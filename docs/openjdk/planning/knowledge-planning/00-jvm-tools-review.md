# 域 00 深度 REVIEW 报告 — 工具覆盖矩阵(48 域全量核对)

> 2026-08-11 | v1 | 依据: 本机实测(JDK 17 全部工具 + JMC 9.1.2 插件盘点 + jfr 事件实测)+ 48 域权威清单(`00-domain-discovery-v3.md`)
> 触发: 实操中发现 JMC 功能远超规划("六面板"实为 29 页签),用户要求对域 00 做全量重审

---

## 一、REVIEW 发现汇总(按严重度)

### P0 — 规划级缺口(4 项)

1. **JMC 被低估 5 倍**: 规划只写"六面板",实测 flightrecorder.ui 有 **29 个分析页签**,且 12 个页签直接对应写作域(锁实例/VM 操作/TLAB/内存泄漏等)——这些页签就是"域 00 → 实现域"的现成映射表
2. **4 个 JDK 工具整体遗漏**: `jimage`/`jlink`(域 41 ZIP&JIMAGE)、`jdeps`/`jdeprscan`(域 07/48)——之前 14 工具清单里没有
3. **jcmd 3 个关键子命令遗漏**: `VM.events`(域 20 VM 操作+13 编译事件)、`VM.log`(域 04 Logging 配置)、`System.trim_native_heap`
4. **jhsdb jsnap 遗漏**: `jhsdb jsnap --all` 直接输出 PerfData 计数器(域 38)——实测含 `sun.rt._sync_*` 锁计数器(域 19 实证,与 async-profiler lockTracer 对照)

### P1 — 域关联遗漏(6 个域此前无任何工具素材)

| 域 | 遗漏的观测途径(已实测) |
|---|---|
| 20-vm-operations | jcmd `VM.events`、JMC `VMOperationPage`、JFR `jdk.ExecuteVMOperation` |
| 22-deoptimization | JFR `jdk.Deoptimization`(probe.jfr 实测 875 条) |
| 38-perfdata | `jhsdb jsnap --all` |
| 41-zip-jimage | `jimage list modules`(实测)、`jlink`、`jmod` |
| 04-logging | jcmd `VM.log`(配置命令)、JMC `SystemPage` |
| 43-nio-net | JMC `FileIOPage`/`SocketIOPage`、JFR `jdk.FileRead/Write`、`jdk.SocketRead/Write` |

### P2 — 已知但未标注的域关联

- 18-safepoint: JFR `jdk.SafepointBegin/SafepointEnd`(probe 实测)——JMC 有对应页签?无专门页签,Event Browser 可看
- 13/15-jit: jcmd `VM.events` 编译事件、JFR `jdk.Compilation` + `CompilerPhase`
- 07-classfile: `jcmd VM.class_hierarchy`(实测输出继承树)、`VM.systemdictionary`、`VM.stringtable/symboltable`

### P3 — 无直接观测工具(间接途径)

| 域 | 间接途径 |
|---|---|
| 02-assembler | `-XX:+PrintAssembly`(需 hsdis)+ JITWatch bytecode-vs-assembly |
| 05-cpu-primitives | 无(汇编层,perf annotate 可看指令) |
| 08-interpreter | JFR `jdk.ExecutionSample` 的 `state=STATE_INTERPRETED`、MethodProfilingPage 解释/编译区分 |
| 12-ci | 间接(CompilationsPage 背后) |
| 21-shared-runtime | jcmd `VM.info` |
| 23-stub-routines | JMC `CodeCachePage`(stub 段) |
| 29-method-handles | 无直接(域 32 JFR 有 MethodHandleInlining 事件,待验证) |
| 30-jvm-entry-points | 无直接 |
| 31-unsafe-whitebox | 无直接(WhiteBox API 本身) |
| 42-core-native | `jcmd VM.dynlibs`(加载的 native 库清单) |
| 45-math | 无直接(perf 采样可看 libfdlibm 调用) |

---

## 二、48 域 × 工具覆盖矩阵(核心产出)

> 值: 🔴直接观察 / 🟡间接观察 / ✗无途径(需源码分析或代码插桩)
> 工具缩写: JMC=JMC29页签, jcmd=jcmd50子命令, jfr=jfr CLI, jsnap=jhsdb jsnap, jimage=jimage/jlink, jstack, jmap, jstat, jconsole, jhsdb=SA套件, AP=async-profiler, AR=Arthas

