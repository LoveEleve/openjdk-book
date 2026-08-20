# Ch13-01 IdleStateHandler、ReadTimeoutHandler 与 WriteTimeoutHandler

## 先把“超时”拆成三种完全不同的边界

很多人第一次在 Netty 里配置 timeout handler，脑子里通常只有一个很粗的概念：连接太久没动，就超时。于是 `IdleStateHandler`、`ReadTimeoutHandler`、`WriteTimeoutHandler` 看起来就像三种语法略有区别的闹钟。可只要真的沿着 pipeline 和出站主线往下走，就会发现这三个 handler 处理的根本不是同一种事。

- `IdleStateHandler` 处理的是“这条连接一段时间没读、没写、或者两边都没动”的空闲状态；
- `ReadTimeoutHandler` 处理的是“长时间没有读到任何数据，于是把 READER_IDLE 升级成异常和关闭”；
- `WriteTimeoutHandler` 处理的则不是“好久没写”，而是“这一次 write 对应的 promise 长时间没有完成”。

如果把这三种边界混成一个倒计时器，后面的语义马上就会错位。因为“连接一段时间没收到数据”和“某一次写操作一直没完成”不是一回事；“连接长时间没写”和“底层输出状态其实并没有推进”也不是一回事。前者更像连接活跃度，后者更像单次出站操作是否卡住。Netty 之所以把它们拆开，不是为了 API 花样，而是因为它们依赖的观察点不同：有的依赖读写时间戳，有的依赖 `ChannelOutboundBuffer` 的输出推进痕迹，有的直接依赖单次 `ChannelPromise` 是否完成。

所以本篇真正要解决的核心困惑不是“timeout 怎么配秒数”，而是：**Netty 里所谓 timeout，到底是在哪一层、盯着什么信号、用什么形式把边界抛给业务。**只要这点先立住，后面 user event、异常、close、reset 和 observeOutput 的设计就会顺理成章。

## `IdleStateHandler`：先把空闲状态变成 user event，而不是立刻下判决

`IdleStateHandler` 的类注释开篇就把角色说得很清楚：当一个 Channel 在一段时间内没有发生 read、write 或两者都没有发生时，它会触发一个 `IdleStateEvent`，见 `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:33`。这里最关键的不是“它会触发事件”，而是**它先触发的是 user event，不是直接异常，更不是直接关闭。**

这说明 Netty 对“空闲”这件事的第一层态度非常克制：先把连接状态变化告诉业务，再由业务决定这个空闲究竟意味着什么。对于有些协议，写空闲意味着应该发一个 ping；对于另一些协议，读空闲意味着连接已经不可用了；还有些业务会把首次空闲和连续空闲区分开，第一次先探活，第二次再断开。`IdleStateHandler` 不替业务做这些决定，它只是把“这条连接在当前维度上已经空闲”翻译成统一的事件。

这也是为什么 `IdleStateEvent` 本身除了 `state()` 之外，还有一个 `isFirst()` 标记。类里预置了 `FIRST_READER_IDLE_STATE_EVENT`、`READER_IDLE_STATE_EVENT`、`FIRST_WRITER_IDLE_STATE_EVENT`、`WRITER_IDLE_STATE_EVENT`、`FIRST_ALL_IDLE_STATE_EVENT` 和 `ALL_IDLE_STATE_EVENT` 这些静态实例，见 `handler/src/main/java/io/netty/handler/timeout/IdleStateEvent.java:22`。这意味着 Netty 在事件层面就承认：第一次空闲和后续重复空闲在业务语义上往往不同，所以需要显式区分。

因此，理解 `IdleStateHandler` 最重要的第一句判断是：**它不是“超时就关连接”的 handler，而是“把连接空闲状态以 user event 形式抛出来”的 handler。**后面 `ReadTimeoutHandler` 和 `WriteTimeoutHandler` 之所以看起来更激进，恰恰是因为它们各自把这层“先抛事件”的抽象进一步专门化了。

## 三种 idle：reader、writer、all 不是一个总开关

