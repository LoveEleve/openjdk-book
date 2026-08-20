# 04 Scheduled Task：为什么这些定时任务不是“后台扫一遍数据”这么轻

走到 `10-async-task-transaction/` 这一组的第四篇，读者最容易出现的一个误解是：前面既然已经把异步事件、事务消息、补偿链都讲清了，那定时任务大概只是这些机制的后台收尾器，篇幅不会太重——无非就是一些 `@Scheduled` 或 `@XxlJob` 定期跑一跑。

这恰恰是 `my-xhs` 里最不能轻写的一层。因为在这套系统中，定时任务并不是“后台巡检”这么弱的角色，而是很多主链路最后一条兜底腿：本地消息表补发靠它、死信扫描靠它、支付 / 退款通知补偿靠它、库存补偿与预扣超时释放靠它、未读对账靠它、索引重建与增量补偿靠它、推荐特征与热池刷新也靠它。换句话说，一旦这层调度系统错配、停摆或者表面成功但实际没产物，前面那些异步与事务设计再漂亮，也会很快在真实运行里露底。

`my-xhs` 历史材料已经把这一层的重要性暴露得非常直白。最典型的是那轮对 XXL-Job 配置错配的深挖：代码里明明有 19 个 `@XxlJob`，但运行库里一度只有大约 8 个能真正被调度，order、coupon、cart、home、search 一大批任务挂在 sample 组或根本没有对应执行器组，结果 `orderCloseJob`、`localMessageRetryJob`、`deadLetterScanJob`、`couponReconcileJob` 等关键兜底链一度形同虚设。`docs/test-2/review-fresh/review-production-config.md:251`

所以本篇真正要回答的，不是“系统有哪些定时任务”，而是更偏执行系统的问题：**这些任务到底在替哪一层业务状态兜底；哪些任务跑在进程内 `@Scheduled`，哪些任务依赖调度中心 `@XxlJob`；一旦调度错配或静默失败，业务会失去哪一条最后保障；以及为什么很多看似一样的定时任务，其实分属完全不同的恢复语义。**

## 先给结论：`my-xhs` 的定时任务不是后台附属品，而是异步与最终一致性架构的最后执行层

先别急着进任务清单，先把本篇最重要的人话答案钉住：`my-xhs` 的定时任务，不是“系统闲着时顺手扫扫数据”，而是很多异步链与最终一致性设计的最后执行层。

这句话至少有三层含义。

第一，很多任务的职责不是优化，而是兜底。`localMessageRetryJob`、`deadLetterScanJob`、`paymentNotifyCompensateJob`、`refundNotifyCompensateJob` 这些都不是锦上添花；如果它们停掉，消息补发、支付结果通知、退款后状态推进这些链路就会直接失去最后一层恢复能力。第二，任务运行方式本身就是系统设计的一部分。`@Scheduled` 代表它跟着进程活、由本机线程池驱动；`@XxlJob` 则代表它依赖外部调度中心的注册、执行器组、任务配置和触发链。第三，任务“存在于代码里”不等于任务“真的在跑”。这也是为什么本篇必须同时讲代码、配置和运行态，而不能只做源码清单。

把这三层忘掉，你就会在很多地方做出非常典型的误判。你会以为定时任务没跑最多是“慢一点恢复”；你会把 `@Scheduled` 和 `@XxlJob` 当成两种语法糖；你会觉得只要 `job handler` 名字存在，调度层就已经完工。`my-xhs` 的历史故障刚好说明这些都不成立。

## 直觉方案为什么不够：不是所有任务都能靠进程内定时跑，也不是接了 XXL-Job 就一定会调到

### 失败方案一：所有任务都可以用本机 `@Scheduled`

这是最朴素的方案。每个服务自己起一个或几个本地定时任务，用 `fixedRate` 或 `cron` 扫状态、补消息、重建索引。这样看起来最简单，不用外部调度中心，也没有执行器组、登录态、任务管理页这些额外复杂度。

