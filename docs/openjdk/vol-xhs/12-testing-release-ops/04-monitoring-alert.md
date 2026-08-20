# 04 Monitoring Alert：为什么“指标有了”不等于“告警闭环了”

到 `12-testing-release-ops/` 的最后一篇，读者很容易把可观测性收束成一个熟悉的工具清单：Prometheus 抓指标，Grafana 画大盘，Alertmanager 发告警，系统就算具备监控能力了。

如果只停在这一步，`my-xhs` 的监控告警篇就会写得非常虚。因为监控真正需要回答的不是“有没有 Prometheus”，而是更贴近运维现场的一句：**当订单失败率、支付回调失败、MQ 死信、Redis 内存、MySQL 复制、ES 集群或某个服务下线时，系统能不能从采集到规则、从规则到通知、从通知到人工处置，完整地把异常推到人面前。**

`my-xhs` 的历史材料已经说明，这条链的每一段都可能独立失效。早期 Prometheus 规则引用了不存在的指标名，导致告警永远不触发；VictoriaMetrics 容器虽然在跑，但 Prometheus 没有 `remote_write`，长期存储实际上是空的；Prometheus 没有 Alertmanager，告警即使触发也没有通知出口；Gateway 指标没有 `application` 标签，入口流量在 `$application` 看板里消失；业务指标惰性注册，没发生事件时看板甚至没有 series。也就是说，监控告警不是“配置一套工具”，而是**指标命名、采集目标、存储链、规则表达式、通知出口和业务处置语义的联合系统。**

所以本篇真正要回答的，不是“Grafana 有几个 dashboard”，而是：**监控告警闭环为什么必须拆成采集、存储、规则、通知、处置五层；为什么一个错误指标名会让告警沉默；为什么 Alertmanager 是告警链的必要出口；以及为什么‘Prometheus targets 全 UP’仍然不能直接等价于‘业务监控有效’。**

## 先给结论：监控告警的核心不是指标数量，而是“异常能不能被正确采集、正确判断、正确送达”

先别急着看配置，先把本篇最重要的人话答案钉住：`my-xhs` 的监控告警闭环，不是“有多少指标、多少看板”，而是五层链路都要对得上。

第一层是采集：Prometheus 能不能抓到服务和中间件的 `/actuator/prometheus`、exporter 或 Canal endpoint。第二层是存储：Prometheus 当前窗口有数据，VictoriaMetrics 是否通过 `remote_write` 接住长期历史。第三层是规则：PromQL 引用的指标名、标签、阈值和业务埋点是否真实存在。第四层是通知：Alertmanager 是否在线、路由和 receiver 是否配置到真实渠道。第五层是处置：告警到人之后，是否知道应该查哪条日志、哪张表、哪个 MQ consumer group 或哪个补偿任务。

任何一层断掉，都会制造一种假闭环：

- targets 全部 UP，但规则引用错指标，异常永远不告警；
- 规则已经 firing，但 Alertmanager 没有真实 receiver，没人收到；
- Grafana 能看到曲线，但 Prometheus 重启后长期历史消失；
- 指标出数，但缺 `application` / `status` / `consumerGroup` 标签，无法按服务或结果定位；
- 告警到了人，但没有对应的业务排障路径，只能重新 grep 全库日志。

所以 `my-xhs` 的监控设计真正要追求的不是“看板漂亮”，而是**指标、规则、告警和排障路径之间的可解释映射**。

## 直觉方案为什么不够：targets UP、看板能打开、规则文件存在，都不能证明告警有效

### 失败方案一：Prometheus targets 全是 UP，就说明监控正常

这是最容易被接受的假结论。Prometheus 的 `/api/v1/targets` 显示服务都 UP，说明抓取链路至少通了；于是大家很自然地认为指标和告警也都正常。

