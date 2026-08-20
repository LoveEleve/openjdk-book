# 04 Observability：为什么网关可观测性不是“装上 SkyWalking 和 Prometheus”就算闭环

到这一组的最后一篇，Gateway 已经被拆成了四层：路由、JWT + HMAC 双门禁、Sentinel 限流，以及前面多次出现却一直没有单独收束的可观测性控制面。很多项目写到这里会很自然地下一个粗糙结论：既然有 SkyWalking、有 Prometheus、有 Grafana、有 ELK，那可观测性就算完成了。

这句话最大的问题，不是它全错，而是它把“装了工具”和“问题真的能被定位”混成了一件事。对 `my-xhs` 这样的微服务入口来说，可观测性真正要回答的，从来不是“系统有没有监控平台”，而是另一句更贴近生产排障的话：**当一次请求从 Gateway 进入系统，最后变成慢请求、错请求、丢链路或无数据时，团队能不能在 trace、日志、指标三条线上把它重新拼回去。**

这个问题一旦落回 `my-xhs` 的现实，会立刻变得非常具体。Gateway 是 WebFlux 入口，不依赖 common 模块；这意味着它不会自动继承其它 14 个服务已经有的公共 metrics 标签与 access log 体系。Gateway trace 还要面对 SkyWalking 的 gateway plugin、webflux plugin、sw8 传播、业务 traceId 与 SkyWalking traceId 两套 ID 体系之间的对齐问题。日志侧则不仅仅是“能写文件”，而是要把 `traceId`、`spanId`、`userId` 真正打进 JSON，经过 Logstash 落到 ES，最后在 Kibana 或 Grafana 里可检索。指标侧也不只是“/actuator/prometheus 能打开”，还涉及 gateway 因为不依赖 common 模块而缺失 `application` 标签、缺失 `myxhs_http` 指标、只能靠 `http.server.requests` 与 histogram bucket 去补齐面板的那一整串工程补丁。

所以本篇真正要写的，不是工具列表，而是这条 northbound 入口控制面的可观测性闭环：一次请求怎样同时留下 trace、日志和 metrics；为什么三者任何一条断掉，系统就会出现“看得到局部、拼不回全链路”的排障断层；以及 `my-xhs` 是怎样通过一次次真实故障修复，把这三条线重新对齐的。

## 先给结论：Gateway 可观测性的核心不是“有三套工具”，而是“同一条入口请求能在三条证据线上互相对上”

先别急着进源码，先把本篇最重要的人话答案钉住：`my-xhs` 的 Gateway 可观测性不是三套工具的并列堆砌，而是三条证据链的对齐。

第一条是 trace 线。它回答“这次请求经过了哪些服务、跨进程和跨线程怎样传播、Gateway 到下游服务之间的入口段是不是打通了”。第二条是日志线。它回答“当 trace 查不到、平台临时挂了、只剩文本日志时，是否还能凭 `traceId`、`spanId`、`userId`、path 和 status 把单次请求捞出来”。第三条是 metrics 线。它回答“即便没有单条请求明细，入口整体的吞吐、时延、错误率、限流情况有没有数值型证据可以先看板定位”。

如果这三条线互相断开，就会出现三种非常典型的假闭环。

- 只有 trace 没有日志：你知道链路经过了 home、user、counter、content，但不知道用户提交的业务参数、网关入口 path、应用日志异常点落在哪。
- 只有日志没有 metrics：你能查到某次请求的错误日志，但不知道它是偶发还是系统性抖动，不知道过去 5 分钟整体 RT 和错误率有没有抬升。
- 只有 metrics 没有 trace：你看到 `http_server_requests_seconds_bucket` 或 5xx 比例飙了，但不知道是 Gateway 自身慢、下游服务慢、trace 断了，还是限流响应没正常发出去。

