# 为什么一次 RPC 到了服务端之后，不是“直接调业务方法”：gRPC-Java 的 ServerCall、ServerCalls 与流式调用模型

> 本文基于 `grpc-java v1.83.1` 当前源码。上一篇《Stub、Channel 与 ClientCall 调用主线》已经把客户端那边如何把一次 RPC 压成 `ClientCall` 和 stream 立住了；本文继续接这条主线，只讲它到了服务端之后，是怎样被接住、切到应用线程、分发到业务实现，并最终变成 unary、server streaming、client streaming、bidi streaming 这四种不同交互模型的。重点放在 `ServerImpl`、`ServerCallImpl`、`ServerCalls`、`StreamObserver` 这几层如何接力；Netty transport 只作为已存在的 stream 入口背景，拦截器整链、Context/Deadline 专题和服务发现/负载均衡都后移。

## 为什么服务端不能只理解成“框架收到请求，然后直接调业务方法”

很多人第一次看 gRPC 服务端时，脑子里会有一个非常自然的简化模型：

- 客户端发来一个请求
- 服务端框架把它反序列化
- 然后直接回调你实现的业务方法
- 业务方法返回结果或往 `responseObserver` 里塞消息

这套说法比“动态代理”那类客户端口号稍微具体一点，但它仍然远远不够。

因为只要你稍微把问题问得再细一点，这个模型立刻就会塌。

比如：

- transport 线程收到 stream 之后，为什么不是立刻就调用业务代码？
- method lookup、fallback lookup、`UNIMPLEMENTED` 到底在哪一层发生？
- 为什么还要先构造 `ServerCallImpl`，而不是直接把 `StreamObserver` 交给业务实现？
- unary 和 server streaming 明明都是“客户端只发一个请求”，为什么它们的服务端处理模型和 client streaming / bidi streaming 仍然有本质差异？
- 为什么 unary 的真正业务 `invoke()` 要等到 `onHalfClose()` 之后，而不是收到第一条消息时立刻调用？
- 为什么有的模式是先把 request 交给业务方法，有的模式却是先把 responseObserver 交给业务方法，再让它返回 requestObserver？
- 为什么取消、`onReady`、auto-request、`onClose` handler 这些边界，全都和 `StreamObserver` 扯在一起？

如果这些问题都答不上来，“收到请求然后调业务方法”就只是结果，不是运行时解释。

更关键的是，服务端真正要解决的问题，从来都不只是“把某个 Java 方法调起来”，而是：

- transport 里来了一条 stream
- 它要被接进服务端运行时
- 要找到对应方法
- 要建立一次受约束的服务端调用语义
- 要根据方法类型选择不同的请求交付与回包模型
- 最后还要把取消、关闭、流控这些边界和应用回调统一起来

也就是说，服务端真正需要建立的是一条运行时主线，而不是一个“最后调到了业务方法”的终点截图。

如果先把最小总图压缩一下，它其实长这样：

```text
transport stream
  -> ServerImpl.streamCreated()
  -> MethodLookup / HandleServerCall
  -> ServerCallImpl
  -> ServerCalls
  -> StreamObserver / ServerCall.Listener
```

这条线一旦立住，后面你再看：

- 为什么 `ServerImpl` 既要做方法查找，又要做线程切换
- 为什么 `ServerCallImpl` 会管 headers、message、close、cancel
- 为什么 `ServerCalls` 要存在
- 为什么四种调用模式不是 unary 的简单放大
- 为什么 `StreamObserver` 在服务端的地位远远不只是“回调接口”

整个服务端运行时就不再像一坨模糊的框架行为，而是一条角色分工清晰的调用链。

所以本文真正要回答的问题不是“服务端会不会回调业务方法”，而是：

**为什么一次 RPC 到了服务端之后，要先经过 `ServerImpl`、`ServerCallImpl`、`ServerCalls` 和 `StreamObserver` 这几层，才能真正变成四种稳定的调用模型。**

## 先看失败方案：为什么这件事不能只按表面现象讲

### 失败方案一：只讲“收到请求后直接调用业务方法”

这是最容易出现的服务端误解。

因为从业务代码角度看，你最后看到的确实往往只是：

- 你实现了一个服务方法
- gRPC 在某个时刻调到了它

于是就很容易把服务端全貌压缩成：

- “框架做了反序列化，然后帮我调方法。”

问题在于，这种讲法把最有价值的运行时结构全擦掉了。

它解释不了：

- stream 是怎么从 transport 世界切进应用线程的
- 方法查找失败时，为什么可以不进业务实现就直接 `UNIMPLEMENTED`
- 为什么 service method 前面还要站着 `ServerCallImpl`
- 为什么真正的请求交付时机要受 `halfClose` 和消息模式约束
- 为什么取消和 `onReady` 不是 transport 私事，而会进入应用回调边界

