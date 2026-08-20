# 下单编排

> 对应目录：`vol-xhs/05-inventory-order-payment/`
> 目标问题：为什么 `my-xhs` 的下单不是一次 `INSERT t_order`，而是一场把地址、SKU、库存、优惠券、事务消息和后续补偿一起拉进来的跨域编排？

## 一句话困惑

前一篇已经把库存三级扣减的状态机讲清楚了，但这只回答了“库存为什么不能直接扣”。交易主链真正更重的一步，是：**谁来把这些状态机串起来？**

从外部看，下单接口似乎很简单：

- 前端提交商品列表、地址、优惠券
- 后端返回一个订单号

但在 `my-xhs` 里，这个动作背后至少要同时满足几件事：

- 商品 `SKU` 和 `SPU` 状态必须仍然有效
- 库存此刻必须足够，且后续要能真正预扣
- 收货地址必须能在订单创建瞬间被拍成快照
- 优惠券要先试算，再在订单创建成功后真正核销
- 订单主表、明细表、本地消息表必须一起成功或一起失败
- 一旦后续某条链断掉，系统还得知道怎么补偿

这意味着：下单根本不是“写一张订单表”这么简单，而是**用订单域把多个别域真相临时拉进同一条执行链，再把结果推出去。**

## 一句话答案

`my-xhs` 的下单本质上是一场编排，不是一条插入语句：订单域先用幂等和分布式锁挡住重复，再同步拉齐商品、库存、地址、优惠券四类外部真相，然后通过 RocketMQ 事务消息把“订单创建”和“库存预扣”绑进同一条可靠推进链，最后再异步补上关单、快照、映射和后续补偿。订单之所以重，不是因为表多，而是因为它承担了跨域时序的总协调责任。

## 先建立最小心智模型

先不要急着看代码，把下单拆成两层：

```text
订单本地事实
  = 订单主表 + 订单明细 + 本地消息表 + 事件/快照

订单外部依赖事实
  = 地址 + SKU真值 + 库存可用性 + 优惠券折扣/核销
```

真正的困难不在第一层，而在第二层。

如果订单只依赖本地事实，它当然可以只是一次本地事务；可一旦它要在创建瞬间同时确认“外面的世界现在是什么状态”，订单域就天然变成了一个编排中心。

## 先推演第一个最直觉的失败方案：先写订单，再慢慢处理别的事

这是大多数系统第一眼会想到的方案。

### 为什么这个方案很诱人

因为它实现简单：

1. 先把订单写进去
2. 再慢慢查库存
3. 再慢慢扣券
4. 失败了再补偿

这样订单表很早就有记录，接口也更容易快速返回。

### 它会先坏在哪里

它会先坏在“订单已经存在，但外部真相没有对齐”。

举几个最典型的例子：

- 订单写进去了，后来才发现 `SKU` 已下架
- 订单写进去了，后来才发现库存其实不够
- 订单写进去了，后来优惠券核销失败
- 订单写进去了，但预扣库存的消息没发出去

这时系统会出现最危险的中间态：**订单已经存在，但订单成立所依赖的外部前提其实没有一起成立。**

这种状态一旦大量出现，后面你写再多补偿逻辑，都只是在给“已经不干净的订单”擦屁股。

所以 `my-xhs` 没有采用“先写订单，再慢慢补齐”的策略，而是尽量把外部关键真相前置校验，再用事务消息把最关键的本地提交和库存预扣绑在一起。

## 再推演第二个失败方案：所有外部调用都先做完，再在一个本地事务里一次性提交

为了避免前一个问题，另一个自然思路是：那就先把商品、库存、地址、优惠券全查完，甚至都先扣完，然后最后再一次性提交订单。

### 为什么这个方案也很诱人

因为它看起来像是在“先把前提都确认完，再落订单”，似乎更稳。

### 它真正会先坏在哪里

它会先坏在“本地事务之外的动作做早了，但最后本地事务未必成功”。

例如：

- 你先把库存预扣了
- 先把优惠券状态改了
- 最后本地订单事务因为某个字段、分片、唯一约束、网络抖动失败了

