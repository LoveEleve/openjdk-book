# Ch13-02 流量整形、流控辅助与日志：AbstractTrafficShapingHandler、FlowControlHandler、LoggingHandler

## 连接治理不只有 timeout 和 watermarks

前面几篇已经把出站和连接活跃度的基础边界立起来了。`ChannelOutboundBuffer` 和 writability 解释了“托管区是不是太满”；`PendingWriteQueue` 和 `CoalescingBufferQueue` 解释了“正式托管区之前和旁边的辅助缓冲层怎么工作”；`IdleStateHandler`、`ReadTimeoutHandler`、`WriteTimeoutHandler` 又解释了“多长时间没动、哪次写太久没完成”这种时间驱动边界。

可真实系统里的连接治理还缺三件非常实际的能力。

第一，**限速**。不是所有连接都应该毫无限制地把可写预算全部吃满。有时你希望每条连接、或者整组连接，都在某个带宽上限之内平稳运行。  
第二，**节奏收束**。上游 decoder 或 codec 可能一次性喷出多条消息，下游却希望一条一条地处理，尤其是在 autoRead 关闭、背压已经介入之后。  
第三，**可观测性**。即使前两件事都做了，如果你仍然看不见连接正在 bind / read / write / flush / idle / exception 的哪些阶段上发生什么，调优和排障还是会陷入盲猜。

`AbstractTrafficShapingHandler`、`ChannelTrafficShapingHandler`、`FlowControlHandler` 和 `LoggingHandler` 正好分别补这三类空白。它们都不负责业务协议本身，却都在运行时层面对连接行为产生实质影响。

所以本篇的关键不是“又认识几个 handler 名字”，而是要看清：**这些 handler 分别在连接治理的哪一层动手，它们改变的是带宽、下游消费节奏，还是连接可观测性。**只要这个边界先立住，后面就不会把它们和 HTTP/2 flow control、timeout、writability 或业务日志混成一锅。

## `AbstractTrafficShapingHandler`：带宽整形不是直接拒写，而是延迟、挂队列和 user-defined writability

先看 traffic shaping 这条线。`AbstractTrafficShapingHandler` 的类注释已经把定位说得很明确：它用于限制全局或每连接的带宽，并借助 `TrafficCounter` 以一定间隔做监控和会计，见 `handler/src/main/java/io/netty/handler/traffic/AbstractTrafficShapingHandler.java:36`。

这里最重要的，不是“限速”两个字，而是它的做法。Netty 没把带宽超限写成“直接丢消息”或“立刻失败写请求”，而是通过**延迟、挂队列和 user-defined writability** 这三件事，把限速叠加到已有出站主线上。

类里持有几个关键参数：

- `writeLimit` / `readLimit`：读写字节速率上限；
- `checkInterval`：`TrafficCounter` 做统计的周期；
- `maxTime`：最长允许的整形等待时间；
- `maxWriteDelay` / `maxWriteSize`：写侧延迟和挂起队列的上限；
- `userDefinedWritabilityIndex`：它将使用哪一位 user-defined writability 来参与 channel 可写性判断。

定义见 `handler/src/main/java/io/netty/handler/traffic/AbstractTrafficShapingHandler.java:78`。

这说明 traffic shaping 从一开始就不是一个“偷偷 sleep 一下”的局部技巧。它直接嵌进了前面已经分析过的 writability 主线：当延迟写队列太大、预计等待时间太长时，它会通过自己的 user-defined writability 位去影响 `channel.isWritable()`，从而把“限速带来的暂缓写”显式暴露给业务层。

所以 traffic shaping 的第一层心智图应该是：

- 不是直接拒写；
- 也不是直接 drop 流量；
- 而是把“现在不该立刻写”的结论，转成**排队等待 + traffic counter 记账 + user-defined writability 变化**。

这也是为什么它和前面 `ChannelOutboundBuffer` 的关系很紧。前者回答“托管区本来就太满了吗”，后者回答“即使托管区还能吞，我现在也要因为带宽策略而故意慢下来”。两个判断维度不同，但最终都可能体现在 `channel.isWritable()` 上。

## `ChannelTrafficShapingHandler`：每连接限速时，消息会先被挂进延迟发送队列

`AbstractTrafficShapingHandler` 只是总抽象，真正最贴近常见使用场景的是 `ChannelTrafficShapingHandler`。它在每个 channel 上维护自己的 `messagesQueue` 和 `queueSize`，见 `handler/src/main/java/io/netty/handler/traffic/ChannelTrafficShapingHandler.java:25`。

