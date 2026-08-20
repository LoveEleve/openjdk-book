# Ch12-04 gRPC / Dubbo Triple 如何落在 HTTP/2 API 与连接主链上

## 前面三篇已经把地基搭好了，但 RPC 还差最后一层翻译

到这里为止，Netty 侧的 HTTP/2 主线其实已经基本完整了。前一篇讲清楚了 HTTP/2 协议地基：frame、stream、HPACK、双层流控。再前一篇把 API 层讲清楚了：`Http2FrameCodec` 把 wire frame 变成对象流，`Http2MultiplexHandler` 再把每条 stream 投影成 child channel。接着 `ConnectionHandler/Encoder/Decoder` 那篇又把连接状态机收了起来：preface、SETTINGS、GOAWAY、流控、stream 限制、分配策略和关闭收尾都已经有了位置。

可只要真正回到上层 RPC 框架，新的问题还是会立刻出现：gRPC 里我们看到的是 `StreamObserver`、metadata、status、keepalive；Dubbo Triple 里我们看到的是 `Invoker`、`TripleClientCall`、`TripleWriteQueue`、协议探测器和 transport listener。它们看起来已经很像一套完整的 RPC 世界，为什么还要关心下面那条 HTTP/2 主线？

答案是：因为这些 RPC 语义并没有绕开前面三篇建立的那条链，它们只是又做了最后一层翻译。HTTP/2 负责把一条连接变成很多 stream，FrameCodec 和 Multiplex 负责把 stream 变成对象与 child channel，ConnectionHandler/Encoder/Decoder 负责把连接状态机跑起来；而 gRPC 与 Dubbo Triple 负责的，则是把“方法调用、头元数据、observer、状态和写队列”重新挂到这些现成的 HTTP/2 运行时接口上。

所以本篇要解决的核心困惑不是“gRPC 和 Triple 有哪些类”，而是：**上层 RPC 语义究竟是如何落在前面已经搭好的 Netty HTTP/2 API 层与连接主链上的。**只要这点讲清楚，后面再看 gRPC streaming、Triple unary/streaming、GOAWAY、写队列和 transport listener，就不会再觉得它们像各写各的独立世界。

## 先推演失败方案：如果 RPC 框架自己重写整套 HTTP/2 传输，会卡在哪

理解桥接层最好的办法，仍然不是先夸它优雅，而是先看如果没有这层桥接，上层框架会被迫承担什么。

第一种失败方案，是 gRPC 或 Triple 直接自己重写一整套 HTTP/2 连接处理器。也就是说，自己收 preface，自己管 SETTINGS，自己判断 stream 状态，自己维护本地和远端窗口，自己处理 GOAWAY 和 stream close。这听起来最“独立”，但问题也最大：你等于把前面几篇已经拆开的协议状态机、API 层和连接主链全部再写一遍。只要 reader/writer、frame object、stream handle、flow controller 或 child channel 语义有一层没对齐，就会和 Netty 自己的 HTTP/2 运行时互相抢状态。

第二种失败方案，是完全无视 FrameCodec / Multiplex 这层 API，直接在一条父连接里用 `streamId` 手工路由所有 RPC 请求。这样虽然仍然能复用底层 HTTP/2 连接主链，但上层会再次掉回“自己分发 frame、自己建局部状态机、自己决定哪些事件属于哪个 stream”的世界。对于 gRPC 这种强调每条 RPC 流的 listener、状态和 metadata 边界的框架来说，这样做几乎等于重新在父连接上模拟 child channel；对于 Triple 这种要同时兼顾 HTTP/1 upgrade、HTTP/2、WebSocket、transport listener 的协议组合体来说，更是会让 pipeline 组织方式迅速失控。

第三种失败方案，是把 RPC 调用简单理解成“写几个字节出去”。这会让方法调用、metadata、observer、状态码、压缩与窗口更新全部退化成一串 payload 处理问题。可前面三篇已经证明，HTTP/2 里的很多关键语义根本不在 payload 里，而在连接状态、stream 生命周期、flow control 和 GOAWAY 这些边界里。只要把 RPC 看成“业务对象最终变成字节”，就一定会低估 transport 层语义在上层框架里的位置。

这三种失败方案共同说明：gRPC 和 Triple 的工作重点，不是“自己发明一条新传输栈”，而是**尽可能复用 Netty 已经准备好的 HTTP/2 状态机和 API 层，再把 RPC 自己那一层语义接进去。**