`IdleStateHandler` 支持三类空闲状态：reader idle、writer idle 和 all idle，见 `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:37`。它们表面上只是三个时间参数，但语义差别非常大。

- `readerIdleTime` 关心的是在多长时间内没有发生入站读；
- `writerIdleTime` 关心的是在多长时间内没有发生出站写；
- `allIdleTime` 关心的是在多长时间内既没有读，也没有写。

这三种状态不能互相代替。因为“连接没收到数据”并不等于“连接完全没活动”；服务端可能在一段时间内持续写推送数据，但没有新的入站消息。反过来，一个连接也可能不断收到心跳包，却很久没有真正把业务数据写出去。`ALL_IDLE` 抓的是“两边都安静”，而 `READER_IDLE` / `WRITER_IDLE` 抓的是单侧静默。

源码里它们也是分开维护的。handler 内部分别持有 `readerIdleTimeout`、`writerIdleTimeout`、`allIdleTimeout` 三个调度任务，以及 `lastReadTime`、`lastWriteTime` 和对应的 first-event 标记，见 `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:109`。初始化时会按三种时间参数分别调度对应任务，见 `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:329`。

这就决定了 `IdleStateHandler` 不是“一个总定时器上挂三个 if”，而是同时维护三条不同维度的时间边界。哪一条开启，取决于配置；哪一条触发，取决于读写行为分别有没有重置对应时间戳。

所以第二层心智模型可以这样记：**IdleStateHandler 里实际上同时存在三条独立的空闲观察线。**它们共享同一个 handler 和同一种 user event 机制，但观察维度不同、时间戳不同、触发结果也不同。

## 它真正盯的是哪些时刻：`channelRead`、`channelReadComplete` 与 `writeListener`

理解三种 idle 的关键，不只是记它们的定义，而是弄清楚这些时间戳到底在哪些时刻被更新。

### 读侧：不是每次 `channelRead` 就立刻更新最终读时间

`channelRead(...)` 到来时，`IdleStateHandler` 并不会马上把 `lastReadTime` 设成当前时间。它做的是把 `reading = true`，并重置 `firstReaderIdleEvent` / `firstAllIdleEvent`，见 `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:282`。真正更新 `lastReadTime` 的时机在 `channelReadComplete(...)`，只有当这一轮 reading 确实结束时，才把 `lastReadTime = ticker.nanoTime()`，见 `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:291`。

这说明 `IdleStateHandler` 对“读发生了没有”的判断不是按单条消息粒度，而是按一轮读批次粒度。它等的是“这轮 read loop 完整结束”，而不是“有个片段消息刚刚进来了”。这种选择和前面讲过的 Netty 读循环模型完全一致：一轮入站处理更接近真实的活跃信号，而不是任何碎片到达都立刻重置超时。也正因为如此，`IdleStateHandler` 观察的是 Channel 级读写活动边界，而不是应用层一条消息或一次业务请求是否已经完整处理完。

### 写侧：不是写调用发生，而是 write 对应的 promise 完成

写侧更有意思。`write(...)` 里如果 writer idle 或 all idle 打开，handler 会把原 promise 转成非 void promise，然后 `ctx.write(msg, promise.unvoid()).addListener(writeListener)`，见 `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:300`。真正更新 `lastWriteTime` 的不是调用 `write(...)` 那一刻，而是 `writeListener` 在 future 完成时才更新，见 `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:130`。

这一步非常关键，因为它说明 `IdleStateHandler` 眼里的“写发生了”不是“业务代码调用过 write”，而是“这次 write 对应的出站动作已经完成到足以让 promise 被通知”。这和前面讲 write/flush/托管区主线时的判断完全一致：光把消息交进写路径，不等于输出真的推进了。

所以光记住“writer idle 表示多久没写”是不够的，更准确的说法应该是：**writer idle 盯的是成功完成的写活动，而不是简单的 write API 调用次数。**

## `observeOutput`：为什么“写空闲”还要看 `ChannelOutboundBuffer` 的输出有没有真正变化

