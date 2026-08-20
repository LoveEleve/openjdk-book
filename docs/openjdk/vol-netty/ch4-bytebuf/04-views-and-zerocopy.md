# 视图与零拷贝：共享数据，不等于共享寿命

> 本文基于当前 Netty `buffer` 模块源码，解释 `slice`、`duplicate`、`readSlice`、`retainedSlice` 及派生 ByteBuf 的引用计数语义。前置：Ch4-01 `01-dual-index-and-refcnt.md`、Ch4-03 `03-heap-vs-direct.md`、Ch1 ByteBuffer view 基础；本文只讲单 parent 派生视图，CompositeByteBuf 留到下一篇。

## 一份消息，为什么不该每交给一个 Handler 就复制一次

想象一条已经读入 ByteBuf 的消息：

```text
[ magic ][ header ][ body ][ 尚未写入空间 ]
```

解析器可能需要把 header 交给一个 Handler，把 body 交给另一个 Handler。最直觉的办法是：每个 Handler 都复制自己需要的区间。

它当然安全。每个 Handler 拿到一份独立内存，谁修改、谁释放，边界都很清楚。

但网络程序往往在高频处理大量字节。一次复制意味着：

- 读取源数据。
- 分配目标存储。
- 把区间复制过去。
- 新对象再建立自己的索引和生命周期。

如果消息只是被拆成几个窗口，内容本身并没有改变，复制做的只是把同一批字节搬到另一处。于是第二种方案出现了：不复制内容，只创建一个“看起来像独立 ByteBuf”的窗口。

这就是派生视图：

```text
parent storage
  -> slice/duplicate 只创建窗口和索引状态
  -> 读写仍落到同一份底层内容
```

但这里马上埋着一个危险：内容可以共享，内存寿命却未必自动共享得正确。如果 parent 被释放，视图对象的 Java 引用仍可能存在；它还能不能访问，不能靠“对象还在”来判断。

所以本篇先给出一条总原则：

```text
零拷贝解决“数据要不要搬”
引用计数解决“这块数据还能不能活着被用”
```

Netty 把这两件事拆成两个独立选择。普通 `slice/duplicate` 共享数据但不增加引用计数；`retainedSlice/retainedDuplicate` 在创建共享视图的同时，显式增加一份 parent ownership。

## 一、先把两条轴分开：共享存储与共享寿命

### 1. copy 和 view 的差别不只是性能

`ByteBuf` 的接口文档把 derived buffer 单独列出：`duplicate`、`slice`、`readSlice` 以及 retained 变体都属于“派生缓冲区”；它们拥有独立的 readerIndex、writerIndex 和 marker，但共享其他内部数据表示，见 `ByteBuf.java:195-210`。

如果需要完全新的一份内容，接口要求调用 `copy()`，见 `ByteBuf.java:212-213`。

这两类操作的核心差异是：

```text
copy
  -> 新存储
  -> 新索引
  -> 新 ownership
  -> 内容修改互不影响

view
  -> 共享存储
  -> 独立索引
  -> ownership 是否延长另行决定
  -> 内容修改可能互相可见
```

“共享存储”和“独立索引”必须同时记住。派生视图不是把 parent 的 readerIndex 和 writerIndex 直接暴露给另一个 Handler；它创建了自己的访问坐标，只把坐标对应的内容映射回 parent。

### 2. 普通派生视图为什么不自动 retain

接口文档明确写着：`duplicate()`、`slice()`、`slice(index,length)` 和 `readSlice()` 不会对返回的派生 buffer 调用 `retain()`，因此引用计数不会增加；需要增加引用计数时，使用 retained 变体，见 `ByteBuf.java:215-221`。

这是一项很容易被误认为“危险疏忽”的设计。为什么不让每个 slice 自动 retain？因为这会把每个短暂窗口都变成一份独立 ownership。

假设一个 parent 被切出 100 个临时窗口，每个窗口只在当前同步调用内消费。如果每次 slice 都自动 retain，parent 的 refCnt 会额外增加 100；这些窗口即使不再使用，也需要对应 100 次 release 才能让 parent 归零。

普通视图的设计假设是：

```text
parent 的生命周期覆盖当前派生视图的使用期
```

这适合解析链中“创建窗口、立即消费、随当前调用返回”的场景。它用调用者已经持有的 parent ownership 支撑窗口，而不是为每个临时对象增加计数。