如果只停在“最后调到了方法”，读者脑子里就会完全没有中间层。

而 gRPC 服务端真正值钱的地方，恰恰就在中间这几层运行时桥接。

### 失败方案二：四种调用模式只是 unary 多几次 `onNext`

这也是一个非常顽固的误解。

因为表面上看，四种模式都绕不开 `StreamObserver`：

- unary：最多一问一答
- server streaming：一问多答
- client streaming：多问一答
- bidi streaming：多问多答

于是很容易得出一个错误结论：

- “本质上都一样，只是有的模式多调几次 `onNext`。”

这个理解会错过四种模式之间最关键的结构差异。

真正的区别根本不只在消息条数，而在：

- 请求什么时候算真正完整
- 业务方法是什么时候被调用的
- 服务端手里先拿到的是 request，还是 request-side `StreamObserver`
- auto-request 和 `halfClose` 的职责边界是什么
- 应用侧是一次性处理请求，还是渐进式消费请求

尤其是这条边界非常关键：

- unary / server streaming：客户端只应发一个请求，因此服务端要先把这个请求收稳，并等到 `onHalfClose()` 确认请求侧结束，才真正调用业务方法
- client streaming / bidi streaming：服务端必须先把 request-side `StreamObserver` 交给业务代码，让它在后续多条消息到来时持续消费

这不是“多发几条消息”，而是交互协议根本不一样。

### 失败方案三：`StreamObserver` 只是个普通回调接口

如果只看接口定义，`StreamObserver` 似乎很朴素：

- `onNext`
- `onError`
- `onCompleted`

于是很容易把它理解成一个语法上的回调容器。

可在 gRPC 服务端运行时里，它远不只是“回调接口”这么简单。

因为它还连着很多真正的运行时边界：

- `ServerCallStreamObserver`
- onReady / onCancel / onClose handler
- auto inbound flow control
- 取消后的异常语义
- 服务端发送 headers / message / close 的时机约束

也就是说，`StreamObserver` 在这里是应用看见的 API 外表，但背后其实吊着一整套服务端调用语义。

如果把它降格成普通回调，后面很多设计都会看不懂：

- 为什么 handler 只能在初始化阶段设置
- 为什么取消后 streaming `onNext` 会抛异常
- 为什么 unary 自动 request 2 条
- 为什么 `halfClose` 对 unary 至关重要

### 失败方案四：第二篇可以顺手把 transport、拦截器、Context 全讲了

这是一种结构性失败，不是事实性失败。

因为服务端这一篇天然很容易越讲越散：

- `ServerImpl` 连着 transport
- `ServerCallImpl` 连着 headers / cancel / close
- `wrapMethod()` 连着 interceptor
- `createContext()` 连着 timeout / deadline
- `JumpToApplicationThreadServerStreamListener` 又连着线程模型

如果在第二篇里一口气把这些线全吞进去，这篇文章就会再次退化成“仓库总览”。

所以这里必须继续强制收边界：

- 本篇只回答“服务端怎样接住一次 RPC，以及四种模式为什么交互不同”
- transport 只作为入口背景
- 拦截器和 Context/Deadline 只点到，不展开
- 重点压在 `ServerImpl -> ServerCallImpl -> ServerCalls -> StreamObserver`

也就是说，这篇不是为了把 gRPC 服务端所有东西一次讲完，而是为了先立住 **服务端调用运行时基线**。

## 先立最小总图：transport stream 是怎样走进服务端运行时的

如果先不抠细节，服务端最值得先记住的，不是某个具体方法，而是调用角色是怎样逐层交棒的。

最小总图可以先写成这样：

```text
transport stream created
  -> ServerImpl.ServerTransportListenerImpl.streamCreated()
  -> method lookup / context creation / application-thread jump
  -> ServerCallImpl
  -> ServerCallHandler.startCall(...)
  -> ServerCalls adapts method shape
  -> ServerCall.Listener or request-side StreamObserver callbacks
```

如果换成人话，这条线其实只发生了五件事。

第一，**transport 世界先承认“有一条新的 RPC stream 进来了”**。

第二，**服务端运行时要先决定这条 stream 对应哪个方法、在哪个线程上继续跑，以及它的上下文和 tracing 怎么挂起来**。

第三，**gRPC 需要先把这条 stream 包装成一个统一的服务端调用对象**，也就是 `ServerCallImpl`。

第四，**这个统一调用对象不能直接暴露给业务方法，而要按方法类型进一步适配**。因为 unary、server streaming、client streaming、bidi streaming 的请求交付方式根本不一样。

第五，**应用真正接触到的，是 `ServerCall.Listener` / `StreamObserver` 这层交互面；而消息、取消、关闭、流控的很多边界，都要从这里兑现。**

