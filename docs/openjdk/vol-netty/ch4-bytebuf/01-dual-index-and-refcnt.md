# ByteBuf 的核心：为什么要把读写进度和内存寿命拆开

> 本文基于当前 Netty `buffer` 与 `common` 模块源码，重点解释 `ByteBuf` 的双指针、空间回收、容量边界和引用计数。前置：Ch1 ByteBuffer 三篇、Ch2 Channel 三篇、Ch3 Selector 三篇；本文只讲 ByteBuf 的核心抽象，分配器、堆/直接内存、派生视图、Composite 和泄漏检测放到后续篇章。

## ByteBuffer 已经能装字节，Netty 为什么还要重做

Ch1 到 Ch3 已经把 JDK NIO 的地基铺出来了。

`ByteBuffer` 能把一块内存交给 `Channel`，`Channel` 能用非阻塞方式收发数据，`Selector` 能告诉事件循环哪个连接现在值得继续读写。单看每个 API，它们都没有问题。

可一旦数据不再只经过一个方法，而是要在多个处理阶段之间接力，ByteBuffer 的使用体验会突然变得很别扭。

设想一条最小的数据链：

```text
网络读入
  -> Handler A 追加数据
  -> Handler B 读取消息头
  -> Handler C 继续读取或生成响应
```

Handler A 写入 100 字节后，ByteBuffer 处于写模式：`position=100`，`limit=capacity`。为了让 Handler B 读取，必须调用 `flip()`，把 `limit` 改成 100，再把 `position` 退回 0。

Handler B 读掉前 40 字节后，`position` 变成 40。此时 Handler C 如果还要往同一个缓冲区追加数据，就不能直接写：position 指向的是“下一处待读位置”，不是“下一处可写位置”。它必须先 `compact()`，把剩余的 60 字节搬到数组开头，再把 position 放到剩余数据末尾，重新进入写模式。

于是一次接力变成了：

```text
写入 -> flip -> 读取 -> compact -> 再写入 -> 再 flip
```

这套流程在单个方法里尚可忍受，因为方法作者可以独占并记住当前模式。可是当多个处理阶段共享一份数据时，模式切换责任会沿着调用链扩散：每个阶段都必须知道上一个阶段把 position、limit 留在了什么状态，还要知道自己处理完之后下一个阶段需要什么状态。

真正的问题不是 `flip()` 难记，而是一个指针承担了两种互相冲突的进度：

- 读进度：已经消费到哪里。
- 写进度：新数据应该追加到哪里。

当这两个进度不是同一个位置时，单个 `position` 无法同时表达它们。调用者只能通过 `limit` 和 `flip/compact` 的组合，反复把同一块内存切换成不同模式。

Netty 重新设计 ByteBuf，第一刀就落在这里：不再让一个 position 轮流扮演读指针和写指针，而是直接保存两个独立索引。

```text
readerIndex：下一次 read 从哪里开始
writerIndex：下一次 write 从哪里开始
```

但 ByteBuf 的变化不止是“把一个字段拆成两个字段”。双指针解决的是数据进度；引用计数解决的是数据背后的内存寿命。两者必须放在同一篇里理解，因为一个缓冲区既可能“还有数据”，也可能“已经不允许访问”。

这篇文章最后要建立的总图是：

```text
数据状态：readerIndex / writerIndex / capacity
资源状态：refCnt

数据状态决定：哪里能读、哪里能写、哪里能回收
资源状态决定：这块内存还能不能碰、何时执行释放
```

先别急着看引用计数。第一步，我们先把 ByteBuf 的双指针模型讲透，看看它到底消除了 ByteBuffer 的哪种模式切换。

## 一、两个进度，三块区域

### 1. readerIndex 和 writerIndex 各自负责什么

ByteBuf 的接口文档没有把双指针藏在某个实现类里，而是直接把它作为核心抽象写出来：`readerIndex` 服务顺序读取，`writerIndex` 服务顺序写入，见 `ByteBuf.java:59-74`。

这两个索引把一块容量为 `capacity` 的内存划成三段：

```text
0                readerIndex          writerIndex             capacity
|---------------------|======================|------------------------|
      discardable              readable                 writable
       已消费数据                当前数据                  可追加空间
```

三段的角色不同：