| # | 域 | 直接 | 间接 | 工具来源 |
|---|---|---|---|---|
| 1 | OS 抽象层 | 🟡 perf/JMC SystemPage | | JMC |
| 2 | Assembler | 🟡 PrintAssembly+hsdis | | JITWatch |
| 3 | Arguments & Flags | 🔴 jcmd VM.flags/set_flag/VM.system_properties | | jcmd |
| 4 | Logging | 🔴 jcmd VM.log | JMC SystemPage | jcmd |
| 5 | CPU Primitives | ✗ | perf annotate | - |
| 6 | OOPs | 🔴 jhsdb hsdb Inspect / jmap -histo | JMC HeapPage | jhsdb/jmap |
| 7 | ClassFile & ClassLoader | 🔴 jcmd VM.class_hierarchy/classloader_stats/systemdictionary | JMC ClassLoadingPage | jcmd/JMC |
| 8 | Interpreter | 🟡 JFR ExecutionSample state=INTERPRETED | | jfr |
| 9 | Memory 核心 | 🔴 JMC TlabPage/HeapPage | jcmd GC.heap_info | JMC |
| 10 | Metaspace | 🔴 jcmd VM.metaspace | JMC GCConfiguration | jcmd |
| 11 | CDS | 🔴 jcmd VM.cds | | jcmd |
| 12 | Compiler Interface | 🟡 JMC CompilationsPage | | JMC |
| 13 | JIT Framework | 🔴 JMC CompilationsPage / jcmd VM.events | JFR Compilation | JMC/jcmd |
| 14 | C1 | 🟡 JMC CompilationsPage(层数) | JITWatch | JMC |
| 15 | C2 | 🟡 同上 + JITWatch 内联树 | | JMC/JITWatch |
| 16 | Code Cache | 🔴 JMC CodeCachePage / jcmd Compiler.codecache | JFR jdk.CodeCacheStatistics | JMC/jcmd |
| 17 | Threads | 🔴 JMC ThreadsPage/ThreadDumpsPage / jstack / jcmd Thread.print | | JMC/jstack |
| 18 | Safepoint | 🔴 JFR jdk.SafepointBegin | async-profiler(AP-2 采样/safepoint bias) | jfr/AP |
| 19 | Synchronization | 🔴 JMC LockInstancesPage / jsnap sun.rt._sync_* | async-profiler lockTracer / Arthas thread -b | JMC/jsnap |
| 20 | VM Operations | 🔴 JMC VMOperationPage / jcmd VM.events / JFR ExecuteVMOperation | | JMC/jcmd |
| 21 | Shared Runtime | 🟡 jcmd VM.info | | jcmd |
| 22 | Deoptimization | 🔴 JFR jdk.Deoptimization(实测 875 条) | JMC Event Browser | jfr |
| 23 | Stub Routines | 🟡 JMC CodeCachePage(stub 段) | | JMC |
| 24 | Frame & Stack Walking | 🔴 jstack / JFR ExecutionSample 栈 | async-profiler walkFP/walkVM(AP-4) | jstack/AP |
| 25 | GC Framework | 🔴 JMC GarbageCollectionsPage/GCSummaryPage/GCConfigurationPage | jstat -gcutil / jcmd GC.heap_info | JMC/jstat |
| 26 | G1 GC | 🔴 JMC GarbageCollectionsPage / JFR G1* 事件(实测 2682 次) | | JMC/jfr |
| 27 | JNI | 🟡 jcmd VM.dynlibs / JMC NativeLibraryPage | async-profiler RegisterNatives(AP-3) | jcmd/JMC |
| 28 | JVMTI | 🟡 jcmd JVMTI.agent_load/data_dump / JMC AgentsPage | async-profiler 16 回调(AP-3) | jcmd/JMC |
| 29 | Method Handles | ✗ | 待验证 jdk.MethodHandleInlining | - |
| 30 | JVM Entry Points | ✗ | jshell/launcher 间接 | - |
| 31 | Unsafe & WhiteBox | ✗ | WhiteBox API 本身 | - |
| 32 | JFR | 🔴 JMC 全部页签 / jfr CLI / jcmd JFR.* | async-profiler JFR 输出(AP-5) | JMC/jfr |
| 33 | JMX & Management | 🔴 jconsole / JMC MBean 浏览器 / jcmd ManagementAgent.* | Arthas jvm/dashboard(AR-4) | jconsole/JMC |
| 34 | NMT | 🔴 jcmd VM.native_memory | | jcmd |
| 35 | Diagnostic Commands | 🔴 jcmd help(50 命令实证) | Arthas 命令框架(AR-2) | jcmd |
| 36 | Attach API | 🔴 jcmd/jmap/jstack attach 本身 | async-profiler jattach(AP-1)/Arthas(AR-1) | jcmd |
| 37 | Heap Dumper | 🔴 jmap -dump / jcmd GC.heap_dump / JMC MemoryLeakPage | MAT 支配树/泄漏嫌疑 | jmap/MAT |
| 38 | PerfData | 🔴 jhsdb jsnap --all(实测 sun.rt._sync_*) | jstat(读 PerfData) | jhsdb |
| 39 | Runtime Monitoring | 🟡 jstat / jsnap | JMC 实时连接 | jstat |
| 40 | Launcher | 🟡 jcmd VM.command_line | async-profiler AP-1 参数解析 | jcmd |
| 41 | ZIP & JIMAGE | 🔴 jimage list / jlink / jmod(实测) | | jimage |
| 42 | Core Native | 🟡 jcmd VM.dynlibs / jmap -clstats | | jcmd |
| 43 | NIO & Net | 🔴 JMC FileIOPage/SocketIOPage / JFR FileRead/Write | | JMC/jfr |
| 44 | Class Verification | 🟡 javap -v StackMapTable | async-profiler rewriteStackMapTable(AP-3) | javap |
| 45 | Math Library | ✗ | perf 采样 libfdlibm | - |
| 46 | SA Postmortem | 🔴 jhsdb hsdb/clhsdb(全部) | | jhsdb |
| 47 | Instrumentation | 🟡 jcmd JVMTI.agent_load / JMC AgentsPage | Arthas(AR-1/2)/async-profiler(AP-3) | jcmd/AR |
| 48 | Utilities & Infra | 🟡 jcmd VM.info/VM.uptime/VM.version | jdeps/jdeprscan | jcmd |

