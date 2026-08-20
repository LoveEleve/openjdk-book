# 02 Transaction Message：为什么这套事务消息不是“半消息 + 回查”八个字就能讲完

上一篇已经把 `my-xhs` 的异步事件系统拆成了“同步主链 + 后半段执行系统”。但如果继续往里走，最不能被一句话带过的，恰恰就是订单下单主链中最核心的那条事务消息：**下单为什么不是先写 MySQL 再发消息，而是先发半消息、再执行本地事务、最后靠 Broker 回查去补齐原子性边界。**

很多文章讲 RocketMQ 事务消息时，都很容易停留在抽象示意图：发送 half message，执行本地事务，返回 COMMIT 或 ROLLBACK，Broker 超时再回查。这个框架级描述当然没错，但对 `my-xhs` 这样真实长链系统来说，它还远远不够。因为一旦把它放进订单域的上下文里，立刻就会出现一连串必须讲清的问题：本地事务里到底包含哪些写入；回查为什么不查订单表而查本地消息表；幂等键和用户锁在事务消息之前还是之后生效；为什么 `context.getOrderId()==null` 会被当成事务回滚信号；为什么本地消息表状态和 RocketMQ 的事务回查是两套不同但耦合的状态机；以及最容易被误写的一点——在这套实现里，事务消息与“普通 Outbox 先落库再补发”到底差在哪里。

这就是本篇的任务。它不是再把框架文档翻译一遍，而是把 `my-xhs-order` 的真实下单实现拆成一个读者能顺着走的因果链：用户请求进来以后，先在哪里挡住重复提交，半消息何时发送，本地事务里写了什么，Broker 没拿到最终状态时怎么回查，库存消费者什么时候才真正能看到消息，以及这套设计为什么比“先写订单再发普通 MQ”更接近交易系统真正需要的原子性。

## 先给结论：`my-xhs` 的事务消息不是“消息可靠投递技巧”，而是订单主链的分布式原子性边界

先别急着看代码，先把本篇最重要的人话答案钉住：`my-xhs` 的 RocketMQ 事务消息，核心并不是“减少丢消息概率”的投递技巧，而是**订单主链跨出本地数据库边界时的原子性边界装置**。

换句话说，下单这里真正要解决的不是“消息发得快不快”，也不是“MQ 会不会重试”，而是另一句更贴近交易现实的话：**当订单主数据准备提交，而库存预扣和后续状态推进又必须异步承接时，系统如何避免出现“订单已经建成，但下游完全不知道”这种最危险的不一致。**

这条边界之所以重要，是因为订单主链不像搜索建议、通知聚合那样允许轻微延迟后再慢慢收敛。对于下单来说，订单主表、明细、本地消息、库存预扣、券核销、后续支付链都在相互牵制。如果“订单已落库，但 MQ 完全没出去”，那下游库存和优惠券就可能永远不接这笔单，最终把问题推给补偿、人工或对账去收。事务消息在这里承担的，就是把“本地事务”和“消息可见性”绑到一个更接近原子的位置上。

所以本篇后面反复会强调：**`my-xhs` 下单里的事务消息，不是“发消息的一种高级 API”，而是订单主链对跨服务原子性所做的工程化让步。**

## 直觉方案为什么不够：先写库后发普通 MQ、先发 MQ 后写库、只靠本地消息表都不够

### 失败方案一：先写 MySQL，再发普通 MQ

这是业务代码最容易长出来的形态：先把订单主表和明细写进 MySQL，本地事务提交成功以后，再普通 `syncSend()` 一条消息给下游，让库存消费者去预扣库存。

这个方案的直觉吸引力很大，因为它看起来最符合“先把自己的事做完，再通知别人”的顺序。问题在于，这恰恰会把最危险的不一致窗口暴露出来：**数据库提交成功，但 MQ 发送失败。** 一旦落到这种状态，订单已经成为数据库事实，但库存、优惠券、支付后续链路完全不知情。对交易系统来说，这不是“之后补一条消息”那么轻，而是主链已经裂成了两段。

`OrderTransactionListener` 的类注释正是针对这个问题写的。它直接拿“先写 DB 再发消息”做反例：订单创建了但库存没扣，最终可能超卖。这里不是泛泛而谈，而是点中了下单链路最核心的风险。`my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:31`

### 失败方案二：先发普通 MQ，再写 MySQL

既然“先写库再发消息”有窗口，那反过来不就行了吗？先把消息发出去，确认 MQ 成功，再去写订单表。这样好像能先保证消息不丢。