但 `my-xhs` 的历史配置 review 已经证明，采集正常和告警有效是两件事。早期规则里曾使用 `myxhs_order_create_total`、`myxhs_payment_total` 等不存在的指标名，而代码实际暴露的是 `orders_created_total`、`payment_callback_total`。结果就是 Prometheus 可以正常抓服务，Grafana 也可以正常打开，但这些规则永远不会按预期触发。`docs/test-2/review-fresh/review-production-config.md:64`

这类故障特别危险，因为它不会表现为 Prometheus Down，而是表现为“系统很安静”。监控平台越安静，团队越容易误以为业务也很健康。

### 失败方案二：PromQL 规则文件挂载进去了，告警就会自动生效

规则文件存在、Prometheus 配置里有 `rule_files`，只能证明规则具备被加载的前提，不等于规则已成功解析、引用的指标有数据、标签匹配正确，更不等于 Alertmanager 能收到告警。

`prometheus.yml` 当前确实把 `alert_rules/*.yml` 纳入 `rule_files`，并且通过 `alerting.alertmanagers` 指向 `127.0.0.1:19093`。但这仍然需要后续验证：规则是否能被 Prometheus 接受、表达式是否命中实际 series、Alertmanager 是否返回 ready、receiver 是否指向真实通知渠道。`my-xhs/config/prometheus/prometheus.yml:9`

所以配置文件挂载只是 L0 证据，规则加载与 firing 是 L1/L2 证据，不能混成一句“告警已配置”。

### 失败方案三：Alertmanager 容器在跑，就说明告警已经能通知到人

`config/alertmanager/alertmanager.yml` 当前使用的是 `default-webhook`，地址是 `http://127.0.0.1:19000/api/alert/hook`，并且注释明确写着这是占位地址，需要部署后按真实渠道替换。`my-xhs/config/alertmanager/alertmanager.yml:14`

这意味着 Alertmanager 当前更多是“通知出口骨架”，不是已完成的真实外部通知渠道。容器健康、端口监听、Prometheus 能连接 Alertmanager，都不能替代“企业微信 / 钉钉 / 邮件 webhook 实际收到通知”的 L2 验证。

这也是 P-D13 的真实背景：Prometheus 没有 Alertmanager 时，告警根本没有出口；后来虽然把 Alertmanager 容器和配置放进部署包，但 receiver 仍需要部署方按真实环境替换。`docs/test-2/HANDOFF-TASK4.md:63`

## 先画总图：`my-xhs` 的监控告警闭环分成哪五层

先把整条链用文字图立住：

```text
业务 / 基础设施事件
  -> Micrometer / Actuator / Exporter / Canal metrics
  -> Prometheus scrape
       15 微服务 + Redis/ES/MySQL/Canal/Node/OAP targets
  -> Prometheus rule_files
       业务失败率 / 支付回调 / DLQ / Redis / MySQL / ES / 服务 UP
  -> Alertmanager :19093
       group_by alertname, service
       group_wait / group_interval / repeat_interval
  -> Webhook / 企业微信 / 钉钉 / 邮件（部署后配置）
  -> 人工排障路径
       日志 traceId / MQ consumer group / DB / Redis / ES / Job log
```

这张图里最关键的，不是工具名字，而是每一层都必须把上层语义准确传给下一层。

- 业务代码的 `orders.created.total` 要正确变成 Prometheus 的 `orders_created_total`。
- 规则要使用真实存在的指标名与标签。
- Alertmanager 要收到 firing 状态并按服务分组。
- receiver 要是实际可访问的通知渠道，而不是占位地址。
- 收到告警的人要知道下一步去查什么。

只要其中一个映射断掉，链路就会变成“看起来配置完整、实际上没有告警”。

## 采集层：Prometheus 配置为什么不是一组 targets，而是一张服务与中间件证据地图

当前 `prometheus.yml` 把采集目标分成几组：

