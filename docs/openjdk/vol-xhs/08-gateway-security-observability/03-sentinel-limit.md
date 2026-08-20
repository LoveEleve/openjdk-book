# 03 Sentinel Limit：为什么这套网关限流不是“配个 429”就结束了

前两篇已经把 Gateway 的路由总图和 JWT + HMAC 双门禁拆开了，但到这里还差最后一块非常容易被讲浅的入口机制：当请求既是合法用户、签名也正确时，Gateway 又该怎样决定“这条请求现在还能不能继续进系统”？

很多系统会把这个问题讲成一句很轻的话：网关有个限流过滤器，被打爆就回 `429 Too Many Requests`。这句话当然没错，但它几乎没有解释任何真正让生产系统难受的地方。限流从来不是“有没有 429”这么简单，而是至少包含四个层次的问题：到底按什么粒度限，是按 IP、按用户、按服务还是按具体接口；规则存在哪里，是写死在代码里、配在配置文件里，还是放在 Nacos / Dashboard 动态下发；规则一旦没及时加载，网关启动后的真空窗口谁来兜底；以及最容易被忽略的一点——在单机、双机、多机部署下，同一条“100 QPS”规则到底意味着什么。

`my-xhs` 的 Gateway 限流实现正好把这些问题都暴露了出来。它确实用了 Sentinel，也确实在被限时统一返回了 `429` JSON 响应；但它的真实复杂度不在那一行响应体，而在另一层：**网关把 route 当成限流资源，把 metadata 当成规则真源，把 Nacos 当成理想中的动态规则面，把本地兜底规则当成启动真空期的保险，同时又明确承认当前仍然是单机限流。** 如果不把这一整层讲清，读者很容易误解成“已经上了 Sentinel = 限流问题解决”，而这恰恰是微服务治理里最危险的错觉之一。

本篇就专门把这条 Sentinel 限流链掰开。它会先回答一个很现实的困惑：为什么 `my-xhs` 不满足于把限流散落在各服务 Controller 上，而要把它统一收在 Gateway。然后再往里推：`RateLimitFilter` 到底真正做了什么，它为什么委托 `SentinelGatewayFilter`，规则为什么从 route metadata 读，Nacos 动态规则与本地兜底为什么会产生时序竞争，T-106 那个 `NoSuchMethodError` 又为什么会把限流从“返回 429”变成“请求悬挂 30 秒超时”。只有把这些层面一起讲出来，读者才会明白这不是一层装饰性治理，而是一条会直接影响交易链入口稳定性的控制面。

## 先给结论：Gateway 限流在这里保护的不是某个接口，而是整条入口控制面

先别急着钻进 Sentinel API，先把本篇最重要的人话结论钉住：`my-xhs` 的 Gateway 限流不是在保护某一个 Controller、某一个服务实例，也不是只为了挡恶意流量，而是在给**入口控制面本身**设总闸门。

这句话的意思是：当所有北向流量都先经过 `19000` 端口时，Gateway 已经知道这次请求将落到哪个 route、将进入哪个业务域、会消耗哪类下游资源。限流放在这里，就可以在请求还没穿透到 `order`、`payment`、`inventory`、`user`、`search` 之前，先按业务类型把全局流量预算切分出去。搜索是高频读，配额可以更宽；订单和支付会牵动库存、券、事务消息和状态机，配额就必须更紧；用户认证天然暴露在撞库和暴力破解风险下，也要单独收口。`my-xhs-gateway/src/main/resources/application.yml:99`

如果把这件事反过来，交给每个服务自己在本地做限流，直觉上也能“拦住一些请求”。但那种拦法有三个严重副作用。

第一，它总是太晚。非法流量已经过了 Gateway、经过了服务发现、占了线程或连接、甚至进了数据库与缓存访问路径，最后才在服务内部被拒。你保住了业务语义，却没保住入口资源。

第二，它总是太分散。每个服务都要单独决定自己用什么限流注解、什么窗口、什么粒度、什么返回码；最后系统层面就不存在一张统一的入口配额图。你知道某个 Controller 限几次，却不知道“order-service 整体在入口该拿多少 QPS”。

