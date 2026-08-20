# 02 Dead Letter：为什么死信在这套系统里不是“消息没消费成功”的附录，而是边界暴露器

如果说上一章的端口冲突复盘讨论的是“服务根本没以正确姿势活起来”这种运行前置故障，那么死信这一篇要处理的，就是另一类更容易被讲轻、但对分布式系统同样致命的问题：**消息已经进了异步链，也确实被消费者看到过，但它仍然没有把业务推进到该去的位置。**

很多团队第一次看到 `%DLQ%consumer-group` 时，直觉都会把它理解成一个附带状态：消费者失败太多次，消息被扔到死信队列，之后再重投一下试试。这个理解在最表层当然成立，但在 `my-xhs` 里远远不够。因为这里的死信不只是“MQ 重试耗尽”的技术后果，而是系统在运行态公开宣告：**当前自动恢复链已经走到边界，失败不再是暂时性波动，而是需要重新判断消息体、消费者逻辑、补偿链和人工介入策略的一个硬断点。**

`my-xhs` 的历史与最新材料已经把这层复杂度暴露得非常清楚。一方面，order 域自己就维护着本地消息表里的“本地死信”（`status=3`），并且还有 `deadLetterScanJob` 再试一轮；另一方面，RocketMQ 的消费者链又会把一条真正无法消费的消息推进 `%DLQ%inventory-order-transaction-consumer-group` 这一类 ConsumerGroup 级别的死信队列。换句话说，**本地死信** 和 **Broker / Consumer DLQ** 在这里不是一个东西，它们处在两层完全不同的失败边界上。更复杂的是，Task13 还首次完成了真实坏消息进 DLQ → 查询 `ORIGIN_MESSAGE_ID` / `RETRY_TOPIC` → 发起 `dlq.redeliver` → 得到 `CR_LATER` 的全链路验证，直接证明：重投请求成功，不代表这条死信就被修好了。`docs/test-3/HANDOFF-TASK13.md:1`

所以本篇真正要回答的，不是“DLQ 在哪”，而是更贴近运行时的几个问题：本地死信和 RocketMQ 死信为什么不是同一层；为什么有些消息该被补发，有些消息即使重投也只会再次失败；为什么 `ORIGIN_MESSAGE_ID` 和 `DLQ msgId` 不是一个值；以及一条死信到底在什么时候应该被看作“可自动恢复”，什么时候必须被视作“消息语义已经坏了”。只有这些问题讲清，死信复盘才不会沦为“消费者失败次数 > N”的配置说明书。

## 先给结论：在 `my-xhs` 里，死信不是“重试失败的终点说明”，而是“自动恢复边界已经暴露”的明确信号

先别急着看 DLQ 查询接口，先把本篇最重要的人话结论钉住：`my-xhs` 的死信，真正表达的不是“这条消息没消费成功”这么浅，而是“**系统已经把自动重试、补发、补偿、状态回查这些恢复手段跑了一轮，但仍然没把这条消息安全送进正确语义轨道**”。

这条结论在项目里至少有三层含义。

第一，死信是恢复系统的边界信号，而不是日志里的一条错误提示。它说明系统已经不再把这件事当成普通瞬时抖动，而是把它升级成一个需要专门处理的异常状态。第二，死信不是只有一种。`my-xhs` 里至少同时存在**本地消息表死信**和**RocketMQ Consumer DLQ** 两类概念，它们分别对应“消息还没可靠离开本地恢复层”和“消息已经进入消费链但消费者无论如何处理不了”。第三，死信不是天然可重投成功。死信是否可恢复，根本取决于失败原因：是依赖短暂不可达、是消息字段缺失、是消费者逻辑有 bug，还是消息体本身就是坏的。

一旦把这三层混成一句“死信就是失败消息”，你后面几乎一定会把系统边界讲错。你会误以为本地消息表 `status=3` 和 `%DLQ%inventory-order-transaction-consumer-group` 是一回事；会误以为 `dlq.redeliver` 请求返回 200 就说明问题解决；会误以为“进入死信”只需要调大重试次数就能避免。`my-xhs` 的真实运行态恰恰说明这些都不成立。

## 直觉方案为什么不够：不是所有死信都该重投，也不是所有失败都值得先进 DLQ

