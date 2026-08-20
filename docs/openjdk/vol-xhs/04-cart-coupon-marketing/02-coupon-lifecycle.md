# 优惠券生命周期

> 对应目录：`vol-xhs/04-cart-coupon-marketing/`
> 目标问题：优惠券为什么不是“用户身上的一个折扣字段”，而是一条要跨模板、库存、用户券、订单、退款、补偿一起流动的生命周期？

## 一句话困惑

优惠券在很多系统里最容易被轻描淡写：下单时算一下折扣，取消时退一下券，好像不过是订单旁边的一段小逻辑。

但只要把 `my-xhs` 的代码真正串起来，就会发现优惠券完全不是一个“附加字段”，而是一条自己的业务生命线：

- 模板何时创建、上架、下架
- 用户何时可以领、能领几次、库存是否足够
- 下单前如何只算折扣不核销
- 订单创建时如何真正占用
- 取消订单或退款时如何回退
- Redis、MQ、MySQL 一旦不同步，谁算权威，谁来修复

这篇要讲清楚的，不是“优惠券接口有哪些”，而是：**一张券从模板到用户、再到订单、最后回到库存池的整个生命周期，到底怎样穿过 Redis、MySQL、MQ 和订单链。**

## 一句话答案

在 `my-xhs` 里，优惠券生命周期不是一次字段更新，而是**模板定义 → Redis 库存初始化 → 用户领取 → 用户券持久化 → 下单前试算 → 下单时核销 → 取消/退款时回退 → 对账/补偿收敛**的多阶段状态机；真正的难点不在折扣公式，而在每个阶段的真相分别落在哪一层、失败后如何收回来。

## 先建立最小心智模型

先把优惠券系统拆成三层对象：

```text
CouponTemplate
  = 平台定义的一种可发放优惠规则

UserCoupon
  = 某个用户已经领到手的那一张券

Order / Refund 关联状态
  = 这张券当前是否已被某笔订单核销、是否需要退回
```

再叠上基础设施层：

```text
Redis
  = 券库存、用户领取次数、模板缓存

MySQL
  = 模板表、用户券表、Outbox 表

RocketMQ
  = 领券持久化、退券失败补偿
```

也就是说，优惠券不是“数据库里一行记录”，而是同一张券在不同阶段分别投影到不同地方。

这里还值得和购物车做一个工程/分布式对照，因为这两者都在交易前置层大量使用 Redis，却选择了不同的收敛方式：

- `cart`：Redis 三结构直接作为权威待购集合，MySQL 异步持久化更多是长期留痕和恢复来源
- `coupon`：Redis 先收敛库存与限领并发，再通过 `syncSend + Consumer` 和对账把结果推进到 MySQL 账本

也就是说，二者虽然都把 Redis 放在前面，但在分布式语义上并不一样：购物车更偏“高频权威态”，优惠券更偏“高频实时裁决 + 持久账本收敛”。如果把它们统一理解成“都是缓存先写、数据库后补”，就会漏掉 coupon 这条链为什么必须对 MQ 发送结果、回滚时机和对账策略格外敏感。

## 先推演第一个最直觉的失败方案：领券时直接写 MySQL，再慢慢扣库存

很多人第一次写领券功能时，最自然的做法是：

1. 查模板剩余数量
2. 插一条用户券记录
3. 再把剩余数量减一

看起来就是普通的数据库事务逻辑。

### 为什么这个方案很诱人

因为它简单、直观，而且表面上也满足业务：

- 用户领到一张券
- 模板库存少一张

如果领券量不大，单靠数据库事务似乎也能撑住。

### 它在 `my-xhs` 上会先坏在哪里

它会先在高并发和限领先坏掉。

优惠券服务在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:37` 到 `:47` 里已经明确了它的 Redis 设计：

- 券库存 `stock`
- 用户领取次数 `claimed`
- 模板缓存 `template`

这说明系统很早就承认：领券不是单纯写表，而是“库存 + 限领次数”两个状态要一起原子变化。

如果你先插 `UserCoupon`，再去慢慢改库存，至少会出现两类问题：

1. 两个并发请求都看到库存还够，然后都插成功，最后超发。
2. 同一个用户的并发请求都通过校验，最后超过 `perUserLimit`。

### `my-xhs` 为什么不走这条路

`claimCoupon()` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:178` 到 `:190` 已经把选择讲清楚了：

