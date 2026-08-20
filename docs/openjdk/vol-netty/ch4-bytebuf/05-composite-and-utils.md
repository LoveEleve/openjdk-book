# CompositeByteBuf：让分散的组件看起来像一块连续内存

> 本文基于当前 Netty `CompositeByteBuf` 源码，解释虚拟拼接、组件 ownership、逻辑索引定位、consolidate 与 `discardReadComponents`。前置：Ch4-01 `01-dual-index-and-refcnt.md`、Ch4-02 `02-allocator-system.md`、Ch4-03 `03-heap-vs-direct.md`、Ch4-04 `04-views-and-zerocopy.md`；本文不展开 Pooled Arena、完整 NIO API 和 ByteBufUtil 工具算法。

## Header 和 Body 已经各自存在，为什么还要再复制一次

假设一个 HTTP 响应已经被拆成两块：

```text
header = 256 字节
body   = 16 KB
```

它们可能来自不同处理阶段，甚至来自不同的 ByteBuf 类型。现在发送方希望把它们当作一条连续消息处理。

最直接的办法是新建一块 16 KB 以上的 ByteBuf，再依次写入 header 和 body：

```text
alloc.buffer(header.readableBytes() + body.readableBytes())
  -> writeBytes(header)
  -> writeBytes(body)
```

这个办法的优点是简单：最终只有一块连续存储，索引定位也简单。代价则是每次组装都要重新分配并复制已有内容。header 和 body 本来已经在内存里，所谓“组装”只是为了让 API 看到连续布局，却又把 16 KB 数据搬了一遍。

如果把复制推迟呢？让一个对象对外表现得像连续 ByteBuf，内部只保存：

```text
component[0] -> header
component[1] -> body
```

逻辑索引 0 到 255 映射到 header，逻辑索引 256 之后映射到 body。这样，消息可以先以多个物理组件存在；只有真正需要一块连续存储时，才执行一次合并。

这就是 `CompositeByteBuf` 的角色。源码注释把它定义为“把多个 buffer 显示成一个合并 buffer 的虚拟缓冲区”，见 `CompositeByteBuf.java:44-49`。

本篇要建立的核心模型是：

```text
逻辑上连续
  -> 物理上分组件
  -> 通过 offset/endOffset 定位
  -> 通过 Component 维护访问和释放
  -> 必要时 consolidate 成一块连续存储
```

Composite 不是“把多块内存神奇地变成一块”，而是把“连续消息”从物理布局问题变成了索引映射问题。

## 一、Composite 的第一层：组件表组成一块虚拟容量

### 1. 它保存的是 Component 表，不是一个大数组

`CompositeByteBuf` 本身继承 `AbstractReferenceCountedByteBuf`，但它没有一块承载全部内容的 `byte[]` 或单独 direct buffer。它保存 allocator、direct 标志、最大组件数、当前组件数和 `Component[]`，见 `CompositeByteBuf.java:49-75`。

因此 Composite 的容量不是“构造时一次分配出来的容量”，而是组件布局的结果；没有组件时 capacity 为 0。当前实现通过最后一个组件的 `endOffset` 返回整体 capacity，见 `CompositeByteBuf.java:837-841`。

假设组件布局是：

```text
component[0]: offset=0,   endOffset=256
component[1]: offset=256, endOffset=16640
```

那么 Composite 对外看到的就是：

```text
capacity = 16640
```

底层仍然是两块存储，但逻辑坐标已经连续起来。

### 2. addComponent 的真正动作是转移 ownership

`addComponent` 不只是把一个引用塞进数组。它还改变了谁负责释放这块 ByteBuf。

接口文档明确说明，加入 Composite 后，传入 buffer 的 `release()` ownership 转移给 Composite，见 `CompositeByteBuf.java:154-164`。这意味着调用者不能一边把 buffer 交给 Composite，一边又把同一份 ownership 当作自己的继续释放。

完整动作可以先记成：

```text
addComponent(buffer)
  -> 读取 buffer 的 readable 区间
  -> 创建 Component 元数据
  -> 放入 components[]
  -> Composite 负责之后 release
```

如果调用者还想保留一份独立 ownership，应当在加入前按 ByteBuf 的引用计数规则 retain，而不是把同一个 release 责任重复计算。

### 3. writerIndex 是否增加，取决于显式参数

