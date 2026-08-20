# 库存三级扣减

> 对应目录：`vol-xhs/05-inventory-order-payment/`
> 目标问题：库存为什么不能在下单时直接扣掉？`my-xhs` 为什么要把库存分成“预扣 → 确认 → 释放”三段，而不是一次 SQL update 结束？

## 一句话困惑

交易主链真正开始变重的第一步，不是订单表写入，而是库存扣减。

从业务直觉看，这件事似乎很简单：

- 用户下单
- 库存减掉对应数量
- 支付成功就完成，支付失败就回滚

如果系统是单机、单库、单事务，这个直觉勉强还能成立。但到了 `my-xhs` 这种微服务交易链里，库存马上变成最先脱离单机直觉的那块硬状态：

- 下单时用户还没支付，直接扣库存会不会把库存长期锁死？
- 支付成功和支付失败不在同一个本地事务里，库存到底什么时候才算真正卖出去？
- 订单取消、超时未支付、退款成功，库存应该加回到哪里？
- 如果 Redis、MQ、MySQL 任一段没跟上，系统怎样防止超卖或库存幽灵锁定？

这篇要讲清楚的，不是“库存服务有几个接口”，而是：**为什么 `my-xhs` 非得把库存扣减拆成三段状态机，以及这三段各自承担什么责任。**

## 一句话答案

`my-xhs` 的库存不是“一次扣减动作”，而是一条跨 Redis、MQ、MySQL 的状态推进链：下单时先在 Redis 预扣，支付成功后再确认，取消/超时/失败时再释放；也就是说，库存真正卖出去之前，系统先把它变成“暂时不能卖但还没最终消失”的中间状态，这就是三级扣减存在的根本原因。

## 先建立最小心智模型

先把库存状态压缩成三种语义，而不是三个接口名：

```text
预扣（PreDeduct）
  = 先把库存从“可卖”变成“暂时不可卖”

确认（Confirm）
  = 支付成功后，把这部分暂时不可卖库存正式视为已经卖掉

释放（Release）
  = 订单取消 / 超时未支付 / 失败时，把暂时不可卖库存放回可卖池
```

如果再对应到底层状态：

- Redis 层有总库存、分桶库存、预扣记录
- MySQL 层有 `available_stock`、`locked_stock`、`freezing_stock`

`Inventory` 实体在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/entity/Inventory.java:12` 到 `:16` 已经把这一点写清了：

- `available_stock`：还能卖的库存
- `locked_stock`：已预扣但未确认的库存
- 总库存 = `available_stock + locked_stock`

也就是说，三级扣减不是概念游戏，而是真实库存状态被拆成了“可卖”和“已锁但未最终成交”两层。

## 先推演第一个最直觉的失败方案：下单时直接扣 MySQL `available_stock`

这是大多数人第一次写库存逻辑时的直觉。

### 为什么这个方案很诱人

因为它简单得近乎完美：

- 下单时 `available_stock = available_stock - quantity`
- 支付成功不用再管库存
- 订单取消时如果需要，再加回去

对单体系统来说，这看起来就是一条最短路径。

### 它在 `my-xhs` 上先坏在哪里

它会立刻在“下单和支付不是同一个动作”这个现实上出问题。

下单成功不等于支付成功。假如你在用户点击“提交订单”的那一刻就直接扣减 MySQL 可用库存，那么只要：

- 用户之后一直不支付
- 支付回调迟迟不来
- 订单超时被系统取消

库存就会在一段时间里被过早地当成“已经卖掉”。这会带来两个问题：

1. **库存被过早消耗**：别的用户明明还能买，但系统已经把库存减掉了。
2. **库存恢复变复杂**：每一次订单取消、支付失败、超时关单都必须把真实已扣库存再回滚。

也就是说，这个方案最大的问题不是扣不下来，而是**扣得太早，早到还不知道这笔交易到底会不会成交。**

## 再推演第二个失败方案：下单时什么都不扣，等支付成功再一次性扣减

既然“直接扣太早”不行，另一种也很自然的想法是：那就什么都别扣，等支付成功以后再扣。

### 为什么这个方案也很有诱惑力

它看起来正好避开了前一个问题：

- 下单不动库存
- 支付成功了再真正减库存
- 不需要释放，也不需要中间态

这似乎让库存状态变得更干净。

### 它会先坏在哪里

它会在“支付前这段窗口”里失去库存保护。

如果下单到支付成功之间完全不做预占，那么多个用户可以同时创建订单，大家都以为自己买到了最后几件货。直到支付成功时再来一次真实扣减，系统才会发现：

- 有人已经抢先买走了
- 后支付的人其实已经无货可扣

这时问题就从“库存锁死”变成了“支付后缺货”：钱可能已经付了，库存却不够，后面只能退款、赔付或人工处理。对交易系统来说，这种结果通常比“先锁住库存再释放”更糟，因为它把失败从系统内部状态管理，推成了用户已经付款后的履约违约问题。

所以第二个失败方案的问题是：**它把库存保护做得太晚，晚到支付完成时才发现货其实不够。**

## 三级扣减到底在绕开什么代价

到这里就能看出，三级扣减不是为了复杂而复杂，而是在同时绕开两种相反的代价：

- 不能在下单时直接把库存当成已经卖掉
- 也不能一直等到支付成功才第一次动库存

于是系统选择了中间态：

```text
先预扣
  既不算真正卖掉
  也不继续暴露给别人卖
