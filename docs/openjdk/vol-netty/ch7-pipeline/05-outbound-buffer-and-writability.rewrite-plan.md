# Ch7-05 ChannelOutboundBuffer 与 writability — rewrite-plan

## 篇章定位

- 核心困惑：业务代码明明只是 `write()` 了一下，为什么 `channel.isWritable()` 会突然变成 `false`？`writeBufferHighWaterMark/LowWaterMark` 到底控制的是什么？对象写出去之前先去了哪里？
- 一句话顿悟：`write()` 并不是立刻发包，而是先把消息放进 `ChannelOutboundBuffer`；这个缓冲区一边托管消息生命周期，一边用 `totalPendingSize + WriteBufferWaterMark + userDefinedWritability` 共同决定 channel 当前是否还可继续无节制写入。
- 文章边界：本篇主讲 `ChannelOutboundBuffer`、`WriteBufferWaterMark`、`PendingBytesTracker` 与 `channelWritabilityChanged` 这条背压主线，主讲消息从 `addMessage -> addFlush -> remove/removeBytes` 的阶段变化、high/low watermark 的双阈值语义、`bytesBeforeWritable/Unwritable` 的观测意义、用户自定义 writability 位；`PendingWriteQueue` 与 `FlushConsolidationHandler` 留给后续篇分别展开。

## 依赖

### HARD

- Ch2-01 `ch2-channel/01-read-write.md`：理解 write 和真实 socket 发送不是同一时刻。
- Ch6-01 `ch6-promise/01-state-model-and-listeners.md`：理解一次 write 对应异步完成，而不是同步 return。
- Ch7-01 `ch7-pipeline/01-pipeline-structure.md`：理解 outbound 事件沿 pipeline 传播。
- Ch4-06 `ch4-bytebuf/06-ownership-and-reference-counting.md`：理解对象写出前后 ownership 会发生阶段性交接。
- Ch4-07 `ch4-bytebuf/07-leak-detector-and-tracking.md`：理解为什么 `addMessage` / `PendingWriteQueue` 会先 `touch(msg)`。

### SOFT

- Ch10 codec：这里只借用“出站消息可能不是裸 ByteBuf，而是 ByteBufHolder / FileRegion”等场景。
- Ch8 memory pool：这里只需要知道 pending bytes 会推迟池化对象归还时机。

### NAV

- 后续篇（待写）：`PendingWriteQueue` 如何把“稍后再写”的消息也纳入背压体系。
- 后续篇（待写）：`write / flush` 与 `FlushConsolidationHandler` 如何减少 syscall。
- HTTP/2 后续篇：stream 级 writability 与连接级 writability 如何交织。

## 素材事实卡片

### 卡片 A：write 先进入缓冲区，不等于立刻发送

- `ChannelOutboundBuffer.addMessage(...)`：新消息先包装成 `Entry` 链到 tail，进入 `unflushedEntry` 区域。
- `addFlush()`：不是发送，只是把当前 `unflushedEntry` 批次标记成 flushed，可供后续 `doWrite` 处理。
- `current()/remove()/removeBytes()`：消息真正写出或部分写出时，才从 flushed 区域向前推进。
- 结论：`write`、`flush`、`remove` 三个阶段分别对应“入队”“允许发送”“真正移除”。

### 卡片 B：背压靠的是 pending bytes，不是消息个数

- `Entry.pendingSize = size + CHANNEL_OUTBOUND_BUFFER_ENTRY_OVERHEAD`，说明背压统计不是只看 payload，还把 entry 开销算进去。
- `incrementPendingOutboundBytes()`：`TOTAL_PENDING_SIZE_UPDATER.addAndGet` 后，若超过 high watermark 就 `setUnwritable`。
- `decrementPendingOutboundBytes()`：跌破 low watermark 时才 `setWritable`。
- `total(Object msg)`：`ByteBuf` 按 readableBytes，`FileRegion` 按 count，`ByteBufHolder` 按 content.readableBytes。
- 结论：Netty 背压统计的是“待发送总字节规模”，不是“排队消息数量”。

### 卡片 C：为什么 high/low 要用双阈值

- `WriteBufferWaterMark` 文档：超过 high 才变不可写，降回 low 以下才恢复可写。
- `bytesBeforeUnwritable()` / `bytesBeforeWritable()`：通过 `+1` 说明状态改变条件是“越过阈值”，不是“等于阈值”。
- 结论：双阈值的本质是给 writability 加滞后区，避免在边界值附近抖动。

### 卡片 D：writability 不只受总字节数影响

- `ChannelOutboundBufferTest.testUserDefinedWritability*`：用户定义位默认都为 true，但任一位为 false 都会让 `channel.isWritable()` 变成 false。
- `testMixedWritability`：即便 `totalPendingWriteBytes` 已降到 0，只要用户定义位仍为 false，channel 仍保持不可写。
- 结论：channel 可写性是系统位与用户位共同决定的，不是单看 watermark。

### 卡片 E：PendingBytesTracker 解释了“谁来统计 pending bytes”