当然，这个假设不是所有场景都成立。只要视图要离开当前调用栈，交给异步队列、另一个线程或延迟任务，就不能继续依赖 parent 的偶然存活时间。此时就应该显式使用 retained 变体。

因此普通与 retained 的差别不是“一个安全、一个不安全”，而是 ownership 意图不同：

```text
普通 view：我借用 parent 当前已经拥有的寿命
retained view：我要求为这个 view 额外保留一份寿命
```

### 3. 派生对象仍然有成本，但省掉了内容复制

“零拷贝”不等于“完全没有对象”。派生视图仍然可能有包装对象、索引状态和方法转发；它省掉的是内容存储的重新分配与复制。

所以更准确的收益描述是：

- 避免把 `[index,index+length)` 的字节复制到新内存。
- 为窗口维护独立的 readerIndex、writerIndex 和 marker。
- 在访问时增加一层从本地索引到 parent 索引的映射或委托。
- 继续承担引用计数和线程协作责任。

如果业务需要修改后的内容与原始内容完全隔离，view 就不是正确选择；如果业务只需要多个阶段看同一份数据的不同区域，copy 才可能是多余成本。

## 二、slice：把 parent 的一段内容变成自己的窗口

### 1. slice 的本地坐标如何映射到 parent

假设 parent 的索引 4 到 12 是 header。调用：

```text
slice = parent.slice(4, 8)
```

派生视图的本地坐标从 0 开始，但底层实际访问仍然落在 parent 的 4 到 12：

```text
slice 本地索引       0 1 2 3 4 5 6 7
parent 实际索引      4 5 6 7 8 9 10 11
```

当前 unpooled sliced implementation 用 `adjustment` 保存这个偏移，并把嵌套 slice 的 offset 累加；构造函数见 `AbstractUnpooledSlicedByteBuf.java:32-53`。

底层访问时，`idx(index)` 直接计算 `index + adjustment`，见 `AbstractUnpooledSlicedByteBuf.java:473-480`。于是 slice 的 `_getByte(0)` 会委托 parent 的 `_getByte(4)`，`_setByte(0, value)` 也会写回 parent 的对应位置，见 `UnpooledSlicedByteBuf.java:38-40`、`:82-85`。

```text
slice.getByte(localIndex)
  -> idx(localIndex) = localIndex + adjustment
  -> unwrap()._getByte(parentIndex)
```

这段实现证明了“视图共享存储”的核心判断：它没有把字节复制进一个新数组，而是把本地坐标翻译成 parent 坐标。

### 2. slice 有自己的 readerIndex 和 writerIndex

虽然 slice 的内容来自 parent，但它不是 parent 的索引别名。

构造 sliced buffer 时，当前实现以窗口长度作为 maxCapacity，初始化长度后把 writerIndex 设为 length，见 `AbstractUnpooledSlicedByteBuf.java:36-53`。这代表 `slice(index,length)` 得到的窗口默认把整个窗口视为 readable；它自己的 readerIndex 可以独立推进，自己的 writerIndex 也可以在窗口范围内变化。

因此两个 Handler 可以这样协作：

```text
parent: readerIndex=0, writerIndex=20
header = parent.slice(4, 8)
body   = parent.slice(12, 8)

header.readerIndex 独立推进
body.readerIndex 独立推进
header/body 的内容修改仍落到 parent 存储
```

这正是 ByteBuf 视图相对于 JDK ByteBuffer view 的重要教学落点：底层数据共享，但每个派生 ByteBuf 有自己的顺序访问状态。它不会要求 Handler B 接管 Handler A 留下的同一个 position。

### 3. slice 的 capacity 被窗口固定住

slice 只是 parent 的一个窗口，不能把窗口之外的区域变成自己的 writable 空间。当前 `SlicedByteBuf.capacity()` 返回构造时的 length，见 `SlicedByteBuf.java:27-49`。

所以如果窗口长度是 8：

```text
slice.capacity() = 8
slice.writerIndex 不能越过 8
```

这是一条逻辑边界，不是底层存储真的被截断。parent 仍可能拥有更大的 capacity；只是这个派生视图不能通过自己的索引访问窗口外内容。

因此 slice 适合表达“这个 Handler 只应该看到这段区域”。它不仅节省复制，还把访问范围写进了对象本身。

### 4. 多层 slice 如何避免代理链越来越长

如果对一个 slice 再切一刀：

