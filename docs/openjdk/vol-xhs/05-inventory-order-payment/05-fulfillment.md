# 履约与退款收口

> 对应目录：`vol-xhs/05-inventory-order-payment/`
> 目标问题：支付成功之后，订单链到底怎样从“钱已到账”走到“货已发出、用户已确认、订单真正结束”，又怎样在退款时把整条链重新拉回一致状态？

## 一句话困惑

支付链看起来已经把交易最难的部分解决了：

- 订单成功创建
- 库存已预扣并确认
- 支付域也已经持有“钱到账”这个事实

但如果把这里当成交易主链的终点，系统就会立刻暴露出另一个盲点：**“已付款”并不等于“已履约”，更不等于“已完成”。**

用户真正感知到一笔交易结束，至少还要再穿过几道状态：

- 商家/系统什么时候把货发出去
- 用户什么时候确认收货
- 订单什么时候才算真正完成
- 如果中途发生退款，已付款这条线又怎样回到已退款，并把库存和优惠券一起收回来

也就是说，前面几篇解决的是“订单和支付怎么成立”，这一篇要解决的是：**交易成立之后，货态如何继续往前推进，最终怎样真正收口。**

## 一句话答案

在 `my-xhs` 里，履约不是支付成功后的附加字段，而是订单状态机的后半段：支付成功只把订单推进到“可履约”，发货把它推进到“在途”，确认收货才把它推进到“已完成”；如果中途退款，则订单要改成“已退款”，库存和优惠券也要跟着回补。换句话说，履约链负责把“钱已经对齐”进一步推进成“货也已经对齐”。

## 先建立最小心智模型

先把订单后半段状态机压缩成最小图：

```text
待付款(0)
  → 已付款(1)
    → 已发货(2)
      → 已完成(3)

待付款(0)
  → 已取消(4)

已付款(1)
  → 已退款(5)
```

这里的关键不是背状态码，而是理解它们分别在回答什么：

- `0 → 1`：钱的问题已经解决
- `1 → 2`：货开始进入履约
- `2 → 3`：用户确认货已到手
- `1 → 5`：钱退回去了，货态也要一起收回一致

`OrderEventService` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderEventService.java:26` 到 `:50` 已经把这些事件和目标状态映射明确列出来了：

- `ORDER_PAID` → `1`
- `ORDER_DELIVERED` → `2`
- `ORDER_COMPLETED` → `3`
- `ORDER_REFUNDED` → `5`

这说明在当前实现里，履约不是零散接口，而是一条明确的后半段状态机。

## 先推演第一个最直觉的失败方案：支付成功就把订单视为完成

这是很多系统文在讲交易链时最容易偷掉的一步。

### 为什么这个方案有诱惑力

因为从“收款成功”的视角看，系统似乎已经完成了最重要的一半：

- 钱到了
- 库存确认了
- 商家也拿到了有效订单

如果只站在支付域或账务视角，确实很容易把“已付款”误看成“这单差不多结束了”。

### 它真正会先坏在哪里

它会先坏在“货还没真正流到用户手里”。

只要系统一把订单直接从已付款推成已完成，就会立刻丢掉至少三类语义：

1. **发货语义**：商家什么时候发货，物流信息是什么。
2. **在途语义**：货已经出库但用户还没确认收货。
3. **售后窗口**：退款和异常履约时，订单还需要一个可回滚、可追溯的中间状态。

所以“支付成功 = 订单完成”在交易系统里是一种典型的过早收口：钱是对上了，货和用户体验还远远没收口。

## 再推演第二个失败方案：发货只是写个物流号，不必进入订单状态机

另一种看起来也很自然的思路是：订单状态到已付款就差不多了，发货只是补个物流信息字段，没必要单独成为状态迁移。

### 为什么这个方案也很诱人

因为很多后台系统一开始就是这么建模的：

- 订单主状态只有待付款 / 已付款 / 已完成
- 物流号只是附属字段

这样模型简单，接口也少。

### 它为什么站不住

履约的关键不在“有没有物流号”，而在“货的交付责任是否已经开始、是否已经结束”。

`OrderService.deliverOrder()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:631` 到 `:660` 中非常明确地把发货定义成状态流转：

- 只有已付款订单才能发货，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:646` 到 `:648`
- 发货后追加 `ORDER_DELIVERED` 事件，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:650` 到 `:654`
- 再写 `delivered_at`，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:655`

