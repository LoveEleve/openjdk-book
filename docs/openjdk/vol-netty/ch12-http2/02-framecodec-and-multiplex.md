# Ch12-02 HTTP/2 Netty API 层：FrameCodec 与 Multiplex

## 先把困惑升级一下：协议地基已经懂了，为什么业务还是没法直接写

前一篇已经把 HTTP/2 的地基讲清楚了：连接上流动的是带 `streamId` 的二进制帧，真正的请求/响应语义挂在 Stream 上；HPACK 负责连接级头压缩，流控负责连接级和流级双窗口。可一旦读者真的回到 Netty 写业务代码，新的困惑会立刻出现：既然协议层已经能区分 stream 了，为什么 Netty 还要再发明 `Http2Frame`、`Http2FrameStream`、`Http2StreamChannel` 这些对象？更夸张的是，一条 TCP 连接上的多个 HTTP/2 stream，在 Netty 里居然还能看起来像多个 child channel。

这个困惑说明，前一篇解决的是“HTTP/2 本身怎么工作”，而这一篇要解决的是“Netty 怎样把这套协议地基翻译成开发者更熟悉的 API 形态”。如果没有这一层翻译，业务面对的就还是一条共享同一连接、同一 pipeline、同一出站缓冲区的 frame 洪流。每个 handler 都得自己看 `streamId`，自己区分 HEADERS/DATA/WINDOW_UPDATE，自己维护 Stream 状态，自己决定哪些事件应该像普通消息一样读入，哪些更像 user event 一样传播。这样虽然理论上可行，但它和 Netty 一贯的使用方式并不相容。

Netty 在 HTTP/2 API 层做的核心事情，正是把这道门槛拆成两步。

第一步，`Http2FrameCodec` 先把 wire frame 翻译成 `Http2Frame` 对象，并为每个 stream 绑定一个 `Http2FrameStream` 句柄。这样业务不再面对“9 字节头 + payload”的原始协议视角，而是面对“这是一条 headers frame，这是一条 data frame，这一帧属于哪个 stream”的对象视角。

第二步，`Http2MultiplexHandler` 再把这个 stream 句柄投影成 child channel。这样业务就不必在一条父连接的 handler 链里手工分发所有 stream，而是可以像平时写 Netty 一样，为每个 stream 准备自己的 child pipeline、自己的 inbound handler、自己的 active/inactive 生命周期感知、自己的异常传播路径。

所以本篇真正要回答的，不是“FrameCodec 里有哪些类”，而是：**Netty 为什么要把 frame 先变成对象，再把 stream 进一步变成 child channel；以及这两层投影到底分别解决了什么问题。**

## 如果只暴露底层 connection/frame listener，业务会卡在哪

要看清 API 层为什么存在，最好的办法不是先夸它优雅，而是先推演一个没有这层翻译的世界会有多别扭。

第一种失败方案，是只给业务暴露一条父连接上的所有 frame。理论上，框架完全可以把 `Http2FrameReader` 读出来的所有 HEADERS、DATA、WINDOW_UPDATE、RST_STREAM 都直接交给同一个 handler 链，再要求业务自己根据 `streamId` 建表、路由、聚合和关闭。问题是，这等于把 HTTP/2 最麻烦的那部分状态管理又原封不动推回给应用：哪条 frame 属于哪个 stream，哪个 stream 现在 half-closed 了，哪个 stream 需要因为 GOAWAY 或 RST 而通知业务结束，全部都得自己维护。

第二种失败方案，是框架替你把 frame 变成对象，但仍然只留一条统一 pipeline。这样比第一种略好，因为至少应用不再直接面对裸帧，但核心问题还在：每个 handler 仍然必须在同一条入站链里靠 `if/switch` 去区分 stream 归属、事件类型和异常范围。一个连接上几十上百个并发 stream 时，这条链会同时承担“协议解析”“stream 路由”“业务处理”“连接级事件处理”四种完全不同的职责，几乎注定会变成一锅粥。

