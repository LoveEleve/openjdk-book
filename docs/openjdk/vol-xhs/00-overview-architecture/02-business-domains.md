# 业务域划分与边界

> 对应目录：`vol-xhs/00-overview-architecture/`
> 目标问题：既然都是一个电商平台，为什么 `my-xhs` 要拆成用户、内容、商品、交易、搜索、通知这些域？这些边界到底是按数据库切、按接口切，还是按业务责任切？

## 一句话困惑

服务拓扑回答了“这些服务怎样连起来”，但还没有回答更根本的问题：**为什么偏偏是这些服务连在一起，而不是另一种拆法？**

如果不先把业务域边界讲清楚，后面的所有模块分析都会遇到同一个困惑：

- 为什么 `home` 这种明显依赖很多下游的服务，不被当成业务核心域？
- 为什么 `order` 是编排中心，却又不是库存、优惠券、支付真相的拥有者？
- 为什么 `search` 和 `notification` 看起来都像“下游功能”，却都被单独拉成独立服务？

这篇要回答的不是“有哪些模块”，而是**每个模块为什么应该在自己的边界里负责这些事，而不负责那些事**。

## 一句话答案

`my-xhs` 的边界不是按技术栈切，也不是按数据库张数切，而是按**业务真相归属 + 时序责任 + 读写模式 + 扩散方式**共同切出来的：谁持有真相，谁就形成权威域；谁只负责拼装展示，就应该留在聚合域；谁负责把动作传播出去，就会成为扩散域或触达域。

## 先建立一个比“模块名列表”更有用的判断框架

最容易犯的错误，是把业务域边界理解成目录边界：

- `my-xhs-user` 就是用户域
- `my-xhs-order` 就是订单域
- `my-xhs-search` 就是搜索域

这当然不算错，但还远远不够。

真正能帮助读者判断边界的，不是模块名，而是四个问题：

1. 这个域持有哪类业务真相？
2. 这类真相的状态机主要在谁手里？
3. 它是被别人同步读取，还是由它自己向外异步扩散？
4. 如果把它并进别的域，会先坏掉的是一致性、演进速度，还是页面聚合能力？

后文所有边界判断，都围绕这四个问题展开。

## 先推演第一个最常见的失败方案：按数据库归属切域

一种非常常见的直觉是：谁有自己的库，谁就是一个业务域；或者反过来，谁没有自己的库，就不应该算独立业务域。

这套方案看起来合理，因为数据库确实经常是系统中最硬的边界。但放到 `my-xhs` 上，很快就会出问题。

### 为什么它看起来合理

在很多业务系统里，领域对象和数据库表天然接近：

- 用户表在用户库里。
- 订单表在订单库里。
- 支付表在支付库里。

如果用这个标准来理解 `my-xhs`，读者会很自然地得出：

- `user`、`product`、`order`、`payment`、`inventory`、`coupon` 这些有明显主数据的服务，确实是业务域。
- `home` 这种看起来像聚合器的服务，因为不持有主数据，似乎不该算一个重要边界。
- `notification` 可能也会被误判成“附属能力”，因为它只是消费别人的事件后再落一份结果。

### 它真正卡住的地方

问题在于，数据库能告诉你“数据放在哪”，却不能告诉你“责任应该由谁承担”。

最典型的反例就是 `home`。`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:17` 直接把自己定义成“首页聚合接口（BFF 层）”；它的职责不是拥有某张权威表，而是把多个下游的结果并行拼起来：

- `my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:72` 到 `:75` 的笔记详情聚合，要汇总笔记、作者、计数、社交状态、评论。
- `my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:97` 到 `:100` 的商品详情聚合，要汇总 SPU、SKU、库存、商品计数。
- `my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:122` 到 `:124` 的用户主页聚合，要汇总用户信息、计数、社交关系、用户笔记。
- `my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:148` 到 `:149` 的购物车聚合，要汇总购物车列表、库存、优惠券。

如果按“谁有库谁成域”的方式理解系统，就会把 `home` 看成一个可以忽略的薄壳。但它明明拥有自己的边界：页面契约、聚合 SLA、下游降级策略、线程池模型、接口语义，都集中在这里。

所以第一个失败方案到这里已经站不住：**数据库归属可以帮助识别权威域，但不能单独决定业务域边界。**

## 再推演第二个同样常见的失败方案：按接口数量或调用中心性切域

另一种常见直觉是：谁接口多、依赖多、调用中心性高，谁就是核心域，其他都围着它转。

