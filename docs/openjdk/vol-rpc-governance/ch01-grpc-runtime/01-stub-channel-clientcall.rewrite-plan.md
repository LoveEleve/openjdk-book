# gRPC-Java：Stub、Channel 与 ClientCall 调用主线 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch01-grpc-runtime`
- 篇：`01 Stub、Channel 与 ClientCall 调用主线`
- 对应主题：`G-RPC-1 调用入口与客户端运行时`
- 文章类型：RPC 运行时基线篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：平时写 gRPC 客户端时，我们看到的是 `stub.someRpc(request)` 这种本地方法调用；它到底在哪一刻摆脱了“Java 普通方法”的外观，开始变成一条真正要发往远端的 RPC？
- 一句话顿悟：`Stub` 并不是一句“动态代理”就能打发掉的外壳，它真正做的事情，是把方法描述、调用选项和调用方式收束成一次 `ClientCall`；而 `ManagedChannel` 负责把这次调用接到通道运行时上，`ClientCallImpl` 则把它推进到真正的 `ClientStream` 与 transport 出口。
- 文章边界：本篇只建立客户端 unary 调用的最短闭环，重点解释 `AbstractStub / ClientCalls / ManagedChannel / ClientCall / ClientCallImpl` 的职责拼接；只把 transport 当作出口桥接，不完整展开 Netty HTTP/2、NameResolver、LoadBalancer、Context、Deadline、服务端主线与四种流式调用全景。

## 前置依赖

### HARD

- `vol-netty/ch12-http2/02-framecodec-and-multiplex.md`：已经知道 HTTP/2 API 层如何把 stream 暴露为更可编程的对象。
- `vol-netty/ch12-http2/03-connection-encoder-decoder.md`：已经知道 HTTP/2 连接主链、写出与流控地基。
- `vol-netty/ch12-http2/04-grpc-and-triple-on-http2.md`：已经建立“gRPC 最终仍然落在 Netty HTTP/2 主线之上”的桥接认知。
- Promise/Future 基础：至少知道同步等待、回调与 Future 三种收敛方式的差别。

### SOFT

- `Context / Deadline` 只作为后续横切面提示，不作为本篇硬前置。
- `NameResolver / LoadBalancer` 只在解释 `ManagedChannel` 不是裸 socket 时点到，不展开。

### NAV

- 后续第二篇：`gRPC-Java：ServerCall、ServerCalls 与流式调用模型`
- 后续第三篇：`gRPC-Java：拦截器、上下文传播与 Deadline`
- 后续第四篇：`gRPC-Java：NameResolver、LoadBalancer 与 Netty Transport`

## 一句话困惑

为什么一个看起来像本地 Java 方法的 `stub.method(request)`，最后会变成一次远程 RPC，而不是停留在“代理对象帮你转发了一下”这种过于含糊的描述里？

## 一句话顿悟

gRPC 客户端真正的统一运行时入口不是 `Stub` 本身，而是 `ClientCall`：`Stub` 只保存 `Channel + CallOptions`，`ClientCalls` 负责把不同调用习惯标准化，`ManagedChannel` 负责创建这次调用，`ClientCallImpl` 再把它压成真正的 `ClientStream` 并交给 transport。

## 读者理解路径

1. 先否定“gRPC 客户端 = 一个动态代理”这种过于粗糙的说法。
2. 再建立最小总图：`Stub 持参 -> ClientCalls 选调用范式 -> ManagedChannel.newCall() -> ClientCall.start() -> ClientStream`。
3. 解释 `AbstractStub` 为什么几乎不做业务逻辑，却是调用入口不可替代的一层：它保管 `Channel` 与不可变 `CallOptions`。
4. 解释 `ClientCalls` 为什么存在：不是重复包装，而是把 blocking / future / async 这些调用习惯统一压到同一条 `ClientCall` 语义线上。
5. 解释 `ManagedChannel` 为什么不是“连到服务器的对象”这么简单，而是客户端运行时总入口；同时控制篇幅，不把发现与负载均衡提前吃进来。
6. 解释 `ClientCallImpl.start()` 为什么才是“远程调用真正开始发生”的关键切点：headers、compressor、deadline、listener、stream 都在这里落位。
7. 最后只把 transport 当作出口收束：从这里往后，调用已经进入前面 Netty HTTP/2 篇章讲过的世界。

