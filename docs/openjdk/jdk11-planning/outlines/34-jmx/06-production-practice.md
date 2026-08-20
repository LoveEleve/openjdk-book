# 06. JMX 生产实践 — 平台指标、DiagnosticCommand、自定义暴露

> 🟡 Working | 域 34 JMX 第 6 篇(巨型域 6 篇之六)| Layer 4
> 读者处境: 生产监控/排查——JMX 读什么、怎么执行诊断命令、怎么暴露业务指标。

### 1. "内存与 GC 监控" — 平台指标

场景: 线上内存告警——JMX 能读到什么?

- `sun.management` 平台 MBean(java.lang 域): MemoryMXBean(堆/非堆使用)/GarbageCollectorMXBean(GC 次数/耗时)
- `jdk.management` 扩展: GarbageCollectorExtImpl(GC 通知含 cause/内存变化明细,GcInfoBuilder)
- 采集方式: 轮询(getAttribute)+ GC 通知(GarbageCollectionNotificationInfo)
- 关键设计 (斜体): *"JMX 是 JVM 运维的统一视图"——内存/GC/线程/类加载全暴露;面试"线上怎么监控 JVM"——JMX 平台 MBean + 外部采集*
- 生产: 监控系统(Prometheus jmx_exporter)采集 GC 次数/堆使用率告警
- [关联: 内部卷 33-jmx-management(JVM 侧数据源)]

### 2. "DiagnosticCommand" — jcmd 的 JMX 通道

场景: 远程执行 jcmd 命令(Thread.print 等)——通过 JMX?

- `DiagnosticCommandImpl.java:60` — jdk.management 的 MBean: `execute(command)`(151-170)→ native `getDiagnosticCommands`(418)
- 命令: GC.class_histogram/Thread.print/VM.flags 等(域 25 工具关联)
- 意义: **远程诊断**(非交互环境也能执行)
- 关键设计 (斜体): *"诊断命令 = JVM 管理操作的统一入口"——jcmd 与 JMX 的 DiagnosticCommand 同源(native 实现);面试"远程怎么执行 jcmd"——DiagnosticCommand MBean*
- 生产: 自动化诊断脚本通过 JMX 触发
- [关联: 内部卷 35-dcmd(诊断命令框架)]

### 3. "自定义业务指标" — MXBean 实践

场景: 团队要监控"订单积压量"——怎么暴露?

- 定义 MXBean 接口 + 实现 → `ManagementFactory.getPlatformMBeanServer().registerMBean(impl, new ObjectName("com.app:type=Order,name=Metrics"))`
- 属性: 积压量/吞吐(实时计算);操作: reset 计数
- 采集: 外部监控轮询/或主动 Notification
- 关键设计 (斜体): *"自定义 MXBean = 业务可观测性"——三步: 接口/实现/注册;面试"怎么暴露业务指标"——MXBean 注册到平台 MBeanServer*
- 生产: 与 Prometheus 等集成(或直接 Metrics 库,域外);注意属性方法开销(轮询频率)

### 4. "安全与配置" — 生产开关

场景: 开启远程 JMX——安全怎么配?

- 启用: `-Dcom.sun.management.jmxremote`(本地)/`.port=9010`(远程)
- 安全: `.authenticate=true`(密码文件)/`.ssl=true`(证书)/`.access.file`(只读)
- 风险: 未认证 JMX = 远程 RCE 面(可执行诊断命令/改配置)
- 关键设计 (斜体): *"JMX 是管理通道也是攻击面"——生产必须认证+SSL+网络隔离;面试"JMX 安全"——认证/SSL/防火墙三件套*
- 生产: 内网单独端口 + 防火墙白名单;云环境用 agent 模式(域外)

---

### 核心悬念

JMX 收官——**JFR** 来了: 事件录制怎么不卡业务?`jdk.jfr` 的 Event/Recording API、飞行记录的分析——下一篇: 域 39 JFR(生产可观测性收官)。

> → 下一篇: 域 39 JFR(39-jfr 系列) | 关联: 内部卷 32-jfr(native 录制引擎)