所以本文后面虽然会反复提到 `ServerImpl`、`ServerCallImpl`、`ServerCalls` 和 `StreamObserver`，但先记住一点：

- 它们不是并列知识点
- 它们是在同一条服务端调用主线上逐层收束

也就是说，服务端不是“请求来了 -> 方法被调”，而是：

- transport stream 被接住
- 服务端运行时完成查找和切线程
- `ServerCallImpl` 建立统一调用语义
- `ServerCalls` 决定四种模式如何适配
- 应用再通过 listener / observer 真正参与交互

先有这张图，后面再落细节，四种调用模式才不会被讲成零散 API。

## 第一层：`ServerImpl` 为什么不是壳，而是 transport stream 进入应用世界的桥

如果只看名字，`ServerImpl` 很容易被误解成“server 生命周期管理器”。

它当然承担 server 的 start / shutdown / termination 之类职责，但对服务端运行时主线来说，它真正关键的地方在于：

- 它是 transport stream 进入应用世界的第一层桥

这个判断最直接的入口，就是 `ServerListenerImpl.transportCreated(...)` 和 `ServerTransportListenerImpl`。

当 transport 被创建时，`ServerImpl` 会生成一个 `ServerTransportListenerImpl`，见 `core/src/main/java/io/grpc/internal/ServerImpl.java:369`、`:410`。

这说明 gRPC 服务端并不是等“某个具体 RPC 方法被调”时才开始进入运行时，而是在 transport 层一出现时，就已经开始布置服务端接入点了。

### 真正的入口切点：`streamCreated()`

服务端主线真正开始明显变得具体，是在：

- `ServerTransportListenerImpl.streamCreated(...)`

证据：`core/src/main/java/io/grpc/internal/ServerImpl.java:465`

这一步很重要，因为它揭示了服务端的真实入口单位不是“一个方法调用”，而是：

- 一条新的 `ServerStream`

也就是说，客户端那边最后落到的是 `ClientStream`；服务端这边接住的也是 stream。业务方法只是这条 stream 在应用语义里的后续翻译结果。

所以服务端运行时的第一步不是“直接调方法”，而是：

- 先接住 transport stream
- 再决定这条 stream 对应什么调用语义

这与上一篇客户端基线篇的收束方式正好镜像：

- 客户端：本地方法先被压成统一调用对象，再压到 stream
- 服务端：transport stream 先被接住，再被抬升成统一调用对象和业务交互模型

如果把前面的 Netty HTTP/2 前置篇也一起带上，就能把整条 RPC 主线连成一句更完整的话：前置篇已经解释了 gRPC 最终怎样落在 HTTP/2 stream 上，第一篇解释了客户端怎样把本地方法压到这条 stream 上，而这一篇解释的，则是服务端怎样把这条已经到达的 stream 再抬升成应用可理解的调用模型。

### 线程切换不是附属细节，而是 `ServerImpl` 的硬职责

`streamCreatedInternal(...)` 一上来先干的一件大事，就是准备 `wrappedExecutor`。

如果不是直连最优路径，它会用 `SerializingExecutor`；如果是 direct executor 场景，则尽量走更轻量的 `SerializeReentrantCallsDirectExecutor`，必要时还会让 stream `optimizeForDirectExecutor()`，见 `core/src/main/java/io/grpc/internal/ServerImpl.java:475`。

这说明：

- transport 收到 stream，并不意味着业务代码可以立刻在当前线程上乱跑
- gRPC 服务端必须先决定，这条调用后续的回调应该在什么执行模型里继续推进

也就是说，线程切换在服务端不是补充细节，而是调用模型的一部分。

如果没有这层桥，后面你看到的：

- method lookup
- application callback
- listener 事件回调
- cancel / close 收尾

全都会直接暴露在 transport 线程边界上，整个模型会很难稳定。

### 方法查找和 `UNIMPLEMENTED` 为什么必须发生在业务方法之前

继续往下看，`ServerImpl` 还会在 `MethodLookup` 里做 method lookup。

它先查 `registry.lookupMethod(methodName, null)`，找不到再走 `fallbackRegistry.lookupMethod(...)`；如果还找不到，就直接返回 `UNIMPLEMENTED`，设置 `NOOP_LISTENER`、关闭 stream、取消 context，并且根本不进入业务实现，见 `core/src/main/java/io/grpc/internal/ServerImpl.java:501`、`:524`。

这一步说明了一个极其重要的服务端事实：

- “有没有业务方法可以调”不是业务实现内部问题，而是服务端运行时入口问题

也就是说，方法查找失败不是一种业务异常，而是一次调用甚至还没资格进入应用代码。

这也解释了为什么服务端不能简单理解成“请求进来直接调方法”。

