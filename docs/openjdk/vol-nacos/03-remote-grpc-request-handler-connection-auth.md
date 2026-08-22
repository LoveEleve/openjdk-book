# Nacos：remote / gRPC / RequestHandler / connection / auth

> 基于 Nacos 3.0.3

## 一、困惑开场：为什么 Nacos 的 gRPC 直觉最容易错

一看到 Nacos 3.x 引入 gRPC，很多人脑子里会自动补出一张熟悉的图：

- 每个业务 API 对应一个 gRPC method
- protobuf message 就是业务对象
- naming 自己有一套 remote 接入
- config 自己也有一套 remote 接入

这个直觉很顺，但恰好和 Nacos 3.0.3 的真实 remote 模型错开了。

Nacos 的做法不是“每个业务暴露一组独立 gRPC API”，而是把 gRPC 压到一个更低层的位置：**gRPC 在这里主要是 transport substrate，真正的应用层协议仍然是 Nacos 自己的 `Request` / `Response` / `RequestMeta` / `RequestHandler` 体系。**

换句话说，Nacos 不把业务语义直接写进 gRPC method，而是把：

- 统一的 wire envelope
- 统一的连接建立方式
- 统一的 handler registry
- 统一的 source 限制
- 统一的 filter/auth 链

都先搭起来，然后让 naming/config 这两个业务平面把各自的 handler 插上去。

所以这篇真正要回答的问题不是“它有没有用 gRPC”，而是：**它到底怎样把 gRPC 降格成 transport，把 Java `Request`/`Response` 提升成真正的应用层协议。**

先给一句结论：Nacos 3.0.3 不是“gRPC method = business API”，而是**统一 `Payload` 外壳 + Java `Request`/`Response` 作为应用层对象 + shared SDK/cluster gRPC server + `RequestHandlerRegistry` 按请求类型分发**。naming/config 并不各自持有一套 transport stack，它们只是把自己的 handler 插进同一条 remote substrate。

## 二、先走四条失败的路

### 失败方案一：每个请求类型都对应一个独立的 gRPC 方法

这是最常见的 gRPC 直觉。

但真正看 `BaseGrpcServer.addServices(...)`，你会发现 server 注册的核心方法非常少，重点就是：

- unary `request`
- bidi `requestBiStream`

`core/remote/grpc/BaseGrpcServer.java:207`  
`core/remote/grpc/BaseGrpcServer.java:210`  
`core/remote/grpc/BaseGrpcServer.java:227`

这说明业务请求不是靠“很多 gRPC method 名字”分发的，而是通过更高一层的请求模型完成路由。

所以 Nacos 的 gRPC 不是业务 API 面，而是共享 transport 面。

### 失败方案二：业务模块直接用 protobuf message 端到端通信

如果只看 `Payload`，你很容易以为业务对象也是一套 protobuf schema。

但 `GrpcUtils` 真正做的事情是：把 Java `Request` / `Response` 对象序列化成 JSON bytes，再塞进 protobuf `Any` 里，同时把 `metadata.type` 写成 Java 类的 simple name。  
`common/remote/client/grpc/GrpcUtils.java:53`  
`common/remote/client/grpc/GrpcUtils.java:58`  
`common/remote/client/grpc/GrpcUtils.java:64`

而反向 parse 的时候，又是按 `metadata.type` 到 `PayloadRegistry` 找回 Java 类，再用 Jackson 反序列化。  
`common/remote/client/grpc/GrpcUtils.java:117`  
`common/remote/client/grpc/GrpcUtils.java:122`

所以这里要明确分层：

- **wire protocol**：protobuf `Payload`
- **application protocol**：Java `Request` / `Response`

这两层在 Nacos 里是分开的。

### 失败方案三：SDK server 和 cluster server 是两套独立实现

看见两个 server 名字——`GrpcSdkServer` 和 `GrpcClusterServer`——很容易误以为它们是两条不同的 transport 栈。

但真正共享的大头都在 `BaseRpcServer` 和 `BaseGrpcServer`：

- server 生命周期
- 端口推导
- unary / bidi service 注册
- transport filter
- interceptor
- request acceptor
- connection acceptor
- source check

都在 shared base 里。  
`core/remote/BaseRpcServer.java:43`  
`core/remote/grpc/BaseGrpcServer.java:91`

而 `GrpcSdkServer` 和 `GrpcClusterServer` 主要只是定制：