Composite 的 add API 有一个很容易写反的边界：普通 `addComponent(buffer)` 默认不会增加 Composite 的 writerIndex；需要在加入时增加 writerIndex，要调用带 `increaseWriterIndex=true` 的重载，见 `CompositeByteBuf.java:154-158`、`:213-223`。

这让“组件已经存在”和“Composite 当前可读范围已经扩大”成为两件可以分开的事：

```text
组件表：已经拥有这块物理数据
writerIndex：逻辑上允许顺序读取到哪里
```

在构造器直接接收多个 buffer 的路径中，源码会添加组件后把 index 设为 `0, capacity()`，见 `CompositeByteBuf.java:85-101`；但单独调用默认 addComponent 时，不能自行假设 writerIndex 一定跟着增长。

### 4. 添加失败时，ownership 也要回滚

把组件放进数组并不是没有失败点：组件索引可能非法，容量可能溢出，组件创建或偏移更新也可能抛异常。

当前 `addComponent0` 用 `wasAdded` 标志配合 finally：只有真正添加成功才保留传入 buffer；如果中途失败，finally 会调用 `buffer.release()`，见 `CompositeByteBuf.java:280-309`。

这条路径很重要，因为 ownership 转移一旦开始，就不能只考虑成功路径：

```text
add 失败
  -> Composite 没有接管成功
  -> 传入 buffer 不能无人负责
  -> finally release 回滚 ownership
```

如果没有这个回滚，异常路径会把一个本来应该释放的组件遗留在外面，造成泄漏。

## 二、Component 为什么保存 srcBuf 和 buf 两个引用

### 1. 访问对象和释放对象可能不是同一个包装层

Composite 接收的组件不一定是一个最底层的普通 ByteBuf。它可能已经经过：

```text
LeakAware -> Swapped -> Slice -> Pooled buffer
```

如果 Composite 只保存最终解包后的底层对象，那么访问可以很直接，但释放时可能落错对象；如果只保存原始包装对象，那么每次访问都要沿着包装链转发，成本和复杂度都会增加。

因此当前 `Component` 保存两份引用：

- `srcBuf`：调用者原始添加进来的 ByteBuf，负责保留原始 ownership。
- `buf`：剥掉若干包装层后的访问对象，负责高效读写。

字段定义见 `CompositeByteBuf.java:1913-1918`。

这两个引用不是重复保存同一件事，而是故意把两种责任拆开：

```text
srcBuf -> 谁交给我的、最后应该 release 谁
buf    -> 逻辑索引映射后，真正从哪里读写
```

### 2. newComponent 会剥掉中间包装，但不丢原始对象

创建 Component 时，Composite 先记录原始 `srcIndex` 和 readable length，再逐层解包 `WrappedByteBuf`、`SwappedByteBuf`、sliced/duplicated buffer，得到更直接的访问对象和对应的 `unwrappedIndex`，见 `CompositeByteBuf.java:320-348`。

这个动作解决的是访问路径：

```text
Composite.getByte(logicalIndex)
  -> Component.buf
  -> 直接访问底层实现
```

但 Component 构造时仍然把原始 `buf` 作为 `srcBuf` 保存下来。因为原始对象可能是一个派生视图或池化包装，真正的引用计数关系并不一定等于解包对象的表面类型。

这也是为什么本节不能只用“Composite 把 slice 解包了”来概括。它同时保留两条坐标和生命周期信息。

### 3. 两套 adjustment 对应两套坐标

Component 内部有两类索引转换：

```text
srcIdx(index) = index + srcAdjustment
idx(index)    = index + adjustment
```

前者把 Composite 的逻辑索引转换回原始 `srcBuf` 的索引，后者把逻辑索引转换到解包后 `buf` 的索引，见 `CompositeByteBuf.java:1936-1942`。

为什么一个 adjustment 不够？因为 `srcBuf` 可能是一个 slice，而 `buf` 可能已经被解包到 parent。逻辑 Composite offset 到原始 slice 坐标，与到 parent 底层坐标的偏移可能不同。

组件被插入、删除或前面的组件被释放后，整体 offset 会变化。`reposition` 会同步调整 `endOffset`、`srcAdjustment` 和 `adjustment`，见 `CompositeByteBuf.java:1948-1954`。

所以 Component 不只是“一个 ByteBuf 加长度”，而是一个小型坐标转换器：

```text
Composite 坐标
  -> 原始包装对象坐标
  -> 解包访问对象坐标
```

