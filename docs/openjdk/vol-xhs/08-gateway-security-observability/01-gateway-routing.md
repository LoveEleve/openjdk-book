# 01 Gateway Routing：为什么这套网关不是简单的 Path 转发

在 `my-xhs` 里，Gateway 并不是一个把 `/api/**` 原样转给下游服务的薄转发层。它是整套系统唯一稳定的北向入口：用户登录后的 JWT 要先在这里被识别，写请求的 HMAC 签名要先在这里被验掉，流量染色、灰度标记、Sentinel 限流、TraceId 注入和下游路由也都在这里收口。所以读者真正容易困惑的问题不是“`application.yml` 里配了多少条路由”，而是另一句更接近生产现实的话：当一个请求打到 `19000` 端口时，Gateway 到底先做什么、后做什么，以及为什么这些动作必须放在 Gateway 而不是分散到 16 个服务里。

如果这个问题不先讲清，后面写 JWT、HMAC、Sentinel 和可观测性时就会不断陷入局部视角。你会看到 `GatewayAuthFilter`、`HmacSignatureFilter`、`RateLimitFilter` 这些类都存在，也会看到 `spring.cloud.gateway.routes` 里定义了很多 `lb://my-xhs-*` 路由，但仍然很难解释三个生产级现象：第一，为什么缺签名的请求应该先被 403，而不是先吃掉限流配额再说；第二，为什么网关要自己注入 `X-Trace-Id` 和 `sw8`，不能等下游服务各自补；第三，为什么这个项目明明只部署了一台网关，仍然要在路由、过滤器顺序、Redis、Nacos 和 Sentinel 之间提前埋下多实例扩展的接口。

本篇就围绕这个入口问题展开。它不是专门讲 JWT，也不是专门讲 HMAC，而是先把 Gateway 当成“入口编排器”来看：路由如何定义，过滤器链如何排序，请求头如何被改写，限流规则如何从路由元数据落到 Sentinel，灰度与版本标记如何在入口被写入，最后请求又如何被送进具体服务。只有这张总图先立住，后面的 `02-jwt-hmac.md`、`03-sentinel-limit.md` 和 `04-observability.md` 才不会变成一堆横向并列的机制清单。

## 先给结论：Gateway 在这里承担的是四层入口职责

先别急着抠源码，先记住本篇最重要的人话答案：`my-xhs-gateway` 干的不是单一的“转发”，而是把四层入口职责叠在一个地方。

第一层是路由收口。所有北向访问都先打到 `19000` 端口，再按路径分发到 `user`、`content`、`search`、`order`、`payment` 等服务；AI 诊断台这种特殊入口还会在这里做路径改写，把 `/ai-api/**` 改成后端真正理解的 `/api/**` 语义。第二层是安全收口。JWT 鉴权、Token 黑名单、HMAC 防篡改、防重放、用户身份透传都在这里完成，避免每个服务各自做一套半吊子门禁。第三层是流量治理收口。TraceId、灰度标记、AB 分组、压测标记和 Sentinel 限流都在进入业务域之前定下来，让后续服务在一个已经被规范化的入口上下文里工作。第四层是运行时观测收口。入口日志、Trace Header、统一响应码和路由级限流告警都在这里落第一锚点。

如果把这四层职责分散给每个业务服务，直觉上好像更“简单”：用户服务自己验 Token，订单服务自己防重放，搜索服务自己限流，支付服务自己打入口日志。问题在于，这种简单只在单服务里成立，一旦系统拆成 16 个模块，就会立刻出现四类故障：同一条请求在不同服务被不同规则解释；非法请求已经打进服务内部才发现；日志和 trace 无法在入口统一关联；以及每个服务都要维护自己的一套边界名单，改一条公开路径要改很多地方。Gateway 的价值，恰恰是把这些入口层的“重复复杂度”从业务服务里抽出来，集中承担。

所以本篇真正要解释的不是“它配了几条 route”，而是“为什么这条入口链必须先做一轮标准化，再把请求交给业务服务”。

## 直觉方案为什么不够：只靠 Path 转发的网关很快会失去控制

最朴素的 Gateway 写法其实非常常见：在 `application.yml` 里给每个服务配一条 `Path=/api/xxx/**` 到 `lb://service-name` 的路由，然后让请求透传。这样的 Gateway 在 demo 里完全够用，因为 demo 不需要回答身份、签名、防刷、压测、灰度和链路追踪这些问题。

但 `my-xhs` 不是这种场景。它前面已经有用户登录与 JWT、内容发布、下单支付、通知 SSE、IM WebSocket、搜索推荐这些主链；如果 Gateway 只做 Path 转发，至少会立刻暴露五个缺口。