第三，它总是太容易被绕。攻击者换一个服务、换一个路径、换一个实例打，同样可能把另外一条入口压爆。对微服务系统来说，单服务限流最多是域内补强，不是入口级治理。

`docs/review-method/22-gateway.md` 在网关复审维度里把这个判断写得很直：必须检查是否存在 Gateway 层统一限流，而不是把限流散落给各服务自己做。因为后者的结果就是“攻击者换一个服务打，该服务照样挂”。`docs/review-method/22-gateway.md:79`

所以本篇真正要解释的不是“限流返回什么 JSON”，而是：**为什么 Gateway 在这里要按 route 统一持有整套服务级流量配额。**

## 直觉方案为什么不够：只靠 `@RateLimit` 或只靠 Dashboard 点规则都不稳

要真正理解 `my-xhs` 这套实现，最有效的方法还是先推演几个看上去顺手、实际上不够稳的方案。

### 失败方案一：每个服务自己用本地注解限流

这是最容易想到的做法：用户服务在登录接口上加个 `@RateLimit`，订单服务在创建订单上加个 `@RateLimit`，购物车服务、优惠券服务、搜索服务各自按业务感受调阈值。这样每个服务都能表达自己的保护意图，看起来也足够灵活。

问题在于，这种灵活是以系统入口失去统一预算为代价换来的。用户服务可以知道“登录接口 1 分钟 5 次”，订单服务可以知道“下单接口 10 秒 1 次”，但没有任何一个地方在回答“整个 northbound 入口对 `order-service` 应该分配多少总 QPS”。而对 `my-xhs` 这种交易链来说，这个问题恰恰更重要。因为一旦订单入口爆掉，受影响的不只是订单自己，还会连着打到库存预扣、优惠券核销、支付创建、事务消息和后续状态回调。

`my-xhs` 当然没有彻底放弃业务服务侧限流或幂等，但它把这些看成域内防线，而不是系统第一道总闸。Gateway 这里的 Sentinel 是先按 route 保护“整个服务入口”；服务内部那些注解、锁、幂等键才负责保护“进入服务之后的具体操作”。如果把这两层混成一层，就会误以为服务内限流足以替代入口限流。其实不能。

### 失败方案二：只靠 Gateway 内置 `RequestRateLimiter`

Spring Cloud Gateway 自带 `RequestRateLimiter`，再配一个 `KeyResolver` 和 Redis 令牌桶参数，就能做出按 IP 或按路径的分布式限流。`my-xhs` 仓库里也确实保留了 `RateLimiterConfig`，里面有 `remoteAddrKeyResolver`、`principalKeyResolver` 和 `pathKeyResolver` 三种解析器。单从代码表面看，很容易以为这就是当前生效的主限流方案。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/RateLimiterConfig.java:20`

但这里现在其实可以把证据再压实一层，而不只停留在复审材料表述。当前 `my-xhs-gateway/src/main/resources/application.yml` 里没有任何 `RequestRateLimiter`、`redis-rate-limiter`、`key-resolver`、`replenishRate` 或 `burstCapacity` 之类的路由级配置；与之相对，Java 侧却确实还保留着 `RateLimiterConfig` 这组三个 `KeyResolver` Bean。把这两层证据合在一起，才更稳妥地说明：**当前仓库里能直接看到的是“解析器能力仍在，但对应的 Gateway 内置令牌桶配置并未接线”，因此现行主入口限流路径不是 `RequestRateLimiter`。** `my-xhs-gateway/src/main/java/com/myxhs/gateway/config/RateLimiterConfig.java:20`

这其实揭示了两种限流方案各自擅长的维度差异。Redis 令牌桶更适合做按 IP、按用户、按路径这类可分布式共享状态的维度控制；Sentinel Gateway Adapter 更适合直接把 Gateway route 视作资源，做服务级全局入口流控。`my-xhs` 当前的主问题不是“某一个 IP 突发打太猛怎么办”，而是“整个 `order-service` / `payment-service` / `search-service` 在北向入口应该拿多少总配额”。所以它最后选择让 `RateLimitFilter` 委托 `SentinelGatewayFilter`，把 route 当成限流资源名。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:164`