- `PendingBytesTracker.newTracker(channel)`：优先挂到 `DefaultChannelPipeline`，否则退回 `ChannelOutboundBuffer`，channel 已关闭则可能退化成 noop。
- 结论：Netty 背压统计不是某个类私有逻辑，而是 pipeline / outbound buffer 共享的一层基础设施。

### 卡片 F：测试暴露了最容易误解的时序

- `ReentrantChannelTest` 注释展示非 I/O 线程 write、I/O 线程处理 write、再次入 `ChannelOutboundBuffer`、最终 flush 移除这一串时序，`channelWritabilityChanged` 可能多次交错发生。
- `ChannelOutboundBufferTest.testWriteTaskRejected`：即使任务被拒绝，也必须把 pending bytes 清零并释放对象。
- 结论：writability 变化是运行时时序现象，不是“写一点数据就只变一次布尔值”的简单模型。

## 理解路径

1. **从业务错觉开场**：`write()` 看起来像发包，但实际先进入托管区。
2. **画缓冲区三段图**：unflushed、flushed、removed 三种阶段，而不是“队列里/队列外”两态。
3. **解释 pending bytes 为什么比消息个数更重要**：背压要防的是内存和写出压力，不是排队条目数量。
4. **给出双阈值失败方案**：如果只有一个阈值，边界附近会抖动；high/low 正是迟滞带。
5. **再讲 writability 的完整定义**：总字节数系统位 + 用户自定义位，共同形成最终 `isWritable()`。
6. **用测试补时序认知**：非 I/O 线程写入、任务拒绝、重入 flush 都会让 writability 变化比直觉复杂。
7. **收网到排障**：看到 `channelWritabilityChanged` 频繁触发时，不要先怪网络，而要先看 pending bytes、watermark、用户位和 flush 时机。

## 失败方案推演

- 只按消息个数背压：一个 1KB 包和一个 10MB 包会被同等对待，无法真实反映压力。
- 只有一个阈值：在边界附近会频繁 writable/unwritable 抖动，事件风暴明显。
- `write()` 就立刻减 pending bytes：会把尚未真正发送的对象当作已完成，背压失真。
- 只统计系统位，不允许用户位：业务无法表达“我自己知道当前下游也需要停写”的额外约束。
- 任务拒绝或失败时不清零 pending bytes：channel 会永久卡在错误的不可写状态。

## 文章结构与预算

1. 开场：为什么 `write()` 之后 `isWritable()` 会变（1000-1400 字）
2. `ChannelOutboundBuffer` 三阶段：入队、flush 标记、真正移除（1800-2400 字）
3. pending bytes：为什么背压按字节数统计（1600-2200 字）
4. high/low watermark：为什么需要双阈值迟滞带（1600-2200 字）
5. writability 总图：系统位、用户位、`bytesBefore*` 与观测接口（1800-2400 字）
6. 时序与测试：非 I/O 线程写入、任务拒绝、重入触发（1600-2200 字）
7. 排障方法：看到不可写或频繁回调以后该怎么判断（1000-1500 字）
8. 收网：桥接到 `PendingWriteQueue`、`flush`、HTTP/2 流控（600-900 字）

目标：去掉代码块后的叙述性正文 9000-12000 字，最低不低于 8000 字。

## 证据清单

- `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:114-169`
- `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:176-208`
- `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:210-220`
- `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:275-345`
- `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:365-429`
- `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:761-788`
- `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:826-876`
- `transport/src/main/java/io/netty/channel/WriteBufferWaterMark.java:21-35`
- `transport/src/main/java/io/netty/channel/WriteBufferWaterMark.java:38-85`
- `transport/src/main/java/io/netty/channel/PendingBytesTracker.java:20-104`
- `transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:333-425`
- `transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:430-509`
- `transport/src/test/java/io/netty/channel/ReentrantChannelTest.java:60-109`

## 边界清单

- 本篇不把 `PendingWriteQueue` 展开成完整主题，只借它作为后续桥接。
- 本篇不完整展开 `flush` 合并、syscall 优化和 `FlushConsolidationHandler`，只建立 `write != flush != remove` 的最低心智模型。
- 本篇不把 `channel.isWritable()` 写成底层 socket 内核缓冲区的直接镜像；这里讨论的是 Netty 用户态托管区语义。
- 本篇不把 `MessageSizeEstimator` 的所有实现细节展开，只说明它决定不同消息类型如何折算到 pending bytes。

## 深审预警

- [ ] 不把 `write()` 说成立刻发送成功。
- [ ] 不把 high/low watermark 写成“到达阈值就切换”，当前实现是越过阈值才切换。
- [ ] 不把 `isWritable()` 写成只受 pending bytes 影响，要写出用户自定义位。
- [ ] 不把 `ChannelOutboundBuffer.close` 的失败清理写成正常成功路径。
- [ ] 不把测试里的特定时序外推成所有线程调度下的唯一顺序，只能作为“可能发生的交错”证据。