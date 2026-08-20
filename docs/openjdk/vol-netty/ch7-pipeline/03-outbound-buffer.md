# 出站与写缓冲区：`write()` 不是发包，`flush()` 才是真正推进 I/O

> 本文基于当前 Netty `AbstractChannelHandlerContext` 与 `ChannelOutboundBuffer` 实现。前置：Ch7-01 `01-pipeline-structure.md`、Ch7-02 `02-handler-types.md`、Ch4 ByteBuf、Ch6 Promise；本文解释出站传播、`ChannelOutboundBuffer` 的三指针链、`nioBuffers()` 聚集写和高低水位反压，不展开 initializer 与 handler 生命周期。

## `ctx.write(msg)` 之后，数据到底去哪了

入站路径的直觉通常比较强：Socket 可读了，数据被读进 ByteBuf，沿 inbound handler 一路往上传。

出站路径则很容易被想得过于简单：

```text
ctx.write(msg)
  -> head
  -> Socket.write(...)
```

这其实不符合 Netty 的真实设计。

如果每次 `write(msg)` 都立刻打一次系统调用，那么：

- 10 次小消息就有 10 次 syscall。
- handler 根本没有机会批量编码、合并或攒写。
- 用户也失去了“先写多条，再统一 flush”的控制权。

所以 Netty 把出站拆成了两个阶段：

```text
write
  -> 把消息挂到待发送结构里

flush
  -> 把已经挂好的那一段真正推进到底层 I/O
```

这就是 `ChannelOutboundBuffer` 的意义。它不是“又一个缓存类”这么轻，而是出站路径真正的中转站：消息、Promise、进度、pending bytes 和可写性状态都在这里会合。

本篇最重要的判断不是“有个链表叫 ChannelOutboundBuffer”，而是：

```text
Netty 不把 write 理解成“立刻发出去”
而把它理解成“声明一条待发送操作”
真正的 I/O 推进留给 flush 和底层 transport
```

## 一、先看出站传播：tail 发起请求，head 才真正打到 `unsafe`

### 1. `write()` 和 `flush()` 在 Pipeline 里是两种不同事件

`AbstractChannelHandlerContext` 里，`write(msg, promise)` 和 `flush()` 是两套独立的传播路径。

- `flush()` 会 `findContextOutbound(MASK_FLUSH)`，找到下一个关心 flush 的 outbound context，再决定是直接调用还是切到对应 executor，见 `AbstractChannelHandlerContext.java:741-772`。
- `write(msg, promise)` 会 `findContextOutbound(MASK_WRITE)`，如果是 `writeAndFlush` 则同时要求 `MASK_WRITE | MASK_FLUSH`，然后把消息 `touch` 一次，再交给对应 outbound handler 或封装成 `WriteTask`，见 `AbstractChannelHandlerContext.java:780-841`。

也就是说，在 Pipeline 眼里：

```text
write
  -> 表示“请把这条消息纳入出站路径”

flush
  -> 表示“请把已经进入出站路径的内容真正往前推进”
```

它们经常一起出现，但不是同一个动作。

### 2. 为什么 Pipeline 自身的出站入口从 tail 开始

上一节已经讲过，`DefaultChannelPipeline.write(...)` 和 `flush()` 最终都从 tail 发起，见 `DefaultChannelPipeline.java:987-1044`。

这看起来像个反直觉的细节，其实正好契合出站方向：

```text
业务代码站在“链的上层”发起 write/flush
所以传播要从 tail 往前找最近的 outbound 节点
最后走到 head，再落到 unsafe.write/flush
```

而 `HeadContext` 的 `write/flush` 最终会调用 `unsafe.write(msg, promise)` 与 `unsafe.flush()`，见 `DefaultChannelPipeline.java:1385-1391`。这说明 head 的职责并不是“缓存消息”，而是把出站逻辑真正落到 Channel 底层。

所以最小总图可以先压成：

```text
pipeline.write(msg)
  -> tail.write(msg)
  -> 若干 outbound handlers
  -> head.write(...)
  -> unsafe.write(...)

pipeline.flush()
  -> tail.flush()
  -> 若干 outbound handlers
  -> head.flush()
  -> unsafe.flush()
```

### 3. `writeAndFlush` 只是把两条路径串在一起

`writeAndFlush(msg, promise)` 并没有发明第三种动作，它只是先按 `write(msg, true, promise)` 走出站查找，再在合适的 outbound 节点后紧接着执行 flush 分支，见 `AbstractChannelHandlerContext.java:775-826`。

这点必须先记住，否则后面看 `ChannelOutboundBuffer` 时容易混乱：

```text
writeOnly       -> 消息进入缓冲区，但未必立刻触发底层写
writeAndFlush   -> 消息进入缓冲区，并在同一轮推进 flush
```