`my-xhs` 这套 Gateway 的真正目标，是让同一条入口请求在这三条线上能互相对得上：`RequestLogFilter` 先生成或透传 `X-Trace-Id`，再补 `sw8`；logback 把 `traceId` / `spanId` / `userId` 打进 JSON；Actuator 与 Micrometer 暴露 `http.server.requests`，Prometheus 抓取，Grafana 或 PromQL 聚合。只有三者同时对齐，northbound 入口才不是“有监控系统”，而是“能排障的入口控制面”。

## 直觉方案为什么不够：只装代理、只开日志、只暴露 `/actuator/prometheus` 都不够

### 失败方案一：只装 SkyWalking agent，以为链路就自然贯通

很多团队的第一直觉是：既然有 SkyWalking agent，链路追踪的问题应该由 agent 自动解决。这个想法在单体、Servlet 同构服务里经常还能勉强成立，但 `my-xhs` 的 Gateway 这里远不够。

最直接的证据就是历史上真的出现过 Gateway 转发链路缺失，而且最开始还误判成 “SCG 4.1.2 witness 盲区”。后来复盘才确认，真正根因根本不是 Spring Cloud Gateway 4.1.2 不被支持，而是 `apm-spring-cloud-gateway-4.x-plugin-9.6.0.jar` 还躺在 `optional-plugins`，没有移进 agent 的 `plugins` 目录。修复动作也很朴素：把插件拷进去，再重启 gateway。之后 Gateway 自己的 segment trace_id 才和 user 服务 segment 同 trace_id 对上，说明入口段真正被打通了。`docs/FINAL-HANDOFF.md:172`

这个案例非常重要，因为它说明“agent 在进程里”不等于“trace 真的能从 Gateway 打到下游服务”。框架插件有没有加载、gateway plugin 与 webflux plugin 是否同时在、sw8 有没有被正确补头，这些都会决定 Gateway 入口是不是 trace 体系里的真实第一跳。

### 失败方案二：只把日志写到文件，以为 grep 能顶住排障

第二个直觉方案也很常见：日志都写到文件了，出了事去 `/logs` 或 `logs/` 里 `grep traceId` 不就行了。这对单机脚本系统或低并发服务可能还够，对 `my-xhs` 的 Gateway 明显不够。

因为这里的问题不是“有没有文件”，而是“日志能不能成为结构化检索证据”。没有 JSON 编码、没有 MDC 注入、没有 `traceId` 显式落字段，日志到了 Logstash 和 ES 后就会变成一堆可读文本，而不是可精确查询的结构化数据。历史故障 `traceid-es-issue.md` 记录得非常直接：当时全部 15 个模块的 `LOGSTASH` appender 都缺 `<includeMdcKeyName>traceId</includeMdcKeyName>`，结果就是 ES 里根本没有 traceId 字段，无法按一次请求把日志捞出来。`docs/traceid-es-issue.md:8`

修复后，Gateway 的 `logback-spring.xml` 已经明确把 `traceId`、`spanId`、`userId` 写进了 `JSON_FILE` 和 `LOGSTASH` 两条编码器链。`my-xhs-gateway/src/main/resources/logback-spring.xml:93`

这说明日志在这里承担的不是“人眼看文本”的角色，而是“给 ES / Kibana / Grafana 提供结构化检索字段”。如果没有这层结构化，trace 再漂亮、指标再齐，也很难把入口请求与应用日志重新拼起来。

### 失败方案三：只暴露 `/actuator/prometheus`，以为指标面板自然会有入口流量

第三个直觉方案则发生在指标侧。很多服务只要加了 Actuator 和 Micrometer，`/actuator/prometheus` 能打开，就会默认指标已经齐了。但 Gateway 这里同样不能这么想。