```text
slice2 = slice1.slice(2, 4)
```

最简单的实现可以让 slice2 包着 slice1，访问时一层层 unwrap。但层数增加后，每次访问都要沿代理链转发，调试和性能都更复杂。

当前 `AbstractUnpooledSlicedByteBuf` 在构造时会识别嵌套 sliced buffer，直接复用原始 buffer，并把原 adjustment 与新 index 相加，见 `AbstractUnpooledSlicedByteBuf.java:40-48`。

于是：

```text
原始 slice adjustment = 4
新 slice 起点 = 2
新 adjustment = 6
```

访问时一次 `index + 6` 就能落到原始坐标。这里要注意边界：这是当前 unpooled sliced implementation 的优化方式，不能把 `adjustment` 字段当成所有 Netty 派生实现的公开统一结构。

## 三、duplicate：全量共享，但索引状态仍然分开

### 1. duplicate 和 slice 的差别是窗口范围

`duplicate()` 的核心用途不是截取一个子区间，而是给整个 parent 创建另一个访问坐标。

当前 `AbstractByteBuf.duplicate()` 创建 `UnpooledDuplicatedByteBuf`；`UnpooledDuplicatedByteBuf` 的底层读写都委托到 unwrap 后的 parent，见 `AbstractByteBuf.java:1204-1208`、`UnpooledDuplicatedByteBuf.java:28-35`。

它的窗口覆盖 parent 的 capacity，而不是某个 `[index,index+length)` 子区间；构造时还会以 parent 当前的 readerIndex/writerIndex 初始化自己的索引状态，见 `DuplicatedByteBuf.java:41-59`、`:82-90`。于是：

```text
duplicate.capacity() = parent.capacity()
duplicate.readerIndex/writerIndex = 自己的一份状态
底层内容 = 与 parent 共享
```

如果 Handler A 只需要 header，slice 更能表达权限范围；如果 Handler B 需要一份与 parent 索引状态完全独立、但覆盖相同容量的访问视图，duplicate 更合适。

### 2. duplicate 不是 parent 的索引别名

假设 parent 当前 `readerIndex=10`，duplicate 创建后也会从相应状态开始，但之后两者的读取可以独立推进：

```text
parent.readByte()
  -> parent.readerIndex 前进

duplicate.readByte()
  -> duplicate.readerIndex 前进
  -> 不会自动把 duplicate 的 readerIndex 一起前移
```

它们读到的底层字节可能相同，也可能因为各自索引不同而处于不同位置。这个设计让多个消费者能用自己的顺序访问状态处理同一份存储；代价是内容修改互相可见，释放边界仍然共享。

### 3. copy 才是完全隔离

`copy()` 的语义与 duplicate 相反：它创建新的存储并复制内容。`AbstractByteBuf.copy()` 默认从当前 readable 区域复制，见 `AbstractByteBuf.java:1200-1202`；它不会因为 parent 后续 release 而悬空，也不会因为 copy 修改内容而影响 parent。

因此选择可以写成：

```text
要独立生命周期和独立内容 -> copy
要独立索引但共享内容   -> duplicate
要缩小访问窗口         -> slice
```

这三者不是“性能版本不同的同一个 API”，而是三种不同的数据 ownership 设计。

## 四、readSlice：视图创建之外，还会消费 parent

### 1. readSlice 多做了一个动作

普通 `slice(index,length)` 只创建指定窗口，不自动改变 parent 的 readerIndex。

`readSlice(length)` 则把“从当前 readerIndex 取一段窗口”与“parent 已经消费这段数据”合并成一个操作。当前实现先检查 readable bytes，调用 `slice(readerIndex,length)`，然后把 parent readerIndex 向前推进 length，见 `AbstractByteBuf.java:885-890`。

```text
readSlice(length)
  -> 检查 parent 可读长度
  -> 从 parent.readerIndex 创建 slice
  -> parent.readerIndex += length
  -> 返回窗口
```

这很适合流式解析：解析器把当前消息段交给下一个阶段，同时告诉 parent“这一段已经从我的消费位置取走”。

### 2. readSlice 与 readBytes 的成本和寿命都不同

`readBytes(length)` 会分配新的 ByteBuf，并把数据复制过去；`readSlice(length)` 只创建共享视图，见 `AbstractByteBuf.java:872-881`、`:885-890`。

所以：

