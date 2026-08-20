# gRPC-Java：Stub、Channel 与 ClientCall 调用主线 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `AbstractStub` 当前核心只持有 `channel` 与 `callOptions` 两个入口状态，且类注释明确强调 stub 配置不可变、修改配置会返回新的 stub，证据：`stub/src/main/java/io/grpc/stub/AbstractStub.java:38`、`:55`。  
2. `AbstractStub` 当前通过抽象的 `build(Channel, CallOptions)` 重建具体 stub，`withDeadline(...)`、`withInterceptors(...)` 等入口配置也都走“组合新 `Channel + CallOptions` 再 build”的路径，证据：`stub/src/main/java/io/grpc/stub/AbstractStub.java:105`、`:141`、`:215`。  
3. blocking / async / future 三种 stub 当前分别在 `AbstractBlockingStub.newStub(...)`、`AbstractAsyncStub.newStub(...)`、`AbstractFutureStub.newStub(...)` 中写入 `ClientCalls.STUB_TYPE_OPTION`，证据：`stub/src/main/java/io/grpc/stub/AbstractBlockingStub.java:62`、`stub/src/main/java/io/grpc/stub/AbstractAsyncStub.java:61`、`stub/src/main/java/io/grpc/stub/AbstractFutureStub.java:62`。  
4. `ClientCalls` 当前不是零散便捷函数，而是与生成 stub 可能出现的调用签名一一对应的统一调用适配层，证据：`stub/src/main/java/io/grpc/stub/ClientCalls.java:58`。  
5. `ClientCalls.blockingUnaryCall(ClientCall, ReqT)` 当前先走 `futureUnaryCall(...)` 再 `getUnchecked(...)`，而不是自己单独实现另一套 transport 路径，证据：`stub/src/main/java/io/grpc/stub/ClientCalls.java:140`。  
6. `ClientCalls.blockingUnaryCall(Channel, MethodDescriptor, CallOptions, ReqT)` 当前会创建 `ThreadlessExecutor`、写入 `STUB_TYPE_OPTION=BLOCKING`、再通过 `channel.newCall(...)` 创建 `ClientCall`，证据：`stub/src/main/java/io/grpc/stub/ClientCalls.java:155`、`:157`、`:159`。  
7. `ClientCalls.futureUnaryCall(...)` 当前通过 `GrpcFuture` 与 `UnaryStreamToFuture` 把 listener 事件收束为 future，而 async 风格则通过 `StreamObserverToCallListenerAdapter` / `CallToStreamObserverAdapter` 做 listener 与 observer 互转，证据：`stub/src/main/java/io/grpc/stub/ClientCalls.java:321`、`:443`、`:535`、`:603`。  
8. `ClientCalls.startCall(...)` 当前统一使用 `call.start(responseListener, new Metadata())` + `responseListener.onStart()` 启动 `ClientCall`，证据：`stub/src/main/java/io/grpc/stub/ClientCalls.java:432`。  
9. `ManagedChannel` 抽象当前首先强调的是生命周期管理，而不是“单条连接”，证据：`api/src/main/java/io/grpc/ManagedChannel.java:22`。  
10. `ManagedChannelImpl.newCall(...)` 当前把调用交给 `interceptorChannel.newCall(...)`，再由 `clientCallImplChannel.newCall(...)` 构造 `ClientCallImpl`，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:809`、`:838`。  
11. `RealChannel.newCall(...)` 当前在 config selector 未就绪时会触发 `exitIdleMode()`、可能返回 `PendingCall`，说明调用可先于更下游运行时条件完全就绪而进入系统，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:864`、`:899`。  
12. `newClientCall(...)` 当前会根据 selector 决定是直接创建 `ClientCallImpl` 还是包装为 `ConfigSelectingClientCall`，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:1049`、`:1103`。  
13. `ManagedChannelImpl.ChannelStreamProvider.newStream(...)` 当前负责把 `ClientCallImpl` 往下桥到 delayed transport / retry stream 世界，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:461`。  
14. `ClientCallImpl` 当前就是 `ClientCall` 的实现；其构造器会收下 method、executor、callOptions、`ClientStreamProvider`、deadline cancellation executor 与当前 `Context`，证据：`core/src/main/java/io/grpc/internal/ClientCallImpl.java:69`、`:97`、`:131`。  
15. `ClientCallImpl.start()` 当前真正逻辑在 `startInternal(...)`；这里会做 context cancel、method config、compressor、headers、deadline、stream 创建和 listener 安装，证据：`core/src/main/java/io/grpc/internal/ClientCallImpl.java:181`、`:188`、`:242`、`:250`、`:286`。  
16. `ClientTransport.newStream(...)` 当前明确是客户端 transport 侧统一出口，负责基于 method / headers / callOptions / tracers 创建 stream，而不是“直接写字节”的薄别名，证据：`core/src/main/java/io/grpc/internal/ClientTransport.java:28`、`:56`。

### 测试证据已核对