这说明 per-channel 限速的具体形态，并不是“每次 write 先算一遍然后原地阻塞”，而是：如果当前写请求需要被延迟，就把它包装成 `ToSend` 节点放进队列，等到预计可发送的时间点再统一吐出去。

`submitWrite(...)` 把这条路径写得很清楚。若当前 delay 为 0 且队列为空，就直接记账并 `ctx.write(msg, promise)`；否则把消息包装成 `ToSend(relativeTimeAction, msg, promise)` 放进 `messagesQueue`，累加 `queueSize`，并调用 `checkWriteSuspend(ctx, delay, queueSize)`，见 `handler/src/main/java/io/netty/handler/traffic/ChannelTrafficShapingHandler.java:177`。

这一步非常关键，因为它说明限速并不是“你现在不能写，所以这次 write 算失败”。相反，这次 write 仍然成立，只是从“立即进入正式出站托管区”变成“先进入 traffic shaping 的延迟队列，等时机成熟再转交给正式写路径”。

后续由 `sendAllValid(ctx, futureNow)` 负责把到点的 `ToSend` 节点逐条拿出来，再调用 `ctx.write(toSend, promise)`，见 `handler/src/main/java/io/netty/handler/traffic/ChannelTrafficShapingHandler.java:203`。这意味着 traffic shaping 本身也是一种出站前的辅助托管层，和前一篇的 `PendingWriteQueue` 在层次上是相近的，只不过它挂起的原因不是业务时机未到，而是带宽策略要求暂缓。

更值得注意的是 `handlerRemoved(...)`。如果 channel 还活着，它会把延迟队列里的消息补写出去；如果 channel 已经不活了，则显式 release 留在队列里的 `ByteBuf`，见 `handler/src/main/java/io/netty/handler/traffic/ChannelTrafficShapingHandler.java:139`。这再次证明：traffic shaping 的挂队列不是纯容器，它同样必须承担生命周期和释放边界。一旦 handler 被移除或连接关闭，不能让那些“原本只是等待更晚一点发送”的消息无限悬挂。

所以第二层心智图应该是：**ChannelTrafficShapingHandler 不是“限速器”这么简单，它是一个因带宽策略而产生的延迟写队列，并且这条队列也必须服从 promise、release 和 writability 主线。**

## `TrafficCounter`：它不是 transport 本身，而是限速决策的会计与观察面

很多人看流量整形时，容易把 `TrafficCounter` 当成“真正负责传输的组件”。这个理解会把整个结构看歪。`TrafficCounter` 的作用更像是会计和观测面，而不是 transport 主体。

从抽象类注释就能看出来：它按 `checkInterval` 周期统计带宽表现，并回调 `doAccounting` 之类的方法，让 handler 能根据统计结果做出整形决策，见 `handler/src/main/java/io/netty/handler/traffic/AbstractTrafficShapingHandler.java:40`。也就是说，它记录的是“这段时间流量大概跑了多少、该不该限制、限制多久比较合适”，而不是“直接替你 write 数据”。

这点必须说清楚，因为它和前面 HTTP/2 的 `FlowController` 边界非常像：`TrafficCounter` 不是 transport 本身，正如 `WeightedFairQueueByteDistributor` 不是完整流控器。它们都站在真实 I/O 路径旁边，负责提供一种控制或分配依据。只不过这里的依据是带宽与时间窗口，而不是 streamable bytes 与 priority tree。

所以 traffic shaping 这条线最稳的总结方式是：**带宽整形真正操纵的是“何时把消息从辅助托管队列放回正式写路径”，`TrafficCounter` 则负责提供这个操纵所需的计量依据，而不直接改写消息最终要写向哪个 handler 或 transport。**

## `FlowControlHandler`：它不是 HTTP/2 流控，而是 pipeline 下游消费节奏收束器

再看 `FlowControlHandler`，它几乎是最容易被名字误导的一个类。只要前面刚写完 HTTP/2 flow control，读者第一反应几乎一定是：这是不是也在管窗口和可写额度？

类注释明确告诉我们，不是。它解决的问题是：某些上游组件，尤其是 `ByteToMessageDecoder` 或 `MessageToByteEncoder`，可能针对一次输入连续吐出很多事件；可 downstream handler 希望在 autoRead 关闭或手动 `read()` 驱动下，一次只接住一个，再慢慢处理，见 `handler/src/main/java/io/netty/handler/flow/FlowControlHandler.java:33`。

也就是说，这里的“flow control”不是协议窗口流控，而是**pipeline 事件节奏控制**。它关心的是：如果上游一口气发了 `HttpRequest`、`HttpContent`、`LastHttpContent` 这种一串消息，而下游只希望一轮 `read()` 对应一条消息，该怎么把这些已经被上游生产出来的事件先缓住。