- 端口 offset
- executor
- plugin/interceptor
- negotiator
- source label

`core/remote/grpc/GrpcSdkServer.java:48`  
`core/remote/grpc/GrpcClusterServer.java:48`

所以它们是 **shared substrate 上的两个 concrete variant**，不是两套独立 remote 栈。

### 失败方案四：请求从 gRPC 进来就直接落到 naming/config 业务代码

这条误解最容易让后面的篇章全写乱。

因为在真正进业务 handler 之前，中间还有一条很长的共享路径：

- transport attrs
- gRPC Context
- source check
- handler lookup
- connection 校验
- parse
- `RequestMeta` 构造
- `RequestContext` 设置
- filter 链
- auth
- 最后才是 business `handle(...)`

所以 naming/config 的 handler 只是这条 remote 请求链的最后一段，不是整条 remote 请求链本身。

## 三、统一 remote 模型：`Request` / `Response` / `RequestMeta` / `Payload`

### 3.1 `Request` 是应用层请求，不是 transport 消息

Nacos 的 `Request` 是应用层基类，不是 gRPC 生成类。它自带：

- case-insensitive headers
- `requestId`
- 逻辑上的 `getModule()`

`api/remote/request/Request.java:29`  
`api/remote/request/Request.java:31`  
`api/remote/request/Request.java:102`

这里最容易误读的一点是：`getModule()` 不是 transport routing key。它只是应用层逻辑标签，不是请求分发主键。

### 3.2 `Response` 也是应用层响应

`Response` 自带：

- `resultCode`
- `errorCode`
- `message`
- `requestId`

`api/remote/response/Response.java:28`  
`api/remote/response/Response.java:61`  
`api/remote/response/Response.java:119`

所以 Nacos 的成功/失败语义首先是应用层的，不是完全依赖 gRPC status code 表达。

### 3.3 `RequestMeta` 是 server-side 视角的上下文

`RequestMeta` 很关键，因为它说明服务端真正信任的上下文不是请求体自己带的随意字段，而是：

- `connectionId`
- `clientIp`
- `clientVersion`
- `labels`
- `appLabels`
- `abilityTable`

`api/remote/request/RequestMeta.java:35`  
`api/remote/request/RequestMeta.java:41`  
`api/remote/request/RequestMeta.java:45`  
`api/remote/request/RequestMeta.java:124`

这说明 remote path 里有一层重要工作：把“连接侧事实”提炼成 server-side request context。

### 3.4 `Payload` 只是统一 wire envelope

真正的 wire 外壳是 protobuf `Payload`，但 business object 并不是 protobuf 业务消息，而是被 JSON 化后放进 `Any`。

这一层由 `GrpcUtils` 统一处理：

- convert 时写 `metadata.type = requestClassSimpleName`  
  `common/remote/client/grpc/GrpcUtils.java:58`
- body 用 JSON bytes 封进 `Any`  
  `common/remote/client/grpc/GrpcUtils.java:64`
- parse 时按 `metadata.type` 回查 Java 类并反序列化  
  `common/remote/client/grpc/GrpcUtils.java:117`

这一步是整篇最关键的顿悟之一：**Nacos 的 remote model 不是 protobuf 业务模型，而是 Java 应用层对象 + protobuf 统一信封。**

### 3.5 `source` 是关键标签

`RemoteConstants` 里有几个关键标签：

- `source`
- `sdk`
- `cluster`

`api/remote/RemoteConstants.java:30`  
`api/remote/RemoteConstants.java:32`  
`api/remote/RemoteConstants.java:34`

这为后面的 source restriction 铺路：同一套 remote substrate 上，SDK 客户端和集群节点并不是“完全一样的来客”。

## 四、双通道：bi-stream 负责建连接，unary 负责跑业务请求

### 4.1 先别把所有请求混成一类

Nacos 的 remote path 至少要先分成两条：

- **bi-stream**：负责连接建立、保持和 server 主动回推基础
- **unary request**：负责普通业务请求/响应

如果不先把这两条路切开，就会把连接语义和业务请求语义写混。

### 4.2 bi-stream：连接建立路径

在 `GrpcBiStreamRequestAcceptor` 中，第一条消息如果是 `ConnectionSetupRequest`，服务端会：

