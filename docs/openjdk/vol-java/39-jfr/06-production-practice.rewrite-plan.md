# 39-jfr/06 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11。本文聚焦 Java 层可见的 `Recording`、`Configuration`、`FlightRecorderMXBean`、`jfr`/`jcmd` 工具入口，以及它们在生产中的组合方式。`JFR.start` 等诊断命令最终由 HotSpot 诊断命令链路承接，但本文不展开 native 实现细节，只把它作为命令入口边界说明。
> 目标：把“JFR 生产实践”改写成一篇围绕“JFR 的生产价值不在于出事后临时开一次录制，而在于如何把 default/profile、时间窗口、保留策略、导出动作和自动化消费串成一套低干扰观测闭环”展开的收官文章。

## 1. 读者困惑

- JFR 到底该在生产里怎么用，才不是一次性的手工抓包工具？
- 为什么很多团队明明知道 JFR 很强，却总是在事故后才想起来开录制？
- `default` 和 `profile` 到底是在切“轻量/重量”，还是在切不同的成本预算？
- 持续录制会不会把磁盘打爆、把开销拖高，JDK 11 到底给了哪些收口手段？
- `jcmd`、`Recording` API、`FlightRecorderMXBean` 和消费者 API 之间应该怎么分工？
- 什么时候该先用 JFR，什么时候该先用 `jstack`、`jmap`、JMX 或常规监控？

## 2. 一句话顿悟

**JFR 在生产里最有价值的姿势，不是“事故发生后临时开一次大录制”，而是提前用 `default` 之类的低成本配置维持一个受控的背景时间窗口；出现告警时再用 `dump`、短时升档、脚本消费和离线复盘把窗口里的历史收住。JDK 11 的 `Recording`/`jcmd`/`FlightRecorderMXBean` 一整套接口，本质上都是在帮你把“录多长、留多少、何时导出、谁来消费”这些成本边界显式化。**

## 3. 旧稿优点与问题

### 保留

- 已经抓到 `jcmd JFR.start/dump/stop/check` 这一组生产入口。
- 已经意识到 `default` 配置适合常开，生产实践离不开开销讨论。
- 已经把 JMX、consumer API 和生产监控之间的衔接点提到了。

### 必须重写

- 旧稿仍是“命令列表 + 工具列表 + 结论卡片”，没有形成真正的生产闭环叙事。
- 没有先回答“为什么临时录制往往太晚”，失败方案和读者困惑都不够具体。
- `default/profile` 被写成轻重二分，没有讲清它们其实是事件预算和调查深度预算。
- 没把 `setMaxAge`、`setMaxSize`、`dump`、`dumpOnExit`、`openStream/readStream` 这些能力统一到“保留窗口与导出策略”这条主线上。
- 没有清晰区分“JFR 负责低干扰时间线留痕”和“`jstack`/`jmap`/JMX/监控系统负责即时状态或告警”的分工边界。

## 4. 理解路径

### 第一节：先立住生产里的真实困惑——为什么“等出事再开 JFR”常常已经错过窗口

主线：
- 线程卡顿、短 GC 抖动、间歇性锁竞争、突发分配尖峰，都可能在你开始人工排查前已经过去。
- 如果只依赖事故后手工执行命令，拿到的往往只是“现在的状态”，不是“问题发生时的一段历史”。
- JFR 前五篇已经把事件、录制、消费讲完，这一篇要把它们收束成生产闭环：先保留窗口，再在窗口里取证。

### 第二节：为什么 JFR 最适合常驻背景录制，而不是每次都临时开一个大 profile

证据：
- `Configuration.java:79`
- `Configuration.java:97`
- `Recording.java:381`
- `Recording.java:409`
- `Recording.java:432`
- `default.jfc:8`
- `profile.jfc:8`

主线：
- `default` 的描述就是面向 continuous production use；`profile` 是更高调查密度的预算。
- JFR 的核心不是“录不录”，而是“录哪些事件、留多大窗口、多久丢弃旧块”。
- `setMaxAge` / `setMaxSize` 让背景录制变成可控环形窗口，而不是无限膨胀的黑洞。

### 第三节：为什么 `default`/`profile` 不是“简单/高级”二分，而是两种不同的成本预算

证据：
- `default.jfc:8`
- `profile.jfc:8`
- `Recording.java:317`
- `FlightRecorderMXBean.java:454`
- `FlightRecorderMXBean.java:485`

