# C 组就绪度核对(C1/C2)— 48 域逐域验证表

> 2026-08-11 | 依据: KP 09 表 + materials/INDEX.md 全量登记 | C1: 每域确认状态 | C2: ✗ 域复核
> 状态: ✅ 有实测输出可引用 | 🟡 有数据待补(GUI 见附录 G / 特定场景) | 🔴 无实测 | ✗ 无工具途径(源码分析)

| 域 | 名称 | 状态 | 素材位置(materials/) | 备注 |
|---|---|---|---|---|
| 01 | OS 抽象层 | ✅ | commands/jcmd-VM.info.txt + screenshots/01-jmc-environment.png | 环境页(AMD EPYC/TencentOS)+ VM.info 1246 行 |
| 02 | Assembler | 🟡 | screenshots/a1-jitwatch.png | 反汇编视图归附录 G4(JITWatch disassembly);CLI 无直接面 |
| 03 | Arguments & Flags | ✅ | commands/jcmd-VM.flags{-annotated}.txt / arthas-vmoption.txt / jhsdb-jinfo.txt / jcmd-VM.set_flag.txt / jcmd-VM.command_line.txt | 四视角: 生效值/Arthas ORIGIN/SA/运行期改 |
| 04 | Logging | ✅ | commands/jcmd-VM.log{-annotated}.txt | 语法+实操+list/disable |
| 05 | CPU Primitives | ✗ | - | C2 复核: 无工具途径(REVIEW v1/v2 已定) |
| 06 | OOPs | ✅ | commands/clhsdb-inspect.txt(InstanceKlass 40 字段)/ clhsdb-class.txt / jmap-clstats.txt / mat-leak.txt | markWord/_java_mirror/_class_loader_data 实测 |
| 07 | ClassFile & ClassLoader | ✅ | commands/javap-*.txt ×4 / jcmd-VM.class_hierarchy.txt / VM.classloader_stats.txt / jdeps.txt / jdeprscan.txt | 字节码+继承树+加载器统计 |
| 08 | Interpreter | ✅ | commands/jfr-xint-executionsample.txt + jfr-xint-samples.txt | -Xint 实证: Compilation=0(修正见坑 17) |
| 09 | Memory 核心 | ✅ | commands/clhsdb-universe.txt / jmap-histo.txt / jcmd-GC.heap_info.txt / arthas-memory.txt / jstat-*.txt ×12 | G1 分区/堆线/分配统计 |
| 10 | Metaspace | ✅ | commands/jcmd-VM.metaspace{-annotated}.txt | chunk/虚拟空间/共享类 1116 |
| 11 | CDS | ✅ | commands/jcmd-VM.cds{-annotated}.txt | 预期失败+用法(需 RecordDynamicDumpInfo) |
| 12 | Compiler Interface (ci) | 🔴 | - | 无直接观测面(REVIEW: ci 间接) |
| 13 | JIT Framework | ✅ | logs/hotspot.log(609 任务) / jcmd-Compiler.{codecache,codelist,queue}.txt / screenshots/a1-jitwatch.png | JITWatch 细节归 G4 |
| 14 | C1 编译器 | ✅ | logs/hotspot.log(level 1/3 条目) / jcmd-Compiler.codecache.txt(profiled 段) | C1 层级证据在编译日志 |
| 15 | C2 编译器 | ✅ | commands/jfr-inlining-events.txt(4122) / jit-inlining.txt / logs/hotspot.log(level 4) | inline 决策+失败原因分布 |
| 16 | Code Cache | ✅ | commands/jcmd-Compiler.codecache{-annotated}.txt | 三段布局/bounds |
| 17 | Threads | ✅ | commands/jcmd-Thread.print{-annotated}.txt / arthas-thread.txt / jhsdb-jstack.txt / screenshots/01-jmc-threads.png | 四视角齐全 |
| 18 | Safepoint | ✅ | jfr-recordings/rec-demo.jfr(SafepointBegin 2710)+ commands/jfr-default-vs-profile.txt(0→503) | threshold 实证 |
| 19 | Synchronization | ✅ | commands/jfr-monitor.txt(JavaMonitorEnter 317)/ jsnap-all.txt(_sync_Inflations)/ screenshots/01-jmc-lock-instances.png | 三视角 |
| 20 | VM Operations | ✅ | commands/jcmd-VM.events{-annotated}.txt / screenshots/01-jmc-vmoperations.png / jfr-default-vs-profile.txt(0→502) | 三视图闭环 |
| 21 | Shared Runtime | 🟡 | commands/jcmd-VM.info.txt / logs/hotspot.log(make_not_entrant 61 条) | VM.info 覆盖部分;深度无 CLI 面 |
| 22 | Deoptimization | ✅ | jfr-recordings/probe.jfr(875 条) / jcmd-VM.events.txt(20 条段)/ logs/hotspot.log(deoptimized 7) | 三源对照 |
| 23 | Stub Routines | 🟡 | commands/jcmd-Compiler.codecache.txt(non-nmethods 段) | 无 GUI CodeCachePage(归附录 G 之外的 B4 截图) |
| 24 | Frame & Stack Walking | ✅ | commands/jfr-xint-samples.txt / jfr-inlining-events.txt(帧)/ rec-demo.jfr 栈帧 | ExecutionSample 全栈帧 |
| 25 | GC Framework | ✅ | commands/jstat-*.txt ×12 / logs/gc.log(13MB) / screenshots/a2-gcviewer.png / jcmd-GC.heap_info.txt / jfr-default-vs-profile.txt | 全量 |
| 26 | G1 GC | ✅ | commands/clhsdb-universe.txt(G1 分区)/ jcmd-GC.heap_info.txt / jcmd-JFR 录制(EvacuationInformation 487) | 全量 |
| 27 | JNI | 🟡 | commands/jcmd-VM.dynlibs.txt(352 行原生库) | 库清单有;JNI 调用深度无 CLI 面 |
| 28 | JVMTI | 🟡 | commands/jcmd-JVMTI.{agent_load,data_dump}.txt / arthas-trace.txt | 插桩实证有;ClassRedefinition 未触发 |
| 29 | Method Handles | ✗ | - | C2 复核: 无工具途径 |
| 30 | JVM Entry Points | ✗ | - | C2 复核: 无工具途径 |
| 31 | Unsafe & WhiteBox | ✗ | - | C2 复核: 无工具途径 |
| 32 | JFR | ✅ | jfr-recordings/ ×10 + commands/jfr-*.txt + screenshots/01-jmc-*.png ×14 | 最大素材集 |
| 33 | JMX & Management | ✅ | commands/jconsole-mbean.txt(131 行)/ arthas-jvm.txt / jcmd-ManagementAgent.*.txt ×4 / INDEX MBean 树 26 个 | 全量 |
| 34 | NMT | ✅ | commands/jcmd-VM.native_memory{-annotated}.txt | 预期失败即素材(需前置开关) |
| 35 | Diagnostic Commands | ✅ | commands/jcmd-help.txt + jcmd-*.txt ×48 | 49 子命令全量 |
| 36 | Attach API | ✅ | commands/arthas-trace.txt(插桩成本)/ jcmd attach 报错记录(坑 3)/ JMXDump.java 实测 | 正常+异常两案例 |
| 37 | Heap Dumper | ✅ | commands/jmap-*.txt ×4 / oom.hprof / jcmd-GC.heap_dump.txt / mat-leak.txt / heap.hprof | jmap/jcmd/OOM/MAT 四路 |
| 38 | PerfData | ✅ | commands/jsnap-all.txt(192 行)/ jstat-*.txt | jsnap 全量 |
| 39 | Runtime Monitoring | ✅ | commands/jstat-*.txt ×12 / jsnap-all.txt | 双源 |
| 40 | Launcher | 🟡 | commands/jlink.txt(jlink 45MB 运行 `java -version`)/ java-list-modules.txt | jlink 运行时实证;launcher 细节无 CLI 面 |
| 41 | ZIP & JIMAGE | ✅ | commands/jimage-{list,info}.txt / /tmp/jimage-extract/ / jlink.txt | 三连+解包 |
| 42 | Core Native | 🔴 | - | libjava.so 无工具途径(源码分析) |
| 43 | NIO & Net | 🟡 | screenshots/01-jmc-fileio.png + 01-jmc-socketio.png + MBean 树 java.nio ×3 | IO 页无数据即实证(demo 无 IO);BufferPool MBean 有 |
| 44 | Class Verification | 🟡 | commands/javap-Demo-v.txt(StackMapTable 属性) | 字节码属性有;验证器行为无工具面 |
| 45 | Math Library | ✗ | - | C2 复核: 无工具途径 |
| 46 | SA Postmortem | ✅ | commands/clhsdb-{universe,class,inspect}.txt / jhsdb-{jmap,jstack,jinfo}.txt / jsnap-all.txt / jhsdb-vs-jdk.txt | SA 全家桶 |
| 47 | Instrumentation | 🟡 | commands/arthas-trace.txt | agent 机制实证;instrument API 深度无面 |
| 48 | Utilities & Infrastructure | ✅ | screenshots/jmc-main.png / commands/java-list-modules.txt / jdeprscan.txt | JMC 本体+JDK 命令 |