```

这就是三级扣减的顿悟时刻：**真正的库存状态不是“可卖 / 已卖”二元，而是至少要有一个“已占位、待决算”的中间层。**

## 第一级：预扣减先在 Redis 分桶里发生

预扣减是三级扣减里最重的一段，因为它既要快，又要抗并发，还要能留下后续确认/释放所需的上下文。

### 为什么预扣放在 Redis 而不是先打 MySQL

`InventoryService` 注释在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:37` 到 `:56` 已经把架构写明：

- L1：Redis 分桶预扣
- L2：MQ 异步扣 MySQL
- L3：定时对账修复

也就是说，预扣减首先发生在 Redis，而不是 MySQL。

原因很直接：预扣是交易链里最容易被高并发打爆的那一段。Redis Lua 能在单线程里原子完成：

- 快速检查总库存
- 按用户路由到某个桶
- 路由桶不足时再遍历其他桶
- 写入预扣记录

这套流程写在 `InventoryService.preDeduct()` 与 `doPreDeduct()`，对应代码见：

- 入口：`my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:197` 到 `:213`
- MySQL 幂等占位：`my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:218` 到 `:239`
- Lua 执行：`my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:287` 到 `:343`

### 预扣到底留下了什么状态

预扣不是只减一个数字，它还会留下：

- `inventory:{skuId}:total`
- `inventory:{skuId}:bucket:{n}`
- `inventory:prededuct:{orderId}`
- `inventory:prededuct:index`

其中最关键的是按订单维度写入的 `prededuct` 记录，因为后面的确认和释放都要靠它来找到“这笔订单当初占了哪些库存”。

### 预扣成功后为什么还要发 MQ

预扣成功并不代表库存状态已经完全收敛。Redis 只是先把并发窗口守住了，MySQL 的持久状态还没跟上。

所以 `preDeduct()` 在 Lua 成功后，还会同步发送库存事件到 MQ，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:325` 到 `:329` 和 `:563` 到 `:623`。真正把这条事件落到 MySQL 的，是 `InventoryDeductConsumer`：它在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/InventoryDeductConsumer.java:18` 到 `:31` 里明确把自己定义成“L2：MQ 异步扣 MySQL”，并在 `handlePreDeduct()` 的 `my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/InventoryDeductConsumer.java:99` 到 `:134` 中把 `available_stock → locked_stock` 推进到数据库。

这一步说明：**预扣减虽然先在 Redis 完成，但系统不会把 Redis 单独当成唯一完成态，而是要继续把结果推进到 MySQL。**

## 预扣链其实还藏着一层很重的工程防御：幂等占位、自愈回填和扩容暂停

如果只把库存链理解成“Redis 预扣 + MQ 落 MySQL”，会漏掉当前实现里非常关键的一层工程问题：**库存域并不假设 Redis 状态永远完整、桶数量永远稳定、消息永远只来一次。**

`InventoryService.preDeduct()` 的前半段就直接体现了这层防御：

