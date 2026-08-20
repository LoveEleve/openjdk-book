# 支付流程

> 对应目录：`vol-xhs/05-inventory-order-payment/`
> 目标问题：订单创建成功之后，支付域到底怎样接住“钱”的状态，又怎样把支付结果反推回订单和库存，最终让“钱”和“货”的状态对齐？

## 一句话困惑

到上一章为止，交易主链已经完成了两件最重的事：

- 订单域把多域真相临时拉进了一条执行链
- 事务消息把“订单创建”和“库存预扣可见性”绑在了一起

但用户真正感知最强的，不是订单表里多了一行，也不是库存变成了预扣，而是：**我到底付没付成功，这笔钱和这件货现在是什么关系。**

支付链一进来，系统面对的问题就从“订单能否成立”切换成了更危险的一组状态对齐问题：

- 订单还是待付款时，支付域能不能独立创建支付单？
- 支付成功之后，订单状态什么时候变成已付款？
- 库存预扣什么时候才从“暂时不可卖”变成“真正卖掉”？
- 退款成功之后，库存和优惠券又怎样回补？

如果这里处理不好，系统最糟糕的状态不是报错，而是：

- 钱已经扣了，但订单还是待付款
- 订单已付款，但库存还停在预扣中
- 退款已经成功，但订单和库存没回到正确状态

所以这篇真正要讲的，不是第三方支付 SDK 细节，而是：**支付域如何持有“钱”的状态，并通过回调和补偿把这份状态重新推回订单域和库存域。**

## 一句话答案

`my-xhs` 的支付链本质上是在维护“钱”和“货”两套状态机的对齐：支付域先独立创建支付单并持有资金侧状态，支付结果落定后再通过 Feign、MQ 和补偿任务把订单状态、库存确认/回补、退款状态继续收敛。支付之所以单独成域，不是因为它只是一个外部网关，而是因为“钱的状态”必须有独立真相来源。

## 先建立最小心智模型

先把交易主链切成两条并行状态线：

```text
订单 / 库存侧
  待付款 → 已付款 → 已发货 / 已完成 / 已退款
  预扣库存 → 确认扣减 / 释放 / 回补

支付侧
  待支付 → 支付成功 / 支付失败
  退款中 → 退款成功 / 退款失败 / 退款关闭
```

这两条线最容易被误解成“一件事的不同名字”。其实不是。

- 订单状态回答的是：这笔交易对“货”意味着什么。
- 支付状态回答的是：这笔交易对“钱”意味着什么。

它们相关，但绝不能被压扁成同一张表里的几个字段。`my-xhs` 明确把这两套真相拆开，正是因为它们的失败模式完全不同。

## 先推演第一个最直觉的失败方案：订单一旦创建成功，就直接把它改成已付款

这是最天真的支付实现方式。

### 为什么这个方案很诱人

因为从前端体验看，用户点击“去支付”之后，系统很容易把“开始支付”误看成“支付成功”。

如果系统只做 demo，这么写甚至一时看不出问题：

- 创建订单
- 立刻把订单状态改成已付款
- 后面发货、确认收货都能往下走

### 它在真实系统里会先坏在哪里

它会先把“支付尝试”和“支付结果”混成一件事。

在 `my-xhs` 里，支付域明确把“创建支付单”和“处理支付回调”拆成两步：

- `PaymentController.pay()` 只负责发起支付，见 `my-xhs-payment/src/main/java/com/myxhs/payment/controller/PaymentController.java:45` 到 `:61`
- `PaymentController.payCallback()` 负责接支付结果回调，见 `my-xhs-payment/src/main/java/com/myxhs/payment/controller/PaymentController.java:63` 到 `:92`

也就是说，当前实现明确承认：

```text
用户发起支付 ≠ 支付已经成功
```

如果系统一创建支付就把订单改成已付款，那么：

- 支付失败会把订单状态弄脏
- 后面库存确认会被提前触发
- 用户未真正付钱，系统却可能开始推进履约链

所以这个方案在真实支付世界里根本站不住。

## 再推演第二个失败方案：支付域只管自己的状态，订单自己慢慢猜测结果

另一种看起来更“模块化”的错误思路是：既然支付和订单是两个域，那支付域把自己的 `t_payment` 状态更新好就够了，订单侧自己去轮询或被动感知。

### 为什么这也很有诱惑力

因为这样边界看起来很干净：

- 支付域只管钱
- 订单域只管货
- 双方尽量少耦合

这在抽象图上很漂亮。

### 它真正会先坏在哪里