这说明在当前实现里，发货不是“补几个字段”，而是从 `1 → 2` 的正式状态推进。

但也必须把边界说清：当前实现里的“发货”仍然是订单域内部的轻量履约动作——它只负责记录物流公司、物流单号和状态推进，并没有接入独立物流平台、仓储系统或复杂的履约编排。也就是说，这一章讲的是订单状态机如何承认“货已上路”，不是在声称系统已经具备完整物流基础设施。

只要不把发货单列成状态机的一步，后面“确认收货”就会失去合法前提，因为系统根本分不清“已付款但未发货”和“已在路上待确认”这两种截然不同的货态。

## 第一步：支付成功只是把订单推进到“可履约”

订单在支付成功后，通过 `onPaymentSuccess()` 进入已付款状态，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:665` 到 `:723`。

这一步做了三件事：

1. 校验订单当前仍是待付款，防并发竞态，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:690` 到 `:701`
2. 追加 `ORDER_PAID` 事件并更新状态，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:704` 到 `:714`
3. 触发库存确认扣减，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:716`

这里最重要的认知点是：**已付款并不是“交易结束”，而只是“履约链可以合法启动”的起点。**

也就是说，支付成功只解决了“钱”的状态；从这一刻开始，系统才有资格推进“货”的交付状态。

## 第二步：发货把订单从“钱已到”推进到“货已上路”

发货入口在 `OrderController.deliverOrder()`，见 `my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:105` 到 `:114`。

`DeliverRequest` 只带三样东西，见 `my-xhs-order/src/main/java/com/myxhs/order/dto/request/DeliverRequest.java:12` 到 `:19`：

- `orderId`
- `logisticsCompany`
- `trackingNo`

这说明当前实现下，履约的“发货”语义很明确：系统并不试图在这里建复杂物流平台，而是把“进入已发货状态”视为一件明确的订单推进动作。

`OrderService.deliverOrder()` 做了四件关键事：

1. 只允许已付款订单发货，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:646` 到 `:648`
2. 追加 `ORDER_DELIVERED` 事件，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:650` 到 `:654`
3. 写 `delivered_at`
4. 记录快照并清缓存，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:657` 到 `:658`

因此发货在当前系统里的本质是：

```text
从“已付款但尚未履约”
推进到“货已离开卖家控制、进入在途状态”
```

## 第三步：确认收货才是订单真正完成的时刻

如果发货只是把货推上路，那么确认收货才是订单真正完成的时刻。

入口在 `OrderController.confirmReceive()`，见 `my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:95` 到 `:102`。

对应的业务逻辑在 `OrderService.confirmReceive()`，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:604` 到 `:626`。

它明确要求：