`my-xhs` 的 Gateway 有一个非常特殊的现实：它不依赖 common 模块，所以不会自动继承其它业务服务已经有的公共 `MeterRegistryCustomizer` 与 `myxhs_http` 指标链。结果就是，最开始 Gateway 虽然也暴露了 Prometheus 指标，但**没有 `application=my-xhs-gateway` 这个公共标签**，同时也没有 common 那套 `myxhs_http_request_duration_seconds*` 指标。所有按 `$application` 聚合的看板都会把网关当成“消失的入口”。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/GatewayMetricsConfig.java:9`

这也是为什么后来必须新增 `GatewayMetricsConfig`，强行给 Gateway 指标补 `application=my-xhs-gateway` 标签；同时在 `application.yml` 里显式开启 `management.metrics.distribution.percentiles-histogram[http.server.requests]=true`，让 Boot 自带的 `http.server.requests` 产出 bucket，好让 Grafana 面板用正则同时覆盖 common 服务的 `myxhs_http_*` 和 Gateway 的 `http_server_requests_*`。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/GatewayMetricsConfig.java:19` `my-xhs-gateway/src/main/resources/application.yml:403`

这就说明，“Actuator endpoint 存在”不等于“指标面板已经能看入口”。指标链和日志链、trace 链一样，必须被具体接线，尤其是 Gateway 这种体系外模块。

## 先画总图：一次 Gateway 请求怎样同时留下 trace、日志和指标

先把整条可观测性链用一张文字图立住：

```text
客户端请求 -> Gateway :19000
  -> RequestLogFilter
       生成/透传 X-Trace-Id
       MDC.put(traceId)
       记录入站日志
       注入 sw8 头
  -> Gateway 后续过滤器 / 路由转发
       JWT / HMAC / Sentinel / downstream call
  -> RequestLogFilter.then(...)
       记录出站 status + duration
       MDC.remove(traceId)

日志线:
  -> logback LOG_PATTERN / JSON_FILE / LOGSTASH
       traceId + spanId + userId 写入结构化日志
  -> /logs/${APP_NAME}.json（本地 JSON 文件）+ TCP 15044 直连 Logstash
  -> ES 19200 -> Kibana / Grafana 按 traceId 精确检索

trace 线:
  -> sw8 头 + SkyWalking gateway/webflux 插件
  -> Gateway segment -> downstream service segment
  -> OAP 12800 / UI 8080 / ES 19201 存储

metrics 线:
  -> Micrometer / Actuator 暴露 health info prometheus metrics
  -> http.server.requests histogram bucket
  -> commonTags(application=my-xhs-gateway)
  -> Prometheus 19090 抓取 -> Grafana 13000 展示
```

这张图里最关键的，不是每个工具名，而是一次请求如何在三条线上共享同一个 northbound 入口事实。

- `traceId` 先由 `RequestLogFilter` 生成或透传，再进 MDC，再进 JSON log，再进 ES。
- `sw8` 同时把入口 trace 语义传给 SkyWalking agent，使 Gateway segment 和下游服务 segment 能连接起来。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RequestLogFilter.java:62`
- `duration` 与 `status` 一边出现在 ACCESS 日志里，一边又会体现在 `http.server.requests` 之类的 metrics 聚合里。

所以可观测性真正成立的标志，不是“这三套系统都在跑”，而是“同一条 Gateway 请求在三条线上可以互相指认”。

## Trace 这条线：Gateway 为什么要自己造 `X-Trace-Id`，还要再补一层 `sw8`

### `RequestLogFilter` 做的第一件事不是记日志，而是先给入口请求发一张身份证

`RequestLogFilter` 的第一步是从请求头里取 `X-Trace-Id`；如果上游没带，就现场生成一个 32 位无横线 UUID。随后它做了两件后面所有章节都会依赖的事：一是把这个 traceId 放进 MDC，二是把它写回 request header。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RequestLogFilter.java:49`

这意味着 Gateway 并不是被动记录者，而是 northbound trace 身份的第一签发点。它不能等下游服务自己再生成 traceId，因为一旦请求先穿过网关、再跨进 user、order、search、notification、MQ 或异步线程，入口层如果没有统一 trace 主线，后面任何一个服务想补 trace 都已经太晚了。你最多得到多个局部 trace，而不是同一条入口请求的贯通视图。

### 只有业务 traceId 还不够，所以网关还要补 `sw8`