这并不意味着 IP 维度或用户维度不重要，而是说明当前主入口限流不是靠 `RequestRateLimiter` 在承担。对读者来说，这一点非常关键，因为如果误把 `RateLimiterConfig` 当成现行主路径，就会把整篇限流文章讲偏成“KeyResolver 怎么解析 X-Forwarded-For”。那只是另一个可能的方案，不是当前实际收口点。

### 失败方案三：只靠 Sentinel Dashboard 手工配规则

第三个直觉方案是最符合“平台治理想象”的：既然都上 Sentinel 了，运维直接去 Dashboard 上点规则不就行了吗？这样甚至连代码都不用改。

这个想法的问题也非常典型。Sentinel Dashboard 更像是规则下发与观察面板，而不是天然持久化的配置真源。历史材料已经反复提醒：如果只是手工在 Dashboard 上创建规则，重启后很可能丢；真正想做到规则跟应用一起可恢复，要么接 Nacos 数据源持久化，要么保留一份本地兜底规则源。`docs/test-2/service-analysis/16-gateway/05-sentinel-rate-limit.md:145`

`my-xhs` 的实现正是围绕这个问题展开的。它不是把规则硬写死在某个静态块里然后宣称“治理完成”，也不是单纯相信 Dashboard 永远在线；而是设计成三层：理想路径是 Nacos 推送 Gateway Flow Rule；如果运行期真的配了 Nacos 数据源，就先等它；但若 30 秒后规则仍没到，再从 route metadata 生成本地兜底规则。也就是说，这套系统已经承认了一个现实：**规则中心和应用启动不是同步世界。**

这条认识非常重要，因为很多“限流没生效”的事故根本不是规则没写，而是写了但来得太晚，或者启动时被错误的本地逻辑覆盖掉了。

## 先画总图：Sentinel 限流在 Gateway 里到底是怎样落下来的

先别急着进 `RateLimitFilter` 细节，先把整条链用一张文字图立住：

```text
application.yml
  -> spring.cloud.gateway.routes[*].metadata.rate-limit-qps
       user=50, search=300, order=10, payment=5 ...
  -> GatewayProperties
       Spring 启动时装配所有 RouteDefinition
  -> RateLimitFilter.onApplicationReady()
       检查是否配置 Sentinel Nacos 数据源
         -> 是：先等异步推送
               30s 后仍为空 -> 本地兜底 initFlowRules()
         -> 否：直接本地兜底 initFlowRules()
  -> initFlowRules()
       routeId + metadata.rate-limit-qps -> GatewayFlowRule(count, intervalSec=1)
       -> GatewayRuleManager.loadRules(rules)
  -> RateLimitFilter.filter()
       委托 SentinelGatewayFilter
       Sentinel 按 routeId 匹配规则
  -> 触发限流
       GatewayCallbackManager / WebFluxCallbackManager
       返回 HTTP 429 + 统一 JSON 响应
```

这张图最关键的不是组件名，而是三条依赖关系。

第一，规则真源和 route 绑定。`RateLimitFilter` 不是自己另写一份 `order=10, payment=5` 的 Map，而是直接遍历 `GatewayProperties.getRoutes()`，从每个 `RouteDefinition.metadata` 中取 `rate-limit-qps`。这样限流规则天然和 northbound route 是同一份入口地图。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:177`

第二，规则装载和应用启动解耦。就算最终采用的是 Nacos 数据源，也不能假设规则一定在 `@PostConstruct` 时就到位，所以真正加载规则的时机被推迟到了 `ApplicationReadyEvent`。这就是为什么 `init()` 只注册 block handler，不直接加载 flow rules。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:95`

