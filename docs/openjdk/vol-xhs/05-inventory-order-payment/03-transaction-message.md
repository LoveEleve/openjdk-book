# 事务消息与最终一致性

> 对应目录：`vol-xhs/05-inventory-order-payment/`
> 目标问题：为什么下单链不能用“先写订单，再发普通 MQ 消息”解决？`my-xhs` 的事务消息、本地消息表、回查和补偿，到底怎样把订单事实和库存预扣绑进同一条最终一致性链？

## 一句话困惑

上一章已经讲清楚，下单不是一次插表，而是一场跨商品、库存、地址、优惠券的编排。但只要再往前追一层，问题会变得更尖锐：**订单域到底凭什么相信“我刚刚创建成功的订单，最终一定会被库存域看见并执行预扣”？**

这是整个交易主链里最危险的一跳。

如果这一跳处理不好，系统就会出现最糟糕的状态：

- 订单已经创建成功
- 用户已经拿到了订单号
- 但库存世界根本不知道这笔订单存在

所以这篇真正要讲的，不是 RocketMQ API 怎么调用，而是：**为什么事务消息在这里不是一个“可靠消息优化点”，而是订单链成立的核心绑定器。**

## 一句话答案

`my-xhs` 用 RocketMQ 事务消息把“订单本地事务成功”和“库存预扣消息对下游可见”绑进同一条推进链；本地消息表再负责回查与补发，补偿消费者负责兜住后续 Feign 失败，最终一致性不是靠一次神奇提交实现的，而是靠“半消息 → 本地事务 → COMMIT可见 → 消费推进 → 失败补发/补偿”这条多段链持续收敛。

## 先建立最小心智模型

先把交易主链里最容易混淆的三种消息分开：

```text
事务消息
  = 绑定“订单本地提交”和“库存预扣可见性”

本地消息表补发
  = MQ 没出去或没确认时，重新把事务消息推进出去

补偿消息
  = 订单已成立后，某个后续 Feign 链（释放库存 / 退券等）失败时，再异步重试收残局
```

这三者都和“消息”有关，但它们解决的是完全不同的问题：

- 事务消息解决“订单能不能安全成立”
- 本地消息表解决“这条事务消息最终会不会丢”
- 补偿消息解决“订单成立以后，某条后续联动失败了怎么办”

如果把这三件事混成一个“MQ 很可靠”就带过，后面所有最终一致性讨论都会失焦。

## 先推演第一个最直觉的失败方案：先写订单，再发普通消息

这是最常见、也最危险的错误方案。

### 为什么这个方案很诱人

因为它实现简单：

1. 本地事务写订单
2. 提交成功后发一条普通 MQ 消息
3. 库存消费者收到消息后去预扣库存

从流程上看，好像只比事务消息少了一层封装。

### 它会先坏在哪里

它会坏在“本地事务已经成功，但消息没发出去”这个窗口。

`OrderTransactionListener` 的类注释在 `my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:31` 到 `:33` 已经把这个失败模式说得非常直白：

- 先写 DB 再发消息：DB 成功但发消息失败 → 订单创建了但库存没扣 → 超卖

也就是说，这个方案的问题根本不是 MQ 丢消息本身，而是：**订单域已经把‘订单成立’作为事实写死了，但库存域完全没有收到这个事实。**

一旦出现这种情况，后面所有补偿都只能在一个已经脏掉的状态上做善后。

## 再推演第二个看起来更稳的失败方案：本地事务里顺便同步调用库存预扣

既然“先写库再发普通消息”不行，另一种自然想法是：那就别异步了，直接在下单事务里同步调库存服务，把预扣做完再提交。

### 为什么这个方案也很诱人

因为它看起来更强：

- 库存先扣成功
- 订单再提交
- 整条链像是一次“强一致交易”

从业务人的角度，这似乎比消息队列更可信。

### 它为什么同样站不住

它会先坏在“跨服务没有共享本地事务”这件事上。

订单域和库存域不是同库、同事务资源。即使你在订单服务里同步调用库存服务，也做不到真正的单事务提交：

- 库存服务可能先改了 Redis 或 MySQL
- 订单服务本地事务最后却回滚了

这时你只是把“先写订单再发消息”的坏状态，换成了“先扣库存再丢订单”的另一种坏状态。