**统计**: 🔴直接 30 域 / 🟡间接 13 域 / ✗无途径 5 域(05-cpu-primitives、29-method-handles、30-jvm-entry-points、31-unsafe、45-math)

---

## 三、与 v2 KP 的差距清单(逐条)

| v2 KP 现状 | 实测真相 | 修正动作 |
|---|---|---|
| 14 工具 | JDK bin 有 18 个相关工具(多 jimage/jlink/jdeps/jdeprscan) | 工具清单 15→19 |
| JMC "六面板" | 29 分析页签 + 实时控制台 + MBean 浏览器 + JOverflow | 补 29 页签按域分组表 |
| 关联 18 域 | 可覆盖 43 域(30 直接 + 13 间接),新增 20/22/38/41/04/43 | 关联域更新 |
| 无域 19 素材 | LockInstancesPage + jsnap sun.rt._sync_* | 补篇 1/3 素材 |
| 无域 20 素材 | VMOperationPage + VM.events + ExecuteVMOperation | 补篇 2 素材 |
| 无域 38 素材 | jsnap --all | 补篇 5/6 素材 |
| 无域 41 素材 | jimage/jlink | 新增篇 4 内容或篇 2 |
| 无域 04 素材 | VM.log | 补篇 2 |
| 无域 43 素材 | FileIOPage/SocketIOPage | 补篇 1 页签清单 |

---

## 四、建议行动

1. **KP v3 修订**: 工具 19 个、JMC 29 页签映射表、关联域 43 个、新增"无直接工具域"清单(5 域走源码分析)
2. **篇 1 大纲 v3**: "六面板"→ 29 页签按域分组;补 LockInstancesPage/VMOperationPage/TlabPage/MemoryLeakPage 等
3. **篇 2 大纲 v3**: 补 VM.events/VM.log/VM.cds/VM.metaspace 子命令及对应域
4. **篇 5 大纲 v3**: 补 jsnap --all(PerfData/域 38)
5. **新篇 7 候选**: "jimage/jlink/jdeps: 模块与镜像工具"(域 41/07)——或并入篇 2
6. **写作域补充素材表**: 20/22/38/41/04/43 六域已有工具侧素材入口,写作时优先引用
