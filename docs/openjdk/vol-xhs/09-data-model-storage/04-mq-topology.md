# 04 MQ Topology：为什么这套 RocketMQ 拓扑不是“有几个 Topic 和消费者”这么简单

到 `09-data-model-storage/` 这一组的第四篇，读者最容易带着的一个误解是：前面已经写了订单主链、事务消息、Canal 索引同步、通知与搜索，那么 RocketMQ 大概只是把这些链路串起来的传输总线，画一张 Topic → ConsumerGroup 的表就差不多了。

这恰恰是 `my-xhs` 里最容易把 MQ 写浅的地方。因为在这套系统里，RocketMQ 从来不是一个“大家都在发消息”的背景设施，而是一张直接承载**交易一致性、索引投影、通知触达、补偿任务、死信回放**的运行拓扑。换句话说，Topic 不是主题名字列表，ConsumerGroup 也不是框架注解上的一个字符串；它们共同决定了：一条事务链究竟是同步失败还是异步兜底、索引链究竟是近实时可搜还是悄悄漂移、通知链究竟是 eventually delivered 还是卡死在重试 / DLQ、以及一条坏消息究竟会止步于本地消息表、反复重试，还是最终坠进真正的 `%DLQ%`。

前面的材料已经反复暴露这种复杂度。订单服务不只是“发消息”，它把本地消息表、RocketMQ topic 和补偿 job 编成一条事务后半段；支付服务又同时保留了 MQ 结果通知与 Feign 回调双路补偿；搜索服务的 `note_index` / `product_index` 增量写链依赖 Canal → MQ → Consumer；通知与 IM 域则又在消费、聚合、未读对账上复用同一套“异步最终一致”思维。最近最新的运行态材料甚至已经把一条真实坏消息推到了 `%DLQ%inventory-order-transaction-consumer-group`，证明这张 MQ 图不是理论图，而是会在真实系统里留下坏消息、重投、消费组和重试痕迹的运行拓扑。`docs/test-3/HANDOFF-TASK13.md:1`

这里还要补一条这轮已经落代码的事实：payment 模块里原先那两个只打日志、不做业务处理的结果消费者，现在已经改成默认关闭。也就是说，当前更稳妥的拓扑口径不再是“payment 自己也正式消费 PAY_RESULT_TOPIC / REFUND_RESULT_TOPIC 完成主链”，而是：**支付结果链的主收敛依赖 MQ 结果通知 + Feign 回调 + Job 补偿三层，payment 模块自消费已退回到可选预留位。**`my-xhs-payment/src/main/java/com/myxhs/payment/consumer/PayResultConsumer.java:27` `my-xhs-payment/src/main/java/com/myxhs/payment/consumer/RefundResultConsumer.java:23`

所以本篇真正要回答的，不是“系统用了哪些 Topic”，而是四个更贴近生产现实的问题：第一，RocketMQ 在 `my-xhs` 里分别承担了哪些类型的异步职责；第二，为什么同样叫“消息”，有的链路是在承接事务后半段，有的在承接索引投影，有的在承接通知分发；第三，为什么消费者分组、重试与 DLQ 语义本身就是业务设计的一部分；第四，为什么一条消息能不能被安全重投，根本取决于它失败在哪一层、消息体是不是坏掉了、以及补偿链是不是还活着。

## 先给结论：这套 MQ 拓扑的核心不是 Topic 数量，而是“每条异步链都在替同步世界承担不同的代价”

先别急着看消费者代码，先把本篇最重要的人话答案钉住：`my-xhs` 的 RocketMQ 拓扑不是一组并列主题，而是一组**替同步链路承担不同代价的异步后半段**。

