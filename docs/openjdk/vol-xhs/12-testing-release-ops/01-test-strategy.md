# 01 Test Strategy：为什么这套测试不是“把接口跑一遍”而是一整套分层验证纪律

如果只看 `my-xhs` 最终留下来的大量回归记录，最容易产生的错觉就是：测试工作量大、用例多、文档细、环境复杂，所以“测试策略”这一章无非是把已有执行结果整理一下，说明团队很认真地测过了很多接口。

这恰恰会错过这套体系里最有价值的部分。因为 `my-xhs` 的测试不是简单的“接口跑一遍”，也不是普通意义上的冒烟 + 回归集合，而是一套被多轮真实事故倒逼出来的**分层验证纪律**：先区分自己当前到底能做 L0 静态核对、L1 框架语义还是 L2 运行态实测；再用 15 层验证把同一条业务用例从 HTTP 响应一路拉到 Redis、MySQL、MQ、Gateway、SkyWalking、ES、Prometheus；最后还要坚持逐用例执行、禁止批量、保留运行痕迹，并在清理数据后反复重跑。

这套纪律之所以必须单独成篇，不是因为它文档写得复杂，而是因为系统历史上已经多次证明：**只看 HTTP 200，甚至只看单服务日志，都足以让人对系统状态产生严重误判。** 一条请求在用户侧返回成功，不等于 Redis 状态对；Redis 对，也不等于 MySQL 对；MySQL 对，也不等于 MQ 真发了、消费者真消费了、ES 真同步了、SkyWalking 真串起来了、Prometheus 真有指标。也就是说，在 `my-xhs` 这种系统里，测试策略本身就是对“分布式假成功”最核心的一层防线。

所以本篇真正要回答的，不是“测了多少条用例”，而是：**为什么这套系统必须把验证深度做成层级化纪律；为什么要禁止批量 curl、坚持逐用例执行；为什么要同时保留 L0/L1/L2 三种结论口径；以及为什么 15 层验证虽然看起来笨重，却恰恰是把分布式系统真实跑懂的最有效方式。**

## 先给结论：`my-xhs` 的测试策略，核心不是用例数量，而是“验证深度必须和结论强度匹配”

先别急着看 15 层清单，先把本篇最重要的人话答案钉住：`my-xhs` 这套测试策略最核心的纪律，不是“多测一些”，而是**结论能说多满，取决于你到底做到了哪一层验证。**

这句话在项目里至少有三层含义。

第一，静态通过、语义核对、运行态实测必须分开说。`docs/test-3/REVIEW-METHODOLOGY.md` 已经把结论措辞写死了：只做了 L0，就只能说“静态通过，运行态未验证”；做到 L1，才能说“L0+L1 已核，L2 待实测”；只有 L2 完成，才允许说“实测通过”。`docs/test-3/REVIEW-METHODOLOGY.md:14`

第二，单条业务用例不是只测 API 结果，而是要拉出完整证据链。`HANDOFF.md` 里的 15 层验证标准已经说明，一条真正完整的验证会从 L1 API 响应一路覆盖到 L15 Prometheus 指标，中间还要经过 Redis、MySQL、应用日志、Nacos 注册、XXL-Job handler、MQ 消息链路、Sentinel、SkyWalking、Gateway 路由和 ES 日志采集。`docs/HANDOFF.md:147`

第三，测试动作本身也必须受纪律约束。Task10、Task11、Task12 等多轮 handoff 都在反复强调一件事：逐用例执行，禁止批量。因为批量执行会把链路叠在一起，让你分不清某次状态变化到底是哪个用例造成的。`docs/test-3/HANDOFF-TASK11.md:36`

把这三层放在一起看，`my-xhs` 的测试策略其实非常清晰：它不是单纯追求“更多测试”，而是在用验证层级约束结论口气、用 15 层证据链约束单条用例可信度、用逐用例执行约束分布式系统的可归因性。

## 直觉方案为什么不够：冒烟成功、接口全 200、批量执行快得多，这些在这里都不够

### 失败方案一：HTTP 200 / JSON body 对了，就算这条用例通过