- 解析 setup request
- 取出 labels 与 appName
- 构造 `ConnectionMeta`
- 记录 tenant / TLS 保护状态
- 创建 `Connection`
- 写入 client 能力表
- 判断 server 是否已启动、是否允许注册
- 注册到 `ConnectionManager`

`core/remote/grpc/GrpcBiStreamRequestAcceptor.java:151`、`:152` 说明它先识别并取出 `ConnectionSetupRequest`。  
`core/remote/grpc/GrpcBiStreamRequestAcceptor.java:153`、`:155`、`:156` 说明它会先抽 labels 和 `appName`。  
`core/remote/grpc/GrpcBiStreamRequestAcceptor.java:158`、`:159`、`:160`、`:161` 说明它把 client 版本、地址、tenant 等装进 `ConnectionMeta`。  
`core/remote/grpc/GrpcBiStreamRequestAcceptor.java:162`、`:163`、`:164` 说明它还会从 channel 属性里补 TLS 保护状态。  
`core/remote/grpc/GrpcBiStreamRequestAcceptor.java:165`、`:166` 说明它通过 delegate 生成真正的 `Connection`。  
`core/remote/grpc/GrpcBiStreamRequestAcceptor.java:168`、`:169`、`:170` 说明它会把 client `abilityTable` 写入连接对象。  
`core/remote/grpc/GrpcBiStreamRequestAcceptor.java:172`、`:173` 说明它会先根据 server startup 状态与限流结果判断要不要拒绝注册。  
`core/remote/ConnectionManager.java:102` 是注册入口。  

连接注册成功后，服务端还可能通过同一条 stream 发回 `SetupAckRequest`，把 server ability table 带回去。  
`core/remote/grpc/GrpcBiStreamRequestAcceptor.java:186`、`:187`、`:190`、`:193` 说明它只在 client 带了 ability table 的情况下回发 setup ack。  

所以 bi-stream 的主职责不是跑业务 handler，而是先把“你是谁、你连上来了、你有什么能力”这件事说清。

### 4.3 unary：普通业务请求路径

普通业务请求则主要走 `GrpcRequestAcceptor.request(...)`。

这条路径会负责：

- 检查 server 是否 ready
- 处理特例请求如 `ServerCheckRequest`
- 查 handler
- 校验 `connectionId`
- parse `Payload`
- 确认 parse 出来的真是 `Request`
- 构造 `RequestMeta`
- 进入 handler 包装链

`core/remote/grpc/GrpcRequestAcceptor.java:90`、`:91`、`:92`、`:98` 说明 server 未启动时会立即返回错误响应并记录 metrics。  
`core/remote/grpc/GrpcRequestAcceptor.java:104`、`:105`、`:109` 说明 `ServerCheckRequest` 会走专门的快速路径。  
`core/remote/grpc/GrpcRequestAcceptor.java:114`、`:116`、`:118` 说明先按 request type 查 handler，查不到就直接返回 `NO_HANDLER`。  
`core/remote/grpc/GrpcRequestAcceptor.java:128`、`:129`、`:130` 说明它会先按 `connectionId` 验证连接是否仍然有效。  
`core/remote/grpc/GrpcRequestAcceptor.java:144`、`:146`、`:147` 说明真正的 payload parse 发生在这里。  
`core/remote/grpc/GrpcRequestAcceptor.java:159`、`:172`、`:173` 说明 parse 结果还会继续区分“null”与“不是 Request”两种非法情形。  
`core/remote/grpc/GrpcRequestAcceptor.java:189`、`:190`、`:191`、`:195`、`:197`、`:198` 说明最后才从连接对象构造 `RequestMeta`、刷新活跃时间、准备上下文并进入 handler。  

这说明业务请求不是靠“长连接通道自动变成业务调用”，而是 unary 路径上仍然有一套完整的服务端检查与分发逻辑。

## 五、完整请求路径：从 transport attrs 到 business handler

这一节是整篇最重要的主干。

### 5.1 transport attrs：底层连接刚建立时先记住地址信息

`AddressTransportFilter.transportReady(...)` 会先把：

- remote socket address
- local socket address
- `connectionId`

写进 gRPC transport attrs。  
`core/remote/grpc/AddressTransportFilter.java:48`  
`core/remote/grpc/AddressTransportFilter.java:56`  
`core/remote/grpc/AddressTransportFilter.java:57`

这说明一开始 server 拿到的不是 business request，而是 transport-level 事实。