- 只有 `status=2`（已发货）的订单才能确认收货，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:615` 到 `:617`
- 然后追加 `ORDER_COMPLETED` 事件，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:619` 到 `:621`
- 再写 `completed_at`，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:622`

这说明在当前系统里，“已完成”并不等于“钱到账了”，而等于：

```text
钱已到 + 货已发 + 用户已确认收到
```

这也是履约状态机成立的根本意义：**它把“收款结束”和“交付结束”强行拆开了。**

但从工程和分布式角度看，履约状态机还不能只理解成订单表里的一个 `status` 字段。当前每次推进都会同时依赖三类动作：

- `OrderEventService.appendEvent()` 追加不可变的状态事件；
- `OrderMapper.updateStatusWithLock()` 用乐观锁推进当前订单状态；
- `takeSnapshot()` 保存当前阶段快照并清理相关缓存。

这三者解决的是不同问题：

- 当前状态方便接口快速判断；
- 事件流保留“为什么走到这里”的顺序事实；
- 快照和缓存清理让后续读取、回放和页面视图能够继续收敛。

因此履约链真正的状态推进不是“把 status 从 1 改成 2”，而是：**状态、事件、快照和缓存视图必须沿同一个业务阶段一起向前走。** 如果只改状态不记事件，后续就无法解释退款是在发货前还是发货后发生；如果只写事件不做乐观锁，支付、关单、发货并发时又可能出现状态覆盖。

## 第四步：退款不是从待付款回滚，而是从已付款链路中切出一条新的收敛路径

退款最容易被误看成“失败交易的回退”。但在当前实现里，退款是一条发生在已付款之后的新状态机。

### 退款成功的合法前提

`OrderService.onRefundSuccess()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:1087` 到 `:1125` 里，先做了非常明确的状态检查：

- 通过映射表反查 `userId` 做分片路由
- 只允许 `status=1`（已付款）的订单进入退款成功收敛，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:1105` 到 `:1108`

这说明退款不是“订单还没成立”的回滚，而是**已成立交易进入售后收口的分支**。

### 退款成功后到底要收什么尾

`onRefundSuccess()` 后续做了四件事：

1. 追加 `ORDER_REFUNDED` 事件，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:1110` 到 `:1112`
2. 释放库存并做退款回补，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:1114` 到 `:1116`
3. 退还优惠券，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:1118` 到 `:1119`
4. 记录快照并清缓存，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:1121` 到 `:1122`

这里也要明确一点：同时调用 `releaseInventory()` 和 `restoreStockOnRefund()` 是当前实现下的双路径收尾策略，不是所有退款链的通用常识。它的目标是同时兜住“预扣残留是否仍存在”和“已成交库存是否需要真实回补”这两种不同语义，而不是机械地把同一批库存加回两次。

也就是说，退款成功不是把钱退掉就算完，而是：

```text
钱退回去了
货态要回补
营销状态要回补
订单状态要收成“已退款”
```

这正是履约链和支付链在退款点重新汇合的地方。

## 为什么退款链里既有 releaseInventory，又有 restoreStockOnRefund

这一步非常容易让读者困惑：既然订单已经支付成功并确认扣减，为什么退款时还会同时出现 `releaseInventory()` 和 `restoreStockOnRefund()`？

答案恰恰说明“退款”不是“取消订单”的简单重放。

### `releaseInventory()` 解决什么

它针对的是预扣阶段残留的那部分记录。如果还有未清理的预扣记录，需要先把这段中间态收干净。

### `restoreStockOnRefund()` 又解决什么

它针对的是已经成交、已经确认扣减过的真实库存回补，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:791` 到 `:819`。

也就是说，退款链之所以复杂，是因为它既要处理：

- 中间态有没有收干净
- 最终态需不需要真正回补库存

这说明退款不是“沿着原路径往回走一遍”，而是一条专门的收口链。

## Event Sourcing 和快照在履约链里到底解决什么

到了履约阶段，为什么系统还要反复追加事件、写快照、清缓存？

因为履约的状态不像下单那样只有一个关键瞬间，它是一条较长的后半段生命周期：

- 已付款
- 已发货
- 已完成
- 已退款

如果没有事件链和快照，你只会在订单表上看到最终状态，却很难回答：

- 这单是什么时候发货的
- 是先退款还是先发货
- 是否发生过支付失败自动取消
- 状态为什么收敛到现在这个样子

`OrderEventService` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderEventService.java:34` 到 `:50` 里把事件到状态的映射列得非常清楚，这说明履约后半段不是“状态随手改掉”，而是被当成一条可回放、可审计的事件链来维护。