第一类是交易一致性链。订单创建、支付结果、退款结果、超时关单、本地消息补发，这些都不是“通知一下别人”，而是在把同步事务里不适合硬塞进去的后半段挪到 MQ 与补偿任务上。第二类是读优化投影链。Canal 把 MySQL 变更推给 RocketMQ，再由搜索侧消费者把主数据投影成 ES 查询视图；这一类消息承担的不是业务确认，而是视图最终一致。第三类是触达分发链。通知、IM、Feed 扩散之类的消息，本质是在把“用户感知结果”拆成可重试、可聚合、可对账的异步动作。第四类是恢复与诊断链。DLQ、重投、补偿任务、重试计数、本地消息表 repair job 这些，不是旁枝细节，而是 MQ 这张图最终能不能闭环的保命层。

如果忘掉这四种角色差异，只把 RocketMQ 写成“系统用了消息队列解耦”，那么后面几乎所有真实故障都会显得莫名其妙。你会不知道为什么支付服务既发 `PAY_RESULT_TOPIC` 又保留 Feign 回调；不知道为什么订单域同时有本地消息表和 RocketMQ；不知道为什么一条 malformed 的 `ORDER_CREATED` 消息最终会进 DLQ；也不知道为什么有些消息重投后还能救回来，有些重投只会再失败一遍。

这就是为什么本篇必须把 MQ 当成一张**承载不同代价的异步拓扑图**来写，而不是基础设施概览图。

## 直觉方案为什么不够：只讲“解耦”、只讲“异步提高吞吐”、只讲“失败会重试”都不够

### 失败方案一：所有消息都是“系统间解耦通知”

这是最常见的写法。订单服务发消息，支付服务收消息，搜索服务也收消息，通知服务再发点消息——总之，消息队列就是拿来让服务别直接互相调用。

这种说法在 PPT 层面没错，但在 `my-xhs` 里远远不够。因为这里有些消息是在“解耦通知”，有些消息是在“承接事务后半段”，有些消息是在“构建查询投影”，还有些消息是在“补偿重放”。这些语义如果不拆开，读者会误以为所有 Topic 的可靠性要求、幂等设计和 DLQ 处理都一样。

例如：`ORDER_TRANSACTION_TOPIC` 这种交易主题和 `NOTE_INDEX_TOPIC` / `PRODUCT_INDEX_TOPIC` 这种索引主题，在设计要求上根本不是同一类东西。前者一旦坏掉，受影响的是库存预扣、事务后半段乃至订单一致性；后者坏掉，短期更直接影响的是 ES 视图可见性与搜索体验。两者都重要，但绝对不是同一类“解耦通知”。

### 失败方案二：只要 RocketMQ 会自动重试，坏消息最后总能消费成功

第二个很危险的误解是：MQ 有重试机制，有重试就够了；最多进几次重试队列，总会成功。

最新的 Task13 运行态材料已经把这个误解彻底击穿。那次验证里，团队不是模拟了一条假消息，而是从订单本地消息表里挑出一条真实 `ORDER_CREATED` 消息，把 payload 改成 malformed JSON，让 `LocalMessageRetryJob` 重新补发到 `ORDER_TRANSACTION_TOPIC`，最后一路观察到库存消费者重试 6 次后进入 `%DLQ%inventory-order-transaction-consumer-group`。随后又真实调用 Dashboard 的 `queryDlqMessageByConsumerGroup.query` 把 `ORIGIN_MESSAGE_ID` / `RETRY_TOPIC` 查出来，再调用 `batchResendDlqMessage.do` 发起重投；结果是：HTTP 200、status=0，说明“重投请求链路”是通的，但因为消息体本身还是 malformed JSON，重投后的消费结果仍是 `CR_LATER`，并没有 magically 成功。`docs/test-3/HANDOFF-TASK13.md:13`

这件事非常关键，因为它说明：**RocketMQ 的重试机制只能处理“消费者暂时失败但消息仍然可被正确处理”的情况，不能自动修复“消息体本身就坏了”这种语义错误。** 也就是说，DLQ 不是“队列自己最终修复消息”的地方，而是把“自动重试已经证明无效”的问题暴露出来，交给人或更高层补偿逻辑处理。