主线：
- `default` 对应低干扰、持续留痕；`profile` 对应更密的采样和更多事件。
- 生产里最常见的正确姿势不是二选一，而是常驻 `default`，在定位窗口内短时切换/叠加更重设置。
- 配置本质上是事件集与阈值的预算声明，不是功能开关名片。

### 第四节：为什么真正的生产闭环是“背景录制 → 告警触发 → 导出窗口 → 离线/脚本复盘”

证据：
- `Recording.java:374`
- `Recording.java:462`
- `Recording.java:507`
- `DCmdStart.java:106`
- `DCmdStart.java:154`
- `DCmdStart.java:176`
- `DCmdStart.java:180`
- `DCmdStart.java:188`
- `DCmdStart.java:203`
- `Main.java:47`
- `Main.java:57`

主线：
- `start/check/dump/stop` 不是四个散命令，而是一套会话控制动作。
- 告警触发时最重要的动作往往不是“现在开始录”，而是“马上 dump 当前保留窗口”。
- `filename`、`dumpOnExit`、`maxAge`、`maxSize`、默认 250MB 保护值，都在约束“你留住多少历史、以什么方式落盘”。

### 第五节：为什么 JFR 不该单打独斗——它和 `jstack`/`jmap`/JMX/监控系统解决的是不同层的问题

证据：
- `FlightRecorderMXBean.java:172`
- `FlightRecorderMXBean.java:194`
- `FlightRecorderMXBean.java:262`
- `FlightRecorderMXBean.java:280`
- `FlightRecorderMXBean.java:376`
- `FlightRecorderMXBean.java:413`
- `FlightRecorderMXBean.java:570`
- `FlightRecorderMXBeanImpl.java:140`
- `FlightRecorderMXBeanImpl.java:164`

主线：
- `jstack` 擅长当前线程现场，`jmap` 擅长堆快照，监控系统擅长实时告警，JMX 擅长远程控制与状态读取。
- JFR 的独特价值是带时间轴的低干扰历史，而不是替代所有诊断工具。
- `FlightRecorderMXBean` 和 stream API 说明 JFR 可以被纳入远程控制和平台自动化，而不是只能靠人工 SSH。

### 第六节：为什么自动化接入的关键不是“有人会开命令”，而是“平台知道什么时候导出、导出多长、谁来消费”

证据：
- `FlightRecorderMXBean.java:300`
- `FlightRecorderMXBean.java:376`
- `FlightRecorderMXBean.java:413`
- `FlightRecorderMXBean.java:638`
- `FlightRecorderMXBeanImpl.java:140`
- `FlightRecorderMXBeanImpl.java:164`
- `Main.java:61`
- `Main.java:73`
- `Main.java:75`

主线：
- JMX 流接口和 `jfr print/summary/metadata` 入口说明 `.jfr` 历史可以批处理消费。
- 生产平台真正要自动化的是触发条件、保留策略、导出动作和后处理，而不是只记住几条命令。
- 收尾把全域主线压回去：JFR 从事件模型、注解、注入、配置、消费，一路收束到生产闭环。

## 5. 失败方案清单

1. 只在事故已经爆发后才临时执行 `JFR.start`，结果错过了真正的抖动窗口。
2. 把 `profile` 当默认常驻模板，不做阈值和时间窗口控制，导致成本预算失控。
3. 只会 `start/stop`，不会 `dump` 当前历史窗口，最后只能拿到事故后的新数据。
4. 持续录制却不设 `maxAge` / `maxSize`，把保留窗口做成无限增长。
5. 把 JFR 当成能替代一切诊断手段的万能工具，忽略 `jstack`/`jmap`/监控/JMX 的即时价值。
6. 只把 `.jfr` 当成给 JMC 手工打开的附件，不接入脚本和自动化消费链路。

## 6. 误解清单

1. JFR 只有在大事故时临时打开才划算。
2. `default` 是简化版，`profile` 是完整版。
3. 只要开了持续录制，磁盘就必然不可控。
4. `JFR.dump` 只是停止录制时的附属动作，不是保留窗口的关键动作。
5. JFR 能替代 `jstack`、`jmap` 和监控系统。
6. 生产落地只需要会手敲 `jcmd`，不需要平台化控制和脚本消费。

## 7. 总图 / 角色 / 箭头 / 时序