但 `X-Trace-Id` 本身还不足以让 SkyWalking 自己把 Gateway 与下游链路连起来。交接材料里有一个很重要的提醒：业务 traceId 和 SkyWalking traceId 原本是两套系统，业务 traceId 透传正常，并不自动代表 SkyWalking 的跨进程传播就成功。`docs/FINAL-HANDOFF.md:181`

这也是为什么 `RequestLogFilter` 不只写 `X-Trace-Id`，还要再额外构造 `sw8`。它把业务 traceId Base64 编码后塞进 SkyWalking 的跨进程传播头格式里，使下游 agent 接收到请求时，既能延续 SkyWalking 的 segment/refs 语义，又尽量让日志里的业务 traceId 与 SkyWalking trace 主线对齐。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RequestLogFilter.java:96`

这里最值得记住的是：Gateway 在 trace 这条线上做的不是“为了多一个 header”，而是把**业务请求标识**和**APM 传播标识**强行对齐。没有这层补头，SkyWalking UI 上看见的 trace 和日志里 grep 到的 traceId 很可能根本不是同一串值，排障时仍然得人工猜。

### Gateway trace 真正打 through，靠的不是 agent 自动魔法，而是插件与传播一起到位

历史修复 #6 把这条线讲得很透。之前 Gateway 转发链路追踪缺失时，误判方向一度是 “SCG 4.1.2 witness 盲区”；后来才确认根因只是 gateway 4.x plugin 没启用。修完后，Gateway segment trace_id 与 user segment 同 trace_id，说明不是只有入口日志有 trace，而是 Gateway 真正成了 SkyWalking 拓扑里的第一跳。`docs/FINAL-HANDOFF.md:172`

这条故障特别值得写进正文，因为它告诉读者：Gateway trace 闭环至少依赖三件事同时成立——WebFlux / Gateway 插件真的加载、`sw8` 真被补头、下游 agent 真能接上。任意一环缺失，都会出现“日志里有 traceId、UI 里也有 trace，但就是拼不回入口段”的假闭环。

## 日志这条线：Gateway 不是只要有 ACCESS 日志，而是要让 traceId 真能进 ES

### `RequestLogFilter` 的 ACCESS 日志为什么必须是双向的

`RequestLogFilter` 并不是只在请求进来时记一条 `>>>`，而是会在 `chain.filter(...).then(...)` 里补一条 `<<<`，把 `status` 和 `durationMs` 一起记出来。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RequestLogFilter.java:80`

这层设计的价值，在 northbound 入口尤其高。因为只记录入站，不记录出站，你最多知道“请求来了”；但不知道它最终成功还是失败、慢了多久、是不是在网关就被拦掉了。反过来，只看 metrics 时你能知道“某分钟错误率高了”，却很难立刻定位到哪些 path、哪些 traceId 的单次请求出了问题。

Gateway 的双向 ACCESS 日志正好填了这个缝：一次 northbound 请求最基本的四元组——`method/path/status/duration`——先在文本层落地；而 traceId 又把这条文本证据串回了 SkyWalking 和 ES 检索链。

### logback 真正起作用的不是 pattern 漂亮，而是 MDC 字段进了 JSON 编码器

`logback-spring.xml` 里最重要的不是彩色控制台或滚动文件，而是 `JSON_FILE` 与 `LOGSTASH` 两个 appender 的 `LogstashEncoder` 都显式包含了：

- `traceId`
- `spanId`
- `userId`

`my-xhs-gateway/src/main/resources/logback-spring.xml:100`

这就是为什么 `traceid-es-issue.md` 那个修复能成为全局性的里程碑。问题的根因并不是“日志没打出来”，而是“结构化日志里没有 traceId 字段”。文本里看得见，不等于 ELK 能按字段索引和检索。修复后，ES 才能真正按 `traceId=...` 精确命中。`docs/traceid-es-issue.md:8`