就算已经把写侧时间戳挂到 promise 完成上，Netty 仍然觉得这还不够，于是又引入了 `observeOutput`。这也是 `IdleStateHandler` 里最容易被忽略、但最值得专门讲的一块。

构造器允许显式传入 `observeOutput`，注释说明它决定在判断 write idle 时，是否额外观察输出 `bytes` 的消费情况，见 `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:170`。类里还额外保存了 `lastMessageHashCode`、`lastPendingWriteBytes`、`lastFlushProgress` 和 `lastChangeCheckTimeStamp` 等字段，见 `handler/src/main/java/io/netty/handler/timeout/IdleStateHandler.java:126`。这说明它并不满足于“写 promise 完成过没有”，还想知道托管区的输出状态有没有实际前进。

为什么要多这一层？因为有些场景下，业务层面看起来似乎一直在写，但连接底层并没有真正往前推进多少。比如 `ChannelOutboundBuffer` 里仍然堆着相同的消息、pending bytes 没怎么变化、flush progress 也几乎不动。此时如果只看“最近是否调用过 write”，连接会显得很活跃；可从输出推进角度看，它其实已经处在一种更接近停滞的状态。

`IdleStateHandlerTest.testObserveWriterIdle()` 和 `testObserveAllIdle()` 正好就是为这层语义写的。测试构造 `observeOutput=true` 的 handler，往 outbound 中写入几条大小不同的消息，再通过人工消费和推进时间，验证只有当输出状态真正持续不动时，才会触发 writer/all idle 事件，见 `handler/src/test/java/io/netty/handler/timeout/IdleStateHandlerTest.java:228`。

所以这里一定要把边界说清楚：**`observeOutput` 不是万能网络探测器，它只是把“输出状态有没有实际变化”也纳入 write idle 观察。**它回答的是“连接是不是一直在假忙”，而不是“网络一定坏了”或“对端一定已经失联”。

因此，如果把 write idle 的完整心智图画出来，至少要有两层：

- 默认模式：看写 promise 的完成节奏；
- observeOutput 模式：再额外看 `ChannelOutboundBuffer` 的输出状态有没有变化。

这也是为什么 `IdleStateHandler` 不应该被简化成“一个定时器 + 三个 if”。它实际上是在持续观察 pipeline、promise 和托管区多个层面的活动痕迹。

## `ReadTimeoutHandler`：把 READER_IDLE 从 user event 升级成异常和关闭

有了 `IdleStateHandler` 这层通用空闲事件，`ReadTimeoutHandler` 就很好理解了。它直接继承 `IdleStateHandler`，并在构造器里固定成 `(timeout, 0, 0)`，也就是只关心 reader idle，见 `handler/src/main/java/io/netty/handler/timeout/ReadTimeoutHandler.java:62`。这也意味着它并没有另起一套新的定时调度模型，而是完整沿用了 `IdleStateHandler` 的时钟、任务调度和 reader idle 判定路径。

真正关键的是它如何处理空闲事件。`channelIdle(...)` 里会断言当前事件一定是 `READER_IDLE`，然后调用 `readTimedOut(ctx)`；而 `readTimedOut(...)` 默认行为是：如果还没关闭，就先 `ctx.fireExceptionCaught(ReadTimeoutException.INSTANCE)`，再 `ctx.close()`，见 `handler/src/main/java/io/netty/handler/timeout/ReadTimeoutHandler.java:87`。

这说明 `ReadTimeoutHandler` 不是一套新的定时逻辑，而是对 `IdleStateHandler` 的一次语义升级：

- `IdleStateHandler` 说：“连接已经 reader idle 了，你自己决定怎么办”；
- `ReadTimeoutHandler` 说：“reader idle 在这个场景里就被视为异常边界，我默认直接抛异常并关连接”。

这层区别一定要说清楚。否则读者很容易把 `ReadTimeoutHandler` 和 `IdleStateHandler(readerIdleTime, 0, 0)` 当成同义词。前者已经替你下了判决，后者只是把状态抛给你。