- 先从缓存拿模板
- 再用 Lua 原子执行“检查库存 → 检查限领 → 扣库存 → 记录领取次数”
- 最后再把领券事件同步发 MQ 持久化到 MySQL

也就是说，系统把领券这件事拆成了：

```text
Redis 先收敛并发真相
MQ 再把结果推进到 MySQL
```

这就是第一条最重要的设计取舍：**先在 Redis 里用原子操作守住“能不能领”，再把“领到了什么”异步落库。**

这里必须把一个很容易混淆的点说透：模板表里的 `remain_count` 并不是实时权威库存。它当然记录了“数据库账本上的剩余量”，但 `CouponReconcileJob` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/job/CouponReconcileJob.java:20` 到 `:22` 已经明确写了“以 Redis 为准修复 MySQL”，`my-xhs-coupon/src/main/java/com/myxhs/coupon/job/CouponReconcileJob.java:105` 到 `:113` 也真正按这个策略执行。这说明当前实现里：

- Redis 的 `stock` 才是高并发实时扣减真相
- `remain_count` 是异步持久化后收敛出来的账本结果

如果把 `remain_count` 当成实时权威，就会误解整条生命周期：你会以为领券首先是在 MySQL 扣库存，实际上系统恰恰反过来设计。

## 再推演第二个失败方案：下单时直接把用户券标成已使用

领券守住了以后，第二个常见误区出现在核销阶段：订单创建时，似乎只要把 `UserCoupon.status=已使用` 就行。

### 为什么这个方案也很有诱惑力

因为从业务表象上看，核销好像只是“一次状态切换”：

- 下单时用了一张券
- 券状态从未使用变成已使用

如果只盯着 `user_coupon` 这张表，很容易觉得这就是一个普通 `UPDATE`。

### 它真正会先坏在哪里

它会先坏在“试算”和“真正占用”之间没有边界。

订单链对优惠券其实有两个不同动作：

1. 下单前先问：这张券现在能便宜多少？
2. 订单真正创建成功后再问：现在要不要正式占用这张券？

如果把这两步混成一步，下单页只要想展示可优惠金额，就不得不提前把券标成已使用。这样：

- 用户只是打开结算页或切换一次优惠券，券就可能被提前锁死
- 用户放弃下单后，系统还得猜测是否该恢复
- 多次试算会直接污染券状态
- 前端每一次刷新报价，都可能变成一次真实状态写操作

### `my-xhs` 为什么要分成“查询折扣”和“真正用券”两步

控制器层就已经把这两步拆开了：

- `/discount/{id}`：只查折扣，不核销，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:133` 到 `:145`
- `/use`：真正核销，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:147` 到 `:158`

服务层也对应分成两段：

- `getCouponDiscount()` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:268` 到 `:291` 中，只做归属校验、状态校验、责任链校验和折扣计算
- `useCoupon()` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:295` 到 `:343` 中，才真正做乐观锁核销

这说明系统对优惠券的理解是：

```text
试算 ≠ 占用
```

这条边界如果不立住，整个订单创建前后的语义都会混乱。

## 第一段生命周期：模板创建与模板上/下线

一张券的生命周期并不是从“用户领取”开始，而是从模板开始。

`CouponController` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:45` 到 `:95` 里定义了管理端的模板动作：

- 创建模板 `/template`
- 修改模板状态 `/template/{id}/status`
- 查模板详情 `/template/{id}`
- 查可领券模板列表 `/template/list`

### 模板创建时，已经同时初始化了两层状态

`CouponService.createTemplate()` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:78` 到 `:120` 中做了三件事：

1. 写入模板真相到 MySQL
2. 用 `SETNX` 初始化 Redis 库存
3. 把模板缓存到 Redis

也就是说，模板一创建出来，系统就已经同时建立了：

- 模板定义真相
- 券库存真相
- 模板缓存视图

### 上/下线为什么要清模板缓存

`updateTemplateStatus()` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:123` 到 `:146` 中修改状态后，会立即清缓存。这说明模板状态不是一个只存在于数据库里的静态字段，而是直接决定前台“可不可领”的热路径条件。