- `[0, readerIndex)`：已经被顺序读取过，原则上可以回收或覆盖。
- `[readerIndex, writerIndex)`：当前仍可读取的有效内容。
- `[writerIndex, capacity)`：当前可追加的新内容。

这个划分不是文章为了好记而编出来的比喻，ByteBuf 接口文档本身就用这三个区域解释双指针，见 `ByteBuf.java:59-74`。索引关系由 `AbstractByteBuf.checkIndexBounds(...)` 约束为 `0 <= readerIndex <= writerIndex <= capacity`，见 `AbstractByteBuf.java:110-115`。

因此，ByteBuf 不需要先把整个对象切换成“读模式”或“写模式”。它只需要根据操作类型选择对应的边界：

```text
readXXX：从 readerIndex 读，读完 readerIndex 向右移动
writeXXX：从 writerIndex 写，写完 writerIndex 向右移动
```

接口文档对两条规则都有明确说明：名字以 `read` 或 `skip` 开头的顺序操作推进 `readerIndex`；名字以 `write` 开头的顺序操作推进 `writerIndex`，见 `ByteBuf.java:76-104`。

这就是第一个顿悟：ByteBuf 的读写并不是通过切换同一个对象的工作模式来完成，而是两个角色同时在同一个容量边界内推进。

### 2. 为什么这能消灭 flip/compact 的主流程

回到刚才的三阶段场景。

Handler A 写入 100 字节后：

```text
readerIndex = 0
writerIndex = 100
```

Handler B 读取 40 字节后：

```text
readerIndex = 40
writerIndex = 100
```

此时 Handler C 如果还要追加数据，并不需要先 compact。因为可读数据仍然位于 `[40,100)`，可写空间则从 `writerIndex=100` 直接开始。两个阶段各自推进自己的索引，状态不会互相覆盖。

```text
0          40                 100                 capacity
|----------|==================|----------------------|
 discarded       readable             writable
```

这不是说 ByteBuf 永远不需要移动数据。它仍然可能在空间不足时回收前面的 discardable 区域；区别在于，回收是一个明确的容量管理动作，而不是每次读写模式切换都要做的前置动作。

ByteBuffer 把“读完之后怎么回到写模式”放在调用者身上；ByteBuf 把读写进度分开，让调用者先专注于“消费多少”和“追加多少”，只有真正需要回收空间时，才显式选择压缩策略。

这里先记住主线，不必马上抠所有索引 setter 的实现：

```text
ByteBuffer：position 改变后，读写模式也跟着改变
ByteBuf：readerIndex 和 writerIndex 各自改变，读写可以连续发生
```

### 3. clear 不是擦除，也不是万能复位

双指针模型还会纠正一个从 `ByteBuffer.clear()` 延伸过来的误解：`clear()` 不等于把内存里的字节清零。

ByteBuf 接口明确说，`clear()` 做的是把 `readerIndex` 和 `writerIndex` 都设为 0，并且它的语义和 NIO buffer 的 `clear()` 不同，见 `ByteBuf.java:458-467`。当前 `AbstractByteBuf.clear()` 的实现也只是执行 `readerIndex = writerIndex = 0`，见 `AbstractByteBuf.java:150-154`。

所以调用 `clear()` 后，旧字节可能仍然物理存在于底层数组或直接内存中，只是从 ByteBuf 的顺序访问协议看，它们不再属于 readable 区域。

```text
clear()
  -> readerIndex = 0
  -> writerIndex = 0
  -> 整块容量重新成为 writable
  -> 不负责擦除旧内容
```

这正是为什么 `clear()` 不能替代“保留未读数据”的回收动作。如果 `[readerIndex, writerIndex)` 里还有半包或未处理消息，直接 clear 会让这部分数据从顺序读取视角消失。要回收已经消费的前缀，应该进入 `discardReadBytes()` 或 `discardSomeReadBytes()` 的选择。

到这里为止，双指针已经解决了“读写进度冲突”。但它没有凭空增加容量：当 writable 区域不够时，ByteBuf 仍然要在“搬数据”和“扩容”之间做选择。下面进入这个选择。

## 二、空间回收：不搬数据会扩容，频繁搬数据又会变慢

### 1. discardReadBytes 做的不是删除，而是搬家

假设一个容量为 8192 的 ByteBuf，已经读掉了前 4096 字节，后面还有 2048 字节未读：