所以真正的问题不是同步还是异步，而是：**跨服务世界里，本地提交和外部状态推进之间，必须有一个可靠绑定器。** 在 `my-xhs` 里，这个绑定器就是事务消息。

## 事务消息在 `my-xhs` 里到底绑定了什么

这件事必须讲得非常精确。

`OrderTransactionListener` 在 `my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:20` 到 `:28` 已经把 6 步流程写出来了：

1. `OrderService` 发送半消息
2. Broker 存储半消息并返回确认
3. 本地监听器执行本地事务
4. 本地事务成功则 `COMMIT`，失败则 `ROLLBACK`
5. 消费者消费消息，库存域预扣库存
6. 如果 Broker 没收到明确结果，则触发事务回查

所以事务消息真正绑定的是：

```text
订单本地事务成功
    ↕
库存预扣消息对下游可见
```

注意，它**不是**绑定“订单完全结束”和“库存已经最终扣完”。它绑定的是更早的一层：订单能否被合法地推进到库存世界。

这条边界很关键，因为很多人会把事务消息误解成“全链路一次提交”。当前实现并没有这么强，它只是保证最关键的第一跳不会失联。

## 本地事务里到底写了什么，为什么本地消息表必须和订单同事务出现

事务消息要成立，前提不是“发了一个半消息”，而是本地事务里有一份可回查、可补发的证据链。

`OrderTransactionService.executeLocalTransaction()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderTransactionService.java:41` 到 `:106` 中，同事务写了四类东西：

1. 订单主表
2. 订单创建事件
3. 订单明细
4. 本地消息表 `t_local_message`

其中最容易被低估的是第四项。

### 为什么不能只写订单主表和明细

如果本地事务里没有 `t_local_message`，事务回查时就只能去猜：

- 是订单插入成功了但 MQ 状态不清楚？
- 还是订单还没来得及插入就失败了？

这会让回查逻辑变得模糊，而且后续也没有一个专门的补发载体。

### 本地消息表为什么必须和订单同事务

`OrderTransactionListener.checkLocalTransaction()` 在 `my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:92` 到 `:100` 已经讲明：

- 回查查的是本地消息表，不是订单表
- 因为本地消息表和订单表在同一事务里写入，状态完全一致

也就是说，本地消息表不是“消息系统附属表”，而是**订单本地事务对外宣告自己已提交的证据锚点。**

## 事务消息真正怎样把库存世界拉进来

事务消息不是停在订单域自娱自乐，它必须最后进入库存域。

`OrderTransactionConsumer` 在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/OrderTransactionConsumer.java:19` 到 `:38` 已经把自己的职责写透了：

- 消费 `ORDER_TRANSACTION_TOPIC`
- 为订单中的每个 `SKU` 执行预扣减
- 消费者层有 `msgId` 去重
- `InventoryService` 层还有预扣幂等兜底

真正的消费逻辑从 `my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/OrderTransactionConsumer.java:59` 开始：

1. 解析 `orderNo / userId / skuItems`
2. 先做消费者层幂等
3. 从 `orderNo` 派生伪 `orderId`
4. 遍历每个 `skuItem`
5. 调 `inventoryService.preDeduct()` 执行预扣

这说明库存预扣不是订单事务的一部分，而是**在事务消息 `COMMIT` 之后，被库存域正式接管的第一跳。**

## 为什么还要有事务回查

即使有半消息和本地事务，系统仍然不能假设 Broker 一定总能及时收到 `COMMIT / ROLLBACK`。

所以 `checkLocalTransaction()` 存在的意义不是“多余保险”，而是：

- 当消息中间态不清时
- Broker 主动回来问：这笔本地事务到底成功没有

当前实现的回答方式也很明确：

- 查 `t_local_message`
- 查到记录 → 说明本地事务已提交 → `COMMIT`
- 查不到 → 说明事务未提交或已回滚 → `ROLLBACK`

这条逻辑写在 `my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:102` 到 `:133`。

这再次说明，本地消息表在这里不是为了凑表数，而是事务消息状态机本身的一部分。

## 事务消息之后，为什么还要有本地消息表补发任务

很多人第一次看到事务消息，会自然以为：既然有 `checkLocalTransaction()` 了，为什么还要搞一个 `LocalMessageRetryJob`？

答案是：事务消息保证的是“本地事务成功时，消息应该对下游可见”；它不自动等于“这条消息此后永远不会因为 Broker 故障、网络抖动、发送异常等原因需要额外补发”。

`LocalMessageRetryJob` 在 `my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:24` 到 `:37` 明确写了自己的价值：

- 即使 MQ Broker 整体宕机，只要 MySQL 里的本地消息表还在，消息就不会丢
- Broker 恢复后，定时任务可以扫描并补发

### 它到底怎么补

补发逻辑在 `my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:89` 到 `:176`：

1. 扫描 `status=0/2` 且到达 `nextRetryTime` 的消息
2. 重新解析目标 Topic
3. 再次 `syncSend`
4. 成功则标记成功
5. 失败则按指数退避更新 `retryCount / nextRetryTime`
6. 超过最大重试次数则标死信

也就是说，本地消息表补发不是“重新执行订单逻辑”，而是**继续推进那条已经在本地事务中被证明成立的外部消息链。**

但必须把边界说清：补发默认是 **at-least-once**，不是恰好一次。`LocalMessageRetryJob` 在 `my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:74` 到 `:76` 已经明确写了这一点：消费端必须保证幂等，因为事务消息可能已经 `Commit` 成功、消费者也可能已经消费过一次。也正因为如此，库存侧 `OrderTransactionConsumer` 才同时做了消费者层 `msgId` 去重和 `InventoryService.preDeduct()` 里的预扣幂等兜底，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/OrderTransactionConsumer.java:25` 到 `:33`。