这套方案在 `my-xhs` 上同样会失真。

### 为什么它也很有诱惑力

从拓扑上看，`order` 和 `home` 都非常中心：

- `order` 需要拉地址、商品、库存、优惠券、支付等事实。
- `home` 需要拉内容、商品、用户、通知、购物车等结果。

如果只看“谁调用了很多下游”，很容易得出“这两个服务都应该拥有最多真相”的错觉。

### 它失败在哪里

`order` 的中心性来自**时序编排**，`home` 的中心性来自**读聚合**，两者不是同一种中心。

`order` 控制器在 `my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:47` 到 `:55` 暴露创建订单接口，后续又在 `:127` 到 `:137` 发起远程支付，在 `:188` 到 `:203`、`:239` 到 `:253` 处理支付成功、退款成功等回调。这个服务中心，是因为它承担了交易时序的推进责任。

但 `home` 的控制器则完全不是这类角色。`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:19` 到 `:25` 明确说它的职责是“将多个下游微服务的数据并行聚合，返回前端所需的完整 VO”，而且所有聚合接口都带降级语义。也就是说，`home` 的中心性不是因为它拥有真相，而是因为它是面向页面的汇聚点。

如果用“中心性最高者拥有最多真相”的思路切域，就会把 BFF 和事务编排中心混成一类。后果不是图画错一点点，而是后续所有分析都会把读聚合问题和状态机问题搅在一起。

## 先把业务域分成三层，而不是把所有服务硬塞进同一层分类

为了避免 `home`、`search` 这种服务在不同维度里反复出现时让读者误以为“分类打架”，这里先明确三层口径：

1. **权威域**：真正持有某类业务真相和状态机的域。
2. **展示/编排域**：不拥有主真相，但负责把多个权威域组织成可执行链或可展示页面。
3. **关联域**：与某个权威域高度耦合，但由于读写模式、检索方式、触达语义不同，被独立切开。

结合前一篇的拓扑图，这一篇更适合先按这三层看边界，再理解每个服务为什么落在这里。

## 1. 身份与账户域：它的边界由身份真相决定

这一组的核心不是“用户表很多”，而是它掌握了系统中谁是谁、能否登录、当前会话是否有效这些基础真相。

代表服务：

- `user`
- `gateway` 中与身份传播有关的部分

### 为什么 `user` 是权威域

`my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:18` 把认证接口明确限定为注册、登录、注销、刷新 Token、验证码。这里的动作都围绕一件事：**确认一个请求代表的是哪个用户，以及这个身份凭证是否还有效。**

例如：

- `my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:31` 暴露验证码入口。
- `my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:39` 暴露注册入口。
- `my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:52` 暴露登录入口。
- `my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:61` 暴露刷新 Token 入口。
- `my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:73` 暴露注销入口。

这些动作虽然最终也会影响别的域，但身份真相本身只能在 `user` 一侧产生。

### 为什么 `gateway` 不会把 user 吞掉

`gateway` 明明掌握 JWT、HMAC、白名单等认证逻辑，看起来也很像“身份域的一部分”。这就很容易诱发一个错误念头：既然网关也懂认证，为什么不把身份问题都收进网关？

因为网关持有的是**传播与校验责任**，不是**身份生成与生命周期真相**。这一点在网关过滤器里也能看到：`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:38` 明确写了“鉴权通过后，注入 X-User-Id Header 到下游服务”，并在 `:126` 到 `:145` 通过 `mutate()` 覆盖写入 `X-User-Id` 和 `X-Trace-Id`。也就是说，网关负责把认证结果扩散到全链路，但注册、登录、刷新、登出这些状态变化仍然属于 `user` 域。两者共同组成账户与身份域，但边界并没有消失。

## 2. 内容与社交域：它的边界由“内容本体 + 互动动作”共同决定

这一组的权威核心包括：

- `content`
- `analytics`
- `counter`

与它强关联、但不并入权威核心的相关域包括：

- `search`（检索与发现视图域）
- 部分 `home`（展示聚合边界）


这几者之所以能形成一个大域，不是因为它们都叫“内容相关”，而是因为它们围绕同一类用户问题：**用户看到了什么、做了什么、别人又如何感知到这些动作。**

### `content` 为什么单独成域

`content` 控制器掌握的是内容本体：

- 笔记发布
- 笔记详情
- 评论列表
- 评论写入

它决定“内容是什么”。

### `analytics` 与 `counter` 为什么没有并回 content

这是一个很值得单独讲的边界。