```text
readBytes  -> parent readerIndex 前进 + 新存储 + 内容复制
readSlice  -> parent readerIndex 前进 + 共享存储 + 独立窗口
```

如果下游会长期持有数据，readSlice 需要进一步考虑 retained ownership；如果只是同步消费，普通 readSlice 可以避免复制。

### 3. readSlice 最容易被误用的地方

有两个常见错误。

第一，把 `slice(readerIndex,length)` 当成 `readSlice(length)`。它们看到的内容可能一样，但前者不会推进 parent readerIndex。解析循环下一次再从 parent.readerIndex 读取时，可能重复处理同一段消息。

第二，把 `readSlice` 返回的窗口直接丢进异步队列，却没有为它建立独立 ownership。普通 readSlice 不 retain；如果 parent 很快 release，队列中的窗口就会变成不可访问的派生对象。

因此 `readSlice` 的名字里“read”不只是“读取一段数据”，还包含“推进 parent 消费进度”的状态副作用。

## 五、retained 变体：显式购买一份独立寿命

### 1. retainedSlice 做了什么

`retainedSlice(index,length)` 的核心不是复制内容，而是在创建普通 slice 后调用 `retain()`。当前 `AbstractByteBuf` 的实现见 `AbstractByteBuf.java:1221-1233`：

```text
retainedSlice(index, length)
  -> slice(index, length)
  -> slice.retain()
  -> 返回共享内容但多一份 parent 引用的窗口
```

`retainedDuplicate()` 的实现同样是 duplicate 后 retain，见 `AbstractByteBuf.java:1211-1213`。

这意味着 retained 变体同时满足两件事：

- 内容仍然共享，没有复制消息字节。
- parent 的引用计数增加，视图可以脱离创建者当前 ownership 存活。

但它没有自动把 release 责任消灭。谁获得了这份 retained 引用，谁就必须在使用完成后 release。

### 2. 普通视图为什么可能悬空

假设 parent 初始 `refCnt=1`：

```text
parent.refCnt = 1
slice = parent.slice(...)
parent.release()
  -> parent.refCnt = 0
  -> deallocate()
```

slice 对象本身可能仍然被 Java 变量持有，但它的 `refCnt` 和可达性会委托到 parent。`AbstractDerivedByteBuf` 的 `isAccessible()`、`refCnt()`、`retain()`、`release()` 都沿 `unwrap()` 委托，见 `AbstractDerivedByteBuf.java:34-49`、`:52-108`。

于是 parent 释放后：

```text
slice.refCnt() -> parent.refCnt() -> 0
slice 内容访问 -> ensureAccessible -> IllegalReferenceCountException
```

这不是“slice 对象自动被 GC 了”，而是“对象还在，但它引用的底层资源已经结束生命周期”。Java 引用存在和 ByteBuf 可访问是两件不同的事。

### 3. retained 视图如何改变时序

如果使用：

```text
parent.refCnt = 1
slice = parent.retainedSlice(...)
  -> parent.refCnt = 2
parent.release()
  -> parent.refCnt = 1
slice 仍可访问
slice.release()
  -> parent.refCnt = 0
  -> deallocate()
```

retained view 把“这个窗口要独立活多久”显式变成一份引用。它适合：

- 把窗口交给另一个异步任务。
- 把窗口交给另一个线程，并且 ownership 协议允许这样做。
- 在 parent 即将离开当前处理阶段时，保留一段数据继续使用。

但 retained 不是线程安全开关，也不是自动回收开关。它只改变引用计数时序；下游仍要遵守内容访问和 release 的约定。

### 4. release 委托不等于每次都释放 parent

派生视图的 `release()` 委托 parent 的 release，但是否真正 deallocate 取决于 parent 当前 refCnt。

如果 parent 还有其他 ownership：

```text
parent.refCnt = 3
slice.release()
  -> parent.refCnt = 2
  -> 不会 deallocate
```

只有最后一次 release 把 parent 计数降到 0 时，底层资源才释放。因此不能把“slice.release() 委托 parent.release()”简化成“释放任意一个 slice 就会释放 parent”。真正需要跟踪的是 ownership 数量，而不是 Java 包装对象数量。

## 六、几个特殊包装：共享底层，不代表行为完全一样

### 1. ReadOnly 只改变能力，不改变共享存储

ReadOnly ByteBuf 的用途是把“可以访问内容”收窄为“只能读取”。它仍然可能共享 parent 的底层数据，但写入入口会被拦截。