## 失败方案推演

### 失败方案一：把 Stub 直接讲成“动态代理”就结束

- 这只能回答“看起来为什么像本地方法”，答不了：
- 调用选项放在哪
- unary / future / async 三种调用习惯如何统一
- 真正的远程调用对象何时创建
- 为什么后续拦截器、deadline、流控都能挂进来
- 本篇必须明确指出：即使生成代码里存在“方法外观”，真正值得建立基线的是 `Stub -> ClientCalls -> ClientCall` 这条运行时链，而不是“代理”二字。

### 失败方案二：直接从 Netty transport 讲起

- 这会把读者的视角一下子拉到太底层。
- 读者此刻真正想问的不是“HTTP/2 帧怎么发”，而是“本地方法调用何时变成统一 RPC 调用对象”。
- 如果一上来就讲 `ClientTransport.newStream()`，会跳过最关键的客户端运行时桥：`ClientCalls` 和 `ClientCallImpl`。

### 失败方案三：把 blocking、future、async 混成“只是返回值不同”

- 这会低估 `ClientCalls` 的作用。
- 三种风格确实共享同一条底层调用线，但它们并不是简单换个返回类型：
- blocking 需要 `ThreadlessExecutor` 在等待期间帮忙排空回调任务
- future 需要 `GrpcFuture` 与 `UnaryStreamToFuture` 把 listener 事件收束为 future
- async 则直接把 `ClientCall.Listener` 适配成 `StreamObserver`
- 本篇必须把“不同表面 API，统一底层 `ClientCall`”讲透。

### 失败方案四：第一篇同时吞下 NameResolver、LoadBalancer、服务端和流式调用

- 这会把“最短闭环”重新写成“仓库总览”。
- `ManagedChannel` 的确连接到解析、选址和 transport，但第一篇只需要知道它是客户端运行时总入口，不需要在这里把 `SubchannelPicker`、`ServerCall`、`StreamObserver` 全量展开。

## 必须澄清的误解

1. `Stub` 不是“远程代理”四个字就讲完的概念，它本质上是 `Channel + CallOptions` 的不可变调用入口容器。
2. `ClientCalls` 不是可有可无的工具类，它承担了把多种调用范式统一到 `ClientCall` 语义上的职责。
3. `ManagedChannel` 在这里不等于“一条 TCP 连接”，它是客户端调用总入口，真正连接管理与解析细节留到后续篇章。
4. `ClientCall.start()` 才是远程调用真正开始落地的关键切点；在这之前，大量信息仍只是“调用描述”。
5. 本篇解释 unary 最短闭环，不等于 gRPC 只有 unary；只是为了先把最稳的运行时基线立住。

## 文章结构与字数预算

1. 困惑开场：为什么 `stub.method(request)` 不能只用“代理”二字带过（800-1000 字）
2. 最小总图：从 Stub 到 ClientStream 的客户端调用闭环（1200-1600 字）
3. `AbstractStub`：为什么它几乎不发 RPC，却必须站在最前面（1400-1800 字）
4. `ClientCalls`：三种调用风格怎样被标准化到 `ClientCall`（1800-2400 字）
5. `ManagedChannel.newCall()`：客户端运行时入口在哪里真正接管调用（1600-2200 字）
6. `ClientCallImpl.start()`：headers、deadline、listener、stream 怎样一起落位（2200-2800 字）
7. transport 出口桥接：为什么这里就足够接到 Netty HTTP/2 主线（800-1200 字）
8. 收网总结：第一篇只需要记住哪四层职责（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

写正文时必须重新逐条核验：

