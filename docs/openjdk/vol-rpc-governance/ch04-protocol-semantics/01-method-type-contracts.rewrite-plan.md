# grpc-java：四种调用模式与方法契约总图 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch04-protocol-semantics`
- 篇：`01 四种调用模式与方法契约总图`
- 对应主题：`G-SPEC-1 gRPC 方法类型契约总篇`
- 文章类型：规范层总串联篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：前面的主干篇已经讲了 unary、server-streaming、client-streaming、bidi-streaming 四种调用模式各自的实现路径，但读者仍然不清楚：这些模式之间的差异到底只是"代码写法不同"，还是存在更严格的契约边界？为什么一个 unary 方法如果发送了两次响应，grpc-java 会报错？为什么 client-streaming 方法如果客户端不发送任何请求就关闭，服务端不会报错？哪些行为是"违反协议契约"，哪些只是"业务异常"？
- 一句话顿悟：gRPC 的四种方法类型不是"代码风格偏好"，而是有严格契约的协议规范——UNARY 要求恰好 1 请求 1 响应，SERVER_STREAMING 要求恰好 1 请求 N 响应，CLIENT_STREAMING 要求 N 请求恰好 1 响应，BIDI_STREAMING 要求 N 请求 N 响应；grpc-java 在 `ServerCallImpl.sendMessageInternal()`、`ServerCalls.UnaryServerCallListener`、`ClientCalls.StreamObserverToCallListenerAdapter` 等多处通过 `Status.INTERNAL` 强制执行这些契约，违反时以 `TOO_MANY_REQUESTS`、`MISSING_REQUEST`、`TOO_MANY_RESPONSES`、`MISSING_RESPONSE` 等明确错误消息终止调用。
- 文章边界：本篇重点解释四种方法类型的契约定义（请求/响应条数、half-close 时机、消息边界）以及 grpc-java 中 enforce 这些契约的关键检查点；不深入 `ClientCallImpl.sendMessage()` 的 Netty 帧级实现细节（已在 ch03/04 压缩篇覆盖），不展开 deadline/cancel 与契约的交互（留给 ch04/03 取消边界篇）。

## 前置依赖

### HARD

- `vol-rpc-governance/ch01-grpc-runtime/01-stub-channel-clientcall.md`：已经知道客户端调用如何从 stub 走到 `ClientCall`。
- `vol-rpc-governance/ch01-grpc-runtime/02-servercall-and-streaming-model.md`：已经知道服务端如何从 `ServerCall` 走到用户 handler。
- `vol-rpc-governance/ch03-runtime-deepening/04-compression-codec-message-framing.md`：已经知道 wire format 的帧结构。

### SOFT

- 不要求先懂 Metadata/Status 语义细节（那是 ch04/02 的内容）。
- 不要求先懂 deadline/cancel/retry 等生产排障细节。

### NAV

- 后续可接：`ch04/02-metadata-status-trailers`（Metadata、Status 与 Trailers 语义）。
- 后续可接：`ch04/03-cancel-halfclose-completion`（取消、half-close 与完成边界）。
- 后续可接：生产诊断卷中的方法类型排障。

## 一句话困惑

Unary、ServerStreaming、ClientStreaming、BidiStreaming 四种调用模式之间，除了"请求/响应条数不同"之外，还有哪些必须遵守的契约？如果违反这些契约，grpc-java 会怎么处理？哪些是"编译时约定"，哪些是"运行时强制"？

## 一句话顿悟

四种方法类型在 gRPC 协议规范中有明确的请求/响应条数契约，grpc-java 在 `ServerCallImpl`（服务端响应计数）、`ServerCalls.UnaryServerCallListener`（服务端请求计数）、`ClientCalls.StreamObserverToCallListenerAdapter`（客户端响应计数）三处通过 `Status.INTERNAL` 强制执行这些契约，违反时以 `TOO_MANY_REQUESTS`、`MISSING_REQUEST`、`TOO_MANY_RESPONSES`、`MISSING_RESPONSE` 四个明确错误消息终止调用；客户端侧的 `ClientCallImpl` 仅做 `IllegalStateException` 状态检查（sendMessage/halfClose 的时序合法），不做请求/响应计数——计数由 stub 层（`ClientCalls`）通过调用模式确保。