这是最常见的测试错觉，也是分布式系统里最危险的一种偷懒。对单体服务来说，HTTP 200 确实往往说明很多问题已经过了；但对 `my-xhs` 这种 15+ 微服务 + Redis + MQ + ES + Gateway + SkyWalking 的系统来说，HTTP 200 最多只能证明“用户入口这一层暂时没炸”。

一条创建订单请求 200，不代表库存真的预扣了、优惠券真的核销了、本地消息表真的落了、下游 MQ 真的发出去了、消费者真的收到了；一条登录请求 200，也不代表 Token 黑名单、HMAC secret、Redis 键、Gateway 头注入、ES traceId 日志和 SkyWalking trace 都成立。也正因如此，`HANDOFF.md` 才把 L1 仅仅定义为“API 响应”，而不是“用例通过”。`docs/HANDOFF.md:151`

换句话说，在 `my-xhs` 的测试体系里，HTTP 200 只是 15 层里的第 1 层，不是全链路结论。

### 失败方案二：L0 / L1 做足了，L2 实测可以不做，反正框架语义已经看懂了

`docs/test-3/REVIEW-METHODOLOGY.md` 几乎就是在反驳这种思路。它的起因写得很直白：多轮静态 review 都称“没问题”，但对方真实环境实测暴露了 20+ 运行态问题。也就是说，**L0/L1 的正确，不足以替代 L2。**`docs/test-3/REVIEW-METHODOLOGY.md:3`

这是因为很多问题根本不是靠静态阅读能看出来的：镜像里有没有 curl/wget、某个 exporter 版本和中间件实际协议兼不兼容、SkyWalking 采样率单位到底是万分比还是百分比、Prometheus 配置改了是否热加载、Grafana provisioning 占位符是否自动替换、甚至某些日志链路是不是只是“看起来配置正确”。这些东西如果不落到运行态，就很容易出现一种表面正确的假安心感。

所以 `my-xhs` 的测试策略并不是“先静态、后看运气要不要实测”，而是从一开始就承认：**验证层级天然分高低，低层结论不能冒充高层结论。**

### 失败方案三：批量跑用例更快，只要最后状态差不多就行

这在普通 Web 接口回归里也许还能勉强成立，但在 `my-xhs` 这种系统里极其危险。Task10、Task11、Task12 的交接文档都在反复强调：逐用例执行，禁止批量。为什么？因为一旦批量执行，Redis 状态、MQ 投递、XXL-Job 扫描、ES 同步、Gateway 限流、对账任务等都会相互叠加，你就很难再说清楚某一层状态是由哪条用例触发的。`docs/test-3/HANDOFF-TASK10.md:33` `docs/test-3/HANDOFF-TASK11.md:36`

更糟的是，批量执行会放大分布式系统里最讨厌的“共享状态污染”：

- 某条消息可能被上一条用例的消费者消费掉
- 某个缓存键可能被另一条用例复用或覆盖
- 某个对账 / 重试任务刚好扫到了上轮残留状态
- 某个限流窗口把两条无关用例算到一起

所以“逐用例执行”在 `my-xhs` 里不是文档格式偏好，而是**让证据可归因**的必要前提。

## 先画总图：这套测试策略其实分成三层结论 + 15 层证据链

先把结构用文字图立住：

```text
结论层级
  L0 静态自洽
    -> 文件存在 / 配置引用 / 语法 / 路径挂载
  L1 框架语义
    -> 单位 / 框架解释 / 版本兼容 / 解析行为
  L2 运行态实测
    -> 真服务拉起 / 真请求执行 / 真指标出数 / 真故障演练

单用例证据链（15 层）
  L1  API 响应
  L2  ACCESS 日志
  L3  Redis
  L4  MySQL
  L5  应用日志
  L6  Nacos 注册
  L7  XXL-Job Handler
  L8  MQ 消息链路
  L9  @RateLimit
  L10 Sentinel
  L11 SkyWalking trace
  L12 Gateway 路由
  L13 Actuator 健康检查
  L14 ES 日志采集
  L15 Prometheus 指标
```

这张图里最关键的，不是层多，而是每层都在防一种典型假成功。

- L0 防“文件都没挂上，但文档还说没问题”
- L1 防“配置写着像对，实际框架根本不是这么解释的”
- L2 防“推理正确，但真实系统压根没按你想的在跑”