```text
0                 4096              6144                 8192
|------------------|=================|----------------------|
   已消费 4096          未读 2048             可写 2048
```

从逻辑上说，前 4096 字节已经没有价值；从物理布局上说，后面的可写空间只有 2048。此时如果下一批数据需要 4096 字节，ByteBuf 有两个选择：

1. 扩大底层容量，保留现有数据位置。
2. 把未读的 2048 字节搬到索引 0，释放出前面的 4096 字节。

`discardReadBytes()` 选择第二种。它把 `[readerIndex, writerIndex)` 的 readable 区间复制到 0，再把 `writerIndex` 减去原来的 `readerIndex`，最后把 `readerIndex` 设回 0，见 `AbstractByteBuf.java:216-233`。

搬动之后，状态从：

```text
readerIndex = 4096
writerIndex = 6144
```

变成：

```text
readerIndex = 0
writerIndex = 2048
```

可写空间从 2048 增加到 6144，容量本身没有变化。

因此 `discardReadBytes()` 的含义不是“把前缀从内存中删除”，而是“把仍然有用的数据向前搬，让已消费的容量重新变成连续 writable 区域”。它解决的是空间布局，不是业务数据删除。

### 2. 为什么这笔搬运是 O(N)

这次操作至少要移动 readable 区域里的内容。未读数据越长，复制成本越高；如果每收到一小段数据就调用一次，就会把本来顺序写入的流程变成反复内存搬运。

这就是 `discardReadBytes()` 的第一个代价：它节省了扩容分配，却支付了复制带宽。

还有一个容易忽略的状态：ByteBuf 可能设置了 reader/writer mark。数据前移以后，mark 也不能继续指向旧的物理位置，否则 reset 会跳到错误的地方。`AbstractByteBuf.discardReadBytes()` 会调用 `adjustMarkers(readerIndex)`，见 `AbstractByteBuf.java:222-230`；`adjustMarkers` 再根据移动距离递减两个 marker，见 `AbstractByteBuf.java:257-269`。

所以一次 discard 的完整责任不只是搬字节：

```text
搬 readable 数据
  -> 减少 writerIndex
  -> readerIndex 归零
  -> 同步调整 markedReaderIndex / markedWriterIndex
```

如果只改两个主索引而不调整 mark，ByteBuf 的另一组状态就会与内容位置脱节。

### 3. discardSomeReadBytes 为什么宁可多占内存

如果每次只消费了几个字节，就立即把剩余内容搬到 0，吞吐会被 O(N) 复制拖住。于是 ByteBuf 还提供了 `discardSomeReadBytes()`。

它的接口合同没有承诺“每次都压缩”，而是明确允许实现丢弃部分、全部或不丢弃已读字节，以减少整体内存带宽消耗，代价是可能多占一些内存，见 `ByteBuf.java:515-521`。

当前 `AbstractByteBuf` 的实现采取了一个简单门槛：

- 如果 readerIndex 已经到达 capacity 的一半或更多，就执行搬移。
- 如果只消费了前面较小的一段，就保留现状，不支付这次复制成本。
- 如果 readerIndex 已经等于 writerIndex，说明所有内容都读完了，可以直接把两个索引归零。

实现见 `AbstractByteBuf.java:235-255`。

这两种方法的区别可以这样记：

```text
discardReadBytes：我现在就要把所有已读空间收回来
                 -> 更确定，可能付出 O(N) 拷贝

discardSomeReadBytes：只有回收收益足够大时才搬
                     -> 少搬几次，可能暂时浪费容量
```

这不是谁绝对更快，而是两种成本的交换：

- 数据复制消耗 CPU 缓存带宽。
- 不回收消耗容量，可能更早触发扩容。

如果你在处理固定大小、持续流入的协议数据，频繁完整 discard 可能很贵；如果缓冲区接近上限而扩容代价更高，主动回收又可能更划算。ByteBuf 把两种策略都暴露出来，让上层根据处理节奏选择，而不是强迫每次都采用同一种回收动作。

到这里，双指针带来了三个区域，但空间回收仍然是有成本的。下一步要解决的是：如果回收后依然不够，ByteBuf 如何判断自己还能不能长大。

## 三、容量边界：capacity 能长，maxCapacity 不能被业务绕过

### 1. writableBytes 和 maxWritableBytes 不是一个概念

双指针让我们知道当前从哪里写，但“当前还能写多少”和“理论上最多还能写多少”必须分开。

