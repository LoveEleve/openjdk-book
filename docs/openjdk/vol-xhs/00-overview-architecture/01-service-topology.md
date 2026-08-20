# 服务拓扑与依赖关系

> 对应目录：`vol-xhs/00-overview-architecture/`
> 目标问题：`my-xhs` 不是只有十几个 Spring Boot 服务吗，为什么一旦进入真实业务链路，复杂度会迅速抬升？

## 一句话困惑

如果把 `my-xhs` 看成“16 个服务 + 一堆中间件”的清单，读者很容易产生一个错觉：服务虽然多，但无非是把用户、商品、订单、支付拆开部署而已。可一旦真的沿着“浏览商品 → 加购物车 → 下单 → 扣库存 → 支付成功 → 发通知”这条链路走一遍，就会发现系统真正的难点不在“有多少服务”，而在**入口在哪、编排在哪、同步调用止于何处、异步消息从哪里接管、谁在持有业务真相、谁又只是在做聚合和转发**。

这一篇的任务，不是把所有模块机械列一遍，而是先建立一张能带着读者走完整卷的总图：

1. 用户请求先打到哪里。
2. 哪些服务是业务真核心，哪些服务是聚合层或配套层。
3. 哪些依赖是同步 Feign，哪些依赖是异步 RocketMQ。
4. 为什么同样是“调用别的服务”，订单服务和首页服务的复杂度完全不同。

如果这张图没有先立住，后面的 `03-product`、`04-cart-coupon`、`05-inventory-order-payment` 就很容易被看成一堆局部实现，而不是同一个分布式系统中的不同角色。

## 一句话答案

`my-xhs` 的拓扑不是“很多服务并排摆开”，而是**网关统一入口 + 业务服务分层分组 + 同步编排链 + 异步扩散网**四者叠加出来的运行结构；真正抬高复杂度的，不是服务数量本身，而是不同服务在这张结构图里承担的职责完全不同。

## 这一篇要先建立什么心智模型

先给出最小心智模型：`my-xhs` 不是一排平铺的微服务，而是四层结构叠在一起。

```text
用户 / 前端
    ↓
Gateway 统一入口层
    ↓
业务服务层（user / content / product / cart / coupon / order / payment / inventory / search / home / notification / im / analytics / counter）
    ↓
数据与中间件层（MySQL / Redis / Elasticsearch / RocketMQ / Nacos / XXL-Job）
```

这四层里最容易被误解的，是中间两层。

很多系统图把所有业务服务并排摆开，仿佛它们只是“不同名字的 CRUD 服务”。但在 `my-xhs` 里，并不是每个服务都在做同样的事：

- `gateway` 是统一入口，不保存业务数据，却掌握路由、鉴权、限流和超时策略。
- `order`、`inventory`、`coupon`、`payment` 是交易链上的强状态服务，状态变化多、失败路径多、补偿也多。
- `home` 更像 BFF 聚合层，本身不拥有太多权威数据，却要把内容、商品、用户、库存、优惠券、通知等结果拼到一起。
- `analytics`、`counter`、`notification` 则承担“业务动作发生之后，如何扩散到其他视图或其他体验层”的职责。

这意味着：**拓扑图不是部署图，而是职责图。** 同样两条箭头，看起来都叫“远程调用”，语义却可能完全不同。

## 先推演一个最直觉、也最容易误导人的失败方案

最直觉的微服务理解方式，是按名词拆服务：

- 用户的事放 `user`
- 商品的事放 `product`
- 订单的事放 `order`
- 支付的事放 `payment`

然后画一张最朴素的图：

```text
前端 → user / product / order / payment / ...
```

这张图看起来没有错，但一进入真实系统就会失败，原因至少有三层。

### 第一层失败：它把统一入口抹掉了

