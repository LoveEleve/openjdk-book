# gRPC-Java：ServerCall、ServerCalls 与流式调用模型 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `ServerImpl` 当前并不是薄生命周期壳，而是通过 `ServerListenerImpl` / `ServerTransportListenerImpl` 接住 transport 世界，证据：`core/src/main/java/io/grpc/internal/ServerImpl.java:369`、`:410`。  
2. `ServerTransportListenerImpl.streamCreated(...)` 当前是服务端真正接住新 RPC stream 的切点，证据：`core/src/main/java/io/grpc/internal/ServerImpl.java:465`。  
3. `streamCreatedInternal(...)` 当前会先决定 executor 形态，并在 direct executor 场景下优化 stream，说明服务端先处理线程模型，再推进业务调用，证据：`core/src/main/java/io/grpc/internal/ServerImpl.java:475`。  
4. `ServerImpl` 当前会在 `MethodLookup` 中查主 registry、fallback registry，查不到就直接 `UNIMPLEMENTED` 并关闭 stream，不进入业务方法，证据：`core/src/main/java/io/grpc/internal/ServerImpl.java:501`、`:524`。  
5. `JumpToApplicationThreadServerStreamListener` 当前会先被设到 stream 上，说明 transport 事件先跳桥、后接业务 listener，证据：`core/src/main/java/io/grpc/internal/ServerImpl.java:510`。  
6. `MethodLookup.maySwitchExecutor(...)` 当前会先构造 `ServerCallImpl`，再与 `ServerCallHandler` 打包成参数对象，证据：`core/src/main/java/io/grpc/internal/ServerImpl.java:579`。  
7. `HandleServerCall.runInternal()` 当前真正通过 `startWrappedCall(...)` 调用 `callHandler.startCall(call, headers)`，证据：`core/src/main/java/io/grpc/internal/ServerImpl.java:598`、`:689`。  
8. `ServerCallImpl` 当前持有 stream、method、context、压缩相关状态、cancelled / sendHeadersCalled / closeCalled / messageSent 等服务端调用语义状态，证据：`core/src/main/java/io/grpc/internal/ServerCallImpl.java:52`。  
9. `ServerCallImpl.sendHeaders(...)` 当前会校验 headers/close 状态、协商 compressor，并最终 `stream.writeHeaders(...)`，证据：`core/src/main/java/io/grpc/internal/ServerCallImpl.java:101`。  
10. `ServerCallImpl.sendMessage(...)` 当前在 `serverSendsOneMessage()` 方法上会阻止第二条响应并触发 `TOO_MANY_RESPONSES`，证据：`core/src/main/java/io/grpc/internal/ServerCallImpl.java:149`。  
11. `ServerCallImpl.close(...)` 当前在 single-response 方法上若 OK 结束但未发响应，会触发 `MISSING_RESPONSE`，证据：`core/src/main/java/io/grpc/internal/ServerCallImpl.java:210`。  
12. `ServerCallImpl.newServerStreamListener(...)` 当前会创建 `ServerStreamListenerImpl`，把 transport 侧 listener 事件统一翻译给应用 listener，证据：`core/src/main/java/io/grpc/internal/ServerCallImpl.java:238`、`:287`。  
13. `ServerCalls` 当前明确承担“把 `ServerCallHandler` 适配到应用服务实现”这一层，而且是给 generated code 用的，证据：`stub/src/main/java/io/grpc/stub/ServerCalls.java:31`。  
14. `ServerCalls` 当前将四种方法形态折成两大类：`asyncUnaryCall/asyncServerStreamingCall` -> `UnaryServerCallHandler`，`asyncClientStreamingCall/asyncBidiStreamingCall` -> `StreamingServerCallHandler`，证据：`stub/src/main/java/io/grpc/stub/ServerCalls.java:49`、`:59`、`:69`、`:79`、`:112`、`:219`。  
15. `UnaryServerCallHandler` 当前会先 `call.request(2)` 来抓 unary/server-streaming 的协议违规，并把真正的 `method.invoke(...)` 推迟到 `onHalfClose()`，证据：`stub/src/main/java/io/grpc/stub/ServerCalls.java:124`、`:170`。  
16. `StreamingServerCallHandler` 当前会先执行 `method.invoke(responseObserver)` 拿到 request-side `StreamObserver`，后续通过 `onMessage()` 渐进式交付请求，并在 `onHalfClose()` 时 `requestObserver.onCompleted()`，证据：`stub/src/main/java/io/grpc/stub/ServerCalls.java:231`、`:260`、`:271`。  
17. `ServerCallStreamObserverImpl` 当前承载 onReady / onCancel / onClose handler、auto request、cancel 后 onNext 语义、首条消息前自动 sendHeaders 等边界，证据：`stub/src/main/java/io/grpc/stub/ServerCalls.java:325`。  
18. `StreamObserver` 当前用于所有 method type，包括 unary，且注释已明确其异步、非线程安全与流控建议，证据：`stub/src/main/java/io/grpc/stub/StreamObserver.java:20`、`:35`、`:52`。