第三种失败方案，是让业务自己在应用层模拟 child pipeline。也就是说，框架只给你 frame 和 streamId，剩下的“每条 stream 有独立 handler 链、独立 active/inactive 生命周期、独立异常传播和关闭语义”都由业务自己拼。这种做法的问题，不在于实现不了，而在于它直接把 Netty 本来最成熟的一套抽象——Channel、Pipeline、HandlerContext、Promise、writability、event loop 顺序保证——全部绕开了。应用最后不是在用 Netty 的 HTTP/2 API，而是在父连接之上重新手写一个迷你版 Netty。

所以这三种失败方案共同说明：HTTP/2 API 层真正要解决的，不是“把协议细节包成几个 POJO”，而是“让多路复用以 Netty 自己熟悉的运行时语义出现”。只要这个目标成立，答案就很自然：先把 frame 变成对象，再把 stream 变成 child channel。

也正因为如此，`Http2FrameCodec` 和 `Http2MultiplexHandler` 不是两个松散的独立组件，而是一个两段式翻译器。前者回答“这是一帧什么消息、属于哪个 stream”；后者回答“既然属于某个 stream，那我能不能让它像一个独立 Channel 那样被接住”。

## 第一层翻译：`Http2FrameCodec` 把 wire frame 变成 `Http2Frame` 对象

`Http2FrameCodec` 的类注释几乎已经把它的 API 层定位写在第一句话里了：这是一个把 HTTP/2 frame 映射成 `Http2Frame` 对象、再把 outbound `Http2Frame` 写回 wire format 的 handler，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:45`。这句话虽然看上去像“对象包装器”的定义，但真正关键的不是“frame 变对象”，而是“对象一旦出现，就能挂进 Netty 原本的 pipeline 语义里”。

对 inbound 来说，`Http2FrameCodec` 会在 `channelRead` 方向把不同类型的帧转成对应的 `Http2Frame` 或 `Http2StreamFrame`。对 outbound 来说，应用写入的则不再是原始 HEADERS/DATA 二进制片段，而是像 `Http2HeadersFrame`、`Http2DataFrame` 这样的对象，再由 codec 往下翻译成真实 HTTP/2 wire format，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:46`。

如果只到这里，它仍然只是“对象包装”。真正让 API 层成立的，是 `Http2FrameStream`。

类注释明确写了两件事。

第一，读进来的 `Http2StreamFrame` 一定会带一个 `Http2FrameStream` 对象，它唯一标识某个具体 stream，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:55`。也就是说，一条入站 frame 不只是“类型变了”，它同时还被绑定到了一个 API 层可追踪的 stream 句柄上。

第二，写出时则反过来：应用在写一个 `Http2StreamFrame` 之前，必须自己先把 `Http2FrameStream` 句柄挂上去，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:59`。这等于把一个原本藏在 `streamId` 数字里的协议维度，显式提升成了“对象写出前必须附着的上下文”。

这两条规则非常重要，因为它们共同把 HTTP/2 从“连接上的一堆 frame”改写成了“带 stream 上下文的对象流”。后面再看 child channel 时你会发现，`Http2MultiplexHandler` 正是接着这个句柄往下做第二层投影的。没有 `Http2FrameStream`，就没有 child channel 可以附着的 stream 身份。

所以 `Http2FrameCodec` 的第一层贡献，不是让应用少看一点二进制，而是先把“frame 属于哪条 stream”这件事变成对象级别的显式关系。与此同时，它也没有把 HTTP/2 API 层变成“什么对象都能随便往里写”的开放口子；类里有一组明确的 `SUPPORTED_MESSAGES`，说明这层翻译只接受它自己认识的一组 HTTP/2 frame 对象，而不是任意上层消息。只有这样，后续的 stream 生命周期、异常范围、引用计数责任和 child pipeline 才有地方挂。

## `Http2FrameStream` 不是编号包装，而是 API 层的 stream 句柄

很多人第一次看到 `Http2FrameStream`，会下意识把它当成 `streamId` 的对象包装：不过就是把一个整数换成一个小接口，方便一点而已。这个理解太轻了。