所以“数据什么时候真正往 Socket 走”从一开始就被拆成了显式阶段，而不是塞在 write 里自动完成。

## 二、`ChannelOutboundBuffer` 的三指针链：消息不是排成一列，而是分成两个阶段

### 1. 三个指针不是三份副本，而是同一条链上的三个分界

`ChannelOutboundBuffer` 最关键的字段是：

- `flushedEntry`
- `unflushedEntry`
- `tailEntry`

外加一个 `flushed` 计数，见 `ChannelOutboundBuffer.java:76-85`。

源码注释直接给出了链表关系：

```text
Entry(flushedEntry) --> ... Entry(unflushedEntry) --> ... Entry(tailEntry)
```

这不是说系统里同时存在三条链，而是同一条 entry 单链表被两个游标切成了两个阶段：

```text
[flushedEntry, unflushedEntry)   -> 已 flush，等待真正写出
[unflushedEntry, tailEntry]      -> 已 write，但还没 flush
```

这里的 `tailEntry` 不是独立的尾哨兵对象，而是“当前链表最后一个实际 Entry 的引用”。它的作用是让新消息可以 O(1) 追加到尾部。

所以写缓冲区最容易记错的一点是：

```text
write 之后不是“消息就排队等待 Socket 写”这么简单
它先进入 unflushed 阶段
flush 之后才进入 flushed 阶段
```

这两个阶段分别回答：

- 这条消息用户已经提交了吗？
- 这条消息这轮是否已经被允许进入真正写出的批次？

### 2. `addMessage` 做的是“挂链 + 计账 + 泄漏追踪”

`addMessage(msg, size, promise)` 会先创建一个 Entry；如果当前尾巴为空，就初始化；否则把新 entry 接到旧 tail 后面。然后更新 `tailEntry`，必要时设置 `unflushedEntry`，对消息执行 `touch()`，最后增加 `pendingOutboundBytes`，见 `ChannelOutboundBuffer.java:114-140`。

这条路径说明 write 阶段做了四件事：

```text
创建 Entry
  -> 挂到 tail
  -> 让消息进入 unflushed 区段
  -> 记录 pending bytes
  -> 为泄漏排查 touch 消息
```

它还没有做的事情是：

- 没有把消息标记成 flushed。
- 没有把 ByteBuf 收集成 `ByteBuffer[]`。
- 没有调用 transport 的实际写方法。
- 没有完成 promise。

所以如果只看 `ctx.write(msg)`，消息只是被“记到出站账本里”，不是已经发出。

### 3. `addFlush` 是把整段 unflushed 批量转成 flushed

`addFlush()` 从 `unflushedEntry` 开始遍历：如果当前还没有 `flushedEntry`，就让它指向这段开头；接着对这段每个 entry：

- `flushed++`
- 把 promise 标成 uncancellable
- 如果 promise 已经取消，则取消 entry、回收 pending bytes

最后把 `unflushedEntry` 设为 null，见 `ChannelOutboundBuffer.java:146-170`。

这说明 flush 的语义不是“逐条立刻写 socket”，而是：

```text
把当前这批已 write 未 flush 的消息
整体划到“允许真正写出”的 flushed 区段
```

于是最小状态图就是：

```text
write(msg1) -> unflushed: [msg1]
write(msg2) -> unflushed: [msg1, msg2]
flush()     -> flushed:   [msg1, msg2], unflushed 清空
```

这也是为什么 `write` 和 `flush` 分离后，Netty 才有了真正的攒批空间：多条消息可以先进入同一个 unflushed 段，再被一次 flush 统一推进。

## 三、Entry：一条待发送消息为什么要同时保存 msg、promise、size、progress

### 1. 出站不是只存消息，还要存结果和状态

`ChannelOutboundBuffer.Entry` 里保存的字段包括：

- `msg`
- `promise`
- `pendingSize`
- `progress`
- `total`
- `buf` / `bufs`
- `count`
- `cancelled`

见 `ChannelOutboundBuffer.java:826-898`。

这说明一条出站消息在 Netty 看来，从来不是“裸消息体”，而是一个完整的发送条目：

```text
我要发什么
发这件事对应哪个 promise
这条消息还占多少 pending bytes
如果是 progressive promise，已经推进了多少
如果已经生成过 nio buffer 视图，缓存在哪里
这条消息是否已经取消
```

这也是为什么不能把 ChannelOutboundBuffer 简化成“ByteBuf 链表”。它其实是“待发送操作链表”。

### 2. `pendingSize` 不是纯 payload 大小

`Entry.newInstance` 会把 `pendingSize` 设为：

```text
size + CHANNEL_OUTBOUND_BUFFER_ENTRY_OVERHEAD
```

见 `ChannelOutboundBuffer.java:850-857`。

