# Ch13-01 IdleStateHandler、ReadTimeoutHandler 与 WriteTimeoutHandler — rewrite-plan

## 篇章定位

- 核心困惑：连接“超时”在 Netty 里到底是什么意思？为什么 `IdleStateHandler` 走的是 user event，而 `ReadTimeoutHandler` / `WriteTimeoutHandler` 又会直接抛异常甚至关闭连接？读超时、写超时、读写都空闲，这三类判断为什么不能混成一个简单定时器？
- 一句话顿悟：Netty 的 timeout/heartbeat handler 不是一堆独立闹钟，而是建立在 EventLoop 时钟、pipeline 事件和出站主线之上的三套边界语义：`IdleStateHandler` 负责把“连接长时间没读/没写/都没动”翻译成 `IdleStateEvent`；`ReadTimeoutHandler` 在此基础上把 READER_IDLE 升级成异常与关闭；`WriteTimeoutHandler` 则围绕单次 write promise 安装超时任务，处理“这次写操作长期没有完成”的问题。
- 文章边界：本篇主讲 `IdleStateHandler` 的 reader/writer/all idle 语义、`observeOutput`、first event、任务调度与 reset；主讲 `ReadTimeoutHandler` 和 `WriteTimeoutHandler` 各自如何建立在不同边界之上；不展开应用层心跳协议包格式，不展开所有 keepalive 业务策略。

## 依赖

### HARD

- Ch5 EventLoop / Ticker 相关篇：理解 Netty 定时任务与 event loop 时钟来源。
- Ch7-05/06：理解 write/flush、托管区、pending bytes 和 promise 完成边界。
- Ch14-01 `01-hashedwheeltimer.md`：理解“时间轮适合大量近似 timeout”，但本篇要强调这些 handler 主要依赖的是 channel executor 的调度，而不是独立 timer API。

### SOFT

- Ch4-06 ownership：只复用“关闭连接也是一种生命周期边界”。
- Ch12 HTTP/2 系列：后续可桥接 keepalive / ping 场景，但本篇不依赖其细节。

### NAV

- 后续：流量整形 / 心跳协议 / gRPC keepalive / TriplePingPongHandler。

## 素材事实卡片

### 卡片 A：`IdleStateHandler` 管的是读空闲、写空闲、双空闲三类 user event

- 构造参数决定 readerIdleTime / writerIdleTime / allIdleTime；0 表示禁用。
- `channelRead` / `channelReadComplete` 更新读时间；`write` 通过 listener 更新写时间。
- 初始化时按三种 idle 类型分别调度 `ReaderIdleTimeoutTask` / `WriterIdleTimeoutTask` / `AllIdleTimeoutTask`。
- firstReaderIdleEvent / firstWriterIdleEvent / firstAllIdleEvent 区分首次事件与后续重复事件。

### 卡片 B：`observeOutput` 不是简单看有没有调用 write

- `observeOutput=true` 时，handler 会额外观察 `ChannelOutboundBuffer` 的消息哈希、pending bytes、flush progress 是否变化。
- 说明“写空闲”可以不是“业务没调用 write”，而是“输出状态没有真正推进”。

### 卡片 C：`ReadTimeoutHandler` 是 `IdleStateHandler` 的语义升级

- 继承 `IdleStateHandler(timeout, 0, 0, unit)`。
- 只处理 READER_IDLE，调用 `ctx.fireExceptionCaught(ReadTimeoutException.INSTANCE)` 并关闭 channel。
- 说明它不是新的一套定时逻辑，而是把 reader idle user event 升级成错误边界。

### 卡片 D：`WriteTimeoutHandler` 与前两者不同，它盯的是“单次 write promise 有没有完成”

- 每次 write 时为 promise 安装一个 `WriteTimeoutTask`。
- timeout 到达后如果 promise 还没 done，就触发 `WriteTimeoutException` 并关闭连接。
- promise 完成时取消定时任务；若回调线程不同，还要把从链表移除的动作调度回正确 executor。
- 说明它不是“长期没写”语义，而是“这一次写操作迟迟没结束”语义。

