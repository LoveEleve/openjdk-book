# Nacos：remote / gRPC / RequestHandler / connection / auth — review notes

## 深度 review 结论

本轮按"事实 → 因果 → 结构 → 删码 → 边界"重审后，**当前正文无必须修改的事实性错误**，主线成立，可以收口。

之后已追加一轮深修：把 `GrpcBiStreamRequestAcceptor`、`GrpcRequestAcceptor`、`BaseGrpcServer` 的更细 `file:line` 锚点补回正文，用来把“连接建立时到底补了哪些元信息”“unary 请求在 acceptor 里依次拦了哪些非法情形”“source 不允许时是在哪一层直接打回去”这三条因果链压得更实。

## 第一轮：事实审

### 已复核的关键结论

1. `Request` / `Response` 是 Nacos 的应用层请求响应模型，不是 gRPC 生成类，证据：`api/remote/request/Request.java:29`、`api/remote/response/Response.java:28`。
2. `RequestMeta` 是服务端从连接事实构造出的请求上下文，包含 `connectionId`、`clientIp`、`labels`、`abilityTable` 等，证据：`api/remote/request/RequestMeta.java:35`、`:41`、`:45`、`:124`。
3. protobuf `Payload` 只是统一 wire envelope，Java `Request` / `Response` 会以 JSON bytes 的形式放进 `Any` 里，`metadata.type` 用于反向解析，证据：`common/remote/client/grpc/GrpcUtils.java:53`、`:58`、`:64`、`:117`。
4. `RemoteConstants` 中的 `source/sdk/cluster` 标签是 shared remote substrate 的关键分流标记，证据：`api/remote/RemoteConstants.java:30`、`:32`、`:34`。
5. `BaseGrpcServer` 注册的核心 gRPC 方法是 unary `request` 与 bidi `requestBiStream`，说明业务分发不依赖每个业务单独的 gRPC method，证据：`core/remote/grpc/BaseGrpcServer.java:207`、`:210`、`:227`。
6. `GrpcBiStreamRequestAcceptor` 负责连接建立、能力协商、连接注册与 setup ack，证据：`core/remote/grpc/GrpcBiStreamRequestAcceptor.java:151`、`:158`、`:172`、`:186`；正文现在还补了 `:153`、`:155`、`:156`、`:161`、`:162`、`:163`、`:164`、`:168`、`:169`、`:170`、`:173`、`:190`、`:193`，把 labels/appName、tenant、TLS、abilityTable、注册拒绝条件和 ack 条件压得更细。
7. `GrpcRequestAcceptor` 负责 unary 业务请求路径：startup 检查、handler 查找、连接校验、payload parse、`RequestMeta` 构造与 handler 调用，证据：`core/remote/grpc/GrpcRequestAcceptor.java:90`、`:114`、`:128`、`:146`、`:189`、`:198`；正文现在还补了 `:91`、`:92`、`:98`、`:104`、`:105`、`:109`、`:116`、`:118`、`:129`、`:130`、`:147`、`:159`、`:172`、`:173`、`:191`、`:195`、`:197`，把未启动、server check、无 handler、无连接、parse 失败、非法对象、上下文构造这些分支压得更细。
8. `RequestHandlerRegistry` 会在 context refresh 后统一收集全部 `RequestHandler` beans，建立 request type → handler、TPS 控制点和 invoke source 元数据，证据：`core/remote/RequestHandlerRegistry.java:77`、`:95`、`:105`、`:109`、`:120`。
9. `BaseGrpcServer` 的 source restriction 发生在进入 acceptor 之前，正文现在已补 `core/remote/grpc/BaseGrpcServer.java:188`、`:189`、`:192`、`:193`、`:194`、`:200`、`:202`、`:203`，压实“先 source 校验，失败直接回包，成功才进 acceptor”的顺序。
9. `RequestHandler.handleRequest(...)` 会先跑 `RequestFilters` 再调用真正的业务 `handle(...)`，证据：`core/remote/RequestHandler.java:46`、`:47`、`:58`。
10. `RemoteParamCheckFilter`、`TpsControlRequestFilter`、`RemoteRequestAuthFilter` 分别承担参数校验、TPS 控制、远程鉴权横切职责，证据：`core/remote/grpc/RemoteParamCheckFilter.java:51`、`core/control/remote/TpsControlRequestFilter.java:58`、`core/auth/RemoteRequestAuthFilter.java:72`。
11. `BaseRpcServer` / `BaseGrpcServer` 是 shared substrate，而 `GrpcSdkServer` / `GrpcClusterServer` 主要只在端口、executor、negotiator、plugin、source label 上定制，证据：`core/remote/BaseRpcServer.java:43`、`core/remote/grpc/BaseGrpcServer.java:91`、`core/remote/grpc/GrpcSdkServer.java:48`、`core/remote/grpc/GrpcClusterServer.java:48`。
12. naming/config 并不各自实现 transport stack，而是分别提供自己的 `RequestHandler` 接到 shared substrate 上，证据：`naming/remote/rpc/handler/InstanceRequestHandler.java:46`、`config/server/remote/ConfigQueryRequestHandler.java:60`。

### 测试与辅助证据复核