它会先坏在“状态对齐的时刻失控”。

如果支付域不主动把结果推回订单域，那么订单侧就只能依赖：

- 定时轮询支付状态
- 用户刷新页面触发查询
- 某个异步消息消费者去慢慢猜

这会让“钱已成功、货未确认”或“钱已退款、货未回补”的窗口被拉得很长。对支付这种高敏感链路来说，这种滞后不是小问题，而是业务核心状态没及时对齐。

`my-xhs` 当前实现恰恰没有走这条路，而是明确让支付域在状态落定后主动通知订单域：

- 支付成功通知：`my-xhs-payment/src/main/java/com/myxhs/payment/feign/OrderFeignClient.java:29` 到 `:42`
- 支付失败通知：`my-xhs-payment/src/main/java/com/myxhs/payment/feign/OrderFeignClient.java:44` 到 `:50`
- 退款成功通知：`my-xhs-payment/src/main/java/com/myxhs/payment/feign/OrderFeignClient.java:53` 到 `:66`

这说明当前系统在边界上做了一个很明确的选择：**钱的真相在支付域，但钱的结果必须主动推回订单域。**

## 第一步：支付单为什么要独立创建，而不是直接挂在订单上

`PaymentService.pay()` 从 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:132` 开始处理支付创建，整个流程可以拆成几步：

1. 分布式锁 + Redis 状态键防重复支付，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:159` 到 `:176`
2. 支付前回查订单状态，确认订单仍待付款，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:178` 到 `:189`
3. 插入支付记录 `t_payment`，状态置为待支付，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:197` 到 `:218`
4. 调用支付渠道策略发起支付，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:226` 到 `:233`

这说明支付单不是订单表上的一个附加字段，而是一份独立的资金侧状态记录。

为什么必须独立？因为支付域需要单独回答：

- 这笔支付是否已经发起
- 当前处于待支付、支付成功还是支付失败
- 这笔钱有没有进入退款流程

这些问题天然都属于支付域，而不是订单域顺手带一下就能讲清的。

## 第二步：支付成功时，真正的关键不是更新 `t_payment`，而是把结果推回订单域

`handlePayCallback()` 在 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:283` 到 `:314` 只是支付回调入口；真正的核心逻辑在 `handlePaySuccessInternal()`，从 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:317` 开始。

### 支付域先把自己的资金状态落定

它先做三件事：

1. 用乐观锁把支付单从待支付改成支付成功，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:323` 到 `:334`
2. 更新 Redis 支付状态缓存，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:336` 到 `:340`
3. 记录支付成功事件，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:344` 到 `:347`

这一步说明：**支付域先对“钱”负责，把自己这边的状态坐实。**

### 然后才把结果推回订单域

紧接着，支付域做了两条向外推进：

1. 发支付结果 MQ，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:349`
2. 同步 Feign 通知订单服务，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:352` 到 `:361`

这里最重要的不是“用了 MQ 还是 Feign”，而是系统明确不允许支付结果只停留在支付域里。它必须尽快进入订单域，推动订单状态从待付款变成已付款。

## 第三步：订单收到支付成功后，才真正把“货”的状态推进下去

订单侧接收支付成功的入口在 `OrderController.notifyPaySuccess()`，见 `my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:185` 到 `:204`。

真正的收敛逻辑在 `OrderService.onPaymentSuccess()`，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:665` 到 `:723`。

这一步的结构非常关键：

1. 先查订单是否仍处于待付款，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:690` 到 `:701`
2. 再追加支付事件并把订单状态改成已付款，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:704` 到 `:714`
3. 最后调用 `confirmInventoryDeduct()` 去确认库存扣减，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:716`

也就是说，在当前实现里，支付成功之后，订单域并不是简单写个“已付款”字段，而是在推动整条“货”的状态链继续往前走。

这正是支付域和订单域的关系：

- 支付域先确认“钱到了没有”
- 订单域收到这个结果后，再决定“货要不要正式卖出去”

## 为什么库存确认要放在订单域，而不是让支付域直接去调库存域

这是一个很关键的边界判断。

支付域明明已经知道支付成功，为什么不自己直接去确认库存？

因为库存确认从业务语义上不是“钱到账后支付域顺手做一件事”，而是“订单状态已经被订单域承认为已付款后，订单域再推进货的最终扣减”。

如果让支付域直接调库存域：

- 支付域就开始越权持有“货”的推进责任
- 订单和库存的绑定点会被支付域横向切开
- 一旦订单状态更新失败，却库存已经确认，系统又会裂成新的坏状态