ByteBuf 接口给出了三个层次：

- `writableBytes = capacity - writerIndex`：现在不扩容就能写多少。
- `maxWritableBytes = maxCapacity - writerIndex`：在最大容量限制内最多还能写多少。
- `maxFastWritableBytes`：在不涉及内部重新分配或复制的前提下，当前最多能写多少。

定义见 `ByteBuf.java:407-430`。对默认实现来说，`maxFastWritableBytes()` 返回当前 `writableBytes()`；某些实现可以进一步表达“不触发内部重分配也能保证的范围”。

这个三层区分是为了避免把“现在能写”与“未来允许增长”混在一起：

```text
writableBytes      = 眼下的空间
maxWritableBytes   = 上限以内的余量
maxFastWritableBytes = 不搬家、不重新分配的确定余量
```

### 2. ensureWritable 的四种结果

调用者通常不会在每个写操作前手动比较一堆容量字段，而是调用 `ensureWritable(minWritableBytes, force)`，让 ByteBuf 负责检查与扩容。

接口给出的状态码只有四种，但每一种都回答了不同问题，见 `ByteBuf.java:537-556`：

- `0`：原来的 writable 空间已经够，容量没有变化。
- `1`：空间不够，且容量没有变化。
- `2`：空间原本不够，ByteBuf 已经扩容，而且扩容后 writable 空间已经足够。
- `3`：请求超过了 maxCapacity；在 `force=true` 时，ByteBuf 把容量扩到 maxCapacity，但仍然不能满足这次完整请求。

因此 `2` 可以直接读成“ByteBuf 已经把这次容量准备好”。接口对 `3` 的描述则相反：容量已到最大值，但仍然不够。调用者真正需要区分的是，`2` 代表这次请求可以继续，`3` 代表即使扩到上限也无法完整满足请求。

当前 `AbstractByteBuf.ensureWritable(int, boolean)` 的执行顺序是：先检查现有 writable 空间；如果请求超过最大余量且不能强制扩容，就返回 1；如果允许强制扩容，就把 capacity 推到 maxCapacity 并返回 3；其余情况下计算新容量、扩容并返回 2，见 `AbstractByteBuf.java:308-335`。

可以把调用者的决策写成：

```text
status = ensureWritable(need, force)

0 -> 直接写
1 -> 空间仍不足，由上层决定等待、拆分或报错
2 -> 已扩容且空间已足够，继续写
3 -> 已到 maxCapacity，完整请求仍放不下
```

为什么不让 `ensureWritable` 直接统一抛异常？因为异步网络处理并不总是只有“成功”和“异常”两条路。调用者可能想拆分消息、推迟发送、转移到别的缓冲区，或者在强制模式下接受“已经扩到顶但请求仍不完整”。状态码把容量动作与上层策略分开了。

### 3. maxCapacity 是资源边界，不是建议值

`capacity` 是当前分配出来的大小，允许在一定范围内变化；`maxCapacity` 则是这块 ByteBuf 在创建时确定的上限，接口提供 `maxCapacity()` 查询，见 `AbstractByteBuf.java:96-103`。

如果没有 maxCapacity，任何不断追加的数据都可以通过自动扩容留在内存中，最终把一个协议异常、恶意请求或业务积压变成进程内存压力。maxCapacity 不是为了让正常请求“永远成功”，而是为了在缓冲区增长前画出硬边界。

这里要把责任分清：

- ByteBuf 负责报告当前空间和上限。
- allocator 负责后续如何计算新容量。
- 上层协议负责决定超过上限后是拒绝、拆分、回压还是关闭连接。

本篇只讲第一层和第三层的接口关系。具体增长曲线由 Ch4-02 的 allocator 体系展开，不能把某种容量计算策略提前当成 ByteBuf 的核心抽象。

到这里为止，ByteBuf 已经解决了两个数据层问题：读写不再共用 position，容量也有明确的增长上限。但还有一个更危险的问题：即使索引和容量都合法，这块内存会不会已经不属于你了？

## 四、从“数据还在”到“内存还活着”

### 1. GC 解决对象可达性，不解决业务 ownership

Java 堆上的 byte[] 可以交给 GC；但 Netty 不只有堆内存，还会使用 Direct 内存和池化内存。更重要的是，网络程序经常把同一份数据交给多个异步阶段：一个阶段读取，另一个阶段排队发送，第三个阶段在未来某个时间释放。

