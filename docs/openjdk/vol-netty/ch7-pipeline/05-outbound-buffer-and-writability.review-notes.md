# Ch7-05 ChannelOutboundBuffer 与 writability — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `ChannelOutboundBuffer.addMessage(...)` 当前会把消息封装成 `Entry` 链到 tail，并在必要时设为 `unflushedEntry`，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:114`。  
2. `addMessage(...)` 当前会先 `touch(msg)`，再增加 pending bytes，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:127`、`:139`。  
3. `addFlush()` 当前只是把 `unflushedEntry` 批次推进为 flushed，可供后续发送循环处理，并不等于真正写出，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:142`。  
4. `incrementPendingOutboundBytes()` 当前在 `totalPendingSize` 超过 high watermark 时调用 `setUnwritable`，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:176`、`:185`。  
5. `decrementPendingOutboundBytes()` 当前在 `totalPendingSize` 低于 low watermark 时调用 `setWritable`，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:195`、`:204`。  
6. `total(Object msg)` 当前对 `ByteBuf`、`FileRegion`、`ByteBufHolder` 分别用不同方式折算待写总量，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:210`。  
7. `remove()` 当前在完整移除 flushed 消息后释放对象、完成 promise，并减少 pending bytes，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:275`。  
8. `remove(Throwable)` 当前在失败路径中 `safeRelease(msg)`、fail promise，并减少 pending bytes，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:317`。  
9. `removeBytes(...)` 当前说明部分写出时会推进当前 `ByteBuf` 的 readerIndex，而不是立刻整体移除，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:361`。  
10. `bytesBeforeUnwritable()` / `bytesBeforeWritable()` 当前都用 `+1` 体现“越过阈值才切换”的语义，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:765`、`:778`。  
11. `Entry.pendingSize` 当前会把 `CHANNEL_OUTBOUND_BUFFER_ENTRY_OVERHEAD` 算进去，不只统计 payload，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:850`、`:853`。  
12. `Entry.cancel()` 当前会释放消息并把其替换成 `Unpooled.EMPTY_BUFFER`，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:859`。  
13. `WriteBufferWaterMark` 文档当前明确：超过 high 才不可写，跌回 low 以下才恢复可写，证据：`transport/src/main/java/io/netty/channel/WriteBufferWaterMark.java:21`。  
14. `PendingBytesTracker.newTracker(channel)` 当前优先挂到 `DefaultChannelPipeline`，否则回退到 `ChannelOutboundBuffer`，再不行退化为 noop，证据：`transport/src/main/java/io/netty/channel/PendingBytesTracker.java:35`。  
15. `ChannelOutboundBufferTest.testUserDefinedWritability1/2` 当前证明用户自定义 writability 位默认全 true，但任一位 false 都会让 `channel.isWritable()` 变 false，证据：`transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:333`。  
16. `testMixedWritability` 当前证明系统 pending bytes 回到 0 后，如果用户位仍为 false，channel 仍不可写，证据：`transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:391`。  
17. `testWriteTaskRejected` 当前证明任务拒绝时对象必须被释放，pending bytes 也必须回到 0，证据：`transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:430`。  
18. `ReentrantChannelTest` 当前注释展示了非 I/O 线程写入、I/O 线程处理、再次入缓冲区、最终 flush 移除的交错时序，证据：`transport/src/test/java/io/netty/channel/ReentrantChannelTest.java:60`。

### 深审发现

1. **中风险：容易把 `write()` 写成立刻发送。** 正文已反复强调 `write != flush != remove`。  
2. **中风险：容易把背压写成按消息个数统计。** 正文已改成“按待写总字节数 + entry 开销统计”。  
3. **中风险：容易忽略用户自定义 writability 位。** 正文已用测试单独立了一节。  
4. **低风险：容易把测试里的回调顺序写成唯一顺序。** 正文已限定为“可能发生的交错”。

## 第二轮：因果审

- `write()` 先进入托管区 -> pending bytes 增加 -> 可能先触发不可写：✅  
- `flush()` 只是阶段切换，不等于消息已移除 -> 不可写不一定立刻恢复：✅  
- 待写压力按字节统计而非按消息数统计 -> 更贴近真实内存与发送压力：✅  
- high/low 双阈值提供迟滞带 -> 避免边界抖动：✅  
- 用户位叠加系统位 -> `channel.isWritable()` 是合成结果，不是单一 watermark 镜像：✅  
- 失败/拒绝路径必须冲回 pending bytes -> 否则 writability 会长期失真：✅

## 第三轮：结构审

正文结构按“错觉 -> 三阶段 -> pending bytes -> 双阈值 -> 用户位 -> PendingBytesTracker -> 时序测试 -> 排障 -> 收网”推进，没有沿字段和方法列表平铺。✅

失败方案已覆盖：
- 只按消息个数背压  
- 只有一个阈值  
- `write()` 立刻减 pending bytes  
- 只统计系统位不允许用户位  
- 失败路径不清零 pending bytes  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `write`、`flush`、真正移除是三件事  
- 背压看的是待写总字节规模  
- high/low watermark 的本质是迟滞带  
- `isWritable()` 由系统位和用户位共同决定  
- writability 是时序现象，不是一个静态布尔值  
- 排障时应该从托管阶段、pending bytes、用户位和失败路径四个方向查起  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把 `PendingWriteQueue` 展开成完整主题，只作后续桥接。✅  
- 未把 `flush` 合并和 syscall 优化提前写透。✅  
- 未把 `channel.isWritable()` 写成内核 socket 缓冲区的直接镜像。✅  
- 未把 `MessageSizeEstimator` 细节展开过多，只保留其在折算 pending bytes 上的责任。✅

## 第六轮：依赖审

- 依赖 Ch2-01 的 write 基础，真实存在。✅  
- 依赖 Ch6 promise 异步完成模型，真实存在。✅  
- 依赖 Ch4-06 / Ch4-07 的 ownership 与 touch 前置，真实存在。✅  
- 后续 `PendingWriteQueue` / `flush` / HTTP/2 流控只作桥接，没有把后文结论当前置。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 12,367。  
- 去掉常见 markdown 标记后的字符数：约 12,010。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立出站托管区与 writability 主线。Ch7-05 可作为后续 `PendingWriteQueue`、`write/flush` 与 HTTP/2 流控篇的直接前置篇。