当前实现明确没有走这条路：支付域只通知订单域，订单域自己决定何时确认库存扣减。这就是边界清晰的地方。

## 第四步：支付失败为什么不只是支付域自己的事

支付失败的处理逻辑在 `handlePayFailInternal()`，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:380` 到 `:405`。

它会：

- 把支付单状态改成失败
- 更新 Redis 状态缓存
- 发失败结果 MQ
- 同步通知订单服务 `notifyPayFail()`

订单侧接到 `notifyPayFail()` 后，又会自动取消订单并释放库存、退还优惠券，见 `my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:206` 到 `:228`。

这说明支付失败不是“钱没到，支付域自己标个失败就完了”，而是：

```text
钱没到
→ 订单不该继续存在为待付款
→ 预扣库存该释放
→ 已准备占用的券该退回
```

也就是说，支付失败会反向推动订单链回滚到更早的状态。

## 第五步：退款链为什么又是一套新的状态机

支付成功之后，事情还没结束。只要发生退款，系统就进入了另一条状态线。

### 支付域先独立维护退款状态

`refund()` 在 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:410` 到 `:534` 中：

1. 先做退款幂等控制
2. 校验支付单状态必须是支付成功
3. 校验退款金额不能超过可退金额
4. 创建退款单 `t_refund`
5. 调支付渠道策略发起退款

这说明退款不是支付状态上的一个小分支，而是一套独立记录、独立幂等、独立回调的状态机。

### 退款成功之后，为什么订单和库存还要再收一次尾

`handleRefundSuccessInternal()` 在 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:566` 到 `:627` 中，会：

1. 把退款单状态改成退款成功
2. 视累计退款情况更新支付单状态
3. 清理 Redis 退款状态键
4. 只有全额退款时，才通知订单服务 `notifyRefundSuccess()`

订单侧收到退款成功后，再去执行：

- 恢复库存
- 退还优惠券
- 更新订单状态为已退款

这个接口定义在 `my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:230` 到 `:254`。这里要特别强调责任归属：支付域只负责把“钱已退回”这个结果通知出去，真正触发库存回补和优惠券退回的是订单域自己的 `onRefundSuccess()` 收敛逻辑，而不是支付域直接去改库存或券状态。

也就是说，退款链不是“支付域里把钱退回去就完了”，而是**钱退回去之后，货和营销状态也要重新收敛。**

## 为什么支付链最难的不是接第三方，而是对齐“钱”和“货”的时刻

走到这里，已经能看出支付链真正的复杂度并不在 SDK 或接口签名上，而在几个非常危险的对齐时刻：

1. 创建支付单时，订单是否仍待付款
2. 支付成功时，订单是否仍允许进入已付款
3. 订单进入已付款后，库存是否被真正确认扣减
4. 退款成功后，库存和优惠券是否都被回补

也就是说，支付链最重的地方，不是“发起支付”这一步，而是：

**钱的状态每往前推进一次，货的状态也必须在正确的时刻、由正确的域、沿正确的路径跟上。**

## 支付域还要接受订单域的反向裁决

很多人讲支付回调时，会把它讲成一条单向链：支付域确认成功，然后把结果推给订单域。当前实现比这更重，因为它允许订单域对这笔钱是否还能被当前订单承认，做一次反向裁决。

最直接的证据在 `PaymentService.handlePaySuccessInternal()`：

- 支付域先把 `t_payment` 从待支付推进成支付成功，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:323` 到 `:345`；
- 然后同步 Feign 调 `orderFeignClient.notifyPaySuccess(orderId, tradeNo)`，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:352` 到 `:361`；
- 如果订单域返回的不是瞬时 503，而是明确的业务拒绝，支付域会把这理解成“这张订单现在已经不允许接住这笔钱”，于是主动发起退款，见 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:362` 到 `:377`。

这条逻辑说明：

```text
钱到账了
  → 还要再问订单域：
     这张订单现在有没有资格承认自己已付款
```

从分布式角度看，支付真相和订单真相不是“通知一次就结束”的单向关系，而是两套状态机在关键竞态点互相裁决。支付侧因此必须保留自动退款与补偿任务，否则就会留下“钱已成功、订单却不能推进”的高危半成功状态。

## 真实故障案例：为什么“钱已成功，但订单状态不允许更新”会逼支付域主动退款

这是当前实现里最能体现支付链复杂度的一个真实风险窗口。

### 现象

用户支付成功了，第三方回调也来了，但订单域那边可能已经因为竞态取消、超时关单或重复处理，不再允许订单从待付款推进到已付款。