### 5.2 interceptor：把 transport attrs 提升到 gRPC Context

`GrpcConnectionInterceptor.interceptCall(...)` 会把这些 transport attrs 搬进 gRPC `Context`，对 bi-stream 场景还会额外暴露 Netty `Channel`。  
`core/remote/grpc/GrpcConnectionInterceptor.java:41`  
`core/remote/grpc/GrpcConnectionInterceptor.java:49`  
`core/remote/grpc/GrpcConnectionInterceptor.java:50`

这一步的意义是：后面的 acceptor 不需要重新摸 socket，而是直接从 Context 拿连接侧事实。

### 5.3 `BaseGrpcServer`：先做 source 限制，再进 acceptor

`BaseGrpcServer.handleCommonRequest(...)` 做的第一件大事，不是 parse payload，而是先检查这个 concrete server 的 source 是否允许处理当前请求类型。  
`core/remote/grpc/BaseGrpcServer.java:188`、`:189` 说明 source 校验直接依赖 `requestHandlerRegistry.checkSourceInvokeAllowed(...)`。  
`core/remote/grpc/BaseGrpcServer.java:192`、`:193`、`:194`、`:200` 说明 source 不允许时，它会直接构造错误响应并记录 metrics。  

只有 source 允许，才会继续把请求转给 `GrpcRequestAcceptor.request(...)`。  
`core/remote/grpc/BaseGrpcServer.java:202`、`:203`

这一步非常关键，因为它把“SDK 请求”和“cluster 内部请求”先在 transport 入口处分流了。

### 5.4 `RequestHandlerRegistry`：统一注册 handler，而不是各模块自己维护映射

`RequestHandlerRegistry` 在 `ContextRefreshedEvent` 时收集所有 `RequestHandler` beans：  
`core/remote/RequestHandlerRegistry.java:77`  
`core/remote/RequestHandlerRegistry.java:78`  
`core/remote/RequestHandlerRegistry.java:79`

然后它会做几件共享工作：

- 读取 `handle()` 方法上的 `@TpsControl`，注册 TPS point  
  `core/remote/RequestHandlerRegistry.java:95`  
  `core/remote/RequestHandlerRegistry.java:96`  
  `core/remote/RequestHandlerRegistry.java:99`
- 从泛型参数解析这个 handler 面向的请求类型  
  `core/remote/RequestHandlerRegistry.java:105`
- 读取类上的 `@InvokeSource`，为这个请求类型登记允许来源  
  `core/remote/RequestHandlerRegistry.java:109`  
  `core/remote/RequestHandlerRegistry.java:110`  
  `core/remote/RequestHandlerRegistry.java:113`
- 最终注册 `requestSimpleName -> handler` 映射  
  `core/remote/RequestHandlerRegistry.java:120`

所以 dispatch key 不是 gRPC method name，也不是 `Request.getModule()`，而是 **request class simple name**。

### 5.5 `GrpcRequestAcceptor`：连接校验、parse、`RequestMeta` 构造

进入 `GrpcRequestAcceptor.request(...)` 之后，服务端才真正开始：

- 检查连接是否已经在 `ConnectionManager` 里注册
- 解析 `Payload`
- 基于 `ConnectionMeta` 和 ability table 构造 `RequestMeta`

`core/remote/grpc/GrpcRequestAcceptor.java:128`  
`core/remote/grpc/GrpcRequestAcceptor.java:146`  
`core/remote/grpc/GrpcRequestAcceptor.java:189`  
`core/remote/grpc/GrpcRequestAcceptor.java:190`  
`core/remote/grpc/GrpcRequestAcceptor.java:194`  
`core/remote/grpc/GrpcRequestAcceptor.java:195`

这一层的重点是：server-side request context 并不是请求体自报的，而是连接建立阶段就记下来的事实和能力协商结果。

### 5.6 `RequestHandler.handleRequest(...)`：filter 链先跑，再进真正业务 handle

选到 handler 以后，不会直接进业务 `handle(...)`，而是先经过 `RequestHandler.handleRequest(...)` 包装链：  
`core/remote/RequestHandler.java:46`  
`core/remote/RequestHandler.java:47`  
`core/remote/RequestHandler.java:58`

这意味着所有 remote 请求都会统一经过 shared filter chain，然后才进具体业务逻辑。

## 六、source 限制、filter、auth、registry 的相对位置

这一节最容易写乱，所以必须把相对位置钉住。