如果系统规模不大，把点赞、收藏、关注、计数全部塞回 `content` 是一种非常自然的做法。这里说的是一种教学性失败方案推演，不是 `my-xhs` 的历史实现。`my-xhs` 没这么做，因为互动动作和内容本体的读写模式不同：

- 点赞、收藏、关注更偏高频动作、幂等控制、异步传播。
- 计数更偏聚合视图、对账、回填和读优化。
- 内容本体则更偏对象生命周期和审核/展示语义。

所以 `content`、`analytics`、`counter` 不是随手拆散的，而是沿着“内容真相”“互动动作”“聚合计数视图”三条不同责任线被切开。

### `search` 为什么与内容域强相关，但不直接并入其中

`search` 控制器在 `my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:18` 到 `:22` 把自己定义为核心搜索接口，并通过 `:47` 与 `:68` 分别提供笔记搜索和商品搜索。从这些入口和后续索引/召回实现可以看出，它需要消费内容和商品数据，但它持有的不是内容真相，而是**检索视图与召回/排序能力**。

因此它和内容域强关联，却不等于内容域本体。把 `search` 并回 `content`，会把“内容对象的生命周期”和“内容检索的组织方式”绑死在一起。

## 3. 商品与交易准备域：它的边界由“可卖什么、待买什么、能优惠什么”决定

这一组包括：

- `product`
- `cart`
- `coupon`

这里三者之所以能被放进同一组，不是因为它们都服务于“下单之前”，而是因为它们共同回答交易准备阶段的三个问题：

- 平台到底卖什么。
- 用户当前准备买什么。
- 这些待买条目能否享受什么优惠。

### `product` 为什么是商品真相域

`my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:24` 到 `:30` 明确把自己定义成 SPU/SKU CRUD、上架/下架、分类树查询的入口。这个域回答的是：

- 平台上到底卖什么。
- 一个商品的 SPU/SKU 结构是什么。
- 商品当前是否可上架展示。

这类真相天然不该让 `cart` 或 `order` 持有。

### `cart` 为什么不等于“订单前半段”

很多系统会把购物车直接并进订单域，理由是购物车反正只是下单前的暂存区。但这里更合理的理解是：**购物车属于交易准备域，不属于交易完成域。**

它解决的问题不是“订单是否成立”，而是“用户准备买什么、买多少、哪些条目当前仍然可结算”。这和订单状态机已经是两种问题。源码入口也印证了这一点：`my-xhs-cart/src/main/java/com/myxhs/cart/controller/CartController.java:18` 到 `:23` 把购物车定义成“Redis 为权威数据源，MQ 异步持久化到 MySQL”的区域，`/add`、`/quantity`、`/merge`、`/clear` 等接口都围绕准备态集合操作展开，见 `my-xhs-cart/src/main/java/com/myxhs/cart/controller/CartController.java:36`、`:48`、`:106`、`:119`。

### `coupon` 为什么也不并进 order

优惠券在用户视角里常常跟下单绑在一起，所以最容易被误判成订单域的一部分。但 `coupon` 持有的是另一套真相：

- 模板是否存在。
- 当前库存是否足够。
- 用户是否已经领取。
- 当前券是否已核销、已退回、已过期。

订单只是在某个时刻借用优惠券状态，而不是拥有优惠券状态。`my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:19` 到 `:24` 也明确把自己定义成“券模板管理、领券、用券、退券、查询”的接口集合；其中 `/claim`、`/user/available` 面向用户侧，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:105`、`:126`，而 `/discount/{id}`、`/use`、`/return` 又明确作为订单侧内部 Feign 接口存在，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:133`、`:147`、`:160`。这正说明券域既要对用户暴露生命周期，又要对订单暴露借用接口，但两者的真相都仍留在 `coupon` 域内。

## 4. 交易执行域：它的边界由状态机和时序责任决定

这一组包括：

- `order`
- `inventory`
- `payment`

这是系统最重的一组，因为它不是围绕“看什么”组织，而是围绕“一个动作最终能不能完成”组织。

### `order` 为什么是编排中心，不是全能真相域

`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:47` 到 `:55` 负责创建订单，`:87` 到 `:93` 负责取消订单，`:127` 到 `:137` 负责支付发起，`:188` 到 `:203` 负责支付成功回调。这些动作说明，订单域的边界不在“它有订单表”，而在**它掌握了交易时序主线**。

但它并不拥有所有真相：

- 地址真相在 `user`
- SKU 真相在 `product`
- 库存真相在 `inventory`
- 券状态真相在 `coupon`
- 支付执行真相在 `payment`