- 业务进程持续运行。
- 后台 `Recording` 以 `default` 或受控配置常驻，保留最近一段历史窗口。
- 监控系统或人工观察发现告警。
- 触发器决定：直接 `dump` 当前窗口，或短时提升配置、补录更密事件。
- `.jfr` 文件被 `jfr` 命令、JMC、consumer API 或平台脚本消费。
- 复盘结论回写到新的阈值、事件集和自动化规则里，形成下一轮预算。

## 8. 证据清单

- `jdk.jfr/share/classes/jdk/jfr/Configuration.java:79`
- `jdk.jfr/share/classes/jdk/jfr/Configuration.java:97`
- `jdk.jfr/share/classes/jdk/jfr/Recording.java:317`
- `jdk.jfr/share/classes/jdk/jfr/Recording.java:374`
- `jdk.jfr/share/classes/jdk/jfr/Recording.java:381`
- `jdk.jfr/share/classes/jdk/jfr/Recording.java:409`
- `jdk.jfr/share/classes/jdk/jfr/Recording.java:432`
- `jdk.jfr/share/classes/jdk/jfr/Recording.java:462`
- `jdk.jfr/share/classes/jdk/jfr/Recording.java:507`
- `jdk.jfr/share/conf/jfr/default.jfc:8`
- `jdk.jfr/share/conf/jfr/profile.jfc:8`
- `jdk.jfr/share/classes/jdk/jfr/internal/tool/Main.java:47`
- `jdk.jfr/share/classes/jdk/jfr/internal/tool/Main.java:57`
- `jdk.jfr/share/classes/jdk/jfr/internal/tool/Main.java:61`
- `jdk.jfr/share/classes/jdk/jfr/internal/tool/Main.java:73`
- `jdk.jfr/share/classes/jdk/jfr/internal/tool/Main.java:75`
- `jdk.jfr/share/classes/jdk/jfr/internal/dcmd/DCmdStart.java:106`
- `jdk.jfr/share/classes/jdk/jfr/internal/dcmd/DCmdStart.java:154`
- `jdk.jfr/share/classes/jdk/jfr/internal/dcmd/DCmdStart.java:176`
- `jdk.jfr/share/classes/jdk/jfr/internal/dcmd/DCmdStart.java:180`
- `jdk.jfr/share/classes/jdk/jfr/internal/dcmd/DCmdStart.java:188`
- `jdk.jfr/share/classes/jdk/jfr/internal/dcmd/DCmdStart.java:203`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBean.java:172`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBean.java:194`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBean.java:262`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBean.java:280`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBean.java:300`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBean.java:376`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBean.java:413`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBean.java:570`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBean.java:638`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBeanImpl.java:76`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBeanImpl.java:140`
- `jdk.management.jfr/share/classes/jdk/management/jfr/FlightRecorderMXBeanImpl.java:164`
- `jdk.jcmd/share/classes/sun/tools/jcmd/JCmd.java:114`
- `jdk.jcmd/share/classes/sun/tools/jcmd/JCmd.java:124`

## 9. 版本与边界

- 全文基于 JDK 11。
- `default`/`profile` 的描述、事件项和开销提示以 JDK 11 源码树中的 `.jfc` 模板为准，不外推到所有版本。
- `jcmd JFR.start/JFR.dump/JFR.stop/JFR.check` 的最终执行经过 attach 与 HotSpot 诊断命令链路；本文只把 Java 层可见入口和命令语义当证据，不伪造 native 行号。
- “通常低于 1%”“大约 2%”来自模板描述，是官方经验值，不等于对所有业务负载的保证；生产仍需压测验证。
- 本文不展开 JMC UI，也不展开 `.jfr` 二进制格式。

## 10. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述：为什么临时录制常常太晚、为什么持续背景录制需要窗口预算、为什么 `default/profile` 是成本预算而不是轻重标签、为什么 `dump` 比 `stop` 更像事故现场保全动作、为什么 JFR 需要和监控/JMX/脚本消费组合成闭环。
- 小标题必须能还原“问题 → 失败方案 → 顿悟 → 机制拆解 → 收网”。
- 至少写清 3 个以上失败方案和 3 个以上常见误解。
- 必须自然承接前五篇，并作为 39-jfr 域的收官篇把主线压回“生产闭环与成本预算”。