所以从运行时层级上看：`ReadTimeoutHandler` 不是在“检测一种新超时”，而是在把一类已有的 idle 状态绑定成默认的 transport 失败边界。

## `WriteTimeoutHandler` 完全不是“长期没写”，它盯的是单次 write promise

`WriteTimeoutHandler` 最容易被误解。很多人看到名字，会下意识把它想成“长时间没有写就超时”，仿佛它只是 `IdleStateHandler(0, writerIdle, 0)` 的另一个版本。源码显示，完全不是这样。

`WriteTimeoutHandler` 根本不继承 `IdleStateHandler`，而是直接继承 `ChannelOutboundHandlerAdapter`，见 `handler/src/main/java/io/netty/handler/timeout/WriteTimeoutHandler.java:66`。这已经说明它观察的不是长期空闲状态，而是单次出站操作的生命周期。

它的 `write(...)` 很直接：如果 timeout 打开，就把 promise 变成非 void promise，然后为这次 promise 安装一个 `WriteTimeoutTask`；随后再把消息正常 `ctx.write(msg, promise)` 往下传，见 `handler/src/main/java/io/netty/handler/timeout/WriteTimeoutHandler.java:106`。

这里的关键不在“装了个定时器”，而在“这个定时器绑定的是这一次 write 对应的 promise”。也就是说，`WriteTimeoutHandler` 盯的不是一条连接有没有长期写活动，而是“这次具体的写操作，过了这么久还没完成吗”。

`WriteTimeoutTask.run()` 的实现把这点说得非常直白：如果 promise 还没 done，就触发 `writeTimedOut(ctx)`；默认行为是抛 `WriteTimeoutException` 并关连接，见 `handler/src/main/java/io/netty/handler/timeout/WriteTimeoutHandler.java:202`。一旦 promise 已经完成，则 listener 会取消定时任务，并把节点从内部双向链表里摘掉。

所以 `WriteTimeoutHandler` 的正确心智图不是“长期没写”，而是：

- 我对每次 write 安装一份超时观察；
- 如果这次 write 对应的 promise 在期限内没有完成，就认为这次写操作超时；
- 这和连接上有没有别的写活动，不是同一个维度。

这点越早说清楚越好。否则读者很容易误把它和 writer idle 混成一件事，进而在设计心跳或写超时策略时完全选错工具。可以把两者压成一句最小对照：`writer idle` 关心的是“最近这条连接有没有写活动”，`write timeout` 关心的是“这一次具体写操作对应的 promise 有没有按时完成”。

## `WriteTimeoutHandler` 为什么还要维护一条双向链表

既然它是按每次 write 安装任务，为什么还要专门维护 `lastTask` 和一条双向链表？原因在于：单次任务的取消、handler 移除和跨 executor 回调必须被统一管理。

`scheduleTimeout(...)` 在为 promise 安装定时任务后，如果 future 还没完成，就把 `WriteTimeoutTask` 加入链表，并给 promise 加 listener，见 `handler/src/main/java/io/netty/handler/timeout/WriteTimeoutHandler.java:130`。而 `handlerRemoved(...)` 时，它会遍历整条链，把所有还挂着的任务统一取消并断开前后指针，见 `handler/src/main/java/io/netty/handler/timeout/WriteTimeoutHandler.java:115`。

这说明 `WriteTimeoutHandler` 不是“每次写随便挂一个定时器就算完”，而是明确知道：一个 handler 可能在还有很多未完成写任务时被移除；如果不统一管理这些任务，它们后续还可能在错误的上下文里继续触发超时。

更微妙的是 `operationComplete(...)` 的跨 executor 场景。若 promise 完成回调不在当前 executor 上，handler 不会直接修改链表，而是把移除动作再调度回正确 executor，见 `handler/src/main/java/io/netty/handler/timeout/WriteTimeoutHandler.java:217`。`WriteTimeoutHandlerTest.testPromiseUseDifferentExecutor()` 正是为这个边界写的，见 `handler/src/test/java/io/netty/handler/timeout/WriteTimeoutHandlerTest.java:33`。