### 4. 为什么 free 必须 release srcBuf

Component 的 `free()` 会清掉缓存 slice，然后调用 `srcBuf.release()`，源码注释特别说明：原始 buffer 与解包后的 buffer 可能拥有不同的引用计数，例如 `PooledSlicedByteBuf`，见 `CompositeByteBuf.java:1979-1984`。

这正是双引用设计的落点：

```text
访问：用 buf
释放：用 srcBuf
```

如果误用 `buf.release()`，Composite 可能只释放了一个内部 parent，或者完全没有释放传入的派生包装，最终 ownership 关系被打乱。

### 5. 组件 slice 为什么要缓存

`Component.slice()` 是惰性的：第一次需要暴露组件窗口时，才调用 `srcBuf.slice(srcIdx(offset), length())` 并缓存结果，后续复用，见 `CompositeByteBuf.java:1962-1967`。

这样做有两个目的：

- 不为每次组件访问反复创建派生视图。
- 释放或重排组件时可以清掉缓存，避免保留旧坐标的 slice。

注意，这个缓存 slice 仍然属于 Component 生命周期的一部分。组件偏移变化或组件释放时，Composite 必须同步处理缓存，否则旧视图可能对应错误位置。

## 三、逻辑偏移如何找到物理组件

### 1. Composite 对外给的是一个逻辑 index

调用者只看到：

```text
composite.getByte(50000)
```

但 Composite 内部必须先回答：50000 落在哪个组件？组件自身从哪个局部索引读取？

当前实现把每个组件的逻辑范围记录为 `[offset, endOffset)`。例如：

```text
component[0] -> [0, 256)
component[1] -> [256, 16640)
component[2] -> [16640, 20000)
```

逻辑 index 500 不等于组件内 index 500；它应当落到 component[1]，再通过 `adjustment` 转成组件底层的局部索引。

`getByte` 的路径就是：先 `findComponent(index)`，再用 `c.buf.getByte(c.idx(index))` 访问，见 `CompositeByteBuf.java:952-962`。

### 2. 二分查找解决随机访问

`toComponentIndex0` 对组件的 offset/endOffset 做二分查找；组件很少时有 1/2 组件快路径，组件较多时用 low/high/mid 缩小范围，见 `CompositeByteBuf.java:912-945`。

如果组件数是 N，随机访问定位的主要成本是 O(log N)，而不是把前面所有组件逐个扫描一遍。这个选择让 Composite 在组件数量增大后仍能提供可接受的随机索引访问。

但“二分”不是唯一的优化。网络数据经常按顺序读取：先消费 header，再消费 body，再消费 footer。每次都重新二分仍然浪费，因为下一次访问很可能还在上一次组件附近。

### 3. lastAccessed 是一个面向顺序访问的弱缓存

Composite 保存一个 `lastAccessed` 组件。查找时先判断目标 offset 是否仍落在这个组件的 `[offset,endOffset)` 范围内；命中就直接返回，否则回退到二分查找，见 `CompositeByteBuf.java:1614-1654`。

它不是 LRU，也不是多个组件的缓存，只保留一个最近访问的组件。这个取舍与典型消费模式有关：

```text
顺序读 header
  -> 仍在 header，命中
读到 body
  -> 第一次切换时二分
  -> 后续 body 内读取继续命中
```

因此不能把 Composite 的访问复杂度绝对写成 O(1) 或 O(log N)：

- 顺序访问在同一组件内，lastAccessed 命中，接近 O(1) 定位。
- 随机访问或跨组件跳跃，可能重新二分，主要定位成本为 O(log N)。
- 多字节操作跨越组件边界，还需要按组件边界拼接处理。

### 4. 跨组件访问为什么更复杂

如果读取一个 int 完全落在同一组件内，Composite 可以把局部索引交给该组件的 `getInt`。如果 int 横跨两个组件，就不能一次从单个底层 buffer 取出，必须按字节或按分段组合。

这就是虚拟连续布局的代价：逻辑上连续不等于物理上连续。调用者获得了统一的 ByteBuf API，但 Composite 内部必须处理组件边界、字节序和多字节访问的组合。

因此组件数量并非越多越好。组件越多，添加时越省复制，但随机定位、跨边界读写和管理元数据的成本也会上升。`maxNumComponents` 和后续 consolidate 就是对这条成本曲线的控制。

