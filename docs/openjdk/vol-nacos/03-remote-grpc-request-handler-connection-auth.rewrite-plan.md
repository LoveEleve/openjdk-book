# Nacos：remote / gRPC / RequestHandler / connection / auth — rewrite plan

## 篇章定位

- 写作卷：`vol-nacos`
- 章节：`ch02-remote-cluster-auth`
- 篇：`03 Nacos：remote / gRPC / RequestHandler / connection / auth`
- 对应主题：`N-03 remote model`
- 文章类型：共享协议与接入篇
- 正文状态：未开始
- 分析对象：`Nacos 3.0.3`

## 文章定位

- 核心困惑：很多人看到 Nacos 3.x 用了 gRPC，就会自然脑补成“每个 naming/config 接口各自对应一组 protobuf RPC 方法”。但真实源码并不是这种写法。Nacos 的远程模型是：业务请求先被包装成统一 `Payload`，再通过 shared gRPC substrate 进入服务端，经过 source 限制、连接查验、filter、auth、`RequestMeta` 构造，最后才分发给具体的 `RequestHandler`。问题不是“它用了 gRPC 吗”，而是：**它到底怎样把 gRPC 降格成 transport，把 Java `Request`/`Response` 提升成真正的应用层协议。**
- 一句话顿悟：Nacos 3.0.3 不是“gRPC method = business API”，而是**统一 `Payload` 外壳 + Java `Request`/`Response` 作为应用层对象 + shared SDK/cluster gRPC server + `RequestHandlerRegistry` 按请求类型分发**。naming/config 并不各自持有一套 transport stack，它们只是把自己的 handler 插进同一条 remote substrate。
- 文章边界：本篇重点讲 `Request` / `Response` / `RequestMeta` / `RemoteConstants`、`GrpcUtils`、`BaseRpcServer` / `BaseGrpcServer`、`GrpcRequestAcceptor` / `GrpcBiStreamRequestAcceptor`、`RequestHandlerRegistry`、`AbstractRequestFilter`、`RemoteRequestAuthFilter` 的组合路径；不深讲 naming/config 的业务处理细节，不深讲 cluster 复制语义，不深讲 auth plugin 内部实现。

## 前置依赖

### HARD

- `01-nacos-source-map-modules-runtime-assembly.md`
- `02-shared-kernel-core-sys-startup-cluster-remote-auth.md`

### SOFT

- 对 gRPC 有基本直觉会有帮助，但不是前提。
- 对 Spring 上下文中 bean 注册和 filter 链有直觉会有帮助，但不是前提。

### NAV

- 后续可接：cluster server-to-server 请求、auth plugin、naming handler 业务链、config handler 业务链。

## 一句话困惑

Nacos 3.x 的 remote/gRPC 到底是“每个业务一个 RPC 方法”，还是“统一 transport + 统一请求分发”？

## 一句话顿悟

Nacos 把 gRPC 当成 shared transport substrate：wire 上只有极少数固定方法，真正的业务分发依赖 `Payload.metadata.type`、`RequestHandlerRegistry`、`RequestMeta`、filter/auth 链和业务 `RequestHandler`。

## 读者理解路径

1. 先否定“gRPC method = business API”这个直觉。
2. 建立统一 remote 模型：`Request` / `Response` / `RequestMeta` / `Payload`。
3. 解释双通道：bi-stream 负责连接建立与维护，unary 负责普通业务请求。
4. 解释从 transport attrs 到 `GrpcRequestAcceptor` 再到 `RequestHandler.handleRequest()` 的完整路径。
5. 解释 `BaseRpcServer` / `BaseGrpcServer` 与 `GrpcSdkServer` / `GrpcClusterServer` 的分工。
6. 解释 source 限制、filter、auth 与 handler registry 的相对位置。
7. 收束到：naming/config 是这条 remote substrate 的消费者，而不是各自实现 transport。

## 失败方案推演

### 失败方案一：每个请求类型都对应一个独立的 gRPC 方法

- 真正注册到 server 的 gRPC 方法很少，核心是 unary `request` 和 bi-stream `requestBiStream`。
- 真正的业务分发不靠 gRPC method name，而靠 `Payload.metadata.type` 和 `RequestHandlerRegistry`。
- 所以 gRPC 只是 transport，不是业务 API 路由表。

### 失败方案二：业务模块直接用 protobuf message 端到端通信

- 真正的 wire 外壳是 protobuf `Payload`。
- 但 business request/response 仍然是 Java `Request` / `Response` 对象，被 JSON 序列化进 `Any` 里。
- 所以 transport protocol 和 application protocol 在 Nacos 里是分层的。

### 失败方案三：SDK server 和 cluster server 是两套独立实现

- 两者共享 `BaseGrpcServer` 的绝大部分逻辑。
- 差异主要是端口、executor、source label、plugin/interceptor、negotiator。
- 所以它们是 shared substrate 上的两个 concrete variant，不是两套 transport stack。

### 失败方案四：请求从 gRPC 进来后会直接落到 naming/config 业务方法

- 中间还要经过 source check、handler lookup、connection 校验、parse、`RequestMeta` 构造、`RequestContext` 设置、filter 链、auth 等阶段。
- 所以业务 handler 只是远程请求路径的最后一段。