这就是为什么 `order` 必须被理解成编排域，而不是万能域。

### `inventory` 为什么不能只算 order 的一个子能力

如果只从“下单要扣库存”来看，最直觉的做法是把库存作为订单域里的一个子模块。但 `inventory` 实际上拥有自己的状态机、自己的补偿逻辑、自己的 MQ 与 Job，因此它持有的是独立真相：**库存到底还有多少、预扣和确认如何转化、失败后如何释放。**

这套真相一旦并回订单域，交易链会更“集中”，但库存语义会被下单语义吞掉，后续任何补偿、对账、回补都会变得难以独立演进。

### `payment` 为什么必须独立

支付域的职责不是“给订单补一个字段”，而是执行支付、查询支付状态、发起退款，并通过回调把结果反向推回订单域。支付侧入口在 `my-xhs-payment/src/main/java/com/myxhs/payment/controller/PaymentController.java:15` 到 `:24` 已经把这组能力列清楚，`/pay`、`/status/{orderId}`、`/refund` 分别对应支付发起、状态查询、退款，见 `my-xhs-payment/src/main/java/com/myxhs/payment/controller/PaymentController.java:48`、`:143`、`:101`；而订单侧又在 `my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:188`、`:239` 接住支付成功和退款成功回调。正好说明支付和订单是两个域：一个执行资金侧动作，一个收敛订单侧状态。

## 5. 触达与体验扩散域：它的边界由“如何让用户感知到变化”决定

这一组包括：

- `notification`
- `im`
- 部分 `home`

### `notification` 为什么独立

`my-xhs-notification/src/main/java/com/myxhs/notification/controller/NotificationController.java:37` 到 `:63` 负责 SSE 连接 ticket 和连接建立，`:70` 到 `:87` 负责通知列表与未读计数，`:95` 到 `:121` 负责已读状态变更。这说明通知域持有的真相不是“业务动作发生了没”，而是**用户最终收到了什么、读了什么、还有多少未读。**

这和内容、互动、订单本身已经是不同层次的问题。

### `im` 为什么不能并进 notification

通知和 IM 都属于“消息感知”，但两者的时序模型差别非常大：

- 通知更偏事件消费、聚合、未读数和 SSE 推送。
- IM 更偏会话流、在线路由、WebSocket 连接状态。

如果把两者压进同一个域，只因为它们都“会给用户发东西”，那其实是按界面感觉切域，而不是按责任切域。

## 业务域边界真正依赖的四个判断

到这里可以把整套边界原则压缩成四个判断。

### 1. 谁持有业务真相

- 身份真相在 `user`
- 商品真相在 `product`
- 券真相在 `coupon`
- 库存真相在 `inventory`
- 支付执行真相在 `payment`
- 通知投递与未读真相在 `notification`

### 2. 谁承担主时序责任

- 下单主时序在 `order`
- 页面聚合主时序在 `home`
- 搜索召回与热搜记录时序在 `search`

### 3. 谁主要被同步读取，谁主要向外异步扩散

- `order`、`home` 更偏同步编排/聚合
- `content`、`analytics`、`search`、`notification` 更强依赖异步扩散

### 4. 如果并域，先坏掉的是什么

- 把 `home` 并进任何权威域，先坏的是聚合边界与页面契约
- 把 `coupon` 并进 `order`，先坏的是券生命周期独立性
- 把 `inventory` 并进 `order`，先坏的是库存补偿与独立演进能力
- 把 `notification` 并进内容或互动域，先坏的是触达语义与未读模型

## 真实故障案例：边界不清时，工程问题会反向暴露业务域关系

业务域边界不只是设计讨论，它会直接在故障中暴露出来。

### 现象

前一阶段修复里，`gateway`、`home`、`order`、`search`、`notification` 都出现过和“边界传播”有关的问题：

- 网关缺路由时，推荐入口直接不可达。
- `home` 的 Feign URL override 问题会让本来只是聚合层的服务因为下游寻址失败整体失能。
- `notification` 的唯一约束设计过严，会把原本应该在通知域内部收敛的问题放大成服务启动问题。

### 根因

这些问题表面上是工程故障，实质上反映的是业务域边界：

- 网关是入口域，不可达会阻断整条外部访问面。
- `home` 是聚合域，任何一个关键下游寻址不稳定，都会直接伤到页面体验。
- `notification` 是触达域，它内部的聚合模型设计失衡，会直接影响“用户是否看得到变化”。