1. `AbstractStubTest` 当前验证默认 stub 不自动携带 `STUB_TYPE_OPTION`，证据：`stub/src/test/java/io/grpc/stub/AbstractStubTest.java:45`。  
2. `BaseAbstractStubTest` 当前验证 `withWaitForReady()`、`withExecutor()` 等入口配置确实返回改写后的 call options，证据：`stub/src/test/java/io/grpc/stub/BaseAbstractStubTest.java:71`。  
3. `ClientCallsTest` 当前覆盖 blocking unary 成功、失败、真实 in-process channel 闭环、线程中断等待 `onClose()`、blocking stub type 和 future unary 收束，证据：`stub/src/test/java/io/grpc/stub/ClientCallsTest.java:126`、`:145`、`:167`、`:195`、`:273`、`:317`。  
4. `ManagedChannelImplTest` 当前覆盖 deadline 立刻过期、调用先于 name resolution 创建、config selector 在调用阶段改写行为，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:487`、`:500`、`:565`。  
5. `ClientCallImplTest` 当前覆盖 deadline 过期不创建 stream、context deadline 传给 stream、运行中 deadline 到期取消 stream，证据：`core/src/test/java/io/grpc/internal/ClientCallImplTest.java:781`、`:809`、`:909`。

### 深审发现

1. **高风险：容易把 gRPC 客户端入口重新写成“动态代理生成器故事”。** 当前正文已把重点从生成代码外观压回 `Stub -> ClientCalls -> ClientCall`。  
2. **高风险：容易从 Netty/HTTP2 直接下潜，跳过客户端运行时桥。** 当前正文已把 transport 收在出口桥，不重写 HTTP/2 主线。  
3. **中风险：容易把 blocking / future / async 写成只是返回值形式不同。** 当前正文已明确 `ThreadlessExecutor`、`GrpcFuture`、adapter 机制。  
4. **中风险：容易把 `ManagedChannel` 写成“单条连接”，忽略 pending call / config selector / runtime entry。** 当前正文已压回“客户端运行时总入口”。  
5. **中风险：容易把 `ClientCallImpl` 写成普通转发器。** 当前正文已强调它是成立性判断和 stream 下沉的关键切点。  
6. **低风险：容易第一篇吞下 NameResolver、LoadBalancer、服务端和流式全景。** 当前正文边界控制合格。

## 第二轮：因果审

- 入口如果只是“代理对象”，就解释不了调用选项、不变性和不同调用风格统一：✅  
- `Stub` 只保存 `Channel + CallOptions`，因此它适合做不可变入口而不是执行中心：✅  
- 不同表面 API 需要被 `ClientCalls` 统一压回 `ClientCall` 语义，否则 blocking / future / async 会各搞一套底层通路：✅  
- `ManagedChannel` 负责接管调用并缓冲下游运行时条件，因此不能被写成静态连接：✅  
- `ClientCallImpl.start()` 同时做成立性判断与 stream 创建，因此它是“本地方法外观”真正越界到远程调用运行时的切点：✅  
- transport 只需作为出口桥接，因为本文主题是客户端调用主线，而不是下游 HTTP/2 传输全景：✅

## 第三轮：结构审

正文结构按“困惑 -> 失败方案 -> 最小总图 -> Stub -> ClientCalls -> ManagedChannel -> ClientCallImpl -> transport 出口 -> 收网”推进，没有退化成源码目录平铺。✅

失败方案已覆盖：
- 只讲生成代码 / 动态代理外观  
- 直接从 transport / HTTP/2 讲起  
- 把 blocking / future / async 当成返回值差异  
- 第一篇同时吞下发现、负载均衡、服务端和流式全景  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `Stub` 是入口容器，不是执行中心  
- `ClientCalls` 是调用范式统一器  
- `ManagedChannel` 是客户端运行时总入口，不是单条连接  
- `ClientCallImpl.start()` 是调用真正开始发生的关键切点  
- `ClientTransport.newStream()` 是 transport 出口，而不是本文的主展开面  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把代码生成模板细节写成主线。✅  
- 未展开服务端 `ServerCall / ServerCalls`。✅  
- 未把四种流式调用完整展开。✅  
- 未深入 `Context / Deadline` 的横切面专题，只在必要处点到。✅  
- 未把 `NameResolver / LoadBalancer / SubchannelPicker` 细节吃进第一篇。✅  
- 未重写 Netty transport / HTTP/2 frame 全链路，只桥到 transport 出口。✅  
- 未引入 Dubbo / Feign 横向对照，边界收得住。✅

## 第六轮：依赖审

- rewrite-plan 中要求依赖的 `vol-netty/ch12-http2/04-grpc-and-triple-on-http2.md` 已被正文通过“transport 出口桥接”真实复用：✅  
- rewrite-plan 中要求的 Promise/Future 基础已在 blocking / future 分节里真正利用：✅  
- rewrite-plan 中要求的“软前置不展开发现/LoadBalancer/Context”已得到执行：✅  
- 正文未显式引用 `vol-netty/ch12-http2/02-framecodec-and-multiplex.md` 与 `vol-netty/ch12-http2/03-connection-encoder-decoder.md`，但 transport 收束依旧与它们兼容；这里只是隐式依赖，后续若要加强导航，可考虑在卷级目录或相关文章索引中补链接说明。⚠️

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：仅使用文字图代码块，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 核对，正文实际使用锚点均来自已核验实现或测试。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数：约 `37,961`。  
- 目标定位：重大主链基线篇，满足篇幅要求。✅

## 结论

当前正文已经建立 `Stub -> ClientCalls -> ManagedChannel -> ClientCallImpl -> ClientTransport` 这条稳定的 gRPC 客户端调用主线，符合 rewrite-plan 与方法论要求。它适合作为“RPC 与治理”主题的第一篇运行时基线篇，并可直接作为后续服务端、Context/Deadline、NameResolver/LoadBalancer 与跨框架对照篇的前置地基。