## 真实故障案例：为什么“钱已退回，但货态没收回来”比“退款失败”更危险

履约链里最危险的故障，不一定是报错本身，而是“钱”和“货”只回了一半。

### 现象

退款成功后，如果：

- 订单状态没收成 `已退款`
- 库存没有真正回补
- 优惠券没有退回

那么用户会看到“我钱好像退回来了”，但系统内部却还有一半状态留在旧世界里。

### 根因

根因在于退款不是单域动作，它天然横跨：

- 支付域：钱退回
- 订单域：状态改成已退款
- 库存域：可卖库存恢复
- 优惠券域：营销资源退回

只要其中一段掉队，系统就会进入一种特别糟糕的半收口状态。

### 修复

当前实现之所以把 `onRefundSuccess()` 写得这么重，就是为了在订单域里统一收这个尾：

- 先认退款成功
- 再同时推进库存、优惠券和订单状态收敛
- 某一步失败就留给后续补偿和对账兜底

### 验证

验证这类问题，不能只看支付域的退款单状态，而要同时看：

- 订单是否变成 `已退款`
- 库存是否回补
- 优惠券是否退回
- 快照和事件链是否完整记录了这次退款收口

### 余波

这个案例说明，**履约链最重要的价值，不是把状态多拆几段，而是确保“钱”和“货”在交易后半段仍然持续对齐，直到真正结束。**

## 这一篇先收束成一张总图

```text
已付款(1)
  → 发货(2)
    → 确认收货(3)

已付款(1)
  → 退款成功(5)
    → 库存回补
    → 优惠券退回

状态推进伴随：
  Event Sourcing 事件追加
  快照记录
  缓存清理
```

这里最重要的不是背状态码，而是三条判断：

1. 支付成功只是把订单推进到“可履约”，并不等于整个交易已经结束。
2. 发货和确认收货分别对应“货已上路”和“货已真正到手”，不能压成一个状态。
3. 退款真正困难的不是退钱，而是让订单、库存、优惠券三条后续链一起收口。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 发货入口与请求模型：`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:105`、`my-xhs-order/src/main/java/com/myxhs/order/dto/request/DeliverRequest.java:7`
- 确认收货入口：`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:95`
- 发货状态推进：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:631`
- 确认收货状态推进：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:604`
- 已付款状态作为履约起点：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:665`
- 退款成功收口：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:1087`
- 退款回补库存：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:791`
- 事件到状态映射：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderEventService.java:34`

## 边界清单

- 本篇讨论的是订单后半段的履约与退款收口，不展开物流系统接入、仓储履约编排和更复杂的售后策略。
- 当前实现里的“发货”仍然是订单域内的轻量履约动作，不等于已经接入完整物流平台。
- 退款链在本文主要讨论全额退款后的状态收敛；部分退款对订单状态是否保持已支付，在支付篇已点到，这里只保留边界提示，不继续展开更细的售后状态分支。
- Event Sourcing 和快照在本文只作为履约收口的支撑机制，不细拆事件表和快照表的持久化结构。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么支付成功只是履约链的起点，而不是交易终点。
- 为什么发货、确认收货、已完成必须拆成不同状态，而不能压成“已付款后差不多完成”。
- 为什么退款的真正难点不是退钱，而是让订单、库存、优惠券三条后续链一起收口。

到这里，`05-inventory-order-payment` 这一组的五篇核心主链已经形成闭环：

- 库存为什么必须拆成三级扣减
- 下单为什么是一场跨域编排
- 事务消息怎样保证订单与库存第一跳不失联
- 支付域怎样把钱的状态推回订单和库存
- 履约与退款怎样把交易后半段真正收口

下一步如果继续沿主交易链往横向补深，可以回到 `09-data-model-storage/` 和 `10-async-task-transaction/`，把这条主链背后的分库分表、MQ Topic、补偿任务和对账机制再做横切归纳。