这让系统具备了一个很关键的能力：**即使订单创建时 MQ 当场没彻底推进出去，只要 MySQL 还活着，库存最终仍有机会看见这笔订单。**

## 补偿消息解决的又是另一类失败

到这里还不能停，因为库存预扣只是订单创建后的第一跳。后面还有很多联动动作：

- 释放库存
- 退还优惠券
- 超时关单
- 退款回补

这些动作如果通过 Feign 调用失败，问题类型已经变了：不是“事务消息这条主链有没有推进出去”，而是“订单成立之后，某个后续联动没收干净”。

这也是本地消息补发和补偿消息必须分开的原因：

- **本地消息补发** 只补 `ORDER_TRANSACTION_TOPIC` 这条事务消息主轴，解决的是“订单已提交，但库存预扣消息没推进完”。
- **补偿消息** 补的是后续 Feign 联动残局，解决的是“订单已经成立，但释放库存/退券等后续动作失败了”。

这就是 `ORDER_COMPENSATION_TOPIC` 存在的原因。

`OrderCompensationConsumer` 在 `my-xhs-order/src/main/java/com/myxhs/order/consumer/OrderCompensationConsumer.java:21` 到 `:35` 已经讲清楚：它消费的是 Feign 失败后的补偿消息，负责重试关单、释放库存、退还优惠券等动作。

也就是说：

- 事务消息解决“订单创建时第一跳不能失联”
- 补偿消息解决“订单已成立后残局不能烂尾”

这两者看起来都像“最终一致性”，但其实解决的是不同阶段的问题。

## 为什么事务消息不是“最终一致性的全部”，而只是第一根主轴

到这里必须再把边界说硬一点：RocketMQ 事务消息很重要，但它不是整个交易链最终一致性的全部。

它至少不负责：

- 优惠券核销失败后的订单取消
- 库存释放失败后的补偿重试
- 退款回补失败后的后续修复
- 各类 L2 / L3 对账收敛

它只负责把“订单成立”这件事和“库存预扣消息可见”绑在一起。

换句话说，事务消息是最终一致性的第一根主轴，但后面还要叠：

- 本地消息补发
- 补偿消息
- 对账任务
- 幂等和回查

这就是为什么当前实现看起来消息很多：并不是过度设计，而是不同失败阶段必须有不同兜底。

## 真实故障案例：为什么“订单已经创建，但库存预扣没发生”会成为交易链里最危险的一类幽灵成功

前一篇已经从订单创建角度碰到过这个问题，这里要从事务消息角度把它彻底讲透。

### 现象

用户下单成功，系统返回了订单号；订单表、订单明细甚至本地快照里都能看到这笔订单。