第三，限流判断和限流响应是两套适配器。`SentinelGatewayFilter` 负责判断是不是该拦；`GatewayCallbackManager` 与 `WebFluxCallbackManager` 负责“真拦住之后怎么回 429”。T-106 那次真实回归正是因为只改了其中一头还不够，结果触发限流时没有正常返回，而是卡成超时。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:241`

## Route 元数据为什么是这套限流的真正配置真源

理解 `my-xhs` 这套网关限流，最值得先记住的一个点就是：**限流不是围绕某个 Java 类配置的，而是围绕 route 配置的。**

`application.yml` 里每条 route 不只声明了 `Path -> lb://service` 的映射，还同时携带了 `response-timeout`、`connect-timeout` 和 `rate-limit-qps`。用户服务 `50 QPS`，搜索服务 `300 QPS`，订单服务 `10 QPS`，支付服务 `5 QPS`，库存服务 `30 QPS`，推荐、首页、通知等也各自有不同额度。`my-xhs-gateway/src/main/resources/application.yml:99`

这意味着 `rate-limit-qps` 在这里不是“顺手写的补充注释”，而是入口控制面的一个正式维度。为什么 route 维度这么重要？因为 Gateway 真正知道的是“这次请求匹配到了哪条入口路由”，而不是“它最终会命中哪个 Controller 方法”。在微服务入口层，按 route 分配配额比按方法分配配额更自然，也更容易和 northbound 业务预算对应上。

比如：

- `search-service` 入口高频读、多缓存、多召回，能承受更高北向吞吐，因此给到 `300 QPS`。`my-xhs-gateway/src/main/resources/application.yml:119`
- `order-service` 是交易主链入口，任何一次请求都可能展开库存、券、支付等编排，所以即便正常业务量不小，也要在网关收得更紧，当前 metadata 是 `10 QPS`。`my-xhs-gateway/src/main/resources/application.yml:129`
- `payment-service` 更进一步，只给 `5 QPS`，这不是“支付很慢所以只能这样”，而是在告诉入口层：支付动作比普通查询更贵，必须把北向突发打平。`my-xhs-gateway/src/main/resources/application.yml:139`
- `user-service` 入口设置 `50 QPS`，明显带着防暴力破解色彩；这和认证链的业务风险是同一张图的一部分。`my-xhs-gateway/src/main/resources/application.yml:99`

对读者来说，这里最重要的理解不是某个具体数字，而是：**`rate-limit-qps` 把业务语义翻译成了入口配额。** 搜索更宽、交易更紧、支付最严，这些不是后端类上某个注解临时表达出来的，而是直接写进了 northbound route 图谱。

## `RateLimitFilter` 真正在做什么：它不是算法本身，而是“规则装配 + 适配器委托”

很多人第一次看 `RateLimitFilter` 会有点失望，因为 `filter()` 方法本身短得像什么都没做，只是：

```java
return sentinelGatewayFilter.filter(exchange, chain);
```

如果停在这一层，很容易误以为这只是个薄封装，真正逻辑都在 Sentinel 里，项目本身没多少东西可讲。实际上恰恰相反：`my-xhs` 最有价值的实现不在“限流算法自己写没写”，而在它怎样把业务路由图装配成 Sentinel 能吃的规则，再把框架的判断结果包装成项目级入口行为。

`RateLimitFilter` 真正承担的复杂度，集中在三件事。

第一件事是规则装载时机。`@PostConstruct init()` 只做 block handler 注册，不做规则加载；真正的 flow rule 加载放在 `ApplicationReadyEvent` 之后。这说明作者已经踩过“Bean 初始化太早，规则中心还没准备好”的坑。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:101`

第二件事是规则来源选择。`onApplicationReady()` 会先判断环境里有没有配置 `spring.cloud.sentinel.datasource.flow.nacos.server-addr`。如果有，就先认定 Nacos 是理想规则源，不立刻把本地规则灌进去；但 30 秒后如果 `GatewayRuleManager` 仍是空的，说明推送没到，再调用 `initFlowRules()` 加载 route metadata 兜底。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:123`