## 统计

- ✅ 就绪: **32** 域(01/03/04/06/07/08/09/10/11/13/14/15/16/17/18/19/20/22/24/25/26/32/33/34/35/36/37/38/39/41/46/48)
- 🟡 半就绪: **9** 域(02/21/23/27/28/40/43/44/47)
- 🔴 空: **2** 域(12/42)
- ✗ 无途径: **5** 域(05/29/30/31/45,C2 复核确认)

> C2 说明: 05/29/30/31/45 五域无任何 JDK 工具/生态工具观测面(REVIEW v1 工具→域矩阵、v2 事件→域矩阵均无条目),维持"源码分析"结论。12-ci/42-core-native 同理无 CLI 面,但 12 可经 JFR CompilerPhase/CompilerConfiguration 间接观察、42 可经 jcmd-VM.dynlibs 部分观察,标 🔴 待写阶段以源码+间接素材处理。

## D3 写作入口确认(阶段 A 五域)

| 写作入口域 | 素材证据 | 状态 |
|---|---|---|
| 32-jfr | jfr-recordings ×10 + JMC 截图 ×14 + jfr-*.txt 命令族 + default-vs-profile 对比 | ✅ 齐备 |
| 28-jvmti | arthas-trace.txt(插桩实测)+ jcmd-JVMTI.{agent_load,data_dump}.txt | 🟡 齐备(ClassRedefinition 场景未触发,写作时以 attach/插桩视角切入) |
| 24-frame | jfr-xint-samples.txt + jfr-inlining-events.txt 全栈帧 | ✅ 齐备 |
| 18-safepoint | rec-demo.jfr SafepointBegin 2710 + default-vs-profile(SafepointBegin 0→503) | ✅ 齐备 |
| 36-attach | arthas attach 实测 + jcmd attach 报错案例(坑 3/19)+ JMXDump.java | ✅ 齐备 |

→ 结论: 阶段 A 五域均可直接进入写作,无需再补采。