这时系统会进入一种最危险的状态：

- 钱已经扣了
- 订单却不能合法地承认自己已付款

### 根因

根因不是支付域一个人能决定“订单现在就该已付款”。订单是否还能推进，要以订单域自己的状态机为准。

因此支付域即使拿到了成功回调，也还得去问订单域：这笔钱现在还能被这张订单接住吗？

### 修复

当前实现给出的修法非常有意思。`handlePaySuccessInternal()` 在 `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:352` 到 `:377` 中：

- 先 Feign 调 `notifyPaySuccess()`
- 如果订单域明确返回“状态不允许支付”而不是临时 503
- 支付域就主动发起退款

也就是说，系统宁可把钱退回去，也不允许“钱已到账但订单状态不合法”这种状态长期悬在那里。

### 验证

验证这种问题，不能只看支付单状态，而要同时看：

- 支付单是否标记成功
- 订单域是否真正接受 `pay-success`
- 如果订单域拒绝，退款是否被自动发起
- 后续库存和订单状态是否最终回到一致状态

### 余波

这个案例说明，**支付域并不是单方面发布结果，它还要接受订单域对这笔钱能否被这张订单承认的反向裁决。** 这正是“钱”和“货”状态机相互制衡的地方。

## 这一篇先收束成一张总图

```text
订单发起支付
  order → payment/pay
    ↓
payment 创建支付单
  幂等校验 + 订单状态回查 + t_payment 落库
    ↓
支付结果回调
  success / fail
    ↓
payment 落定资金侧状态
  t_payment / t_refund / Redis 状态键
    ↓
Feign + MQ 回推订单域
  notifyPaySuccess / notifyPayFail / notifyRefundSuccess
    ↓
order 收敛货侧状态
  已付款 / 已取消 / 已退款
    ↓
库存确认 / 释放 / 回补
```

这里最重要的不是接口顺序，而是三条判断：

1. 支付域持有“钱”的独立状态真相，订单域持有“货”的主状态真相。
2. 支付成功不等于订单天然已付款，订单域仍要在自己的状态机里接住这笔钱。
3. 退款成功不等于交易自动结束，库存和优惠券还要继续回补，系统才算真正收敛。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 支付入口与第三方回调入口：`my-xhs-payment/src/main/java/com/myxhs/payment/controller/PaymentController.java:45`、`my-xhs-payment/src/main/java/com/myxhs/payment/controller/PaymentController.java:63`
- 支付单创建与订单状态回查：`my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:132`、`my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:178`
- 支付成功内部处理：`my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:317`
- 订单侧支付成功回调入口：`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:185`
- 订单侧收敛已付款并确认库存：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:665`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:716`
- 支付失败回推订单取消：`my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:380`、`my-xhs-order/src/main/java/com/myxhs/order/controller/OrderController.java:206`
- 退款流程与退款成功收敛：`my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:410`、`my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:566`
- 支付域通知订单域的 Feign 契约：`my-xhs-payment/src/main/java/com/myxhs/payment/feign/OrderFeignClient.java:29`、`my-xhs-payment/src/main/java/com/myxhs/payment/feign/OrderFeignClient.java:53`、`my-xhs-payment/src/main/java/com/myxhs/payment/feign/OrderFeignClient.java:87`

## 边界清单

- 本篇聚焦“支付域怎样把钱的状态推回订单和库存”，不展开支付渠道策略内部实现、三方签名验签细节和支付页面交互。
- 当前实现里，支付域通过 Feign + MQ 双路径推进订单侧状态；本文重点解释状态机关系，不细拆每条补偿任务的全部实现。
- 退款链这里主要讨论全额退款后的状态收敛，部分退款对订单状态的保留语义只做点到为止，不展开更复杂的售后策略。
- 支付域虽然会在某些失败场景主动发起退款，但它仍不拥有订单状态真相；是否能承接支付结果，最终由订单域状态机裁决。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么支付域必须独立持有“钱”的状态，而不是挂在订单域上顺带处理。
- 为什么支付成功、支付失败、退款成功都必须继续反推订单域和库存域，而不是停留在支付域里自洽。
- 为什么支付链真正难的不是接第三方，而是让钱的状态和货的状态在正确时刻重新对齐。

但它还没进入交易主链的最后一个问题：一笔订单最终怎样结束、怎样履约、怎样退款完成，以及这条链在“用户收到货”之后怎样进入真正的终态。

所以下一篇应该进入 `05-fulfillment.md`，去回答**履约、确认收货、售后退款和最终完成状态到底怎样把整个交易主链收口**。
