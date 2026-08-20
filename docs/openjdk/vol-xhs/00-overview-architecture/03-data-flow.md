# 核心数据流

> 对应目录：`vol-xhs/00-overview-architecture/`
> 目标问题：从浏览商品到支付完成，数据到底怎样穿过 `gateway`、`home`、`cart`、`coupon`、`order`、`inventory`、`payment`、`notification` 这些域？

## 一句话困惑

理解了服务拓扑，也理解了业务域边界之后，读者仍然会卡在一个更具体的问题上：**这些边界之间的数据到底怎么流？**

尤其在 `my-xhs` 这种系统里，很多动作并不是“前端请求一次 → 一个服务写一次库 → 结束”。真实链路更像这样：

- 浏览商品时，页面已经在拼装多个下游返回值。
- 加购物车时，权威数据先写 Redis，再异步落 MySQL。
- 领优惠券时，库存和限领先在 Redis Lua 里原子扣减，再同步发 MQ 写数据库。
- 下单时，订单并不拥有全部真相，而是临时把地址、SKU、库存、优惠、支付拉成一条链。
- 支付成功后，状态又会反向流回订单、库存、通知这些域。

如果不把这条数据流讲清楚，前两篇建立的拓扑图和边界图还只是静态地图，读者依然不知道系统到底是怎么跑起来的。

## 一句话答案

`my-xhs` 的核心数据流不是单线直达，而是**展示读流先聚合、准备态数据先缓存、交易态数据先编排、结果态数据再回写并扩散**的多段式流动：前半段偏读聚合和准备态缓存，后半段偏事务编排和最终一致扩散。

## 先给出整条主链的最小图

```text
浏览商品
  → home 聚合 product + inventory + counter
加购物车
  → cart 先写 Redis 三结构，再异步发 MQ 落 MySQL
领优惠券
  → coupon 先 Lua 扣库存/限领，再同步 MQ 入库
创建订单
  → order 拉 user/product/inventory/coupon/payment 多方事实
支付完成
  → payment 更新支付态，再回调 order 收敛订单态
后续扩散
  → inventory / notification / home 等域感知变化
```

这条链里最重要的，不是“经过了几个服务”，而是每一段为什么要选择当前的数据承载方式：

- 为什么展示态读流优先做聚合。
- 为什么购物车权威数据先放 Redis。
- 为什么优惠券用 Lua + MQ 同步写库。
- 为什么订单要拉齐多方事实而不是只写自己。
- 为什么支付成功后不是结束，而是新一轮状态传播的起点。

## 先推演第一个失败方案：把整条链都理解成同步 CRUD

最直觉的理解方式是：

1. 页面打开就查商品表。
2. 加购物车就写购物车表。
3. 领券就写用户券表。
4. 下单就写订单表。
5. 支付就改订单状态。

这套理解在单体系统里偶尔还能凑合，但在 `my-xhs` 里很快就会失效。

### 为什么这种理解看起来合理

因为每一步单独看都像一个普通业务动作：

- 浏览商品像一次查询。
- 加购物车像一次写入。
- 领券像一次库存扣减。
- 下单像一次订单创建。
- 支付像一次状态更新。

如果只从 API 表面观察，很容易觉得整条链不过是几次 REST 调用和几次表写入。

### 它失败在什么地方

它完全看不见三件事：

1. **展示态数据不是单源查询，而是多源聚合。**
2. **准备态数据未必先写数据库，可能先写缓存或先走 Lua。**
3. **交易完成后的结果不会停在本域里，而会继续向别的域扩散。**

也就是说，这套“同步 CRUD”理解法，最开始会低估读路径复杂度，中间会误判权威数据位置，最后会漏掉结果传播。

## 再推演第二个失败方案：把所有真相都塞进 order

另一种同样常见的误解是：既然交易主链最后都要落到订单，那不如把地址、库存、优惠券、支付这些真相都理解成“订单域的附属数据”。

这也不对。

### 为什么它也很有诱惑力