## 第二段生命周期：用户领取时，Redis 先判断“能不能领”

领券入口在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:99` 到 `:112`。

真正关键的是 `claimCoupon()`：

### 1. 先从缓存读模板，避免高并发直打 DB

见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:196` 到 `:209`。

### 2. 再用 Lua 原子收敛库存与限领

见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:211` 到 `:219`。

这一步不是简单扣一个数字，而是把：

- 剩余库存
- 当前用户已领次数
- 当前模板的 `perUserLimit`

在同一轮 Redis 脚本里一起收敛。

### 3. Redis 成功后，同步发送领券事件到 MQ

见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:225` 到 `:263` 和 `:540` 到 `:568`。

这里必须强调：**同步发送 MQ，并不等于 MySQL 和 Redis 在同一个本地事务里。** 它真正的语义是：Redis 已经扣减成功，但只有 MQ 发送成功，系统才认为“这次领券可以继续推进到持久化”；一旦 MQ 发送失败，就立刻回滚 Redis 库存，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:228` 到 `:230` 和 `:578` 到 `:586`。

### 4. MQ 消费端再把用户券正式写进 MySQL

这一步在 `CouponClaimConsumer` 里完成。`my-xhs-coupon/src/main/java/com/myxhs/coupon/consumer/CouponClaimConsumer.java:20` 到 `:29` 已经把职责讲明：消费 `COUPON_CLAIM_TOPIC`，把领券记录持久化到 MySQL，并通过 `msgId + uk_claim_no` 双重幂等防重复。

实际写入动作在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/consumer/CouponClaimConsumer.java:67` 到 `:89`：

- 写 `t_user_coupon`
- 再扣模板 `remain_count`

这里也要明确一下语义：这一步是在把 Redis 已经收敛过的结果持久化到数据库账本，而不是在数据库里重新做一次实时库存裁决。`remain_count` 在这里是“跟随 Redis 收敛”的持久结果，不是领券并发判断的第一现场。
所以领券的完整数据流其实是：

```text
模板缓存/库存缓存
  → Redis Lua 判断能不能领
    → MQ syncSend
      → Consumer 持久化 UserCoupon + 扣 MySQL remain_count
```

## 第三段生命周期：可用券查询和下单前试算

用户领到券以后，并不是立刻进入“已使用”状态。中间还有一个很重要的展示和试算阶段。

### 我的券列表与可用券列表不是同一回事

- `/user/list`：查用户所有券，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:114` 到 `:121`
- `/user/available`：只查当前下单可展示的可用券，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:123` 到 `:129`

`getAvailableCoupons()` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:434` 到 `:456` 中，除了要求 `status=0`，还会实时过滤：

- 已过期券
- 未来才生效的券

这一步说明“可展示可用券”其实已经是一层业务视图，而不是原始表状态直接输出。

### 折扣试算为什么要独立存在

`getCouponDiscount()` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:268` 到 `:291` 中完成了三件事：

1. 校验这张券属于当前用户
2. 校验这张券当前状态可用
3. 通过责任链做门槛、有效期、状态校验，再返回折扣金额

也就是说，这一步只回答：

```text
这张券现在值多少钱
```

它不回答：

```text
这张券已经被谁正式占用了
```

## 第四段生命周期：订单创建成功后，券才真正进入“已使用”

核销发生在订单域创建成功之后。

`OrderService` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:243` 到 `:275` 里已经把这段联动写得很清楚：

- 订单本地事务和事务消息先成功
- 如果请求里带 `couponId`
- 再调用 `couponFeignClient.useCoupon()` 做真正核销
- 一旦核销失败，就取消订单，保证“打了折扣的订单必有已核销的券”

这一步非常关键，因为它说明券的生命周期并不是“订单请求一进来就锁死”，而是：

1. 先试算
2. 再成功创建订单
3. 最后才正式占用

这也是为什么 `useCoupon()` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:334` 到 `:338` 最终要靠乐观锁 `WHERE status = 0` 把状态改成已使用。

## 第五段生命周期：取消订单或退款后，券要退回库存池