实现也完全支持这个解释。`FlowControlHandler` 内部维护的是一个 `RecyclableArrayDeque` 和 `unsatisfiedReads` 计数，见 `handler/src/main/java/io/netty/handler/flow/FlowControlHandler.java:70`、`:96`。上游 `channelRead(...)` 到来时，它不是立刻无条件把消息全都往下 `fireChannelRead`，而是先把消息放进自己的 queue；如果 autoRead 开着，就全部 dequeue；如果 autoRead 关着且下游还有未满足的 `read()`，就只 dequeue 一条，见 `handler/src/main/java/io/netty/handler/flow/FlowControlHandler.java:178`。

这说明 `FlowControlHandler` 的真正作用不是决定 transport 能不能继续发送，而是决定**下游 handler 这轮愿意消费多少上游已经产生出来的消息。**它调节的不是网络侧带宽，而是 pipeline 内部消息喷发节奏。

所以这条边界一定要钉死：

- HTTP/2 flow control 关心的是 stream/window/budget，也就是某条流现在有没有资格继续消费连接级发送额度；
- `FlowControlHandler` 关心的是 decoder/encoder 吐出的消息节奏与下游 `read()` 意愿，也就是 pipeline 内部的消费节奏收束。

前者管理的是 stream/window 预算，后者收束的是下游消息消费节奏。两者都叫 flow control，但处在完全不同层。

## `FlowControlHandler` 真正解决的是“上游一次吐三条、下游只想吃一条”

`FlowControlHandlerTest` 把这个问题展示得很直白。测试里故意放了一个 `OneByteToThreeStringsDecoder`，每收到一个字节就会解出三条消息，见 `handler/src/test/java/io/netty/handler/flow/FlowControlHandlerTest.java:75`。这正是注释里所说的“上游可以任意多产，下游却想自己掌控节奏”的场景。

没有 `FlowControlHandler` 时，哪怕 autoRead 关闭、哪怕下游只调用了一次 `read()`，三个消息还是会一股脑儿全到下游，测试 `testAutoReadingOff()` 就证明了这一点，见 `handler/src/test/java/io/netty/handler/flow/FlowControlHandlerTest.java:171`。

有了 `FlowControlHandler` 以后，queue 和 `unsatisfiedReads` 才把这条链重新收回来：一次 `read()` 只满足一个下游消费请求，其余已经由上游吐出来的消息先在中间层缓住，等下一次 `read()` 或 autoRead 恢复再继续放行。

这说明 `FlowControlHandler` 的最大价值，不在于它“实现了一个队列”，而在于它把 Netty 原本偏向“上游能吐多少就先吐多少”的事件模型，重新压回到“下游这次到底愿意消费多少”的节奏上。对处理 HTTP 请求头/内容、解码后多条逻辑消息或其他喷发型 decoder 来说，这层缓冲非常关键。

所以理解它最好的方式，不是“另一个协议流控器”，而是：**它是 pipeline 内部的消费节奏闸门。**

## `LoggingHandler`：不是调优器，但它决定你能不能看见这些治理行为

最后看 `LoggingHandler`。很多人会本能觉得它只是调试便利工具，和连接治理关系不大。这个判断太轻了。

`LoggingHandler` 的职责当然不是限速、不是背压、不是流控、不是超时判决，它也不会主动改变 transport 语义。可它决定了另一件同样重要的事：当连接真的在 bind/connect/read/write/flush/idle/exception 这些边界上发生变化时，系统有没有一套一致的视图把这些事件打印出来。

类注释已经说明它会记录所有 Channel 事件，默认日志级别是 DEBUG，而且对 `ByteBuf` 会输出完整 hex dump，见 `handler/src/main/java/io/netty/handler/logging/LoggingHandler.java:36`。从实现看，它覆盖了 `channelRegistered`、`channelActive`、`exceptionCaught`、`userEventTriggered`、`bind/connect/disconnect/close` 等几乎所有关键边界，见 `handler/src/main/java/io/netty/handler/logging/LoggingHandler.java:177`。

更重要的是，它还区分了 `ByteBuf` 和 `ByteBufHolder` 的日志视图，以及 `ByteBufFormat` 的差异。也就是说，它不是只在打印一个事件名字，而是在尽量把“当时到底流过了什么数据”也纳入可观测面。

为什么说这和运行时治理有关系？因为前面几篇其实已经证明，Netty 的很多治理动作都发生在很细的边界上：

- `channelWritabilityChanged()` 何时触发；
- `IdleStateEvent` 是 first 还是 repeated；
- 某次 write 是不是卡在 promise completion；
- `TrafficShapingHandler` 是不是在某个时刻挂起了写；
- `FlowControlHandler` 是不是把后续事件先缓住了。