这时外部世界已经被你改过，但订单本身却没有成功创建。于是系统就会陷入另一种坏状态：**外部依赖已经推进，本地订单却不存在。**

这正是为什么 `my-xhs` 要把“本地订单事实”和“库存预扣消息的可见性”绑进事务消息，而不是靠“先做外部动作，再赌本地事务不会失败”。

## 第一步：幂等和分布式锁先决定“谁有资格进入下单编排”

`OrderController` 在 `my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:46` 到 `:55` 暴露 `/api/order/create`，真正的逻辑从 `OrderService.createOrder()` 开始，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:106`。

它最先做的并不是查商品，而是幂等与锁。

### 幂等键：防止同一笔前端请求被重复提交

`OrderService` 先用 `bizIdentifier` 生成幂等键，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:127` 到 `:133`。这说明系统优先保护的不是“性能”，而是“同一笔下单意图不能被重复创建成多张订单”。

### 用户级分布式锁：防止同一用户在短时间内并发下单

紧接着，系统又对同一用户加了一个短期锁，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:135` 到 `:143`。

也就是说，下单编排的第一层根本不是商品或库存，而是：

```text
先保证同一个用户的同一笔意图不会并发进入两次
```

这很重要，因为后面所有外部依赖校验、事务消息和补偿，都是建立在“这是一笔唯一订单尝试”的前提上。

## 第二步：订单域先把外部事实拉齐，再允许自己进入事务提交流程

幂等和锁之后，系统才开始进入真正的编排阶段。

### 1. 拉取商品真相

订单先批量拉 `SKU` 详情，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:147` 到 `:156`。

这一步不是为了展示，而是为了拿到：

- `skuId`
- `spuId`
- `price`
- `image`
- `spuStatus`

也就是说，订单域自己不存商品真相，但它在创建订单这一刻必须把商品真相拍一份可消费快照。

### 2. 校验 SPU / SKU 状态仍然允许交易

`OrderService` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:158` 到 `:169` 做了双状态校验：即使购物车列表阶段已经做过 `valid` 防御，下单层仍然再校验一次 `spuStatus`。

这说明订单域不相信“前面看起来没问题”就够了，它在真正创建前还要再把交易前提锁一次。

### 3. 校验库存此刻是否够用

接着才调库存服务做前置库存校验，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:171` 到 `:183`。

这一步不是正式预扣，而是先回答：

```text
这笔订单现在是否值得继续往下走
```

必须把这条边界说得非常硬：

- 这里查到的只是 `availableStock` 的当前快照
- 它只能过滤明显无货的请求
- 它并没有在这一步建立任何 `prededuct` 记录
- 真正把库存从“可卖”推进到“暂时不可卖”的动作，要等事务消息 `COMMIT` 之后由库存消费者去做

也就是说，**前置库存校验 ≠ 已经占住库存**。如果连库存都不够，就没必要让订单域继续推进到事务消息和本地事务层；但如果库存看起来够，也还只是拿到了继续编排的资格，不代表库存已经被你锁住。
### 4. 拍地址快照，而不是只记一个 addressId

`resolveAddressSnapshot()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:341` 到 `:363` 中，会通过 `user` 服务拿真实收货地址并序列化成 JSON 快照。

这说明订单域并没有把“地址真相永远留在 user 服务再回头查询”当成默认前提。对订单来说，地址一旦进入交易，就必须变成订单自己的历史快照，而不是继续依赖外部 mutable 数据。

### 5. 先试算券折扣，但不在这一步提前核销