所以本篇后面的结构也很自然：先看 gRPC 是如何把自己的 handler、metadata 和 keepalive 插到 `Http2ConnectionHandler` 这条连接主链里；再看 Triple 是如何更显式地组合 `Http2FrameCodec`、`Http2MultiplexHandler` 和自定义 flow controller、listener/queue，把 Dubbo 的调用模型落进去。

## gRPC 的第一层桥：`GrpcHttp2ConnectionHandler` 不是重写，而是包装

gRPC 这条线最好的入口，就是 `GrpcHttp2ConnectionHandler`。因为它的类注释已经把姿态写得很清楚：这是一个 gRPC 对 `Http2ConnectionHandler` 的 wrapper，见 `grpc-java/netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:32`。

它不是另外一套连接处理器，更不是想取代 Netty 的 HTTP/2 主链。它直接继承 `Http2ConnectionHandler`，构造器只是额外接收 `channelUnused` 和 negotiation logger，然后调用父类构造器，见 `grpc-java/netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:42`。这说明 gRPC 在连接级的第一策略非常克制：连接状态机、preface、frame decode/encode、flow control 和 flush 仍由 Netty 那条主链负责；gRPC 做的是把“协议协商完成后的附加信息、channelz/security、unused 通知”等 RPC transport 语义插进去。

`handleProtocolNegotiationCompleted(...)` 就是典型例子。它不是 reader/writer 逻辑的一部分，而是在 negotiation 完成后、handler 加入 channel 前，把 attributes 和 securityInfo 交给 gRPC 侧 transport 语义，见 `grpc-java/netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:66`。这说明 RPC 框架在连接级最先关心的，往往不是“字节怎么解”，而是“这条 HTTP/2 连接在 RPC 视角里还附带了哪些协商结果和安全属性”。

同样，`notifyUnused()` 也很能说明桥接思路。它不是关闭 channel，而是把 `channelUnused` promise 设为成功，用于表示这条 channel 后面可能脱离 Netty executor 场景继续被用，见 `grpc-java/netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:87`。这已经不属于 HTTP/2 协议本身，而是 gRPC 自己围绕 transport 生命周期做的附加控制。

所以 gRPC 在这条入口上的选择非常明确：**连接主链继续由 Netty 的 `Http2ConnectionHandler` 驱动，gRPC 只是包上一层 transport 语义外壳。**

如果把这一点忘掉，后面看 `NettyServerHandler` 和 `NettyClientHandler` 时就容易误解成“gRPC 自己写了一套新的 HTTP/2 处理器”。实际上它们更像是在 `Http2ConnectionHandler` 这条现成连接主链上，注入 gRPC 所需的 header 处理、metadata、状态管理和 keepalive 行为。

## gRPC 服务端：`NettyServerHandler` 直接组装自己的 HTTP/2 连接状态机

gRPC 的服务端落点，比 `GrpcHttp2ConnectionHandler` 这个抽象入口更具体。`NettyServerHandler.newHandler(...)` 会直接创建服务端自己的 `Http2FrameReader`、`Http2FrameWriter`、`DefaultHttp2Connection`、`DefaultHttp2ConnectionDecoder`、`DefaultHttp2ConnectionEncoder` 以及 flow controller，并把 transport listener、keepalive、max streams、header list size、message size、RST 限制等 gRPC transport 语义一起灌进去，见 `grpc-java/netty/src/main/java/io/grpc/netty/NettyServerHandler.java:159`。

这说明 gRPC 并没有避开前一篇讲的连接主链，反而是把那条主链作为自己 transport handler 的构造骨架。只不过，gRPC 在这个骨架上又叠了一层自己关心的 server transport 语义：

- `ServerTransportListener`：接住上层 RPC transport 生命周期；
- `TransportTracer`：记录 transport 维度指标；
- `KeepAliveEnforcer` / `KeepAliveManager` / `MaxConnectionIdleManager`：把 gRPC 的 keepalive 和连接年龄策略压到同一条 HTTP/2 连接上；
- `streamTracerFactories`：为每条 RPC stream 附加 tracing 语义；
- metadata / authority / content-type / TE 校验：把 HTTP/2 头语义映射成 gRPC header 约束。