这个方案同样不成立。因为它把风险从“订单已写、消息没发”换成了“消息已发、订单没写”。如果下游库存消费者收到消息后开始预扣，而本地订单事务后来失败，系统就会出现另一种同样致命的不一致：库存已经动了，但订单根本不存在。这比前一种错误并没有更轻，只是换了方向。

也就是说，订单主链要的不是“消息先成功”或“数据库先成功”，而是**两者对外可见性的边界尽可能绑定。** 这正是事务消息要介入的位置。

### 失败方案三：只靠本地消息表 + 补发任务，不走 RocketMQ 事务消息

更有经验一点的设计会往前再走一步：既然普通 MQ 发送时序不靠谱，那就只用本地消息表。订单主数据和 `t_local_message` 在一个本地事务里提交，之后再由 `LocalMessageRetryJob` 扫表补发。这样即使 Broker 一时挂了，消息意图也至少落库了。

这套思路已经比前两种稳很多，也是上一篇异步事件里专门讲过的一层关键设计。但如果把它理解成“足够替代事务消息”，在 `my-xhs` 这里仍然不完整。原因很简单：**本地消息表能保证事件意图与主数据一起落库，但不能替你决定“下游消费者从何时起能看到这条消息”以及“Broker 在本次请求语义里如何感知本地事务是否成功”。**

`my-xhs-order` 当前的真实实现不是纯 Outbox，而是 RocketMQ 事务消息 + 本地消息表双层绑定：先发 half message 让 Broker 暂存消息，再在事务回调里把订单、明细、事件流、本地消息表一起提交。这样做的结果是，本地消息表不是“首次投递唯一通道”，而是事务消息回查与后续补发的锚点。这个差别非常关键，否则你会把这套系统误写成“只是多加了一张补发表”。

## 先画总图：订单事务消息在 `my-xhs` 里的真实时序长什么样

先把真实时序图立住，后面再拆每一步：

```text
用户 POST /api/order/create
  -> OrderService.createOrder()
      -> 幂等键 SETNX
      -> 用户级分布式锁 SETNX + Lua 解锁
      -> 构建 payload / addressSnapshot / OrderCreateContext
      -> sendMessageInTransaction(ORDER_TRANSACTION_TOPIC, msg, context)
           1. RocketMQ 暂存 half message（消费者不可见）
           2. 回调 OrderTransactionListener.executeLocalTransaction()
                -> OrderTransactionService.executeLocalTransaction()
                   - INSERT t_order
                   - appendEvent(CREATED)
                   - INSERT t_order_item
                   - INSERT t_local_message
           3. 成功 -> COMMIT，失败 -> ROLLBACK
           4. Broker 若久未收到状态 -> checkLocalTransaction()
      -> 事务消息成功后继续同步后置动作
           - 优惠券核销
           - 延时关单消息
           - 补记 CREATED 事件 / 快照 / 映射表
      -> 返回订单结果

消费者侧
  -> Inventory Consumer 看见 ORDER_TRANSACTION_TOPIC 消息
      -> 预扣库存 / 后续一致性动作
```

这张图里最关键的不是顺序长，而是每一步都在压一个不一致窗口。

- 幂等键防同一业务标识重复提交。
- 用户锁防同一用户短时间并发造多笔订单。
- half message 暂存保证“Broker 已知道这条消息，但下游暂时看不见”。
- 本地事务把订单核心真相和本地消息意图一起落下。
- COMMIT / ROLLBACK 决定下游是否有资格看到这条消息。
- 回查决定“Producer 没来得及返回状态时，Broker 到底该不该放行这条消息”。

这也解释了为什么这一篇必须单独写。单靠“RocketMQ 事务消息的定义”根本不足以让读者看明白 `my-xhs` 在压哪些窗口。

## 入口前置条件为什么也必须纳入事务消息篇：幂等键和用户锁不是外围小技巧，而是事务边界的前导闸门

很多人写事务消息时，会从 `sendMessageInTransaction()` 直接开始，仿佛前面的幂等键和分布式锁只是接口层的附属细节。但在 `my-xhs` 这里，这两道闸门其实和事务消息是同一条边界上的前导保护。

`OrderService.createOrder()` 一开始先做的不是算价，也不是发半消息，而是：

- `bizIdentifier` 做 24 小时 `SETNX` 幂等
- 同一用户再做 10 秒 `SETNX` 用户级创建锁
- 锁释放必须用 Lua 比较 UUID 后再删

`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:127`

为什么这要写进事务消息篇？因为事务消息真正要保护的是“订单核心事务 + 下游消息可见性”的原子边界，而幂等与并发闸门则决定了有多少请求能有资格进入这条边界。如果重复请求和并发多单在事务消息之前不被挡住，那么 half message、本地事务和回查都会被大量无效请求放大，系统成本和故障表象都会更糟。