而 15 层则是在单条业务用例内部，把“用户入口成功”和“整个链路真的收口”区分开。也就是说，结论层级和单用例层级是两张正交坐标系，不是重复清单。

## 三层验证法为什么是这套测试体系的第一原则

`docs/test-3/REVIEW-METHODOLOGY.md` 已经把三层验证法写成了明确方法论：

- L0：静态自洽
- L1：框架语义
- L2：运行态实测

更重要的是，它把结论措辞也一起绑定了。你没做 L2，就不允许说“没问题”或“可部署”；只能说“L0+L1 通过，L2 待实测”或“静态通过，运行态未验证”。`docs/test-3/REVIEW-METHODOLOGY.md:14`

这条规则在 `my-xhs` 里的价值极高，因为系统的复杂度早就超过了“看配置像没问题”这个层次。像 SkyWalking 的 `SW_TRACE_SAMPLE_RATE` 单位、Boot 3.x `http_server_requests_seconds` 默认无 bucket、Grafana provisioning 占位符不自动替换、Prometheus 规则不热加载，这些都属于典型的“L1 不核就会说错、L2 不做就会说满”的问题。`docs/test-3/REVIEW-METHODOLOGY.md:31`

所以三层验证法的真正作用，不只是帮人组织流程，而是在强行遏制一种很常见的分布式测试幻觉：**你以为自己是在给系统下结论，实际上你只是完成了阅读。**

## 15 层验证为什么不是过度设计：它在对抗分布式系统的“局部成功”错觉

从表面看，15 层验证很容易显得笨重：一条用例不就该看结果对不对吗，为什么要拉到 Redis、MySQL、MQ、Nacos、SkyWalking、Prometheus 这么多层？

真正理解它的关键，在于知道它在对抗什么。它在对抗的，是分布式系统最典型的一种错觉：**局部成功被误当成整体成功。**

举几个很典型的例子：

- 下单接口返回 200，但 MQ 没发出去，这时只有 L1 通过，L8 不通过；
- Gateway 鉴权通过、业务也 200，但 ES 里没有 traceId，这时 L1/L2 通过，L14 不通过；
- 用户主页聚合返回正常，但 total 是 String 被错误处理成 0，这时只看 HTTP 可能没意识到语义错；需要至少打到 L4 / L5；
- Canal 服务进程在跑，但索引 10 秒后仍不更新，这时得走到 L8 / L14 / L15 甚至观测中间件。

也就是说，15 层并不是为了追求“看起来严格”，而是为了让“成功”这个词在分布式系统里有足够厚度。`docs/HANDOFF.md:147`

## 为什么逐用例执行、禁止批量，是这套策略里最像“笨办法”的聪明设计

多轮 handoff 一直在重复一句话：逐用例执行，禁止批量。这个纪律很像是在牺牲效率，但其实是在换取可归因性。`docs/test-3/HANDOFF-TASK11.md:36`

`my-xhs` 的运行态有大量共享状态：

- Redis 键和 TTL
- MQ topic / consumer lag
- XXL-Job 扫描窗口
- ES 索引延迟
- 限流窗口
- 事务消息与补发队列

如果你把多条用例批量压在一起跑，后面再去看 Redis / MySQL / MQ / ES，就很难还原“到底是谁改了它”。尤其在补偿任务、对账任务、增量索引同步、通知聚合这种异步系统里，状态本来就有时间窗口；一旦再把多条用例叠在一起，归因几乎会完全丢失。

这就是为什么 `my-xhs` 把“禁止批量”写成纪律，而不是建议。它不是为了慢，而是为了让每一条 L2 / L3 / L8 / L14 证据都还能追溯到单个动作。

## 真实回归规模为什么值得写进策略篇：这套方法不是小样本试玩，而是 297 用例全绿跑出来的

如果方法论只是纸上谈兵，它就很容易显得教条。但 `my-xhs` 这里有一个特别强的地方：这套策略已经在大规模真实回归里被跑过，而且留下了明确结果。

`FINAL-HANDOFF.md` 记录了一轮 `147/147` 的 Gateway + JWT + HMAC + 各模块补测全通过。`docs/FINAL-HANDOFF.md:257`