对 Gateway 来说，这一点尤其关键，因为 northbound 入口往往是排障的第一站。只要入口日志能在 ES 里按 traceId 捞出来，后面无论是去看下游服务日志，还是回头对照 SkyWalking segment，都会顺很多。反过来，若入口日志结构化字段缺失，哪怕 Gateway 自己日志打得很勤，也只是“能看见很多文本”，而不是“能作为索引式证据链的第一锚点”。

### Logstash 和 ES 不是附加品，而是把入口日志从“文本”变成“查询系统”的桥

当前这份 `docker-compose.yml` 能直接确认的日志链，是 Logstash 暴露 `15044/15045` 输入、向 ES `19200` 写入，再由 Kibana `15601` 提供查询入口；而 Gateway 自己的 `logback-spring.xml` 则同时具备两条产出路径：一条是本地 `/logs/${APP_NAME}.json` 文件，一条是 `LOGSTASH` appender 直连 `21.130.247.89:15044`。因此就当前可见部署与源码证据而言，更稳妥的表述是“**结构化日志既可落本地 JSON 文件，也可由应用直接推送到 Logstash。**”

至于 Filebeat，只能更谨慎地写成另一层历史事实：在 `config/production-env-config/docker-container-review-20260811-162334/07-deploy-src/docker-compose.yml` 这份归档部署包里，确实能看到 `filebeat:` 服务定义；但在当前工作中的主 `config/docker-compose.yml` 片段里，我没有直接看到对应 service。因此 Filebeat 可以被写成“历史部署拓扑中出现过的一条采集路径”，不能被写成“当前主 compose 已显式启用的唯一入口”。`my-xhs/config/docker-compose.yml:903` `my-xhs/config/production-env-config/docker-container-review-20260811-162334/07-deploy-src/docker-compose.yml:708` `my-xhs-gateway/src/main/resources/logback-spring.xml:93`

而 `observability-issues.md` 又给出了更关键的运行态结果：Prometheus 16/16 UP、Grafana 4 面板 + ES 日志、traceId 精确检索，说明这条日志 / 检索链历史上不是只部署过，而是真正打通并被使用过。`docs/observability-issues.md:37`

这也解释了为什么在 `my-xhs` 里，日志不只是排障备用品，而是 trace 的侧证据源。SkyWalking 可以告诉你 home 调了 user、counter、content；ES 则能让你按同一条 traceId 直接捞出 Gateway 入站日志、下游异常日志和业务关键字段。没有这条链，Trace UI 和文本日志仍然是两套世界。

## Metrics 这条线：Gateway 的最大坑不是没指标，而是“入口流量在所有看板里消失”

### Gateway 不依赖 common，导致它天然比其它 14 个服务少一层观测接线

`my-xhs` 的其它业务服务很多都能复用 common 模块里的公共 metrics / access log / trace 基建，但 Gateway 是一个例外。它是独立 WebFlux 入口，不依赖 common，所以一开始并不会自动拥有与其它服务一致的指标标签与 HTTP 指标族。这个差异如果不单独指出来，读者很容易误以为“全项目 Micrometer 配置是一套”。其实不是。