### 6.1 source restriction：决定“这个 server 能不能接这种请求”

source restriction 最早发生在 `BaseGrpcServer.handleCommonRequest(...)`。  
`core/remote/grpc/BaseGrpcServer.java:188`

它依赖的是：

- 当前 concrete server 的 `source`（`sdk` 还是 `cluster`）
- `RequestHandlerRegistry` 里对请求类型登记的允许来源集合

这一步决定的是：**这个 server 能不能接这类请求**。

### 6.2 registry：决定“哪一个 handler 处理这个请求”

registry 关心的是 request type 到 handler 的映射。

它回答的是：**找到谁来处理。**

### 6.3 filter：决定“这个请求能不能继续往后走”

`AbstractRequestFilter.init()` 会把 filter 自动注册到 `RequestFilters`。  
`core/remote/AbstractRequestFilter.java:44`  
`core/remote/AbstractRequestFilter.java:46`  
`core/remote/RequestFilters.java:33`

之后 `RequestHandler.handleRequest(...)` 会统一跑这些 filter。  
`core/remote/RequestHandler.java:47`

### 6.4 参数与 TPS filter

比如：

- `RemoteParamCheckFilter` 会按 handler/method 上的 extractor 定义去抽参数并校验  
  `core/remote/grpc/RemoteParamCheckFilter.java:51`  
  `core/remote/grpc/RemoteParamCheckFilter.java:58`  
  `core/remote/grpc/RemoteParamCheckFilter.java:63`
- `TpsControlRequestFilter` 会按 `@TpsControl` 信息做阈值判断，必要时返回 `OVER_THRESHOLD` 失败响应  
  `core/control/remote/TpsControlRequestFilter.java:58`  
  `core/control/remote/TpsControlRequestFilter.java:65`  
  `core/control/remote/TpsControlRequestFilter.java:84`

### 6.5 auth：决定“身份和权限是否过关”

`RemoteRequestAuthFilter` 的顺序也很清楚：

- 先从 handler 上拿 `@Secured` 元数据  
  `core/auth/RemoteRequestAuthFilter.java:72`  
  `core/auth/RemoteRequestAuthFilter.java:73`  
  `core/auth/RemoteRequestAuthFilter.java:74`
- 再看 inner API 和 auth 开关是否允许短路  
  `core/auth/RemoteRequestAuthFilter.java:76`  
  `core/auth/RemoteRequestAuthFilter.java:80`
- 再做 server identity 检查，identity 已匹配时可直接放行  
  `core/auth/RemoteRequestAuthFilter.java:86`  
  `core/auth/RemoteRequestAuthFilter.java:87`  
  `core/auth/RemoteRequestAuthFilter.java:92`
- 若还需鉴权，则补 `X-Real-IP`，解析资源、解析身份、先验 identity 再验 authority  
  `core/auth/RemoteRequestAuthFilter.java:100`  
  `core/auth/RemoteRequestAuthFilter.java:101`  
  `core/auth/RemoteRequestAuthFilter.java:102`  
  `core/auth/RemoteRequestAuthFilter.java:103`  
  `core/auth/RemoteRequestAuthFilter.java:104`  
  `core/auth/RemoteRequestAuthFilter.java:112`  
  `core/auth/RemoteRequestAuthFilter.java:113`  
  `core/auth/RemoteRequestAuthFilter.java:114`

所以 auth 也不是“业务 handler 里自己判断权限”，而是 shared remote substrate 先拦住。

## 七、`BaseRpcServer` / `BaseGrpcServer` vs `GrpcSdkServer` / `GrpcClusterServer`

### 7.1 `BaseRpcServer`：通用 server 生命周期地板

`BaseRpcServer` 持有的是更上层的 server 生命周期共性：

- payload registry 初始化
- `@PostConstruct start()`
- 端口 = 主端口 + offset
- shutdown hook
- TLS/protocol refresh hook

`core/remote/BaseRpcServer.java:36`  
`core/remote/BaseRpcServer.java:43`  
`core/remote/BaseRpcServer.java:50`  
`core/remote/BaseRpcServer.java:107`

### 7.2 `BaseGrpcServer`：真正的共享 gRPC substrate

`BaseGrpcServer` 则继续往下承接：

- unary + bidi service 注册
- transport filters / interceptors
- executor
- source allow check
- acceptor 委派