### 失败方案三：只要有事务消息，订单一致性问题就都解决了

第三个误解则发生在交易链里。很多系统只要用了事务消息，就会很自然地把“最终一致性”写成“事务消息已保证”。但 `my-xhs` 的订单与支付链恰恰说明，事务消息本身只是其中一层。

订单服务除了消息队列，还有本地消息表、重试 job、映射表、库存消费者、支付结果 MQ、支付 Feign 回调、退款补偿链。支付服务也不是把结果只发一遍 MQ 就不管了，而是既发 `PAY_RESULT_TOPIC` / `REFUND_RESULT_TOPIC`，又保留 Feign 通知与 XXL-Job 补偿任务。这里需要特别按证据边界来写：当前我能直接在代码层核到的是 payment 侧确实发送这两个 Topic，并且 payment 模块自身也声明了对应消费者 / 补偿任务；而“订单服务是否以消费者身份直接订阅这两个 Topic”这一点，我这轮没有在 order 模块里直接搜到同名消费者类，因此更稳妥的表述应是：**支付结果链在当前实现中至少明确存在 MQ 结果通知 + Feign 回调 + 补偿任务三层收敛，而最终订单状态更新并不只依赖单一路径。** `my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:1083` `my-xhs-payment/src/main/java/com/myxhs/payment/consumer/PayResultConsumer.java:27` `my-xhs-payment/src/main/java/com/myxhs/payment/job/PaymentNotifyCompensateJob.java:48`

这意味着事务消息在这里不是“可靠性交给 MQ 就完事”，而是把“提交成功但后半段未完成”的问题交给一整张消息 + 回调 + 补偿拓扑去承接。只讲事务消息，不讲本地消息表、重试、DLQ 和补偿，读者会误以为这套一致性是一次性自动完成的。实际上不是。

## 先画总图：`my-xhs` 的 RocketMQ 拓扑到底分哪几类链路

先用一张文字图把全貌立住：

```text
交易一致性链
  Order 本地事务
    -> t_local_message 分片表
    -> LocalMessageRetryJob 补发
    -> ORDER_TRANSACTION_TOPIC
    -> inventory-order-transaction-consumer-group
    -> 库存预扣 / 回退 / 确认
    -> 失败重试 -> %DLQ%inventory-order-transaction-consumer-group

支付结果链
  payment-service
    -> PAY_RESULT_TOPIC / REFUND_RESULT_TOPIC
    -> 订单服务消费者更新订单状态
    -> Feign 回调 / XXL-Job 补偿兜底

索引投影链
  MySQL binlog
    -> Canal instance(note/product/inventory)
    -> RocketMQ topic
    -> NoteIndexSyncConsumer / ProductIndexSyncConsumer
    -> ES 查询视图

触达 / 分发链
  NOTIFICATION_TOPIC / FEED / 行为上报等
    -> notification / home / search 等消费者
    -> SSE / 推荐 / 聚合 / 未读 / 对账
```

这张图里最重要的，不是 Topic 名字，而是每条链都在承接一种不同的“同步世界做不起的代价”。

- 交易链承担的是“事务后半段最终一致”
- 支付结果链承担的是“结果通知 + 双路补偿”
- 索引链承担的是“主数据到查询视图的最终一致投影”
- 触达链承担的是“用户面向事件的可重试分发”

只有先把角色拆清，后面再看具体 Topic 和 ConsumerGroup 才不会混。

## 基础设施层：当前 RocketMQ 不是高可用集群，而是单 NameServer + 单 Broker

从部署事实看，`my-xhs` 当前并没有把 RocketMQ 搭成一个多 NameServer、多 Broker 的高可用集群，而是相当克制地采用了：

- NameServer：`9876`
- Broker：`11911`
- Dashboard：`18081`

并且 compose 注释已经明写：这是“单 NameServer + 单 Broker”。`my-xhs/config/docker-compose.yml:297`

