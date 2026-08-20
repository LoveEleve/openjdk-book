# Ch7-07 ChannelOutboundBuffer.Entry 与 WriteTask：复用落点专题 — rewrite-plan

## 篇章定位

- 核心困惑：前面已经知道 Netty 有 `Recycler`、`FastThreadLocal`、`PoolThreadCache` 这些基础设施，但这些“公共底盘”到底落在哪些真实热点对象上？`ChannelOutboundBuffer.Entry` 和 `AbstractChannelHandlerContext.WriteTask` 为什么值得单独拿出来讲？
- 一句话顿悟：Netty 并没有把对象复用停留在公共工具层，而是把它精准打在出站主链最容易高频 churn 的两个节点上：`ChannelOutboundBuffer.Entry` 复用的是“消息排队包装壳”，`WriteTask` 复用的是“跨 executor 写任务壳”，两者都不是复用业务消息本体，而是复用围绕消息产生的热点运行时包装对象，并把 pending bytes、失败回滚和对象释放边界一起纳入回收路径。
- 文章边界：本篇主讲 `ChannelOutboundBuffer.Entry`、`AbstractChannelHandlerContext.WriteTask` 的创建、复用、取消、回收和 pending bytes 协作；强调它们与 `Recycler`、`ChannelOutboundBuffer`、pipeline 出站调度的关系；不展开 `Recycler` 内部队列实现、不重讲 `ChannelOutboundBuffer` / writability / flush 主线。

## 依赖

### HARD

- Ch5-03 `ch5-eventloop/03-fastthreadlocal-and-recycler.md`：理解 `Recycler` 的受控复用语义。
- Ch7-05 `ch7-pipeline/05-outbound-buffer-and-writability.md`：理解 `ChannelOutboundBuffer`、pending bytes、writability。
- Ch7-06 `ch7-pipeline/06-write-flush-and-consolidation.md`：理解 write/flush 的托管区与调度边界。
- Ch4-06 `ch4-bytebuf/06-ownership-and-reference-counting.md`：理解对象本体与包装壳的所有权边界。

### SOFT

- Ch8-06：只复用“缓存底层区域描述”和“缓存对象壳不是一回事”的对照思路。
- Ch6 promise：只复用 promise/future 失败与完成模型。

### NAV

- 后续：pipeline 异步跨 executor 出站路径。
- 后续：RejectedExecution 与关闭路径的更系统排障专题。

## 素材事实卡片

### 卡片 A：`ChannelOutboundBuffer.Entry` 复用的是什么

- `Entry` 自带 `Recycler<Entry>`。
- `newInstance(...)` 只设置 msg/pendingSize/total/promise，不新建底层消息对象。
- `cancel()` 释放消息本体并把 msg 替换成 `Unpooled.EMPTY_BUFFER`。
- `unguardedRecycle()` 清空 next/bufs/buf/msg/promise/progress/total/pendingSize/count/cancelled。
- 结论：Entry 复用的是排队壳与其元数据，不是消息 payload。

### 卡片 B：Entry 与 pending bytes 的关系

- `pendingSize = size + CHANNEL_OUTBOUND_BUFFER_ENTRY_OVERHEAD`。
- 说明 Entry 自己就是 writability/pending bytes 模型的一部分，而不是纯零成本壳。
- cancel/remove/recycle 必须和 pending bytes 一起考虑。

### 卡片 C：`WriteTask` 复用的是什么

- `WriteTask` 自带 `Recycler<WriteTask>`。
- `newInstance/init(...)` 绑定 ctx/msg/promise/flush 标志；必要时估算任务大小并给 pipeline 增加 pending outbound bytes。
- `run()` 先减 pending bytes，再执行 `ctx.write(msg, flush, promise)`，最后 recycle 自己。
- `cancel()` 也必须先减 pending bytes，再 recycle。
- 结论：WriteTask 复用的是“跨 executor 写任务壳”，同时它把任务本身也纳入 pending bytes 账本。

### 卡片 D：任务大小估算不是装饰品

- `ESTIMATE_TASK_SIZE_ON_SUBMIT` 和 `WRITE_TASK_OVERHEAD` 控制是否把异步提交任务也计入 pipeline pending bytes。
- 这意味着在消息真正进入 `ChannelOutboundBuffer` 之前，pipeline 已经可能先因为待执行写任务而被算进背压。

### 卡片 E：失败/拒绝路径证明复用不能脱离清理边界

- `AbstractChannelHandlerContext.safeExecute(...)` 在任务提交失败时 release msg 并 fail promise。
- `ChannelOutboundBufferTest.testWriteTaskRejected` 验证 rejected task 后 `totalPendingWriteBytes()` 必须回到 0，消息引用计数也必须归零。
- 结论：对象壳的复用如果不和 pending bytes、失败释放一起设计，就会直接污染 writability 和 ownership 语义。

## 理解路径

1. **从误解开场**：Netty 复用的不是业务消息本体，而是围绕消息产生的高频运行时壳。
2. **先讲 Entry**：为什么消息进入 `ChannelOutboundBuffer` 时需要一个可复用的排队壳。
3. **再讲 WriteTask**：为什么跨 executor 写入时需要一个可复用的任务壳，而且它还要进入 pending bytes 账本。
4. **把两者放到同一张图里**：Entry 属于托管区内部壳，WriteTask 属于托管区之前的异步任务壳。
5. **最后讲失败边界**：取消、拒绝、释放、pending bytes 回滚、recycle 必须同步发生。

## 失败方案推演

- 每次 write 都直接 new 一个 Entry：对象壳 churn 全压在出站热点上。
- 每次跨 executor 写入都 new 一个任务对象：高频异步路径持续制造任务壳分配噪声。
- 复用壳但不回滚 pending bytes：writability 会长期失真。
- 复用壳但不 release msg：对象本体 ownership 会被污染。
- 复用业务消息本体：会直接破坏引用计数与生命周期边界。

## 文章结构与预算

1. 开场：Netty 复用的不是消息本体，而是运行时包装壳（900-1200 字）
2. `Entry`：排队壳、取消、回收、pending bytes（1800-2400 字）
3. `WriteTask`：异步任务壳、估算大小、run/cancel/recycle（1800-2400 字）
4. 两条壳的关系：托管区之前 vs 托管区之内（1400-1800 字）
5. 失败与排障：RejectedExecution、pending bytes 回滚、release（1400-1900 字）
6. 收网：公共底盘如何落到真实出站热点（600-900 字）

目标：去掉代码块后的叙述性正文 8500-10500 字，最低不低于 8000 字。

## 证据清单

- `transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:826-897`
- `transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1073-1152`
- `transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1034-1052`
- `transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:430-509`
- `transport/src/test/java/io/netty/channel/DefaultChannelPipelineTest.java:145-168`
- `common/src/main/java/io/netty/util/Recycler.java:303-422`

## 边界清单

- 本篇不把 `Recycler` 实现细节再展开成通用专题，只复用其结论。
- 本篇不重讲 `ChannelOutboundBuffer` 三阶段与 writability 主线，只聚焦 Entry 壳本身。
- 本篇不把 `WriteTask` 写成普通消息对象池，它缓存的是异步任务壳。
- 本篇不把 `pending bytes` 只理解成 ByteBuf payload；任务壳和 Entry overhead 也会参与账本。

## 深审预警

- [ ] 不把 Entry/WriteTask 复用写成复用消息本体。
- [ ] 不把 recycle 写成纯局部动作，必须写出 pending bytes 和 release 边界。
- [ ] 不把 rejected task 写成只 fail promise，不释放消息。