- 先在 MySQL 写 `insertPredeductIdem(orderId, skuId)` 做幂等占位，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:218` 到 `:238`
- 如果 `bucketCountKey` 丢失，不是立刻报错，而是先尝试 `rebuildStockFromDb(skuId)` 自愈重建，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:249` 到 `:266`
- 如果检测到 SKU 正在扩容，还会抛 `ResizeInProgressException` 延迟消费，避免在桶重分布窗口里继续写旧桶，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:242` 到 `:246` 和 `:275` 到 `:285`

这三步揭示了库存链另外三类很容易被漏讲的问题：

1. **工程问题**：Redis 状态可能丢、桶结构可能变、消息可能重投，系统必须先防御这些脏状态再谈扣减。
2. **分布式问题**：同一 `orderId + skuId` 的重复消息不能再扣第二次，因此幂等不能只押在 Redis `predeductKey` 上，还要有 MySQL 兜底占位。
3. **微服务问题**：库存域并不是被动响应订单链，它还在主动维护自己的可用性与自愈逻辑；否则订单链一旦继续向前，库存真相就会掉队。

也就是说，库存域真正重的地方，不只是“状态机有三段”，而是**这三段状态机还要在 Redis 失真、桶扩容和消息重投这些工程现实里继续成立。**

## 第二级：确认扣减在支付成功之后推进

预扣之后，库存还处在“暂时不可卖”的状态，并没有被真正视为已成交。

支付成功后，订单域才会推动库存进入第二级“确认”。

### 订单侧何时触发确认

`OrderService.onPaymentSuccess()` 在 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:665` 到 `:723` 中，先把订单状态从待付款改成已付款，然后调用 `confirmInventoryDeduct()`，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:716`。

对应的确认调用则在 `confirmInventoryDeduct()` 里真正发出，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:732` 到 `:746`。

这说明系统明确规定：**确认库存扣减只能发生在支付成功之后。**

### 确认阶段到底做什么

`InventoryService.confirmDeduct()` 在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:346` 到 `:409` 中做了两件事：

1. 删除 Redis 里的预扣记录（库存在预扣时已经从可卖池里扣掉，因此此时 Redis 总库存不再二次变动）
2. 发送 `CONFIRM` 事件给 MySQL 侧，推进 `locked_stock` 正式扣减

对应的 L2 落库则在 `InventoryDeductConsumer.handleConfirm()`，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/InventoryDeductConsumer.java:136` 到 `:149`。也就是说，确认链并不是“发完 MQ 就算完”，而是确实有一条专门的消费路径把 `locked_stock` 继续往最终状态推进。

这里最值得注意的反直觉点是：**确认阶段不是再去 Redis 里减一次库存。** Redis 的“可卖总量”在预扣时就已经变了，确认时更多是在结束这段中间态，并把持久层状态追平。

## 第三级：释放库存负责把未成交交易从中间态拉回可卖态

如果支付成功会走确认，那取消订单、超时未支付、支付失败这些未成交场景，就必须走释放。

### 订单侧有哪些时机会触发释放

在当前实现里，释放库存至少出现在两类场景：

- 用户主动取消或超时关单，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:477` 到 `:484` 以及 `:775` 到 `:776`
- 预扣超时任务主动扫描回退，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/job/PreDeductTimeoutJob.java:17` 到 `:32`

这说明释放不是一条单一入口，而是订单域主动触发和库存域主动扫描两套机制共同兜底。

### 释放阶段到底做什么

`InventoryService.releaseStock()` 在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:413` 到 `:483` 中，把预扣库存回退到来源桶、回退总库存、删除预扣记录，然后再发 `RELEASE` 事件推进 MySQL 把 `locked_stock` 退回 `available_stock`。真正的 L2 落库发生在 `InventoryDeductConsumer.handleRelease()`，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/InventoryDeductConsumer.java:151` 到 `:164`。

也就是说，释放阶段的核心不是“取消订单”这四个字，而是：

```text
把一段尚未成交的中间态库存
安全地放回可卖池
```

### 为什么还需要超时扫描任务

即使订单域已经会主动取消和释放，系统仍然不敢完全依赖“上游一定会来调用我”。