在 `Http2FrameCodec` 的语义里，`Http2FrameStream` 真正承担的是 API 层 stream 句柄的职责。它不是只让业务知道“这是 3 号流、5 号流”，而是让后续所有以 stream 为边界的状态、异常和 channel 投影都有一个稳定锚点。

类注释里关于 stream lifecycle 的那段很能说明问题。一个 active stream 会在任一侧发送 `RST_STREAM`，或者双方都发送了带 `END_STREAM` 的帧后关闭；而每个 `Http2StreamFrame` 都绑定着一个唯一对应的 `Http2FrameStream`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:53`。换句话说，API 层不是把“stream 状态”散落在很多 frame 之间，而是把它们都通过同一个 stream 句柄串起来。

这也是为什么创建 outbound stream 时，不是直接让你写一个“待分配 streamId 的 headers frame”，而是先通过 `Http2ChannelDuplexHandler.newStream()` 拿到一个新的 `Http2FrameStream`，再把它挂到 `Http2HeadersFrame` 上写出去，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:82`。这套顺序表达的其实是：在 API 层，stream 先是一个有待建立的句柄，然后才由某个具体 frame 把它真正带入协议状态机。

如果把这里压成一句最小心智图，可以写成：

- `Http2Frame`：回答“这是一条什么消息”；
- `Http2FrameStream`：回答“这条消息属于哪条 stream，以及异常/状态边界落在哪条 stream”；
- `Http2StreamChannel`：回答“这条 stream 在 Netty 里由哪个局部运行时容器来接住”。

更进一步，关于错误边界的那段注释也说明它绝不是普通编号包装。类注释明确写了：如果某个异常只适用于特定 HTTP/2 stream，它会被包装成 `Http2FrameStreamException`，并且异常里会附着对应的 `Http2FrameStream`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:125`。这说明在 API 层里，stream 句柄不仅承载“属于哪条流”的身份，也承载“这次异常范围落在哪条流”的边界信息。

所以理解 `Http2FrameStream` 最好的方式，不是把它想成 `streamId` 的对象化，而是把它想成一根把 frame、状态和异常都拴在一起的绳子。前一篇里我们已经知道协议层真正工作的是 stream 状态机；这一篇里，Netty 只是把那台状态机在 API 层的可见入口，统一收束成了 `Http2FrameStream` 这个句柄。

有了这个句柄，FrameCodec 才能把“这是一条属于某个 stream 的消息”稳稳交给上层。没有它，后面的 multiplex child channel 连“附着在哪条 stream 上”都无从谈起。

## 第二层翻译：`Http2MultiplexHandler` 把 stream 句柄投影成 child channel

如果说 `Http2FrameCodec` 解决的是“如何把 frame 变成带 stream 上下文的对象”，那 `Http2MultiplexHandler` 解决的就是更进一步的问题：既然每条 frame 已经知道自己属于哪条 stream，能不能让每条 stream 直接像一个独立 Channel 一样被业务接住？

它的类注释开宗明义：这个 handler 会为每个 stream 创建一个 child channel，而且必须和 `Http2FrameCodec` 配合使用，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:45`。注意这里的关键不是“创建一个对象”，而是“创建一个 child channel”。这意味着 Netty 决定不让应用继续在一条父连接的 pipeline 里手动分拣所有 stream，而是把每条 stream 的业务接收面直接投影成 child pipeline。

这个投影一旦建立，很多原本会在 HTTP/2 上额外发明的新概念，都能重新复用 Netty 既有抽象。

- 每个 stream 都可以有自己的 `ChannelPipeline`；
- 每个 stream 都有自己的 active/inactive 感知；
- 每个 stream 都能收自己的 user event、异常和 writability 信号；
- 每个 stream 的 handler 不必再在父连接里自己用 `if(streamId)` 分发。