这条事实很重要，因为它决定了本篇不能把 MQ 写成“多副本高可用总线”。当前这条消息骨干的复杂度主要来自**业务拓扑**，而不是 MQ 集群形态本身。换句话说，RocketMQ 在这里是单节点骨干承载多条异步链，而不是一个本身已经高度冗余的消息云。

这并不是说它不重要，恰恰相反。正因为基础设施层比较克制，Topic / ConsumerGroup / DLQ / 补偿语义就更不能写混。单 Broker 下的坏消息、补发、Dashboard 重投、保留时间和消费组积压，都会更直接地暴露在业务层。

## 交易链为什么最值得先讲：`ORDER_TRANSACTION_TOPIC` 不是通知，而是事务后半段的真正承接者

如果整张 MQ 拓扑只能先讲一条，那最应该先讲的就是订单交易链。原因很简单：它不是“异步优化”，而是交易一致性本身的一部分。

从 Task13 的运行态证据可以非常清楚地看出这条链的骨架：订单服务本地事务先把消息写进分片后的 `t_local_message`，`LocalMessageRetryJob` 再按 `payload` 原样 `syncSend` 到 `ORDER_TRANSACTION_TOPIC`，库存消费者 `inventory-order-transaction-consumer-group` 负责消费；如果消息内容本身有问题，就会一路重试直至进 `%DLQ%inventory-order-transaction-consumer-group`。`docs/test-3/HANDOFF-TASK13.md:56`

这里最重要的不是“有一个 topic 叫 ORDER_TRANSACTION_TOPIC”，而是这条链精确承接了同步事务不愿直接承担的后半段：下单本地事务先提交，本地消息表保留待发送记录，后续再由 job 补发给 MQ，把库存、优惠券、支付等后续一致性动作往外送。它本质上是 Outbox / 本地消息表模式的一种落地，而 RocketMQ 只是承接这个模式的“远端运输层”。

这也是为什么本地消息表和 MQ 必须被放在一起讲。只讲 MQ，会把事务后半段写成“订单服务发一条消息”；只讲本地消息表，又会忽略真正失败的是消费者链还是本地补发链。

## 支付结果链为什么是双路的：MQ 不是唯一通道，Feign 回调和 XXL-Job 也是拓扑的一部分

另一个特别值得单独点名的拓扑特征，是支付结果链的双路甚至三路收敛。当前直接可核到的代码事实是：`my-xhs-payment` 会发送 `PAY_RESULT_TOPIC` / `REFUND_RESULT_TOPIC`，payment 模块自己也保留了同名 Topic 的消费者与补偿任务；与此同时，支付侧还保留了 Feign 回调订单服务的主动通知路径。更稳妥地展开，这条链至少包含：

1. 支付成功或退款成功后，payment 发 MQ 消息到结果 Topic；
2. payment 模块内部保留结果消费者，用于日志、补偿与链路兜底；
3. 如果 MQ 消费失败或链路异常，支付服务还可以通过 Feign 主动回调订单；
4. 再进一步，还有 `PaymentNotifyCompensateJob` / `RefundNotifyCompensateJob` 这类定时任务扫描“支付已成功但订单未确认”的记录，继续重试通知。`my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:1083` `my-xhs-payment/src/main/java/com/myxhs/payment/consumer/PayResultConsumer.java:27` `my-xhs-payment/src/main/java/com/myxhs/payment/consumer/RefundResultConsumer.java:22` `my-xhs-payment/src/main/java/com/myxhs/payment/job/PaymentNotifyCompensateJob.java:21` `my-xhs-payment/src/main/java/com/myxhs/payment/job/RefundNotifyCompensateJob.java:19`