用户并不直接调用 `user`、`product`、`order` 这些服务，而是先进入网关。`gateway` 在 `my-xhs-gateway/src/main/resources/application.yml:80` 定义了统一路由层，把 `/api/user/**`、`/api/product/**`、`/api/order/**`、`/api/payment/**` 等路径映射到对应服务；同一处配置里还为不同业务域设置了不同的超时和 QPS 元数据，比如订单链路比内容接口更长，支付链路的超时又比订单更宽松，首页聚合接口则被单独视为 BFF 场景。

也就是说，这张“前端直打服务”的图，在入口这一步就已经错了。拓扑图的真正起点不是 `user` 或 `order`，而是 `gateway`。

### 第二层失败：它把同步编排链压扁成了单服务动作

订单不是一个只改自己数据库的服务。`order` 服务里直接声明了多个 Feign 客户端：

- `my-xhs-order/src/main/java/com/myxhs/order/feign/UserFeignClient.java:17` 对接 `my-xhs-user`，并在 `:23` 通过 `/api/user/address/{id}` 获取真实收货地址。
- `my-xhs-order/src/main/java/com/myxhs/order/feign/ProductFeignClient.java:18` 对接 `my-xhs-product`，并在 `:26` 通过 `/api/product/sku/batch` 批量获取 SKU 详情。
- `my-xhs-order/src/main/java/com/myxhs/order/feign/InventoryFeignClient.java:18` 对接 `my-xhs-inventory`，并在 `:26`、`:32`、`:42` 分别查询库存、释放库存、确认扣减。
- `my-xhs-order/src/main/java/com/myxhs/order/feign/CouponFeignClient.java:18` 对接 `my-xhs-coupon`，并在 `:26`、`:35`、`:42` 分别查询折扣、核销、退还优惠券。
- `my-xhs-order/src/main/java/com/myxhs/order/feign/PaymentFeignClient.java:18` 对接 `my-xhs-payment`，并在 `:26`、`:32`、`:38` 发起支付、查询支付状态、发起退款。

这说明 `order` 根本不是一个“自己下单、自己完成”的节点，而是把地址、商品、库存、优惠、支付这些分散事实临时拉成一条同步业务链的编排中心。

### 第三层失败：它把异步扩散网彻底漏掉了

如果所有动作都靠同步 Feign 串起来，系统会非常脆弱。所以 `my-xhs` 在很多地方引入 RocketMQ，把“必须立即完成的动作”和“可以延后传播的动作”拆开。

例如：

- 内容发布会发 `FEED_TOPIC`，让后续 Feed 推送和相关消费者接管，见 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:133`。
- 评论、点赞、关注等动作会发 `NOTIFICATION_TOPIC`，通知服务再决定怎样生成站内通知，见 `my-xhs-content/src/main/java/com/myxhs/content/service/CommentService.java:186`、`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:328`、`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:588`。
- 推荐侧会把行为事件写到 `RECOMMEND_BEHAVIOR_TOPIC`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:188`。
- 通知服务本身则通过 `my-xhs-notification/src/main/java/com/myxhs/notification/consumer/NotificationEventConsumer.java:35` 订阅 `NOTIFICATION_TOPIC`，在 `:74` 调用 `notificationService.processEvent(event)` 落地通知。

所以那张最朴素的“并排服务图”最后失败的地方，是它根本看不见主链之外的扩散网。

到这里先记住一个结论：**服务拓扑真正要解释的，不是“服务有哪些”，而是“请求从哪里进入、在哪些点同步收束、又从哪里异步扩散”。**

### 第四层失败：它把读聚合和事务编排混成了同一种中心

就算承认有网关、承认有 Feign、承认有 MQ，仍然还有一种常见误解：把所有“依赖很多下游”的服务都看成同一种中心节点。

这也不对。

`order` 和 `home` 都依赖很多别的服务，但它们依赖别人的方式完全不同：