从业务编程体验看，这比“在一条大连接里手工路由 frame”自然得多。因为 HTTP/2 虽然协议上是多路复用，但业务想处理的往往还是“一条请求流、一条响应流”的相对局部语义。child channel 正是把这种局部语义重新还给开发者。

`Http2MultiplexHandler.channelRead(...)` 这段实现很好地证明了它并不是抽象噱头。如果收到的是 `Http2StreamFrame`，handler 会先拿到它携带的 `DefaultHttp2FrameStream`，再通过 `attachment` 找到对应的 `AbstractHttp2StreamChannel`，然后把 frame 投递到这个 child channel，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:168`。也就是说，父连接上的 frame 到了这里，不再继续在父 pipeline 里被当作“一条共享消息”，而是被分派到了 stream 自己的 child world 里。

这一步就是真正的 multiplex API 层翻译：协议层的一条 stream，在 Netty 里被投影成一个可注册、可收发、可感知生命周期的 child channel。前一篇讲的是“为什么 HTTP/2 一条连接上能有很多 stream”；这一篇则是在回答“Netty 为什么能让这些 stream 看起来像很多小 Channel”。

## 为什么有些 frame 走普通 read，有些却要走 user event

一旦把 stream 投影成 child channel，另一个必须说清楚的问题就来了：所有属于某条 stream 的 frame，都会像普通消息一样走 `channelRead()` 吗？答案是否定的，`Http2MultiplexHandler` 明确把两类 frame 特别拎出来：`Http2ResetFrame` 和 `Http2PriorityFrame`。

在 `channelRead(...)` 里，如果收到的是普通 `Http2StreamFrame`，且不是 `Http2WindowUpdateFrame`、不是 reset、不是 priority，那么 handler 会调用 `channel.fireChildRead(streamFrame)`，也就是把它当成 child channel 的普通入站消息，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:168`。但如果是 `Http2ResetFrame` 或 `Http2PriorityFrame`，它不会走这条普通读入路径，而是改成 `channel.pipeline().fireUserEventTriggered(msg)`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:180`。

这不是随意区分，而是在强调 API 语义差别。

普通 `Http2HeadersFrame`、`Http2DataFrame` 更像“这条 stream 真正要消费的业务内容”；而 `RST_STREAM`、PRIORITY 这类帧更像“影响这条 stream 行为和状态的控制事件”。它们不受普通 read 流控和 child channel `read()` 抑制逻辑约束，也不适合被业务误解成“我读到了一条普通消息”。Netty 把它们抬成 user event，本质上是在告诉应用：这不是 stream 上的一段 payload，而是 stream 状态边界自己在说话。

这条区分非常值得记住，因为它正好说明 `Http2MultiplexHandler` 创建 child channel 并不是在做一层机械路由。它还在重新组织“哪些东西是业务消息，哪些东西是状态事件”。如果所有 frame 都平铺进 `channelRead`，业务仍然得自己判断哪些消息该像数据一样消费，哪些更像边界或控制信号。Netty 这里主动把它们拆开，child channel 的语义就清晰得多。

所以当我们说 `Http2MultiplexHandler` 把 stream 变成了 child channel，真正的含义不只是“给每条 stream 一个独立管道”，而是“把 frame 再按消息语义和状态语义重新归类”。这也是它比手写 `streamId -> handler` 路由更像一个完整运行时抽象的原因。

## child channel 最容易误解的第一个边界：active 不等于 stream 已经完全建立

一旦 child channel 出现，最容易让人误会的就是它的 active 状态。很多人看到“stream 对应一个 child channel”，就会下意识把“child channel active”理解成“这条 HTTP/2 stream 已经完全建立好了”。`Http2MultiplexHandler` 的类注释专门提醒：事情没这么简单。

注释写得很明确：child channel 只要被注册到 `EventLoop` 就会变成 active，因此一个 active child channel 并不立刻等于一个 active HTTP/2 stream；只有当某个 `Http2HeadersFrame` 已经成功发送或接收之后，这个 channel 才真正映射到一条 active HTTP/2 stream，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:75`。