`PreDeductTimeoutJob` 在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/job/PreDeductTimeoutJob.java:28` 到 `:32` 里已经把原因讲明：Redis Key 过期不保证精确时刻删除，如果没人来主动释放，库存可能被“幽灵锁定”。

同样地，查询库存时系统也不敢盲目把 MySQL 回填回 Redis。`InventoryService.getStock()` 在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:489` 到 `:550` 已经特别处理了这一点：Redis miss 时，宁可直接返回 MySQL 持久值，也不因为“看见数据库里还有 available_stock”就盲目重建 Redis 总库存，否则在途预扣会被覆盖，反而制造超卖。

所以库存域自己再跑一层超时扫描，把即将过期的预扣记录找出来，回退库存并补发 `RELEASE` 事件。这个机制说明：**释放不只是订单取消动作的副产品，它是库存域为了保证可卖池最终收敛而主动维护的一层修复能力。**

## 退款回补为什么不等同于释放

三级扣减之外，当前实现还额外出现了一个很容易和释放混淆的动作：退款回补。

### 为什么它不能和 release 共用一个语义

释放针对的是“订单未成交”——库存还在中间态里。

退款回补针对的是“订单已经成交，库存已经确认扣减”——这时再加回库存，语义上不是撤销预扣，而是**新的一次库存回补事件**。

### 当前实现怎样处理这件事

库存控制器把退款回补单独暴露成 `/refund-restore`，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:103` 到 `:114`。订单域在退款场景下也会走单独的 `refundRestore` 调用，见 `my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:798` 到 `:815`。

这说明系统很明确地把：

- 未成交释放
- 已成交退款回补

视为两条不同的库存语义，而不是一个通用“加回库存”动作。

## 为什么要把三级扣减写成 Redis + MQ + MySQL 三层，而不是只靠一层

到这里已经能看到，三级扣减真正的重量不在“接口数量”，而在三层状态分别承担不同职责。

### Redis 层：先把高并发窗口守住

- 保护可卖总量不被超卖
- 提供预扣中间态
- 支持快速释放和超时扫描

### MQ 层：把 Redis 状态推进到持久层

- 预扣成功后推进 MySQL `locked_stock`
- 确认后推进正式扣减
- 释放后推进可用库存回退

### MySQL 层：提供持久账本和对账基准

- 保存 `available_stock / locked_stock / freezing_stock`
- 提供 Redis 丢失时的恢复来源
- 提供长期一致性修复的对账对象

这三层缺一层都不行：

- 只有 Redis：快，但持久账本会丢
- 只有 MySQL：稳，但高并发和中间态成本太高
- 没有 MQ：Redis 和 MySQL 之间就缺少状态推进通道

## 真实故障案例：为什么“库存未初始化”或“缓存丢失”会让订单提交成功但库存没真正扣下去

三级扣减最真实、也最危险的故障，不是简单的“扣减失败”，而是订单链已经往前走了，库存却没真正收住。

### 现象

`InventoryService.doPreDeduct()` 在 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:249` 到 `:266` 特别处理了一个真实问题：如果 `bucketCountKey` 丢了，系统可能遇到“库存未初始化”或 Redis 分桶信息被删除的状态。

注释已经点明，这是因为 Canal 缓存失效会删除 Redis 库存 key，而如果没有自愈回填路径，下单事务消息可能已经 `COMMIT`，但库存不扣，最终走向超卖风险。这里“订单链继续往前跑”的关键前提在 `OrderTransactionListener` 里也能看到：`my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:20` 到 `:28` 把下单事务消息的 6 步流程写得很清楚，其中第 4 步本地事务成功后就会 `COMMIT`，第 5 步才由库存消费者去预扣库存。也就是说，订单创建和库存预扣在时序上本来就不是同一个本地事务。

### 根因

根因就在于三级扣减不是一个单点事务，而是一条推进链。只要这条链在 L1 入口就断掉，而上游订单链又继续往前跑，就会出现：

- 订单已经创建
- 优惠券可能已核销
- 但库存预扣没有真正建立

这类问题最危险，因为它不是“系统报错停住”，而是“系统继续前进，但库存真相已经掉队”。

### 修复

当前实现给出的修法，是在 `bucketCountKey` 缺失时先尝试 `rebuildStockFromDb()` 自愈重建，见 `my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:251` 到 `:265` 以及 `:644` 到 `:663`。