第三件事是路由元数据到 Sentinel 规则对象的转换。`initFlowRules()` 逐个遍历 `GatewayProperties.getRoutes()`，跳过非业务路由，把 `rate-limit-qps` 读出来，生成 `GatewayFlowRule(routeId).setCount(qps).setIntervalSec(1)`。在 Sentinel 看来，资源名就是 `routeId`；在 `my-xhs` 看来，这等价于“每条 northbound 服务入口拿一个 1 秒窗口的流量配额”。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:185`

所以这段代码真正要读出的不是“它有没有自己实现限流算法”，而是：**它把限流问题定义成了一条路由规则装配链。** 算法复用 Sentinel，项目实现自己的规则装配、时序选择和响应契约。这恰恰是成熟工程里的正常分工。

## 为什么 Nacos 动态规则和本地兜底会产生时序竞争

这套实现里最容易被低估的一节，其实不是限流判断，而是规则加载时序。因为这直接决定系统在启动后前几十秒到底有没有保护。

直觉上，既然生产推荐 Nacos 动态规则，那应用启动时只要“配置了 Nacos 数据源”就行，规则总会到。问题在于，Nacos Config Client 拉规则本身是异步的；`ApplicationReadyEvent` 触发时，监听器可能已经注册好了，但规则数据未必已经推送到 `GatewayRuleManager`。如果这时项目代码武断地看到“当前规则集为空”，就立刻灌入一套本地规则，后面 Nacos 推送来了，谁覆盖谁、有没有竞态，就都成了风险点。

`RateLimitFilter` 的实现正是在绕这个坑。它先判断“是否配置了 Nacos 数据源”，如果配置了，就先等待；30 秒后再看规则集是不是还是空。这个 30 秒真空窗口兜底并不漂亮，但它至少是显式承认：**规则中心到达时间不是零。** `my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:132`

这里特别值得强调的是，这不是“作者多写了一段防御代码”这么简单，而是限流体系真正能不能在应用重启、配置中心波动、部署时序变化中保持工作的一条关键边界。很多系统在日常压测里限流都正常，但到了真实发布窗口，一次滚动重启、一次规则中心延迟，就把入口放空了几十秒。`my-xhs` 至少已经把这个风险显式编码进了启动逻辑，而不是假装不存在。

从工程视角再往下拆，这里其实有两层成本：

1. **规则加载时序成本**：应用启动、Nacos 数据源初始化和规则到达不是同一个时钟，因此系统必须容忍“进程已经 ready，但规则尚未 ready”的窗口；
2. **规则真源一致性成本**：route metadata、Nacos 推送和本地兜底规则三者必须避免互相覆盖，否则会出现“静态配置、运行态规则、运维认知”三套不一致的情况。

也就是说，Sentinel 在当前实现里不仅是限流算法问题，还是一条配置与运行时协同问题。它最像的不是“加一个过滤器”，而是“给入口控制面再叠一层规则生命周期管理”。

当然，方法论要求我们这里也要收口边界：现在可以明确说有 Nacos-first + 30 秒兜底的策略；但不能直接写成“线上已经验证过 Nacos 动态规则稳定生效”。因为当前可直接看到的运行态材料，更多证明的是历史测试和规则导入结果，而不是本机此刻真的有 Dashboard 或 Nacos 动态规则正在工作。后面边界清单会专门收这个口径。

## T-106：为什么“只回个 429”会演化成请求悬挂 30 秒

如果只看限流正路径，读者很容易以为这条链没什么戏剧性：命中规则 -> 返回 429 JSON -> 完了。可真正把这篇文章拉出厚度的，恰恰是那个已经在代码注释里留下来、并且非常有代表性的故障：T-106。

问题的表面现象不是“限流没触发”，而是更诡异的一种：请求明明命中了 Sentinel，但没有及时返回 429，而是悬挂，最后超时。这类故障在入口层极其危险，因为它会让人误以为“只是慢了一点”，实际上入口线程和连接都在被错误占用。

根因在于 Spring 版本与 Sentinel 适配器的签名不兼容。`RateLimitFilter` 的注释明确写着：Sentinel 1.8.8 的默认 `BlockRequestHandler` 是按 Spring 5.x 编译的，调用的是 `ServerResponse.status(HttpStatus)`；而当前 WebFlux 6.1.6 需要的是 `HttpStatusCode` 重载。结果就是：当真正触发限流时，block handler 在生成响应这一刻抛出 `NoSuchMethodError`，于是本该立刻返回的 429 变成了请求悬挂 30 秒后超时。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:243`