更进一步，`HANDOFF-TASK11.md` 又把范围推到 `G1~G8` 八组，总计 `297/297` 用例全绿，并且明确强调这是“逐用例执行，禁止批量”的结果。`docs/test-3/HANDOFF-TASK11.md:3`

这条数据很重要，因为它说明 15 层验证和三层验证法并不是少数关键用例上的重炮，而是真正被团队拿来支撑大规模系统级回归的一套方法。它不是“审查时偶尔用一下的 checklist”，而是已经证明可以落地的大生产式回归方式。

## 手工验证文档为什么同样重要：这套策略不是只给 AI 或脚本用的

`docs/test-3/MANUAL-VERIFY.md` 提供了另一个很关键的补充：这套测试策略并不是只面向脚本、只面向 AI、只面向开发者。它同样被翻译成了“打开 → 输入 → 看到什么”的人工操作手册，直接告诉使用者如何在 SkyWalking、Kibana、Grafana、RocketMQ、XXL-Job、Nacos、Sentinel 这些平台上看见对应证据。`docs/test-3/MANUAL-VERIFY.md:1`

这说明一个很重要的设计点：**测试策略在 `my-xhs` 里不仅是执行流程，也是交接语言。** 同一条用例，既可以有 curl / testlib / 程序化验证，也可以有面向人工的控制台核对步骤。这样做的价值在于，它让“测试通过”不再只掌握在脚本执行者手里，而是可被多人复核、可被交接、可被现场演示。

这也进一步说明，测试策略不是附录，而是系统理解方式的一部分。

## 基于当前 compose 的远程 L2 实测清单

前面已经讲过，`docker-compose.yml` 只能证明“部署描述”和“预期拓扑”，不能单独替代 L2 运行态结论。但它足够告诉我们：如果现在要把 `12-testing-release-ops/` 这一组里最薄弱的远程平台证据补齐，应该按什么顺序、看什么接口、期望看到什么结果。

下面这份清单的目标，不是新增一套方法论，而是把三层验证法落到当前最需要补证的远程平台项上。也就是说：**先承认 compose 只能给出 L0/L1，再据此推导出最小可执行的远程 L2 验证动作。**

### 1. Prometheus（采集层）

当前静态事实：

- compose 中 Prometheus 监听 `19090`，healthcheck 走 `/-/healthy`，见 `my-xhs/config/docker-compose.yml:842` 到 `:867`
- `prometheus.yml` 已明确接入 15 个微服务、SkyWalking OAP、Redis/ES/MySQL exporter、Canal、Node exporter，并配置了 `alerting` 与 `remote_write`，见 `my-xhs/config/prometheus/prometheus.yml:9` 到 `:135`

远程 L2 最小验证动作：

1. `http://21.130.247.89:19090/-/healthy` 返回 200
2. `http://21.130.247.89:19090/api/v1/targets` 中 `my-xhs-services` 为 `15/15 UP`
3. `up{job="my-xhs-services"}`、`up{job="redis"}`、`up{job="mysql"}`、`up{job="canal"}` 等关键 job 都有数据
4. `http://21.130.247.89:19090/api/v1/rules` 能看到 `alert_rules/*.yml` 已加载

只有做到这一步，才能把“Prometheus 已在线采集”写成现时 L2 结论；否则只能停留在“compose 和配置已声明采集目标”。

### 2. Grafana（展示层）

当前静态事实：

- compose 中 Grafana 监听 `13000`，healthcheck 走 `/api/health`，见 `my-xhs/config/docker-compose.yml:873` 到 `:901`
- provisioning 已挂载 datasource 和 dashboards 目录，说明“看板骨架”已随包，见 `my-xhs/config/docker-compose.yml:887` 到 `:890`

远程 L2 最小验证动作：

1. `http://21.130.247.89:13000/api/health` 返回 `{"database":"ok"...}`
2. 登录后能看到预置 datasource 正常连到 Prometheus
3. 至少核一张依赖真实指标的核心面板：如 Gateway P99、订单/支付业务指标、Node exporter 主机面板
4. 确认看板不是“空 dashboard 骨架”，而是真的有 series 在出数