这句话极其关键，因为它把“Netty Channel 生命周期”和“HTTP/2 Stream 生命周期”这两层边界分开了。child channel active 只说明：这个 API 层抽象已经被 event loop 接纳，可以开始承担 pipeline、handler 和事件投递职责；它不保证底层协议状态机那边已经完成了 HEADERS 建立、stream id 分配、远端确认等更强的语义步骤。

为什么非得这么设计？因为从实现上讲，child channel 必须先存在，很多后续事件和 handler 才有地方落；但从协议上讲，stream 真正变 active 又要依赖更晚到来的 HEADERS 或状态变化。Netty 只能承认这两个时刻不是一回事，而不能强行把它们捏成同一个瞬间。

这也是理解 outbound stream 创建时机的关键。无论是 `Http2FrameCodec.newStream()`，还是后面 `Http2StreamChannelBootstrap.open()` 创建 outbound child channel，API 层都允许你先得到一个 channel/stream 句柄，再由后续 HEADERS 真正把它推进到底层协议状态。只有这样，业务才能先把 handler 链、option、attr 等准备好，再发起真正的 stream 建立动作。

所以面对 child channel active，最稳妥的理解不是“stream 已完全建立”，而是“Netty 为这条即将或已经映射到某个 stream 的局部世界准备好了运行时容器”。这层分离如果不先讲清楚，后面很多关于异常、writability 和关闭行为的判断都会被带偏。

## child channel 最容易误解的第二个边界：writability 不等于整条连接都还能随便写

第二个最容易出错的地方，是 child channel 的 writability。因为一旦 stream 看起来像独立 channel，很多人就会自然地把 `childChannel.isWritable()` 理解成“这条 HTTP/2 连接现在总体上还很宽松”。`Http2MultiplexHandler` 的文档明确说，这个理解不成立。

它写得非常直白：child channel 的 writability 观察到的是 outbound/remote flow control，而且只在这个 channel 已经映射到 active HTTP/2 stream 时才有意义；更重要的是，child channel **并不知道 connection-level flow control window**，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:83`。这意味着哪怕某条 child stream 自己看起来还可写，父连接级别的总窗口、总背压或总缓冲压力也可能已经变紧。

这条边界极其重要，因为它把我们前面几篇刚建立好的 writability 心智图再次分层了。

- 在普通 Netty Channel 上，`channel.isWritable()` 主要反映用户态托管区的待写压力；
- 到 HTTP/2 child channel 上，writability 又多了一层 stream-level flow control 的语义；
- 但它仍然不是“整条连接的全知信号”，因为 connection-level 窗口和父连接级别压力并不会完全投影成 child channel 自己的局部视角。

所以 child channel writability 的正确理解，不是“整个 HTTP/2 连接现在没压力”，而是“站在这条 stream 的 API 边界上，它当前对下游流控的局部观察仍允许继续写”。一旦把这个边界忘掉，业务就很容易在 child channel 层误以为“还能写很多”，结果把额外数据继续压回父连接的托管区。

这也是为什么类注释特别提醒：handler 完全可以忽略 child channel 的 writability，这种情况下多余写入会继续被父 channel 缓冲，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:87`。这句话看起来像警告，实际上是在说明 API 层抽象到这里为止的局部性：child channel 的 writability 是很有价值的信号，但它不是全局真相。

## child channel 最容易误解的第三个边界：关闭一个 stream channel 可能映射成 `RST_STREAM`

第三个边界是关闭语义。对普通 Netty Channel 来说，`close()` 往往意味着这条连接或通道彻底结束；但对 `Http2StreamChannel` 来说，关闭的并不是整条 TCP 连接，而是其中某一条 stream。于是 child channel 的关闭动作，自然要被翻译回 HTTP/2 自己的局部关闭语义。