也就是说，幂等键和用户锁不是事务消息之外的“接口限流小技巧”，而是在压缩进入事务边界的请求集合。

## `sendMessageInTransaction()` 在这里真正绑定了什么：Broker 的 half message 与本地事务结果

`OrderService.createOrder()` 里最关键的那一行当然是：

```java
SendResult sendResult = rocketMQTemplate.sendMessageInTransaction(
    ORDER_TRANSACTION_TOPIC, msg, context);
```

`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:225`

但真正重要的，不是 API 名字，而是它在 `my-xhs` 这套实现里绑住了哪两件事。

第一件事是 Broker 侧的 half message。消息已经被 Broker 接收，但在 Producer 给出明确事务结论之前，下游消费者看不到它。第二件事是 Producer 侧的本地事务结果：`OrderTransactionListener.executeLocalTransaction()` 要么成功写完订单主表、明细、事件流、本地消息表并返回 `COMMIT`，要么任一异常返回 `ROLLBACK`。`my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:56`

这意味着 half message 解决的不是“消息暂存一下”这么简单，而是在给本地事务争取一个“先决定自己是否成立、再决定是否对外可见”的窗口。对订单链来说，这个窗口极其关键。因为一旦它不存在，下游库存消费者就可能看到一条其实不该存在的订单消息，或者永远看不到一条其实已经建成的订单消息。

## `OrderTransactionService` 为什么必须独立成类：事务消息真正依赖的是本地事务能否被 AOP 正确代理

`OrderTransactionService` 的独立存在，很多人第一次看会觉得只是 Spring AOP 的常识问题：同类内部调用不走代理，所以把 `@Transactional` 抽出去。

但在事务消息这条链里，它的重要性比普通业务服务更高。因为这里的本地事务不是“事务能成更好，事务不成顶多代码脏一点”，而是整个 half message 何时 `COMMIT` / `ROLLBACK` 的判断依据。如果这个 `@Transactional` 根本没生效，那 `executeLocalTransaction()` 就可能在作者以为是单一原子块的地方部分成功、部分失败，最后把 RocketMQ 事务状态判断建立在一个并不可靠的本地事实之上。`my-xhs-order/src/main/java/com/myxhs/order/service/OrderTransactionService.java:21`

也就是说，独立类不是代码风格问题，而是事务消息链的前提条件之一：**本地事务真的得是事务，Broker 才有资格拿它的结果决定消息可见性。**

## 本地消息表在事务消息篇里的真正地位：它不是首次发送器，而是回查与补发锚点

这一点是整篇最容易被写错的地方，也值得单独强调。

`OrderTransactionService.executeLocalTransaction()` 里确实会把 `LocalMessage` 与订单主表、明细、事件流一起写进同一个本地事务；但这并不意味着当前订单主链是“先落库，再靠本地消息表首次投递 MQ”。真实时序仍然是：half message 已经先被 Broker 接收，随后事务回调里才把 `LocalMessage` 落库。`my-xhs-order/src/main/java/com/myxhs/order/service/OrderTransactionService.java:93`

所以这张表在事务消息篇里的真正定位，应该被说成：

- 本地事务成功的锚点之一
- `checkLocalTransaction()` 回查时的查询依据
- 后续补发、状态对账和本地死信扫描的锚点

而不是“普通 Outbox 那样先落库、再首次发送”的唯一发送器。上一轮对 `01-async-event.md` 的深审已经证明，如果把这两种模型讲混，读者就会误以为只要本地消息表落了，half message 之前的风险就也被覆盖了。实际上不是。`my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:86`

## `checkLocalTransaction()` 为什么查本地消息表，而不是查订单表

Broker 回查是事务消息最容易被抽象描述掩盖的一层。很多人会简单记住“Broker 没收到 Commit 就回查”，却不会继续问：回查到底查什么，为什么这么查。

`OrderTransactionListener.checkLocalTransaction()` 的实现给了一个非常工程化的答案：它不是去查订单表本身，而是优先查 `t_local_message`，如果 header 里带了 `userId` 就精确按分片键路由，否则再兜底按事务号查。`my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:102`