### 卡片 E：测试揭示三类边界

- `IdleStateHandlerTest.testReaderIdle/testWriterIdle/testAllIdle`：首次 idle 事件与后续 idle 事件。
- `testResetReader/testResetWriter`：reset 方法会推迟超时。
- `testObserveWriterIdle/testObserveAllIdle`：observeOutput 会把“输出是否实际推进”纳入判断。
- `WriteTimeoutHandlerTest.testPromiseUseDifferentExecutor`：write timeout 的任务移除必须考虑 promise completion 发生在不同 executor 的情况。

## 理解路径

1. **从误解开场**：连接超时不是一个开关，而是“没读”“没写”“单次写未完成”三种不同边界。
2. **先讲 IdleStateHandler**：用 user event 把空闲状态抛给业务决定，而不是直接强制关闭。
3. **再讲 observeOutput**：说明“写空闲”不只看应用有没有调 write，还看输出是否推进。
4. **再区分 ReadTimeout 与 WriteTimeout**：一个是 reader idle 的升级版，一个是以 promise 为中心的单次 write 超时。
5. **最后回到测试与调度边界**：first event、reset、跨 executor promise completion、关闭路径。

## 失败方案推演

- 把读空闲、写空闲、单次写超时都混成一个倒计时：语义会严重混乱。
- 只要到时就统一 `close()`：业务失去通过 user event 自己处理心跳/探活的机会。
- 写超时只看“有没有调用 write”，不看 promise 是否完成：会漏掉真实卡在出站链路里的写操作。
- observeOutput 永远关闭：某些“业务在写但底层没有推进”的场景无法被识别。

## 文章结构与预算

1. 开场：超时不是一个闹钟，而是三种边界（900-1200 字）
2. `IdleStateHandler`：三类 idle、first event、初始化与 reset（2200-2800 字）
3. `observeOutput`：为什么“写空闲”还要看 `ChannelOutboundBuffer`（1400-1800 字）
4. `ReadTimeoutHandler`：reader idle -> exception/close（1200-1600 字）
5. `WriteTimeoutHandler`：每次 write 的 promise 超时任务（1800-2400 字）
6. 测试回读：idle、reset、observeOutput、不同 executor completion（1600-2200 字）
7. 收网：与心跳协议、gRPC keepalive、TriplePingPongHandler 的桥接（600-900 字）

目标：去掉代码块后的叙述性正文 8500-11000 字，最低不低于 8000 字。

## 证据清单

- `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:33-135`
- `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:192-355`
- `handler/src/main/java/io/netty/handler/timeout/ReadTimeoutHandler.java:62-102`
- `handler/src/main/java/io/netty/handler/timeout/WriteTimeoutHandler.java:66-236`
- `handler/src/main/java/io/netty/handler/timeout/IdleStateEvent.java:22-83`
- `handler/src/test/java/io/netty/handler/timeout/IdleStateHandlerTest.java:39-300`
- `handler/src/test/java/io/netty/handler/timeout/WriteTimeoutHandlerTest.java:33-60`

## 边界清单

- 本篇不把 `IdleStateHandler` 事件默认写成“必须 close”，它本质上先抛 user event。
- 本篇不把 `WriteTimeoutHandler` 写成“长期没写”检测器，它盯的是单次 write promise 完成时限。
- 本篇不把 `observeOutput` 写成万能网络探测，它只是额外观察输出推进痕迹。
- 本篇不把这些 handler 和 `HashedWheelTimer` 画等号；它们主要依赖的是 channel executor 调度。

## 深审预警

- [ ] 不把三类 timeout 语义混成一个倒计时器。
- [ ] 不把 reader/writer idle user event 直接等同为异常。
- [ ] 不把 `WriteTimeoutHandler` 的超时触发点写成“调用了 write 以后多久没 flush”。
- [ ] 不把 `observeOutput` 的语义写漏。