### 修复

这些问题的修复不是“统一加几个配置”就完了，而是要先知道每个域到底在系统里负责什么，才能判断故障会扩散到哪里。

### 验证

是否真正修好，也不能只看单服务启动成功，而要看：

- 入口是否恢复可达
- 聚合是否恢复拼装
- 触达是否恢复生成和已读流转

### 余波

这个案例提醒我们：**业务域边界不是静态建模练习，它决定了故障沿着哪条链扩散。**

## 这一篇先收束成一张边界图

```text
身份与账户域
  user + gateway中的身份传播

内容与社交域
  content + analytics + counter + 部分home

商品与交易准备域
  product + cart + coupon

交易执行域
  order + inventory + payment

触达与体验扩散域
  notification + im + 部分home

检索与发现关联域
  search（与内容/商品强关联，但不并入它们的权威域）

聚合展示域
  home（不拥有主数据，负责面向页面拼装）
```

这里最重要的不是分了几组，而是两条判断：

1. 一个服务是否独立成域，关键看它是否拥有不可替代的真相、时序责任或聚合契约。
2. 一个服务依赖很多下游，并不自动意味着它拥有最多真相；它可能只是编排中心，也可能只是聚合中心。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 身份与认证入口：`my-xhs-user/src/main/java/com/myxhs/user/controller/AuthController.java:18`
- 商品真相域：`my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:24`
- 商品内部批量 SKU 读取：`my-xhs-product/src/main/java/com/myxhs/product/controller/ProductController.java:176`
- 订单时序编排与支付回调：`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:47`、`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:127`、`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:188`、`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:239`
- 首页聚合边界：`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:17`、`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:69`、`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:95`、`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:120`、`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:145`
- 搜索作为检索与发现关联域：`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:18`、`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:47`、`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:68`
- 购物车作为交易准备域：`my-xhs-cart/src/main/java/com/myxhs/cart/controller/CartController.java:18`、`my-xhs-cart/src/main/java/com/myxhs/cart/controller/CartController.java:36`、`my-xhs-cart/src/main/java/com/myxhs/cart/controller/CartController.java:106`
- 优惠券作为独立生命周期域：`my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:19`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:105`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:133`
- 网关承担身份传播而非身份生成：`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:38`、`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/GatewayAuthFilter.java:126`
- 支付域与订单域分离：`my-xhs-payment/src/main/java/com/myxhs/payment/controller/PaymentController.java:15`、`my-xhs-payment/src/main/java/com/myxhs/payment/controller/PaymentController.java:48`、`my-xhs-payment/src/main/java/com/myxhs/payment/controller/PaymentController.java:101`、`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:188`
- 通知作为触达域：`my-xhs-notification/src/main/java/com/myxhs/notification/controller/NotificationController.java:37`、`my-xhs-notification/src/main/java/com/myxhs/notification/controller/NotificationController.java:67`、`my-xhs-notification/src/main/java/com/myxhs/notification/controller/NotificationController.java:82`

## 边界清单

- 本篇仍是全局边界篇，不进入各域内部状态机细节；库存三级扣减、优惠券生命周期、订单状态流转会在后续篇章展开。
- `home` 在本文中不被视为任何权威域的成员，而是单独的聚合展示域；正文里提到它与内容域、触达域强相关，表达的是依赖关系，不是归属关系。
- `search` 与内容/商品关系很深，但本文把它单列为“检索与发现关联域”；正文里把它放进内容与流量语境，是在描述流量联系，不是在改写它的边界归属。
- 本篇对故障案例的处理仍以交接阶段记录为辅证，主要作用是说明边界不清会如何放大工程问题；若要做运行态强结论，仍需补日志、端口、Nacos、Trace 等原始证据。
- `ai-app`、`ai-mcp`、`ai-tools` 继续排除在本卷主分析线之外，后续单独处理。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- `my-xhs` 的边界不是按模块名、数据库或接口数量机械切出来的。
- 权威域、编排域、聚合域、检索域、触达域在系统里的职责完全不同。
- `order` 与 `home` 虽然都很中心，但一个是交易执行域的编排中心，一个是聚合展示域的拼装中心。

但它还留下了一个更具体的问题：这些已经切开的域，在一次真实业务链里到底怎样流动、怎样交接、怎样把状态从一个域传到另一个域？

所以下一篇应该进入 `03-data-flow.md`，去回答**从浏览、加购、领券、下单到支付完成，这些域之间的数据到底是怎么流动的**。