- `order` 在一次下单过程中，必须把地址、商品、库存、优惠、支付这些事实拉齐，否则订单状态机会断裂。
- `home` 在一次页面聚合中，更多是在拼装展示结果；少一块数据通常意味着降级，而不是整条业务链回滚。

如果把这两类中心节点混为一谈，后面写交易链时就会误把 BFF 当作事务核心，写首页聚合时又会误把页面组装当成强一致链路。这种混淆不会让图立刻报错，但会让后面所有模块分析都走偏。

## 先把服务分组，而不是先逐个服务点名

真正有用的服务拓扑，不是从 `gateway` 一直数到 `ai-tools`，而是先分组。按职责看，`my-xhs` 至少可以拆成五组服务。

### 1. 入口与聚合层

这一组包括：

- `gateway`
- `home`
- 部分前端对外聚合接口对应的搜索/推荐入口

`gateway` 的角色非常清晰：

- 统一入口
- 路由分发
- JWT 与 HMAC 鉴权
- 限流与连接池治理
- 不同业务域的超时差异化

它在 `my-xhs-gateway/src/main/resources/application.yml:99` 之后定义了用户、内容、搜索、订单、支付、库存、购物车、优惠券、首页、通知、IM、推荐等路由。也就是说，**网关不是“可有可无的转发器”，而是所有业务拓扑的总开关。**

`home` 则是另一种“入口”。它不是统一入口，而是**业务聚合入口**。`my-xhs-home/src/main/java/com/myxhs/home/HomeApplication.java:20` 开启了 Feign 客户端；对应的 Feign 声明里，至少可以看到三类代表性聚合调用：

- `my-xhs-home/src/main/java/com/myxhs/home/feign/ProductFeignClient.java:21` 通过 `/api/product/spu/{spuId}` 获取商品详情。
- `my-xhs-home/src/main/java/com/myxhs/home/feign/UserFeignClient.java:21` 通过 `/api/user/{userId}/info` 获取用户公开信息。
- `my-xhs-home/src/main/java/com/myxhs/home/feign/NotificationFeignClient.java:21` 通过 `/api/notification/unread-count` 获取未读通知数。

这些调用证明，`home` 更像面向页面的 BFF，而不是某个单体领域服务。

这里先记住一个结论：

**`gateway` 解决“入口统一”，`home` 解决“页面拼装”。它们都在入口附近，但不是一回事。**

### 2. 账户与身份层

这一组包括：

- `user`
- `gateway` 中与 JWT / HMAC 有关的认证配置

`user` 负责注册、登录、用户资料、地址、Token 相关能力；而 `gateway` 负责把认证结果推广到所有下游服务。`my-xhs-user/src/main/resources/application.yml:28` 声明服务名 `my-xhs-user`，`my-xhs-gateway/src/main/resources/application.yml:282` 之后则配置了 JWT 密钥、HMAC 白名单和鉴权白名单。

这意味着账号体系不是只存在于 `user` 服务里，而是天然横跨 `user + gateway` 两个节点。后文写认证时，必须把它当成一个跨服务机制，而不是只看 `AuthController`。

### 3. 内容与流量层

这一组包括：

- `content`
- `analytics`
- `counter`
- `search`
- 部分 `home`

这一组服务共同负责“用户为什么会看到东西、看到之后发生了什么”。

- `content` 生成内容本体，负责笔记和评论等主数据。
- `analytics` 处理点赞、收藏、关注等社交动作。
- `counter` 提供计数视图，把点赞数、评论数、收藏数等聚合出来。
- `search` 负责内容和商品的检索、推荐和热搜。
- `home` 把这些能力重新拼成首页或详情页体验。

这里最重要的拓扑特征是：**内容层既有同步查询链，也有异步传播链。**

