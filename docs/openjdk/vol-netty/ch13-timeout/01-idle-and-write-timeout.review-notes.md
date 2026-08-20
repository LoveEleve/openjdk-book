# Ch13-01 IdleStateHandler、ReadTimeoutHandler 与 WriteTimeoutHandler — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `IdleStateHandler` 当前定义 readerIdle、writerIdle、allIdle 三种空闲语义，并以 `IdleStateEvent` 形式抛出 user event，证据：`handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:33`。  
2. `IdleStateEvent` 当前预置了 first / non-first 的 reader、writer、all 三类事件实例，证据：`handler/src/main/java/io/netty/handler/timeout/IdleStateEvent.java:22`。  
3. `IdleStateHandler.channelRead(...)` 当前只把 `reading=true` 并重置 first 标记，真正更新 `lastReadTime` 在 `channelReadComplete(...)`，证据：`handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:282`、`:291`。  
4. `IdleStateHandler.write(...)` 当前不是在调用 write 时更新时间，而是给 promise 加 `writeListener`，由 future 完成时更新 `lastWriteTime`，证据：`handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:130`、`:300`。  
5. `IdleStateHandler` 当前初始化时会分别调度 reader、writer、all 三类 timeout task，证据：`handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:329`。  
6. `observeOutput=true` 当前会额外维护 `lastMessageHashCode`、`lastPendingWriteBytes`、`lastFlushProgress` 等输出观察字段，证据：`handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:126`。  
7. `ReadTimeoutHandler` 当前继承 `IdleStateHandler(timeout, 0, 0, unit)`，并在 `channelIdle()` 中把 `READER_IDLE` 升级成 `ReadTimeoutException` 与关闭，证据：`handler/src/main/java/io/netty/handler/timeout/ReadTimeoutHandler.java:62`、`:87`。  
8. `WriteTimeoutHandler` 当前不继承 `IdleStateHandler`，而是围绕每次 write 的 promise 安装 `WriteTimeoutTask`，证据：`handler/src/main/java/io/netty/handler/timeout/WriteTimeoutHandler.java:66`、`:106`。  
9. `WriteTimeoutTask.run()` 当前在 promise 未完成时触发 `writeTimedOut(ctx)` 并随后从链表移除，证据：`handler/src/main/java/io/netty/handler/timeout/WriteTimeoutHandler.java:202`。  
10. `WriteTimeoutTask.operationComplete(...)` 当前在 promise 完成时取消定时任务，并在必要时把链表移除动作切回正确 executor，证据：`handler/src/main/java/io/netty/handler/timeout/WriteTimeoutHandler.java:217`。  
11. `IdleStateHandlerTest.testReaderIdle/testWriterIdle/testAllIdle` 当前证明 first idle event 与后续 idle event 的差异，证据：`handler/src/test/java/io/netty/handler/timeout/IdleStateHandlerTest.java:39`。  
12. `testResetReader/testResetWriter` 当前证明 reset 方法会推迟对应超时边界，证据：`handler/src/test/java/io/netty/handler/timeout/IdleStateHandlerTest.java:101`。  
13. `testObserveWriterIdle/testObserveAllIdle` 当前证明 observeOutput 会把输出推进状态纳入 writer/all idle 判断，证据：`handler/src/test/java/io/netty/handler/timeout/IdleStateHandlerTest.java:228`。  
14. `WriteTimeoutHandlerTest.testPromiseUseDifferentExecutor` 当前证明 write timeout 任务移除必须考虑 promise completion 发生在不同 executor 的情况，证据：`handler/src/test/java/io/netty/handler/timeout/WriteTimeoutHandlerTest.java:33`。

### 深审发现

1. **高风险：容易把三类 timeout 语义混成一个倒计时器。** 正文已明确拆成 reader idle、writer/all idle、单次 write promise timeout 三条线。  
2. **中风险：容易把 `IdleStateHandler` 事件默认写成“必须 close”。** 正文已明确它先抛 user event，由业务决定。  
3. **中风险：容易把 `WriteTimeoutHandler` 写成“长期没写”。** 正文已改成“单次 write promise 超时”。  
4. **低风险：容易写漏 `observeOutput`。** 正文已单独立节说明。  
5. **低风险：容易忽略跨 executor promise completion 边界。** 正文已用测试单独收束。

## 第二轮：因果审

- 连接空闲不等于单次写超时 -> 三类 handler 必须拆开：✅  
- `IdleStateHandler` 先抛 user event -> 业务可自定义 ping / close / ignore：✅  
- `ReadTimeoutHandler` 是 reader idle 的语义升级版：✅  
- `WriteTimeoutHandler` 绑定 promise 完成时限，而不是长期写活动：✅  
- `observeOutput` 说明“有 write 调用”与“输出真正推进”不是同一件事：✅

## 第三轮：结构审

正文结构按“超时三分 -> IdleStateHandler -> 三类 idle -> 读写时间戳 -> observeOutput -> ReadTimeout -> WriteTimeout -> 测试回读 -> 收网”推进，没有按源码方法顺序平铺。✅

失败方案已覆盖：
- 把读空闲、写空闲、单次写超时混成一个倒计时  
- 超时统一直接 close  
- 写超时只看是否调用 write  
- observeOutput 永远关闭  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `IdleStateHandler` 是空闲状态事件翻译器，不是直接判决器  
- reader/writer/all idle 三条线分别观察什么  
- `observeOutput` 为什么要引入 `ChannelOutboundBuffer` 输出观察  
- `ReadTimeoutHandler` 和 `WriteTimeoutHandler` 为什么不能互相替代  
- first event、reset、跨 executor completion 为什么重要  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把 `IdleStateHandler` 默认写成“必须 close”。✅  
- 未把 `WriteTimeoutHandler` 写成长期没写检测器。✅  
- 未把 `observeOutput` 写成万能网络探测器。✅  
- 未把这些 handler 与 `HashedWheelTimer` 直接画等号。✅

## 第六轮：依赖审

- 依赖 EventLoop/Ticker 前置，真实存在。✅  
- 依赖 Ch7-05/06 的出站托管和 promise 边界，真实存在。✅  
- 依赖 Ch14 timer 只作时间驱动边界背景，未重复其主线。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 10,889。  
- 去掉常见 markdown 标记后的字符数：约 10,502。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立 timeout/heartbeat handler 的三条语义线：reader idle、writer/all idle、单次 write timeout。本篇只承担 transport 边界，不承担应用层 ping/pong 或具体心跳包语义；这些留给后续 keepalive / TriplePingPongHandler 等专题。Ch13-01 可作为后续流量整形、应用层 ping/pong、gRPC keepalive 和 Triple 心跳专题的直接前置篇。