### 测试证据已核对

1. `ServerCallsTest.runtimeStreamObserverIsServerCallStreamObserver()` 当前证明运行时 responseObserver 确实是 `ServerCallStreamObserver`，并且 auto-request 会持续 request 后续消息，证据：`stub/src/test/java/io/grpc/stub/ServerCallsTest.java:86`。  
2. `ServerCallsTest.noCancellationExceptionIfOnCancelHandlerSet()` 与 `expectCancellationExceptionIfOnCancelHandlerNotSet()` 当前证明 streaming 取消后的行为取决于是否设置 onCancelHandler，证据：`stub/src/test/java/io/grpc/stub/ServerCallsTest.java:139`、`:172`。  
3. `ServerCallsTest.onCloseHandlerCalledIfSetInUnaryClientCall()` 当前证明 unary/server-streaming 形态也会触发 onCloseHandler，证据：`stub/src/test/java/io/grpc/stub/ServerCallsTest.java:226`。  
4. `ServerCallsTest.cannotSetOnCancelHandlerAfterServiceInvocation()` 等测试当前证明 observer 初始化后会被冻结，证据：`stub/src/test/java/io/grpc/stub/ServerCallsTest.java:250`。  
5. `ServerCallsTest.disablingInboundAutoRequestSuppressesRequestsForMoreMessages()` 当前证明关闭 auto-request 后不会自动 `request(1)`，证据：`stub/src/test/java/io/grpc/stub/ServerCallsTest.java:355`。  
6. `ServerCallsTest.disablingInboundAutoRequestForUnaryHasNoEffect()` 当前证明 unary 仍会 request 2 条来抓协议违规，证据：`stub/src/test/java/io/grpc/stub/ServerCallsTest.java:401`。  
7. `ServerCallsTest.onReadyHandlerCalledForUnaryRequest()` 当前证明 unary/server-streaming 的 onReady 要等请求真正交付并 `halfClose` 后才补偿触发，证据：`stub/src/test/java/io/grpc/stub/ServerCallsTest.java:419`。  
8. `ServerCallsTest.clientSendsOne_errorMissingRequest_unary()` 与 `clientSendsOne_errorTooManyRequests_unary()` 当前证明 unary/server-streaming 的 `MISSING_REQUEST / TOO_MANY_REQUESTS` 约束，证据：`stub/src/test/java/io/grpc/stub/ServerCallsTest.java:480`、`:517`。  
9. `ServerCallImplTest.sendMessage_serverSendsOne_closeOnSecondCall_unary()` 及其 `CLIENT_STREAMING_METHOD` 同族测试，当前共同证明凡是 `serverSendsOneMessage()` 的方法，多发响应都会触发 `TOO_MANY_RESPONSES`，证据：`core/src/test/java/io/grpc/internal/ServerCallImplTest.java:229`。  
10. `ServerCallImplTest.serverSendsOne_okFailsOnMissingResponse_unary()` 及其 `CLIENT_STREAMING_METHOD` 同族测试，当前共同证明凡是单响应方法，若 OK 结束但未发响应会触发 `MISSING_RESPONSE`，证据：`core/src/test/java/io/grpc/internal/ServerCallImplTest.java:302`。  
11. `ServerCallImplTest.streamListener_*` 系列当前证明 `halfClosed / closed / onReady / onMessage` 会被正确翻译给应用 listener，证据：`core/src/test/java/io/grpc/internal/ServerCallImplTest.java:386`。

### 深审发现