`GatewayMetricsConfig` 上的注释已经把这个坑写得很清楚：gateway 不依赖 common，导致 `MetricsAutoConfiguration` 不会替它补 `application` 公共标签；结果就是所有按 `$application` 聚合的面板都看不到网关流量，入口层在监控视图里相当于“透明”。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/GatewayMetricsConfig.java:9`

修复动作也非常直接：给 registry 强行补 `commonTags("application", "my-xhs-gateway")`。这个修复看似朴素，但它的价值非常高，因为入口网关如果在按应用聚合的指标体系里消失，很多“系统入口有没有流量、RT 抬没抬、错误是不是先发生在 Gateway”这类最基础的问题都无法回答。

而且这一步现在已经不只是源码意图。历史 review 材料里已经明确给出过两条更强的验证：一是 gateway 指标已经带上 `application` 标签；二是补开 histogram 之后，gateway 的 P99 延迟已经能够在看板里出数。这使得这里的口径可以更稳地写成“**代码层补了标签与 bucket，历史运行态也验证过它们确实让入口指标重新回到面板里。**” `docs/test-3/review/ANSWERS-DEPLOY-PACKAGE.md:145` `docs/test-3/HANDOFF-TASK6.md:48`

### `http.server.requests` bucket 为什么要显式打开

Gateway 指标的第二个坑，不是没有 metrics，而是没有**对得上延迟面板的 histogram bucket**。

`application.yml` 里专门给 `management.metrics.distribution.percentiles-histogram[http.server.requests]=true` 打开了 bucket。注释写得很明白：Gateway 没有 common 模块里那套 `myxhs_http` 指标，所以要靠 Spring Boot 自带的 `http.server.requests` 来替位；而很多 Grafana 延迟图和 PromQL 聚合，本来就依赖 `_bucket` 系列指标。`my-xhs-gateway/src/main/resources/application.yml:403`

这意味着，“/actuator/prometheus 打开了”仍然不够。没有 bucket，你能看到 count 和 sum，但很难做标准的 P95 / P99 histogram_quantile 计算。`docs/test-3/REVIEW-METHODOLOGY.md` 甚至把这点专门记成了方法论提醒：Boot 3.x 的 `http_server_requests_seconds` 默认无 `_bucket`，如果不显式开 histogram，很多延迟看板就会空掉。`docs/test-3/REVIEW-METHODOLOGY.md:35`

所以 Gateway 指标链真正要立住的不是“有 metrics endpoint”，而是“这个 endpoint 产出的 metrics 能被 Prometheus 抓、能被 Grafana 看板消费、能与其它 14 个服务统一聚合”。

### 当前本机 Prometheus / Grafana / SkyWalking 端口都关着，这意味着什么

我在当前这台环境上探测了 `19090`、`13000` 和 `8080` 三个端口，结果分别是 `CLOSED`、`CLOSED`、`CLOSED`。这说明在此刻的本机环境里，Prometheus、Grafana、SkyWalking UI 至少都不是直接可访问状态。

这条事实非常重要，因为它直接决定本篇后面所有运行态表述都不能写成现在进行时。我们可以明确引用历史验证材料，比如 `observability-issues.md` 里“Prometheus 16/16 UP、Grafana 4 面板 + ES 日志、traceId 精确检索”、`FINAL-HANDOFF.md` 里“SkyWalking 跨服务 22 span ✅”；但不能把这些历史结果平移成“现在这台机器上这三套平台都在线可用”。`docs/observability-issues.md:37` `docs/FINAL-HANDOFF.md:234`

这也刚好印证了方法论要求：运行态材料必须并入正文，但运行态是有时间戳和环境边界的。能说的是“历史上曾打 through”，不能说成“此刻仍然保持在线”。

## 部署拓扑为什么是正文证据，而不是附录

如果不看 `docker-compose.yml`，这篇很容易写成一篇纯 Java 源码分析。但可观测性恰恰不能这样写，因为大量关键事实都藏在部署层。

`docker-compose.yml` 明确了当前中间件机上的可观测性拓扑：

- SkyWalking OAP：`12800`（健康检查走这个 HTTP 端口）
- SkyWalking UI：`8080`
- SkyWalking 存储 ES：`19201`
- Prometheus：`19090`
- Grafana：`13000`
- VictoriaMetrics：`8428`
- Node Exporter：`9100`
- Redis / ES / MySQL exporter：`9151` / `9114` / `9104` / `9105`
- Logstash：`15044/15045`
- Kibana：`15601`

`my-xhs/config/docker-compose.yml:595`

这些端口不是“部署附录信息”，而是解释正文中很多可观测性现象的证据源。比如：

- 为什么 SkyWalking OAP 的健康探测不是去看 gRPC `11800`，而是用 `12800` 做真实探测；因为历史上就踩过“端口在监听但 OAP 实际不可用”的坑。`my-xhs/config/docker-compose.yml:619`
- 为什么 SkyWalking 采样率要特别提一嘴；因为 `SW_TRACE_SAMPLE_RATE` 曾从 `10` 修成 `1000`，否则几乎看不到真实流量。`my-xhs/config/docker-compose.yml:600`
- 为什么日志链不只是 logback 配完就完事；因为还要经过 `15044` 的 Logstash TCP 输入，再落到 `19200` 的业务 ES。`my-xhs/config/docker-compose.yml:909`

换句话说，可观测性篇如果不把部署拓扑并入正文，就会漏掉一半复杂度：很多“源码看着已经有埋点，平台却没数据”的问题，根本不在源码，而在 agent 插件、端口、采样率、exporter 与 Logstash 这些运行层事实。

## 真实故障案例：Gateway 入口链路追踪缺失，暴露的是“trace 传播成功”和“trace 平台能看见”不是一回事

按照本卷方法论，每篇都必须有真实故障案例。对可观测性这一篇来说，最合适的不是某个单独 exporter 挂掉，而是更能逼出入口闭环本质的案例：**Gateway 转发链路追踪缺失**。

这个故障的特别之处在于，它一开始甚至被误判了。旧判断是“SCG 4.1.2 witness 盲区”，仿佛框架版本本身导致 Gateway 入口看不进 SkyWalking；后来真正查清后才发现，根因其实只是 `apm-spring-cloud-gateway-4.x-plugin-9.6.0.jar` 没从 `optional-plugins` 移进 `plugins`。这就是一个非常典型的可观测性故障：源码本身没坏，请求也在走、日志也能看到，但 APM 平台里缺的那一段恰好是 Gateway 入口。`docs/FINAL-HANDOFF.md:172`

用方法论要求的五段式把它收起来：

- 现象：Gateway 到下游服务的入口段 trace 缺失，看得到下游 segment，看不到 Gateway 自己的转发段
- 根因：SkyWalking Gateway 4.x 插件未真正启用，不是 SCG 4.1.2 天生不支持
- 修复：把插件移进 `plugins/` 并重启 gateway
- 验证：Gateway segment trace_id 与 user segment 同 trace_id，sw8 传播成功
- 余波：以后排障不能先下框架兼容性结论，必须先查 agent 插件实际加载状态

这个案例特别适合作为可观测性篇的主案例，因为它同时揭示了 trace 线的三个层次：请求真的经过了 Gateway；Gateway 也真的把 trace 头往下游传了；但只要平台侧的 plugin 没接上，UI 里依然会缺一段。这比“某个 dashboard 暂时 404”更能说明为什么可观测性不是装好平台就自然闭环。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- `RequestLogFilter` 负责生成 / 透传 `X-Trace-Id`、注入 MDC、补 `sw8` 头、记录入站 / 出站日志。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RequestLogFilter.java:42`
- `logback-spring.xml` 的 `JSON_FILE` 与 `LOGSTASH` encoder 显式包含 `traceId`、`spanId`、`userId`。`my-xhs-gateway/src/main/resources/logback-spring.xml:93`
- `GatewayMetricsConfig` 手工为 Gateway 指标补了 `application=my-xhs-gateway` 公共标签。`my-xhs-gateway/src/main/java/com/myxhs/gateway/config/GatewayMetricsConfig.java:19`
- `application.yml` 显式暴露了 `health/info/prometheus/metrics` 端点，并开启 `http.server.requests` histogram。`my-xhs-gateway/src/main/resources/application.yml:403`