- `my-xhs-services`：15 个微服务的 `/actuator/prometheus`
- Prometheus 自身
- SkyWalking OAP telemetry
- Redis exporter
- Elasticsearch exporter
- MySQL master / slave exporter
- Canal `11112/metrics`
- Node exporter

`my-xhs/config/prometheus/prometheus.yml:25`

这张地图的价值不只是“监控更多组件”，而是把故障定位从应用单点扩成了系统证据链。比如：

- Gateway 5xx 上升，可以先看服务 target 是否 UP；
- MySQL 查询慢，可以对照 MySQL exporter / slave 状态；
- Redis 连接失败，可以对照 Redis exporter 和 Sentinel 主节点；
- 索引滞后，可以对照 Canal delay、MQ backlog 和 search consumer；
- 主机资源异常，可以对照 Node exporter。

但这层也有一个方法论边界：配置写了 target 只是静态事实，不代表当前采集真的成功。历史材料里才有真正的 L2 证据：`up{job="my-xhs-services"}=15/15`，总 targets 16 个。`docs/test-3/review-production-config.md:735`

因此正文里应该明确区分“配置了采集目标”和“目标当前实测 UP”。

## 规则层：指标名与标签对齐为什么是告警系统的第一性问题

### 业务指标不是写出来就能被规则使用

`BusinessMetrics` 里定义了 `orders.created.total`、`payment.callback.total`、`myxhs.mq.dlq.total` 等业务指标，并且通过标签区分状态、consumerGroup、topic 等维度。Prometheus 经过 Micrometer 命名转换后，规则中要引用的是 `orders_created_total`、`payment_callback_total` 等名字。`my-xhs/my-xhs-common/src/main/java/com/myxhs/common/metrics/BusinessMetrics.java:38`

历史 P-D4 的根因就是规则名与实际指标名不一致，导致规则永静默。修复动作包括把订单和支付规则名改成实际 Prometheus 名称，并隔离暂时没有 exporter 支撑的中间件规则，避免规则配置看起来完整却永远不可能触发。`docs/test-2/FIX-PLAN-PRODUCTION-CONFIG.md:30`

这说明告警规则审查不能只检查 YAML 语法，还要做三方对照：

1. 代码是否真正埋点；
2. Prometheus 是否能查到对应 series；
3. 规则表达式和标签是否与实际 series 匹配。

`review-production-config.md` 已经把这种方法明确写成“采集 / 规则 / 埋点三方对齐验证”。`docs/test-3/review-production-config.md:729`

### 惰性注册为什么会让“没有指标”不等于“系统坏了”

历史 P-D42 又揭示了一个相反方向的问题：`payment_callback_total`、`myxhs_mq_dlq_total` 在没有发生对应事件时可能没有 series。这不是采集失败，而是 Micrometer Counter 惰性注册：第一次 `increment` 之前，指标还不存在。`docs/test-3/review-production-config.md:736`

这会让告警和看板出现“空白”，而不是 0。处理方式是预注册关键指标，让系统启动后即使还没有事件也能看到 series。后续材料记录了 `BusinessMetrics.preRegister()` 的修复与重启生效。`docs/test-3/review-production-config.md:755`

所以“没有 series”也必须有语义判断：可能是业务事件确实没发生，也可能是指标只在第一次事件时惰性创建，不能一概当作服务故障。

## 存储层：VictoriaMetrics 为什么要接上 `remote_write`，以及它不接时会发生什么

Prometheus 默认保留窗口适合近期查询，但 `my-xhs` 还部署了 VictoriaMetrics，目标是承接更长期的历史数据。`prometheus.yml` 当前通过 `remote_write` 把样本送到 `127.0.0.1:8428/api/v1/write`；compose 里 VictoriaMetrics 的 retention 是 30 天。`my-xhs/config/prometheus/prometheus.yml:15` `my-xhs/config/docker-compose.yml:655`