这一步不做，就不能把“Grafana 已可视化监控可用”写成 L2，只能说“dashboard provisioning 已随包”。

### 3. Alertmanager（通知出口）

当前静态事实：

- compose 中 Alertmanager 监听 `19093`，healthcheck 走 `/-/ready`，见 `my-xhs/config/docker-compose.yml:822` 到 `:841`
- `prometheus.yml` 已把 `127.0.0.1:19093` 写进 `alerting.alertmanagers`，见 `my-xhs/config/prometheus/prometheus.yml:9` 到 `:13`
- `alertmanager.yml` 的 receiver 仍是 `http://127.0.0.1:19000/api/alert/hook` 占位地址，见 `my-xhs/config/alertmanager/alertmanager.yml:14` 到 `:18`

远程 L2 最小验证动作：

1. `http://21.130.247.89:19093/-/ready` 返回 200
2. 在 Alertmanager UI/API 中能看到 Prometheus 已接入的 alerts
3. 触发一条可控测试规则，确认它从 Prometheus 进入 Alertmanager
4. 保持“默认 webhook 仍是占位骨架”的边界说明，不再推进真实外部通知渠道验证

这里最重要的不是把通知真正发出去，而是明确区分：当前可以验证 Alertmanager 在线与规则链已接入，但外部告警渠道刻意不纳入本轮范围。

### 4. SkyWalking（链路追踪层）

当前静态事实：

- compose 中 OAP 监听 `12800`（healthcheck）和 `1234`（Prometheus telemetry），UI 监听 `8080`，见 `my-xhs/config/docker-compose.yml:600` 到 `:649`
- OAP 存储写到 `127.0.0.1:19201`，并明确配置了 `SW_TRACE_SAMPLE_RATE=1000`，见 `my-xhs/config/docker-compose.yml:600` 到 `:609`

远程 L2 最小验证动作：

1. `http://21.130.247.89:8080/` 可打开 UI
2. `http://21.130.247.89:1234/metrics` 能抓到 OAP telemetry
3. 随机打一条真实业务请求，确认 Gateway → 下游服务链路可以在 UI 中串起来
4. 至少验证一条 trace 能和日志/业务 traceId 对上，而不是只有 UI 页面能打开

否则最多只能说“SkyWalking 部署描述和健康探针已在包中”，不能说“链路追踪当前在线可用”。

### 5. Nacos（配置与发现层）

当前静态事实：

- compose 与全卷多处配置都把 Nacos 固定为 `18848`
- `prometheus.yml` 里 15 个微服务的 scrape 目标也假定服务机 `21.214.97.212:19000~19016` 已由 Nacos + 启动脚本收敛到稳定状态，见 `my-xhs/config/prometheus/prometheus.yml:27` 到 `:91`

远程 L2 最小验证动作：

1. Nacos UI/API 可访问
2. `my-xhs` 命名空间存在且 15 个核心服务实例都已注册
3. `my-xhs-common.yaml`、`my-xhs-gateway.yaml` 等关键配置存在且版本正确
4. 随机抽一个依赖配置中心的服务，确认它不是只靠本地 fallback 在跑

只有这样，才能把“配置中心和服务发现在线收敛”写成 L2，而不只是 L0/L1。

### 6. RocketMQ（异步链与诊断层）

当前静态事实：

- compose 中 NameServer/Broker/Dashboard 端口已固定为 `9876/11911/18081`
- 多篇正文已证明大量业务链依赖 `ORDER_TRANSACTION_TOPIC`、`NOTIFICATION_TOPIC`、索引同步 Topic 和 DLQ 重投

远程 L2 最小验证动作：

1. NameServer、Broker、Dashboard 都可访问
2. 关键 Topic / ConsumerGroup 存在且可查询积压
3. 至少验证一条典型业务消息链：如本地消息补发、通知事件消费、索引同步消费
4. 如果要支撑 DLQ/坏消息结论，还需能查询 `%DLQ%...`、`ORIGIN_MESSAGE_ID`、`RETRY_TOPIC`

也就是说，RocketMQ 的 L2 不能只看端口开没开，还得看业务链是否真的在流动。

### 7. Redis Sentinel（会话/路由/高可用层）

当前静态事实：