### 失败方案一：消费者失败次数耗尽后，一律重投一次再说

这是最常见也最危险的直觉。只要一条消息进了 DLQ，就从 dashboard 查出来，执行一次重投。如果还不行，再多重投几次。反正 DLQ 的价值不就是“以后还能再投”吗？

Task13 那条真实坏消息已经把这个误解彻底击穿。那次实验里，团队不是用历史旧死信做演示，而是直接从 `t_local_message` 里挑出一条真实 `ORDER_CREATED` 记录，把 payload 改成 malformed JSON，再补发到 `ORDER_TRANSACTION_TOPIC`。结果非常清楚：库存消费者重试 6 次后进 `%DLQ%inventory-order-transaction-consumer-group`；随后 `dlq.redeliver` 的 HTTP 请求链路和 Dashboard 交互链都成功了，但消费结果仍然是 `CR_LATER`。原因不在链路，而在消息体本身依旧是坏的。`docs/test-3/HANDOFF-TASK13.md:164`

这说明死信重投不是“总有希望再试成功”的万金油，它只适合那种**消息本体仍然正确，只是外部环境暂时不允许成功**的场景。一旦消息语义自身坏掉，重投再多次也只是在可靠地重复坏事实。

### 失败方案二：本地消息表死信和 RocketMQ 的 DLQ 反正都叫死信，可以统一处理

`my-xhs` 这套系统里最容易讲混的一点，就是本地死信和 RocketMQ DLQ 都带着“dead letter”的词，看起来像同一层东西。实际上完全不是。

`LocalMessageRetryJob` 里的“死信”指的是：本地消息表在补发阶段指数退避耗尽后，`status=3`，并由 `deadLetterScanJob` 再尝试重投。它还会维护 `myxhs.local_message.dead_letter.count` 指标，日志里直接打“需人工介入”。`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:147`

而 RocketMQ Consumer DLQ 则是另一层失败：消息已经离开本地消息表和补发层，进入了真正的消费链；消费者重试达到 `maxReconsumeTimes` 后，Broker 才把它送进 `%DLQ%consumer-group`。Task13 明确写了：本次要验证的是 RocketMQ consumer DLQ，不是本地消息表死信。`docs/test-3/HANDOFF-TASK13.md:67`

两者之间最大的区别在于：**本地死信暴露的是“消息没可靠走出发送侧恢复层”，RocketMQ DLQ 暴露的是“消息已经走进消费侧，但消费者语义没法收下它”。** 如果把它们统一叫“死信再重试”，你就会忽略真正需要排障的位置到底在发送侧还是消费侧。

### 失败方案三：只要调高 `maxReconsumeTimes`，就能把死信问题压下去

这也是一种典型的“表面缓解”思路。既然消息总是在第 6 次失败后进死信队列，那把 `maxReconsumeTimes` 再调大一点，不就能少出几个死信了吗？

这种思路对监控数字可能有短期美化作用，但对 `my-xhs` 的真实故障边界没有帮助。因为如果消息本身 malformed JSON、消费者字段解析逻辑出错、订单状态已矛盾，继续重试只是在重复同一个不可恢复失败。Task13 那条消息之所以在第 6 次失败后进 `%DLQ%inventory-order-transaction-consumer-group`，并不是因为 6 次太少，而是因为第 1 次到第 6 次失败的原因都没有变化：消息体还是坏的。`docs/test-3/HANDOFF-TASK13.md:168`

所以这篇后面会反复强调：死信不是“重试次数配置没调对”，而是“系统必须承认恢复逻辑已经撞到语义边界”的信号。

## 先画总图：`my-xhs` 的死信至少分成两层

先把这张失败拓扑图立住：

```text
发送侧恢复层
  t_local_message(status=0/2)
    -> LocalMessageRetryJob 指数退避补发
       -> 失败次数耗尽 -> status=3（本地死信）
       -> DeadLetterScanJob 每小时再试一轮
       -> 仍失败 -> 本地死信持续存在 + 指标/日志告警

消费侧恢复层
  RocketMQ topic
    -> ConsumerGroup 重试
       -> maxReconsumeTimes 耗尽
       -> %DLQ%consumer-group
       -> Dashboard / 工具链查询
       -> dlq.redeliver 发起重投
       -> CR_SUCCESS / CR_LATER
```