## 读者理解路径

1. 先否定"四种方法类型只是代码风格偏好"的粗糙理解。
2. 建立最小总图：契约定义（UNARY = 1:1, SERVER_STREAMING = 1:N, CLIENT_STREAMING = N:1, BIDI_STREAMING = N:N）→ 服务端 enforce（ServerCallImpl + ServerCalls）→ 客户端 enforce（ClientCalls）→ 违反后果。
3. 解释 `MethodDescriptor.MethodType` 的 4 个枚举值及其 `clientSendsOneMessage()`/`serverSendsOneMessage()` 语义。
4. 解释服务端请求计数：`UnaryServerCallListener.onMessage()` 的 `TOO_MANY_REQUESTS` 和 `onHalfClose()` 的 `MISSING_REQUEST`。
5. 解释服务端响应计数：`ServerCallImpl.sendMessageInternal()` 的 `TOO_MANY_RESPONSES` 和 `closeInternal()` 的 `MISSING_RESPONSE`。
6. 解释客户端响应计数：`ClientCalls.StreamObserverToCallListenerAdapter.onMessage()` 的 "More than one responses" 和 `UnaryStreamToFuture` 的 exactly-1 校验。
7. 解释客户端请求无强制计数：`ClientCallImpl.sendMessageInternal()` 只做状态检查（halfCloseCalled/cancelCalled），不计数；`ClientCalls.asyncUnaryRequestCall()` 通过代码路径确保恰好发送 1 次。
8. 收束到：契约是规范层（什么是对的），enforce 是实现层（什么会报错），两者缺一不可。

## 失败方案推演

### 失败方案一：四种方法类型只是"代码风格偏好"，没有严格的契约约束

- 如果只是风格偏好，那为什么 `ServerCallImpl.sendMessageInternal()` 要专门检查 `serverSendsOneMessage()` 并拒绝第二次响应？
- 为什么 `ServerCalls.UnaryServerCallListener.onMessage()` 收到第二个请求时会直接 `call.close(Status.INTERNAL)`？
- 如果只是风格，这些检查完全可以去掉，把四种模式统一成一种"你爱发多少条就发多少条"的语义。
- 所以四种方法类型不是偏好，而是有严格契约约束的协议规范。

### 失败方案二：客户端和服务端的契约检查是对称的

- 这个方案看起来合理，但实际实现并不对称。
- 服务端对请求和响应都有严格的计数检查（`UnaryServerCallListener` 检查请求数，`ServerCallImpl` 检查响应数）。
- 客户端对响应有计数检查（`StreamObserverToCallListenerAdapter` 检查多条响应），但对请求不做计数检查——`ClientCallImpl.sendMessageInternal()` 只检查 `halfCloseCalled` 和 `cancelCalled` 的状态，不检查`clientSendsOneMessage()`。
- 客户端侧的请求计数由 stub 层（`ClientCalls.asyncUnaryRequestCall`）通过"调用一次 sendMessage 后立即调用 halfClose"的代码路径确保，而不是通过运行时检查。
- 所以不对称是设计选择：服务端不能信任客户端，必须强制执行；客户端可以信任自己的 stub 代码。

### 失败方案三：违反契约就是抛出异常，和 Status 无关

- 如果违反契约只是抛一个 `IllegalStateException` 或 `RuntimeException`，那客户端收到的就是一个内部错误，而不是一个标准的 gRPC Status。
- 但实际实现中，服务端违反契约时（`TOO_MANY_RESPONSES`、`MISSING_RESPONSE`）是通过 `handleInternalError()` 调用 `stream.cancel(Status.INTERNAL)` 来终止调用，客户端收到的是 `Status.INTERNAL`。
- 客户端违反契约时（`TOO_MANY_REQUESTS`、`MISSING_REQUEST`）也是通过 `call.close(Status.INTERNAL, ...)` 来终止。
- 所以违反契约不是"内部异常"，而是"标准 gRPC INTERNAL 状态"——这个区别很重要，因为客户端可以统一通过 `Status.getCode()` 来识别和处理。

