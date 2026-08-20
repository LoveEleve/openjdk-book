# gRPC-Java：ServerCall、ServerCalls 与流式调用模型 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch01-grpc-runtime`
- 篇：`02 ServerCall、ServerCalls 与流式调用模型`
- 对应主题：`G-RPC-2 服务端运行时与流式交互`
- 文章类型：服务端运行时基线篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：客户端那边已经把一次 RPC 压成了 `ClientCall` 和 stream；那它到了服务端之后，是怎样被接住、分发到业务方法、再根据 unary / server streaming / client streaming / bidi streaming 这四种模式转成不同交互语义的？
- 一句话顿悟：gRPC 服务端并不是“收到请求后直接回调业务方法”这么简单，而是先由 `ServerImpl` 把 transport stream 收进服务端运行时，再由 `ServerCallImpl` 建立一次服务端调用语义，最后由 `ServerCalls` 按方法类型把它适配成四种不同的 `StreamObserver` 交互模型。
- 文章边界：本篇只讲服务端调用如何落地，以及四种调用模式为什么不是 unary 的简单放大；重点解释 `ServerImpl / ServerTransportListener / ServerCallImpl / ServerCalls / StreamObserver` 的职责关系，不深入拦截器、Context/Deadline 专题、NameResolver/LoadBalancer，也不重写 Netty transport 细节。

## 前置依赖

### HARD

- `vol-rpc-governance/ch01-grpc-runtime/01-stub-channel-clientcall.md`：已经建立客户端调用如何被压到 `ClientCall` 与 stream 的基线。
- `vol-netty/ch12-http2/04-grpc-and-triple-on-http2.md`：已经知道 gRPC 最终落在 HTTP/2 stream 与 transport 主线之上。
- 至少知道 `StreamObserver` 在 gRPC 中既可表示请求侧也可表示响应侧。

### SOFT

- `Context / Deadline` 只在服务端收尾与取消处点到，不作为本篇硬前置。
- 拦截器只在 `wrapMethod()` 路径中点到，不展开成单独主线。

### NAV

- 后续第三篇：`gRPC-Java：拦截器、上下文传播与 Deadline`
- 后续第四篇：`gRPC-Java：NameResolver、LoadBalancer 与 Netty Transport`

## 一句话困惑

一次 RPC 到了服务端之后，为什么不是“框架收到消息 -> 直接调用业务方法”这么简单，而还要绕过 `ServerImpl`、`ServerCallImpl`、`ServerCalls` 和一整套 `StreamObserver` 适配层？

## 一句话顿悟

gRPC 服务端真正要解决的不是“把一个方法调起来”，而是把 transport stream 变成一次受约束的服务端调用：`ServerImpl` 负责接流和切线程，`ServerCallImpl` 负责服务端调用语义与收尾约束，`ServerCalls` 负责按 unary / server streaming / client streaming / bidi streaming 四种模式组织消息与 half-close 语义。

## 读者理解路径

1. 先否定“服务端收到请求就直接回调业务方法”的粗糙理解。
2. 先建立最小总图：`transport stream -> ServerImpl.streamCreated() -> MethodLookup / HandleServerCall -> ServerCallImpl -> ServerCalls -> StreamObserver`。
3. 解释 `ServerImpl` 为什么不是单纯的 server 容器，而是服务端 transport 与应用线程之间的第一层运行时桥。
4. 解释 `ServerCallImpl` 为什么是服务端调用统一语义，而不是简单的 response wrapper。
5. 解释 `ServerCalls` 为什么重要：它把四种方法形态统一适配进 service implementation，而不是让 generated code 直接拼装所有细节。
6. 解释四种调用模式到底差在哪：什么时候先收一个请求再 invoke，什么时候先给出 request observer，什么时候 auto-request，什么时候 `halfClose` 才触发真正业务调用。
7. 最后收束到：流式调用不是“unary 多几次 onNext”，而是服务端请求交付、回包时机、取消语义和流控方式都不一样。

## 失败方案推演

### 失败方案一：服务端只要收到消息，直接调用业务方法就行

- 这种理解漏掉了：
- 方法查找与兜底 `UNIMPLEMENTED`
- transport 线程与应用线程切换
- headers / compressor / cancel / close 这些服务端调用语义
- 四种调用模式的请求交付时机差异
- 所以“直接回调业务方法”只描述了最表面的一瞬间，根本解释不了服务端运行时结构。

### 失败方案二：四种调用模式只是 unary 多几次 `onNext`

- 这会错过最关键的模式边界：
- unary / server streaming：client 只发一个请求，真正业务 `invoke()` 要等到 `onHalfClose()` 后才能稳定成立
- client streaming / bidi：业务方法先返回一个 request-side `StreamObserver`，后续请求再逐条喂进去
- `halfClose`、`onReady`、auto-request、cancel 触发点都不同
- 所以 streaming 不是输出条数变化，而是交互协议变化。

### 失败方案三：`StreamObserver` 只是一个回调接口，没什么运行时地位

- 这会低估 `ServerCalls` 和 `ServerCallStreamObserver`。
- 它们不仅承载消息回调，还承载：
- onReady/onCancel/onClose handler
- auto inbound flow control
- 服务端发消息时的 headers / close 约束
- 也就是说，`StreamObserver` 在服务端不是末端小工具，而是四种调用模型共同暴露给应用的交互面。

### 失败方案四：第一篇客户端讲完后，第二篇可以直接混进拦截器、Context、transport

- 这会让服务端调用模型再次失焦。
- 本篇只回答：服务端怎样接住一次 RPC，以及四种模式为什么交互不同。
- 拦截器、Context/Deadline、transport 细节都应后移。