因为在真正有资格调方法之前，gRPC 还要先回答：

- 你要调的方法到底存在不存在？
- 如果不存在，是不是应该在运行时边界就直接挡回去？

### `JumpToApplicationThreadServerStreamListener` 说明服务端先搭桥，再交应用

`ServerImpl` 还有一个非常关键但容易被忽略的角色：

- `JumpToApplicationThreadServerStreamListener`

它会先被设到 stream 上，见 `core/src/main/java/io/grpc/internal/ServerImpl.java:510`。

这一步非常能说明服务端的设计哲学：

- 真正的业务 listener 还没准备好之前，transport 回调不能直接撞进应用代码
- 先要有一个桥接 listener，把 transport 侧事件安全地跳到应用线程世界

也就是说，服务端并不是“方法先有，stream 后有”，而是：

- stream 先接进来
- 运行时桥先搭好
- 业务 listener 之后才被正式接上去

这与很多人脑中的“框架只是在某个时刻帮我调个方法”已经是完全不同的世界了。

### `ServerCallImpl` 在 `ServerImpl` 里被构造，说明服务端调用语义先于具体模式适配

`MethodLookup.maySwitchExecutor(...)` 里还有一步对本文尤其关键：

它会先构造 `ServerCallImpl`，再把它和 `ServerCallHandler` 打包成 `ServerCallParameters`，见 `core/src/main/java/io/grpc/internal/ServerImpl.java:579`。

这一步必须先记住。

因为它说明 gRPC 服务端运行时的顺序是：

- 先有一套统一的服务端调用语义对象
- 再由更上层的 `ServerCallHandler` / `ServerCalls` 按方法类型去适配不同调用模型

也就是说，四种调用模式是建立在统一服务端调用语义之上的，不是各自直接从 transport 长出来的。

### `HandleServerCall` 才真正把调用推进到业务 handler 世界

之后 `HandleServerCall.runInternal()` 会调用 `startWrappedCall(...)`，也就是：

- `params.callHandler.startCall(params.call, headers)`

见：`core/src/main/java/io/grpc/internal/ServerImpl.java:598`、`:689`

这一步才是“业务 handler 世界开始接手”的真正切点。

所以到这里为止，`ServerImpl` 已经完成了它最关键的职责：

- 接住 transport stream
- 切进应用线程模型
- 完成方法查找和兜底
- 创建统一的 `ServerCallImpl`
- 再把它安全地推给 `ServerCallHandler`

这和“server 只是个壳”完全不是一回事。

所以第一层先收一句：

- `ServerImpl` 不是单纯 server 容器，而是 transport stream 进入应用运行时的总桥

再往下，服务端统一调用语义真正长在 `ServerCallImpl` 上。

## 第二层：`ServerCallImpl` 为什么不是 response wrapper，而是服务端统一调用语义

很多人第一次看 `ServerCallImpl`，会把它粗暴地理解成：

- “服务端拿来写响应的一个包装器。”

这会把它的职责压得太扁。

类开头已经把几个状态直接摊出来了：

- `stream`
- `method`
- `context`
- `messageAcceptEncoding`
- `cancelled`
- `sendHeadersCalled`
- `closeCalled`
- `messageSent`

见：`core/src/main/java/io/grpc/internal/ServerCallImpl.java:52`

这说明 `ServerCallImpl` 管的远不只是“发响应”这一件事，而是一整套服务端调用语义：

- 请求对应哪个方法
- 调用现在是不是被取消了
- headers 发没发
- call 关没关
- unary/server-sends-one 语义下是不是已经发过响应
- compressor / decompressor 边界怎样落

也就是说，`ServerCallImpl` 是服务端调用统一语义的承载体。

### `sendHeaders()` 说明服务端回包不是“想写就写”，而是受协议约束的

`sendHeadersInternal(...)` 一上来就有两个硬约束：

- `sendHeaders` 不能重复调用
- close 之后不能再发

见：`core/src/main/java/io/grpc/internal/ServerCallImpl.java:101`

接着它会根据 compressor、客户端可接受编码、decompressor registry 来整理 headers，并最终调用：

- `stream.writeHeaders(headers, !getMethodDescriptor().getType().serverSendsOneMessage())`

见：`core/src/main/java/io/grpc/internal/ServerCallImpl.java:145`

这一步说明，服务端回包并不是“业务代码往 observer 里塞数据”这么简单。它前面先有一层统一调用语义在收束：

- 头什么时候可以发
- 压缩是否可用
- 当前方法是不是单响应语义

也就是说，`ServerCallImpl` 把应用的“我要回一个响应”翻译成了一次真正受约束的服务端调用动作。

### `sendMessage()` 说明 single-response 约束是在服务端调用语义层兑现的

`sendMessageInternal(...)` 更能说明这一点。