这个案例特别适合放在 Sentinel 篇，而不只是留在修复日志里，因为它说明了一件很深的事：**限流系统的失败，不一定是规则判定失败，也可能是“判定成功了，但无法把拒绝响应正确地发出去”。** 对入口控制面来说，后者一样致命。

`my-xhs` 的修法也很有代表性：不是简单只改一处回调，而是同时注册 `GatewayCallbackManager` 和 `WebFluxCallbackManager` 两套 block handler；前者服务于 Sentinel Gateway Adapter，后者服务于 WebFlux 适配路径。并且在 WebFlux 那条链上显式改用 `HttpStatusCode.valueOf(429)`，避开 Spring 6 的方法签名差异。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:248`

这就是为什么本篇从一开始就强调：限流不是“配个 429”这么简单。真正难的不是写出“请求过于频繁，请稍后再试”，而是保证在框架版本、适配器路径和响应构造都变动的前提下，这个 429 还能稳定、及时、成体系地返回。

## 为什么当前只能严谨地说“单机限流”，不能写成全局精确限流

`RateLimitFilter` 自己的类注释已经把这一点说得非常清楚：当前 Sentinel 是单机限流，每台 Gateway 实例独立计数；如果要做全局精确限流，需要 Sentinel Token Server。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:66`

这句话看起来像免责声明，实际上它是整个限流篇最重要的分布式边界之一。

只要 Sentinel 规则存活在单实例内存里，那么“`order-service` 10 QPS”在 1 台 Gateway 下确实接近 10 QPS；但在 3 台 Gateway 下，系统总入口就可能接近 30 QPS。也就是说，规则的数值没变，系统总体允许吞吐却按实例数线性放大。对于搜索这种高读链路，这可能还不是第一优先级问题；但对订单、支付、库存这种本来就收得很紧的写路径，它会直接改变你以为自己在保护的配额边界。

所以在 `my-xhs` 里，当前可以明确写到三层：

- 已经实现的：按 route 的单机 Sentinel 限流
- 设计上承认的：多实例下总 QPS 会放大
- 未来如果要继续收紧的：接入 Sentinel Token Server 或改成更分布式的全局计数方案

这条边界在方法论上尤其重要，因为很多写微服务治理的文章最容易犯的错，就是把“代码里写了 100 QPS”直接说成“系统全局限流 100 QPS”。在这里不能这么写。能说的是：**当前每个网关实例各自按 100 QPS 计；总配额是否等于 100，要看实际实例数。**

## 运行态材料告诉了我们什么，又没有告诉我们什么

限流这种机制，如果只看源码，很容易写得过满；如果只看测试材料，又容易忘记实现边界。这里需要把三层证据重新合在一起看。

先看已经能确认的运行态事实。`FINAL-HANDOFF.md` 明确记录过一次 Gateway 侧的限流验证：`Gateway 限流 429（令牌桶 100/50） ✅`。但这里必须先收口证据层级：这条记录本身更像是在证明“Gateway 曾正确返回统一 429 拒绝响应”，而不是足以单独证明“当前写作这一篇里的 Sentinel route 级限流链已被同一轮实验直接打透”。因为它使用的是“令牌桶 100/50”这套描述，更接近 Gateway 内置 `RequestRateLimiter` 的语义。`docs/FINAL-HANDOFF.md:230`

真正更接近本篇主线的历史材料，是 `docs/test-2/service-analysis/16-gateway/05-sentinel-rate-limit.md` 里那条更细的实验记录：并发 150 个请求打 user 路由，结果是 `200 × 100 + 429 × 50`，且限流响应体就是 `{"code":429,"message":"请求过于频繁，请稍后再试","data":null}`。这条材料至少能证明两件事：第一，Gateway 层的统一 429 JSON 在运行态打 through 过；第二，历史测试文档把这次实验归因到了网关限流链。但同样要严谨区分：它是历史验证材料，不等于我现在在这台机器上复现并再次确认了同一条 Sentinel 路径。`docs/test-2/service-analysis/16-gateway/05-sentinel-rate-limit.md:150`