也就是说，对 gRPC 服务端来说，HTTP/2 连接主链不是“底层黑箱”，而是它自己 transport handler 的第一层材料。它需要这条主链已经具备 stream 状态机、flow control、SETTINGS、GOAWAY 和 flush 语义，然后才能安全地把 gRPC 自己的 `Metadata`、`Status`、`ServerTransportListener` 和 stream tracer 贴上去。

这也解释了为什么 `NettyServerHandler` 里会自己组装 `DefaultHttp2LocalFlowController`、`DefaultHttp2RemoteFlowController`、`DefaultHttp2FrameReader`、`DefaultHttp2FrameWriter` 这一套。它不是要绕开 Netty 的 HTTP/2 连接主链，而是要在“主链仍然是那条主链”的前提下，带着 gRPC 自己的参数和 listener 语义把它构出来。

所以理解 gRPC 服务端最好的方式，不是“它有自己的 handler”，而是“它有自己的 HTTP/2 主链装配方案”。连接状态机还是那台状态机，只是外面包上了 gRPC 的 transport 语义。

## gRPC 客户端：在同一条连接主链上再加 keepalive、authority 和 stream buffering

客户端路径和服务端类似，但它在一些边界上更能说明“RPC 语义如何叠加到 HTTP/2 主链上”。

`NettyClientHandler.newHandler(...)` 也会显式创建 `DefaultHttp2Connection`、`DefaultHttp2FrameReader`、`DefaultHttp2FrameWriter`，还会额外创建 `UniformStreamByteDistributor` 和 `DefaultHttp2RemoteFlowController`，然后把它们挂到 connection 上，见 `grpc-java/netty/src/main/java/io/grpc/netty/NettyClientHandler.java:156`、`:177`。这再次证明：gRPC 客户端没有跳过 Netty 的 HTTP/2 连接主链，它也是先构造 connection、reader、writer、encoder、decoder、flow controller，再往里面塞自己的 transport 语义。

客户端更显眼的一层，是 authority、ping、in-use 状态和 keepalive。类里维护了 authority、`Http2Ping`、`InUseStateAggregator`、`KeepAliveManager`、`ClientTransportLifecycleManager` 等组件，见 `grpc-java/netty/src/main/java/io/grpc/netty/NettyClientHandler.java:120`。这些东西都不是 HTTP/2 协议自身的基础部件，但它们又必须依附在同一条 HTTP/2 连接上工作。

这说明客户端和服务端虽然都构建在相同 HTTP/2 主链上，但各自附加的 RPC 侧语义并不相同：

- 服务端更关心 listener、tracer、maxStreams、keepalive enforcement、server stream lifecycle；
- 客户端更关心 authority、ping、transport in-use 状态、断连状态映射和 client-side lifecycle。

再看 `StreamBufferingEncoder` 的使用也很有意思。客户端 newHandler 里显式创建了 `UniformStreamByteDistributor` 和 remote flow controller，用于控制出站 stream 的额度分配，见 `grpc-java/netty/src/main/java/io/grpc/netty/NettyClientHandler.java:177`。这意味着对 gRPC 客户端来说，“开一条 RPC stream”本质上仍然是在 HTTP/2 连接上争取一个 stream 和一份流控额度。RPC 并没有抹掉 stream buffering、window 或 write queue 这些连接级约束，而只是让应用通过更高层的调用 API 去触发它们。

所以 gRPC 客户端这一线最值得记住的，不是某个具体 handler 字段，而是它再次重复了同一件事：**RPC transport 语义是叠在已有 HTTP/2 连接主链上的，而不是另起一套。**

## Dubbo Triple 的姿态不同：更显式复用 `Http2FrameCodec`、`Http2MultiplexHandler` 和协议选择管线

gRPC 这条线更贴近“连接级 handler 自己把 HTTP/2 主链装出来”。Dubbo Triple 则更显式地沿用前面两篇已经讲过的 `Http2FrameCodec`、`Http2MultiplexHandler` 和 pipeline 组合方式。

这一点从 `GrpcHttp2Protocol` 就能看出来：这个类本身几乎什么都没做，只是继承了 `TripleHttp2Protocol`，见 `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/GrpcHttp2Protocol.java:19`。这说明在 Dubbo Triple 语境里，“gRPC over HTTP/2”不是完全独立的传输世界，而是 Triple HTTP/2 协议线的一个变体入口。