如果完全没有一致的日志视图，这些行为调试起来就会极其痛苦。所以 `LoggingHandler` 虽然不是调优器，却是这些治理行为能否被看见的一层通用入口。

因此，`LoggingHandler` 最稳的定位不是“只是调试方便”，而是：**它是连接治理的可观测性基线。**它不替你做治理决策，但它让治理决策终于有地方被看见。与此同时，这里被记录下来的是 Channel 事件和 ByteBuf 的日志视图，而不是 transport 真相本身；真正的协议状态、allocator 指标和系统层内存表现仍需要和其他诊断信号一起交叉判断。

## 三类 handler 分别补哪层空白

到这里最好做一次并排收束，否则这三类 handler 很容易再次混成一组“运行时辅助器”。

### `TrafficShapingHandler`

它补的是**带宽与延迟整形**这层空白。它不关心协议语义，只关心当前读写速率是否超限，以及是否该把写请求暂时挂进延迟队列，再通过 user-defined writability 位告诉业务“现在先别继续灌了”。

### `FlowControlHandler`

它补的是**pipeline 下游消费节奏**这层空白。它不关心 transport window，不关心 HTTP/2 streamable，不关心网络带宽，而是关心“上游已经喷出来的消息，能不能按 downstream `read()` 的意愿一条条喂下去”。

### `LoggingHandler`

它补的是**可观测性**这层空白。它不改变传输语义，也不负责限速或排队，但它把 Channel 生命周期、I/O 事件和 `ByteBuf` 内容可视化，让前两类治理动作不至于完全发生在黑箱里。

这三层空白放在一起，正好把“连接治理”这个概念补全了：

- 限速：让连接不要写得太快；
- 节奏：让下游不要被上游一次喷太多消息淹没；
- 可观测：让你看得见这些治理动作到底发生了什么。

## 测试真正证明的，是这些 handler 都有自己的生命周期边界

最后再看测试，会发现它们都在反复验证同一件事：这些 handler 不是抽象策略对象，而是会在真实 Channel 生命周期里留下副作用，所以必须有正确的退出边界。

`TrafficShapingHandlerTest.testHandlerRemove()` 验证的就是移除 handler 时，延迟队列里如果还有消息，要么补写出去，要么在连接失活时 release 掉，同时还要清掉 `REOPEN_TASK` 这类属性，见 `handler/src/test/java/io/netty/handler/traffic/TrafficShapingHandlerTest.java:55`。这说明 traffic shaping 队列不是“拔掉 handler 就自动蒸发”，而是必须经历一次完整的 drain 或 release 收尾。

`FlowControlHandlerTest` 则从多个角度说明，autoRead on/off 与 queue drain 并不是简单切换开关。尤其是没有 `FlowControlHandler` 时，上游 decoder 一次喷出的多条消息根本挡不住；而加上它之后，queue empty 与否、unsatisfiedReads 的变化才成为重要生命周期状态，见 `handler/src/test/java/io/netty/handler/flow/FlowControlHandlerTest.java:121`。

这说明一个共同原则：**这些运行时 handler 虽然不像协议 codec 那样处理业务格式，但它们同样必须对齐 pipeline 生命周期和释放边界。**只要移除、关闭、autoRead 切换或延迟队列排空这些边界没设计好，所谓连接治理就很容易反过来制造新的状态混乱。

## 收网：连接治理的三件事，是限速、节奏和可观测

现在可以把整条主线收回来了。

- `AbstractTrafficShapingHandler` / `ChannelTrafficShapingHandler` 解决的是“这条连接该不该按带宽上限和延迟策略被主动整形”，并通过挂起写队列、`TrafficCounter` 和 user-defined writability 接入出站主线。  
- `FlowControlHandler` 解决的是“上游一次吐很多消息、下游却想按 `read()` 节奏慢慢吃”这类 pipeline 内部节奏收束问题，它不是 HTTP/2 flow control。  
- `LoggingHandler` 解决的是“这些治理动作发生时，系统有没有一致的 Channel 事件和 `ByteBuf` 视图可以拿来观察”。

所以本篇真正要留下来的结论是：**连接治理并不只是 timeout 和 watermarks。Netty 还额外提供了三类运行时 handler，分别负责限速、节奏和可观测。**

把这三层看清以后，后面再去看大对象分块写出、应用层 ping/pong、gRPC keepalive 或 Triple transport 调优，就不会再只盯着“协议怎么编解码”，而会自然想到：这条连接还需不需要被限速、它的下游消费节奏能不能兜住、以及这些动作现在到底能不能被看见。