1. **高风险：容易把服务端重新写成“收到请求后直接调业务方法”。** 当前正文已把重点压回 `ServerImpl -> ServerCallImpl -> ServerCalls` 这条运行时桥。  
2. **高风险：容易把四种调用模式写成 unary 多几次 `onNext`。** 当前正文已明确请求交付模型、业务 invoke 时机和 `halfClose` 语义差异。  
3. **中风险：容易低估 `ServerCalls`，把它写成 generated code 边角料。** 当前正文已把它提升为四种模式的核心适配层。  
4. **中风险：容易把 `ServerCallImpl` 写成 response wrapper。** 当前正文已补 headers / sendMessage / close / cancel / listener 翻译这些统一调用语义。  
5. **中风险：容易把 `StreamObserver` 当普通回调接口。** 当前正文已补 `ServerCallStreamObserver`、auto-request、onReady/onCancel/onClose 这些运行时边界。  
6. **低风险：容易把 transport / interceptor / Context 一股脑吞进第二篇。** 当前正文边界基本控制住了。

## 第二轮：因果审

- transport stream 必须先被 `ServerImpl` 接住并桥到应用线程世界，否则服务端运行时没有稳定入口：✅  
- 统一的 `ServerCallImpl` 必须先建立服务端调用语义，否则四种模式会直接暴露 transport 细节给业务方法：✅  
- `ServerCalls` 之所以重要，是因为四种模式真正先分野的是“client 是不是只发一个请求”，而不是“响应有几条”：✅  
- unary / server-streaming 要等 `halfClose` 后才 invoke，因此 streaming 不是 unary 多几次消息：✅  
- client-streaming / bidi 先返回 requestObserver，因此它们的应用交互模型与 unary 根本不同：✅  
- `StreamObserver` 之所以成为关键交互面，是因为取消、流控、关闭 handler 都从这里暴露给应用：✅

## 第三轮：结构审

正文结构按“困惑 -> 失败方案 -> 最小总图 -> ServerImpl -> ServerCallImpl -> ServerCalls -> 四种模式对照 -> StreamObserver 边界 -> 收网”推进，没有退化成源码目录平铺。✅

失败方案已覆盖：
- 收到请求直接调业务方法  
- 四种模式只是 unary 多几次 `onNext`  
- `StreamObserver` 只是普通回调接口  
- 第二篇顺手吞下 transport / interceptor / Context 全景  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `ServerImpl` 是 transport stream 进入应用运行时的桥  
- `ServerCallImpl` 是统一服务端调用语义，而不是 response wrapper  
- `ServerCalls` 是四种模式的核心适配层  
- unary/server-streaming 与 client-streaming/bidi 的真正分野在请求交付和 `halfClose` 语义  
- `StreamObserver` 在服务端连着流控、取消和关闭边界  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开拦截器整链，只在 `wrapMethod()` 背景下点到。✅  
- 未把 Context / Deadline 展开成横切面专题。✅  
- 未重写 Netty transport / HTTP/2 细节。✅  
- 未把 NameResolver / LoadBalancer 拉进第二篇。✅  
- 未引入 Dubbo / Feign 横向对照。✅  
- 重点仍压在服务端调用运行时与四种模式差异，边界收得住。✅

## 第六轮：依赖审

- 已显式承接第一篇客户端基线篇，形成 client-call -> server-call 的镜像推进：✅  
- 与 `vol-netty/ch12-http2/04-grpc-and-triple-on-http2.md` 的关系已被收在“transport stream 已经存在”的前提上，且正文明确说明三篇之间的接力关系，没有重复展开 transport 细节：✅  
- rewrite-plan 中要求的“拦截器 / Context / transport 只点到不深讲”已得到执行：✅  
- 卷内导航仍可在后续总目录中继续加强，但当前正文已不再只是隐式依赖。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中已清零。✅  
- 代码块：仅使用文字图代码块，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验实现或测试。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数：约 `35,448`。  
- 目标定位：重大主链基线篇，满足篇幅要求。✅

## 结论

当前三件套的目标明确：第二篇应把 `ServerImpl -> ServerCallImpl -> ServerCalls -> StreamObserver` 这条服务端运行时主线立住，并解释四种调用模式为什么不是 unary 的简单放大。只要正文按这个 review 结论收口，它就能成为后续拦截器、Context/Deadline 与更深 transport 专题的稳定前置地基。