真正的装配点是 `TripleHttp2Protocol`。在 client pipeline 里，它会先创建一个 `Http2Connection`，再用 `TripleHttp2FrameCodecBuilder.fromConnection(connection)` 构建 `Http2FrameCodec`，随后依次加入 `Http2MultiplexHandler`、`TriplePingPongHandler`、`TripleGoAwayHandler` 和 `TripleTailHandler` 等 handler，见 `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:104`。

这条 client 组装线几乎是在明着复用前一篇的 API 层总图：

- `Http2FrameCodec`：把 wire frame 变成对象流；
- `Http2MultiplexHandler`：把 stream 投影成 child channel；
- ping/goaway/tail handlers：在这个 API 层语义上再补 Triple 自己的 transport 边界。

它没有像 gRPC 那样把很多 transport 语义更多地收在一个大 handler 里，而是更倾向于用 pipeline 组合的方式，把“HTTP/2 基础层”和“Triple transport 语义层”显式串起来。

所以如果说 gRPC 更像是“在 `Http2ConnectionHandler` 主链外面包 transport handler”，那 Triple 更像是“在 `FrameCodec + Multiplex` API 层外面拼 transport pipeline”。两者姿态不同，但都没有绕开前面已经分析过的 HTTP/2 运行时结构。

## Dubbo Triple 服务端：同样复用 HTTP/2 主链，但更强调协议选择和 pipeline 组合

服务端路径更能看出 Triple 的风格。`TripleHttp2Protocol.configServerProtocolHandler(...)` 会先根据探测结果区分 HTTP/1.1 与 HTTP/2；若进入 HTTP/2 路径，再创建 `Http2Connection`、`Http2FrameCodec`、`Http2MultiplexHandler`，并组装 `HttpWriteQueueHandler`、`NettyHttp2SettingsHandler`、`FlushConsolidationHandler`、`TripleServerConnectionHandler`、`TripleTailHandler` 等 handler，见 `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:136`、`:236`。

这条服务端路径说明了 Triple 的几个关键特征。

第一，它把协议探测、HTTP/1 升级、HTTP/2 直连、WebSocket 分支都纳入同一条更大的协议选择器里。因此 Triple 的 HTTP/2 不是孤立 transport，而是整个 Dubbo 多协议接入链中的一个重要分支。

第二，一旦确定走 HTTP/2，它并没有自己重写 frame/stream API，而是明确沿用 `Http2FrameCodec` 和 `Http2MultiplexHandler`。也就是说，stream -> child channel 这层语义对 Triple 同样成立。

第三，它还会在 server 侧显式插入 `FlushConsolidationHandler(64, true)`，见 `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:246`。这说明前面我们讲的 write/flush 合并主线，在 Triple 这种上层 RPC 协议里并没有消失，反而被明确当作 transport pipeline 的组成部分来使用。

更关键的是，它还会自定义 local/remote flow controller。`createHttp2ClientConnection(...)` 会把 `TripleHttp2LocalFlowController` 和 `TripleHttp2RemoteFlowController` 挂到 connection 上，见 `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:128`。这说明 Triple 虽然复用了 Netty 的 HTTP/2 总体结构，但在流控策略层仍然会注入自己关心的 transport 语义。

因此，Triple 的服务端姿态可以总结成一句话：**在保留 Netty HTTP/2 frame/stream/API 层主线的前提下，用更显式的 pipeline 组合方式接入协议探测、settings、flush、连接事件和自定义流控。**

## `TripleInvoker` 说明：RPC 调用最终还是要落到 HTTP/2 stream 和写队列上

如果还想更进一步看“方法调用”究竟怎样变成 HTTP/2 运行时动作，`TripleInvoker` 是最好的入口。

它的字段已经很能说明问题：`AbstractConnectionClient`、`TripleWriteQueue`、`ThreadlessExecutor`、`streamExecutor`、`TripleClientCall`、`RequestMetadata` 全部都站在“方法调用”和“连接写出”之间，见 `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleInvoker.java:91`。

`doInvoke(...)` 里首先检查连接是否可用；随后根据方法描述符和调用模式，构造 `TripleClientCall`，同步 unary 走 `ThreadlessExecutor`，streaming 则走 `streamExecutor`，见 `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleInvoker.java:143`、`:171`。这说明 Triple 的“同步调用”和“流式调用”在 transport 上并不是简单地共享一条阻塞语义，而是显式挂到不同执行策略上。