金额计算里，订单会先算 `totalAmount`，再调 coupon 服务算折扣，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:186` 到 `:193`。

也就是说，订单先拿到了“如果使用这张券，大概应该优惠多少”，但还没有真正占用这张券。这和上一章的优惠券生命周期正好衔接上：试算和占用是两件事。

## 第三步：真正的关键不是本地事务，而是事务消息把“订单创建”和“库存预扣可见性”绑在一起

这是整篇最关键的一层。

### 为什么不用“先写 DB 再发普通消息”

`OrderTransactionListener` 在 `my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:20` 到 `:33` 已经把这个问题讲透：

- 先写 DB 再发消息：DB 成功但消息失败 → 订单创建了但库存没扣 → 超卖
- 事务消息：本地事务和消息发送绑定成原子操作，要么都成功，要么都失败

也就是说，这里的关键不是 RocketMQ 技术本身，而是：**订单域不允许自己先成立，然后再祈祷库存预扣消息也能顺利出去。**

### 事务消息在当前实现里到底怎么走

顺序在 `OrderTransactionListener` 里写得很明确：

1. `OrderService` 发送半消息
2. Broker 存半消息
3. Listener 执行本地事务
4. 本地事务成功才 `COMMIT`
5. 库存消费者才看得见消息并预扣库存

这里最重要的其实是第 4 步：**只有本地订单事实和本地消息表都成功写入，库存预扣这条链才会对外可见。**

这就是为什么订单创建不是一个单体 `insert`，而是“本地事务 + 消息可见性”的联合提交问题。

## 第四步：本地事务里真正写进去的，不只是一张订单表

`OrderTransactionService.executeLocalTransaction()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderTransactionService.java:41` 到 `:106` 中，才是真正执行本地事务的地方。

它同一事务里至少写了四类东西：

1. 订单主表，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderTransactionService.java:59` 到 `:72`
2. 订单事件，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderTransactionService.java:73` 到 `:75`
3. 订单明细，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderTransactionService.java:76` 到 `:91`
4. 本地消息表，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderTransactionService.java:93` 到 `:104`

这说明订单域在“创建订单”这件事里，真正提交的不是一行，而是一组彼此互相解释的数据：

- 主表给出订单存在性
- 明细给出买了什么
- 事件给出状态演进起点
- 本地消息表给出后续分布式链路的补发依据

所以 `INSERT t_order` 只是整件事里最显眼的一步，远不是全部。

## 第五步：订单创建成功后，还要继续补齐几条后续链

如果前面都成功了，下单还没有彻底结束。

### 1. 真正核销优惠券

订单在本地事务和事务消息成功之后，才会真正调用 `couponFeignClient.useCoupon()` 去占用那张券，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:243` 到 `:275`。

而且这里有一个很值得单独点破的风险窗口：此时订单本地事实已经提交，事务消息也已经 `COMMIT` 可见，库存预扣会由消费者继续推进，但当前线程又马上开始核销优惠券。于是系统会短暂进入一个中间窗口：

```text
订单已创建
+ 优惠券可能已核销
+ 库存预扣消息已可见但未必已消费完成
```

这正是为什么后面必须有库存对账、补偿消息和超时关单兜底——因为订单主链并不是在一个本地事务里把“订单、券、库存”同时落完的。

这里还有一个非常强的约束：如果核销失败，订单直接取消，保证“打了折扣的订单必有已核销的券”。这说明订单域在编排上已经明确：**价格收敛成功还不够，营销真相也必须最终对齐。**

### 2. 发延时关单消息