## 必须澄清的误解

1. 四种方法类型不是"代码风格偏好"，而是有严格契约的协议规范，违反时以 `Status.INTERNAL` 终止调用。
2. 客户端和服务端的契约检查不对称：服务端强制执行请求和响应计数，客户端只强制执行响应计数——请求计数由 stub 层代码路径保证。
3. 违反契约不是内部异常，而是标准 gRPC `Status.INTERNAL`，有明确的错误消息（`TOO_MANY_REQUESTS`、`MISSING_REQUEST`、`TOO_MANY_RESPONSES`、`MISSING_RESPONSE`）。
4. `clientSendsOneMessage()` 和 `serverSendsOneMessage()` 不是"会不会发送"的语义，而是"契约要求恰好 1 条"的语义。
5. 客户端 `ClientCallImpl.sendMessage()` 可以调用 0 次、1 次或 N 次——这个底层不限制，但 stub 层通过调用路径确保了契约合规。

## 文章结构与字数预算

1. 困惑开场：为什么"发两条消息"会报错——引出契约概念（800-1000 字）
2. 最小总图：四种契约 + 三层 enforce 体系（1000-1400 字）
3. `MethodDescriptor.MethodType`：契约的定义层（1200-1600 字）
4. 服务端请求 enforce：`UnaryServerCallListener` 的 `TOO_MANY_REQUESTS` 和 `MISSING_REQUEST`（1400-2000 字）
5. 服务端响应 enforce：`ServerCallImpl` 的 `TOO_MANY_RESPONSES` 和 `MISSING_RESPONSE`（1400-2000 字）
6. 客户端 enforce：`ClientCalls` 的响应计数 + 请求无计数（1200-1600 字）
7. 不对称设计：服务端信任 vs 不信任的哲学（1000-1400 字）
8. 收网总结：契约 + enforce + 不对称 = 完整的方法类型体系（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### MethodType 定义
- `api/src/main/java/io/grpc/MethodDescriptor.java:81` — `UNARY` 枚举值及 javadoc
- `api/src/main/java/io/grpc/MethodDescriptor.java:87` — `CLIENT_STREAMING` 枚举值及 javadoc
- `api/src/main/java/io/grpc/MethodDescriptor.java:93` — `SERVER_STREAMING` 枚举值及 javadoc
- `api/src/main/java/io/grpc/MethodDescriptor.java:99` — `BIDI_STREAMING` 枚举值及 javadoc
- `api/src/main/java/io/grpc/MethodDescriptor.java:114` — `clientSendsOneMessage()` 方法
- `api/src/main/java/io/grpc/MethodDescriptor.java:124` — `serverSendsOneMessage()` 方法

### 服务端请求 enforce
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:37` — `TOO_MANY_REQUESTS` 常量
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:38` — `MISSING_REQUEST` 常量
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:126` — `UnaryServerCallHandler.startCall()` 的 `clientSendsOneMessage()` 前置检查
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:154` — `UnaryServerCallListener.onMessage()` 第二次请求 → `TOO_MANY_REQUESTS`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:170` — `UnaryServerCallListener.onHalfClose()` 无请求 → `MISSING_REQUEST`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:261` — `StreamingServerCallListener.onMessage()` 无计数（允许 N 请求）