1. `core/remote/grpc/GrpcRequestAcceptorTest.java:125`、`:192`、`:227`、`:299` — unary 请求路径与异常分支。
2. `core/remote/grpc/GrpcBiStreamRequestAcceptorTest.java:105` — connection setup 路径。
3. `core/remote/RequestHandlerRegistryTest.java:91`、`:97` — handler registry 与 source restriction。
4. `core/remote/RequestFiltersTest.java:36` — filter registration。
5. `core/control/remote/TpsControlRequestFilterTest.java:75`、`:104` — TPS filter。
6. `core/auth/RemoteRequestAuthFilterTest.java:100`、`:114`、`:161` — remote auth filter 行为。

## 第二轮：因果审

- 如果不先否定“gRPC method = business API”，读者会永远在错误层级理解 Nacos remote：当前正文已在开篇破掉这个直觉，成立。✅
- 如果不把 `Payload` 与 Java `Request` / `Response` 的两层协议区分清楚，后面会把 wire protocol 和 application protocol 写混：当前正文已切开，成立。✅
- 如果不把 bi-stream 和 unary 分开，连接语义和业务请求语义会混成一条线：当前正文已分两条通道，成立。✅
- 如果不拉直“transport attrs -> acceptor -> registry -> meta -> filter/auth -> handler”链路，remote 篇会退化成类名清单：当前正文已拉直，成立。✅
- 如果不明确 naming/config 只是 handler 消费者，后续业务篇会反过来错误地侵吞 transport 职责：当前正文已收束，成立。✅

## 第三轮：结构审

### 结构是否跑偏

没有跑偏。正文推进顺序是：

1. 先抓“为什么 gRPC 直觉最容易错”  
2. 再用四个失败方案打掉最常见错误模型  
3. 再建立统一 remote 模型与双通道  
4. 再把完整请求路径拉直  
5. 再切出 source/filter/auth/registry 的相对位置  
6. 最后再说明 base vs concrete server 和 naming/config 的消费者角色  

这保证了正文没有退化成 grpc 类名词典，也没有退化成 naming/config 业务细节提前剧透。✅

### 失败方案是否有效

有效，而且正好命中这一篇最需要先打掉的四种错觉：
- 每个请求类型都对应一个独立的 gRPC 方法  
- 业务模块直接用 protobuf message 端到端通信  
- SDK server 和 cluster server 是两套独立实现  
- 请求从 gRPC 进来就直接落到业务代码  

这四条分别对应 method 层、协议层、server 层、执行链层的常见错位。✅

## 第四轮：删码测试

删除所有代码块后，正文仍然能复述：

- Nacos remote 不是“每业务一个 gRPC 方法”，而是统一 transport substrate  
- `Payload` 是 wire envelope，业务对象是 Java `Request` / `Response`  
- bi-stream 负责连接建立，unary 负责普通业务请求  
- 请求路径要经过 source check、registry、connection/meta、filter/auth 才进 handler  
- naming/config 共享同一套 remote substrate，只在最后一段提供 handler  

删码后主线不塌，说明代码块不是叙事骨架。✅

## 第五轮：边界审

### 本篇边界控制

当前正文边界控制是对的：
- 没深挖 naming 业务语义  
- 没深挖 config query/publish/listen 业务语义  
- 没深挖 cluster 复制语义与 `@InvokeSource(cluster)` 的业务图  
- 没深挖 auth plugin / resource model  
- 重点压在共享 remote substrate 与 business handler 的边界上  

### 与后续篇章的边界

- 第 04 篇可自然接 cluster membership / server-to-server coordination。✅
- naming 篇可接 `InstanceRequestHandler` 背后的真正业务链。✅
- config 篇可接 `ConfigQueryRequestHandler` / publish/listen 的业务链。✅
- auth 篇可接 plugin/resource/permission model。✅
- 本篇自身位置：`vol-nacos` 的 shared remote substrate 立柱篇。✅

## 第六轮：风险点

### 已确认不是问题的点

1. 正文没有把 gRPC method 写成业务 API 粒度。  
2. 正文没有把 protobuf `Payload` 写成业务对象本体。  
3. 正文没有把 SDK server 和 cluster server 写成两套独立栈。  
4. 正文没有把请求路径写成“进来就进业务 handler”。  
5. 正文没有在 remote 篇里过度展开 naming/config 业务细节。  

### 当前仍存在的轻微风险

1. 正文已经补齐关键 remote 主链锚点，但如果后续做整卷统一抛光，仍可继续把 `GrpcUtils`、`AddressTransportFilter`、`GrpcConnectionInterceptor` 的局部路径压得更细。  
2. 这个问题不影响主线正确性，属于进一步精修项。  

## 机械检查

- 禁用表达已复扫；当前命中为 0。✅
- 正文行数：541。✅
- 代码块未承担主叙事骨架。✅
- 主要结论均已落到 file:line。✅
- 正文已经达到 remote 篇所需的长文规模。✅

## 结论

本轮深度 review 后，正文可以认为已经完成收口：

- 事实层面成立  
- 因果链成立  
- 结构推进成立  
- 删码后主线成立  
- 与后续篇章边界清晰  

如果后续要再提升一档，优先项不是改结构，而是补更细的 `GrpcBiStreamRequestAcceptor` / `GrpcRequestAcceptor` / `BaseGrpcServer` 锚点。当前版本不改也可以过关。 
