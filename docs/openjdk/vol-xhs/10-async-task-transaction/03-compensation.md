# 03 Compensation：为什么这套补偿不是“失败了再重试一下”这么轻

如果说上一章的事务消息讲的是“怎样把本地事务事实和消息可见性绑在一起”，那补偿这一章真正要面对的，就是事务消息已经做完它能做的那部分之后，系统仍然会剩下什么问题。很多团队讲补偿时，都很容易落到一个非常轻的口径：失败了就补偿、补偿就是再试一次、再不行人工介入。听上去没错，但在 `my-xhs` 这样一条交易链、通知链、索引链交织在一起的系统里，这种说法远远不够。

因为 `my-xhs` 的补偿根本不是统一的一把锤子，而是至少分成了三类完全不同的东西。第一类是**本地消息补偿**：消息还没可靠送到消费链，或者送了但本地状态还停在待处理 / 失败；这类补偿依赖 `t_local_message`、XXL-Job 扫描和指数退避。第二类是**消费后补偿**：消息已经进入异步链，但下游业务动作做了一半，库存没回、券没退、订单状态没推进，这时需要 `ORDER_COMPENSATION_TOPIC` 这种正式补偿消息流。第三类是**结果通知补偿**：支付和退款这类“结果事实”已经在支付域成立，但订单域还没跟上，于是系统再用 Feign 回查、MQ 结果通知和 XXL-Job 重扫去强行收口。换句话说，补偿在这里不是“多试一次”，而是一个层层接力的恢复系统。

如果不把这三层拆开讲，后面很多真实故障都会看起来像一个问题，实际上却完全不是一类。例如：本地消息状态停在 `status=2`，和库存消费者反复消费失败进 DLQ，不是同一层失败；支付成功后订单仍待支付，和索引补偿漏了跨库前缀，也不是同一层补偿；死信重投请求返回 `status=0` 但消费仍是 `CR_LATER`，更说明“补偿链活着”和“语义已经修复”是两回事。所以本篇真正要回答的，不是“系统有哪些补偿任务”，而是：**补偿到底在弥补哪一层断点，它何时还能自动恢复，何时必须承认边界并交给人工。**

## 先给结论：`my-xhs` 的补偿不是一段兜底代码，而是把“已经部分成立的业务事实”继续往前推进的恢复系统

先别急着看 Job 或 Consumer，先把本篇最重要的人话答案钉住：`my-xhs` 的补偿，不是“请求失败再试一次”的重试器，而是系统在**某些业务事实已经部分成立**之后，继续把链路往最终状态推进的恢复系统。

这句话为什么重要？因为补偿只会在一种很微妙的状态下出现：系统不是完全没做事，也不是所有事都做好了，而是已经留下了一部分真实后果。订单主表可能已经创建成功，但库存没有正确预扣；支付记录已经成功，但订单状态还卡在待支付；退款成功了，但库存回补和优惠券退还没有被订单域感知；补发消息已经发出，但消费者又在另一端失败。这些都不是“重新来一遍主流程”就能简单解决的状态，而是必须**带着已有后果继续往前收口**。

也就是说，补偿不是回到世界初始点再跑一次，而是在“世界已经变过一半”的前提下继续收束。`my-xhs` 之所以复杂，恰恰是因为它接受这种部分成功的现实，并为不同层次的部分成功设计了不同的恢复器：本地消息补发、本地死信重投、补偿 Topic、支付 / 退款通知补偿、库存补偿表扫描、索引增量补偿、全量重建。把这些都叫“补偿”没错，但它们修复的断点根本不是同一个位置。

## 直觉方案为什么不够：补偿不是简单重试、也不是失败重放的同义词

### 失败方案一：补偿 = 再执行一次原动作

这是最常见的误解。比如库存回退失败了，就再调一次释放库存；订单状态没推进，就再通知一次；退款回补失败了，就再发一遍消息。表面上看，这很像“补偿”，但如果不先区分当前状态是否已经部分推进，这种做法很容易制造第二次错误。