`order` 确实是最重的编排中心：它要拉地址、SKU、库存、优惠、支付，还要处理支付成功、退款成功等后续回调。只看时序图，订单像一个天然的汇聚中心。

### 它真正的问题

订单是**时序汇聚点**，不是**真相吞并点**。

- 地址真相仍在 `user`
- SKU 真相仍在 `product`
- 券真相仍在 `coupon`
- 库存真相仍在 `inventory`
- 资金执行真相仍在 `payment`

如果把这些真相都想象成“最后都归 order”，后面就会完全无法解释：为什么库存还需要自己的补偿和 MQ，为什么优惠券还需要自己的 Lua 和 Outbox，为什么支付还要反向回调订单侧。

因此，数据流的正确理解方式不是“最后流到哪张表就算谁的”，而是“哪一段暂时借用了别人的真相，哪一段真正改写了谁的真相”。

## 第一段数据流：浏览商品时，数据先在展示域汇合

浏览商品是整条链的最前段，但它已经不是单源查询。

`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:95` 到 `:114` 暴露了商品详情聚合接口 `/api/home/product/{spuId}`。这意味着前端并不总是直接打 `product` 服务，而是先进入 `home` 这个聚合展示域。

真正的聚合逻辑在 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:22` 到 `:34` 已经写得很清楚：

- 第一层并行拉 `SPU` 详情和商品计数，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:59`。
- 第二层在拿到 `SKU` 列表后，再并行拉每个 `SKU` 的库存，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:123`。
- 最终再把 `spu`、`sku`、库存、计数组装成完整的 `ProductDetailAggVO`，见 `my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:128`。

这说明浏览商品时，数据流不是：

```text
前端 → product → 商品详情
```

而更接近：

```text
前端 → gateway → home
               ├─→ product（SPU/SKU 真相）
               ├─→ inventory（库存真相）
               └─→ counter（计数视图）
```

这里的关键判断是：**浏览商品时，数据首先不是写入，而是跨域汇合。** 这一段的主角不是事务，而是聚合。

## 第二段数据流：加购物车时，权威数据先进入 Redis，再异步落库

购物车是整条链里最容易暴露“权威数据位置”反直觉的一段。

很多人下意识会认为购物车数据当然在 MySQL 里。但 `my-xhs-cart/src/main/java/com/myxhs/cart/controller/CartController.java:21` 到 `:22` 已经明确写了：所有接口需登录，购物车操作**以 Redis 为权威数据源，MQ 异步持久化到 MySQL**。

服务实现把这件事讲得更具体。`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:31` 到 `:47` 解释了它的核心设计：

- Redis 三结构协同：`Hash + Set + ZSet`
- Redis 为权威数据源
- MQ 异步持久化到 MySQL
- 商品详情通过 Feign 从 `product` 补齐

加购物车入口在 `my-xhs-cart/src/main/java/com/myxhs/cart/controller/CartController.java:36`，真正写数据时，`CartService.addToCart()` 在 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:118` 开始执行：

1. 先校验 `SKU` 是否存在，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:123`。
2. 用 Lua 脚本原子更新 Redis 的 `items / checked / sort` 三结构，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:130`。
3. 成功后发送 `CART_TOPIC` 事件异步持久化，见 `my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:153` 和 `:673`。

也就是说，这一段数据流不是：

```text
前端 → cart → MySQL 购物车表
```

而是：

```text
前端 → gateway → cart
               ├─→ Redis 三结构（权威）
               ├─→ product（校验/补齐 SKU）
               └─→ MQ → MySQL（异步持久化）
```

这一步非常关键，因为它定义了“准备态数据”的真实位置：**购物车真相先落缓存，再异步收敛到数据库。**

## 第三段数据流：领优惠券时，库存和用户领取次数先在 Redis Lua 里原子收敛

优惠券的流动方式，又和购物车不同。

`my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:99` 到 `:112` 暴露了用户领券入口 `/api/coupon/claim`。但真正重要的不是接口本身，而是服务端怎样处理“库存”和“限领”这两个竞争条件。