问题在于，这种方案一旦进入多实例或需要跨服务统一观测的阶段，很快就会碰壁。谁来保证只有一个实例执行？任务是否可以被远程触发？任务失败是否有统一日志和告警？不同服务的调度是否能在一个地方被运营和回放？这些都是纯 `@Scheduled` 难处理的点。

`my-xhs` 并没有完全抛弃 `@Scheduled`，但它也没有把所有关键任务都留在本机定时器里。像库存补偿、搜索增量补偿、热搜计算这类更偏进程内状态演进的任务，仍然有 `@Scheduled`；而本地消息补发、订单超时关单、支付 / 退款通知补偿、推荐计算、未读对账、优惠券对账等更需要统一调度与观察的任务，则进入了 `@XxlJob`。这说明作者在主动按任务性质区分执行方式，而不是一把梭。`

### 失败方案二：只要标了 `@XxlJob`，任务自然就会被调到

这恰恰是 `my-xhs` 历史上最真实也最危险的坑。很多人写分布式调度时，容易把“代码里有 handler 名字”误当成“调度已经生效”。但 review 材料已经清楚记录：某一阶段代码里明明有 19 个任务，运行库里却只有约 8 个真正可调度。原因不是代码没写，而是 `xxl_job_group` 缺失执行器组，或者 `xxl_job_info` 挂在 sample 组 / NULL 地址下，导致任务事实上永远不会被调度。`docs/test-2/review-fresh/review-production-config.md:251`

这件事特别能说明为什么本篇必须同时看三层：

- 代码里有没有 `@XxlJob`
- 配置里有没有 executor 地址 / token / appname
- 运行库里对应 job_group / trigger_status / handler 是否真的对上

少看任何一层，任务系统都会呈现出“看起来齐全，实际上瘫痪”的假象。

### 失败方案三：所有定时任务都只是“恢复慢一点”，不会直接影响主链正确性

这也是一个很危险的误解。表面上看，任务系统出问题最多就是某些事情晚一点发生。但 `my-xhs` 的关键任务很多都不是“优化延后”，而是“主链最后一条安全腿”。

review 文档对 `orderCloseJob` 的表述尤其典型：它一度失效时，order 模块就只剩 RocketMQ 延时消息这一条腿在兜底；如果延时消息再出问题，待支付订单就可能永远不关闭，库存和优惠券也不会自动释放。`docs/test-2/review-fresh/review-production-config.md:258`

同一类风险也会落到 `localMessageRetryJob` 和 `deadLetterScanJob` 上：它们一旦失效，不是“重试晚一点”，而是整个本地消息补发 / 死信扫描机制直接失效。`couponReconcileJob`、`unreadReconcileJob`、`IndexRebuildJob` 以及 inventory 域的对账 / 补偿一类任务也是如此：它们未必总在主链第一现场，但它们在修正、收口和恢复最后一层状态。

这就意味着，定时任务在这里不是后台低优先级，而是“主链正确性的一部分”。

## 先画总图：`my-xhs` 的调度系统其实分成了两套执行平面

先用一张文字图把总体拓扑立住：

```text
进程内调度平面（@Scheduled）
  - InventoryCompensationJob (30s)
  - IncrementalIndexSyncJob (60s)
  - IndexRebuildJob (cron 4:00)
  - HotSearchService.calculateHotSearch (60s)
  - notification/IM 局部维护任务

调度中心平面（@XxlJob）
  - localMessageRetryJob
  - deadLetterScanJob
  - orderCloseJob
  - paymentNotifyCompensateJob
  - refundNotifyCompensateJob
  - unreadReconcileJob
  - couponReconcileJob
  - recommendItemCFJob / recommendFeatureJob / recommendHotPoolJob
  - followCounterRepairJob / counterReconcileJob ...

运行保障层
  - xxl-job-admin 18080
  - executor appname + port
  - job_group / job_info 配对
  - trigger_status
  - 手工 trigger / 日志回放 / 失败重试