`my-xhs` 在很多地方已经明确地躲开了这种简单重放。最典型的就是 `OrderCompensationConsumer`：它消费 `ORDER_COMPENSATION_TOPIC` 后，不是无脑调用原来的 `closeTimeoutOrder()`，而是按 `action` 分发成 `RELEASE_STOCK`、`RETURN_COUPON`、`CLOSE_ORDER` 三种补偿动作。原因写得很明白：旧实现一律调 `closeTimeoutOrder`，会对 `status != 0` 的订单直接跳过，导致库存 / 券泄漏。`my-xhs-order/src/main/java/com/myxhs/order/consumer/OrderCompensationConsumer.java:113`

这就说明补偿的第一原则不是“重跑原流程”，而是“面向当前已知剩余缺口，执行剩下还没收口的动作”。

### 失败方案二：只要 MQ 有重试，补偿就不需要单独设计

第二个误解是把 RocketMQ 的自动重试等同于补偿。既然消费者失败会 reconsume，那再加一堆补偿任务是不是重复建设？

Task13 的坏消息案例已经把这个误解打穿。那条真实 `ORDER_CREATED` 消息进了消费链，重试 6 次后还是进 DLQ；再走 `dlq.redeliver`，HTTP 请求链路虽然成功，但消费结果依旧是 `CR_LATER`，因为消息体本身就是坏的。也就是说，MQ 重试只能解决“再试一次也许能成”的暂时性失败，不能解决“要换一种恢复手段”的问题。`docs/test-3/HANDOFF-TASK13.md:164`

补偿链之所以仍然必须单独设计，就是因为很多失败在语义上已经超出了 MQ 自动重试能处理的范围。比如订单服务已经取消了订单，但库存没回；支付域已经记录成功，但订单域还没变；这些都不是“重投同一条消息就一定能好”的问题。

### 失败方案三：补偿总能自动收敛，人工介入只是极小概率兜底

第三个误解更危险，因为它会让人低估补偿系统的边界。很多设计文档会把人工介入写成一种几乎不会触发的末尾句子，仿佛补偿链只要足够长，系统总能自己修回去。

`my-xhs` 的代码和文档恰恰说明作者并没有这么乐观。`LocalMessageRetryJob` 在本地消息补发耗尽后会把消息标成 `status=3`，并明确把死信累计数注册成 Prometheus Gauge，日志里直接写“需人工介入”。`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:147`

支付与退款补偿任务也都内置了最大重试次数，达到上限后会写出“需人工处理”的日志，而不是无限重试。`my-xhs-payment/src/main/java/com/myxhs/payment/job/PaymentNotifyCompensateJob.java:116` `my-xhs-payment/src/main/java/com/myxhs/payment/job/RefundNotifyCompensateJob.java:114`

这说明作者对补偿的预期很务实：补偿链是为了缩小人工介入面，而不是承诺人工永远不需要出现。只要消息体损坏、依赖长期不可达、状态已经自相矛盾或补偿路径本身也失败，最终仍然必须暴露给人。

## 先画总图：`my-xhs` 的补偿系统分哪几层

先把这张恢复图用文字立住：

```text
同步主链部分成功
  -> 留下本地事实 / 中间事实
     - 订单已建但消息未完成
     - 支付已成功但订单未推进
     - 退款已成功但库存/券未回补
     - 索引增量失败但主数据已更新

补偿层 1：本地消息补发
  t_local_message(status=0/2)
    -> LocalMessageRetryJob（30s 指数退避）
    -> 失败过多 -> status=3 本地死信
    -> DeadLetterScanJob 再次重投

补偿层 2：业务补偿消息
  ORDER_COMPENSATION_TOPIC
    -> OrderCompensationConsumer
       RELEASE_STOCK / RETURN_COUPON / CLOSE_ORDER

补偿层 3：结果通知补偿
  PaymentNotifyCompensateJob / RefundNotifyCompensateJob
    -> Feign 回查订单状态
    -> 必要时重新通知
    -> Redis 计数控制最大重试次数

补偿层 4：表扫描 / 投影补偿
  InventoryCompensationJob
  IncrementalIndexSyncJob
  IndexRebuildJob

最终边界
  -> DLQ / 本地死信 / 告警 / 人工介入
```

这张图里最重要的，不是补偿器数量，而是它们修复的对象不同。

- 本地消息补发修的是“消息还没可靠进入消费链”
- 补偿 Topic 修的是“消费链知道这事了，但后续业务动作没做完”
- 结果通知补偿修的是“结果域与订单域状态没对齐”
- 表扫描 / 投影补偿修的是“主数据与派生视图 / 外围状态没对齐”

