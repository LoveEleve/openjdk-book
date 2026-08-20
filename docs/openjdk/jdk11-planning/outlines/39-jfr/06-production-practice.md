# 06. JFR 生产实践 — jcmd 操作、飞行记录、性能评估

> 🟡 Working | 域 39 JFR 第 6 篇(巨型域 6 篇之六)| Layer 4
> 读者处境: 生产用 JFR 排查——命令、场景、开销评估。

### 1. "jcmd 操作 JFR" — 命令行

场景: 线上开启 60 秒录制——命令是什么?

- `jcmd <pid> JFR.start name=debug duration=60s filename=/tmp/dbg.jfr`
- `JFR.dump`(导出当前缓冲)/`JFR.stop`(停止)
- `JFR.check`(查看录制状态)
- 底层: 通过 attach(域 25)/DiagnosticCommand(域 34)调用
- 关键设计 (斜体): *"JFR 运维三命令 start/dump/stop"——生产排查的标准动作;面试"线上怎么开 JFR"——jcmd JFR.start*
- 生产: 问题复现时开启(无需重启);生产默认可关(低开销可常开)
- [关联: 域 25 诊断工具;jcmd 实现]

### 2. "排查场景" — 飞行记录的用途

场景: 线上卡顿/内存问题——JFR 看什么?

- GC 问题: GC 事件(暂停时长/频率/各代大小)
- 锁问题: 锁事件(竞争/等待)
- 性能: CPU 采样/方法耗时事件/分配事件
- 关键设计 (斜体): *"JFR = 问题回放"——事件按时间线回放(暂停/锁/GC 前后对照);面试"JFR 能查什么"——GC/锁/IO/分配全维度*
- 生产: 事故复盘标配(采集留档)

### 3. "性能开销评估" — 常开可行吗

场景: 生产常开 JFR——开销多少?

- 设计目标: <1% 开销(默认配置)
- 开销来源: 事件写入(缓冲/锁)/后台刷盘/启用事件数量
- 控制: default 配置(低事件量)+ 阈值过滤 + 环形缓冲大小
- 关键设计 (斜体): *"开销 = 事件量 × 单事件成本"——default 配置常开可接受,profile 需按需;面试"JFR 常开吗"——多数生产可常开(default)*
- 生产: 核心服务常开 default(出事有据可查);压测验证 overhead
- [内部卷: 32-jfr(开销的 native 侧依据)]

### 4. "与监控集成" — 生态衔接

场景: JFR 数据怎么进监控系统?

- 连续录制: 常开 + 定期 dump/保留环形缓冲
- 集成方式: 脚本定时 JFR.dump → 分析工具;或 JMX(域 34 jdk.management.jfr)
- 事件导出: 自定义分析(consumer API)接入指标
- 关键设计 (斜体): *"JFR 是原始数据,监控系统是消费端"——采集与展示解耦;面试"JFR vs 监控"——JFR 事后深挖,监控实时告警(互补)*
- 生产: JFR(深挖)+ Prometheus(实时)组合
- [关联: 域 34 JMX(jdk.management.jfr 管理接口)]

---

### 核心悬念

可观测性收官——**并发体系的最后一块**: 并发集合与线程池。`ConcurrentHashMap` 的 CAS+同步组合、`ThreadPoolExecutor` 的 Worker 生命周期、`ForkJoin` 的 work-stealing——下一篇(按写作顺序)进 Layer 5: 域 10 并发集合。

> → 下一篇: 域 10 并发集合(10-concurrent-collections 系列) | 关联: 域 12/13/14