这条链之所以必须单独讲，是因为历史上 VictoriaMetrics 容器虽然在跑，但 Prometheus 没有 `remote_write`，VM 的 totalSeries=0。结果不是“监控全挂”，而是近期 Prometheus 还能看，长期趋势和重启后的历史全部丢失。`docs/test-2/review-fresh/review-production-config.md:92`

这说明存储层也是监控闭环的一部分：Prometheus 当前可查询不等于长期观测已经建立。

## Alertmanager：告警出口有了，但真实通知渠道仍是部署后语义

当前 compose 已新增 Alertmanager `19093`，Prometheus `alerting` 段也已经指向它，说明告警从 Prometheus 到 Alertmanager 的骨架已经接上。`my-xhs/config/docker-compose.yml:817` `my-xhs/config/prometheus/prometheus.yml:9`

但 `alertmanager.yml` 的 receiver 仍然是 `127.0.0.1:19000/api/alert/hook` 占位地址。这个配置能表达“Alertmanager 要把告警送到哪里”的结构，却不能证明生产通知渠道已经可用；就当前这轮代码核对，我也没有直接在仓库里找到与该路径一一对应的通知 handler。因此更稳妥的口径只能是：部署后要么替换为真实 webhook / 邮件配置，要么先补齐与该占位地址匹配的接收端，再实测 firing / resolved 两种通知都能到达。

这正是三层验证法在告警领域的具体落点：配置存在是 L0，Alertmanager 能解析是 L1，真实告警到达通知端是 L2。

## 真实故障案例：规则名错误导致告警永远沉默，targets 却可以全部 UP

按照本卷方法论，本篇必须有真实故障案例。最适合的主案例是 P-D4：Prometheus 采集链看起来正常，但告警规则引用不存在的指标名，导致监控系统“有数据却不报警”。

历史材料已经把根因写得很清楚：规则引用 `myxhs_order_create_total`、`myxhs_payment_total` 等不存在名称，而代码真实指标是 `orders_created_total`、`payment_callback_total`；另外若干规则还依赖未部署的 exporter。结果是告警文件可能成功加载，Prometheus target 也可能 UP，但业务异常永远不会触发规则。`docs/test-2/FIX-PLAN-PRODUCTION-CONFIG.md:30`

用方法论五段式收它：

- 现象：服务和 Prometheus targets 看起来正常，但业务异常没有告警
- 根因：规则指标名 / 标签与代码实际埋点不一致，部分中间件规则还没有 exporter 支撑
- 修复：对齐实际 Prometheus 指标名，隔离没有数据源支撑的规则，并补 exporter / 业务预注册
- 验证：历史 review 已实测 `orders_created_total`、`payment_callback_total`、`myxhs_mq_dlq_total` 有数据，规则能对齐；Gateway 指标与 P99 也已出数
- 余波：告警系统必须持续做“代码埋点 → Prometheus series → 规则表达式 → firing”四段核对，不能只看 YAML 语法

这个案例特别适合作为监控篇的主案例，因为它说明最危险的监控故障是“没有任何红色告警”。

## 证据清单：本篇关键结论分别站在哪一层

L0 / L1 静态与语义证据：

- `prometheus.yml` 明确配置了 15 微服务、Prometheus、中间件 exporter、Canal、Node、OAP 等 scrape job，并设置 `rule_files`、`alerting`、`remote_write`。`my-xhs/config/prometheus/prometheus.yml:9`
- `BusinessMetrics` 定义了订单、支付回调、MQ DLQ 等业务指标与标签。`my-xhs/my-xhs-common/src/main/java/com/myxhs/common/metrics/BusinessMetrics.java:38`
- Alertmanager compose / config 已存在，但默认 receiver 是占位 webhook，真实通知渠道仍需部署后配置。`my-xhs/config/alertmanager/alertmanager.yml:1`
- compose 明确 Prometheus `19090`、Alertmanager `19093`、Grafana `13000`，并挂载规则和 dashboard 配置。`my-xhs/config/docker-compose.yml:817`

L2 运行态证据：