把这几类断点混在一起，补偿系统就会显得像一堆杂乱的任务；拆开之后，读者才看得懂为什么这些 Job 和 Consumer 同时存在。

## 本地消息补偿为什么是第一层：它补的是“还没把事件可靠送出”

`LocalMessageRetryJob` 的职责非常清晰：扫描 `t_local_message` 中 `status=0/2` 且到达重试时间的消息，重新 `syncSend` 到对应 Topic；失败则指数退避，直到重试耗尽标成本地死信 `status=3`。`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:24`

这一层最重要的设计，不是“有个 30 秒 cron”，而是它明确把补偿对象限定在**本地消息状态**上。也就是说，它不管消费者最后有没有成功执行业务动作，它先保证“这条事件起码被可靠地再次送到消息通道里”。这就是典型的第一层补偿：先把“送出去”这件事补齐。

这里还要特别强调一个边界。Task13 的运行态材料专门指出：当前 `LocalMessageRetryJob.doRetry()` 实际走的是 `selectList(wrapper)`，并没有用 `LocalMessageMapper.selectPendingMessages()` 那条带 `created_at < 60s` 保护的自定义 SQL；因此某些基于“只扫 60 秒前消息”的直觉不能直接写成运行态事实。`docs/test-3/HANDOFF-TASK13.md:136`

这正说明补偿系统的真实行为，不能只看接口名字或 Mapper 注释，必须看当前实际调用路径。

## `ORDER_COMPENSATION_TOPIC` 为什么不是普通重试，而是面向缺口的业务恢复消息

`OrderCompensationConsumer` 是补偿系统里最值得拆开的第二层。它消费的 `ORDER_COMPENSATION_TOPIC` 不是“原始消息的重试队列”，而是业务显式构造出来的恢复意图消息。消息体里有 `action`，消费者再按 `RELEASE_STOCK`、`RETURN_COUPON`、`CLOSE_ORDER` 分发。`my-xhs-order/src/main/java/com/myxhs/order/consumer/OrderCompensationConsumer.java:23`

这一层的设计非常关键，因为它把“补偿”从“重试原动作”升级成了“只修还没修好的那一部分”。比如库存已经没问题，只剩优惠券没退，那就不该再整单关一遍；退款链上订单状态已更新，但回补库存失败，就只应该补 `RELEASE_STOCK`。也就是说，补偿消息在这里已经是一种**面向差额状态**的业务事件，而不是原业务事件的复制品。

而且这条链还有自己的幂等与边界：

- 一级幂等：Redis `order:compensation:consumed:{msgId}`
- 二级幂等：业务方法内部依赖订单状态、乐观锁或幂等条件
- maxReconsumeTimes=3：失败过多后交给 DLQ / 运维

这正是成熟补偿流应该有的形状：有独立 Topic、有明确语义、有独立幂等和失败边界。

这里还要再补一个经常被漏掉的分布式边界：补偿消息要想真正可恢复，最好在消息体里就携带足够的路由上下文，而不是把关键信息全部寄托给后置查询。当前 `OrderCompensationConsumer` 在 `userId` 缺失时，会退回到 `OrderNoMappingRepository.selectByOrderId(orderId)` 反查分片路由信息，见 `my-xhs-order/src/main/java/com/myxhs/order/consumer/OrderCompensationConsumer.java:92` 到 `:108`。这当然比直接 ACK 掉好得多，但它也说明：一旦 mapping 缺失、补录滞后或查询异常，补偿链的成功率就会立刻依赖另一条旁路是否还活着。

换句话说，补偿 Topic 在当前实现里已经是正式恢复层，但它的恢复力仍然受“消息里带了多少上下文”影响。业务语义要表达“补哪一步”，工程上还要尽量带齐“靠什么路由到正确对象”。

## 支付 / 退款通知补偿为什么属于第三层：它补的是“结果事实已经成立，但对方域还没认账”

支付与退款补偿任务和本地消息补发、本地补偿 Topic 都不是同一层恢复器。它们修复的不是“消息没送出去”，而是“支付域这边的结果已经成立，但订单域那边还没把这个结果认成自己的状态”。