## 必须澄清的误解

1. `ServerImpl` 不是单纯 server 生命周期壳，它是 transport stream 进入应用运行时的接入口。
2. `ServerCallImpl` 不只是 response wrapper，它承担服务端 headers、message、close、cancel 等统一调用语义。
3. `ServerCalls` 不是 generated code 边角料，而是四种调用模式的核心适配层。
4. unary / server streaming 和 client streaming / bidi streaming 的差异，不只是响应条数，而是请求交付与 half-close 时机完全不同。
5. `StreamObserver` 在服务端不是简单回调接口，它连着流控、取消和关闭边界。

## 文章结构与字数预算

1. 困惑开场：为什么服务端不是“收到请求直接调业务方法”（800-1000 字）
2. 最小总图：transport stream 怎样走进服务端运行时（1200-1600 字）
3. `ServerImpl`：方法查找、切线程、构造 `ServerCallImpl` 的运行时桥（1800-2400 字）
4. `ServerCallImpl`：headers / sendMessage / close / cancel 怎样建立服务端调用语义（1800-2400 字）
5. `ServerCalls`：四种方法形态怎样被统一适配（2200-3000 字）
6. 四种调用模式对照：为什么 streaming 不是 unary 的简单放大（1800-2400 字）
7. `StreamObserver` 与服务端流控/取消的交互边界（1200-1600 字）
8. 收网总结：服务端运行时先立住哪几层（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `core/src/main/java/io/grpc/internal/ServerImpl.java:369`
- `core/src/main/java/io/grpc/internal/ServerImpl.java:410`
- `core/src/main/java/io/grpc/internal/ServerImpl.java:465`
- `core/src/main/java/io/grpc/internal/ServerImpl.java:501`
- `core/src/main/java/io/grpc/internal/ServerImpl.java:510`
- `core/src/main/java/io/grpc/internal/ServerImpl.java:524`
- `core/src/main/java/io/grpc/internal/ServerImpl.java:579`
- `core/src/main/java/io/grpc/internal/ServerImpl.java:598`
- `core/src/main/java/io/grpc/internal/ServerImpl.java:689`
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:52`
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:101`
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:149`
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:210`
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:238`
- `core/src/main/java/io/grpc/internal/ServerCallImpl.java:287`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:31`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:49`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:59`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:69`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:79`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:112`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:219`
- `stub/src/main/java/io/grpc/stub/ServerCalls.java:325`
- `stub/src/main/java/io/grpc/stub/StreamObserver.java:20`
- `stub/src/main/java/io/grpc/stub/StreamObserver.java:52`

## 测试证据清单

- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:86`：运行时 `responseObserver` 确实是 `ServerCallStreamObserver`。
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:139`：设置 onCancelHandler 后取消不会抛额外异常。
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:172`：未设置 onCancelHandler 时 streaming onNext 会暴露取消异常。
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:226`：onCloseHandler 在 unary/server-streaming 形态也会触发。
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:250`：冻结后不能再改 onCancel/onReady/onClose handler。
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:355`：关闭 auto request 后不会自动 `request(1)`。
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:401`：unary 自动请求 2 条是为了抓协议违规。
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:419`：unary/server-streaming 的 onReady 要等 request 真正交付后才触发。
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:480`：缺失请求时 unary/server-streaming 直接报 `MISSING_REQUEST`。
- `stub/src/test/java/io/grpc/stub/ServerCallsTest.java:517`：多请求时 unary/server-streaming 直接报 `TOO_MANY_REQUESTS`。
- `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:229`：serverSendsOne 方法多次发响应会触发 `TOO_MANY_RESPONSES`。
- `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:302`：serverSendsOne 方法若 OK 结束但未发响应，会触发 `MISSING_RESPONSE`。
- `core/src/test/java/io/grpc/internal/ServerCallImplTest.java:386`：`ServerStreamListenerImpl` 正确分发 `halfClosed / closed / onReady / onMessage`。

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讨论的是 Java 服务端调用运行时抽象，不把 Netty server transport、TLS/ALPN 或具体传输栈细节展开。
- 本篇把 generated service method 看成已存在的入口，不分析 protoc 生成模板本身。
- `ServerImpl` 当前实现包含拦截器包装、binlog、context 创建与 executor 切换；本篇只在服务端主线需要的范围内点到。

## 与其他篇的边界

### 本篇要讲清

- transport stream 如何进入 `ServerImpl`。
- `ServerCallImpl` 如何建立服务端统一调用语义。
- `ServerCalls` 如何把四种方法形态适配进业务实现。
- four-call-model 到底差在哪，尤其是 unary/server-streaming 与 client-streaming/bidi 的请求交付时机差异。
- `StreamObserver` 在服务端如何连着取消、流控与关闭边界。

### 本篇不深讲

- 拦截器完整链路。
- Context / Deadline 横切面专题。
- Netty transport / HTTP/2 连接主链细节。
- NameResolver / LoadBalancer。
- Dubbo / Feign 横向对照。

## 写作后检查

- [ ] 开篇先抓“为什么不是直接回调业务方法”，而不是直接列四种模式。
- [ ] 至少展开 3 个失败方案，且包含“streaming 不是 unary 多几次 onNext”。
- [ ] 明确给出 `ServerImpl -> ServerCallImpl -> ServerCalls -> StreamObserver` 文字总图。
- [ ] 不把本篇写成 API 枚举文或 generated code 模板文。
- [ ] 不把第二篇扩成 transport、拦截器和 Context 大杂烩。
- [ ] 删除代码块后，读者仍能复述四种模式的真正差别。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。