第一个缺口是身份无法在入口统一成立。下游服务必须知道当前请求对应谁，否则购物车、订单、通知、IM 都没法判断用户上下文。最粗暴的办法是每个服务都自己解析 `Authorization` 里的 JWT，但这会把签名密钥、Token 类型校验、黑名单查询和异常响应复制到所有模块，最后每个模块都长出一份不完全一致的鉴权逻辑。`my-xhs` 反而选了另一条路：让 Gateway 先验完 JWT，再把可信的 `X-User-Id`、`X-User-Role` 和 `X-Trace-Id` 写到请求头里，下游服务只消费已经标准化的入口结果。源码里 `GatewayAuthFilter` 正是在做这件事，且它用 `headers.set()` 覆盖而不是追加，目的就是防止客户端伪造同名头混进下游服务。这里不是为了省几行代码，而是在建立“身份真源只能来自 Gateway”这一条入口约束。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:126`

第二个缺口是写请求的防篡改和防重放。JWT 只能证明“你是谁”，不能证明“这次提交的参数没在中途被改”，也不能阻止同一笔有效请求被重放多次。尤其是库存、订单、支付、发帖、互动这些写链路，一旦入口不做 HMAC 和 nonce 去重，就只能把所有重复提交风险留给下游服务各自兜底。`my-xhs` 的做法是把公开读接口和认证接口放进 HMAC 白名单，而把非白名单路径统一要求携带 `X-Timestamp`、`X-Nonce`、`X-Signature`，然后在网关层先做时间窗口校验、Redis 原子去重和 per-session secret 验签。这样真正非法的请求会在进入业务服务前就被 403 掉，而不是先消耗库存、锁、线程和数据库连接。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:122`

第三个缺口是流量标记无法在系统里统一传播。灰度、AB 分组、压测流量、API 版本这些属性，如果等到下游服务再各自决定，就会变成“入口认知分裂”：Gateway 以为这是普通流量，搜索服务以为这是灰度流量，订单服务又把它当压测流量。这种系统级元数据必须在最早入口定下来，再一路往后传。`TrafficColoringFilter` 就是为此存在的：它把 `X-Gray-Tag`、`X-Api-Version`、`X-AB-Group`、`X-Pressure-Test` 和 `X-Forwarded-For` 在鉴权之后统一落到请求头里。后面哪怕只有一台网关，这套入口协议也已经替多实例、灰度和压测预留好了接口。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/TrafficColoringFilter.java:95`

第四个缺口是限流容易打偏。很多业务系统一开始会在下游 Controller 上用注解做本地限流，看起来也能工作。但对微服务来说，这意味着非法请求、未鉴权请求和签名错误请求都已经先穿透了网关。它们即便最后被拒绝，也先消耗了后端实例、线程池和数据库侧资源。`my-xhs` 反过来把 Sentinel 限流放在 Gateway，规则又不是硬编码在某个服务类里，而是从每条 route 的 metadata 里读出 `rate-limit-qps` 后统一装载到 `GatewayRuleManager`。这样“订单比搜索更严格、支付比订单更严格、公开内容比交易链更宽松”的差异化限制，天然就跟路由绑定在一起了。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:177`

