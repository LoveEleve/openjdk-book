# Ch7-08 PendingWriteQueue 与 CoalescingBufferQueue — rewrite-plan

## 篇章定位

- 核心困惑：前面已经知道消息 `write()` 后会进入 `ChannelOutboundBuffer`，但还有两类对象总在出站路径里反复出现：一种是“现在还不能直接写，要先挂起一下”的消息，另一种是“很多小块 ByteBuf 先合在一起，再按需要切出去”的缓冲队列。`PendingWriteQueue`、`AbstractCoalescingBufferQueue`、`CoalescingBufferQueue` 和 `ChannelFlushPromiseNotifier` 到底分别在解决什么问题？
- 一句话顿悟：`ChannelOutboundBuffer` 负责托管已经正式进入出站主线的消息，而 `PendingWriteQueue` 和 `CoalescingBufferQueue` 处理的是更早一层的“暂挂写”和“按字节聚合写”：前者把待写消息和 promise 先挂成一个可失败、可批量写出的队列，并把这些消息同样纳入 writability 账本；后者把很多小 `ByteBuf` 及其 promise/listener 聚成一个字节队列，支持按长度切片取出或整体写出，从而在 framing/写出场景里减少碎片化。
- 文章边界：本篇主讲 `PendingWriteQueue`、`PendingWrite`、`PendingBytesTracker`、`AbstractCoalescingBufferQueue`、`CoalescingBufferQueue`、`ChannelFlushPromiseNotifier` 的职责和协作，重点回答“为什么这些临时队列也必须接入 pending bytes、promise 聚合与消息释放边界”；不重复讲 `ChannelOutboundBuffer` 三阶段、`FlushConsolidationHandler` 和 `Recycler` 公共底盘实现。

## 依赖

### HARD

- Ch7-05 `ch7-pipeline/05-outbound-buffer-and-writability.md`：理解 pending bytes、high/low watermark、userDefinedWritability。
- Ch7-06 `ch7-pipeline/06-write-flush-and-consolidation.md`：理解 write/flush 分离与托管区推进边界。
- Ch7-07 `ch7-pipeline/07-entry-and-writetask-reuse.md`：理解消息本体与热点壳对象的边界。
- Ch4-06 `ch4-bytebuf/06-ownership-and-reference-counting.md`：理解释放消息本体的 ownership 责任。

### SOFT

- Ch8-06：只复用“缓存底层区域描述”和“局部复用面不是第二个池”的对照思路。
- Ch11/12 HTTP/HTTP2：只借 framing / stream 写出场景，不承担硬依赖。

### NAV

- 后续：HTTP/2 `CoalescingBufferQueue` 在 flow-control / stream writing 中的具体使用方。
- 后续：大型对象分块写出和队列聚合的对照专题。

## 素材事实卡片

### 卡片 A：`PendingWriteQueue` 不是普通 List，而是“挂起写 + writability”边界

- 类注释明确：这是待后续执行的写操作队列，同时也要更新 channel 的 writability。
- `add(msg, promise)`：把 `PendingWrite` 链到队尾，统计 `bytes` 和 `PendingBytesTracker`，并 `touch(msg)`。
- 说明：它虽然还没把消息真正交给 `ChannelOutboundBuffer`，但已经先把“这条待写消息的压力”计入了 channel 账本。

### 卡片 B：`removeAndWriteAll()` / `removeAndFailAll()` 是两条最关键的出口

- `removeAndWriteAll()`：清空当前链、通过 `PromiseCombiner` 聚合 promise，再逐条 `invoker.write(msg, promise)`。
- 允许 re-entrant writes：被写 promise 触发的新写会“复活”队列，因此要一直写到空为止。
- `removeAndFailAll()`：逐条 `safeRelease(write.msg)`、fail promise、回收节点。
- 说明：挂起队列不是简单缓存，它必须同时承担批量下放和批量失败清理。

### 卡片 C：`PendingWrite` 和 `Entry` 很像，但站位不同

- `PendingWrite` 也是 Recycler 壳，只保存 `msg/size/promise/next`。
- 但它站在 `ChannelOutboundBuffer` 之前：消息还没正式进入 flushed/unflushed 托管区，先在业务或 handler 层挂起。

### 卡片 D：`AbstractCoalescingBufferQueue` 处理的是“按字节聚合”，不是“按消息排队”

- 内部是 `bufAndListenerPairs`，把 `ByteBuf` 与 `ChannelFutureListener` 配对保存。
- `remove(alloc, bytes, aggregatePromise)` 按长度取出，可切 retained slice、可 compose 成 `CompositeByteBuf`。
- `writeAndRemoveAll(ctx)` 会把剩余 `ByteBuf` 和对应 promise/listener 顺次写出。
- 说明：它关心的是“多少字节能凑成一个输出”，不是“有多少消息待写”。