这里最重要的理解是：对支付链来说，MQ 不是唯一真理，而是“第一条异步通道”。Feign 回调和 XXL-Job 并不是在和 MQ 竞争，而是在帮 MQ 补最后那一截可靠性。因此本篇如果只按 Topic → ConsumerGroup 画图，会漏掉最关键的业务语义：**支付结果链至少是一条带 MQ 结果通知、主动回调与异步补偿的多路拓扑。**

这也解释了为什么很多 MQ 文章只讲“生产者发，消费者收”不够。对资金相关链路来说，消息投递成功不等于业务一致性成功；真正的成功定义是“订单最终被推进到正确状态”，而不只是“Broker 收到一条消息”。

## 索引投影链为什么要放进 MQ 拓扑篇：Canal 到 ES 中间真正依赖的是 Topic 与 ConsumerGroup 语义

虽然上一篇已经把 ES 投影视图单独拆开了，但在 MQ 拓扑篇里，索引链仍然必须回收一次。原因很简单：MySQL → Canal → MQ → Consumer → ES 这条链里，MQ 不是透明传输层，而是索引最终一致性的关键拓扑节点。

`my-xhs` 的搜索域当前能直接核到 `NoteIndexSyncConsumer`、`ProductIndexSyncConsumer`、`IncrementalIndexSyncJob` 和 `IndexRebuildJob` 这些组件，说明索引写链并不是“Canal 直接写 ES”，而是明确要经过 Topic / Consumer 这一跳。`my-xhs-search/src/main/java/com/myxhs/search/consumer/NoteIndexSyncConsumer.java:58` `my-xhs-search/src/main/java/com/myxhs/search/consumer/ProductIndexSyncConsumer.java:56`

这条链在 MQ 视角下最重要的，不是 Topic 名本身，而是 ConsumerGroup / 重试 / 补偿的含义。只要 ConsumerGroup 挂掉、格式不匹配、版本域冲突或补全失败，消息即使已经从 Canal 发出来，也未必会把正确文档落进 ES。也就是说，索引同步链的“最终一致性”并不只依赖 Canal，更依赖 MQ 拓扑有没有把消息稳定送到正确消费者。

所以本篇必须把索引链纳入 RocketMQ 总拓扑，而不是把它留在 ES 篇里当一条背景箭头。

## ConsumerGroup 为什么不能只当配置名：它决定了重试、DLQ 和重投的语义边界

在 `my-xhs` 里，ConsumerGroup 绝对不是一个可以轻描淡写的字符串。因为只要系统一出现坏消息、消费失败、回放或积压问题，最后你面对的第一定位锚点通常不是 Topic，而是 ConsumerGroup。

Task13 的运行态链已经把这点演得非常彻底：同一条真实坏消息不是简单“某个 topic 消费失败”，而是最终落到了 `%DLQ%inventory-order-transaction-consumer-group` 这个以消费组为名的死信队列里。后续 `mq.dlq_query` 和 `dlq.redeliver` 也是围绕 `consumerGroup` 展开的，而不是先从 Topic 反查。`docs/test-3/HANDOFF-TASK13.md:16`

这说明 ConsumerGroup 在这里承担了三层语义：

- 谁在消费这类消息
- 这类失败应该归属到哪个重试 / DLQ 空间
- 后续重投时应回到哪条 RETRY_TOPIC / 哪组消费者上下文中去

如果把 ConsumerGroup 当成一个“配置细节”，那一到坏消息现场你就会立刻迷路。因为真正的死信、重投、积压、观测，大多都不是沿 Topic 抽象展开，而是沿“某条消费链的这组消费者”展开。

这里还可以再补一层工程问题：当前系统已经开始把“死信积压”本身也当成一个需要独立监控的消息账本指标。`DlqMetrics` 在 `my-xhs-common/src/main/java/com/myxhs/common/metrics/DlqMetrics.java:36` 到 `:97` 中，会按 ConsumerGroup 维护 DLQ backlog 缓存，并定时通过 PullConsumer 查询 `%DLQ%<consumerGroup>` 的堆积量，暴露成 `rocketmq.dlq.backlog` 指标。也就是说，在当前实现里，ConsumerGroup 不只是 MQ 注解上的字符串，它还决定了：