例如 `content` 通过 `my-xhs-content/src/main/java/com/myxhs/content/feign/UserFeignClient.java:21` 调用 `/api/user/internal/info/{userId}` 获取用户公开信息（昵称、头像），该客户端注释在 `my-xhs-content/src/main/java/com/myxhs/content/feign/UserFeignClient.java:12` 还明确写了“通知 senderName 填充”；与此同时，内容发布和互动行为又通过 MQ 向 Feed、通知、推荐等方向扩散。也就是说，这一组服务比交易链更像“读扩散网络”，而不是“强状态事务链”。

### 4. 交易主链层

这一组包括：

- `product`
- `cart`
- `coupon`
- `inventory`
- `order`
- `payment`

这是全卷最重要的一组，因为系统里的大部分分布式复杂度都集中在这里。

从拓扑上看，它们并不是平级兄弟，而是一条有前后顺序的链：

```text
product → cart / coupon → order → inventory / payment → notification / home
```

但这条链不是简单的“前一个服务调用后一个服务”。更准确地说：

- `product` 提供商品/SPU/SKU 视图和详情能力，是交易链的商品底座。
- `cart` 把商品变成“待结算集合”，会同步依赖 `product`。
- `coupon` 在结算前后都参与：先给优惠，再在订单成功或失败后做核销与退回。
- `order` 是编排中心，拉齐用户地址、商品价格、库存、优惠券和支付状态。
- `inventory` 持有库存扣减真相，不只是被 `order` 顺手调用的附属服务。
- `payment` 不是简单收款器，它还会反向通知订单状态变化；反向调用定义在 `my-xhs-payment/src/main/java/com/myxhs/payment/feign/OrderFeignClient.java:40`、`:64`、`:74`，分别对应支付成功、退款成功、退款失败通知订单侧。

在这个组里，真正的中心节点不是 `product` 也不是 `payment`，而是 `order`。但这个“中心”不是权威数据中心，而是**跨服务编排中心**。这是后面写交易链时必须先立住的判断。

### 5. 触达与会话层

这一组包括：

- `notification`
- `im`
- 部分 `home`

它们负责“业务动作发生之后，怎么让用户感知到”。

- `notification` 主要面向站内通知、SSE 推送、未读数聚合。
- `im` 负责即时会话和 WebSocket 路由。
- `home` 某些聚合接口又会把通知摘要、未读状态拼到页面上。

通知和 IM 经常在产品功能上被放在一起看，但拓扑角色不同：通知更偏事件消费与汇总，IM 更偏长连接与在线路由。写这一组时，不能用“都是消息”一句话带过。

## 同步链路：谁在直接调用谁

先看同步拓扑，因为这是读者最容易想象的那一层。

### 网关是所有外部 HTTP 流量的统一起点

`gateway` 服务名定义在 `my-xhs-gateway/src/main/resources/application.yml:26`，服务端口为 `19000`，见 `my-xhs-gateway/src/main/resources/application.yml:1`。路由层把最核心的业务服务都挂在统一前缀下：

- `/api/user/**` → `my-xhs-user`，见 `my-xhs-gateway/src/main/resources/application.yml:100`
- `/api/content/**`、`/api/note/**`、`/api/comment/**` → `my-xhs-content`，见 `my-xhs-gateway/src/main/resources/application.yml:109`
- `/api/order/**` → `my-xhs-order`，见 `my-xhs-gateway/src/main/resources/application.yml:129`
- `/api/payment/**` → `my-xhs-payment`，见 `my-xhs-gateway/src/main/resources/application.yml:139`
- `/api/home/**` → `my-xhs-home`，见 `my-xhs-gateway/src/main/resources/application.yml:205`
- `/api/recommend/**` 虽然是推荐入口，但实际复用 `my-xhs-search`，见 `my-xhs-gateway/src/main/resources/application.yml:232`

这一层最重要的意义，是把“用户请求打到哪个服务”改写为“用户请求先落到网关，由网关决定去哪”。这也是为什么后面几乎所有业务文档，都要默认把 `gateway` 当作零号参与者。

### 交易链中，Order 是同步编排中心

