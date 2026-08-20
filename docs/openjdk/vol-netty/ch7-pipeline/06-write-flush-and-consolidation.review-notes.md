# Ch7-06 write、flush 与 FlushConsolidation — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `ChannelOutboundInvoker.write(...)` 当前文档明确：write 不会请求实际 flush，想把 pending data 下沉到 transport，必须再显式调用 `flush()`，证据：`transport/src/main/java/io/netty/channel/ChannelOutboundInvoker.java:216`。  
2. `FlushConsolidationHandler` 当前类注释明确：flush 往往昂贵，因为可能触发 transport 层 syscall；handler 的目标是合并 flush 操作，证据：`handler/src/main/java/io/netty/handler/flush/FlushConsolidationHandler.java:30`。  
3. 读循环进行中时，`flush(...)` 当前不会立刻向后透传，而是优先累计到 `channelReadComplete()` 或阈值，证据：`handler/src/main/java/io/netty/handler/flush/FlushConsolidationHandler.java:121`。  
4. 非读循环且 `consolidateWhenNoReadInProgress=true` 时，flush 当前会优先调度一个 event loop 任务而不是立即透传，证据：`handler/src/main/java/io/netty/handler/flush/FlushConsolidationHandler.java:129`、`:207`。  
5. 达到 `explicitFlushAfterFlushes` 阈值时，当前会立即 `flushNow(ctx)`，证据：`handler/src/main/java/io/netty/handler/flush/FlushConsolidationHandler.java:126`、`:131`。  
6. `channelReadComplete()` 当前会调用 `resetReadAndFlushIfNeeded(ctx)`，把读循环中的 pending flush 统一推进，证据：`handler/src/main/java/io/netty/handler/flush/FlushConsolidationHandler.java:143`。  
7. `channelWritabilityChanged()` 当前在 channel 变不可写时会立刻 `flushIfNeeded(ctx)`，注释明确这是为释放内存压力，证据：`handler/src/main/java/io/netty/handler/flush/FlushConsolidationHandler.java:176`。  
8. `exceptionCaught()`、`disconnect()`、`close()`、`handlerRemoved()` 当前都会在继续传播边界事件前先执行 flush 兜底，证据：`handler/src/main/java/io/netty/handler/flush/FlushConsolidationHandler.java:155`、`:163`、`:170`、`:186`。  
9. `scheduleFlush(...)` 当前只在尚无待执行任务时提交一次 flushTask，避免重复调度，证据：`handler/src/main/java/io/netty/handler/flush/FlushConsolidationHandler.java:207`。  
10. `AbstractChannelHandlerContext.safeExecute(...)` 当前在任务提交失败时会 release msg 并 fail promise，证据：`transport/src/main/java/io/netty/channel/AbstractChannelHandlerContext.java:1034`。  
11. `FlushConsolidationHandlerTest.testFlushViaScheduledTask` 当前证明：非读循环且允许合并时，flush 会先排任务，不立刻透传，证据：`handler/src/test/java/io/netty/handler/flush/FlushConsolidationHandlerTest.java:36`。  
12. `testFlushViaThresholdOutsideOfReadLoop` 当前证明：外部 flush 达到阈值后会立即推进，不再等待调度任务，证据：`handler/src/test/java/io/netty/handler/flush/FlushConsolidationHandlerTest.java:52`。  
13. `testFlushViaReadComplete` 当前证明：读循环里多次读事件可合并到一次 `channelReadComplete()` 刷出，证据：`handler/src/test/java/io/netty/handler/flush/FlushConsolidationHandlerTest.java:75`。  
14. `testFlushViaClose/Disconnect/Exception/Removal` 当前证明：边界事件都会触发兜底 flush，证据：`handler/src/test/java/io/netty/handler/flush/FlushConsolidationHandlerTest.java:101`。  
15. `testResend` 当前证明：listener 中再次 `writeAndFlush` 也不能把消息吞掉，证据：`handler/src/test/java/io/netty/handler/flush/FlushConsolidationHandlerTest.java:166`。  
16. `EmbeddedChannelTest.testHandleOutboundMessage` 当前证明：只有 `writeOneOutbound(...)` 还不会调用 flush，必须再 `flushOutbound()` 才会真正处理 outbound message，证据：`transport/src/test/java/io/netty/channel/embedded/EmbeddedChannelTest.java:564`。

### 深审发现

1. **中风险：容易把 `writeAndFlush()` 写成独立第三机制。** 正文已明确它只是组合调用。  
2. **中风险：容易把 flush 合并写成“单纯吞吐优化”。** 正文已补“不可写 / close / exception 边界优先”的语义约束。  
3. **低风险：容易把测试里的顺序当成所有运行时唯一顺序。** 正文已限制为行为证据，不当作唯一调度序。  
4. **低风险：容易忽略跨 executor 提交失败对 write/flush 语义边界的影响。** 正文已单独补 `safeExecute(...)`。

## 第二轮：因果审

- `write()` 不自动 flush -> 托管区才能形成批量 -> 运行时才有调度推进信号的空间：✅  
- 每次 write 自动 flush -> flush 次数和推进次数被强绑定 -> 批量空间消失：✅  
- 读循环里等 `channelReadComplete()` -> 利用天然批次边界合并 flush：✅  
- 非读循环可短暂调度 flushTask -> 给更多 flush 一次合流机会，但阈值到达就立刻推进：✅  
- channel 不可写 / close / exception / removal -> 语义边界和内存压力优先级高于合并机会：✅  
- 跨 executor 提交失败 -> 必须 release msg 并 fail promise -> 说明 write/flush 本来就可能和调用点解耦：✅

## 第三轮：结构审

正文结构按“拆开最顺手的 API -> 接口合同 -> 自动 flush 的失败方案 -> consolidation 三大场景 -> 边界兜底 -> 测试语义 -> 跨 executor 失败边界 -> 收网”推进，没有按类代码顺序平铺。✅

失败方案已覆盖：
- 每次 write 自动 flush  
- 所有 flush 一律延迟  
- 只在读循环结束时 flush  
- 非读循环无限等待更多 flush  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `write` 是入托管区，`flush` 是推进托管区  
- `writeAndFlush` 只是组合调用，不是第三机制  
- `FlushConsolidationHandler` 合并的是推进信号，不是消息  
- 读循环、非读循环、阈值、不可写/close/exception 边界采用不同策略  
- flush 合并的前提是语义边界没有被跨越  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把 flush 昂贵简单收缩成“就是 syscall”，只保留 transport 推进成本抽象。✅  
- 未把 `writeAndFlush` 写成独立第三机制。✅  
- 未把 `FlushConsolidationHandler` 的测试行为外推成唯一调度顺序。✅  
- 未展开 `PendingWriteQueue` 细节，只作后续桥接。✅

## 第六轮：依赖审

- 依赖 Ch7-05 的 `write != flush != remove` 前置，真实存在。✅  
- 依赖 pipeline outbound 传播基础，真实存在。✅  
- 依赖 promise 异步完成基础，真实存在。✅  
- 后续 `PendingWriteQueue` 与 HTTP/2 flush 语义只作桥接，没有把后文结论当前置。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 12,327。  
- 去掉常见 markdown 标记后的字符数：约 11,974。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立 `write`、`flush` 与 consolidation 的主线。并已补强 flush 成本与读循环小心智图两处表达。Ch7-06 可作为后续 `PendingWriteQueue` 与 HTTP/2 API flush 语义的直接前置篇。