但证据边界同样要讲清。当前我在本机对 `127.0.0.1:8858` 做端口探测返回的是 `CLOSED`，说明此刻这台环境上 Sentinel Dashboard 并没有直接处于可访问状态。与此同时，评审材料里又有另一条运行态事实：`gateway flow rules 15 资源 = 15 路由 id 一一对应，导入后即可生效`。这意味着历史上规则导入与验证是做过的，但不能被误写成“现在这台机器上 Dashboard 正在开着、Nacos 规则正在实时推送”。`docs/test-2/review-fresh/review-production-config.md:527`

这就是为什么本篇后面必须把“历史验证通过”和“当前运行态在线状态”分开。前者可以作为 L2 证据支撑“这套限流链曾经在真实环境打 through”；后者如果没有现时端口、日志、控制台或规则快照支撑，就不能写成现在进行时。

## 真实故障与失败案例：规则不是没判到，而是判到了却回不出 429

按照本卷方法论，每篇都要有一个真实故障案例，而且最好能逼出设计动机。对 Sentinel 限流这篇来说，最好的案例不是“某条 QPS 配小了”，而是 T-106 这种更本质的失败：规则已经命中了，但 Gateway 因为 block handler 与 Spring 6 方法签名不兼容，没法把 429 正常返回给客户端。

这个案例的重要性在于，它把限流问题从“规则有没有”拉到了“控制面是否闭环”。很多治理文章讲限流，默认只关心判定环节；仿佛只要规则判定成功，治理就成功了。但对入口层来说，**正确的拒绝响应本身就是机制的一半。** 如果它缺席，请求就会悬挂、重试、堆积，最后形成比“直接 429”更糟糕的系统状态。

因此，用方法论要求的五段式来收这个案例：

- 现象：请求命中限流后没有及时返回 429，而是悬挂到超时
- 根因：Sentinel 1.8.8 默认 handler 依赖 Spring 5.x 的 `ServerResponse.status(HttpStatus)`，当前 WebFlux 6.1.6 需要 `HttpStatusCode`
- 修复：同时注册 Gateway/WebFlux 两条 block handler，并在 WebFlux 路径使用 `HttpStatusCode.valueOf(429)`
- 验证：历史运行态材料已记录 Gateway 429 行为可以正确返回
- 余波：未来只要再升级 Spring / Sentinel 版本，这一层适配关系仍需复检，不能假设永远安全

这个案例写对了，读者会直接意识到：限流从来不是“有没有规则”，而是“规则判定、规则装载、拒绝响应、运行时适配”四件事都要闭环。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- `RateLimitFilter` 把限流判断委托给 `SentinelGatewayFilter`，并把执行顺序固定在 HMAC 校验之后。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:164`
- `initFlowRules()` 直接遍历 `GatewayProperties.getRoutes()`，从每个 route metadata 读取 `rate-limit-qps` 生成 `GatewayFlowRule`。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:185`
- `application.yml` 确实为不同 route 提供了差异化 `rate-limit-qps`，如 user=50、search=300、order=10、payment=5。`my-xhs-gateway/src/main/resources/application.yml:99`
- `GatewayConfig` 手工注册了 `sentinel-json-gw-flow-converter`，说明 Nacos `gw-flow` 规则反序列化并不完全靠 starter 自动完成。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/GatewayConfig.java:22`
- `RateLimiterConfig` 中虽存在多个 `KeyResolver`，但当前主限流路径并不直接使用它们。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/RateLimiterConfig.java:20`

L1 框架/语义证据：