`PaymentNotifyCompensateJob` 的逻辑很能体现这一点。它不是简单地重发同一条 MQ，而是先扫支付成功记录，再通过 Feign 调订单服务查询支付金额，借此判断订单是不是仍停在“待支付”；如果是，再调用 `notifyPaySuccess` 去推进订单状态。也就是说，这个补偿任务先做了**状态回查**，再决定要不要补发通知。`my-xhs-payment/src/main/java/com/myxhs/payment/job/PaymentNotifyCompensateJob.java:128`

退款补偿也一样。`RefundNotifyCompensateJob` 会先扫退款成功记录，再通过 Feign 观察订单当前状态是否仍需要被推进。如果订单服务不可达或状态异常，则累加 Redis 计数等待下轮再补；达到阈值后才暴露人工边界。`my-xhs-payment/src/main/java/com/myxhs/payment/job/RefundNotifyCompensateJob.java:81`

这一层之所以重要，是因为它展示了补偿系统另一种典型形态：不是靠事件本身反复重试，而是靠“**先问现在还缺什么，再决定怎么补**”来收口。对于支付 / 退款这种结果型事实，这比单纯重放消息更稳。

## 库存补偿为什么又是另一层：它补的是“局部动作失败后的状态回退”

`InventoryCompensationJob` 再次说明，补偿不是一个统一模板。它处理的不是订单通知没出去，也不是支付结果没认账，而是库存回退这种非常局部的状态恢复。

它扫描 `t_inventory_compensation` 里未处理的记录，再用 `release.lua` 重试回退库存；为了避免再犯早期 bug，还会从 `prededuct` hash 里读出实际 bucket 号，补齐 `indexKey` 与 `orderId` 等 release 脚本需要的参数。`my-xhs-inventory/src/main/java/com/myxhs/inventory/job/InventoryCompensationJob.java:19`

这一层特别说明了一件事：很多补偿任务并不关心整条业务主链，只关心自己负责的一小块状态是否回到正确位置。对库存来说，“订单已取消但库存未释放”就是它的全部世界。这个视角很窄，但正是因为它窄，它才更适合做局部专用补偿器。

## 真实故障案例：真实 DLQ 重投成功发起，但 `CR_LATER` 说明补偿链和语义修复不是一回事

按照本卷方法论，本篇必须有真实故障案例。对补偿篇来说，Task13 那次真实坏消息重投几乎是最贴切的案例，因为它把“补偿动作发起成功”和“业务语义被修复”这两个经常被混成一件事的层次彻底拆开了。

在那次验证里：

- 本地消息里的 `ORDER_CREATED` payload 被故意改坏
- `localMessageRetryJob` 真实补发到了 `ORDER_TRANSACTION_TOPIC`
- 库存消费者重试 6 次后进入 `%DLQ%inventory-order-transaction-consumer-group`
- Dashboard 查询接口成功返回 `ORIGIN_MESSAGE_ID` / `RETRY_TOPIC`
- `batchResendDlqMessage.do` 也真实返回 `HTTP 200 + status=0`
- 但 `consumeResult` 依旧是 `CR_LATER`

`docs/test-3/HANDOFF-TASK13.md:207`

这次案例最值得保留的地方，不是“MQ 很复杂”，而是它让我们看清：**补偿链活着，并不等于语义已经恢复。** 查询成功、重投成功、接口返回成功，都只是说明“恢复动作已被正确发起”；如果消息体本身是坏的，消费者还是会再次失败，业务语义仍然是坏的。

用方法论的五段式收它：

- 现象：DLQ 查询与重投接口都成功，但消费结果仍是 `CR_LATER`
- 根因：坏的不是链路，而是消息 payload 自身 malformed JSON
- 修复：不是简单“再投一次”，而是必须回到消息体 / 生产源头去修正坏事实
- 验证：真实 Dashboard 查询和重投请求链路都已跑通
- 余波：以后所有补偿系统都必须区分“恢复动作是否发起成功”和“业务语义是否真正恢复”