订单创建成功后，会发 30 分钟延时消息，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:278` 到 `:279` 以及 `sendCloseDelayMessage()`。这说明系统在创建订单时，已经提前埋下了“如果后面不支付，我要怎么收残局”的后手。

### 3. 记录快照和映射

订单创建后还会：

- 写快照，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:295` 到 `:296`
- 写订单号映射，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:298` 到 `:299`

这说明订单域不仅在创建交易，还在为后续查询、回放、分片路由和故障恢复铺路。

## 为什么下单编排的核心不是“查了多少服务”，而是“外部真相和本地事实在哪一刻绑定”

到这里很容易被表面的 Feign 调用数量带偏，以为下单复杂只是因为“调了 user / product / inventory / coupon 很多服务”。

其实真正的重量不在调用数量，而在绑定时刻：

- 商品真相在什么时候被冻结成订单明细？
- 地址真相在什么时候冻结成地址快照？
- 优惠券试算在什么时候升级成真正核销？
- 库存校验在什么时候升级成库存预扣？

这几条“从外部真相到订单事实”的绑定时刻，才是下单编排真正的骨架。

## 真实故障案例：为什么“订单已创建但库存未扣”是下单链里最危险的失败模式

前面已经在事务消息设计里看到了这个风险，但值得单独作为故障案例再收一遍。

### 现象

如果订单本地事务成功了，但库存预扣消息没成功出去，或者预扣消费者没真正执行，那么系统会进入最坏的一种中间态：

- 用户看到订单创建成功
- 订单表里确实有记录
- 但库存实际上没有被占住

这时系统表面上“一切都在跑”，实际上超卖风险已经埋进去了。

### 根因

根因并不是单个服务 bug，而是：**订单本地事实和库存外部事实没有在同一个可靠推进链里绑定。**

这正是为什么当前实现坚持要用 RocketMQ 事务消息，而不是先写订单再发普通消息。

### 修复

当前系统的修法就是：

1. 半消息先入 Broker
2. 本地事务成功才 `COMMIT`
3. 本地消息表作为回查和补发依据
4. 如果后续链路还断，再靠补偿和对账兜底

### 验证

验证这种问题，不能只看订单接口返回 200，而要同时看：

- `t_order / t_order_item / t_local_message` 是否同事务写入
- 事务消息是否 `COMMIT`
- 库存消费者是否真正收到并处理消息
- Redis 预扣记录和 MySQL `locked_stock` 是否最终跟上

### 余波

这个案例说明，**下单编排最危险的地方，不是某一个字段写错，而是系统已经把“订单成立”告诉了用户，但还没有把这件事同步告诉库存世界。**

## 这一篇先收束成一张总图

```text
下单请求
  → 幂等键 + 用户级分布式锁
  → 拉商品真相（SKU / SPU状态）
  → 拉库存可用性
  → 拉地址快照
  → 试算优惠券折扣
  → 发送事务半消息
  → 本地事务写入：订单 + 明细 + 事件 + 本地消息表
  → COMMIT 后库存消费者可见并预扣库存
  → 再真正核销优惠券
  → 发延时关单消息
  → 写快照 / 订单号映射
```

这里最重要的不是步骤多，而是三条判断：

1. 下单不是一次本地写入，而是一场把多域真相临时绑成同一条执行链的编排。
2. 真正危险的不是查得多，而是本地订单事实和外部库存事实没能一起推进。
3. 订单域之所以重，不是因为它拥有最多真相，而是因为它承担了最多“真相绑定时刻”的协调责任。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 下单入口：`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:46`
- 幂等键与分布式锁：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:127`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:135`
- 商品真相、库存真相、地址快照和券折扣的前置拉取：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:147`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:171`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:201`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:341`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:186`
- 事务消息 6 步流程：`my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:20`
- 本地事务真实写入内容：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderTransactionService.java:41`
- 订单事件链：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderEventService.java:34`
- 订单创建后真正核销优惠券：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:243`
- 延时关单与快照/映射：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:278`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:295`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:298`

## 边界清单

- 本篇聚焦“订单创建如何编排”，不展开库存三级扣减内部实现、支付策略实现和退款链，这些属于前后篇章。
- 当前实现里，订单域承担的是绑定和推进责任，不等于订单域拥有商品、库存、地址、优惠券这些外部真相。
- 事务消息保证的是“订单本地事务”和“库存预扣消息可见性”原子绑定，不等于整条交易链后续所有动作都在同一事务里。
- 优惠券真正核销发生在本地事务提交后，这是一种当前实现下的收敛策略；它带来的补偿边界已在正文中明确。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么下单不是一次 `INSERT`，而是一场把多域真相临时绑定进执行链的编排。
- 为什么事务消息在下单链里不是可选优化，而是避免“订单已创建但库存未扣”的关键机制。
- 为什么订单域真正重的地方，不在表结构，而在它承担了商品、库存、地址、优惠券这些外部真相的绑定时刻。

但它还没进入接下来的两个问题：

- 事务消息本身如何保证最终一致，它的回查、半消息、本地消息表到底怎样协同？
- 支付链一旦接入，订单状态、库存确认和退款回补又如何继续收敛？

所以下一篇应该进入 `03-transaction-message.md`，把事务消息和最终一致性的主轴单独讲透，再进入支付闭环。