GC 判断的是对象是否仍然可达，不知道“最后一个异步使用者什么时候完成”。只要某个引用还留在队列、闭包或 handler 字段里，GC 就可能认为对象仍然活着；反过来，一旦 Java 引用关系断开，GC 也不会理解某个底层资源是否还有业务使用协议。

对 DirectBuffer 来说，Cleaner 提供的是与 GC 关联的被动清理路径，不是“业务完成时立即释放”的 ownership 协议。它能处理“对象最终不可达之后怎么清理”，却不能替网络 pipeline 判断“最后一次写已经完成”。

所以 Netty 需要另一种规则：资源的使用者自己声明持有和放弃。

```text
创建 ByteBuf -> 初始持有 1 份引用
交给异步使用者 -> retain()
某个使用者完成 -> release()
最后一份引用释放 -> deallocate()
```

这就是引用计数。它不依赖 GC 决定业务何时结束，而是把“还能不能访问”和“何时释放底层资源”直接纳入 ByteBuf 协议。

### 2. 引用计数不是共享数据的万能锁

这里必须先拆掉一个危险误解：ByteBuf 有引用计数，不代表 ByteBuf 的所有操作都可以被多个线程随意并发调用。

引用计数解决的是 ownership 计数的原子更新：多个线程可能同时 retain 或 release，计数不能因为普通读改写而丢失。它不自动保护：

- `readerIndex` 和 `writerIndex` 的并发推进。
- 同一位置的内容读写。
- 一个线程在释放后，另一个线程是否还持有合法引用。
- 多个 handler 之间的业务顺序。

因此要把两条线分开：

```text
引用计数并发安全：谁持有、谁释放，计数更新不互相覆盖
内容访问线程安全：谁在什么时候读写哪些索引，仍由上层协议负责
```

这也是为什么“CAS 替代 synchronized”只能用于引用计数这条局部链路，而不能推出“ByteBuf 是全线程安全容器”。

## 五、retain/release：引用数归零时才允许释放

### 1. 当前 Netty 把计数实现独立成 RefCnt

本篇依据的当前源码中，`AbstractReferenceCountedByteBuf` 不直接实现所有 CAS 细节，而是持有一个 `RefCnt` 对象。它把 `refCnt()`、`retain()`、`release()` 分别委托给 `RefCnt`，见 `AbstractReferenceCountedByteBuf.java:24-43`、`:59-89`。

`RefCnt` 根据运行环境选择三种更新后端：Unsafe、VarHandle 或 `AtomicIntegerFieldUpdater`，见 `RefCnt.java:34-46`。这是一项实现选择，不应被误写成“Netty 永远只用 Unsafe”或“引用计数就是一个普通 volatile int”。

内部字段 `value` 是 `volatile int`，但它保存的是编码后的 raw value：偶数表示活跃引用数，奇数表示已经归零的终止状态，见 `RefCnt.java:50-58`。例如活跃引用数 1 不是直接存 1，而是以 raw value 2 表示；归零会进入奇数状态。

这样编码有一个直接好处：活跃态与终止态可以通过低位区分，release 竞争到终止状态后，其他线程再 retain 或 release 就能被识别为非法生命周期操作。

### 2. retain 为什么不能只是 `refCnt++`

假设两个线程都看到引用数是 1，然后各自执行普通的读改写：

```text
线程 A：读到 1 -> 准备写 2
线程 B：读到 1 -> 准备写 2
最终结果：2
实际应该：3
```

这就是普通 `refCnt++` 在并发下会丢更新的原因。

当前 `RefCnt` 的三个后端都提供原子更新语义。以 Atomic fallback 为例，`retain0` 通过 `getAndAdd` 增加编码后的计数，并检查旧值是否已经处于终止态或发生溢出，见 `RefCnt.java:254-270`。Unsafe 与 VarHandle 后端采用对应的原子加法能力。

所以 `retain()` 的协议不是“把数字加一”这么简单，而是：

```text
尝试增加一份 ownership
  -> 如果对象已经终止或计数溢出
       撤销这次增加并抛出 IllegalReferenceCountException
  -> 否则保留新计数
```