如果券只能领和用，不能退，它的生命周期仍然是不完整的。

### 取消订单时如何退券

订单域的 `cancelOrder()` 会并行触发退券，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:477` 到 `:484`；真正的优惠券回退逻辑在 `CouponService.returnCoupon()`，从 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:359` 开始。

它做了三步：

1. 用乐观锁把 `UserCoupon` 状态从已使用改回未使用，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:380` 到 `:385`
2. MySQL 原子增加模板 `remain_count`，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:388` 到 `:390`
3. 事务提交后，再回退 Redis 库存和领取次数，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:398` 到 `:414`

### 为什么 Redis 回退要放在 afterCommit

这里是这篇最值得注意的细节之一。

如果 Redis 先回退，而 MySQL 事务后面回滚，就会出现：

- Redis 看起来券已回来了
- MySQL 里却仍是已使用

因此系统明确把 Redis 回退移到了 `afterCommit`，让数据库先收敛，再回退缓存层状态。

### Redis 回退失败怎么办

这也是生命周期真正难的地方：MySQL 成功了，不代表整张券已经完全回到“可再次领取”的状态。

如果 Redis 回退失败，系统不会假装没事，而是发送 `COUPON_RETURN_REDIS_REPAIR_TOPIC` 补偿消息，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:409` 到 `:412` 以及 `:588` 到 `:600`。

对应的补偿消费者在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/consumer/CouponReturnRedisRepairConsumer.java:18` 到 `:38`，会重新执行 Redis 修复。

这说明券的回退不是“一次 update 就算完”，而是一条带补偿尾巴的链。

## 第六段生命周期：对账任务负责把长期漂移收回来

即使有回滚和补偿，系统仍然承认 Redis 和 MySQL 可能长期漂移，所以它还留了一道最终收网机制：对账。

`CouponReconcileJob` 在 `my-xhs-coupon/src/main/java/com/myxhs/coupon/job/CouponReconcileJob.java:18` 到 `:32` 明确写了自己存在的原因：

- 退券时 MySQL 已提交但 Redis 操作失败
- MQ 回滚失败
- Redis 重启后数据丢失

它的策略也非常明确：**以 Redis 为准修 MySQL**，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/job/CouponReconcileJob.java:20` 到 `:22` 以及 `:105` 到 `:113`。

这意味着在当前实现里，券库存的实时权威仍然站在 Redis 一侧，而 MySQL 更像持久账本和恢复来源。对账任务不是附加运维工具，而是生命周期最后一环。

## 这条生命周期真正隐含的三条分工

到这里可以把整条优惠券生命线压缩成三条核心分工：

### 1. 模板负责定义“这种券是什么”

模板决定：

- 券类型
- 门槛
- 折扣值
- 总量
- 有效期
- 是否上架

### 2. 用户券负责定义“这张券现在归谁、处在什么状态”

用户券决定：

- 谁领到了
- 现在是未使用、已使用，还是已过期
- 是否已被某笔订单绑定

### 3. Redis / MQ / MySQL 分别负责不同层次的真相

- Redis：并发下的实时库存和限领状态
- MQ：把状态推进到持久层，或在失败时承接补偿
- MySQL：模板、用户券、Outbox 和最终账本

也就是说，优惠券生命周期不是围绕“某张券字段怎么改”，而是围绕“这三层真相如何持续收敛”。

## 真实故障案例：为什么领券一旦把 Redis 扣减和持久化写散，系统就会出现“券看起来领到了，但实际上没领到”这种最难解释的状态

这条生命周期里最经典的风险，就是 Redis 扣成功了，但 MySQL 没跟上。

### 现象

用户点击领券，接口一开始看起来成功；但稍后去“我的优惠券”列表里查，却可能看不到那张券，或者模板剩余数、用户券记录、Redis 库存三者互相矛盾。

### 根因

根因就在于这条链是分层推进的：

- Redis Lua 先扣库存
- MQ 再负责把结果推进到 MySQL

只要第二步失败，而第一步没回滚或补偿没收敛，系统就会出现“实时库存已经变化，但持久态没跟上”的裂口。

### 修复

`my-xhs` 当前围绕这条风险布了四层保护：