也就是说，出站缓冲统计的不只是 payload 字节数，还考虑 entry 自身的额外开销。这样高低水位和总 pending size 的判断，就不只是“消息内容多大”，而是“这批待发送条目整体大概占了多少资源”。

### 3. `remove()` 才是真正把“这条消息成功发完了”落账

`remove()` 会拿当前 `flushedEntry`，把它从链上摘掉；如果 entry 之前没被取消，就：

- 释放 msg
- `safeSuccess(promise)`
- 扣减 pending bytes
- 回收 entry

见 `ChannelOutboundBuffer.java:275-345`。

这条路径把三个维度真正合到一起了：

```text
写出成功
  -> 资源释放
  -> Promise 完成
  -> 反压计数下降
```

所以“消息什么时候算真正发完”，不是在 `write()` 那一刻，而是在底层写出推进到足以移除 entry 的那一刻。

### 4. progressive promise 的进度也在这里推进

`progress(amount)` 会累加当前 flushed entry 的 progress，并在 promise 是 `DefaultChannelProgressivePromise` 或 `ChannelProgressivePromise` 时调用 `tryProgress(progress, total)`，见 `ChannelOutboundBuffer.java:247-268`。

这说明出站进度不是 Promise 自己凭空知道的，而是写缓冲区在“底层已经写出多少字节”这个节点上最清楚，因此由它来推进最自然。

它还做了一个快路径：如果 promise 类就是 `VoidChannelPromise` 或 `DefaultChannelPromise`，直接 return。因为这两种 promise 根本不关心进度。

所以 Entry 保存 `progress/total` 不是附带信息，而是 progressive 写路径的必要状态。

## 四、`nioBuffers()`：不是把消息拼成一个大 buffer，而是收集引用后聚集写

### 1. 聚集写的关键在“收集 ByteBuffer 引用”而不是复制内容

`nioBuffers(maxCount, maxBytes)` 会从 `flushedEntry` 开始遍历，只要 entry 是 flushed 且 msg 是 `ByteBuf`，就尝试把它转换成一个或多个 `ByteBuffer`，并放入线程本地数组中，见 `ChannelOutboundBuffer.java:414-496`。

这条路径的重点不在“新建更大的连续 buffer”，而在：

```text
从多条已 flush 的 ByteBuf
提取它们的 NIO 视图
组织成一个 ByteBuffer[]
交给底层 gather write / writev 路径
```

所以它节省的是：

- 不需要把多条消息再复制拼成一个新 ByteBuf。
- 允许一次底层写调用处理多个缓冲区。

但也要收住边界：这不是说所有路径都 zero-copy 到网卡，而是说在用户态准备阶段没有新增“拼成一个大连续 buffer”的那次复制。

### 2. `FastThreadLocal` 数组是为了高频复用，不是固定 1024 死限制

`NIO_BUFFERS` 是一个 `FastThreadLocal<ByteBuffer[]>`，初始长度 1024，见 `ChannelOutboundBuffer.java:67-72`。

但这不是硬编码上限。`nioBuffers()` 里如果发现需要的槽位超过当前数组长度，就会调用 `expandNioBufferArray()` 翻倍扩容，并把新数组重新放回线程本地缓存，见 `ChannelOutboundBuffer.java:467-470`、`:517-534`。

因此当前实现的真实语义是：

```text
默认先给 1024 槽
不够就翻倍
以后继续复用扩大的数组
```

所以不能把它写成“Netty 一次最多只能聚集 1024 个 ByteBuffer”。1024 只是线程本地数组的初始容量，不是协议上限。

### 3. `maxCount` / `maxBytes` 说明聚集写也受边界约束

`nioBuffers(maxCount, maxBytes)` 不是“把能放的都放进去”。它会在计数和总字节数上做边界控制：

- `maxCount` 限制最多收集多少个 `ByteBuffer`
- `maxBytes` 给出目标总字节数，虽然为了保证至少有进度，允许轻微超出

见 `ChannelOutboundBuffer.java:427-460`。

这说明聚集写也不是无限堆料。底层 OS、平台和 transport 路径都有自己的接受上限；Netty 在用户态先把这条边界编码出来，避免把不合理的大批次塞进一次写调用。

### 4. 单 buffer 和多 buffer 走的是不同缓存路径

如果某个 entry 只有一个 NIO buffer，`nioBuffers()` 会把它缓存到 `entry.buf`；如果有多个，就缓存到 `entry.bufs`，见 `ChannelOutboundBuffer.java:472-515`。

这再次体现了当前实现的目标：

```text
不是每次都重新构建 ByteBuffer 视图
而是尽可能复用 entry 里已经生成过的视图数组/单体引用
```

所以 `nioBuffers()` 不是只在做“拼装”，它也在做视图缓存和对象分配控制。

