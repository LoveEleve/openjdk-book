# Ch7-07 ChannelOutboundBuffer.Entry 与 WriteTask：复用落点专题 — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `ChannelOutboundBuffer.Entry` 当前自带 `Recycler<Entry>`，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:826`。  
2. `Entry.newInstance(...)` 当前只填充 `msg/pendingSize/total/promise` 等壳层元数据，不创建消息本体，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:850`。  
3. `Entry.pendingSize` 当前把 `CHANNEL_OUTBOUND_BUFFER_ENTRY_OVERHEAD` 算进账本，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:853`。  
4. `Entry.cancel()` 当前会 `safeRelease(msg)`、替换成 `Unpooled.EMPTY_BUFFER`，并清零相关字段，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:859`。  
5. `unguardedRecycle()` 当前会清空 next/bufs/buf/msg/promise/progress/total/pendingSize/count/cancelled，再回收到 Recycler，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundBuffer.java:878`。  
6. `AbstractChannelHandlerContext.WriteTask` 当前自带 `Recycler<WriteTask>`，证据：`transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1073`。  
7. `WriteTask.init(...)` 当前会绑定 `ctx/msg/promise/flush`，并在启用 `ESTIMATE_TASK_SIZE_ON_SUBMIT` 时给 pipeline 增加 pending outbound bytes，证据：`transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1105`。  
8. `WriteTask.run()` 当前先减 pending bytes，再执行 `ctx.write(msg, flush, promise)`，最后 recycle 自己，证据：`transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1122`。  
9. `WriteTask.cancel()` 当前也会先减 pending bytes，再 recycle，证据：`transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1132`。  
10. `safeExecute(...)` 当前在任务提交失败时会 release msg 并 fail promise，证据：`transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1034`。  
11. `ChannelOutboundBufferTest.testWriteTaskRejected` 当前验证 rejected task 后 future 必须失败、消息 `refCnt` 归零、`totalPendingWriteBytes()` 回到 0，证据：`transport/src/test/java/io/netty/channel/ChannelOutboundBufferTest.java:501`。  
12. `DefaultChannelPipelineTest.testFreeCalled` 当前说明对象沿 pipeline 传播后仍必须走到最终 release/deallocate，证据：`transport/src/test/java/io/netty/channel/DefaultChannelPipelineTest.java:145`。  
13. `Recycler.get()` 当前在不满足受控线程前提时会回退到 `NOOP_HANDLE` 路径，证据：`common/src/main/java/io/netty/util/Recycler.java:303`。

### 深审发现

1. **高风险：容易把 Entry / WriteTask 复用写成复用消息本体。** 正文已明确它们复用的是运行时壳。  
2. **中风险：容易把 recycle 写成纯局部对象池动作。** 正文已反复绑定 pending bytes、release 和 promise 边界。  
3. **中风险：容易忽略 WriteTask 也会进入 pending bytes 账本。** 正文已单独立节。  
4. **低风险：容易把 rejected task 写成只 fail promise。** 正文已补 release 和 pending bytes 回滚。

## 第二轮：因果审

- Entry 是消息进入托管区后的排队壳 -> 自己的 overhead 也进入 pending bytes：✅  
- WriteTask 是跨 executor 路径上的任务壳 -> 提交时就可能先进入 pipeline 账本：✅  
- 两类壳都不是消息本体 -> 复用不应破坏 ownership 语义：✅  
- recycle 之前必须先处理 release / pending bytes / promise 边界：✅  
- rejected task 证明壳复用一旦脱离失败回滚，就会直接污染主线语义：✅

## 第三轮：结构审

正文结构按“从工具层拉回真实热点 -> Entry 壳 -> Entry 账本 -> Entry 退出 -> WriteTask 壳 -> WriteTask 账本 -> rejected task 失败边界 -> 两种壳合图 -> 收网”推进，没有按源码字段顺序平铺。✅

失败方案已覆盖：
- 每次 write 都直接 new Entry  
- 每次跨 executor 写入都 new 任务壳  
- 复用壳但不回滚 pending bytes  
- 复用壳但不 release msg  
- 复用业务消息本体  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- Netty 复用的不是消息本体，而是热点运行时壳  
- Entry 属于托管区内部壳，WriteTask 属于托管区之前的异步任务壳  
- 两者都要和 pending bytes / promise / ownership 边界一起分析  
- rejected task 场景为何能暴露这条主线  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把 Recycler 内部实现重讲成独立专题。✅  
- 未重讲 ChannelOutboundBuffer 主线，只聚焦 Entry 壳。✅  
- 未把 WriteTask 写成普通消息对象池。✅  
- 未把 pending bytes 仅理解为 ByteBuf payload。✅

## 第六轮：依赖审

- 依赖 Ch5-03 的 Recycler 结论，真实存在。✅  
- 依赖 Ch7-05/06 的托管区、writability 与 flush 前置，真实存在。✅  
- 依赖 Ch4-06 的 ownership 前置，真实存在。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 10,100。  
- 去掉常见 markdown 标记后的字符数：约 9,775。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经把 `Recycler` 的公共底盘落到两个真实出站热点壳上：`ChannelOutboundBuffer.Entry` 与 `WriteTask`。本篇只承担“热点壳复用落点”专题，不再重复 `Ch7-05/06` 中 `ChannelOutboundBuffer` 三阶段、writability 与 flush 主线。Ch7-07 可作为后续异步出站路径、RejectedExecution 排障和更多对象壳复用专题的直接前置篇。