这也正好解释了为什么本篇不能把补偿写成“失败了就重试一下”。真正的补偿设计，最终是围绕可恢复性边界展开的。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- `LocalMessageRetryJob` 实现了本地消息指数退避补发、本地死信标记与死信再次扫描。`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:24`
- `OrderCompensationConsumer` 明确消费 `ORDER_COMPENSATION_TOPIC`，并按 `RELEASE_STOCK / RETURN_COUPON / CLOSE_ORDER` 做动作分发。`my-xhs-order/src/main/java/com/myxhs/order/consumer/OrderCompensationConsumer.java:23`
- `PaymentNotifyCompensateJob` 与 `RefundNotifyCompensateJob` 都在用 Feign 状态回查 + Redis 通知计数 + 周期扫描做结果型补偿。`my-xhs-payment/src/main/java/com/myxhs/payment/job/PaymentNotifyCompensateJob.java:20` `my-xhs-payment/src/main/java/com/myxhs/payment/job/RefundNotifyCompensateJob.java:19`
- `InventoryCompensationJob` 明确扫描补偿表并用 `release.lua` 重试局部库存回退。`my-xhs-inventory/src/main/java/com/myxhs/inventory/job/InventoryCompensationJob.java:19`

L1 框架 / 语义证据：

- 补偿不是统一“重跑原动作”，而是按断点层级分别补“未送达、未推进、未认账、未回退、未投影”。
- MQ 重试、补偿 Topic、Feign 回查、XXL-Job 周期扫描、本地死信和 DLQ 共同构成多层恢复系统，彼此不是替代关系。
- “补偿请求成功”与“业务语义恢复成功”是两件不同的事，前者只是恢复动作层成功，后者才是业务闭环成功。

L2 运行态证据：

- `docs/test-3/HANDOFF-TASK11.md` 已把“补偿三动作 MQ 投递”列为修复确认项，说明补偿消息流在真实回归里已被验证。`docs/test-3/HANDOFF-TASK11.md:85`
- `docs/test-3/HANDOFF-TASK13.md` 已真实证明：坏消息能被补发进主 Topic、进入 DLQ、再通过 Dashboard 查询与重投；但重投后仍可能因语义错误继续失败。`docs/test-3/HANDOFF-TASK13.md:149`

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 `my-xhs` 的补偿系统是多层恢复链，而不是单一重试器；但不能把它写成“只要层数够多就一定会自动修复”。不同层级的补偿仍然会在坏 payload、依赖长期不可达、状态矛盾等场景下失效。

第二，当前可以明确写出订单、支付、退款、库存、索引都有各自的补偿器；但不能写成“所有模块都使用统一补偿模式”。有的靠 Topic，有的靠 Job，有的靠 Feign 回查，有的靠补偿表扫描，模式本身就是异构的。

第三，当前可以明确写出本地死信和 RocketMQ Consumer DLQ 都已在代码与运行态中出现；但不能把这两者混成一类。前者是本地消息补发层耗尽，后者是消息进入消费链后仍无法被处理。

第四，当前可以明确写出很多补偿任务最终会暴露“需人工处理”的边界；但不能把这理解成设计失败。更准确的说法是：系统已经把自动恢复能做的层层做完，剩下的才是明确暴露给人处理的失败面。

## 收网：这篇 Compensation 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的补偿不是“失败重试”这一件事，而是一套围绕断点层级组织的恢复系统：本地消息补发修送达，补偿 Topic 修业务缺口，支付 / 退款通知补偿修跨域认账，库存补偿修局部回退，索引补偿修查询视图漂移，而本地死信、DLQ 与人工介入则共同定义了自动恢复的最终边界。

从业务逻辑视角看，它守住的是“部分事实已经成立后的继续收口”；从工程视角看，它把 Topic、Job、Feign、Redis 计数、补偿表和 DLQ 织成了分层恢复链；从分布式视角看，它承认系统无法一次性把所有错误抹平，只能不断缩小剩余失败面；从微服务视角看，它让“服务拆分后的失败”不再只能回到同步主链硬扛，而是被拆成多个可恢复层次分别处理。

更重要的是，本篇把一个特别容易被讲轻的事实钉住了：**补偿真正修复的不是“请求失败”，而是“已经部分成立的业务事实还没完全走到该去的位置”。**

下一篇如果继续沿 `10-async-task-transaction/` 推进，最自然的顺序就是进入 `docs/openjdk/vol-xhs/10-async-task-transaction/04-scheduled-task.md`，把前面多次出现的 XXL-Job / 定时重试 / 对账 / 重建任务统一收束成调度机制篇。