### 服务端响应 enforce
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:57` — `TOO_MANY_RESPONSES` 常量
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:58` — `MISSING_RESPONSE` 常量
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:145` — `sendHeadersInternal()` 的 `endOfStream = !serverSendsOneMessage()`
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:156` — `sendMessageInternal()` 的 `serverSendsOneMessage()` + `messageSent` 检查 → `TOO_MANY_RESPONSES`
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:217` — `closeInternal()` 的 `serverSendsOneMessage()` + `!messageSent` 检查 → `MISSING_RESPONSE`

### 客户端 enforce
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:81` — `asyncUnaryCall()` 入口
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:95` — `asyncServerStreamingCall()` 入口
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:111` — `asyncClientStreamingCall()` 入口
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:127` — `asyncBidiStreamingCall()` 入口
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:396` — `asyncUnaryRequestCall()` 发送 1 请求 + halfClose
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:420` — `asyncStreamingRequestCall()` 返回 StreamObserver，不发送
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:468` — `CallToStreamObserverAdapter.onNext()` → `call.sendMessage()`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:479` — `CallToStreamObserverAdapter.onCompleted()` → `call.halfClose()`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:562` — `StreamObserverToCallListenerAdapter.onMessage()` 多条响应 → `INTERNAL`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:618` — `UnaryStreamToFuture.onMessage()` 多条 → `INTERNAL`
- `stub/src/main/java/io/grpc/stub/ClientCalls.java:633` — `UnaryStreamToFuture.onClose()` 无响应 → `INTERNAL`
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:120` — `unaryRequest` 标志（UNARY/SERVER_STREAMING 为 true）
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:499` — `halfCloseInternal()` 状态检查
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:515` — `sendMessageInternal()` 状态检查（无计数）
- `core/src/main/java/io/grpc/internal/ClientCallImpl.java:745` — `onReady()` 对 `clientSendsOneMessage()` 方法静默

## 测试证据清单

- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:480` — `clientSendsOne_errorMissingRequest_unary`
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:497` — `clientSendsOne_errorMissingRequest_serverStreaming`
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:516` — `clientSendsOne_errorTooManyRequests_unary`
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:537` — `clientSendsOne_errorTooManyRequests_serverStreaming`
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:400` — `disablingInboundAutoRequestForUnaryHasNoEffect`
- `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:229` — `sendMessage_serverSendsOne_closeOnSecondCall_unary`
- `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:302` — `serverSendsOne_okFailsOnMissingResponse_unary`
- `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:329` — `serverSendsOne_canErrorWithoutResponse`

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讨论的是 grpc-java 中方法类型契约的 enforce 实现，不展开 gRPC 规范本身的 wire format 定义。
- `MethodType` 的 `UNKNOWN` 值在本篇中不展开（它主要用于 xDS 等动态场景）。
- 本篇的"契约"指 gRPC 协议规范层面的方法类型语义，不是 Java 层面的接口契约。

## 与其他篇的边界

### 本篇要讲清

- 四种方法类型的契约定义（请求/响应条数）。
- grpc-java 在服务端 enforce 契约的三个检查点（`UnaryServerCallListener` 请求计数、`ServerCallImpl` 响应计数、`ServerCallImpl` 关闭检查）。
- grpc-java 在客户端 enforce 契约的检查点（`StreamObserverToCallListenerAdapter` 响应计数、`UnaryStreamToFuture` 计数）。
- 客户端请求无计数的设计选择及原因。

### 本篇不深讲

- Metadata、Status 与 Trailers 的语义细节（留给 ch04/02）。
- 取消、half-close 与完成边界的细节（留给 ch04/03）。
- Deadline 与 retry 的交互（留给生产排障卷）。
- xDS 对方法类型的动态配置。

## 写作后检查

- [ ] 开篇先抓"为什么发两条消息会报错"，而不是直接讲 MethodType 枚举。
- [ ] 至少展开 3 个失败方案，且包含"契约检查是对称的""违反契约是内部异常"。
- [ ] 明确给出四种契约的 1:1 / 1:N / N:1 / N:N 总图。
- [ ] 不把本篇写成 `MethodDescriptor.MethodType` 的字段说明书。
- [ ] 每个 enforce 点先讲动机（为什么需要这个检查）再给证据。
- [ ] 删除代码块后，读者仍能复述四种契约、三层 enforce 体系、不对称设计。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。