这一步只保证计数更新不会互相覆盖，并不替你创造一份合法 ownership。调用者必须在把 ByteBuf 交给新的异步使用者之前 retain；如果使用者没有真正获得这份引用，盲目 retain 只会制造泄漏。

### 3. release 为什么要把“归零”交给唯一出口

release 的危险在于，多个使用者可能同时完成。假设当前有两份引用：

```text
refCnt = 2
线程 A release -> 1
线程 B release -> 0
```

只有把计数降到 0 的那个 release 才能执行底层释放；如果两个线程都根据各自的旧值判断“我负责释放”，就会出现 double free。

`RefCnt.release` 通过原子更新把计数递减；`AbstractReferenceCountedByteBuf.release()` 得到结果后交给 `handleRelease`，只有结果表示已经归零时才调用 `deallocate()`，见 `AbstractReferenceCountedByteBuf.java:82-101`。Atomic fallback 的 `release0` 使用循环读取、计算 next、CAS 提交，并把奇数终止态作为“已经归零”的信号，见 `RefCnt.java:273-295`。

```text
release()
  -> 原子递减
  -> 没归零：返回 false，不释放底层资源
  -> 恰好归零：返回 true
  -> handleRelease(true)
  -> deallocate()
```

这里的关键不是“release 负责释放”，而是“只有最后一次 release 才有释放资格”。资源释放因此从竞争中的多个调用，收敛成一个确定出口。

### 4. deallocate 为什么必须交给子类

ByteBuf 的公共使用者只想调用 `release()`，但不同实现的底层资源完全不同：

- Heap ByteBuf 持有 Java 数组，数组本身最终由 GC 管理。
- Unpooled Direct ByteBuf 持有堆外资源，通常需要执行对应的 direct buffer 清理；包装外部内存的实现可能设置为不负责释放。
- Pooled ByteBuf 的内存属于池，需要把 chunk/handle 归还给池化结构。

`AbstractReferenceCountedByteBuf` 因此只定义 `protected abstract void deallocate()`，不在基类假设具体资源类型，见 `AbstractReferenceCountedByteBuf.java:98-101`。

不同子类提供自己的释放动作：Heap、Direct、Pooled 的实现分别在 `UnpooledHeapByteBuf.java:548`、`UnpooledDirectByteBuf.java:781`、`PooledByteBuf.java:174`。这形成一条稳定的模板方法链：

```text
公共协议：release()
  -> 基类判断是否归零
  -> 子类 deallocate()
  -> 按底层存储选择释放、清理或归还
```

调用者不需要知道“这块数据来自堆、堆外还是内存池”，但必须知道自己是否拥有一份需要释放的引用。多态隐藏了释放动作，不会替调用者隐藏 ownership 责任。

### 5. ensureAccessible 是访问入口的最后一道门

即使 release 已经把引用数降到 0，旧的 ByteBuf 对象引用仍可能留在业务变量里。为了避免调用者继续通过这个对象访问底层内容，`AbstractByteBuf` 提供 `ensureAccessible()`：当可达性检查开启且 `isAccessible()` 为 false 时，抛出 `IllegalReferenceCountException`，见 `AbstractByteBuf.java:1474-1482`。

内容访问方法会在入口路径上调用它。比如读取、写入、容量修改等操作都要先证明“这块资源还活着”，否则即使索引范围合法，也不能继续访问。

当前 `AbstractReferenceCountedByteBuf.isAccessible()` 使用的是 `RefCnt.isLiveNonVolatile`，源码注释明确说这是为了性能的 best-effort 检查，见 `AbstractReferenceCountedByteBuf.java:33-38`；它不是跨线程生命周期同步原语。

这带来一个必须说清的边界：

```text
ensureAccessible：尽早发现明显的 use-after-release
refCnt 原子更新：让归零与释放只发生一次
ownership 协议：仍由调用者保证 retain/release 配对
```

如果关闭 `io.netty.buffer.checkAccessible`，检查会被跳过，但 release 的计数和 deallocate 逻辑不会因此消失。这个开关改变的是错误发现时机和检查成本，不是资源寿命规则。相关开关在 `AbstractByteBuf.java:49-64` 定义并初始化。

## 六、把双指针、容量和寿命放进一张图

现在回看开篇的 Handler 接力。

ByteBuffer 的单 position 把读写进度压在同一个字段里，所以调用者必须不断切换模式；ByteBuf 用两个索引把读进度和写进度分开，让多个处理阶段可以围绕同一份内容继续推进。