- 哪条失败链进哪个死信空间；
- 监控里应该按哪个维度暴露积压；
- 告警和人工处理时应该按哪组消费者去定位。

这进一步说明 MQ 拓扑在 `my-xhs` 里不是“消息怎么发”，还包括“失败之后系统怎样继续观察和收敛这批消息”。

## 真实故障案例：真实坏消息进入 `%DLQ%inventory-order-transaction-consumer-group`，证明 DLQ 不是抽象概念而是拓扑终点之一

按照本卷方法论，本篇必须落一个真实故障案例。对 MQ 拓扑来说，最新也最有价值的案例，就是 Task13 里那条真实坏消息的 DLQ 闭环。

这次验证之所以特别珍贵，是因为它不是单测、不是 mock、也不是文档推演，而是真实修改了一条订单本地消息表的 payload，让它变成 malformed JSON，再走现有生产链路去观察 MQ 行为。最后看到的不是“系统大概会重试”，而是非常具体的事实：

- 本地消息表里的 `ORDER_CREATED` 记录被改坏
- `LocalMessageRetryJob` 把它重新发送到 `ORDER_TRANSACTION_TOPIC`
- `inventory-order-transaction-consumer-group` 重试 6 次
- 最终进入 `%DLQ%inventory-order-transaction-consumer-group`
- Dashboard 的 DLQ 查询接口可以真实拿到 `ORIGIN_MESSAGE_ID` / `RETRY_TOPIC`
- `batchResendDlqMessage.do` 可以 HTTP 200 + status=0 发起重投
- 但因为消息体本身仍然坏，重投后消费结果还是 `CR_LATER`

`docs/test-3/HANDOFF-TASK13.md:13`

用方法论的五段式把它收起来：

- 现象：真实坏消息经过重试后进入对应 ConsumerGroup 的 DLQ，重投请求成功但消费仍失败
- 根因：消息内容本身 malformed JSON，不是“偶发消费超时”或“暂时性下游失败”
- 修复：这次案例本身不是代码修复，而是用它证明“DLQ 重投只能恢复可恢复消息，不能修复坏 payload”
- 验证：真实 Dashboard 查询与重投接口链路都已跑通
- 余波：今后遇到 DLQ，第一判断永远不是“重投一下试试”，而是先分辨是消息体损坏、消费者逻辑问题，还是临时依赖故障

这正好逼出了 RocketMQ 拓扑最容易被忽略的真相：**DLQ 不是异常附录，而是异步链的一种真实落点。**

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- 支付服务显式使用 `RocketMQTemplate` 发送 `PAY_RESULT_TOPIC` / `REFUND_RESULT_TOPIC`，同时项目中存在多个 `@RocketMQMessageListener` 消费者。`my-xhs-payment/src/main/java/com/myxhs/payment/service/PaymentService.java:70` `my-xhs-payment/src/main/java/com/myxhs/payment/consumer/PayResultConsumer.java:27`
- 搜索域当前可直接核到 `NoteIndexSyncConsumer`、`ProductIndexSyncConsumer`、`BehaviorReportConsumer`、`LikeCountSyncConsumer` 等 RocketMQ 消费者。`my-xhs-search/src/main/java/com/myxhs/search/consumer/NoteIndexSyncConsumer.java:58`
- order / payment / user / home 等模块在 `application.yml` 中显式声明了 producer group 或 consumer group。`my-xhs-order/src/main/resources/application.yml:123` `my-xhs-payment/src/main/resources/application.yml:161` `my-xhs-user/src/main/resources/application.yml:157` `my-xhs-home/src/main/resources/application.yml:121`
- compose 明确当前 RocketMQ 基础设施是单 NameServer `9876` + 单 Broker `11911` + Dashboard `18081`。`my-xhs/config/docker-compose.yml:297`