## 必须澄清的误解

1. gRPC method 不是业务 API 粒度。
2. `Payload` 只是统一 wire envelope，真正业务对象还是 Java `Request` / `Response`。
3. `Request.getModule()` 不是 dispatch key，真正分发靠 request class simple name。
4. SDK server 和 cluster server 共享同一 remote substrate。
5. naming/config handler 是 remote substrate 的消费者，不是 transport 栈作者。

## 文章结构与字数预算

1. 困惑开场：为什么 Nacos 的 gRPC 直觉最容易错（800-1000 字）
2. 统一 remote 模型：`Request` / `Response` / `RequestMeta` / `Payload`（1400-2000 字）
3. 双通道：bi-stream 连接建立 vs unary 业务请求（1400-2000 字）
4. 完整请求路径：transport attrs → acceptor → handler（2200-3000 字）
5. `BaseRpcServer` / `BaseGrpcServer` vs `GrpcSdkServer` / `GrpcClusterServer`（1600-2200 字）
6. source 限制、filter、auth、registry 的相对位置（1600-2200 字）
7. naming/config 如何共享这条 substrate（1000-1400 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-13000` 字；代码块不计入目标。

## 证据清单

- `api/remote/request/Request.java:29` — Request base model
- `api/remote/response/Response.java:28` — Response base model
- `api/remote/request/RequestMeta.java:35` — RequestMeta server-side context
- `api/remote/RemoteConstants.java:30` — source / sdk / cluster labels
- `api/remote/request/ConnectionSetupRequest.java:28` — setup request
- `api/remote/request/SetupAckRequest.java:29` — setup ack
- `common/remote/client/grpc/GrpcUtils.java:53` — Request/Response → Payload convert
- `common/remote/client/grpc/GrpcUtils.java:117` — Payload parse back to Java class
- `core/remote/grpc/AddressTransportFilter.java:48` — transport attrs
- `core/remote/grpc/GrpcConnectionInterceptor.java:41` — attrs into gRPC context
- `core/remote/grpc/BaseGrpcServer.java:207` — unary / bidi service registration
- `core/remote/grpc/GrpcBiStreamRequestAcceptor.java:151` — connection setup path
- `core/remote/ConnectionManager.java:102` — connection registration
- `core/remote/grpc/GrpcRequestAcceptor.java:90` — unary request path
- `core/remote/RequestHandlerRegistry.java:77` — handler bean discovery
- `core/remote/RequestHandler.java:46` — filter + business handle wrapper
- `core/remote/AbstractRequestFilter.java:44` — filter registration
- `core/control/remote/TpsControlRequestFilter.java:58` — TPS filter
- `core/auth/RemoteRequestAuthFilter.java:72` — remote auth filter chain
- `core/remote/grpc/BaseRpcServer.java:43` — shared RPC lifecycle
- `core/remote/grpc/BaseGrpcServer.java:91` — shared gRPC substrate
- `core/remote/grpc/GrpcSdkServer.java:48` — SDK concrete server
- `core/remote/grpc/GrpcClusterServer.java:48` — cluster concrete server
- `naming/remote/rpc/handler/InstanceRequestHandler.java:46` — naming business handler example
- `config/server/remote/ConfigQueryRequestHandler.java:60` — config business handler example

## 测试与辅助证据

- `core/remote/grpc/GrpcRequestAcceptorTest.java:125`
- `core/remote/grpc/GrpcBiStreamRequestAcceptorTest.java:105`
- `core/remote/RequestHandlerRegistryTest.java:91`
- `core/remote/RequestFiltersTest.java:36`
- `core/control/remote/TpsControlRequestFilterTest.java:75`
- `core/auth/RemoteRequestAuthFilterTest.java:100`

## 版本边界

- 当前分析对象固定为 `Nacos 3.0.3`。
- 不深讲 protobuf schema 生成细节。
- 不深讲 TLS negotiator / handshake 细节。
- 不深讲 business payload 语义（后续 naming/config 篇展开）。
- 不深讲 cluster 复制协议语义。

## 与后续篇章的边界

### 本篇要讲清

- Nacos remote 模型不是“每业务一个 gRPC 方法”。
- 统一的 `Payload` / `Request` / `Response` / `RequestMeta` 分层。
- 完整请求路径与共享 request handler substrate。
- SDK server 与 cluster server 的 shared core / thin variant 分工。

### 本篇不深讲

- naming handler 内部业务语义
- config handler 内部业务语义
- cluster 复制与 `@InvokeSource(cluster)` 的业务含义
- auth plugin / permission model

## 写作后检查

- [ ] 开篇先抓“为什么 gRPC 直觉是错的”，而不是直接列类名。
- [ ] 至少展开 4 个失败方案，且包含“gRPC method = business API”“SDK/cluster 两套独立实现”。
- [ ] 明确给出 transport attrs → acceptor → handler 的完整总图。
- [ ] 明确区分 wire envelope 和 Java application protocol。
- [ ] 每个关键转折都落到 file:line。
- [ ] 删除代码块后，读者仍能复述 remote substrate 与 business handler 的边界。
- [ ] 通过一次性深审收口。