更关键的是，这里从来没有出现“直接写一个字节数组到 socket”。相反，`TripleInvoker` 会先构造 `RequestMetadata`、`TripleClientCall` 和写队列，再根据 unary/server stream/client stream/bi stream 走不同调用分支，见 `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleInvoker.java:178`。

这说明一件非常关键的事：**RPC 调用在这里虽然已经是 Dubbo 自己的业务模型，但 transport 层仍然是 stream、metadata、write queue、observer 和异步执行器的组合。**也就是说，Triple 并没有把前面 HTTP/2 API 和连接主链抹成一个“发字节”黑箱，而是继续在那条 stream/write 语义之上构建自己的调用模型。

所以不论是 gRPC 的 `StreamObserver`，还是 Triple 的 `Invoker + TripleClientCall + TripleWriteQueue`，它们最后都在做同一类事情：把方法调用语义翻译成一条条 HTTP/2 stream 上的 headers/data/write/close 动作，再交回前面已经分析过的连接主链与 API 层去推进。

## 对照收束：gRPC 与 Triple 分别复用了哪一层

走到这里，可以把两条线并排摆在一起了。

### gRPC 更贴近连接级 transport handler 封装

- 它直接以 `GrpcHttp2ConnectionHandler` 继承/包装 `Http2ConnectionHandler`；
- `NettyServerHandler`、`NettyClientHandler` 自己构造 connection、reader、writer、flow controller 和 transport listener；
- keepalive、authority、channelz/security、transport tracer 等 RPC transport 语义主要围绕连接 handler 这层聚合。

也就是说，gRPC 更像是在**连接主链**之上加 transport 语义外壳。

### Triple 更贴近 API 层与 pipeline 组合封装

- 它更显式地沿用 `Http2FrameCodec`、`Http2MultiplexHandler`、`FlushConsolidationHandler`、settings handler、protocol selector；
- `TripleHttp2Protocol` 负责把 HTTP/2 分支纳入更大的协议探测与 pipeline 组合体系；
- `TripleInvoker` 再把 Dubbo 调用语义挂到 `TripleClientCall`、`TripleWriteQueue` 和 stream 模型上。

也就是说，Triple 更像是在**FrameCodec + Multiplex API 层**之上再拼 transport 与调用语义。

但这两条路无论姿态如何不同，本质都没有绕开前面三篇已经讲清楚的 HTTP/2 主线：

- stream 仍然是基本隔离单位；
- flow control 仍然约束写入节奏；
- GOAWAY、RST、close 仍然是边界事件；
- write queue、flush、writability 仍然决定数据何时下沉；
- ownership 和引用计数责任仍然留在对象路径上。

所以 gRPC 和 Triple 的差别，主要不是“谁更底层”，而是“谁更偏连接 handler 封装，谁更偏 pipeline/API 组合”。

## 收网：RPC 不是跳过 HTTP/2，而是把方法语义压到已有的 stream 与连接主链上

现在可以把整条桥接主线收回来。

- gRPC 通过 `GrpcHttp2ConnectionHandler`、`NettyServerHandler`、`NettyClientHandler`，把 metadata、authority、keepalive、transport listener、状态和 tracing 附着到 `Http2ConnectionHandler` 这条连接主链上。  
- Dubbo Triple 通过 `TripleHttp2Protocol`、`Http2FrameCodec`、`Http2MultiplexHandler`、`FlushConsolidationHandler`、自定义 flow controller、`TripleInvoker` 和 `TripleWriteQueue`，把协议选择、stream API 和调用模型串成一条 transport 组合链。  
- 两者都没有跳过 HTTP/2 的 stream、flow control、GOAWAY、write/flush、ownership 和关闭语义；它们只是把“方法调用 / observer / invoker / metadata”这层 RPC 语言，压到前面已经建立好的 Netty HTTP/2 API 与连接主链之上。

所以本篇真正要留下来的心智模型是：**RPC 框架不是替换掉 HTTP/2，而是把自己的方法语义翻译到现有的 frame、stream、child channel、connection handler 和 write queue 主链上。**

有了这层理解，后面再去看 gRPC streaming、Dubbo Triple unary/streaming、transport listener 或更具体的协议细节，就不会再把它们看成“RPC 自己的神秘世界”。它们只是站在 Netty 已经准备好的 HTTP/2 运行时骨架上，再往上搭的最后一层桥。