L1 框架 / 语义证据：

- RocketMQ 的重试 / DLQ / 重投语义天然是以 ConsumerGroup 为边界，而不是只看 Topic 名字。
- 事务后半段、索引投影、通知触达虽然都走 MQ，但它们失败后的可恢复性、补偿方式与一致性要求并不相同。
- 真实坏消息是否能靠重投恢复，根本取决于失败是“暂时性不可达”还是“消息体 / 语义本身已坏”。

L2 运行态证据：

- `docs/test-3/HANDOFF-TASK13.md` 已首次真实完成 `ORDER_TRANSACTION_TOPIC -> consumer retry -> DLQ` 闭环，并记录了 `%DLQ%inventory-order-transaction-consumer-group`、`ORIGIN_MESSAGE_ID`、`RETRY_TOPIC` 与 `CR_LATER` 重投结果。`docs/test-3/HANDOFF-TASK13.md:1`
- `FINAL-HANDOFF.md` 已记录 payment→order Feign 与补偿链 30/30 调通，说明支付结果链不是纸面设计。`docs/FINAL-HANDOFF.md:160`
- `HANDOFF.md` 已把 `traceId 跨 MQ 传播` 单列为 order 修复项，说明 MQ 链路不仅承载业务，还进入了可观测性与诊断范围。`docs/HANDOFF.md:103`

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 RocketMQ 在 `my-xhs` 里承担交易、索引、触达和补偿多类职责，但不能把这些职责写成“都由同一套语义保障”。不同链路对幂等、DLQ、补偿和最终一致性的要求并不一致。

第二，当前可以明确写出基础设施层是单 NameServer + 单 Broker，但不能把它写成“已经具备 MQ 集群高可用”。当前可见拓扑更多是单节点骨干承载多条业务链，而不是多副本集群。

第三，当前可以明确写出 DLQ 查询 / 重投链路已被真实验证，但不能写成“DLQ 重投就能把坏消息自动修好”。Task13 的真实结论恰好相反：请求链路打通，不代表消费能成功。

第四，当前可以明确写出支付结果链具备 MQ + Feign + 补偿 job 的双路甚至三路收敛，但不能写成“任意链路失败都一定被自动修复”。更准确的口径是：系统已经显式设计了多层补偿拓扑，但每层补偿仍依赖具体依赖项是否健康、消息体是否可用、消费者逻辑是否幂等。

## 收网：这篇 MQ Topology 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的 RocketMQ 拓扑不是“系统里有一些 Topic 和消费者”这么静态，而是一张承接不同同步代价的异步地图：交易链把本地事务的后半段交给它，支付链把结果通知与双路补偿交给它，索引链把主数据投影交给它，通知与触达链把用户感知分发交给它，而 DLQ / 重投 / 补偿则共同构成了这些异步链的兜底边界。

从业务逻辑视角看，它守住的是“同步世界做不起的后半段”；从工程视角看，它把 Topic、ConsumerGroup、本地消息表、Feign 回调、补偿任务和 Dashboard 重投织成了一张真实运行拓扑；从分布式视角看，它要求每条链都明确自己的重试语义、死信边界与可恢复条件；从微服务视角看，它不是解耦装饰，而是很多核心链路真正能否最终收敛的承载平面。

更重要的是，本篇也把一个特别容易被讲虚的事实钉住了：**在 `my-xhs` 里，消息队列最危险的从来不是“有无 Topic”，而是“哪条消息失败后还能靠重试恢复，哪条消息一旦进了 DLQ 就意味着你必须回到消息体、消费者与补偿拓扑本身去定位”。**

下一篇如果继续沿 `09-data-model-storage/` 推进，这一组已经基本收口；更自然的转向，是进入 `10-async-task-transaction/01-async-event.md`，把前面交易、通知、索引和任务里反复出现的异步事件语义统一提升成机制层正文。