1. `syncSend`，失败立即感知
2. 失败立刻回滚 Redis 库存
3. Outbox 兜底补发，见 `my-xhs-coupon/src/main/java/com/myxhs/coupon/job/CouponOutboxSenderJob.java:24` 到 `:27`
4. 最后再用 `CouponReconcileJob` 做长期收敛

### 验证

这类问题的验证不能只看领券接口 200，而要同时看：

- Redis 库存是否减少
- `t_user_coupon` 是否新增
- 模板 `remain_count` 是否同步变化
- Outbox 是否被标记 sent

### 余波

这个案例说明，**优惠券真正难的从来不是折扣公式，而是状态沿着多层介质流动时，如何保证用户最终看到的是一张完整存在的券，而不是半张券。**

## 这一篇先收束成一张总图

```text
模板创建
  MySQL 写 CouponTemplate
  → Redis 初始化库存 + 模板缓存

用户领取
  Redis Lua 扣库存/限领
  → MQ syncSend
  → Consumer 持久化 UserCoupon + 扣 MySQL remain_count

下单前
  只查折扣，不改状态

下单成功后
  useCoupon 乐观锁核销

取消/退款后
  MySQL 恢复 UserCoupon + remain_count
  → afterCommit 回退 Redis
  → 失败则发补偿消息

长期收敛
  Outbox 补发 + Reconcile 对账
```

这里最重要的不是接口数量，而是三条判断：

1. 领券、试算、核销、退券是四个不同阶段，不能混写成一次状态更新。
2. Redis、MQ、MySQL 在券生命周期里承担的是不同层次的真相，不可互相替代。
3. 一张券真正“存在”于系统中，不取决于某一层单独成功，而取决于整条链最终收敛。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 模板管理入口：`my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:45`
- 模板创建即初始化 Redis 库存：`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:78`
- 领券 Lua + syncSend：`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:178`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:540`
- 领券 MQ 持久化到 MySQL：`my-xhs-coupon/src/main/java/com/myxhs/coupon/consumer/CouponClaimConsumer.java:20`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/consumer/CouponClaimConsumer.java:67`
- 可用券用户视图过滤：`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:434`
- 下单前只试算折扣：`my-xhs-coupon/src/main/java/com/myxhs/coupon/controller/CouponController.java:133`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:268`
- 下单成功后真正核销：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:243`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:295`
- 取消/退款退券：`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:359`
- Redis 回退失败补偿：`my-xhs-coupon/src/main/java/com/myxhs/coupon/service/CouponService.java:588`、`my-xhs-coupon/src/main/java/com/myxhs/coupon/consumer/CouponReturnRedisRepairConsumer.java:18`
- Outbox 兜底补发：`my-xhs-coupon/src/main/java/com/myxhs/coupon/job/CouponOutboxSenderJob.java:24`
- 长期对账收敛：`my-xhs-coupon/src/main/java/com/myxhs/coupon/job/CouponReconcileJob.java:18`

## 边界清单

- 本篇讨论的是优惠券生命周期，不展开满减/折扣/无门槛三类券的具体折扣公式推导。
- “Redis 为实时权威、MySQL 为持久账本、MQ 为推进和补偿通道”是当前实现层的结论，不是所有优惠券系统的唯一设计方式。
- `getAvailableCoupons()` 里对未来生效券、孤儿券的过滤属于用户视图层语义，和模板/用户券底层真相不是同一层问题。
- 本篇只在订单域引用了“用券/退券”联动，不展开订单状态机细节。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么优惠券不是一个折扣字段，而是一条跨模板、用户券、订单、退款和补偿的生命周期。
- 为什么领券、试算、核销、退券必须拆成不同阶段，不能混成一次 update。
- 为什么 Redis、MQ、MySQL 三层要同时参与，才能把优惠券状态真正收敛。

但它还没进入营销栈里的最后一个问题：当购物车、优惠券都已经准备好之后，多个优惠和促销规则到底怎样叠加、怎样排优先级、怎样避免把最终支付金额算乱。

所以下一篇应该进入 `03-promotion-rules.md`，去回答**营销规则到底怎样进入下单前试算，为什么“能用券”不等于“应该这样算价”**。