为什么查本地消息表而不是订单表？类注释已经把理由说得很直接：本地消息表和订单表是在同一个事务里写入，状态一致，而且本地消息表用 `transactionId=orderNo` 查询更直接。换句话说，作者把“本地消息表存在”本身视作本地事务已提交的可靠指示信号。`

这条设计非常值得写进正文，因为它说明本地消息表不是冗余副本，而是 RocketMQ 事务回查机制依赖的一部分。没有它，Broker 还得绕到更复杂的订单主表语义中去判断事务状态；有了它，回查逻辑可以更直接也更贴近“这条消息意图到底落没落地”。

## `context.getOrderId()==null` 为什么是一个很关键的同步信号

在 `OrderService.createOrder()` 里，发送事务消息后有一个看起来很朴素的判断：如果 `context.getOrderId() == null`，就认为本地事务执行失败，释放幂等键并抛异常。`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:236`

这个判断之所以重要，不在于它多复杂，而在于它说明 `sendMessageInTransaction()` 在当前实现里并不是 fire-and-forget。Producer 这边并不会仅仅因为 RocketMQ 返回了 `SEND_OK` 就自以为大功告成，而是还要确认本地事务回调有没有把 `orderId` 回写进上下文。换句话说，**Broker 接收到了 half message 还不够，Producer 还要看到本地事务确实产出了订单主事实。**

这一点很像把“消息投递成功”和“业务事务成功”强行拆成两个确认层。只有两层都成立，下单接口才会继续往后走。这种细节非常能体现交易链对“半成功”状态的敏感度。

## 事务消息成功以后，为什么下单主链仍然没完全结束

这是这篇最值得反复提醒的一件事：**事务消息成功，不等于整个 `createOrder` 流程已经彻底结束。**

从 `OrderService.createOrder()` 的真实代码看，在 `context.getOrderId()` 确认本地事务成功之后，系统仍会继续同步做几件事：

- 优惠券核销
- 发送 30 分钟后超时关单的延时消息
- 再补记一次 `CREATED` 事件
- 写订单快照
- 保存订单号映射表

`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:243`

这点特别重要，因为它直接告诉读者：RocketMQ 事务消息解决的是“订单核心本地事务与下游消息可见性”的原子边界，而不是“把下单接口之后所有事情都自动吞掉”。事务消息只是主链中最关键的一道原子性门，并没有把整个下单动作彻底简化成“一发消息万事大吉”。

这也是为什么上一轮对 `01-async-event.md` 的深审要专门把“订单核心本地事务闭环”和“同步后置动作”拆开。否则很容易在本篇里继续把事务消息的作用写大。

## 真实故障案例：坏消息不是从消费者开始坏的，它可能先作为“已提交本地事实”存在，再一路走到 DLQ

按照本卷方法论，这篇必须有真实故障案例。对于事务消息篇来说，最合适的并不是一个纯 RocketMQ 配置错误，而是 Task13 那条“从本地消息表改坏 payload，再一路进 DLQ”的真实链路。

这条案例特别适合放在事务消息篇，是因为它把 half message、本地事务、回查锚点和后续消费者失败串成了一条完整因果链。那条消息并不是“消费者凭空收到的坏消息”，而是先作为 `t_local_message` 里的已提交本地事实存在，再被 `LocalMessageRetryJob` 原样补发到 `ORDER_TRANSACTION_TOPIC`，最后才在下游库存消费者一侧重试失败并坠入 DLQ。`docs/test-3/HANDOFF-TASK13.md:56`

这个案例迫使我们承认一件非常关键的事实：**事务消息保证的是“本地事务事实”和“消息可见性”的边界，不保证“消息体语义本身永远正确”。** 一旦本地消息表里已经写进了坏 payload，事务消息、回查、补发和重投都只是在可靠地传播一条坏事实。系统能恢复的是“送达机会”，不是“语义正确性”。

用方法论要求的五段式收它：

- 现象：真实 `ORDER_CREATED` 消息被改坏后，补发进入 `ORDER_TRANSACTION_TOPIC`，消费者多次重试后进入 `%DLQ%inventory-order-transaction-consumer-group`
- 根因：消息体本身 malformed JSON，不是 MQ 丢消息，也不是消费者暂时不可达
- 修复：这次案例不是代码修复，而是通过真实链路证明“事务消息和补发链无法自动修复坏 payload”
- 验证：真实查询 DLQ、获取 `ORIGIN_MESSAGE_ID` / `RETRY_TOPIC`、执行重投，结果仍是 `CR_LATER`
- 余波：以后排障不能把“消息已可靠存在”误写成“消息语义就一定正确”

这正好把事务消息的边界钉死：它解决的是原子性，不解决业务语义正确性。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- `OrderService.createOrder()` 先构造带 `orderNo/userId/KEYS` 的事务消息，再调用 `rocketMQTemplate.sendMessageInTransaction()`，并在返回后显式检查 `context.getOrderId()`。`my-xhs-order/src/main/java/com/myxhs/order/service/OrderService.java:195`
- `OrderTransactionListener.executeLocalTransaction()` 明确在事务回调里执行订单主表、事件流、明细和本地消息表的本地事务，并返回 `COMMIT/ROLLBACK`。`my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:56`
- `OrderTransactionListener.checkLocalTransaction()` 通过 `t_local_message` 回查本地事务状态，有 `userId` 时走精确分片路由。`my-xhs-order/src/main/java/com/myxhs/order/listener/OrderTransactionListener.java:86`
- `LocalMessageMapper` 里存在 `selectByTransactionId` / `selectByTransactionIdAndUserId`，说明本地消息表不仅服务补发，也服务事务回查。`my-xhs-order/src/main/java/com/myxhs/order/mapper/LocalMessageMapper.java:47`

L1 框架 / 语义证据：

- RocketMQ 事务消息在这里承担的是“half message 可见性”和“本地事务提交结果”的绑定，不等于普通 MQ send + 后补 job。
- 本地消息表在这条链里是回查与补发锚点，不是纯粹的首次发送器。
- `context.getOrderId()` 成为下单主线程感知“本地事务是否真的成功”的同步信号，说明 Producer 侧并不只相信 Broker 的 `SEND_OK`。

L2 运行态证据：

- `docs/test-3/HANDOFF-TASK11.md` 已记录“事件链 CREATED 落库 + 全流转 seq 完整”与“补偿三动作 MQ 投递”这些真实验证，说明事务消息相关后半段链路不是纸面设计。`docs/test-3/HANDOFF-TASK11.md:83`
- `docs/test-3/HANDOFF-TASK13.md` 已真实证明：本地消息表中的一条已提交消息可以被重新补发到事务主题，并最终在消费者侧重试 / DLQ。`docs/test-3/HANDOFF-TASK13.md:56`
- `docs/test-2/service-analysis/09-order/03-transaction-message.md` 已对这套 half message → 本地事务 → 回查流程做过历史源码级拆解，与当前实现主线一致。`docs/test-2/service-analysis/09-order/03-transaction-message.md:6`

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 `my-xhs` 下单主链使用 RocketMQ 事务消息绑定 half message 与本地事务，但不能把它写成“订单创建之后所有动作都被事务消息原子保护”。优惠券核销、快照、映射、延时关单等后置步骤仍然在事务消息 `COMMIT` 之后分层执行。

第二，当前可以明确写出本地消息表为事务回查和后续补发提供锚点，但不能把它写成“Broker 任意不可用时都必然先把本地消息表落下”。半消息发送阶段完全失败时，本地事务回调根本不会被触发。

第三，当前可以明确写出事务消息显著缩小了“订单已写、下游不知”的窗口，但不能把它写成“彻底消灭所有不一致”。消费者逻辑错误、坏 payload、补偿失败、外部依赖长期不可达，仍会把问题推给异步执行层与人工边界。

第四，当前可以明确写出 `checkLocalTransaction()` 通过本地消息表判定提交状态，但不能把它写成“只要本地消息表存在，整个订单业务语义就一定正确”。它证明的是本地事务提交了，不证明 payload 内容、下游消费和后续状态推进必然正确。

## 收网：这篇 Transaction Message 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的事务消息不是 RocketMQ API 用法说明，而是订单主链跨出本地数据库边界时的一道原子性闸门：Broker 先暂存 half message，本地事务在回调里决定订单 / 明细 / 本地消息表是否一起提交，`COMMIT/ROLLBACK` 再决定消息何时对消费者可见，而 `checkLocalTransaction()` 则在 Producer 来不及返回状态时替系统补上“这条本地事务到底成没成”的判断。

从业务逻辑视角看，它守住的是“订单核心事务”和“库存后半段消息可见性”的边界；从工程视角看，它把 half message、事务回调、本地消息表、回查和补发任务织成了一套有锚点的可靠执行链；从分布式视角看，它不是在追求一次不差的神话，而是在极力压缩最危险的不一致窗口；从微服务视角看，它也让订单服务不再只是“写完库再通知别人”，而是先在系统边界上决定消息有没有资格被下游世界看见。

更重要的是，本篇把一个特别容易被讲错的事实钉住了：**事务消息保证的是“本地事务事实”和“消息可见性”的原子边界，不保证消息语义本身永远正确，也不替后续补偿、消费和状态推进兜底到底。**

下一篇如果继续沿 `10-async-task-transaction/` 推进，最自然的顺序就是进入 `docs/openjdk/vol-xhs/10-async-task-transaction/03-compensation.md`，把这篇里已经多次出现的补偿链、重试边界、人工介入条件再单独打透。