`Http2MultiplexHandler` 的类注释明说：一旦关闭 `Http2StreamChannel`，如果需要的话，会向远端发送一个带 `Http2Error.CANCEL` 的 `Http2ResetFrame`；如果你希望用别的错误码关闭这条 stream，就应该向 pipeline 传播一个 `Http2FrameStreamException`，最终框架会自动把它转成对应错误码的 `RST_STREAM`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:91`。

这段说明非常关键，因为它再次证明 child channel 不是“真的多了一条 TCP 通道”，而是“某条 HTTP/2 stream 在 API 层的投影”。关闭这个投影时，真正发到线上的是 stream 级别的协议动作，不是整条连接级别的 close。

也正因为如此，`Http2GoAwayFrame` 和 `Http2ResetFrame` 这类事件才会被当成 child channel 必须感知的 user event。它们不是普通数据，而是直接影响 stream 是否还能继续通信的边界信号。child channel 的生命周期、异常传播和关闭行为，最终都要回到“底层 stream 状态机到底会怎么走”这件事上。

所以对 `Http2StreamChannel.close()` 最准确的理解是：它不是把父连接关掉，而是要求框架把这条局部 stream 的结束语义正确翻译成协议动作。child channel 在这里的价值，不是把协议差异抹平，而是让这份差异变成一个更符合 Netty 编程模型的局部关闭接口。

## `Http2StreamChannelBootstrap`：为什么主动开 stream 还要像 Bootstrap 一样组织

到这里为止，我们已经知道入站 stream 是如何被投影成 child channel 的。可 outbound stream 呢？为什么 Netty 不直接暴露一个 `new Http2StreamChannel(...)` 给你，而是还要专门造一个 `Http2StreamChannelBootstrap`？

原因和普通 Netty 里的 `Bootstrap` 很像：一条新的 child stream channel 不是“new 出来就算完”，它还需要挂 handler、设 option、写 attr、保证在正确的 event loop 上注册，并确保父连接里确实已经有 `Http2MultiplexHandler` 或 `Http2MultiplexCodec` 这一层上下文。

`Http2StreamChannelBootstrap` 正是把这些前置步骤包成一个 Netty 风格入口。它内部持有父 `Channel`、要设置的 `ChannelOption`、`AttributeKey` 和 `ChannelHandler`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2StreamChannelBootstrap.java:45`。`open()` 时先找到 multiplex context，如果当前不在对应 executor 上，就把真正的创建动作投递到 event loop；如果父连接已经 inactive，则直接失败，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2StreamChannelBootstrap.java:102`。

`findCtx()` 这段实现也很能说明它不是可有可无的便利层。bootstrap 会先尝试缓存的 `multiplexCtx`，不行就去父 pipeline 里查找 `Http2MultiplexCodec` 或 `Http2MultiplexHandler`；如果都找不到，而 channel 还活着，它直接抛出配置错误，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2StreamChannelBootstrap.java:135`。这说明 outbound stream channel 的创建不是裸构造动作，而是必须依附于一条已经安装好多路复用 API 层的父连接环境。