`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:37` 到 `:45` 先写明了 Redis 设计：

- 券库存 `stock`
- 用户领取次数 `claimed`
- 模板缓存 `template`

到了 `claimCoupon()`，数据流非常清楚：

1. 先从缓存取模板，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:196`。
2. 再执行 Lua 脚本，同时检查库存、检查限领、扣库存、记录领取次数，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:211` 到 `:219`。
3. 只有 Redis 这一步成功，才同步发送 `COUPON_CLAIM_TOPIC` 事件写 MySQL，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:227` 和 `:540`。
4. 如果 MQ 同步发送失败，再回滚 Redis 库存，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:228` 到 `:230` 以及 `:578`。

这说明领券不是“先写库，再改缓存”，也不是“缓存库随便选一个”。它的真实流动方式是：

```text
前端 → gateway → coupon
               ├─→ Redis Lua（库存 + 限领原子收敛）
               └─→ MQ syncSend → MySQL 用户券/Outbox
```

购物车和优惠券到这里已经出现明显分化：

- 购物车选择“Redis 权威 + MQ 异步落库”。
- 优惠券选择“Redis 原子扣减 + MQ 同步入库 + 失败回滚”。

这正好说明：**同样是准备态数据，不同域也会根据一致性要求采用不同流法。**

## 第四段数据流：创建订单时，多个域的真相被临时拉成一条同步链

订单是整条链里最重的一段，因为从这一刻起，系统开始从“准备态”进入“执行态”。

`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:47` 到 `:55` 暴露了创建订单入口 `/api/order/create`。真正的核心逻辑在 `OrderService.createOrder()`，从 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:123` 开始。

这里的数据流可以拆成几步：

### 1. 先挡住重复创建和并发创建

- 幂等键：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:127` 到 `:133`
- 用户级分布式锁：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:135` 到 `:143`

这一层还没有跨域拉数据，但它先决定“谁有资格进入交易编排”。

### 2. 再拉商品与库存真相

- SKU 详情来自 `product`，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:147` 到 `:156`
- SPU/SKU 状态校验在订单侧再次执行，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:158` 到 `:169`
- 库存前置校验来自 `inventory`，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:171` 到 `:183`

### 3. 再拉地址与优惠真相

- 地址快照在订单服务中通过 `resolveAddressSnapshot` 获取，调用起点见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:201` 到 `:214`
- 金额计算与优惠折扣收敛在订单侧完成，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:186` 到 `:193`

### 4. 再把交易主线落到本地事务与事务消息

- 事务消息 Topic 定义在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:85`
- 半消息发送在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:225` 到 `:229`
- 本地事务提交后，再继续后续流程

### 5. 最后才核销优惠券

如果用户带了优惠券，订单服务还会同步调用 `coupon` 进行核销，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:243` 到 `:259`。

所以这一段真正的数据流不是：

```text
前端 → order → 订单表
```

而是：

```text
前端 → gateway → order
               ├─→ product（SKU 真值）
               ├─→ inventory（库存前置校验）
               ├─→ user（地址快照）
               ├─→ coupon（折扣计算 / 核销）
               ├─→ 本地事务（订单/明细/消息）
               └─→ RocketMQ 事务消息 / 延时关单消息
```

到这里，读者应该先抓住一个核心判断：**订单域真正做的，不是拥有所有真相，而是把别域真相临时拉进一条可提交的执行链。**

## 第五段数据流：支付域接管资金动作，再把结果反向送回订单域

支付并不是订单的一次字段更新，而是一次跨域接管。

`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:127` 到 `:137` 说明：当 `pay.type=remote` 时，订单服务会构造 `PayCreateRequest` 并通过 `PaymentFeignClient` 调用支付服务。

支付域收到请求后，`my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:147` 开始处理 `pay()`：

1. 先做幂等与分布式锁，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:159` 到 `:176`
2. 再回查订单状态，确认订单仍是待付款，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:178` 到 `:189`
3. 插入支付记录，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:197` 到 `:218`
4. 调用支付渠道策略发起支付，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:226` 到 `:233`
5. Mock 模式同步成功，真实异步模式则登记回调模拟器，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:235` 到 `:241`