### 卡片 E：`CoalescingBufferQueue` 是一个面向 Channel 的具体落地

- 继承 `AbstractCoalescingBufferQueue`，提供 `remove(int, ChannelPromise)`、`releaseAndFailAll(Throwable)` 和 `compose(...)`。
- `updateWritability=true` 时会接入 `PendingBytesTracker`，否则只是纯聚合队列。
- 说明：它可以选择既做字节聚合，也做 writability 账本参与者。

### 卡片 F：`ChannelFlushPromiseNotifier` 处理的是“写到某个字节检查点后完成哪些 promise”

- `add(promise, pendingDataSize)` 记录 flush checkpoint。
- `increaseWriteCounter(...)` 推进已写字节计数。
- `notifyPromises(...)` 在 checkpoint 达成后 success/fail 对应 promise。
- 说明：它是“按写出进度完成 promise”的辅助器，不是一般的队列。

## 理解路径

1. **从出站主线的空白处切入**：不是所有消息都会立刻进 `ChannelOutboundBuffer`，也不是所有写出都天然是按消息边界处理。
2. **先拆两类问题**：挂起写（PendingWriteQueue）和按字节聚合（CoalescingBufferQueue）。
3. **讲 PendingWriteQueue**：为什么还没正式写出去，也必须先纳入 writability、release 和 promise 语义。
4. **讲 CoalescingBufferQueue**：为什么很多小 ByteBuf 需要按“字节长度”而不是“消息条数”组织。
5. **最后把它们和主线接回去**：它们不是第二个 `ChannelOutboundBuffer`，而是位于它之前、旁边或上面的辅助托管层。

## 失败方案推演

- 挂起写但不计入 pending bytes：channel 可写性会乐观失真。
- 挂起写失败时不 release msg：消息 leak。
- 小块 ByteBuf 各写各的，不做字节聚合：写路径碎片化，promise 粒度也更难管理。
- 只按消息条数组织聚合队列：无法支持“我要先取 7 个字节，剩余 5 个字节下次再写”的 framing 场景。
- 只把这些队列当纯容器，不让它们参与 promise/listener 回调：完成与失败边界会错位。

## 文章结构与预算

1. 开场：出站主线之外为什么还需要两类辅助队列（900-1200 字）
2. `PendingWriteQueue`：挂起写、writability、批量写出/失败（2000-2600 字）
3. `PendingWrite` 壳与 `ChannelOutboundBuffer.Entry` 的位置差异（1200-1600 字）
4. `AbstractCoalescingBufferQueue`：按字节聚合、切片取出、listener 配对（2200-2800 字）
5. `CoalescingBufferQueue` 与 `ChannelFlushPromiseNotifier`：聚合写出和检查点完成（1600-2200 字）
6. 测试回读：reentrant write/fail、writability changed、partial read/merge（1600-2200 字）
7. 收网：它们和出站主线的关系（600-900 字）

目标：去掉代码块后的叙述性正文 9000-11500 字，最低不低于 8000 字。

## 证据清单

- `transport/src/main/java/io/netty/channel/PendingWriteQueue.java:29-341`
- `transport/src/main/java/io/netty/channel/AbstractCoalescingBufferQueue.java:31-432`
- `transport/src/main/java/io/netty/channel/CoalescingBufferQueue.java:23-85`
- `transport/src/main/java/io/netty/channel/ChannelFlushPromiseNotifier.java:25-220`
- `transport/src/test/java/io/netty/channel/PendingWriteQueueTest.java:41-259`
- `transport/src/test/java/io/netty/channel/CoalescingBufferQueueTest.java:72-257`

## 边界清单

- 本篇不重复展开 `ChannelOutboundBuffer` 三阶段与 watermarks 主线。
- 本篇不把 `CoalescingBufferQueue` 写成通用对象队列，它是 ByteBuf 字节聚合队列。
- 本篇不把 `ChannelFlushPromiseNotifier` 写成一般 promise 聚合器，它依赖写出字节检查点。
- 本篇不把 `PendingWriteQueue` 写成“已经进入传输层”的队列，它仍位于正式托管区之前。

## 深审预警

- [ ] 不把 `PendingWriteQueue` 和 `ChannelOutboundBuffer` 混成同一层。
- [ ] 不把挂起写阶段排除在 writability 账本之外。
- [ ] 不把 `CoalescingBufferQueue` 写成按消息条数消费。
- [ ] 不把部分读取 / retained slice 的引用计数边界写漏。
- [ ] 不把 re-entrant write/fail 测试忽略掉。