真正开 stream 的 `open0(...)` 会根据当前 multiplex handler 类型拿到一个新的 outbound stream channel，初始化 pipeline、应用 option 和 attr，然后把 child channel 注册到父连接的 event loop 上，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2StreamChannelBootstrap.java:164`。这整套流程和普通 Netty `Bootstrap` 非常像：不是“我需要一个对象”，而是“我需要一个已经被正确接入运行时语义的通道”。

所以 `Http2StreamChannelBootstrap` 的价值，不只是多包了一层 builder，而是把“主动开一条 HTTP/2 stream”这件事重新收编进 Netty 最熟悉的启动模型里。它和普通 `Bootstrap` 很像，但本质上又不是“创建一条新的 TCP 连接”，而是在一条已经存在的 HTTP/2 父连接上，开出一个新的局部 stream runtime。child stream channel 在 API 层之所以看起来像真正的 Channel，正是因为连创建它的方式都尽量保持了同一种运行时语法。

## ownership 和异常传播说明：到了 API 层，引用计数责任并没有消失

讲到 HTTP/2 API 层，最容易再次被忽略的一点，就是对象所有权和引用计数责任其实并没有因为“有了 child channel”就自动消失。

`Http2FrameCodec` 的类注释专门有一节 `Reference Counting`，明说某些 `Http2StreamFrame` 因为携带 `ByteBuf` 等引用计数对象，本身也实现了 `ReferenceCounted`；frame codec 在传播前会先 `retain()`，因此应用 handler 消费后仍然需要 release，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:131`。`Http2MultiplexHandler` 又几乎原样重复了这条规则，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:67`。

这条规则放在本篇末尾反而更好理解。因为现在我们已经知道，API 层做的是两层投影：frame -> object，stream -> child channel。投影可以改变开发者观察和处理对象的方式，但不会替底层对象抹掉 ownership 协议。一个 `Http2DataFrame` 进了 child channel，看起来像局部 stream 消息了，可它底下如果还带着 `ByteBuf`，那引用计数责任仍然在。

异常传播同样说明 API 层没有把底层边界抹平，只是重新组织了它。`Http2FrameCodec` 会把只作用于特定 stream 的异常包装成 `Http2FrameStreamException`，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:127`；`Http2MultiplexHandlerTest` 还专门验证了异常如何被转发到 child channel，甚至可以被包装成 `Http2MultiplexActiveStreamsException` 这种更适合 active streams 范围的形式，见 `codec-http2/src/test/java/io/netty/handler/codec/http2/Http2MultiplexHandlerTest.java:85`。

这说明 Netty API 层并不是想让业务“忘记自己在处理 HTTP/2”，而是想让业务在 HTTP/2 语义仍然成立的前提下，用更像 Netty 的方式处理它。引用计数责任保留着，异常范围保留着，流控边界保留着，变化的只是它们终于不必再挤在一条父连接的大杂烩 handler 链里。

## 收网：FrameCodec 把 frame 变成对象，Multiplex 把 stream 变成 Channel

现在可以把整条主线收回来了。为什么前一篇已经把 HTTP/2 的协议地基讲清楚了，Netty 还要再额外做一层 API 层翻译？因为协议能工作，不等于开发者就愿意直接面对连接级 frame 洪流。Netty 真正要做的，是把 HTTP/2 的多路复用状态机改写成它自己最擅长的运行时语义。

- `Http2FrameCodec` 先把 wire frame 变成 `Http2Frame` / `Http2StreamFrame`，并通过 `Http2FrameStream` 把 stream 身份显式挂到对象上，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:45`。  
- `Http2FrameStream` 不是编号包装，而是 API 层里承载 stream 生命周期、异常范围和后续 child channel 附着关系的句柄。  
- `Http2MultiplexHandler` 再把这个 stream 句柄投影成 child channel，让每条 stream 都能拥有自己的 pipeline、自己的 active/inactive 边界、自己的局部异常和局部业务处理路径，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:45`。  
- `Http2StreamChannelBootstrap` 则把主动创建 outbound stream 的过程也收编进 Netty 风格的启动模型，见 `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2StreamChannelBootstrap.java:98`。  
- 整个过程中，引用计数、writability、异常传播和关闭语义都没有消失，只是被重新组织成了更符合 Netty 编程模型的局部视图。

所以本篇真正要留下来的心智模型是：**`Http2FrameCodec` 解决“frame 怎么变成对象流”，`Http2MultiplexHandler` 解决“stream 怎么变成 channel 语义”，两者合在一起，才让 HTTP/2 在 Netty 里不只是可实现，而且可编程。**

有了这层 API 翻译，后面再去看 gRPC、Dubbo Triple 或者任何跑在 HTTP/2 之上的协议，就不会再觉得它们是在一条神秘大连接上做魔法。它们只是把 RPC 或应用语义，挂在了 Netty 已经替你准备好的那套 frame object、stream handle 和 child channel 投影之上。换句话说，业务之所以不必自己在父连接里按 `streamId` 手写路由，并不是 HTTP/2 变简单了，而是 Netty 已经替你把这层路由、生命周期和局部运行时容器翻译好了。