但库存侧如果没有收到或没有成功处理预扣消息，真实库存其实没有被占住。这时系统最表面的现象可能只是“订单成功了”，真正危险的后果要等下一笔订单进来才暴露出来——超卖。

### 根因

根因不是库存服务一个点挂了，而是“订单成立”这个事实没有可靠地推进到库存世界。

这正是：

- 事务消息为什么存在
- 本地消息表为什么必须同事务落库
- 补发任务为什么必须存在

三件事共同要解决的问题。

### 修复

当前实现的修法不是寄希望于“网络别抖”或“Broker 永远别挂”，而是显式铺了三层链：

1. 事务消息半消息 + `COMMIT/ROLLBACK`
2. 本地消息表回查 + 定时补发
3. 库存消费者幂等 + 失败重试

### 验证

验证这类问题，不能只看订单接口或 MQ 发送返回值，而要同时看：

- `t_order / t_order_item / t_local_message` 是否同事务写入
- 事务消息状态是否 `COMMIT`
- 库存消费者是否真正消费到这条消息
- Redis 预扣记录和 MySQL `locked_stock` 是否最终建立

### 余波

这个案例说明，**事务消息最重要的价值不是“消息不会丢”，而是“用户已经看到的订单成功，最终必须被库存世界承认”。** 这才是交易链里最根本的一致性要求。

## 这一篇先收束成一张总图

```text
OrderService
  发送半消息 ORDER_TRANSACTION_TOPIC
    ↓
OrderTransactionListener
  执行本地事务：订单 + 明细 + 事件 + 本地消息表
    ↓
本地事务成功 → COMMIT
本地事务失败 → ROLLBACK
    ↓
Inventory OrderTransactionConsumer
  看到 COMMIT 后，开始预扣库存
    ↓
若中间状态不清
  Broker 调 checkLocalTransaction() 回查 t_local_message
    ↓
若消息没推进完
  LocalMessageRetryJob 继续补发
    ↓
若后续 Feign 联动失败
  ORDER_COMPENSATION_TOPIC 再补残局
```

这里最重要的不是记住 RocketMQ API，而是三条判断：

1. 事务消息真正绑定的是“订单本地事务成功”和“库存预扣消息对下游可见”。
2. 本地消息表不是附属记录，而是回查和补发的证据锚点。
3. 最终一致性在当前实现里不是单一机制，而是事务消息、本地补发、补偿消息和幂等/对账共同收敛出来的结果。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 事务消息 6 步流程：`my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:20`
- 本地事务真实写入内容：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderTransactionService.java:41`
- 事务回查查本地消息表：`my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:86`
- 库存侧事务消息消费者：`my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/OrderTransactionConsumer.java:19`
- 本地消息表补发（at-least-once）：`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:24`
- 指数退避与死信：`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:140`
- 事务消息消费端双重幂等：`my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/OrderTransactionConsumer.java:25`
- 补偿消息消费者：`my-xhs-order/src/main/java/com/myxhs/order/consumer/OrderCompensationConsumer.java:21`
- 事务消息 Topic 与补偿 Topic：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:86`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:590`

## 边界清单

- 本篇聚焦的是“订单创建 → 库存预扣”这一跳的最终一致性主轴，不展开支付成功后的库存确认、释放和退款回补，这些属于前后篇章的职责。
- 事务消息保证的是第一根主轴成立，不等于整条交易链后续动作都在同一原子提交里完成。
- 本地消息表补发和补偿消息是两类不同机制：前者补事务消息推进，后者补后续联动残局，不能混写。
- 当前实现依赖 RocketMQ 事务消息、本地消息表、消费者幂等、补偿和对账共同收敛；本文不把它神化成“单一机制一次解决全部问题”。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么交易主链不能用“先写订单，再发普通消息”解决，而必须引入事务消息。
- 为什么本地消息表在这里不是附加表，而是回查与补发机制的核心锚点。
- 为什么最终一致性在当前实现里不是一招搞定，而是事务消息、本地补发、补偿和幂等共同作用的结果。

但它还没进入下一步更贴近用户感知的问题：支付真正接入之后，订单状态、库存确认、退款回补和支付状态到底怎样闭环，系统又怎样把“钱”和“货”的状态对齐？

所以下一篇应该进入 `04-payment-flow.md`，去回答**支付链是怎样接住订单、又怎样把最终结果反推回订单和库存的**。