但双指针只是让“数据在哪里”变清楚。数据能不能继续写，还要经过容量边界；数据背后的内存能不能继续碰，还要经过引用计数。

三条协议合起来是：

```text
一、数据位置
readerIndex <= writerIndex <= capacity
  -> readerIndex 之前：已消费，可考虑回收
  -> 两个索引之间：可读内容
  -> writerIndex 之后：可写空间

二、容量增长
writableBytes 不够
  -> discard 或扩容
  -> 不能越过 maxCapacity
  -> ensureWritable 返回结果，交给上层决策

三、资源寿命
创建 -> refCnt=1
  -> 交给新使用者前 retain
  -> 每个使用者完成后 release
  -> 最后一次 release 触发 deallocate
  -> 后续访问由 ensureAccessible 拦截
```

这张图也解释了为什么 ByteBuf 不是“带更多 API 的 byte[]”。它同时管理三种容易互相污染的状态：

- 内容进度：读到哪里、写到哪里。
- 空间边界：当前能写多少、最多允许长到哪里。
- 资源寿命：还有多少使用者、何时可以释放。

Netty 把三者显式拆开，代价是调用者必须理解更多协议；收益是这些协议不再隐藏在 `flip/compact`、GC 时机或某个共享字段里。

## 七、几个最容易错的判断

### 1. “readerIndex 前面的数据自动变成可写空间”

不是。readerIndex 前面的区域只是 discardable，仍然占据物理容量。只有调用 `discardReadBytes()`、`discardSomeReadBytes()`，或者由某个具体实现采用其他回收策略后，它才可能重新形成连续 writable 空间。

### 2. “clear 会清空字节”

不是。clear 只重置索引，旧内容是否仍留在底层存储中与顺序访问协议是两回事。要清理数据内容，需要显式写入或使用适合的安全擦除策略；不要把索引复位当成内存清零。

### 3. “ensureWritable 返回 2 就说明这次请求已经完整放下”

不是。2 表示容量发生了增长；3 才明确表示已经到达 maxCapacity 且仍不足。调用者还要根据新的 writable 空间和业务策略判断是否继续、拆分或失败。

### 4. “引用计数是 1，所以我可以安全访问”

不充分。引用计数只能说明计数状态；你是否拥有当前这份引用、是否与其他线程正确同步、内容索引是否被并发修改，都需要额外成立。

### 5. “CAS 让 ByteBuf 线程安全”

不成立。CAS 主要保护引用计数的更新竞争。ByteBuf 的内容、readerIndex、writerIndex 仍然遵循上层事件循环或调用者的线程模型。

## 收网：ByteBuf 重新发明的是状态边界

现在可以回答开篇的问题：Netty 为什么不满足于 JDK ByteBuffer？

不是因为 ByteBuffer 不能存字节，而是因为网络框架需要同时处理三件事，而 ByteBuffer 的默认模型没有把它们拆开：

1. 多个处理阶段如何在同一块数据上分别推进读写进度。
2. 数据消费后如何在复制、扩容和内存占用之间做选择。
3. 多个异步使用者如何明确表达 ownership，并在最后一次使用完成时释放资源。

ByteBuf 的回答分别是：

```text
读写进度：readerIndex + writerIndex
容量治理：writableBytes + maxCapacity + ensureWritable
资源寿命：refCnt + retain/release + deallocate
```

所以本篇最核心的结论不是“ByteBuf 比 ByteBuffer API 更多”，而是：

```text
ByteBuffer 把很多状态压进 position、limit 和 GC 生命周期
ByteBuf 把数据进度、空间边界、资源寿命拆成三套显式协议
```

拆开之后，问题不会自动消失：discard 仍可能付出 O(N) 拷贝，扩容仍受 maxCapacity 限制，漏 release 仍会泄漏，过早 release 仍会让访问失败。但每个问题都有了独立的责任边界，调用者不必再用一次 `flip()` 同时承担读写模式、数据保留和下一阶段交接三种责任。

下一篇进入 ByteBuf 的创建者：`ByteBufAllocator`。本篇已经知道 ByteBuf “是什么”，接下来要回答的是它“从哪里来”：初始容量如何确定，容量不足时如何计算新容量，Pooled、Unpooled 和不同内存类型又怎样在同一套接口后面切换。