`order` 服务通过 Feign 直接依赖多个核心下游，这在源码层面很明确：

- 地址快照来自 `my-xhs-order/src/main/java/com/myxhs/order/feign/UserFeignClient.java:23`
- SKU 真值来自 `my-xhs-order/src/main/java/com/myxhs/order/feign/ProductFeignClient.java:26`
- 库存查询/释放/确认来自 `my-xhs-order/src/main/java/com/myxhs/order/feign/InventoryFeignClient.java:26`、`:32`、`:42`
- 优惠券折扣/核销/退回来自 `my-xhs-order/src/main/java/com/myxhs/order/feign/CouponFeignClient.java:26`、`:35`、`:42`
- 支付发起/回查/退款来自 `my-xhs-order/src/main/java/com/myxhs/order/feign/PaymentFeignClient.java:26`、`:32`、`:38`

这些依赖说明，订单服务并不拥有完成下单所需的全部事实：地址在用户侧、商品数据在商品侧、库存真相在库存侧、优惠状态在优惠券侧、支付结果又在支付侧。`order` 要做的，是在一次下单尝试中，把这些分散的事实临时拉成一条可执行链。

这就是为什么订单服务总会成为电商系统里最重的节点之一：它不是因为代码量最大，而是因为它承担了最多的跨服务时序责任。

### Home 是同步聚合中心，而不是事务中心

如果说 `order` 是“为了完成一个动作而编排多个服务”，那么 `home` 则是“为了拼出一个页面而并行查询多个服务”。

从 Feign 声明就能看出它的依赖面比很多业务服务都更宽：

- 商品详情来自 `my-xhs-home/src/main/java/com/myxhs/home/feign/ProductFeignClient.java:21`
- 用户公开信息来自 `my-xhs-home/src/main/java/com/myxhs/home/feign/UserFeignClient.java:21`
- 未读通知来自 `my-xhs-home/src/main/java/com/myxhs/home/feign/NotificationFeignClient.java:21`
- 此外还存在对 `content`、`analytics`、`counter`、`inventory`、`coupon`、`cart` 的 Feign 依赖，见 `my-xhs-home/src/main/java/com/myxhs/home/feign/`

但这里的依赖和 `order` 不同。`home` 的大部分调用不是为了推进一个强状态事务，而是为了给用户返回一个聚合视图。它的失败模式更偏“部分信息缺失时如何降级”，而不是“某一步失败后如何回滚整个交易”。

这个对照非常重要：

- `order` 的中心性来自事务编排。
- `home` 的中心性来自读聚合。

两者都很“中心”，但复杂度性质完全不同。

## 异步链路：什么时候拓扑从树变成网

如果同步调用解决的是“请求当前必须完成什么”，那么异步消息解决的是“动作发生之后，哪些效果不必阻塞主链路，但又必须最终扩散出去”。

### 内容与社交动作会向通知、Feed、推荐扩散

`content` 和 `analytics` 模块里可以看到大量 RocketMQTemplate 的发送逻辑：

- `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:133` 发布 `FEED_TOPIC`
- `my-xhs-content/src/main/java/com/myxhs/content/service/CommentService.java:186` 发布 `NOTIFICATION_TOPIC`
- `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:328` 发布 `NOTIFICATION_TOPIC`
- `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:588` 发布 `NOTIFICATION_TOPIC`
- `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:188` 发布 `RECOMMEND_BEHAVIOR_TOPIC`

这几条边说明：发布内容、评论、点赞、关注这些动作，并不会只停留在“源服务”自己内部。它们会继续扩散到：

- 通知是否生成
- Feed 是否刷新
- 推荐特征是否更新
- 计数是否补齐

也就是说，内容层的拓扑天然是“事件扩散型”的。

### 通知服务是异步汇聚点，不是动作发起点