这一段的重点不是“支付单写成功了”，而是**支付域开始拥有一份资金侧执行状态**。从此之后，订单是否完成，必须等待支付结果再回流回来。

## 第六段数据流：支付结果回流订单，再继续向别的域扩散

这条链最容易被低估的地方，是很多人会把“支付成功”当成终点。但在 `my-xhs` 里，支付成功更像下一轮数据流的起点。

订单控制器里已经暴露了支付成功和退款成功回调：

- `my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:188` 到 `:203` 处理支付成功
- `my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:239` 到 `:253` 处理退款成功

支付域真正处理完回调后，会继续通知订单域更新状态。于是数据开始反向流动：

```text
payment → order
```

但流到 `order` 也还没结束。订单状态变化之后，还会继续影响：

- `inventory`：预扣库存确认或回补
- `coupon`：券状态保持已核销，或在取消/退款时退回
- `notification`：用户最终是否感知到支付/交易结果
- `home` / 页面聚合：用户再次打开页面时看到的是新状态

所以支付成功不是链路终点，而是“交易态数据开始向结果态数据扩散”的分水岭。

## 第七段数据流：通知域把别的业务动作翻译成用户能感知到的结果

如果前几段数据流解决的是“系统内部状态怎么变”，那么通知域解决的是“用户怎么知道这些变化发生了”。

`my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:27` 到 `:32` 把通知服务的核心职责写得很清楚：

1. 处理通知事件
2. 通知列表查询
3. 标记已读
4. 获取未读计数

最关键的是 `processEvent()`。在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:47` 到 `:79` 里，通知服务会：

1. 构建通知实体
2. 聚合处理
3. 更新未读数
4. 如果用户在线，则通过 `SseEmitterManager` 直接推送通知和未读计数

所以这一段数据流不是：

```text
某个业务动作 → 数据库
```

而是：

```text
content / analytics / 其他事件源
  → MQ
    → notification
      ├─→ 通知表 / 聚合器
      ├─→ 未读计数
      └─→ SSE 推送给在线用户
```

到这里整条主链才真正闭环：业务变化最终变成用户可见的结果。

## 这条主链真正隐含的三个设计判断

把前面七段数据流压缩一下，能看到三个非常重要的设计判断。

### 1. 展示态优先聚合，不优先落库

商品浏览、首页展示、用户主页这些入口，并不是先造一张“全能宽表”，而是先用 `home` 这种聚合展示域拼出结果。因为这里的问题是“给用户看什么”，不是“先把状态写死在哪”。

### 2. 准备态优先选择对自己最合适的权威存储

- 购物车选择 Redis 为权威，再异步落库。
- 优惠券选择 Redis 原子扣减，再同步 MQ 入库。

这说明系统并没有强迫所有准备态数据都走同一条路，而是按一致性和并发压力决定流法。

### 3. 执行态和结果态是两段不同的数据流

订单与支付解决的是“交易能不能成立”，通知与页面展示解决的是“交易成立后用户如何感知”。把这两段混成一段，就会既看不清一致性问题，也看不清体验扩散问题。

## 真实故障案例：为什么数据流一旦断在中间，问题会在别的域里暴露

数据流文章如果只讲理想路径，很容易显得漂亮却不真实。`my-xhs` 前一阶段的一些修复，恰好说明数据流一旦断在中间，问题未必会在断点本身爆出来。

### 现象

例如购物车、优惠券、订单、通知这些域都大量依赖“动作先发生，再通过 MQ 或 Feign 扩散”。一旦中间的路由缺失、消费失败、幂等标记卡死，最终暴露出来的现象可能是：

- 用户加了购物车但列表异常
- 券库存变化了但用户券没入库
- 支付完成了但订单状态没有更新
- 业务动作发生了但通知没有到达

### 根因

这些问题的共同点，不在于某个单点代码坏了，而在于**数据流在某一段停住了，但系统的其他段还在继续前进**。于是不同域看到的是不同步的世界。

### 修复

前一阶段大量修复都围绕这件事展开：

- 有的修路由，让流量先能到正确服务。
- 有的修 MQ 幂等与回滚，让消息失败后还能重试。
- 有的修 traceId 透传，让跨域数据流断点能被追出来。

### 验证

因此这类问题的验证不能只看一个接口返回 200，而要看：

- 入口请求是否成功
- 中间 Feign / MQ 是否到达
- 下游状态是否真的变化
- 用户最终是否能感知到结果

### 余波

这个案例说明，**核心数据流一旦建立起来，故障也会沿着同一条流扩散。** 这正是后续每一篇都必须带故障案例的原因：没有故障，就看不出数据流真正的脆弱点在哪里。

## 这一篇先收束成一张总图

```text
展示读流
  前端 → gateway → home → product / inventory / counter