- 历史实测 `up{job="my-xhs-services"}=15/15`，说明服务采集链曾经真实可用。`docs/test-3/review-production-config.md:735`
- 本轮 `2026-08-20` 远程探测中，中间件机 Prometheus `/-/healthy` 返回 `200`，当前 `/api/v1/targets` 为 `23/23 up`，`/api/v1/rules` 返回 `6` 个 rule groups、`28` 条规则；这把 Prometheus 当前在线与采集/规则加载结论提升为现时 L2，但仍不等于每条业务告警都已 firing。
- 本轮远程探测中 Grafana `/api/health` 返回 `200` 且数据库 `ok`，Alertmanager `/-/ready` 返回 `200` 且状态 `ready`；这证明平台进程与基础 API 在线，但不证明真实外部通知 receiver 已收到 firing/resolved。
- 历史 review 已验证 Gateway `application` 标签和 P99 指标出数。`docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md:145`
- 历史 review 已验证订单、支付回调、MQ DLQ 指标名与规则对齐并出数。`docs/test-3/review-production-config.md:729`
- 本轮远程探测中 SkyWalking `1234/metrics` 与 `8080` UI 可达；`12800/healthCheck` 返回 `404`，但 compose 使用 `12800` TCP healthcheck，因此这条 HTTP 404 不能单独判定 OAP 故障。
- 本轮仍未验证真实业务告警抵达外部通知渠道、Grafana 核心面板实际 series、SkyWalking 新业务 trace 与日志 traceId 对齐，因此这些结论仍保留为待补 L2。

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出远程 Prometheus、Grafana、Alertmanager 的基础 API 已在线，但不能把它写成“真实企业微信 / 钉钉 / 邮件通知已经在所有环境打通”。默认 receiver 仍是占位地址，而且外部告警渠道当前明确不纳入推进范围。

第二，当前可以明确写出本轮远程 Prometheus 有 `23/23` targets 为 up、规则 API 返回 `6` 组/`28` 条规则，但不能把它写成“任何业务异常都能被自动告警”。没有埋点、没有 exporter、没有 series 或标签不匹配，都会形成监控盲区。

第三，当前可以明确写出 VictoriaMetrics `8428/health` 本轮远程可达，且配置中存在 `remote_write`；但不能把它写成“长期样本已经持续写入并可查询”。这仍需检查写入状态和 total series。

第四，当前可以明确写出 Gateway 的指标缺口已经有代码与历史验证修复，但不能把它写成“监控缺口永久消失”。本轮还没有验证 Grafana 核心面板实际出数，也没有重新验证 Gateway trace 与日志 traceId 对齐。

## 收网：这篇 Monitoring Alert 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的监控告警不是“装上 Prometheus / Grafana / Alertmanager”就结束，而是一条从业务埋点、中间件 exporter、Prometheus scrape、规则表达式、长期存储、Alertmanager 路由到人工处置的完整证据链。它真正复杂的地方，不在工具数量，而在每层的指标名、标签、端口、存储和通知语义必须互相对齐。

从业务逻辑视角看，它把订单失败、支付回调、死信、库存和接口错误率翻译成可观测信号；从工程视角看，它把 Prometheus、VictoriaMetrics、Grafana、Alertmanager、exporter 与部署包串成一张监控平面；从分布式视角看，它承认“targets UP”与“业务健康”之间存在巨大距离；从微服务视角看，它让每个服务的局部指标可以被聚合成系统级入口与交易视图。

更重要的是，本篇把一个特别容易被讲轻的事实钉住了：**监控最危险的故障不是红色告警太多，而是规则引用错指标、通知没有出口、业务事件没有埋点，导致真正异常发生时系统保持安静。**

如果继续往 `12-testing-release-ops/` 推进，这一卷目前已基本收口；更自然的下一步是回到后续发布 / 运维或补写既有篇章的运行态证据，而不是继续并列扩展工具清单。