这张图里最关键的不是“有两种死信”，而是两种死信分别宣告了两种不同的边界：

- 本地死信 = 发送侧补发链没有把消息稳定送出去
- Consumer DLQ = 发送成功了，但消费侧无法把它转成正确业务动作

只有先把这两层分清，后面再看查询、重投和人工介入，才不会把问题全混到 RocketMQ 一侧去。

## 本地消息表死信为什么不是 MQ DLQ：它暴露的是发送侧恢复器已经耗尽

`LocalMessageRetryJob` 在补发失败达到上限时，会把消息标记成 `status=3`，累加 `deadLetterCount`，并明确日志写出“需人工介入！请检查下游服务是否正常”。`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:147`

这条设计的意义非常关键。它说明在 `my-xhs` 里，本地消息表本身就带着一套发送侧恢复状态机：

- `0`：待处理
- `2`：失败待重试
- `3`：本地死信

而且它不是无限重试，而是先指数退避（30s、60s、120s、240s、480s），然后停下来，把问题升级成本地死信暴露给后续流程与人工。`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:141`

这说明本地消息表死信的作用，不是为了“以后随便看一下”，而是明确告诉系统：**快速补发这一层发送侧自动恢复已经走完了。** 这时如果还要继续自动尝试，就必须切换到另一套更保守的流程——比如 `deadLetterScanJob`。只有当 `deadLetterScanJob` 再重投之后仍然失败，本地死信才真正从“发送侧快速恢复耗尽”升级成更明确的边界暴露。

## `deadLetterScanJob` 为什么说明本地死信不是终点，而是人工介入前的最后自动恢复层

`LocalMessageRetryJob` 里其实不只有补发，还有另一段经常被忽略的逻辑：`deadLetterScanJob`。它每小时扫描最近 24 小时内的 `status=3` 本地死信，最多再给 3 次保守重投机会。`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:178`

这一层很有代表性，因为它说明作者对死信的理解不是“进入死信就宣判人工”，而是“进入死信意味着要从快节奏重试切换到更保守、更显式的恢复层”。也就是说，本地死信不是终点，而是自动恢复链中的最后一级。