这说明装饰器可以改变 ByteBuf 的某一个维度，而不复制内容：

```text
底层数据：仍然共享
读写能力：被限制为只读
生命周期：仍需看包装器与 parent 的 ownership 关系
```

因此“view 不复制”不等于“view 可以任意修改”。派生关系、只读关系和引用计数关系是三个可以叠加的维度。

### 2. Unreleasable 是 ownership 边界的特殊包装

`UnreleasableByteBuf` 的类注释说明，它包装另一个 ByteBuf，阻止用户增加或减少被包装对象的引用计数，见 `UnreleasableByteBuf.java:22-26`。它的 `retain` 返回自身，`release` 返回 false，不把释放动作传给底层，见 `UnreleasableByteBuf.java:104-132`。

它连 retained slice 都做了特殊处理：`retainedSlice()` 最终走普通 `slice()` 包装，避免对一个不可释放的包装层制造新的 retained 计数语义，见 `UnreleasableByteBuf.java:52-101`。

这提醒我们：当包装器改变 ownership 规则时，所有派生方法都必须重新定义，不能只覆盖一个 `release()` 就认为语义完整。

### 3. Swapped 是访问解释层，不是复制层

字节序包装器的核心作用是改变多字节读写的解释方式：底层数据仍然可以共享，包装层在读出或写入时执行字节序转换。

它和 ReadOnly/Unreleasable 的共同点是：都在原始 ByteBuf 外增加一层行为，而不是为内容创建副本。因此多个包装层的组合顺序会影响可见行为，但不会把共享存储自动变成独立存储。

本篇不展开 Swapped 的全部方法，只需要把它放进同一张图：

```text
派生/包装可以改变：窗口、索引、只读能力、字节序、ownership 入口
派生/包装默认不改变：底层内容是否被复制
```

## 七、最容易错的五个判断

### 1. slice 是 zero-copy，所以可以随便交给异步线程

不成立。zero-copy 只说明内容没有复制；普通 slice 不 retain，parent 释放后视图可能不可访问。异步交接需要 retained 变体或其他明确 ownership。

### 2. retainedSlice 会复制一份安全数据

不成立。retainedSlice 仍共享底层存储，只增加引用计数。它保护的是寿命，不是内容隔离；其他视图修改同一区域时，数据仍然互相可见。

### 3. duplicate 会跟 parent 使用同一个 readerIndex

不成立。duplicate 共享内容和容量范围，但拥有独立 readerIndex、writerIndex 和 marker。它不是 parent 的索引别名。

### 4. readSlice 只是更短的 slice

不完整。readSlice 还会推进 parent 的 readerIndex；readRetainedSlice 也会推进，只是额外增加一份引用。

### 5. slice.release() 一定会释放 parent

不成立。release 委托 parent，但只有 parent 的引用计数归零才会触发底层 deallocate。

## 收网：零拷贝把复制成本换成 ownership 纪律

现在可以回答开篇的问题：为什么 Netty 允许 slice/duplicate 共享数据，却不默认 retain？

因为它把两个问题拆开了：

```text
数据问题：这个窗口是否需要复制内容？
寿命问题：这个窗口是否需要额外拥有 parent 的一份引用？
```

普通派生视图选择：

```text
共享内容 + 不增加引用
```

它适合在 parent 当前生命周期内完成同步消费。retained 派生视图选择：

```text
共享内容 + 增加一份 parent 引用
```

它适合跨阶段、跨线程或异步持有，但使用者必须匹配 release。

slice、duplicate、readSlice 又分别在窗口范围和 parent 消费进度上做了不同选择：

```text
slice       -> 指定窗口 + 独立索引
duplicate   -> 全量窗口 + 独立索引
readSlice   -> 当前 readerIndex 的窗口 + 推进 parent readerIndex
retained*   -> 在上述语义上额外延长 parent 寿命
copy        -> 新存储，内容与寿命都隔离
```

所以本篇最重要的结论不是“Netty 支持零拷贝”，而是：

```text
零拷贝不是免费安全
它省掉了内容复制，却要求调用者明确索引边界、ownership 和 release 时机
```

到这里，单个 parent 的派生视图已经讲清楚。下一篇进入更复杂的组合场景：如果一条逻辑消息由多个 ByteBuf 组件拼成，CompositeByteBuf 如何同时维护组件范围、引用计数和零拷贝访问？