- Sentinel Gateway Adapter 以 routeId 作为资源名进行匹配，天然适合服务级入口流控。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:166`
- `ApplicationReadyEvent` 相比 `@PostConstruct` 更适合等待异步规则源准备好，说明规则加载与 Bean 初始化不是一个时钟。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:109`
- Sentinel 单机限流与多实例全局限流不是同一语义；当前代码自己已承认若要全局精确限流需接 Token Server。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:66`

L2 运行态证据：

- `FINAL-HANDOFF.md` 明确记录过 Gateway 侧 429 限流验证通过。`docs/FINAL-HANDOFF.md:230`
- 历史深度分析稿记录过 `200 × 100 + 429 × 50` 的 Gateway 限流实验结果，以及统一 JSON 响应。`docs/test-2/service-analysis/16-gateway/05-sentinel-rate-limit.md:150`
- 当前本机 `127.0.0.1:8858` 端口探测为 `CLOSED`，说明至少此刻 Sentinel Dashboard 不处于直接可访问状态；因此本篇不能把 Dashboard 当前在线当作既成事实。

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 Gateway 已经存在基于 Sentinel 的 route 级限流实现，但不能把它写成“当前线上已实现全局精确限流”。因为代码和文档都明确说明：现阶段仍是单机限流，多实例下总 QPS 会按实例数放大。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RateLimitFilter.java:66`

第二，当前可以明确写出 route metadata 是本地兜底规则的真源，但不能直接写成“每个 metadata 超时/限流值都已经在当前运行态严格生效”。对限流来说，metadata 会被 `initFlowRules()` 真正读取；但对超时来说，`application.yml` 注释已明确它们更多还是设计规范，当前请求超时主要仍由全局 httpclient 配置承担。`my-xhs-gateway/src/main/resources/application.yml:93`

第三，当前可以明确写出 Nacos-first + 30 秒兜底的规则加载策略，但不能直接写成“当前环境里的 Nacos 动态规则一定已在线推送生效”。更具体地说：我现在能直接在源码里确认的，是 `RateLimitFilter` 会检查 `spring.cloud.sentinel.datasource.flow.nacos.server-addr` 这个配置键；能在文档里看到的，是历史上确实存在 `gw-flow` 规则资源与导入说明；但在当前本地可见的 `application.yml` 里，并没有直接展开这组 Sentinel datasource 配置。因此现阶段最稳妥的口径只能是：**代码明确支持 Nacos 规则源，历史材料表明规则曾被整理/导入过，但当前这台环境是否已在线推送，不能仅凭眼下可见文件写成既成事实。**

第四，当前可以明确写出 `RateLimiterConfig` 中的 KeyResolver 不是主限流路径，但不能因此说项目完全不需要 IP / 用户维度的限流。更准确的说法是：**当前 northbound 主入口限流由 Sentinel route 级流控承担，IP / 用户维度仍是可扩展方向或其它方案的遗留能力。**

## 收网：这篇 Sentinel 限流真正建立了什么

到这里可以回收开头的困惑了。`my-xhs` 的 Gateway 限流不是“命中就 429”这么单薄，而是一条完整的入口控制链：路由元数据先表达业务配额，`RateLimitFilter` 再把这份入口地图翻成 Sentinel 规则，规则加载时既考虑了 Nacos 动态推送，又考虑了启动真空期兜底，真正触发限流时还要保证 Gateway/WebFlux 两条响应路径都能稳定返回统一 JSON。

从业务逻辑视角看，它把不同业务域的 northbound 预算切开了：搜索更宽、认证更谨慎、交易与支付最严；从工程视角看，它把 route 配置、Nacos 数据源、GatewayProperties、Sentinel 适配器和 block handler 串成了一条规则装配链；从分布式视角看，它明确承认当前仍是单机限流，并把多实例放大量作为已知边界；从微服务视角看，它把限流收在网关入口，而不是放任各服务各自守门。

更重要的是，本篇也把一个特别容易被忽略的事实钉实了：**限流失败不只表现为“没拦住”，也可能表现为“拦住了，但 429 回不出去”。** 这也是为什么 T-106 这种适配器故障，必须被当成限流主线的一部分，而不是随手记在修复日志里。

下一篇最自然的桥接，就是把本篇和前两篇里已经多次出现、但还没统一收束的最后一层讲清：既然网关已经承担了路由、双门禁和限流，那么 Trace、日志、指标、SkyWalking、Prometheus、Grafana 到底如何把这整条入口控制面观测出来。也就是说，接下来应进入 `08-gateway-security-observability/04-observability.md`。