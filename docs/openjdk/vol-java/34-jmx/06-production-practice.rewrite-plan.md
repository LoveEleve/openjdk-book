# 34-jmx/06 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ManagementFactory`、平台 MBean、`DiagnosticCommandImpl`、GC 通知、平台 MBeanServer 上的自定义注册。本文聚焦生产使用模式与安全边界；JFR 对照仅作后续引子。
> 目标：把“JMX 生产实践”改写成一篇围绕“JMX 真正的生产价值，不在于偶尔打开 JConsole 看图，而在于把 JVM 内部状态、自定义业务指标和诊断命令统一收束成一个可采集、可告警、可自动化、但同时必须被严格保护的管理面”展开的机制文章。

## 1. 读者困惑

- 线上真正监控 JVM 时，JMX 到底提供了哪几类生产能力？
- 内存、线程、GC 这些平台指标是从哪里来的，为什么程序内 API 和外部监控读到的是同一批数据？
- `jcmd` 那套诊断命令为什么也能通过 JMX 暴露出来？
- 自定义业务指标该怎么接进平台 MBeanServer，为什么通常推荐 MXBean？
- 远程 JMX 为什么既是管理入口，又可能变成高危攻击面？

## 2. 一句话顿悟

**JMX 在生产里的真正价值，是把三类本来可能四散分布的能力收束成同一管理面：平台 MBean 暴露 JVM 内部状态，自定义 MXBean 暴露业务运行指标，DiagnosticCommand MBean 暴露诊断命令入口。这样，程序内 API、JConsole、外部监控系统和自动化诊断脚本都能围绕同一个平台 MBeanServer 工作；代价则是，这条管理面一旦远程暴露，必须按高权限入口来保护。**

## 3. 旧稿优点与问题

### 保留

- 已抓到平台 MBean、GC 通知、DiagnosticCommandImpl、自定义 MXBean 注册和远程安全开关这些关键落点。
- 已把 `DiagnosticCommand` 与 `jcmd` 同源性说出来，这是很好的收束点。
- 已给出认证/SSL/网络隔离三件套，生产边界正确。

### 必须重写

- 旧稿偏实践清单，需要先立住总问题：JMX 在生产里的“统一管理面”价值是什么。
- 平台指标、自定义指标、诊断命令要统一到“同一 MBeanServer 管理面”这条主线上。
- `DiagnosticCommand` 要讲成“jcmd 命令被 MBean 化”，而不是又一个独立小专题。
- 安全部分要更明确回扣：为什么这条管理面权限高，所以不能裸露。

## 4. 理解路径

### 第一节：从“线上真正怎么用 JMX”开场

先立总问题：JMX 在生产里不是单一监控接口，而是 JVM 运行状态、业务指标和诊断命令的汇合点。

### 第二节：为什么平台 MBean 是 JVM 运维的默认数据面

证据：
- `ManagementFactory.java:342/352/429/475`
- `MemoryImpl.java:46`
- `GarbageCollectorImpl.java:38/46/49`
- `GarbageCollectionNotificationInfo.java:100/147/156/165/174`

主线：
- 程序内 API 和远程工具都围绕平台 MBeanServer 读同一批平台对象。
- GC 既可以轮询统计，也可以走通知模型拿单次事件明细。
- 这解释了 JMX 为什么是 JVM 观测统一视图。

### 第三节：为什么 `DiagnosticCommand` 让 `jcmd` 命令也变成管理面的一部分

证据：
- `DiagnosticCommandImpl.java:60/151/159/170/188/195/418/420`

主线：
- `getMBeanInfo()` 动态枚举诊断命令并暴露为 MBean 操作。
- `execute(String[] args)` 最终转发到 native `executeDiagnosticCommand`。
- 这说明 `jcmd` 与 JMX DiagnosticCommand 是同源诊断入口的两种接入方式。

### 第四节：为什么自定义业务指标最自然的落点是平台 MBeanServer 上的 MXBean

证据：
- `ManagementFactory.java:475`
- 旧稿中的 `registerMBean` 用法线索

主线：
- 平台 MBeanServer 已经是统一管理面，自定义指标直接挂进去最自然。
- MXBean 比标准 MBean 更适合远程消费和外部监控发现。
- 属性 getter 必须轻量，否则监控本身会给应用制造负担。

### 第五节：为什么“轮询 + 通知 + 自动化命令”是生产上的三类核心使用方式

主线：
- 平台指标通常靠轮询采集形成仪表盘和告警。
- GC 等关键事件可用通知补充单次细节。
- 诊断命令通过 DiagnosticCommand 形成自动化处置入口。
- 这三者一起构成 JMX 的生产闭环。

### 第六节：为什么远程 JMX 既是管理面，也是攻击面

主线：
- 一旦远程开放，外部不仅能读指标，还可能调操作、触发诊断命令。
- 认证、SSL、网络隔离不是附加建议，而是保护高权限管理面的最低要求。
- 这要把安全问题直接和 `DiagnosticCommand`、自定义 MBean 控制能力挂钩。

## 5. 失败方案清单

1. 把 JMX 只当作偶尔人工点开 JConsole 的观测接口。
2. 只采平台指标，不把业务关键状态统一暴露进同一管理面。
3. 让自定义 MBean getter 做重计算或带副作用，拖慢采集线程。
4. 把 `jcmd` 诊断和 JMX 诊断当作两套无关体系，错失自动化入口。
5. 在生产中裸露未认证的远程 JMX 端口。

## 6. 误解清单

1. `ManagementFactory` API 和 JConsole 读到的是两套不同来源的数据。
2. JMX 主要适合人工查看，不适合自动化采集和诊断脚本。
3. GC 监控只能靠轮询统计，看不到单次事件细节。
4. DiagnosticCommand 只是命令行工具内部实现，与 MBean 无关。
5. 远程 JMX 只读指标，不会形成高危权限面。

## 7. 证据清单

- `ManagementFactory.java:342/352/429/475`
- `MemoryImpl.java:46`
- `GarbageCollectorImpl.java:38/46/49`
- `GarbageCollectionNotificationInfo.java:100/147/156/165/174`
- `DiagnosticCommandImpl.java:60/151/159/170/188/195/418/420`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦生产使用模式，不展开 Prometheus/Exporter 具体部署配置细节。
- 远程安全只保留 JMX 层最小原则，不扩展成完整 RMI 安全教程。
- JFR 只作为后续更强持续观测手段的引子。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“JMX 生产价值为什么是统一管理面 → 平台 MBean 如何提供 JVM 指标 → DiagnosticCommand 如何把 jcmd 能力 MBean 化 → 自定义 MXBean 如何并入平台 MBeanServer → 为什么轮询/通知/自动化命令组成生产闭环 → 为什么远程 JMX 必须按高权限入口保护”。
- 必须把生产实践讲成‘统一管理面’而不是分散技巧。
- 必须自然收束 `34-jmx` 全域，并引到后续域。