但它也同时说明另一件事：只要这一级仍然失败，系统就不打算再无限自动重试了。代码里用负值 `retryCount` 区分死信重试次数，就是在清楚地表达：已经进入另一类状态空间。`

对读者来说，这一步特别重要，因为它能帮助理解为什么“死信”在 `my-xhs` 里是一个分层状态，而不是单个 bool 标志。

## Consumer DLQ 为什么更危险：消息已经进入了正确拓扑，却仍然不能被业务收下

和本地死信相比，Consumer DLQ 的危险性更高。因为一条消息能进 `%DLQ%consumer-group`，说明发送侧的很多事情其实都已经做对了：消息已经进入 Broker，也已经进入了正确的 Topic，消费者也真的收到了，甚至还尝试了多次。问题出在最后一步——**业务消费者无法把它转成正确状态变化。**

Task13 的真实案例就非常典型。消息已经从 `t_local_message` 补发到 `ORDER_TRANSACTION_TOPIC`，inventory consumer 也确实连续消费失败；最终进入 `%DLQ%inventory-order-transaction-consumer-group`。这不是“消息没到”，而是“消息到了，但消费语义无法成立”。`docs/test-3/HANDOFF-TASK13.md:175`

这也是为什么 Consumer DLQ 比本地死信更容易被误判。很多人会下意识把它理解成“队列暂时堵了”“再投一次试试”，但其实它往往意味着业务处理器自身已经无法接受这条消息：字段缺失、格式错误、状态矛盾、幂等条件不满足，甚至下游逻辑 bug，都可能把消息推到这一步。

## `ORIGIN_MESSAGE_ID` 和 `DLQ msgId` 为什么必须分清：重投不是把死信本身再发一次

Task13 提供了一个非常适合写进正文的细节：DLQ 里的 `msgId` 和 `ORIGIN_MESSAGE_ID` 不是一个东西。Dashboard 查询结果里同时出现：

- `dlqMsgId = 15D661D449170AAEE2A25F0057C3EEA9`
- `ORIGIN_MESSAGE_ID = 1582F75900002E870000000025385814`
- `RETRY_TOPIC = ORDER_TRANSACTION_TOPIC`

`docs/test-3/HANDOFF-TASK13.md:168`

这说明死信重投不是“拿 DLQ 这条消息自身的 msgId 再投一次”，而是要回到它的原始消息身份，把这条原始消息重新投回 `RETRY_TOPIC`。文档里甚至专门提醒：`batchResendDlqMessage.do` 的 `msgId` 参数必须传 `ORIGIN_MESSAGE_ID`，传错就找不到消息。`docs/test-3/HANDOFF-TASK13.md:297`

这点很关键，因为它把“死信重投”从一个看似简单的操作，变成了必须理解 MQ 内部语义的运维动作。你不是在对一个失败样本做简单 resend，而是在请求 Broker 把原消息再进入一次消费链。

## 为什么 `dlq.redeliver` 请求成功不等于业务修复成功

这也是 `my-xhs` 死信复盘里最值得保留的一层经验。Task13 已经把结果写得非常直白：`batchResendDlqMessage.do` 返回 `HTTP 200`，body 里 `status=0`，说明 Dashboard 与 Broker 的交互链路是通的；但 `consumeResult = CR_LATER`，说明消费仍然失败。`docs/test-3/HANDOFF-TASK13.md:225`

这意味着死信重投的成功与否必须拆成至少两层：

- **动作层成功**：查询到死信、提取 `ORIGIN_MESSAGE_ID`、发起重投请求、Broker 接收了重投动作
- **语义层成功**：消费者真正把这条消息处理完，结果不再是 `CR_LATER`

`my-xhs` 这次真实案例最有价值的地方就在于，它强迫我们承认：动作层成功并不代表语义层成功。也就是说，**重投请求成功**不是复盘终点，只是新的观察起点。

## 真实故障案例：真实坏消息进 `%DLQ%inventory-order-transaction-consumer-group`，重投仍是 `CR_LATER`

按照本卷方法论，本篇必须有真实故障案例。对死信篇来说，Task13 那次坏消息的完整闭环几乎就是最合适的主案例。

它的价值在于，整个过程都是真实的：

- 本地消息表 payload 被改坏
- `localMessageRetryJob` 真实补发到 `ORDER_TRANSACTION_TOPIC`
- inventory consumer 真实重试 6 次
- Broker 真实把消息推进 `%DLQ%inventory-order-transaction-consumer-group`
- Dashboard 真实返回 `ORIGIN_MESSAGE_ID` / `RETRY_TOPIC`
- `dlq.redeliver` 真实返回 `status=0`
- 但 `consumeResult` 仍是 `CR_LATER`

`docs/test-3/HANDOFF-TASK13.md:149`

用方法论五段式收它：

- 现象：坏消息进入 Consumer DLQ，重投动作成功发起，但消费结果仍失败
- 根因：消息体本身 malformed JSON，消费者每次都会在同一解析点失败
- 修复：不是简单重投，而是必须回到消息源或 payload 本身修复坏事实
- 验证：DLQ 查询、`ORIGIN_MESSAGE_ID` 提取、重投请求与 `CR_LATER` 返回都已真实完成
- 余波：以后看到 DLQ，不要先问“怎么重投”，而应先问“这条消息失败是暂时性问题，还是消息本体已经坏了”

这条案例几乎就是本篇的总纲：**死信不是“再试一次就好”的附件，而是自动恢复边界的公开暴露。**

这里还要再补一个很重要的分布式判断：并不是所有失败都会长成“进 DLQ 的坏消息”，还有一类更危险的情况是——消息根本没有进入重试/死信体系，就被系统当成功确认掉了。历史 `F-006`、`F-015` 这两类问题正好代表了这种更隐蔽的边界：

- 一类是补偿消息缺少路由信息时被直接 ACK，根本不重试、不进 DLQ；
- 一类是事务消息字段异常时被静默确认，留下“订单已创建、库存未预扣”的隐形裂口。

也就是说，DLQ 至少还有一个显性的暴露位置；真正更危险的，是**失败没有被正确升级成重试或死信，而是在错误语义下被控制面当成成功吞掉。**

这让本篇和 `03-feign-timeout.md`、`04-startup-failure.md` 形成了同一条主题：运行时最难的故障，往往不是报错，而是系统错误地确认了一次本该继续重试或继续补偿的失败。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- `LocalMessageRetryJob` 明确实现了本地消息状态机、指数退避、本地死信 `status=3`、`deadLetterCount` 指标以及 `deadLetterScanJob`。`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:147`
- `OrderCompensationConsumer` 明确在 RocketMQ 消费层再承接补偿消息，并设置 `maxReconsumeTimes=3`，说明消费链本身也有失败边界。`my-xhs-order/src/main/java/com/myxhs/order/consumer/OrderCompensationConsumer.java:32`

L1 框架 / 语义证据：

- 本地消息死信和 Consumer DLQ 不是同一层：前者暴露发送侧恢复层耗尽，后者暴露消费侧语义无法被收下。
- `ORIGIN_MESSAGE_ID` / `RETRY_TOPIC` 的存在说明 DLQ 重投针对的是原消息身份，不是对 DLQ 样本本身做简单 resend。
- `consumeResult=CR_LATER` 说明“重投动作已发起”与“业务语义已恢复”必须严格分开。

L2 运行态证据：

- `docs/test-3/HANDOFF-TASK13.md` 已真实记录 `%DLQ%inventory-order-transaction-consumer-group`、`ORIGIN_MESSAGE_ID`、`RETRY_TOPIC`、`reconsumeTimes=6` 以及 `CR_LATER` 的完整结果。`docs/test-3/HANDOFF-TASK13.md:164`
- 同一份材料还明确区分了“本次要验证的是 RocketMQ consumer DLQ，不是本地消息表死信”，说明这两层边界已经在真实运行中被刻意区分。`docs/test-3/HANDOFF-TASK13.md:67`

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 `my-xhs` 同时存在本地消息死信和 Consumer DLQ 两层失败边界，但不能把它写成“所有失败最终都会走到同一个死信出口”。有些失败停在本地补发层，有些停在消费层，有些在补偿层就被收掉。

第二，当前可以明确写出 DLQ 查询与重投链路已经被真实验证，但不能把它写成“重投链路已经证明可恢复任意死信”。Task13 的结果恰好说明相反：链路通，不代表消息可恢复。

第三，当前可以明确写出本地死信会触发指标与日志告警，但不能把它写成“本地死信一定优先于 Consumer DLQ 被处理完”。这取决于消息到底卡在发送侧还是消费侧，两层可能并行暴露问题。

第四，当前可以明确写出 `ORIGIN_MESSAGE_ID` 与 `DLQ msgId` 必须区分，但不能把这扩写成“只要拿到原始消息 ID 就能成功重投”。消息体语义错误、消费者逻辑错误、依赖不可达都仍会让 `CR_LATER` 持续存在。

## 收网：这篇 Dead Letter 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的死信不是“消费者失败次数超限”的附录状态，而是一套自动恢复系统主动暴露出来的边界标志：本地消息补发层耗尽了，ConsumerGroup 语义接不住了，或者恢复动作链虽然通了，但消息本体仍然坏着。它告诉运维和开发的，不是“这里有一条失败消息”，而是“自动系统已经把它能自动做的部分做完，现在必须重新判断失败类型和恢复手段”。

从业务逻辑视角看，它守住的是“失败不再被当成普通抖动”的升级边界；从工程视角看，它把本地消息状态机、RocketMQ DLQ、Dashboard 查询、`ORIGIN_MESSAGE_ID`、重投结果和指标告警织成了一张失败诊断图；从分布式视角看，它清楚地区分了发送侧恢复层与消费侧恢复层；从微服务视角看，它让“消息失败”不再只是某个消费者的局部异常，而成为整条异步链的系统级暴露点。

更重要的是，本篇把一个特别容易被讲错的事实钉住了：**死信真正危险的地方，不是它进了队列，而是你误以为把它从队列里再扔回去一次，问题就已经解决了。**

下一篇如果继续沿 `11-runtime-failure-review/` 推进，最自然的顺序就是进入 `docs/openjdk/vol-xhs/11-runtime-failure-review/03-feign-timeout.md`，把前面多次出现的 Feign 超时、回调补偿与“依赖不可达”边界系统复盘。