通知服务表面上也暴露 HTTP 接口，但它在整个系统里的更关键角色，是异步消费者。`my-xhs-notification/src/main/java/com/myxhs/notification/consumer/NotificationEventConsumer.java:35` 声明它订阅 `NOTIFICATION_TOPIC`，`consumerGroup` 为 `notification-event-consumer-group`，并在 `:74` 真正调用通知服务处理事件。

因此在拓扑图里，`notification` 不能只画成“一个被 Gateway 访问的普通服务”，还要画成“多个业务动作的异步汇合点”。

### Inventory 一侧的异步边更像一致性保底

交易链里也有异步消息，但语义不同于内容层。内容层更像“体验扩散”，交易链的异步边更像“一致性保底”。

从库存服务实现和相关 Job 可以看到：

- `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:589` 会发送库存相关 MQ
- `my-xhs-inventory/src/main/java/com/myxhs/inventory/job/InventoryOutboxSenderJob.java:24` 明确写到它在处理发送失败和双花风险
- `my-xhs-inventory/src/main/java/com/myxhs/inventory/job/PreDeductTimeoutJob.java:217` 会发释放库存的异步消息

也就是说，库存这一侧的消息不是为了让页面更丰富，而是为了在同步链路失败、超时或部分成功时，给一致性一个缓冲和补偿通道。

## 工程问题：为什么“服务图”不能只画调用箭头

如果只画 `gateway → service → service`，这还是一张逻辑图，不是可运行的拓扑图。`my-xhs` 之所以值得单独写服务拓扑，是因为它的很多关键边并不是业务代码本身决定的，而是工程配置决定的。

### 服务名、端口和发现机制是一套独立事实

各服务在自己的 `application.yml` 里都显式声明了 `server.port` 与 `spring.application.name`：

- `my-xhs-user/src/main/resources/application.yml:1` / `:28`
- `my-xhs-order/src/main/resources/application.yml:1` / `:27`
- `my-xhs-payment/src/main/resources/application.yml:1` / `:31`
- `my-xhs-inventory/src/main/resources/application.yml:1` / `:28`
- `my-xhs-home/src/main/resources/application.yml:1` / `:27`

网关再通过 `lb://my-xhs-...` 的方式路由到这些服务，见 `my-xhs-gateway/src/main/resources/application.yml:101`、`:131`、`:141`、`:151`、`:206`。这说明服务拓扑至少要同时包含三层名字：

- 代码模块名
- Spring 应用名
- 对外访问路径或路由前缀

只列“模块路径”是不够的，因为运行时真正参与发现和路由的是服务名。

### Feign override 问题本身就是拓扑的一部分

前期修复里反复出现的 `Feign URL override` 不是边角料，而是系统拓扑的一部分。当前源码里 `order` 与 `home` 的 `application.yml` 没有保留显式 `spring.cloud.openfeign.client.config.{service}.url` 条目，说明这些 override 更可能存在于交接阶段已修改但当前源码未保留、或位于运行环境/Nacos 配置中。也就是说，关于“override 曾作为运行态兜底存在”这一点，本篇目前只有交接记录层面的证据，没有回收到静态配置原文。

这会直接影响我们如何理解“服务之间是否真的完全靠注册发现互通”。答案不是抽象上的“是”，而是工程上的“设计如此，但现实里某些链路曾经需要 override 保稳；但这一判断在本文当前证据层级上仍属于运行态历史事实，而不是静态源码事实”。

### Gateway 里已经内嵌了拓扑优先级

`my-xhs-gateway/src/main/resources/application.yml:129` 之后，订单、支付、库存、首页等路由都有不同的 `response-timeout` 和 `rate-limit-qps`。这说明拓扑图里并不是每条边都等价：

- 订单链路被视为慢但关键
- 支付链路被视为更慢且更敏感
- 搜索链路被视为高 QPS 快响应
- 首页链路被视为聚合型接口