## 五、高低水位和 `unwritable`：写不会阻塞你，但会通过状态告诉你该收手了

### 1. 超过 highWaterMark 不是阻塞，而是切换可写性状态

`ChannelOutboundBuffer` 通过 `totalPendingSize` 跟踪待发送总量；一旦增加后超过 `writeBufferHighWaterMark`，就调用 `setUnwritable()`，见 `ChannelOutboundBuffer.java:176-189`。当减少后低于 `writeBufferLowWaterMark`，就调用 `setWritable()`，见 `ChannelOutboundBuffer.java:195-207`。

这里最关键的一点是：它没有把当前线程阻塞住。

也就是说：

```text
高水位触发
  -> 不是让 write() 在这里睡住
  -> 而是把 channel 的 writability 状态切成 false
  -> 再通过事件通知上层“你最好别继续猛写了”
```

这是一种反压反馈，而不是同步阻塞。

### 2. `unwritable` 不是布尔值，而是 32 位掩码

当前实现里，`unwritable` 是一个 `int` 位掩码，bit0 用于系统水位线；bit1 到 bit31 留给用户自定义可写性标记，见 `ChannelOutboundBuffer.java:98-104`、`:554-616`。

所以 channel “不可写”并不一定只来自一个原因。它可能是：

- 当前 pending bytes 超过高水位。
- 某个业务层自定义位把它标成不可写。
- 或两者同时成立。

这让反压从一个简单的“太大了/又变小了”布尔条件，升级成可组合的状态位集合。

### 3. writability 变化会回到 Pipeline

当 `setWritable` / `setUnwritable` 真的发生状态边界翻转时，`fireChannelWritabilityChanged` 会通知 pipeline；必要时它会把通知包装成任务丢给 `channel.eventLoop()`，见 `ChannelOutboundBuffer.java:618-660`。

这点非常重要，因为反压不是写缓冲区的内部私事。它必须回到 Pipeline，交给 handler 决定：

```text
我现在该暂停上游写入吗？
我可以恢复发送了吗？
```

所以高低水位不是 “ChannelOutboundBuffer 自己偷偷做的一个阈值判断”，而是出站反压和上层 handler 协作的接口。

## 六、最容易错的五个判断

### 1. `write(msg)` 就等于已经开始写 Socket

不成立。`write` 只是把消息挂到 `ChannelOutboundBuffer` 的 unflushed 段；真正推进到底层 I/O 还要等 `flush()` 和 transport 写路径。

### 2. `flush()` 只是一个小提示，不影响内部结构

不成立。`addFlush()` 会把整段 unflushed 区间整体迁到 flushed 区间，这是出站状态转换的关键一步。

### 3. `nioBuffers()` 是把多条消息复制拼成一个大数组再发

不成立。它收集的是 `ByteBuffer` 引用/视图，并尽量复用线程本地数组和 entry 缓存；不等于先复制成一个大连续 ByteBuf。

### 4. 高水位触发后，写调用会在用户线程里阻塞

不成立。高低水位通过 writability 状态和事件回调反馈反压，不是同步阻塞写线程。

### 5. `FastThreadLocal` 的 1024 数组不够了就只能失败

不成立。当前实现会在需要时翻倍扩容，并继续缓存复用。

## 收网：出站路径真正的核心，是“先挂链，再推进，再回压”

现在可以回到开篇的问题：`ctx.write(msg)` 之后，数据到底去哪了？

答案不是“马上写进 Socket”，而是：

```text
先进入 Pipeline 的 outbound 传播
  -> 最终到 head / unsafe
  -> 先变成 ChannelOutboundBuffer.Entry 挂进缓冲链
  -> flush 时整段迁入 flushed 区
  -> transport 再通过 nioBuffers()/doWrite 真正推进到底层 I/O
```

在这个过程中，`ChannelOutboundBuffer` 同时承担了四件事：

- 用 `Entry` 链保存待发送操作。
- 用 `promise` 绑定异步完成结果。
- 用 `nioBuffers()` 为聚集写准备视图。
- 用高低水位和 `unwritable` 状态把反压传回 Pipeline。

所以 Ch7-03 最该带走的结论不是“有个三指针链表”，虽然这句话没错；真正该记住的是：

```text
Netty 把“提交写请求”和“真正触发 I/O”拆成了两个阶段
正因为如此，它才有空间做攒批、聚集写、进度通知和反压反馈
```

下一篇进入初始化与生命周期。因为到这里为止，我们已经知道事件怎么传播、消息怎么写出，但还没讲清一个更动态的问题：handler 什么时候真正 `handlerAdded()`？为什么 `ChannelInitializer` 初始化完要把自己移除？Pipeline 的生命周期动作如何和 Channel 注册时机对齐？