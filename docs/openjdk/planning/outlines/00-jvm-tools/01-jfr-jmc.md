# 01. 先录一次 JFR,看见整个 JVM — JFR 录制与 JMC 可视化

> 🟢 工具域 | 工具: JMC/JFR/jcmd/jfr CLI | 关联 JVM 域: 32-jfr、25-gc、26-g1、17-threads、19-sync、20-vm-ops、09-memory、13-jit、16-code-cache、43-nio-net、37-heap-dumper
> 读者处境: 你要写 JFR 的文章——先亲手录一次,让 JMC 把事件流摊开给你看。
> 修订: 2026-08-11 v2——jfr2flame 标注修正(Arthas 仓库未带 converter.jar,官方 release 才有);改以 jfr CLI 提取 + JMC 自带火焰图
> 修订: 2026-08-11 v3——"六面板"→ 29 分析页签(插件盘点实证);补 LockInstances/VMOperation/Tlab/MemoryLeak/IO 页签及对应域
> 修订: 2026-08-11 v4——Event Browser = 域级素材检索入口(170 事件索引表,KP 05 节);补域 18/19/20 事件量级素材

### 1. "30 秒录一个 JFR" — 三种触发方式

场景: 目标进程在跑,三种方式都能录。

- **jcmd**: `jcmd <pid> JFR.start duration=30s filename=rec.jfr` → `JFR.dump`/`JFR.stop`——命令行精确控制
- **JMC 界面**: JMC 里"Start Flight Recording"(向导: 时间/事件设置)
- **Java 启动参数**: `-XX:StartFlightRecording=duration=30s,filename=rec.jfr`
- **无头提取(JDK 自带 jfr CLI)**: `jfr summary rec.jfr`(事件类型/计数)、`jfr print --events jdk.ExecutionSample rec.jfr`(按事件过滤)——无 GUI 环境的素材提取主力,与 JMC 读取同一文件
- [Java: JFR 是 JDK 内置(域 32),默认开一部分事件;`jcmd JFR.configure` 可调全局设置]

关键设计: **录制是"事件流"不是"快照"**: JFR 文件是一系列带时间戳的事件(GC/线程/分配/编译)——JMC 打开后能看到**时间线**,这是 jstack/jmap 那种"单点快照"给不了的。这正是域 32 的核心概念: 事件驱动采样。

### 2. "JMC 打开后的面板" — 看见什么

场景: 双击 rec.jfr,JMC 打开——从哪看起?

**v3 修订**: JMC 9.1.2 实际有 **29 个分析页签**(插件盘点实证),不是"六面板"。按写作域分组:

- **总览**: Overview(CPU/堆/GC/线程趋势)、JavaApplicationPage、JVMInformationPage、RecordingPage——第一眼
- **GC/内存**: Memory/HeapPage(堆使用)、GarbageCollectionsPage/GC 时间线、GCSummaryPage、GCConfigurationPage(域 25/26 素材)、**TlabPage**(TLAB 分配统计——域 09/25 素材)、Metaspace 相关
- **线程/锁**: **ThreadsPage**(线程状态时间线——域 17)、ThreadDumpsPage(线程转储)、**LockInstancesPage**(锁实例: 谁持有/谁等待——**域 19 synchronization 直接素材**)、**VMOperationPage**(VM 操作: GC 之外的 STW——**域 20 素材**)
- **代码**: Code(CompilationsPage——域 13)、CodeCachePage(域 16)、MethodProfilingPage(方法热点,解释/编译区分——域 08/32)
- **IO/类加载/异常**: ClassLoadingPage(域 07)、FileIOPage/SocketIOPage(域 43)、ExceptionsPage、NativeLibraryPage/AgentsPage(域 27/28/47)
- **事件/分析**: Event Browser(全事件列表——**域级素材检索入口: 写哪个域,按域查事件**,170 个 jdk.* 事件全量可查,见 KP 05 节索引表)、Automated Analysis(JMC 规则引擎 74 条——v4)、**Flame Graph(自带火焰图)/Heat Map/Dependency View**
- **MemoryLeakPage**: JFR 泄漏分析(OldObjectSample——域 37 素材,与 MAT 互补)
- **v4 素材预标注(rec-demo.jfr 实测,可直接引用数字)**: SafepointBegin 2710 条(域 18)、ExecuteVMOperation 2709 条(域 20)、GCPhaseParallel 229 万条(域 25)、PromoteObject*PLAB 306 万条(域 26)——写这些域时引"我录了 30 秒,数到 X 条"比写概念更有力

关键设计: **JMC 是"JFR 格式的第二读者"**: 它能解析 async-profiler 写的 JFR(async-profiler AP-5 的格式对齐目标)——同一文件多解析器,是"格式契约"最直接的验证。v2 实测修正: 交接文档称"async-profiler jfr2flame ✅(Arthas 仓库 converter)"有误——Arthas 仓库嵌入的 async-profiler 仅含 3 个 .so,未带 converter.jar/profiler.sh(jfr2flame 在官方 release 的 converter.jar 中)。对照路线改为: JMC / jfr CLI / async-profiler 原生 JFR 输出三方互证。

**v5 补充 — "两种写者"实证**: async-profiler 写 15 个 JDK 事件 + 自定义 jdk.MethodTrace(jfrMetadata.cpp 源码实测,见 KP 08 节)——同一 .jfr 格式,JDK 写 170 事件、AP 写子集+MethodTrace;GC/编译/safepoint 事件是 JDK 专属,采样/锁/分配是 AP 侧重——域 32 格式契约文章用"两种写者、多种读者"开场。

### 3. "对照与写作素材" — 三工具看同一天线程

场景: 一个 CPU 高的问题,三种工具三种视图。

- `jstack`: 当前时刻线程栈(单点)
- `Arthas thread -n 3`: CPU 采样 Top(窗口平均)
- JFR Threads 面板: 全程时间线(谁在何时烧 CPU)
- **v3 素材补充**: LockInstancesPage(锁竞争可视化)↔ Arthas `thread -b`/async-profiler lockTracer(AP-2)——域 19 三视角;VMOperationPage ↔ jcmd `VM.events`——域 20 双视图
- 写作素材: "三种视图互补"——JFR 时间线是写作域 32 的活例子,Arthas/async-profiler 的线程视角(AR-3/AP-2)可交叉引用

生产注意: JFR 录制有开销(1-2% 级别);生产用 `jcmd JFR.start` 比重启加参数更安全(AP-0 篇 2 同哲学: 按需开)。

---

跨域桥: JFR 格式契约 = async-profiler AP-5 篇 2(jfrMetadata.cpp:41-155);事件驱动 vs 快照 = Arthas AR-4(dashboard Timer 快照对照);写作素材 = 域 32-jfr。