第五个缺口是可观测性没有第一锚点。入口日志如果分散到每个服务，链路一旦跨 Gateway、Feign、MQ、SSE、WebSocket，就很难先确认“这次请求有没有真的进系统”。`RequestLogFilter` 在最前面生成或透传 `X-Trace-Id`，同时补 `sw8` 头，把业务 TraceId 和 SkyWalking 跨进程传播强行钉在系统最北边。这样后面哪怕是下游服务日志丢了、某条 Feign 调用断了、某个消费者异步执行了，排障时也总有一个入口 trace 可追。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RequestLogFilter.java:49`

这些缺口共同说明一件事：只做 Path 转发的 Gateway 在 demo 里够用，在这套系统里不够。`my-xhs` 的 Gateway 必须先把请求变成“已经带身份、带签名判定、带流量标签、带 trace、带限流语义的标准化请求”，然后才交给业务服务。

## 先看入口总图：一条请求从 19000 进来后会经过什么

先把这条入口链用文字图立住，后面再回到各个实现细节：

```text
客户端
  -> Gateway :19000
      -> RequestLogFilter
          生成/透传 X-Trace-Id，补 sw8，记入站日志
      -> BodyCacheFilter
          对有 body 的写请求缓存请求体，供后续验签使用
      -> GatewayAuthFilter
          白名单放行；非白名单解析 JWT、查黑名单、注入 X-User-Id/X-User-Role
      -> TrafficColoringFilter
          注入灰度、版本、AB、压测等入口标记
      -> HmacSignatureFilter
          非 HMAC 白名单路径校验 timestamp/nonce/signature
      -> RateLimitFilter
          按 route ID 命中 Sentinel Gateway 规则
      -> GrayRouteFilter / ApiVersionFilter
          根据入口标记修正路由语义
      -> Route 定位
          Path=/api/order/** -> lb://my-xhs-order
          Path=/api/search/** -> lb://my-xhs-search
          Path=/ai-api/** -> RewritePath -> lb://my-xhs-ai-app
      -> 下游服务
```

这张图里最需要记住的不是每个类名，而是两个原则。

第一个原则是“先标准化，再转发”。也就是说，请求在被真正交给路由之前，先在入口被补齐身份、签名、trace 和流量元数据。第二个原则是“越靠前的过滤器越负责系统公共契约，越靠后的过滤器越接近具体路由语义”。所以日志、body 缓存、鉴权、HMAC 和限流都在前面，灰度与版本等更偏路由侧的处理则往后摆。

这个顺序不是抽象上的好看，而是由依赖关系逼出来的。HMAC 必须读到 `X-User-Id` 才能去 Redis 拿 per-session secret，所以它依赖 `GatewayAuthFilter` 先完成身份注入。限流不应该把签名非法请求也算进配额，所以 `RateLimitFilter` 必须排在 HMAC 后面。流量染色如果想根据 `X-User-Id` 决定 AB 分组，也必须放在鉴权后面。Body 缓存如果排在 HMAC 后面，验签时就拿不到请求体摘要。这样一路推下来，过滤器顺序其实不是工程偏好，而是一条严格的因果链。

已有测试分析文档也把这条顺序总结为 `RequestLog -> GatewayAuth -> TrafficColoring -> HmacSignature -> RateLimit -> GrayRoute -> ApiVersion`，和源码中的 `Ordered.HIGHEST_PRECEDENCE + offset` 设计是一致的。`docs/test-2/service-analysis/16-gateway/04-jwt-filter-chain.md:98`

## 路由层先立住：Gateway 如何把不同业务域收口到一个入口

从纯路由角度看，`my-xhs-gateway` 的配置并不复杂，但它承载的信息远不止“路径转到哪个服务”。`application.yml` 里把用户、内容、搜索、订单、支付、库存、Analytics、Counter、商品、购物车、优惠券、首页、通知、IM、推荐和 AI 诊断台都收到了 `spring.cloud.gateway.routes` 下，每个 route 至少定义了三类事实：一是 northbound path；二是 southbound `lb://service-name`；三是和这条业务链绑定的元数据，例如 `response-timeout`、`connect-timeout` 和 `rate-limit-qps`。`my-xhs-gateway/src/main/resources/application.yml:92`

这意味着 route 在这里不是单纯的匹配条件，而是“入口治理的最小单位”。例如：

- `user-service` 绑定 `/api/user/**`，超时较短但整体 QPS 控制更严格，体现的是认证入口防暴力破解。`my-xhs-gateway/src/main/resources/application.yml:99`
- `search-service` 绑定 `/api/search/**`，连接和响应超时更激进、QPS 上限最高，体现的是搜索场景更偏高频读流量。`my-xhs-gateway/src/main/resources/application.yml:119`
- `order-service` 和 `payment-service` 的 QPS 分别进一步收紧，同时给更长响应时间，体现的是交易链更容忍单次请求长一些，但不容忍大量并发刷单。`my-xhs-gateway/src/main/resources/application.yml:129`
- `home-service` 的路由元数据说明这是一个 BFF 聚合点，所以超时时间不是最短，而是更接近“多下游并发 + 聚合”的现实。`my-xhs-gateway/src/main/resources/application.yml:205`
- `recommend-service` 单独把 `/api/recommend/**` 指回 `lb://my-xhs-search`，说明推荐入口虽然物理上复用了搜索服务，但 northbound 语义仍被单独保留。这个 route 也是之前真实修复过的缺口：推荐路由曾经缺失，导致入口层面根本不可达。`my-xhs-gateway/src/main/resources/application.yml:232`
- `ai-app-service` 是最特殊的一条：northbound 是 `/ai-api/**`，进入网关后先 `RewritePath=/ai-api/(?<seg>.*), /${seg}`，再转到 `lb://my-xhs-ai-app`，并把响应超时抬到 31 分钟，对齐 AI 后端的 SSE 超时窗口。这说明 Gateway 这里不仅承担普通 HTTP 路由，还承担前端路径兼容和长连接协议适配。`my-xhs-gateway/src/main/resources/application.yml:242`

把 route 理解成“路径 -> 服务”的人，很容易忽略 metadata 的存在；但在 `my-xhs` 里，metadata 正是 route 进入工程化入口的地方。`RateLimitFilter` 后面会直接读取 `GatewayProperties` 里的 `RouteDefinition`，把 `rate-limit-qps` 翻成 Sentinel 的 `GatewayFlowRule`。换句话说，route 不是被限流规则引用，而是 route 本身就是限流规则的配置真源。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:189`

这里还必须补一层运行态事实。根据交接材料，中间件机上的 Nacos 对外是 `21.130.247.89:18848`，Gateway 在本地配置里也显式把 discovery 和 config 都指向这个地址；同时生产运行里微服务流量入口统一走服务机的 `19000` 端口，而不是 compose 里中间件组件自身的 host 端口。也就是说，读 route 配置时必须把三层端口区分开：Gateway northbound 入口是服务端口 `19000`，下游服务真实注册端口是 `19001~19016`，而 Nacos、Redis、MQ、Prometheus 等则是另一套中间件 host 端口。混掉这三层，文章很容易把“网关的请求入口”和“中间件的宿主端口”写成一回事。`docs/openjdk/vol-xhs/HANDOFF-XHS-CONTINUATION.md:142` `my-xhs-gateway/src/main/resources/application.yml:41`

## 过滤器链真正的骨架：为什么顺序比类名更重要

如果说 route 解决的是“转给谁”，那过滤器链解决的就是“转之前先把请求变成什么样”。在 `my-xhs` 里，理解 Gateway 最关键的一步不是记住有哪些 Filter，而是看懂顺序背后的依赖关系。

### 第一层：RequestLogFilter 先把入口 trace 钉住

`RequestLogFilter` 的 `getOrder()` 返回 `Ordered.HIGHEST_PRECEDENCE + 100`，这意味着它是最早执行的一层。它做了三件决定后面所有章节都会反复依赖的事：先生成或透传 `X-Trace-Id`，再把这个 traceId 写进 MDC，最后在请求头里补上 `sw8`。这样做的目的不是“多打一行日志”，而是在入口先建立一条跨日志和链路追踪都可回溯的 ID 主线。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RequestLogFilter.java:119`

这里最值得注意的是它没有等下游服务自己生成 trace，而是在网关处就把 `X-Trace-Id` 和 `sw8` 一起写进去。因为一旦请求从网关再跨到下游服务、Feign、MQ、SSE 或 WebSocket，入口如果没有统一 trace，就会出现“应用日志有 traceId、SkyWalking 没串起来”或者“SkyWalking 有 trace、业务日志找不到同一个 ID”的断裂。交接文档中曾明确强调过：业务 traceId 和 SkyWalking traceId 原本是两套系统，而网关补 `sw8` 的目的正是把它们在入口尽可能锚到同一条线上。`docs/FINAL-HANDOFF.md:181` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RequestLogFilter.java:62`

### 第二层：BodyCacheFilter 先解决“验签要读 body，但 body 只能读一次”

写请求想做 HMAC，最直觉的办法是直接在 HMAC Filter 里读取 request body 做摘要。但在 WebFlux 里，请求体是流式的，读一次就消费掉了；如果 HMAC 先读了，后面的 Controller、下游服务或者其它过滤器就可能再也读不到。这就是为什么 `BodyCacheFilter` 被放到了 `Ordered.HIGHEST_PRECEDENCE`，甚至比 RequestLog 更靠前：它先把 `POST/PUT/PATCH/DELETE` 的 body 读出来缓存到 `exchange attribute`，然后重建一个可以继续往后消费的新 request。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/BodyCacheFilter.java:33`

这里还埋了两个很实在的边界。第一，multipart 上传直接跳过缓存，因为此前出现过大于 1MB 的上传请求被当场截成空 body、下游解析 EOF 的问题；第二，body 超过 1MB 时直接按空 body 处理，让 HMAC 失败而不是把网关内存打爆。这个设计不优雅，但它非常符合入口层的思路：宁可让请求在安全检查阶段失败，也不能让一个异常上传请求把 Gateway 本身拖垮。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/BodyCacheFilter.java:45`

### 第三层：GatewayAuthFilter 决定“这是谁”

`GatewayAuthFilter` 是入口门禁的第一道核心闸门。它先判断路径是否在 JWT 白名单中；不在白名单就要求 `Authorization: Bearer ...`，解析 JWT，校验 `type=access`，再拿 `jti` 去 Redis 黑名单查注销状态，最后把可信的 `X-User-Id`、`X-User-Role` 和 `X-Trace-Id` 覆盖写入请求头。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:88`

这层最容易被轻视的地方是“覆盖写入”而不是“透传客户端头”。如果客户端原本自己带了 `X-User-Id`，Gateway 不覆盖而只是追加，下游服务就很可能从多个同名头里读到伪造值。源码里明确用了 `headers.set()`，这是在把“用户身份只能由入口认证链生成”写成机械约束。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:126`

它还有一个很关键的运行时选择：黑名单 Redis 读取异常时返回 `true`，也就是 fail-closed。这意味着 Redis 一旦坏掉，网关宁可把请求拒掉，也不冒“已注销 Token 在短故障窗口里复活”的风险。这种权衡对交易和账号系统是成立的，因为这里保护的是认证边界，不是可读缓存。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:216`

### 第四层：TrafficColoringFilter 决定“这是哪种流量”

`TrafficColoringFilter` 之所以排在鉴权后，是因为它需要先拿到 `X-User-Id` 才能决定默认 AB 分组。它会给请求补上 `X-Gray-Tag`、`X-Api-Version`、`X-AB-Group`、`X-Pressure-Test` 等入口标签，并且把 `X-Forwarded-For` 重写为真实连接 IP，避免客户端伪造这个头绕过反作弊或压测门禁。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/TrafficColoringFilter.java:95`

这层的价值不是当前所有下游都已经完全吃掉这些 Header，而是入口先建立统一语义。只有这样，灰度、AB、压测、版本这些本来容易散落在不同服务里的概念，才不会变成每个服务各自命名、各自解释的一堆局部开关。

### 第五层：HmacSignatureFilter 决定“这次提交有没有被改或重放”

`HmacSignatureFilter` 的顺序放在鉴权和流量染色之后、限流之前，恰恰反映了它的角色：它不是身份识别，而是对“已经识别出是谁的请求”再做一次提交完整性保护。非白名单路径必须带 `X-Timestamp`、`X-Nonce`、`X-Signature`；网关先校验五分钟时间窗，再用 Redis Lua 做 `SET NX EX` 去重，接着根据 `X-User-Id` 去 Redis 取 `myxhs:user:hmac:secret:{userId}` 这个 per-session 密钥，最后用 `method|path|query|timestamp|nonce|bodyHash` 重新计算签名并比对。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:144`

这里有一个非常关键的设计转折：类里虽然还保留了 `hmacSecretKey` 字段，但真正验签用的不是全局配置密钥，而是 Redis 中的 per-session secret。也就是说，HMAC 在这里已经不是“所有客户端共享一把项目级密钥”的旧式设计，而是和登录态绑定的会话级签名密钥。这样客户端即便会签名，也只能签属于自己会话的请求，登出或过期后密钥就跟着失效。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:161`

更值得记住的是它在 Redis 上采取了两种不同策略：nonce 去重失败时记录错误后放行，请求不会因为去重 Redis 故障被整体打断；但 per-session secret 读取失败时却直接 403，走 fail-closed。这看上去不统一，其实反映了两个风险等级不同。nonce 去重丢掉的是“防重放增强”，而 secret 读取失败时如果继续放行，就等于直接绕过了签名校验本身。这种差异化安全策略，正是入口层比业务服务更适合承担的复杂度。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:156` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:173`

### 第六层：RateLimitFilter 决定“这条路由还能不能继续接流量”

`RateLimitFilter` 自己并不实现限流算法，而是把限流判断委托给 `SentinelGatewayFilter`。它真正承担的复杂度在另外两点：一是把每条 route 的 metadata 读取出来，翻成 Sentinel `GatewayFlowRule`；二是在运行期兼容 Nacos 动态规则和本地兜底规则。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:164`

这里最值得注意的不是 `filter()` 那一行委托，而是 `onApplicationReady()` 里的规则装载逻辑。它会先判断是否配置了 Sentinel Nacos 数据源；如果配置了，就先等异步推送，不立即用本地规则覆盖；但如果 30 秒后规则仍然没到，再加载本地兜底规则。这其实是在修复一个很典型的微服务入口问题：配置中心、规则中心和应用启动不是严格同步的，Gateway 不能因为启动得比 Nacos 推送快，就把一套过时本地规则永久顶住。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:123`

限流本身为什么排在 HMAC 后面也值得再重复一次。因为 `my-xhs` 把 route 视作配额单位，如果签名非法请求先命中限流，再被后面的 HMAC 拒掉，就会形成“攻击者拿无效请求耗尽合法用户配额”的副作用。现在的顺序等于先做请求合法性筛洗，再让合法请求参与配额竞争。这不是微调，而是整个入口治理策略的边界。

## 过滤器链如何真正执行：为什么这个项目专门写了 CachingFilteringWebHandler

如果只看各个 Filter，很容易以为 Spring Cloud Gateway 默认就会把它们按顺序串起来执行。`my-xhs` 源码里确实额外实现了一个 `CachingFilteringWebHandler`，它会把全局过滤器和 route 级过滤器合并、排序后按 `routeId` 缓存起来，请求再来时复用这一份已排序链表，并在 `RefreshRoutesResultEvent` 到来时清空缓存。单看实现，它显然是在尝试把过滤器链从“每次请求临时拼装”改成“按路由复用执行计划”。`my-xhs-gateway/src/main/java/com/myxhs/gateway/handler/CachingFilteringWebHandler.java:31`

但这里必须收口到证据边界：我已经确认这个类存在，也确认它的 `handle()` 和 `onRouteRefresh()` 逻辑完整；不过在当前仓库里没有继续找到把它注册成实际运行中 `WebHandler` 的装配点。因此本篇现在只能把它写成“存在于源码中的优化实现与设计意图”，不能直接写成“当前生产请求一定经过这层缓存式 WebHandler”。`my-xhs-gateway/src/main/java/com/myxhs/gateway/handler/CachingFilteringWebHandler.java:53`

这条边界很重要，因为它恰好体现了方法论里“事实”和“设计解释”必须分开：

- 可以确认的事实是：源码里有这套缓存式过滤器链实现，并且考虑了排序复用与路由刷新失效。
- 可以做的设计解释是：作者显然想降低入口热路径上重复拼装过滤器链的开销。
- 现在还不能写满的结论是：它已经替代了框架默认的 `FilteringWebHandler` 并在运行态生效。

对读者来说，这一节更稳妥的收获不是“网关一定已经用了这套缓存执行链”，而是：`my-xhs` 的网关作者已经意识到过滤器链属于入口热路径，甚至专门写过一版缓存式执行器；只是它是否已真正接入运行链，还需要在后续运行态或装配代码里继续追证。

## 工程落地层：Route 元数据如何落到 Sentinel、Nacos 和 Redis 上

到这里为止，业务主线和过滤器顺序已经立住了，但 Gateway 文章如果只讲这些，还会漏掉微服务系统真正容易翻车的工程面：路由、配置、注册中心和运行时依赖是怎么接上的。

首先，Gateway 的 discovery 和 config 都接到了 Nacos `21.130.247.89:18848`。这意味着 route 里的 `lb://my-xhs-user`、`lb://my-xhs-order` 等目标不是写死的静态地址，而是依赖 Nacos 服务发现的实例名。Gateway 自己既要通过 discovery 找下游实例，也要通过 config 拉公共配置和网关私有配置。`my-xhs-gateway/src/main/resources/application.yml:37`

其次，Gateway 自己不连数据库，但它强依赖 Redis。JWT 黑名单、HMAC nonce 去重、per-session secret、后续可能的流量状态共享都需要 Redis Sentinel。`application.yml` 里直接把 Redis Sentinel 节点写成 `21.130.247.89:26379`，而 compose 也明确了当前中间件部署使用 host 网络模式，Redis 主从与 Sentinel 的容器端口是 `6379/6380/26379`。这就是为什么交接文档反复强调“容器 host 模式端口”和“对外暴露端口”不能混写：Gateway 配置中看的是真正被服务机访问的中间件端口语义，而不是仅凭 compose 里容器内部描述猜。`my-xhs-gateway/src/main/resources/application.yml:255` `my-xhs/config/docker-compose.yml:209`

再次，Sentinel 这条链不是只靠 starter 自动完成的。`GatewayConfig` 里手动注册了名为 `sentinel-json-gw-flow-converter` 的 Bean，目的就是修掉 Spring Cloud Alibaba 在 `gw-flow` 规则类型上不会自动注册 JSON 反序列化器的问题。没有这个 Bean，Nacos 里即便配置了 GatewayFlowRule，网关也未必能正确把它转成 Sentinel 规则对象。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/GatewayConfig.java:22`

最后，Gateway 还是一个明显偏长连接和高并发的入口，所以 `spring.cloud.gateway.httpclient.pool` 也被显式配置成 fixed 池，并设置 `max-life-time=45000`，故意小于下游服务 keep-alive 的 60 秒。这个细节在路由表面上看不到，但它很关键：如果网关复用了一条实际上已经被下游服务保活超时关闭的连接，就会在发送 body 时触发 `PrematureClose`。入口层的连接池生命周期因此也成了 route 之外的工程事实。`my-xhs-gateway/src/main/resources/application.yml:81`

这些工程细节共同说明：Gateway 在这套系统里既是业务入口，也是多个基础设施依赖的汇聚点。文章如果只写过滤器链，不写 Nacos、Redis、Sentinel 和连接池，就会把它误解成一个纯逻辑层组件。

## 分布式视角：为什么网关层也要提前考虑多实例问题

表面上看，当前环境里网关只验证了服务机的 `19000` 端口可用；我在本地对服务机上的 `127.0.0.1:19000` 做了端口探测，当前返回 `OPEN`，这说明运行态至少有一台 Gateway 正在对外接流量。但交接文档与 compose 材料都在提醒下一位写作者：不要因为现在“看起来是单机入口”，就把系统写成纯单机思维。`/data/workspace/my-xhs` 当前大量设计已经明显在为多实例或跨实例扩展做准备。

第一处就是 Redis。JWT 黑名单、HMAC nonce 去重、per-session HMAC secret 都没有存本地内存，而是存 Redis。这意味着入口安全状态不是绑在某一台 Gateway 实例上的。哪怕后面再起第二台 Gateway，已注销 Token 仍然会在任何入口被拒，nonce 也不会只在单机上去重。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:216` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:145`

第二处就是 Sentinel。当前 `RateLimitFilter` 也明确承认了：现在是单机限流，每台网关实例独立算 QPS；如果未来要做集群限流，还需要 Sentinel Token Server。这说明作者并没有把“当前单机限流够用”偷换成“系统天然只支持单机限流”，而是在代码层显式标了边界。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:66`

第三处就是灰度和流量染色。`TrafficColoringFilter` 与 `GrayRouteFilter` 的存在，说明入口已经把请求头里的 `X-Gray-Tag` 当成灰度语义的承载物；但要更严谨地说，当前源码里真正已经落地的是“打标、透传和记录属性”，而不是完整的跨实例灰度实例过滤。`GrayRouteFilter` 自己的类注释就写得很直接：当前阶段仅做 Header 透传加日志记录，真正的实例过滤要靠后续 `GrayLoadBalancer` 一类组件完成。也就是说，这类入口标记的价值确实指向 future stable/gray 混布场景，但当前文章不能把它写成“已经具备完整灰度选实例能力”。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GrayRouteFilter.java:42`

第四处就是配置刷新与路由缓存失效。`CachingFilteringWebHandler` 监听 `RefreshRoutesResultEvent` 并清缓存，本质上也是在适配“入口配置可以动态变化”的现实。动态变化意味着实例不止一个、配置中心不止一次推送、路由规则不是重启才生效。`my-xhs-gateway/src/main/java/com/myxhs/gateway/handler/CachingFilteringWebHandler.java:71`

所以，从分布式视角看，Gateway 这里最重要的不是“现在到底几台”，而是“入口层哪些状态必须共享，哪些能力当前仍是单机边界”。JWT 黑名单和 HMAC 去重已经是共享状态；Sentinel 限流仍然是单机边界；灰度和路由刷新则已经具备跨实例语义，但是否真正跑多实例还要看后续部署。写作时必须把这几层区分开，不能把“代码有多实例准备”写成“线上已多实例运行”，也不能反过来因为当前只看到一台入口就把多实例设计全部忽略。

## 微服务视角：Gateway 为什么是入口编排，而不是业务编排

讲 Gateway 时还有一个常见误解：既然它已经会鉴权、验签、限流、染色、改写路径、注入 Header，那是不是也应该顺手做更多业务聚合，把很多逻辑都放进网关？

`my-xhs` 的实现恰好给出了一个很清晰的边界：Gateway 只做入口编排，不做业务编排。它决定请求能不能进、该带什么上下文进、该落到哪条路由上，但它不会在网关里拼业务视图，也不会在这里串订单、库存、支付的领域逻辑。首页聚合由 `home` 服务做，订单编排由 `order` 服务做，通知聚合由 `notification` 服务做。Gateway 负责的是“进入业务世界之前”的门禁与标准化，而不是“替业务服务做业务决策”。

这个边界体现在源码里非常清楚。所有路由都只是指向 `lb://my-xhs-*`，没有在网关内写业务聚合器；唯一接近 BFF 兼容的只是 AI 诊断台那条 `RewritePath`，它解决的是 northbound 路径语义兼容，不是业务逻辑聚合。`my-xhs-gateway/src/main/resources/application.yml:245`

这种边界划分对微服务系统尤其重要。因为网关一旦开始侵入业务编排，很快就会变成另一个“超大公共服务”：既握有所有入口凭据，又知道所有业务链，还承担所有入口流量。那样一来，任何需求变更都会先压到 Gateway，最后它成为系统里最难扩、最难改、最不敢重启的点。`my-xhs` 目前没有走这条路，而是把 Gateway 限定在入口控制平面，业务编排仍留给各业务服务或 BFF。

换句话说，Gateway 在这里是“谁能进、怎么进、带着什么上下文进”，不是“进来以后业务要怎么跑”。这条边界守住了，后续写 `02-jwt-hmac.md` 和 `03-sentinel-limit.md` 才不会把 Gateway 写成一个包打天下的超级中枢。

## 真实故障案例：推荐路由缺失，暴露的是入口地图本身的缺口

本篇必须有一个能逼出设计动机的真实故障。对于 Gateway 路由这一篇，最合适的不是 JWT 或 HMAC 的细节问题，而是更底层的入口地图缺口：`recommend` 路由曾经缺失，后来才补到 `application.yml` 里。交接文档把它记为 `F-025`，修复方式也非常直接，就是在网关配置中新增推荐服务路由。`docs/openjdk/vol-xhs/HANDOFF-XHS.md:160` `docs/HANDOFF.md:119`

这个故障表面上像个简单配置漏项，但它特别适合作为 Gateway Routing 篇的案例，因为它暴露的不是某个业务服务代码 bug，而是“入口地图本身不完整”。搜索与推荐在实现上都跑在 `my-xhs-search` 模块里，很容易让人产生一个错误直觉：既然物理服务一样，推荐入口大概会自然跟着搜索入口一起可达。实际并不会。对客户端和调用方来说，northbound 语义仍然是两条不同路径：`/api/search/**` 和 `/api/recommend/**`。如果 Gateway 没有显式声明后一条，即使后端服务内部已经实现了推荐能力，入口层仍然会把它当成不存在的世界。

这个案例非常能说明 Gateway 的职责边界：Gateway 不是“发现后端有接口就自动可达”的魔法层，入口能力必须被明确建模成 route。只要 northbound 路由没定义，这个能力对外就等于不存在。也正因如此，Gateway 文档不能只围绕过滤器链写安全机制，还必须把“入口地图是否完整”当作一类核心问题。`my-xhs-gateway/src/main/resources/application.yml:232`

从修复结果看，推荐路由被补上后，推荐入口才重新纳入统一鉴权、验签、限流和观测链。也就是说，这个故障的影响不只是 404 或不可达，而是整条入口控制面根本没有覆盖到对应业务域。这和普通业务代码 bug 是两回事。

## 证据清单：本篇关键判断分别站在哪一层

为了避免把推断写成事实，这里把本篇关键结论按证据层重新收一遍。

L0 源码静态证据：

- Gateway 对外监听 `19000`，并在 `spring.cloud.gateway.routes` 下声明了 user、content、search、order、payment、inventory、recommend、AI 等路由及各自 metadata。`my-xhs-gateway/src/main/resources/application.yml:1` `my-xhs-gateway/src/main/resources/application.yml:92`
- 过滤器顺序由各自 `getOrder()` 决定，`RequestLogFilter`、`GatewayAuthFilter`、`TrafficColoringFilter`、`HmacSignatureFilter`、`RateLimitFilter` 都是全局过滤器。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RequestLogFilter.java:119` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:152` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/TrafficColoringFilter.java:117` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:213` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:171`
- HMAC 依赖 body 缓存、nonce 去重和 per-session secret；JWT 鉴权依赖 Redis 黑名单；限流规则从 route metadata 读取。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/BodyCacheFilter.java:19` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/HmacSignatureFilter.java:144` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:203` `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:177`
- 过滤器链实际通过 `CachingFilteringWebHandler` 合并、排序、缓存并在路由刷新时失效。`my-xhs-gateway/src/main/java/com/myxhs/gateway/handler/CachingFilteringWebHandler.java:53`

L1 框架/语义证据：

- `lb://service-name` 语义依赖 Spring Cloud Gateway + Nacos 服务发现，而不是固定 URL。`my-xhs-gateway/src/main/resources/application.yml:37`
- Sentinel Gateway 规则并非只靠 starter 自动完成，还需手工注册 `sentinel-json-gw-flow-converter` 以解析 `gw-flow` JSON 规则。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/GatewayConfig.java:22`
- WebFlux 请求体只能安全消费一次，所以必须用 body cache + request decorator 的方式给后续链路复用。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/BodyCacheFilter.java:58`

L2 运行态证据：

- 当前服务机上的 Gateway 入口端口 `19000` 可达，本地探测返回 `OPEN`。
- 交接材料确认关键服务入口端口组 `19000~19016` 已恢复，Gateway 是北向入口。`docs/openjdk/vol-xhs/HANDOFF-XHS.md:13`
- `FINAL-HANDOFF.md` 明确记录了 Gateway + HMAC 重测全通过，并且整套 Gateway 链路 147/147 用例通过，说明路由、鉴权、验签、限流至少在当时的运行环境里被端到端验证过。`docs/FINAL-HANDOFF.md:235`

## 边界清单：哪些结论现在能说，哪些还不能写满

本篇虽然把 Gateway 入口总图立住了，但有几条边界必须明确，不然口径会写过头。

第一，当前可以确认 Gateway 已经具备多实例友好的共享状态设计，但不能直接写成“线上已经多实例部署并完成入口高可用验证”。我们有 Redis、Nacos、灰度标记和动态路由刷新这些准备，也知道中间件与服务机是分离的，但现有材料并没有直接证明多台 Gateway 同时对外提供流量。这个结论只能写到“设计上已预留，多实例运行态待后续验证”。

第二，当前可以确认 route metadata 里写了 `response-timeout` 和 `connect-timeout`，但 `application.yml` 注释也明确提醒：这些 metadata 是架构规范，当前实际请求超时仍主要由 `spring.cloud.gateway.httpclient` 的全局默认值生效，除非再配合自定义 GatewayFilter 才能实现逐路由差异化超时。也就是说，不能把 metadata 中的每个超时值直接写成“当前运行态已经严格按路由生效”。`my-xhs-gateway/src/main/resources/application.yml:93`

第三，当前可以确认 Sentinel 规则支持 Nacos 动态化和本地兜底，但不能写成“所有限流规则现在都持久化在 Nacos 并且集群同步完备”。`RateLimitFilter` 自己已经承认当前还保留本地兜底逻辑，且单机限流是明确边界。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:57`

第四，HMAC 机制已经从全局密钥迈向 per-session secret，但这不等于所有 northbound 写接口都已经彻底消灭了下游幂等和防重放责任。Gateway 只是做入口第一道筛选，订单、库存、支付、优惠券这些域内幂等仍然必须存在。HMAC 在这里是“入口防篡改 + 防重放前哨”，不是整个系统唯一一致性防线。

## 收网：Gateway Routing 这一篇真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的 Gateway 不是一个“把路径转给服务”的薄代理，而是一套入口控制面的总装配：route 定义 northbound 地图，过滤器链把请求先标准化成可信、可追踪、可限流、可灰度的统一形态，再交给具体业务服务。真正决定它复杂度的，也不是 route 数量本身，而是入口层要把身份、签名、流量、配置、限流和观测这些跨域问题同时收在一个地方。

从业务逻辑视角看，Gateway 建立的是用户与系统的第一道交互边界；从工程视角看，它把 Nacos、Redis、Sentinel、WebFlux 和连接池这些基础设施依赖收在一条入口链上；从分布式视角看，它把黑名单、nonce 和签名密钥这些必须共享的状态抽离到 Redis，把多实例语义提前预留出来；从微服务视角看，它守住了“入口编排而非业务编排”的边界，没有把自己膨胀成业务超级中枢。

开头的问题因此可以得到一句更准确的回答：当请求打到 `19000` 时，Gateway 并不是立刻转发，而是先完成一轮入口标准化，再决定是否把请求送入具体业务域。这就是为什么后面的 JWT、HMAC、Sentinel 和可观测性篇章，都必须建立在本篇这张入口总图之上。

下一篇最自然的桥接，就是把本篇里只作为“入口总图一部分”出现的两条安全链拆开：JWT 如何与 Redis 黑名单共同定义登录态边界，HMAC 又如何补上 JWT 不负责的防篡改与防重放责任。也就是说，接下来应进入 `08-gateway-security-observability/02-jwt-hmac.md`，把本篇中“先识别是谁，再确认这次提交没被改”的双层门禁彻底展开。