## 四、consolidate：什么时候值得把组件真正合并

### 1. 合并不是零拷贝，而是主动支付一次复制

Composite 的优势是延迟复制，但延迟不等于永远不复制。

当组件过多，或者后续操作确实需要一块连续存储时，Composite 可以执行 `consolidate()`：申请一个新的连续 ByteBuf，把多个组件依次写进去，再释放旧组件。

`consolidate0` 的路径是：

```text
计算待合并组件范围
  -> allocBuffer(totalCapacity)
  -> 每个 Component.transferTo(consolidated)
  -> 移除旧组件
  -> 新 buffer 变成一个 Component
```

源码见 `CompositeByteBuf.java:1768-1793`。`Component.transferTo` 明确执行 `dst.writeBytes(...)` 后 `free()`，见 `CompositeByteBuf.java:1956-1960`。

所以 consolidate 的本质是：

```text
一次性 O(总内容长度) 复制
  -> 释放旧组件
  -> 后续只面对更少的组件
```

它不是 zero-copy。它是在“现在支付复制成本”和“未来每次访问继续支付组件管理成本”之间做选择。

### 2. 组件上限会触发自动合并

addComponent 操作完成后，Composite 会调用 `consolidateIfNeeded()`；当组件数达到配置的 maxNumComponents，就可能自动合并，见 `CompositeByteBuf.java:234-267`。

这条机制解决的是组件无限增长问题。当前 `consolidateIfNeeded()` 在组件数大于 `maxNumComponents` 时合并，而不是在刚好达到上限时立刻合并，见 `CompositeByteBuf.java:562-573`：

```text
不断 addComponent
  -> components[] 越来越长
  -> 组件数超过 maxNumComponents
  -> consolidate 降低组件数量
```

`maxNumComponents` 不是内容容量上限，而是布局复杂度上限。一个 Composite 可以有很大的逻辑容量，也可以只有少量组件；它控制的是“这条逻辑消息允许由多少块物理 buffer 拼成”。

### 3. 手动 consolidate 的时机

自动阈值只能控制最坏的组件数量，不能知道业务下一步要做什么。调用者可能在以下场景主动 consolidate：

- 后续 API 明确要求一块连续 ByteBuf 或单个 NIO buffer。
- 数据已经组装完成，之后会被高频随机访问。
- 组件数量不多，但跨边界多字节访问已经成为热点。
- 即将把数据交给不理解 Composite 的外部接口。

相反，如果消息只是顺序读取一次，组件边界天然和协议边界重合，就不一定值得提前合并。一次复制可能比顺序跨组件定位更贵。

这不是“组件多就必须 consolidate”，而是把访问模式纳入判断：

```text
短期顺序消费 -> 保留组件，延迟复制
长期随机访问/要求连续 -> consolidate，一次复制换后续简单路径
```

### 4. capacity 扩缩容也会改变组件布局

Composite 的 `capacity(newCapacity)` 并不是修改一个整数。

扩容时，当前实现分配一块 padding ByteBuf 作为新组件；如果组件数量达到上限，再触发合并。缩容时，则从尾部组件开始裁剪：能完整删除的组件直接 free，部分组件调整 endOffset，必要时替换缓存 slice，见 `CompositeByteBuf.java:844-886`。

这说明 Composite 的容量变化仍然遵循“逻辑容量映射到物理组件”的模型：

```text
扩容 -> 添加 padding 组件
缩容 -> 尾部裁剪/释放组件
组件过多 -> consolidate
```

它没有把所有组件先复制成一个数组再修改容量，因为那会破坏 Composite 延迟复制的主要价值。

## 五、discardReadComponents：读完整个组件就直接释放

### 1. 普通 ByteBuf 的回收为什么不适合 Composite

普通 ByteBuf 的 `discardReadBytes()` 通常要把未读数据向前搬，换出前缀空间。那是一种内容复制。

Composite 的情况更特殊：已读前缀可能刚好对应完整的组件。

```text
component[0] header 已全部读完
component[1] body 还没开始读
```

这时最优动作不是把 body 搬到索引 0，而是直接释放 header 组件，让 body 成为新的逻辑起点。

### 2. discardReadComponents 的实际路径

`discardReadComponents()` 先检查 readerIndex。如果 readerIndex 已经覆盖了某些组件，就遍历这些组件并调用 `free()`；随后移除它们，更新剩余组件 offset，重新设置 reader/writer index 和 markers，见 `CompositeByteBuf.java:1798-1843`。