`core/remote/grpc/BaseGrpcServer.java:91`  
`core/remote/grpc/BaseGrpcServer.java:171`  
`core/remote/grpc/BaseGrpcServer.java:177`  
`core/remote/grpc/BaseGrpcServer.java:186`  
`core/remote/grpc/BaseGrpcServer.java:207`

### 7.3 `GrpcSdkServer` 和 `GrpcClusterServer` 真正定制了什么

`GrpcSdkServer` 主要定制：

- SDK port offset
- SDK executor
- SDK config keys
- SDK protocol negotiator
- SDK transport plugins
- `source = sdk`

`core/remote/grpc/GrpcSdkServer.java:48`  
`core/remote/grpc/GrpcSdkServer.java:54`  
`core/remote/grpc/GrpcSdkServer.java:121`

`GrpcClusterServer` 也是对称地定制：

- cluster port offset
- cluster executor
- cluster config keys
- cluster negotiator
- cluster plugins
- `source = cluster`

`core/remote/grpc/GrpcClusterServer.java:48`  
`core/remote/grpc/GrpcClusterServer.java:54`  
`core/remote/grpc/GrpcClusterServer.java:132`

所以 shared 的大头都在 base，concrete server 只是把参数、插件、source 标签换掉。

## 八、naming/config 只是这条 remote substrate 的消费者

这一步是本篇的收束点。

### 8.1 naming handler 不是 naming 自己的 transport 栈

`InstanceRequestHandler` 只是一个 `RequestHandler` bean，它接入的是 shared registry、shared filter、shared auth、shared request path，最后才在 `handle(...)` 里调用 naming 业务逻辑。  
`naming/remote/rpc/handler/InstanceRequestHandler.java:46`  
`naming/remote/rpc/handler/InstanceRequestHandler.java:58`  
`naming/remote/rpc/handler/InstanceRequestHandler.java:75`

### 8.2 config handler 也是同一套 substrate 的消费者

`ConfigQueryRequestHandler` 一样只是 shared remote substrate 上的一个业务终点。  
`config/server/remote/ConfigQueryRequestHandler.java:60`  
`config/server/remote/ConfigQueryRequestHandler.java:71`  
`config/server/remote/ConfigQueryRequestHandler.java:86`

### 8.3 这就是 remote 篇最稳的结论

所以 naming/config 在 remote 这一层并不是“各自暴露了一套 transport API”，而是：

- 共享 `Payload`
- 共享 gRPC server
- 共享 request acceptor
- 共享 handler registry
- 共享 filter / auth / context
- 最后才进入各自不同的业务 `handle(...)`

## 九、误解澄清

### 误解一：每个业务请求都对应一个 gRPC 方法

不是。核心只有少量固定 gRPC 方法，业务分发靠 request type。

### 误解二：protobuf message 就是业务对象

不是。protobuf `Payload` 只是统一 wire envelope，真正业务对象还是 Java `Request` / `Response`。

### 误解三：SDK server 和 cluster server 是两套独立 transport 实现

不是。它们共享 `BaseGrpcServer`，只是 source/port/executor/plugin 定制不同。

### 误解四：请求进来后会直接落到 naming/config 业务方法

不是。中间还有 source check、registry、connection 校验、`RequestMeta`、filter、auth 等一整条共享路径。

### 误解五：`Request.getModule()` 就是 dispatch key

不是。真正 dispatch key 是 request class simple name 和 handler registry。

## 十、收网总结：Nacos 是“统一 transport + 统一分发”，不是“每业务一套 gRPC API”

回到开头的问题：Nacos 的 gRPC 到底是怎样工作的？

答案不是“每个业务一个 gRPC 方法”，而是：Nacos 把 gRPC 压成统一 transport substrate，把 Java `Request` / `Response` 提升成应用层协议，再通过 shared SDK/cluster server、handler registry、filter/auth/context 链，把请求送到 naming/config 等业务 handler。

把整篇压成三句话：

1. Nacos remote 模型里，wire 外壳是 protobuf `Payload`，应用层协议仍然是 Java `Request` / `Response` / `RequestMeta`。  
2. 请求路径不是“gRPC 直接进业务”，而是 `transport attrs -> acceptor -> registry -> connection/meta -> filter/auth -> business handler`。  
3. naming/config 不是各自实现 transport 栈，而是共享同一条 remote substrate，只在最后一段提供自己的 `RequestHandler`。  