这说明 `WriteTimeoutHandler` 的难点不是“多久超时”，而是“在正确的线程和生命周期边界上追踪这次写任务的完成与取消”。它关心的是 promise 的 transport 完成语义，而不是业务是否调用过 write。

## `reset`、`first event` 和测试告诉我们：这些 handler 管的不是时间，而是边界

把几组测试放在一起看，会发现它们真正反复验证的不是“时间到了没”，而是“边界是不是对”。

### `first event`

`IdleStateHandlerTest.testReaderIdle/testWriterIdle/testAllIdle` 验证的是首次 idle 事件和后续重复事件不同，见 `handler/src/test/java/io/netty/handler/timeout/IdleStateHandlerTest.java:39`。这说明对 Netty 来说，空闲不是一个纯布尔状态，而是一串可能需要分层处理的边界事件。

### `reset`

`testResetReader()` 和 `testResetWriter()` 说明，`resetReadTimeout()`、`resetWriteTimeout()` 并不是重新创建 handler，而是把对应时间边界向后推，见 `handler/src/test/java/io/netty/handler/timeout/IdleStateHandlerTest.java:101`。这让业务有机会在某些自定义协议边界上，把“刚有活动”的事实显式告诉 timeout handler。

### `observeOutput`

`testObserveWriterIdle/testObserveAllIdle` 说明，输出推进和写 API 调用不是同一件事，只有当输出状态真的长期不变时，相关 idle 事件才应该触发，见 `handler/src/test/java/io/netty/handler/timeout/IdleStateHandlerTest.java:228`。

### 跨 executor promise completion

`WriteTimeoutHandlerTest.testPromiseUseDifferentExecutor` 则把写超时边界又往前推进了一步：超时任务链表的维护必须服从 promise 的真实完成线程，而不是假设所有回调都和 write 调用点在同一个 executor 上，见 `handler/src/test/java/io/netty/handler/timeout/WriteTimeoutHandlerTest.java:33`。

这些测试共同说明：Netty 的 timeout handler 从来不是“拿个计时器简单比秒数”。它们真正管理的是连接和单次写操作的边界事件：什么时候该把空闲状态抛给业务，什么时候该把状态升级成异常，什么时候要重新推迟边界，什么时候又必须把回调重新调度回正确 executor。

所以把它们统一看成“闹钟”会非常误导。更准确的说法应该是：**它们是时间驱动的边界管理器。**

## 收网：空闲、读超时、写超时，是三条不同的 transport 语义线

现在可以把这条主线收回来了。

- `IdleStateHandler` 负责把 reader idle、writer idle、all idle 三类连接空闲状态，先翻译成 `IdleStateEvent` user event；它默认不替业务下判决。  
- `observeOutput` 说明“写空闲”不只看应用有没有调 write，还可以额外观察 `ChannelOutboundBuffer` 的输出是否真的推进。  
- `ReadTimeoutHandler` 不是新的定时器，而是把 READER_IDLE 这条 user event 语义进一步升级成异常和关闭。  
- `WriteTimeoutHandler` 则完全是另一条线：它不看长期空闲，而是为每次 write promise 安装超时任务，处理“这一次写操作太久没完成”。  
- first event、reset、handlerRemoved 和跨 executor promise completion 共同说明，这些 handler 真正管理的是时间驱动的 transport 边界，而不是简单秒表。

所以本篇真正要留下来的结论是：**Netty 里的 timeout/heartbeat handler 不是一个总开关，而是三条不同的 transport 语义线：连接读空闲、连接写空闲/双空闲、以及单次写操作超时。**

把这三条线分清楚，后面再去看应用层 ping/pong、gRPC keepalive、Triple 的 ping handler、连接治理与流量整形，就不会再把所有“超时”粗暴压成一个定时器，而会知道自己真正要观察的是哪一层边界。