- `stub/src/main/java/io/grpc/stub/AbstractStub.java:38`
- `stub/src/main/java/io/grpc/stub/AbstractStub.java:55`
- `stub/src/main/java/io/grpc/stub/AbstractStub.java:105`
- `stub/src/main/java/io/grpc/stub/AbstractStub.java:141`
- `stub/src/main/java/io/grpc/stub/AbstractStub.java:215`
- `stub/src/main/java/io/grpc/stub/AbstractBlockingStub.java:62`
- `stub/src/main/java/io/grpc/stub/AbstractAsyncStub.java:61`
- `stub/src/main/java/io/grpc/stub/AbstractFutureStub.java:62`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:58`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:155`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:157`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:159`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:321`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:407`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:432`
- `api/src/main/java/io/grpc/ManagedChannel.java:22`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:809`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:838`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:864`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:899`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1049`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1103`
- `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:461`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:72`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:97`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:131`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:181`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:188`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:242`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:250`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:286`
- `core/src/main/java/io/grpc/internal/ClientTransport.java:28`
- `core/src/main/java/io/grpc/internal/ClientTransport.java:56`

## 测试证据清单

- `stub/src/test/java/io/grpc/stub/AbstractStubTest.java:45`：默认 stub 不强塞 stub type。
- `stub/src/test/java/io/grpc/stub/BaseAbstractStubTest.java:71`：`withWaitForReady()` 等不可变配置改写行为。
- `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:126`：blocking unary 最短成功闭环。
- `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:145`：blocking unary 失败如何回到 `StatusRuntimeException`。
- `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:167`：经由真实 in-process channel 的 unary 闭环。
- `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:195`：线程中断后仍等待 `onClose()` 收尾。
- `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:273`：blocking stub type 会被写入 `CallOptions`。
- `stub/src/test/java/io/grpc/stub/ClientCallsTest.java:317`：future unary 调用的收束方式。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:487`：deadline 过期时新调用直接失败。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:500`：调用可先于 name resolution 创建，后续通过 pending call 重处理。
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:565`：config selector 可在 `start()` 时改写调用行为。
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:781`：deadline 已经过期时不会真正创建 stream。
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:809`：context deadline 会传给 stream。
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:909`：运行中的 deadline 到期会取消 stream。

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讨论的是 Java 客户端运行时抽象，不把生成代码模板细节写成主线。
- `ManagedChannelImpl` 当前实现包含 config selector、pending call、retry/hedging 等机制；本篇只在不破坏主线的范围内点到，不展开成独立专题。
- transport 出口只桥接到 `ClientTransport.newStream()` 这一层，不把 Netty handler、HTTP/2 frame、流控细节重新展开。

## 与其他篇的边界

### 本篇要讲清

- `Stub` 持有什么，为什么是不可变入口。
- `ClientCalls` 如何把调用风格标准化。
- `ManagedChannel.newCall()` 与 `ManagedChannelImpl` 在哪里接管调用。
- `ClientCallImpl.start()` 如何让“调用描述”真正进入 transport 之前的统一抽象。
- unary 最短闭环为什么足以充当整组主题的 RPC 运行时基线。

### 本篇不深讲

- 代码生成器如何产出具体 stub 方法。
- 服务端 `ServerCall / ServerCalls` 运行时。
- 四种流式调用的完整对照。
- `Context / Deadline` 的语义体系化分析。
- `NameResolver / LoadBalancer / SubchannelPicker` 细节。
- Netty transport / HTTP/2 帧发送全链路。
- Dubbo / Feign 横向对照。

## 写作后检查

- [ ] 开篇先抓住“为什么不能只说代理”，而不是直接列类名。
- [ ] 至少展开 3 个失败方案，且包含“只讲动态代理”和“直接从 transport 讲起”。
- [ ] 明确给出 `Stub -> ClientCalls -> ManagedChannel -> ClientCallImpl -> ClientTransport` 文字总图。
- [ ] 不把 `ManagedChannel` 写成发现与负载均衡总览。
- [ ] 不把第一篇写成客户端、服务端、流式和 transport 的大杂烩。
- [ ] 删除代码块后，读者仍能复述 unary 最短闭环。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。