```text
readerIndex 已越过 component[0]
  -> component[0].free()
  -> remove component[0]
  -> 剩余组件 offset 整体前移
  -> readerIndex/writerIndex 重新对齐
```

这里的优势是：完整读完的组件不需要复制其后内容。它释放的是“整个已读单元”，而不是把未读字节从后面搬到前面。

### 3. 它和 discardReadBytes 不是同一个操作

`CompositeByteBuf.discardReadBytes()` 也会释放前面完整读完的组件，但对于第一个还包含未读数据的组件，会调整该组件的起点和 adjustment，必要时创建新的 slice，见 `CompositeByteBuf.java:1845-1900`。

因此两者的差别可以这样记：

```text
discardReadComponents
  -> 只处理完整读完的组件
  -> 不处理当前部分消费组件的内部前缀
  -> 更保守，避免搬剩余内容

discardReadBytes
  -> 继续处理第一个部分消费组件
  -> 调整/切出未读窗口
  -> 更接近普通 ByteBuf 的“回收前缀”语义
```

不能把 `discardReadComponents` 简化成“永远 O(1)”。如果一次需要移除很多组件，仍要遍历和更新布局；它的核心优势是完整组件释放时不复制剩余内容。

## 六、几个最容易错的判断

### 1. Composite 一定是零拷贝

不绝对。添加组件阶段可以不复制；`consolidate()` 会申请新 buffer 并把组件写进去，明确包含复制。Composite 是“延迟复制”，不是“永不复制”。

### 2. direct Composite 只能放 Direct 组件

不能这样推断。Composite 的 `direct` 标志主要影响它自己通过 `allocBuffer` 新分配 padding 或 consolidated buffer 的方向；已有组件的存储类型是另一条路径。不要把 Composite 的方向标记写成对所有组件的强制转换。

### 3. addComponent 后 writerIndex 一定增加

不一定。默认入口不增加 writerIndex，带 `increaseWriterIndex=true` 的重载才会增加。组件 ownership 已经转移与逻辑 readable 范围扩大是两件事。

### 4. Component 只保存解包后的 buf 就够了

不够。当前实现保留 `srcBuf` 处理原始 ownership，保留 `buf` 处理解包后的访问，并用两套 adjustment 映射索引。丢掉任一层，派生/池化组件的释放或访问都可能错位。

### 5. discardReadComponents 每次都是严格 O(1)

不严谨。释放一个完整组件可以不复制内容，但移除多个组件、重排数组和更新 offset 仍有管理成本；它的 O(1) 优势是相对于搬运剩余内容的复制成本。

## 收网：Composite 把“连续”从物理事实变成逻辑协议

现在可以回答开篇的问题：header 和 body 已经各自存在，为什么还要复制成一个大 buffer？

因为很多时候并不需要立刻得到物理连续存储。Composite 先用一张组件表把它们映射成逻辑连续的 ByteBuf：

```text
Component 表
  -> 每个组件记录 offset/endOffset
  -> 逻辑 index 找到组件
  -> adjustment 把逻辑 index 转成访问 index
  -> srcBuf 保留原始 ownership
  -> buf 承担解包后的数据访问
```

当访问模式适合组件化布局时，Composite 避免了拼接时复制；当组件过多或外部 API 需要连续布局时，`consolidate()` 再一次性复制并释放旧组件；当读取完整组件时，`discardReadComponents()` 直接释放，不搬剩余内容。

所以 Composite 的核心不是“多个 buffer 放进一个数组”，而是三条协议共同成立：

```text
逻辑坐标：offset/endOffset/adjustment
访问定位：lastAccessed + 二分查找 + 组件内委托
资源寿命：srcBuf ownership + free/release
```

本章至此，ByteBuf 的内存模型已经闭环：

- 双指针管理单个缓冲区的数据进度。
- Allocator 管创建意图和容量增长。
- Heap/Direct 管底层存储路径。
- slice/duplicate 管共享窗口与生命周期选择。
- Composite 管多个物理组件的逻辑连续化。

下一章进入 EventLoop：这些 ByteBuf 并不会自己读 Socket、切视图或释放组件。谁在什么线程里驱动这些动作，谁负责把 Selector 的就绪事件变成 ByteBuf 的数据流，交给 EventLoop 回答。