- compose 明确 Redis master/slave/Sentinel 端口为 `6379/6380/26379`
- 业务文档又同时存在 `16379/16380/16381` 的对外交付口径
- 当前多个关键链路都依赖它：JWT 黑名单、HMAC Secret、IM 在线路由、SSE ticket、未读计数、热搜窗口

远程 L2 最小验证动作：

1. Sentinel 能返回 `get-master-addr-by-name mymaster`
2. 远程微服务实际能连到 Sentinel 广播出的主节点地址
3. 至少抽查一条高价值状态链：如 JWT 黑名单、生效中的 SSE/IM route key、搜索热搜分钟桶
4. 如果要支撑“高可用正常”，还要确认不是只读到旧主地址或 `127.0.0.1` 这类错误广播

这一步不做，就不能把“Redis 高可用链可用”写满，只能说“代码采用 Sentinel-first，compose 也部署了 Sentinel”。

## 这份清单真正补的是什么

## 本轮远程 L2 探测结果

在 `2026-08-20` 的本轮探测中，分别从当前环境访问中间件机 `21.130.247.89` 和服务机 `21.214.97.212`，得到了一组可以写入正文的现时证据：

- 中间件机的 `18848`、`26379`、`6379`、`6380`、`9876`、`11911`、`18081`、`19200`、`19201`、`19090`、`13000`、`19093`、`8080`、`1234`、`8428`、`9151`、`9114`、`9104`、`9105`、`9100`、`11112`、`18080`、`15601`、`15044`、`15045` TCP 端口均可达。
- 服务机的业务端口 `19000~19004`、`19008~19016` 均可达；抽查 `gateway:19000`、`analytics:19003`、`coupon:19010`、`search:19016` 的 `/actuator/health` 均返回 `200` 且 `status=UP`。
- Prometheus `/-/healthy` 返回 `200`；`/api/v1/targets` 返回 `23` 个 active targets，当前 `23` 个为 `up`；`/api/v1/rules` 返回 `6` 个 rule groups、共 `28` 条规则；`up` 查询也返回 `23` 条结果。
- Grafana `/api/health` 返回 `200` 且数据库状态为 `ok`；Alertmanager `/-/ready` 返回 `200`，API 状态为 `ready`，版本为 `0.27.0`。
- SkyWalking `1234/metrics` 返回 `200` 且有指标内容；`8080` UI 返回 `200`。`12800/healthCheck` 返回 `404`，但 compose 对 OAP 使用的是 `12800` TCP 监听探针，因此这一条 HTTP 路径 404 只能说明路径不存在，不能单独判定 OAP 不可用。
- Nacos `/nacos/` 返回 `200`，服务列表 API 返回 `count=15`；Redis Sentinel 的 `PING` 返回 `PONG`，`get-master-addr-by-name mymaster` 返回 `21.130.247.89:6379`。
- RocketMQ Dashboard `18081`、XXL-Job `18080`、Kibana `15601` 及 Canal/exporter metrics 端点均返回 `200`。

这组结果把部分平台结论从“部署描述”升级成了当前远程 L2 事实；但它仍然没有证明真实业务告警已经抵达外部通知渠道、SkyWalking UI 中已有一条新业务 trace，或 RocketMQ 的每条业务 Topic 当前都在持续消费。后续结论仍需保持按证据粒度分层。 

这份清单不是新增一个附录，而是在给 `12-testing-release-ops/` 这一组补一条很关键的执行纪律：

- `docker-compose.yml` 负责给出部署拓扑与健康探针（L0/L1）
- 远程平台探测负责把“在线、可用、在出数、在发告警、在流动”补成 L2

也就是说，对 Prometheus / Grafana / Alertmanager / SkyWalking / Nacos / RocketMQ / Redis Sentinel 这些平台来说，**能部署** 和 **当前在线可用** 之间，必须用一份可执行清单明确隔开。

## 真实问题为什么倒逼出了这套策略：因为太多“看起来没问题”的结论曾经在运行态上翻车

这一点其实是整篇最关键的背景。`REVIEW-METHODOLOGY.md` 开头已经说得非常坦白：这套三层验证法之所以沉淀出来，是因为多轮静态 review 一直说“没问题”，但真实环境一跑就爆出了 20+ 运行态问题。`docs/test-3/REVIEW-METHODOLOGY.md:3`