准备态数据流
  前端 → gateway → cart → Redis(权威) → MQ → MySQL
  前端 → gateway → coupon → Redis Lua(库存/限领) → MQ syncSend → MySQL

交易执行流
  前端 → gateway → order
                 → user / product / inventory / coupon / payment
                 → 本地事务 + 事务消息

支付回流
  payment → order → inventory / coupon / 后续状态收敛

结果扩散流
  content / analytics / 其他事件源 → MQ → notification → 未读数 / SSE / 用户可见结果
```

这张图里最关键的不是箭头多，而是三条判断：

1. 展示态、准备态、执行态、结果态是四种不同的数据流语义。
2. `order` 是执行态编排中心，但不吞并别域真相。
3. 支付成功不是终点，通知到达用户才是结果态的可见闭环。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 商品详情读聚合：`my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:95`、`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:24`、`my-xhs-home/src/main/java/com/myxhs/home/service/ProductAggService.java:59`
- 购物车 Redis 权威 + MQ 落库：`my-xhs-cart/src/main/java/com/myxhs/cart/controller/CartController.java:21`、`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:31`、`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:130`、`my-xhs-cart/src/main/java/com/myxhs/cart/service/CartService.java:153`
- 优惠券 Redis Lua + MQ 同步入库：`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:37`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:178`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:227`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:540`
- 订单多域编排：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:123`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:147`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:171`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:225`
- 支付接管与回流：`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:127`、`my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:147`、`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:188`
- 通知结果扩散：`my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:27`、`my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:47`

## 边界清单

- 本篇刻意只画主流，不展开每个域内部的完整状态机；库存三级扣减、订单状态流转、支付退款闭环会在后续专题分别深挖。
- “购物车 Redis 为权威”“优惠券 Redis 先扣再同步 MQ”“订单编排多域事实”“通知把结果推到用户”都属于源码明确支持的判断。
- “展示态/准备态/执行态/结果态”是对源码结构的归纳，不是框架自带术语。
- 故障案例部分在本篇仍以交接阶段的已知修复经验作辅证，目标是说明数据流会跨域断裂；若要升级成运行态强结论，后续需要补 trace、日志、端口和 MQ 消费证据。
- `ai-app`、`ai-mcp`、`ai-tools` 继续排除在本卷主分析线之外。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- `my-xhs` 的核心数据流不是单线 CRUD，而是展示读流、准备态数据流、交易执行流、结果扩散流叠在一起。
- 购物车、优惠券、订单、支付、通知各自选择了不同的数据承载方式，不是偶然实现差异，而是业务约束使然。
- “支付成功”不是链路终点，用户最终感知到状态变化才是系统闭环的结果态出口。

但它还没进入另外两个更细的问题：

- 技术栈为什么会被选成现在这样，分别承担什么基础设施职责？
- 这些数据流一旦断裂，哪些故障最值得单独复盘？

所以下一篇应该进入 `04-technology-stack.md`，回答**为什么这套业务和数据流最后会落在 Nacos、RocketMQ、Redis、MySQL、ES、SkyWalking 这一组技术栈上**。