它会先检查：

- headers 必须已经发过
- call 还没关

然后如果当前方法类型属于 `serverSendsOneMessage()`，且已经发过一次消息，再发第二次就会触发内部错误，直接 cancel stream，见 `core/src/main/java/io/grpc/internal/ServerCallImpl.java:149`。

这一步非常关键。

因为它说明 unary / client-streaming 这种“服务端只应该发一个响应”的规则，并不是业务实现“自觉遵守”而已，而是在服务端统一调用语义层就被卡死了。

这也解释了为什么 streaming 不是 unary 多几次 `onNext`：

- 在 unary / client-streaming 世界里，多发一条响应就是协议错误
- 在 server-streaming / bidi 世界里，多发响应则是合法交互的一部分

这两者不是“数量差异”，而是调用语义差异。

### `close()` 说明“OK 结束但没有响应”同样是协议错误

`closeInternal(...)` 还继续暴露了这种单响应语义。

如果 status 是 OK，但当前方法类型属于 `serverSendsOneMessage()`，且根本没发过响应，那么它会触发 `MISSING_RESPONSE` 错误，而不是老老实实正常关闭，见 `core/src/main/java/io/grpc/internal/ServerCallImpl.java:210`。

这点非常值得强调。

因为它说明：

- 对 unary / client-streaming 来说，“成功结束”不只是状态 OK
- 还必须真的交付过一个响应

也就是说，服务端调用语义里，“一次调用成立”不仅要求请求处理成功，还要求响应形态和方法契约吻合。

### `ServerStreamListenerImpl` 说明服务端 listener 事件也是统一语义的一部分

`ServerCallImpl.newServerStreamListener(...)` 最后会创建一个 `ServerStreamListenerImpl`，见 `core/src/main/java/io/grpc/internal/ServerCallImpl.java:238`、`:287`。

这个内部 listener 很重要，因为它说明 `ServerCallImpl` 还负责把 transport 侧 listener 事件翻译成应用侧的 `ServerCall.Listener` 生命周期：

- `messagesAvailable()` -> `listener.onMessage(...)`
- `halfClosed()` -> `listener.onHalfClose()`
- `closed(Status)` -> `listener.onComplete()` 或 `listener.onCancel()`
- `onReady()` -> `listener.onReady()`

这说明 `ServerCallImpl` 不只是“发响应”的统一语义层，它还站在请求消费与关闭事件的统一边界上。

### 测试怎么证明 `ServerCallImpl` 确实在守服务端契约

`ServerCallImplTest` 在这里给的证据非常强。

`sendMessage_serverSendsOne_closeOnSecondCall_unary()` 以及针对 `CLIENT_STREAMING_METHOD` 的同族测试，证明凡是 `serverSendsOneMessage()` 的方法，多发响应都会触发 `TOO_MANY_RESPONSES`；这里强调的是“单响应方法族约束”，不是在展开 client-streaming 的完整运行时模型，见 `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:229`。

`serverSendsOne_okFailsOnMissingResponse_unary()` 以及针对 `CLIENT_STREAMING_METHOD` 的同族测试，又证明凡是单响应方法，若 OK 结束但没发响应，就会触发 `MISSING_RESPONSE`；这里仍然是在证明 `ServerCallImpl` 的统一契约，而不是把 client-streaming 本身和 unary 混成一套，见 `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:302`。

后面的 `streamListener_*` 系列测试，则证明 `halfClosed / closed / onReady / onMessage` 会被正确分发到应用 listener，并在取消后做短路，见 `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:386`。

所以第二层可以先收一句：

- `ServerCallImpl` 不是 response wrapper，而是服务端统一调用语义和生命周期约束的核心承载体

再往下，真正把它接进四种调用模型的，就是 `ServerCalls`。

## 第三层：`ServerCalls` 为什么不是边角料，而是四种调用模型的核心适配层

很多人在 gRPC 服务端源码里会不自觉低估 `ServerCalls`。

因为它既不在 core 里，也不像 `ServerImpl` 那样一眼看上去就像“运行时中心”。它很容易被误看成 generated code 的配套工具类。

但类注释其实已经说明它的定位：

- 它是把 `ServerCallHandler` 适配到应用服务实现上的工具函数，而且就是给 generated code 用的

证据：`stub/src/main/java/io/grpc/stub/ServerCalls.java:31`

这个定位恰恰很关键。

因为它说明：

- generated service skeleton 本身并不直接拼装四种模式的所有运行时细节
- 真正把四种方法形态统一进服务端运行时的，是 `ServerCalls`

### 四个工厂方法已经先把模式边界明确切开了

`ServerCalls` 一上来就给了四个入口：

- `asyncUnaryCall(...)`
- `asyncServerStreamingCall(...)`
- `asyncClientStreamingCall(...)`
- `asyncBidiStreamingCall(...)`