这其实是在工程配置层面提前声明了一种业务优先级。把这些信息忽略掉，文章就会把真实系统压扁成“大家都是 HTTP 服务”。

## 微服务问题：真正的边界不是按代码仓库切的

写服务拓扑时，最容易犯的错，是把模块边界直接等同于微服务边界。源码目录确实分成了 `my-xhs-user`、`my-xhs-order`、`my-xhs-payment` 等模块，但从运行时看，真实边界更复杂。

### 第一种错觉：以为“谁有库，谁就是边界”

例如 `home` 看起来不像权威数据服务，因为它更偏聚合；但它仍然是一个独立运行节点，有自己的 SLA、自己的路由、自己的失败模式。因此微服务边界不只由数据库归属决定，还由流量入口、依赖密度、降级策略和页面语义决定。

### 第二种错觉：以为“谁最中心，谁就拥有最多真相”

`order` 在交易链上最中心，但它并不拥有库存、优惠券、支付三类真相。它更像是一个时序调度者。微服务架构里经常会出现这种现象：中心性最高的服务，不一定是数据权威性最高的服务。

### 第三种错觉：以为“异步消费者只是附属逻辑”

通知、推荐、Feed、对账、补偿这些消费者如果不画进拓扑图，系统看起来会简单很多。但那只是图变好看了，不是系统变简单了。真正的运行复杂度，恰恰躲在这些“主链之外但不能缺席”的消费者、Job 和补偿流程里。

## 真实故障案例：为什么服务拓扑必须把运行态也画进去

只看代码，很容易以为拓扑已经清楚；但前一阶段的修复证明，很多真正的拓扑问题是在运行时暴露的。

### 现象

在服务恢复阶段，`analytics`、`coupon`、`search` 都出现过端口冲突导致的启动失败；这类问题已在交接文档的故障清单中登记，当前稿只把它作为“运行态拓扑会断裂”的案例，而不是把交接文档本身当成原始证据。

### 根因

这类问题不是业务代码 bug，而是运行态拓扑没有稳定收敛：

- 服务名存在，但端口被占用，导致实例起不来。
- Nacos 理论上应该发现服务，但前提是实例真的启动成功并注册。
- 一旦某个关键节点没起来，上游网关路由和下游 Feign 链都会受到影响。

这类故障提醒我们：**服务拓扑不只是“逻辑上谁依赖谁”，还包括“运行时谁真的活着、谁真的注册成功、谁真的可达”。**

### 修复

前一阶段的修复策略并不复杂，但很说明问题：先检查端口占用，再重启服务，再确认端口和启动日志恢复正常。

### 验证

最终验证不是“代码看起来没问题”，而是：

- 服务端口开放
- 启动日志出现 `Started ...`
- 网关路由可达
- 关键服务已切到新代码

这里的运行态验证结论来自交接阶段已有记录；如果后续要把这篇升格为完全闭环的运行态正文，还需要补一轮端口检查、Nacos 实例检查和启动日志原始截面。

### 余波

这个案例的价值在于，它迫使我们承认：**拓扑图必须同时有静态图和运行态图。** 静态图解释职责和依赖，运行态图解释为什么同一条业务链在某天能通、某天却会断。

## 这一篇先收束成一张总图

到这里可以先把 `my-xhs` 的服务拓扑压缩成下面这张文字图：

```text
外部请求
  → gateway（统一入口、鉴权、限流、路由）
    → user（账号与身份）
    → content / analytics / counter / search（内容与流量）
    → product / cart / coupon / order / inventory / payment（交易主链）
    → home（BFF 聚合）
    → notification / im（触达与会话）

同步层：Feign 把订单编排链、首页聚合链串起来
异步层：RocketMQ 把内容扩散链、通知链、推荐链、一致性保底链织成网
基础层：MySQL / Redis / ES / Nacos / XXL-Job / SkyWalking 支撑整张图运行
```