也就是说，库存域已经承认：在真实环境里，初始化和缓存完整性本身就是库存状态机的一部分，不能只靠理想流程假设永远正确。

### 验证

验证这类问题，不能只看订单接口返回成功，而要看：

- Redis 分桶是否存在
- 预扣记录是否建立
- MQ 是否成功发出库存事件
- MySQL `locked_stock` 是否最终跟上

### 余波

这个案例说明，**三级扣减真正难的地方，不是写出三个接口，而是让三层状态机在出故障时仍然能把库存真相收回来。**

## 这一篇先收束成一张总图

```text
初始化
  MySQL available_stock
    → Redis total + buckets

预扣（下单）
  Redis total/buckets 减少
  + 预扣记录建立
  + MQ 推进 MySQL locked_stock

确认（支付成功）
  删除 Redis 预扣记录
  + MQ 推进 MySQL 正式扣减 locked_stock

释放（取消/超时/失败）
  Redis total/buckets 回退
  + 删除预扣记录
  + MQ 推进 MySQL available_stock 回补

退款回补（已成交后）
  独立于 release 的新回补事件

长期收敛
  超时扫描 + 对账修复
```

这里最重要的不是记住三个接口名，而是三条判断：

1. 预扣、确认、释放本质上是在管理一段“暂时不可卖但还未最终成交”的库存中间态。
2. Redis 先守住并发窗口，MQ 再推进状态，MySQL 最终沉淀账本。
3. 三级扣减真正绕开的，是“扣得太早”和“扣得太晚”这两种相反风险。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 库存状态模型：`my-xhs-inventory/src/main/java/com/myxhs/inventory/entity/Inventory.java:12`
- 控制器入口：`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:67`、`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:79`、`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:91`
- 初始化分桶：`my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:137`
- 预扣减流程与 Lua 执行：`my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:197`、`my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:287`
- 订单事务消息提交后库存消费者才可见：`my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:20`
- L2 预扣落库：`my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/InventoryDeductConsumer.java:18`、`my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/InventoryDeductConsumer.java:99`
- 订单创建前的库存前置校验：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:171`
- 支付成功后的确认扣减：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:716`、`my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:346`、`my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/InventoryDeductConsumer.java:136`
- 取消/超时后的释放：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:499`、`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:775`、`my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:413`、`my-xhs-inventory/src/main/java/com/myxhs/inventory/consumer/InventoryDeductConsumer.java:151`
- 退款回补：`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:798`、`my-xhs-inventory/src/main/java/com/myxhs/inventory/controller/InventoryController.java:103`
- Redis miss 时谨慎回读 MySQL、不盲目回填：`my-xhs-inventory/src/main/java/com/myxhs/inventory/service/InventoryService.java:489`
- 超时扫描释放：`my-xhs-inventory/src/main/java/com/myxhs/inventory/job/PreDeductTimeoutJob.java:17`
- L3 对账修复：`my-xhs-inventory/src/main/java/com/myxhs/inventory/job/InventoryReconcileJob.java:16`

## 边界清单

- 本篇聚焦的是库存三级扣减的主状态机，不展开库存热点扩容、TCC 分支、Outbox 细节和库存消费者内部实现，这些属于库存专题的后续深挖空间。
- “三级扣减”在当前实现里主要指 `预扣 → 确认 → 释放` 这条主链；退款回补是成交后的独立后续动作，不应和 `release` 混成一个语义。
- 订单域在这里承担的是库存动作的触发者，不是库存真相拥有者。
- Redis、MQ、MySQL 三层的职责分工属于当前实现结论，不等于所有库存系统都必须这样设计。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么库存不能在下单时直接一次性扣掉，也不能等支付成功后才第一次扣。
- 为什么系统必须引入“预扣中间态”，并把库存拆成预扣、确认、释放三段推进。
- 为什么 Redis、MQ、MySQL 必须同时参与，才能让库存状态在高并发和跨服务交易里最终收敛。

但它还没回答下一个更具体的问题：库存状态机已经成立之后，订单创建本身到底怎样编排地址、SKU、优惠券、库存和本地事务，才能把整条交易主链真正拉起来？

所以下一篇应该进入 `02-order-create.md`，去回答**订单创建为什么不是一次 insert，而是一场把多域真相临时拉进同一条执行链的编排过程**。
