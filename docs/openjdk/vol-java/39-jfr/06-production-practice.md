# 06. JFR 生产实践 — jcmd 操作、飞行记录、性能评估

> **前置依赖**: [39-jfr/01 — JFR 全景与事件模型](01-jfr-overview-event-model.md)(三物件)、[39-jfr/04 — 录制与配置](04-recording-config.md)(Recording 会话)、[34-jmx/06 — JMX 生产实践](../34-jmx/06-production-practice.md)(DiagnosticCommand 通道)
> → **后续**: 域 10 并发集合(10-concurrent-collections 系列,按写作顺序)
> 关联: 内部卷 32-jfr(native 录制引擎);内部卷 36-attach(attach 连接)

## 生产怎么用 JFR

前五篇把 JFR 机制讲完了——这一篇收官: 线上怎么操作、看什么、开销多少、怎么和监控集成。

## 1. "jcmd 操作 JFR" — 命令行

### 1.1 四命令

```
jcmd <pid> JFR.start name=debug duration=60s filename=/tmp/dbg.jfr
jcmd <pid> JFR.dump    name=debug filename=/tmp/dbg.jfr   # 导出当前缓冲
jcmd <pid> JFR.stop    name=debug                          # 停止
jcmd <pid> JFR.check                                      # 查看录制状态
```

### 1.2 底层通道

jcmd 工具经 **attach** 连接(内部卷 36-attach),命令经 **DiagnosticCommand** 通道执行(域 34 第 6 篇 §2);JFR 命令是 JVM 诊断命令(树外 native 实现)。

面试"线上怎么开 JFR": jcmd JFR.start——生产排查的标准动作,问题复现时开启(无需重启);生产也可常开 default(低开销)。

关键设计(斜体):*"JFR 运维四命令 start/check/dump/stop"——生产排查的标准动作。面试"线上怎么开 JFR": jcmd JFR.start;生产: 问题复现时开启(无需重启),default 配置可常开。*

## 2. "排查场景" — 飞行记录的用途

### 2.1 三类问题

| 问题 | 看什么事件 |
|------|-----------|
| GC 问题 | GC 事件(暂停时长/频率/各代大小) |
| 锁问题 | 锁事件(竞争/等待) |
| 性能 | CPU 采样/方法耗时事件/分配事件 |

### 2.2 问题回放

事件按时间线回放(暂停/锁/GC 前后对照)——事故复盘标配(采集留档)。

面试"JFR 能查什么": GC/锁/IO/分配全维度。

关键设计(斜体):*"JFR = 问题回放"——事件按时间线回放(暂停/锁/GC 前后对照)。面试"JFR 能查什么": GC/锁/IO/分配全维度;生产: 事故复盘标配(采集留档)。*

## 3. "性能开销评估" — 常开可行吗

### 3.1 开销模型

- 官方预置 default 的描述示例就是 *"Low overhead configuration safe for continuous use in production environments"*(`Configuration.java:97-100`)
- 开销来源: 事件写入(缓冲/锁)/后台刷盘/启用事件数量
- 控制手段: default 配置(低事件量)+ 阈值过滤 + 缓冲大小

### 3.2 常开决策

default 配置常开可接受,profile 需按需;核心服务常开 default(出事有据可查),压测验证 overhead。

面试"JFR 常开吗": 多数生产可常开(default)。

关键设计(斜体):*"开销 = 事件量 × 单事件成本"——default 配置常开可接受,profile 需按需。面试"JFR 常开吗": 多数生产可常开(default);生产: 核心服务常开 default,压测验证 overhead。*

## 4. "与监控集成" — 生态衔接

### 4.1 JMX 管理接口

`jdk.management.jfr` 模块的 `FlightRecorderMXBean`(`jdk/management/jfr/FlightRecorderMXBean.java:172`,extends PlatformManagedObject): `newRecording`(`:194`)/`startRecording`(`:262`)/`stopRecording`(`:280`)/`closeRecording`(`:298`)/`getRecordings`(`:570`);实现 `FlightRecorderMXBeanImpl`(`:76`,extends StandardEmitterMBean)——JMX 远程管理 JFR(域 34 通道)。

### 4.2 集成方式

- 连续录制: 常开 + 定期 dump(脚本 `JFR.dump` → 分析工具)
- 事件导出: consumer API(第 5 篇)自定义分析接入指标
- 组合: JFR(事后深挖)+ 监控系统(实时告警,如 Prometheus)——互补

面试"JFR vs 监控": JFR 事后深挖,监控实时告警(互补)。

关键设计(斜体):*"JFR 是原始数据,监控系统是消费端"——采集与展示解耦。面试"JFR vs 监控": JFR 事后深挖,监控实时告警(互补);生产: JFR(深挖)+ Prometheus(实时)组合。*

跨层标注: [内部卷 32-jfr——缓冲/刷盘/native 事件(native 侧依据);域 34 第 6 篇——DiagnosticCommand 通道与 JMX 远程;内部卷 36-attach——jcmd 的 attach 连接]

## 核心悬念

可观测性收官——**并发体系的最后一块**: 并发集合与线程池。`ConcurrentHashMap` 的 CAS+同步组合、`ThreadPoolExecutor` 的 Worker 生命周期、`ForkJoin` 的 work-stealing——下一篇(按写作顺序)进 Layer 5: 域 10 并发集合。

> → 下一篇: 域 10 并发集合(10-concurrent-collections 系列)| 关联: 域 12 锁、域 13 原子