这张图里最重要的不是服务数量，而是三条判断：

1. `gateway` 是统一入口，不是装饰层。
2. `order` 和 `home` 都是中心节点，但一个是事务编排中心，一个是读聚合中心。
3. 同步 Feign 负责把动作做完，异步 MQ 负责把影响扩散出去或把一致性补回来。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 网关统一入口与差异化路由：`my-xhs-gateway/src/main/resources/application.yml:80`
- 交易链同步编排：`my-xhs-order/src/main/java/com/myxhs/order/feign/UserFeignClient.java:23`、`my-xhs-order/src/main/java/com/myxhs/order/feign/ProductFeignClient.java:26`、`my-xhs-order/src/main/java/com/myxhs/order/feign/InventoryFeignClient.java:26`、`my-xhs-order/src/main/java/com/myxhs/order/feign/CouponFeignClient.java:26`、`my-xhs-order/src/main/java/com/myxhs/order/feign/PaymentFeignClient.java:26`
- 首页聚合的代表性跨服务读取：`my-xhs-home/src/main/java/com/myxhs/home/feign/ProductFeignClient.java:21`、`my-xhs-home/src/main/java/com/myxhs/home/feign/UserFeignClient.java:21`、`my-xhs-home/src/main/java/com/myxhs/home/feign/NotificationFeignClient.java:21`
- 内容服务对用户信息的用途：`my-xhs-content/src/main/java/com/myxhs/content/feign/UserFeignClient.java:12`、`my-xhs-content/src/main/java/com/myxhs/content/feign/UserFeignClient.java:21`
- 内容/社交动作向异步网络扩散：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:133`、`my-xhs-content/src/main/java/com/myxhs/content/service/CommentService.java:186`、`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:328`、`my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:188`
- 通知服务是异步汇聚点：`my-xhs-notification/src/main/java/com/myxhs/notification/consumer/NotificationEventConsumer.java:35`
- Feign override 问题当前仅有交接记录层证据，静态源码中未回收到显式 override 配置

## 边界清单

这篇刻意把边界写清楚：

- 本篇主分析线只覆盖 `gateway`、`user`、`content`、`analytics`、`counter`、`product`、`cart`、`coupon`、`inventory`、`order`、`payment`、`home`、`notification`、`im`、`search`；`ai-app`、`ai-mcp`、`ai-tools` 当前只作为网关挂载的旁支存在，后续单独分析，不并入本卷主拓扑判断。
- “网关是统一入口”“order 是事务编排中心”“home 是读聚合中心”属于源码与配置共同支持的判断。
- “内容层更像读扩散网络”“交易链异步边更像一致性保底”属于基于源码结构做出的设计解释，不应误写成框架规范。
- 端口冲突案例在本篇只用作运行态拓扑会断裂的说明，当前证据层级仍以交接记录为主；若要升级成 L2 运行态强结论，后续需补原始日志、端口检查与 Nacos 实例快照。
- 本篇是后续 `02-business-domains.md`、`03-data-flow.md`、以及交易主链篇章的硬前置：不先立住入口层、编排中心、聚合中心和异步扩散网的区别，后面的业务域边界和数据流分析都会失焦。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- `my-xhs` 的服务不是一张静态名录，而是一张分层、分组、分语义的拓扑网。
- 入口层、交易层、内容层、触达层的中心节点各自不同，不能用一把尺子量。
- 同步调用和异步消息在这张图里承担的是两套完全不同的职责。

但它还没进入两个更具体的问题：

- 这些服务边界为什么会被划成现在这样，而不是别的样子？
- 一条真实业务链上的数据，到底如何穿过这些服务与中间件流动？

所以下一篇不应该马上跳到某个单独服务，而应该先回答**业务域边界是怎么切出来的**。也就是：为什么用户、内容、交易、搜索、通知这些模块在拓扑上会形成今天这套分组，而不是一个更粗或更细的拆法。