换句话说，`my-xhs` 的测试策略并不是某个完美主义团队事先设计出来的繁琐流程，而是一次次被真实事故打脸后，倒逼出来的结论：

- 只看配置不够
- 只看 HTTP 不够
- 只看日志不够
- 只看平台页面也不够
- 只有把验证层级和证据层级绑起来，才能让结论有分量

这就是为什么这篇不能只是列流程，而必须把“为什么必须这么测”写出来。因为这套策略背后不是抽象规范，而是失败史。

## 证据清单：本篇关键结论分别站在哪一层

L0 / L1 方法论与静态证据：

- `docs/test-3/REVIEW-METHODOLOGY.md` 已明确规定三层验证法（L0/L1/L2）和对应结论措辞，禁止直接说“没问题”。`docs/test-3/REVIEW-METHODOLOGY.md:6`
- `docs/HANDOFF.md` 已把 15 层验证标准明确成项目级测试标准。`docs/HANDOFF.md:147`
- 多份 handoff 文档都反复把“逐用例执行，禁止批量”写成纪律。`docs/test-3/HANDOFF-TASK11.md:36`

L2 运行态与回归结果证据：

- `FINAL-HANDOFF.md` 已记录 `147/147` 总体验证通过。`docs/FINAL-HANDOFF.md:257`
- `HANDOFF-TASK11.md` 已记录 `G1~G8 = 297/297` 全绿，并明确说明逐用例执行。`docs/test-3/HANDOFF-TASK11.md:3`
- `MANUAL-VERIFY.md` 证明这套策略不仅能程序化执行，也能被人工控制台复核。`docs/test-3/MANUAL-VERIFY.md:1`

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 `my-xhs` 已经沉淀出三层验证法与 15 层用例验证标准，但不能把它写成“所有测试活动都已严格覆盖到每一层”。现实里仍然存在只做到 L0/L1、尚待 L2 的项。

第二，当前可以明确写出 297/297、147/147 这类大规模回归结果，但不能把它们写成“系统未来任何改动都已被完全证明安全”。这些结果只对当时的环境、数据基线和修复版本成立。

第三，当前可以明确写出逐用例执行是核心纪律，但不能把它写成“批量执行在任何场景都毫无价值”。更准确的说法是：对 `my-xhs` 这类共享状态重、异步链多的系统，关键回归必须以逐用例执行为主，批量只能做补充而不能替代。

第四，当前可以明确写出人工验证手册与自动化回归并存，但不能把它写成“人工验证已经替代自动化”或反之。两者在这套系统里是互补关系：一个强在可复核与交接，一个强在规模化执行。

## 收网：这篇 Test Strategy 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的测试策略不是“用例很多、文档很多”的劳动密集型工程，而是一套把分布式系统结论强度和验证深度牢牢绑在一起的纪律体系：L0/L1/L2 负责约束你能说多满，15 层验证负责约束单条用例到底有没有把分布式链路真正走通，逐用例执行负责约束证据是否还能被归因，人工验证手册则负责把这些结果变成可交接、可复核、可演示的操作语言。

从业务逻辑视角看，它守住的是“成功”这个词不能只停留在 HTTP 返回；从工程视角看，它把 API、日志、Redis、MySQL、MQ、Gateway、SkyWalking、ES、Prometheus 织成了一张统一的验证图；从分布式视角看，它承认共享状态、异步链和补偿系统会天然制造局部成功错觉，因此必须层层拆穿；从微服务视角看，它让测试不再只是模块自证，而是系统级证据收集。

更重要的是，本篇把一个特别容易被低估的事实钉住了：**在 `my-xhs` 里，测试策略真正防的不是“有 bug 没发现”，而是“分布式系统看起来成功、其实只是某一层暂时没暴露出失败”。**

如果继续往 `12-testing-release-ops/` 推进，下一篇最自然就是 `docs/openjdk/vol-xhs/12-testing-release-ops/02-startup-script.md`，把前面多次出现的 `restart-service.sh`、`start-all.sh`、参数传递、PID/health 判定与交付脚本风险统一收束。