见：

- `stub/src/main/java/io/grpc/stub/ServerCalls.java:49`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:59`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:69`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:79`

这说明四种模式在运行时入口上就已经被明确区分开了，而不是到更后面才临时判断。

更关键的是，这四个入口并不是四套完全无关的代码，而是被折叠成两大类：

- unary / server streaming -> `UnaryServerCallHandler`
- client streaming / bidi -> `StreamingServerCallHandler`

这个切分非常有启发性。

因为它说明 gRPC 服务端真正最先在意的，不是“响应是一条还是多条”，而是：

- 客户端是不是只会发一个请求

这就是为什么 unary 和 server streaming 被分在一起，而 client streaming 和 bidi 被分在一起。

### `UnaryServerCallHandler`：先收住唯一请求，再等 `halfClose` 触发业务调用

`UnaryServerCallHandler.startCall(...)` 有一个特别值得记住的动作：

- 它先 `call.request(2)`

证据：`stub/src/main/java/io/grpc/stub/ServerCalls.java:124`

这一步一眼看上去很怪：

- 明明 unary / server-streaming 只该有一个请求，为什么要 request 2 条？

答案是：

- 这样如果有不守规矩的客户端发了第二条请求，服务端就能立刻抓到协议违规

也就是说，gRPC 服务端不是简单相信“这个方法按定义只会收到一个请求”，而是在运行时主动把违规入口留出来。

接着更关键的一步是：

- `onMessage()` 先只把请求缓存下来
- 真正的 `method.invoke(request, responseObserver)` 要等到 `onHalfClose()` 才发生

见：`stub/src/main/java/io/grpc/stub/ServerCalls.java:153`、`:170`

这一点太重要了。

因为它说明 unary / server-streaming 的本质不是“第一条消息来了就能直接开始业务处理”，而是：

- 必须等客户端明确 half-close，服务端才认为这次单请求输入已经完整成立

所以在这两种模式里，`halfClose` 不是可有可无的尾声，而是：

- 触发真正业务调用的信号

这就是为什么四种模式绝对不能被讲成“多调几次 `onNext`”。

### `StreamingServerCallHandler`：先把 requestObserver 交给业务，再让消息逐条灌进去

另一边，`StreamingServerCallHandler.startCall(...)` 的结构就完全不一样了。

它会先创建 `ServerCallStreamObserverImpl`，然后立刻调用：

- `StreamObserver<ReqT> requestObserver = method.invoke(responseObserver)`

见：`stub/src/main/java/io/grpc/stub/ServerCalls.java:231`

这说明对于 client-streaming 和 bidi 来说，业务方法不是在“请求已经收全之后”才被调起，而是：

- 它要先返回一个 request-side `StreamObserver`
- 后续每条请求消息再通过 `onMessage()` 渐进式喂给这个 observer

而 `StreamingServerCallListener.onMessage()` 会在每次收到请求时调用：

- `requestObserver.onNext(request)`

必要时还会自动 `call.request(1)` 继续拉下一条消息，见 `stub/src/main/java/io/grpc/stub/ServerCalls.java:260`

这说明 streaming 模型真正重要的不是“消息更多”，而是：

- 服务端和客户端之间形成了一段持续中的交互关系
- 业务代码需要先拿到一个长寿命的 request observer，后续边收边处理

而在 `onHalfClose()` 时，它会调用：

- `requestObserver.onCompleted()`

见：`stub/src/main/java/io/grpc/stub/ServerCalls.java:271`

这再次说明：在 streaming 世界里，`halfClose` 不再是“现在才开始 invoke 业务方法”，而是“请求流已经结束，你的 request observer 可以收尾了”。

这和 unary / server-streaming 的语义已经完全不同。

### `ServerCallStreamObserverImpl`：应用看到的 observer 外表，背后挂着一整套运行时约束

`ServerCalls` 里真正最容易被低估的一层，是 `ServerCallStreamObserverImpl`。

它表面上只是把 `ServerCallStreamObserver` 具体化，但实际上这里挂着很多服务端模型的关键边界：

- `freeze()` 之后不能再改 onReady/onCancel/onClose handler
- `disableAutoRequest()` 只能在初始化阶段调用
- `onNext()` 在 streaming cancel 后可能抛出异常
- 第一次 `onNext()` 前会自动 `sendHeaders()`
- `onError()` / `onCompleted()` 会转成 `call.close(...)`

见：`stub/src/main/java/io/grpc/stub/ServerCalls.java:325`

这说明业务代码眼里拿到的是 observer，但 observer 背后其实吊着一整个服务端调用约束系统。

所以 `StreamObserver` 在服务端不是薄接口，而是应用与运行时交界面的主要外壳。

### 测试怎么证明 `ServerCalls` 的适配层地位

`ServerCallsTest` 在这里给了非常多直接证据。

`runtimeStreamObserverIsServerCallStreamObserver()` 证明运行时交给应用的 `responseObserver` 确实是 `ServerCallStreamObserver`，而且 auto-request 会不断 request 下一条消息，见 `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:86`。

`noCancellationExceptionIfOnCancelHandlerSet()` 与 `expectCancellationExceptionIfOnCancelHandlerNotSet()` 证明取消后的行为并不是统一一刀切，而和是否设置 `onCancelHandler` 有直接关系，见 `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:139`、`:172`。

`cannotSetOnCancelHandlerAfterServiceInvocation()`、`cannotSetOnReadyHandlerAfterServiceInvocation()`、`cannotSetOnCloseHandlerAfterServiceInvocation()` 和 `cannotDisableAutoRequestAfterServiceInvocation()` 证明 observer 初始化之后会被冻结，见 `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:250`。

`disablingInboundAutoRequestSuppressesRequestsForMoreMessages()` 说明 auto-request 确实可以关掉，见 `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:355`。

`disablingInboundAutoRequestForUnaryHasNoEffect()` 则说明 unary 模式仍然会 request 2 条来抓协议违规，见 `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:401`。

`onReadyHandlerCalledForUnaryRequest()` 又说明 unary/server-streaming 的 onReady 不是立即触发，而要等 request 真正交付、half-close 完成后才补偿触发，见 `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:419`。

最后，`clientSendsOne_errorMissingRequest_*` 和 `clientSendsOne_errorTooManyRequests_*` 两组测试，又直接把 unary/server-streaming 的请求契约钉死了，见 `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:480`、`:517`。

所以到第三层可以先收一句：

- `ServerCalls` 不是 generated code 边角料，而是四种服务端调用模型的核心适配层

## 第四层：为什么四种调用模式根本不是“unary 多几次 onNext”

现在可以把前面的结构收成四种模式的真正差别了。

为了不被 API 形状迷惑，最好的拆法不是看“谁发几条消息”，而是看三个问题：

- 业务方法什么时候被调用
- 请求是一次性交付，还是渐进式交付
- `halfClose` 的语义是什么

### unary

在 unary 里：

- 客户端只应发一个请求
- 服务端先缓存这一个请求
- 等 `onHalfClose()` 才真正 `invoke(request, responseObserver)`
- 服务端只应发一个响应

所以 unary 的本质是：

- 单请求先收稳
- 再一次性执行业务逻辑
- 最后只允许单响应完成

### server streaming

server streaming 和 unary 在“请求怎么进入业务代码”这件事上其实是一样的：

- 客户端也只应发一个请求
- 服务端也要等 `onHalfClose()` 后再真正 invoke

它和 unary 的差别，不在请求侧，而只在响应侧：

- unary 只允许一个响应
- server streaming 允许服务端持续多次 `onNext`

所以 server streaming 不是“从头到尾都和 unary 不同”，而是：

- 请求语义仍是 unary
- 响应语义变成 streaming

这也是为什么它和 unary 会共用 `UnaryServerCallHandler`。

### client streaming

client streaming 则反过来了：

- 客户端请求是多条
- 服务端在开始时先返回 request-side `StreamObserver`
- 后续每条消息渐进式交给这个 observer
- `halfClose` 代表请求流结束
- 服务端最终只应回一个响应

所以 client streaming 的本质是：

- 输入端 streaming
- 输出端 single response

这和 unary 相比，已经不是“多几条请求”这么简单，而是业务代码的交互模型变了：

- 它不再一次性拿到请求对象
- 它要逐条消费输入，再在流结束时收口

### bidi streaming

bidi streaming 再进一步：

- 请求侧是 streaming
- 响应侧也是 streaming
- 服务端同样先拿到 request-side observer
- 之后输入输出可以交错推进

这时服务端交互模型已经变成真正的双向流，而不再是“一次请求对应一次业务执行结果”。

所以从服务端运行时角度看，bidi streaming 真正特殊的地方并不是“最多消息更多”，而是：

- 服务端应用与 transport 之间形成了一段持续存在、双向可交错的交互关系

### 四种模式真正的分野线

如果把四种模式重新按运行时结构压缩一下，最该记住的是这条分野线：

```text
Unary / ServerStreaming
  -> client sends one request
  -> invoke only after halfClose
  -> request delivered as a whole