L1 框架/语义证据：

- `sw8` 是 SkyWalking 的跨进程传播头，仅有业务 `X-Trace-Id` 并不能自动等价为 SkyWalking trace 贯通。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RequestLogFilter.java:96`
- WebFlux 入口若不显式清理 MDC，会因线程模型造成上下文污染；`doFinally(MDC.remove(...))` 正是在处理这个语义差异。`my-xhs-gateway/src/main/java/com/myxhs/gateway/filter/RequestLogFilter.java:93`
- Boot 3.x 下要做 HTTP 延迟 histogram，看板依赖 `http.server.requests` bucket，不能只满足于 endpoint 存在。`my-xhs-gateway/src/main/resources/application.yml:405`

L2 运行态证据：

- `observability-issues.md` 已记录历史上 Prometheus 16/16 UP、Grafana 4 面板 + ES 日志、traceId 精确检索，以及 SkyWalking 22 span、4 服务贯通的实证。`docs/observability-issues.md:13`
- `traceid-es-issue.md` 已确认全部 15 个模块修完 `includeMdcKeyName traceId` 后，ES 可按 traceId 精确命中。`docs/traceid-es-issue.md:30`
- `FINAL-HANDOFF.md` 已记录 Gateway trace 缺失故障修复后，Gateway segment 与 user segment 同 trace_id。`docs/FINAL-HANDOFF.md:172`
- 当前本机端口探测显示 `19090`、`13000`、`8080` 均为 `CLOSED`，因此这些平台“此刻在线”不能写成既成事实。

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出 Gateway 已具备 trace、日志、metrics 三条观测接线，但不能写成“当前这台环境上 Prometheus / Grafana / SkyWalking 平台都在线可用”。现时端口探测已经证明至少本机不是这个状态。

第二，当前可以明确写出 Gateway 通过 `sw8` 尝试对齐业务 traceId 与 SkyWalking 传播语义，但不能把它写成“业务 traceId 与 SkyWalking 内部 traceId 永远完全同值”。更准确的说法是：Gateway 在尽力把两条标识主线对齐，并且历史上已经验证过入口段贯通；但 SkyWalking 自身仍有 segment / refs / UI 查询窗口等独立语义。`docs/FINAL-HANDOFF.md:181`

第三，当前可以明确写出 Gateway 指标已补齐 `application` 标签和 `http.server.requests` histogram，但不能把它写成“入口监控盲区已在所有环境永久消失”。更准确地说，是**代码层已补上缺口，历史运行态曾验证有效，当前环境是否已重新抓到指标仍取决于 Prometheus / Grafana 实例是否在线。**

第四，当前可以明确写出 ELK 链路已具备 `traceId` 精确检索能力，但不能写成“只靠 ES 日志就能替代 trace 平台”。日志和 trace 在这套系统里是互证关系，不是彼此替代。

## 收网：Gateway 可观测性真正完成的不是工具安装，而是入口证据链闭环

到这里可以回收开头的问题了。`my-xhs` 的 Gateway 可观测性不是“SkyWalking + Prometheus + Grafana + ELK”这串名词本身，而是同一条 northbound 请求能在三条证据线上重新拼起来：trace 线告诉你它经过了哪些服务，日志线让你按 traceId/spanId/userId 精确检索上下文，metrics 线告诉你入口整体吞吐、时延和错误率有没有抬升。

从业务逻辑视角看，它守住的是“用户一次入口请求”在系统里留下的完整足迹；从工程视角看，它把 `RequestLogFilter`、logback JSON、Actuator、Micrometer、SkyWalking 插件、Logstash 与 ES 串成了一条跨源码与部署的观察链；从分布式视角看，它明确地区分了业务 traceId 与 APM trace 传播语义，并通过 `sw8` 和结构化日志尽量对齐两者；从微服务视角看，它让 Gateway 这个 northbound 入口不再是“有流量却不可见”的黑盒，而成为全系统排障的第一锚点。

更重要的是，本篇也把一个最容易被忽略的事实钉实了：**可观测性失败，不只是“平台没部署”，更可能是“请求在走、日志在打、agent 在挂，但三条证据线就是对不上”。** `my-xhs` 过去这几轮真实修复，修的恰恰就是这种“看似都有，实际上没闭环”的入口可观测性。

下一步如果继续推进 `08-gateway-security-observability/` 这一组，其实已经收口完成；更自然的转向，是进入 `09-data-model-storage/01-mysql-sharding.md`，把前面交易链、Gateway、搜索和通知里反复出现的数据层复杂度统一收束。