```

这张图里最关键的不是任务名字，而是作者并没有把所有调度都塞进一个框架里。为什么要分两套？因为任务语义本身不同。

- 进程内 `@Scheduled` 更像本服务自己的状态维持器，适合与本地资源、轻量周期任务、无外部触发依赖的逻辑绑在一起。
- `@XxlJob` 更像跨实例受控执行器，适合需要“全局只跑一份”、需要运维可视化、需要远程触发和统一管理的兜底任务。

这也是为什么本篇必须把调度机制当成一层独立设计，而不是附在异步事件或补偿篇的末尾。

## `@Scheduled` 这一侧：进程内任务更像局部状态维持器，而不是全局调度中心

`my-xhs-search` 里有两类非常适合说明 `@Scheduled` 角色的任务：

- `IncrementalIndexSyncJob`：当前代码实际按 60 秒扫一次 Redis Set，把失败索引做增量补偿；但它自己的类注释仍保留“每 5 分钟”这一旧口径，说明这里已经发生过调度频率调整
- `IndexRebuildJob`：按 cron 在凌晨 4 点做全量重建

`my-xhs-search/src/main/java/com/myxhs/search/job/IncrementalIndexSyncJob.java:77` `my-xhs-search/src/main/java/com/myxhs/search/job/IndexRebuildJob.java:79`

这类任务的共同点是：它们都更像“当前进程掌握本地状态 / 本地依赖的延迟修正器”。增量索引补偿本质上是在消费自己服务里累积的失败集合；全量重建也更像搜索域内部的周期性校偏器。这些任务不一定需要外部调度中心每次精确触发，也未必要求人工随时在管理台上手动点火。

库存补偿任务也属于这一类。`InventoryCompensationJob` 用 `@Scheduled(fixedRate = 30000)` 周期扫 `t_inventory_compensation`，再依赖 Redisson 锁保证单次只有一个实例处理。这种任务天然更像“进程内跑 + 轻分布式互斥”模式，而不是交给中心化调度台的那种任务。`my-xhs-inventory/src/main/java/com/myxhs/inventory/job/InventoryCompensationJob.java:48`

这说明 `@Scheduled` 在 `my-xhs` 里不是“低配版 XXL-Job”，而是作者对一些局部补偿和状态维持任务做出的明确选择：让它们随服务一起活着、就近修复、尽量不引入额外调度依赖。

## `@XxlJob` 这一侧：它承担的不是“定时器”，而是跨实例受控执行与运营观察

和进程内 `@Scheduled` 相比，`@XxlJob` 在 `my-xhs` 里承担的是完全不同的一层职责。

最典型的例子就是 order 域的三件套：

- `localMessageRetryJob`
- `deadLetterScanJob`
- `orderCloseJob`

这些任务如果交给每个实例自己本地定时跑，最麻烦的不是代码写不出来，而是很难保证“只跑一份、跑的是哪一份、失败后谁看得到”。`LocalMessageRetryJob` 的类注释已经明确写到：XXL-Job Admin 只调度一个 Executor 实例执行，因此不需要 Redisson 分布式锁。也就是说，作者把“单实例选主”这件事外包给了调度中心。`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:35`

同样的逻辑也出现在支付补偿任务、未读对账任务、推荐计算任务上。它们的共同点是：

- 业务价值高，失败要有人看见
- 往往需要统一运维入口手工触发 / 回放
- 多实例下最好由调度中心明确指定执行者
- 调度记录本身也是诊断材料

这正是为什么 `@XxlJob` 在这里不是“定时器语法”，而是调度治理平面。

## XXL-Job 错配事故为什么特别关键：它证明“代码里有 Job”根本不等于“系统里有兜底”

按照本卷方法论，每篇都必须有真实故障案例。对调度系统这篇来说，最有代表性的案例就是 `P-D20`：XXL-Job 调度配置严重错配。

review 文档对它的描述几乎就是调度系统为什么必须单独成篇的最佳证据：代码里有 19 个任务，但运行库里只有约 8 个可调度；order/coupon/cart/home/search 组缺失或错挂 sample 组，导致 `orderCloseJob`、`localMessageRetryJob`、`deadLetterScanJob`、`couponReconcileJob` 等关键兜底任务事实上永远不跑。`docs/test-2/review-fresh/review-production-config.md:251`

这个事故的特别之处在于，它既不是业务代码 bug，也不是中间件整体挂掉，而是最容易被忽略的一类“治理平面错配”：

- handler 名在代码里存在
- executor 在端口上可能也监听了
- 但 job_group / job_info / 地址 / trigger_status 没配对好
- 于是任务实际上没有被调度

用方法论的五段式收它：

- 现象：大量 `@XxlJob` 看起来存在，但关键兜底任务长期不触发
- 根因：执行器组缺失、任务挂错组、sample 组地址为空等调度元数据错配
- 修复：补建 order/coupon/cart/home/search 执行器组，修正 job_group，手工校验任务可触发
- 验证：文档已记录 19 个任务可调度、`orderCloseJob` 等触发后成功执行
- 余波：以后任何“任务怎么没跑”的排障，都不能只 grep `@XxlJob`，必须连代码、配置库、调度台三层一起核

这就是为什么定时任务在 `my-xhs` 里不是后台小活，而是运行系统的一部分。

## `localMessageRetryJob` / `deadLetterScanJob` 为什么说明调度失效会直接把事务消息兜底链打断

在 order 域里，调度系统的风险是最容易被低估的。因为很多人会以为事务消息既然已经有 Broker 回查和消费者重试了，本地消息补发任务就算晚一点跑也无所谓。

但 review 文档已经明确写出：一旦 `localMessageRetryJob` / `deadLetterScanJob` 失效，本地消息表补发和死信再投链就一起失效。换句话说，事务消息链从“有第二条腿”退化成只剩实时半消息和消费者这条腿，一旦这条腿断掉，就只能靠人工。`docs/test-2/review-fresh/review-production-config.md:258`

这说明在 `my-xhs` 里，调度系统并不是附着在事务消息旁边的辅助功能，而是事务消息链真正闭环的必要组成部分。

## 支付 / 退款通知补偿任务为什么说明“结果事实”也需要被周期性重扫

`PaymentNotifyCompensateJob` 和 `RefundNotifyCompensateJob` 之所以重要，不只是因为它们是 `@XxlJob`，而是因为它们展现了调度系统的另一种价值：**有些事实不是靠一次回调完成，而是要被周期性地重新问一遍“你现在还缺不缺这一刀”。**

支付补偿任务每 2 分钟扫描支付成功记录，退款补偿任务每 3 分钟扫描退款成功记录。它们都不是无脑重试，而是：

- 先查支付 / 退款表里哪些记录到了补偿窗口
- 再通过 Feign 去问订单域当前状态
- 状态仍未推进才重试通知
- Redis 记录通知计数，超过上限就报警人工处理

`my-xhs-payment/src/main/java/com/myxhs/payment/job/PaymentNotifyCompensateJob.java:65` `my-xhs-payment/src/main/java/com/myxhs/payment/job/RefundNotifyCompensateJob.java:60`

这里最值得记住的，不是 cron 表达式，而是这种“结果型事实必须被周期性重扫”的设计心态。它和本地消息补发完全不是一回事：前者补的是“消息没送出”，这里补的是“消息送出过，结果事实仍没被对方域承认”。这正是调度系统之所以要单独成篇的原因——任务不是都在做同一类工作。

## 推荐、索引、未读对账这些任务为什么又是另一类：它们修的是长期漂移，而不是立刻缺口

除了交易补偿型任务，`my-xhs` 还有一批调度任务修的是另一类问题：**不是一笔事件马上没收口，而是数据视图和状态长期慢慢漂移。**

- `IndexRebuildJob`：每天凌晨 4 点做全量重建，校正 ES 查询视图
- `IncrementalIndexSyncJob`：每 60 秒补一遍失败索引
- `unreadReconcileJob`：未读数与聚合状态对账
- `recommendItemCFJob` / `recommendFeatureJob` / `recommendHotPoolJob`：不是“补偿一次失败请求”，而是在周期性刷新离线结果与推荐状态

这些任务的共同点是：它们关心的是时间积累出来的偏差，而不是刚刚发生的一次单点失败。这种任务如果不跑，系统表面上未必立刻报错，但查询视图、推荐结果、未读计数和聚合状态会慢慢偏离。也就是说，它们修的是“漂移”，不是“断点”。

这也是为什么调度系统不能只讲补偿。补偿修断点，对账 / 重建修漂移，两者在业务感觉上完全不同，但都属于任务系统在最终一致性架构中的核心职责。

## 运行态证据说明了什么：任务系统既是恢复器，也是风险信号源

`HANDOFF-TASK11.md` 和 review 材料已经给出一个非常有价值的事实：当任务系统跑通后，很多异步链问题不会立刻变成用户可见事故，而是先在任务日志、任务状态和补偿计数里留下痕迹。比如：

- `T-110` 提到事件链 `CREATED` 落库 + 全流转 seq 完整
- `P1-2/P1-3` 提到补偿三动作 MQ 投递已验证
- review 文档又明确把 “task trigger_status / group 配错 / sample 地址 NULL” 这类调度元数据当成系统性风险

`docs/test-3/HANDOFF-TASK11.md:83` `docs/test-2/review-fresh/review-production-config.md:251`

这说明调度系统在 `my-xhs` 里有两个身份：一方面它是恢复器，真正推动补偿与重建执行；另一方面它还是风险信号源，告诉你哪条兜底腿已经断了。如果只把任务系统看成“后台执行逻辑”，你就会漏掉第二层价值。

这里还要再补一个很关键的工程问题：**任务成功和业务产物成功不是一回事。**

推荐链历史上就出现过非常典型的“XXL-Job 假成功”问题：任务外层向调度台返回 `handleSuccess()`，但内层离线计算路径实际上失败，导致推荐产物长期停留在旧版本。当前 `RecommendComputeJob` 的实现之所以值得单独点出来，就是因为它在三个离线路径里都改成了“源表或写入失败就直接抛出异常”，见 `my-xhs-search/src/main/java/com/myxhs/search/job/RecommendComputeJob.java:54` 到 `:62`、`170` 到 `:178`。这说明当前调度系统真正要守住的，不只是“有没有调到”，还包括：

- 调到之后是否真的生成了新产物；
- 业务空数据和执行失败是否被严格区分；
- 下游依赖缺失时，任务会不会向外暴露失败，而不是继续假装成功。

这层对 `my-xhs` 特别重要，因为很多离线任务负责的不是“多跑一次也无所谓”的辅助结果，而是推荐矩阵、特征表、热门池、索引重建这些会长期污染用户感知的产物。也就是说，调度系统的假成功风险本身，就是最终一致性链的一部分。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- `LocalMessageRetryJob`、`deadLetterScanJob`、`paymentNotifyCompensateJob`、`refundNotifyCompensateJob`、`recommend*Job`、`couponReconcileJob` 等任务在代码层真实存在，且明确区分 `@Scheduled` 与 `@XxlJob` 两类执行模型。`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:78` `my-xhs-payment/src/main/java/com/myxhs/payment/job/PaymentNotifyCompensateJob.java:70` `my-xhs-search/src/main/java/com/myxhs/search/job/IndexRebuildJob.java:79`
- `PaymentNotifyCompensateJob` / `RefundNotifyCompensateJob` 通过 Feign 状态回查 + Redis 计数控制重试上限，说明调度任务不只是 cron 触发器，而是完整恢复器。`my-xhs-payment/src/main/java/com/myxhs/payment/job/PaymentNotifyCompensateJob.java:128`
- `LocalMessageRetryJob` 和 `InventoryCompensationJob` 分别代表了“消息补发型”和“局部状态回退型”两类不同任务。`my-xhs-order/src/main/java/com/myxhs/order/job/LocalMessageRetryJob.java:24` `my-xhs-inventory/src/main/java/com/myxhs/inventory/job/InventoryCompensationJob.java:19`

L1 框架 / 语义证据：

- `@Scheduled` 更偏本地状态维持器，`@XxlJob` 更偏跨实例受控调度与运营可视化，这在 `my-xhs` 当前设计里是明确分工，而不是随手混用。
- 调度系统失败并不只表现为“恢复变慢”，而可能直接让最终一致性只剩单腿支撑。
- 补偿、对账、重建、刷新是四类不同任务语义：修断点、修漂移、修视图、修离线结果，不能混成一个“后台任务”概念。

L2 运行态证据：

- `docs/test-2/review-fresh/review-production-config.md` 已明确记录过 `P-D20`：代码 19 个任务只有约 8 个可调度，说明“有 handler ≠ 任务真在跑”。`docs/test-2/review-fresh/review-production-config.md:251`
- `docs/FINAL-HANDOFF.md` 已记录 payment 4 个 XXL-Job 未注册后被补建并验证 `handleCode=200`，说明调度配置问题曾真实影响支付补偿链。`docs/FINAL-HANDOFF.md:167`
- `docs/test-3/HANDOFF-TASK11.md` 已记录补偿三动作 MQ 投递、事件链 CREATED 落库等结果，说明任务系统在真实回归中不是装饰件。`docs/test-3/HANDOFF-TASK11.md:83`

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 `my-xhs` 的定时任务系统是最终一致性架构的重要执行层，但不能把它写成“所有任务都已长期稳定运行”。历史上 XXL-Job 错配就真实发生过，调度链本身也是故障面。

第二，当前可以明确写出 `@Scheduled` 与 `@XxlJob` 在项目里承担不同角色，但不能把这种区分写成绝对边界。随着后续架构演进，某些任务完全可能从进程内迁到调度中心，或反过来回收为本地任务。

第三，当前可以明确写出任务系统能显著缩小补偿与漂移问题，但不能把它写成“只要任务在跑，系统就一定最终一致”。坏消息语义错误、依赖长期故障、错误任务逻辑本身，都可能让任务反复跑也收不回来。

第四，当前可以明确写出任务状态和 trigger_status 是非常关键的运行态证据，但不能把它写成“只要调度台显示成功，业务结果就一定对”。推荐任务历史上就存在“XXL-Job 看到 success，实际产物未更新”的 review 结论，这说明任务成功和业务成功仍是两件事。`docs/review-1/02-findings/medium/F-041-recommend-jobs-report-success-after-inner-failure.md:16`

## 收网：这篇 Scheduled Task 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的定时任务不是“后台扫一遍数据”的附属逻辑，而是异步与最终一致性架构的最后执行层：它负责把没送出的消息继续送，把没回补的库存继续回，把没认账的支付结果继续推，把漂移的索引和未读状态重新对齐，把离线推荐与热池周期性刷新回正确轨道。

从业务逻辑视角看，它守住的是“主链结束后仍然会继续演化的那些状态”；从工程视角看，它把进程内调度、XXL-Job 调度中心、Redis 计数、补偿表、重建逻辑与手工触发织成了一张运营可见的执行平面；从分布式视角看，它承认异步系统会自然产生滞后、漂移和局部失败，因此必须有长期存在的扫描器与恢复器；从微服务视角看，它让恢复能力不再隐藏在单个服务内部，而是成为跨服务、可观测、可运维的一层系统能力。

更重要的是，本篇把一个特别容易被低估的事实钉住了：**在 `my-xhs` 里，很多最终一致性不是“靠事件自动完成”，而是“靠事件先留下痕迹，再靠任务系统不断把世界往正确状态推”。**

下一篇如果继续沿 `10-async-task-transaction/` 推进，这一组已经接近收口；更自然的转向，是进入 `11-runtime-failure-review/01-port-conflict.md`，把前面多次提到的运行时事故开始系统复盘。