ClientStreaming / BidiStreaming
  -> client may send many requests
  -> invoke returns requestObserver immediately
  -> requests delivered incrementally
```

这才是四种模式的真正差别。

所以“streaming 不是 unary 的简单放大”这句话，翻译成人话就是：

- 不是把响应多发几条这么简单
- 而是请求交付模型、业务进入时机、`halfClose` 语义和 observer 生命周期全都变了

## 第五层：`StreamObserver` 为什么在服务端是交互面，而不只是回调接口

前面已经多次提到 `StreamObserver`，现在可以专门把它收一遍。

接口定义本身其实很朴素：

- `onNext`
- `onError`
- `onCompleted`

见 `stub/src/main/java/io/grpc/stub/StreamObserver.java:20`

但注释里已经明确提醒：

- 它用于所有 method type，包括 unary
- 它不是线程安全的
- API 是异步的
- streaming 场景建议借助 `ClientCallStreamObserver` / `ServerCallStreamObserver` 做流控

见：`stub/src/main/java/io/grpc/stub/StreamObserver.java:22`、`:35`、`:52`

这说明 `StreamObserver` 在 gRPC 里并不是“流式调用专属的小接口”，它是统一交互面。

在服务端，这个统一交互面的意义尤其大：

- unary / server-streaming 的 response side 也是它
- client-streaming / bidi 的 request side 也是它
- 流控、取消、关闭 handler 又进一步通过 `ServerCallStreamObserver` 挂在它的运行时外壳上

也就是说，应用代码看到的虽然是 `StreamObserver`，但真正被框架交付出来的，常常是带着服务端运行时约束的 `ServerCallStreamObserverImpl`。

所以把 `StreamObserver` 仅仅理解成“回调接口”，会把最值钱的那一层应用-运行时边界擦掉。

它在服务端真正扮演的是：

- 四种调用模型共同的应用交互面
- 同时也是流控、取消、关闭和消息交付约束的承载外壳

## 最后把整条服务端主线收回来：一次 RPC 为什么不能跳过这些层直接调业务方法

现在可以把整篇文章的主线收回来了。

如果只记一句最短的人话答案，那就是：

**一次 RPC 到了服务端之后，并不是“框架收到请求，然后直接调业务方法”，而是先由 `ServerImpl` 把 transport stream 接进服务端运行时，再由 `ServerCallImpl` 建立统一调用语义，最后由 `ServerCalls` 按四种模式把它适配成不同的 `StreamObserver` 交互模型。**

把它拆开，就是四层非常稳定的职责分工。

### 第一层：`ServerImpl` 接住 stream，并把它桥到应用线程世界

它负责：

- stream 入口
- 方法查找
- `UNIMPLEMENTED` 兜底
- context 创建
- listener 桥接
- `ServerCallImpl` 构造与 `ServerCallHandler.startCall(...)` 推进

所以它不是生命周期壳，而是服务端运行时总桥。

### 第二层：`ServerCallImpl` 建立统一服务端调用语义

它负责：

- sendHeaders
- sendMessage
- close
- cancel
- single-response 约束
- listener 事件翻译

所以它不是 response wrapper，而是统一调用契约层。

### 第三层：`ServerCalls` 适配四种方法形态

它负责：

- 把 unary / server-streaming 折成“先收住一个请求，再等 halfClose invoke”
- 把 client-streaming / bidi 折成“先返回 requestObserver，再渐进式消费请求流”

所以它不是边角料，而是四种服务端调用模型真正成形的地方。

### 第四层：`StreamObserver` 暴露给应用的统一交互面

它让应用看到的是统一 observer 接口，但背后实际连着：

- onReady
- onCancel
- onClose
- auto-request
- sendHeaders / close 约束
- streaming cancel 语义

所以它不是单纯回调接口，而是运行时边界在应用层的外观。

## 这篇先立住的，不是服务端全景，而是服务端调用运行时基线

到这里为止，这篇文章故意没有展开很多你已经能想到的线：

- 拦截器怎样插在 `wrapMethod()` 上
- Context / Deadline 在服务端怎样传播和取消
- Netty transport 怎样把 stream 交给 `ServerImpl`
- binlog、executorSupplier、压缩与 tracing 怎样继续深入

不是这些不重要，而是第二篇如果不先把服务端调用基线立住，后面所有专题都会变成漂在空中的补丁知识。

所以这篇真正要留下来的心智模型只有一条：

```text
transport stream
  -> ServerImpl 接桥
  -> ServerCallImpl 立统一调用语义
  -> ServerCalls 选交互模型
  -> StreamObserver / Listener 暴露给应用
```

只要这条线立住，后面再看：

- 为什么 unary 要等 `halfClose`
- 为什么 server-streaming 和 unary 是一类
- 为什么 client-streaming / bidi 要先拿 requestObserver
- 为什么取消、流控和 onReady 会和 observer 紧紧绑在一起

整个 gRPC 服务端运行时就不再像一团“框架会帮你处理”的黑箱。

而这，正是客户端基线篇之后，最应该马上建立的第二块地基。