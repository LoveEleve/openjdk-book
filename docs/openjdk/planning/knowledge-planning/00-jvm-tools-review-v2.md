# 域 00 深度 REVIEW 报告 v2 — JFR 事件契约级核对(170 事件 × 48 域)

> 2026-08-11 | v2 | 依据: `jfr metadata` 全量导出(170 事件,实测)+ JMC 74 条规则(services 实证)+ rec-demo/probe 录制实测
> 层级说明: v1 REVIEW 是"工具→域"(页签/命令级);v2 下沉到**"JFR 事件→域"**(工具与 JVM 之间的数据契约级)——写作素材的最细粒度索引

---

## 一、v2 核心发现(在 v1 基础上的增量)

### 1. JFR 事件是"域 00 → 48 域"的最细粒度契约(170 个)

`jfr metadata` 实测导出 **170 个 jdk.* 事件类型**。每个事件 = 一个"JVM 内部机制的可观测切片"——写哪个域的文章,直接查"该域有哪些事件"。v1 的"页签/命令"映射全部由事件层支撑。

### 2. 域 29 MethodHandles 证实无 JFR 观测面

v1 标注"待验证 jdk.MethodHandleInlining"——**实测 170 事件中无任何 MethodHandle 事件**。矩阵更新:域 29 = ✗ 无 JFR 面(只能源码分析/或 javap 观察 invokehandle 字节码)。

### 3. 新增 8 个 v1 未标注的事件级素材入口

| 事件 | 域 | 价值 |
|---|---|---|
| jdk.CompilerInlining | 15-c2 | 内联决策实证(与 JITWatch 内联树/async-profiler [inlined] 三视图) |
| jdk.BiasedLock* 系列(3 个) | 19-sync | 偏向锁撤销/重偏向——Arthas/async-profiler 无此视角 |
| jdk.ThreadContextSwitchRate | 17-threads | 上下文切换率 |
| jdk.DirectBufferStatistics | 43-nio-net | DirectBuffer 使用 |
| jdk.OldObjectSample | 37-heap-dumper | MemoryLeakPage 数据源(泄漏分析事件!) |
| jdk.ExecuteVMOperation | 20-vm-ops | VM 操作事件(2709 条实测) |
| jdk.SafepointBegin/End/Cleanup/StateSynchronization(5 个) | 18-safepoint | safepoint 全过程(2710 条实测)——域 18 最强素材 |
| jdk.Container* 系列(5 个) | 01-os | cgroup/容器资源(容器环境写作亮点) |

### 4. JMC 自动分析规则 74 条(新维度)

`flightrecorder.rules.jdk` 插件 **74 条规则**(services 实证): GcPauseRatio/LongGcPause/HighJvmCpu/SystemGc/FullGc(域 25/26)、VMOperation(域 20)、BiasedLockingRevocation(域 19)、TlabAllocationRatio(域 9)、AllocationByClass/AllocationByThread(域 9)、CodeCache(域 16)、ClassLeaking(域 7/37)、MetaspaceOom(域 10)、DynamicallyLoadedAgents/MultipleAgents(域 28/47)、StackDepthSetting/MethodProfiling(域 32)、FileRead/Write、SocketRead/Write(域 43)、PasswordsIn* (域 48)、CompressedOops(域 6)、StringDeduplication(域 25)等

> 意义: "Automated Analysis" 不是摆设——74 条规则本身就是"工具侧对 JVM 健康维度的权威清单",写作时可引用规则→事件→域的链条。

### 5. ExecutionSample.state 证实可区分解释/编译(域 08)

metadata 实测: `ExecutionSample.state`(String, 值为 STATE_INTERPRETED/STATE_RUNNABLE 等)——域 08 解释器/域 13 编译的采样面确认(此前为推断)。

---

## 二、170 JFR 事件 × 48 域映射(核心产出)

> 实测来源: `jfr metadata rec-demo.jfr`。★=本机录制实测有数据。

| 域 | 事件(数量) | 代表事件 |
|---|---|---|
| 01-OS | 13 | CPUInformation、OSInformation、SystemProcess★、PhysicalMemory、CPULoad★、Container* (5)★、VirtualizationInformation、InitialEnvironmentVariable★ |
| 03-Flags | 16 | BooleanFlag★/IntFlag★/LongFlag★/StringFlag★/DoubleFlag★/Unsigned* + 全部 FlagChanged + ActiveSetting★、InitialSystemProperty★ |
| 04-Logging | 0 | (无 JFR 事件,走 jcmd VM.log) |
| 06-OOPs | 2 | ObjectCount、ObjectCountAfterGC |
| 07-ClassFile | 12 | ClassLoad、ClassDefine、ClassUnload、ClassLoaderStatistics★、ClassLoadingStatistics★、ModuleExport★、ModuleRequire★、StringTableStatistics、SymbolTableStatistics、LoaderConstraintsTableStatistics、PlaceholderTableStatistics、ProtectionDomainCacheTableStatistics |
| 08-Interpreter | 1 | ExecutionSample(state=STATE_INTERPRETED)★ |
| 09-Memory | 6 | ObjectAllocationInNewTLAB、ObjectAllocationOutsideTLAB、ObjectAllocationSample★、AllocationRequiringGC★、ThreadAllocationStatistics★(351 条)、DirectBufferStatistics★ |
| 10-Metaspace | 5 | MetaspaceSummary★、MetaspaceAllocationFailure、MetaspaceChunkFreeListSummary★、MetaspaceGCThreshold、MetaspaceOOM |
| 13-JIT | 6 | Compilation、CompilationFailure、CompilerConfiguration、CompilerPhase、CompilerStatistics★、JITRestart |
| 15-C2 | 1 | **CompilerInlining**(v2 新增) |
| 16-CodeCache | 6 | CodeCacheConfiguration、CodeCacheFull、CodeCacheStatistics★、CodeSweeperConfiguration、CodeSweeperStatistics、SweepCodeCache |
| 17-Threads | 8 | JavaThreadStatistics★、ThreadStart、ThreadEnd、ThreadSleep★、ThreadPark、ThreadCPULoad★、**ThreadContextSwitchRate★**、ThreadAllocationStatistics★ |
| 18-Safepoint | 5 | SafepointBegin★(2710)、SafepointEnd、SafepointCleanup、SafepointCleanupTask、SafepointStateSynchronization |
| 19-Sync | 7 | **BiasedLockClassRevocation、BiasedLockRevocation、BiasedLockSelfRevocation(v2 新增)、JavaMonitorEnter、JavaMonitorInflate、JavaMonitorWait、SyncOnValueBasedClass** |
| 20-VM-Ops | 2 | **ExecuteVMOperation★(2709)、SystemGC** |
| 21-Shared-Runtime | 3 | ExceptionStatistics★、JavaErrorThrow、JavaExceptionThrow |
| 22-Deopt | 1 | Deoptimization★(probe 实测 875 条) |
| 24-Frame | 3 | ExecutionSample★、NativeMethodSample、ReservedStackActivation |
| 25-GC-Framework | 16 | GarbageCollection★、GCConfiguration、GCHeapConfiguration、GCHeapSummary★、GCLocker、GCPhaseConcurrent★、GCPhaseParallel★(229万)、GCPhasePause★、GCReferenceStatistics★、GCSurvivorConfiguration、GCTLABConfiguration、TenuringDistribution★、YoungGenerationConfiguration、GCTLABConfiguration、GCPhasePauseLevel1-4★ |
| 26-G1/收集器 | 19 | G1GarbageCollection★、G1HeapSummary★、G1MMU★、G1EvacuationYoung/OldStatistics★、G1AdaptiveIHOP★、G1BasicIHOP★、EvacuationInformation★、PromoteObject*PLAB★、YoungGarbageCollection★、OldGarbageCollection、ConcurrentModeFailure、EvacuationFailed、PromotionFailed、PSHeapSummary、ParallelOldGarbageCollection、Shenandoah* (3)、Z* (9,域 26 变体) |
| 27-JNI | 1 | NativeLibrary★ |
| 28-JVMTI | 3 | ClassRedefinition、RedefineClasses、RetransformClasses |
| 29-MethodHandles | **0** | **证实无 JFR 面(v2 修正)** |
| 32-JFR | 5 | ActiveRecording、ActiveSetting★、DumpReason、DataLoss、Flush |
| 37-HeapDump | 2 | HeapDump、**OldObjectSample★(v2 新增)** |
| 40-Launcher | 2 | ProcessStart、InitialEnvironmentVariable★ |
| 42-Core-Native | 3 | NativeMethodSample、X509Certificate、X509Validation |
| 43-NIO-Net | 8 | FileForce、FileRead、FileWrite、SocketRead、SocketWrite、NetworkUtilization、TLSHandshake、DirectBufferStatistics★ |
| 48-Utilities | 5 | JVMInformation、Shutdown、SecurityPropertyModification、SecurityProviderService、Deserialization |

**无事件域(10 个)**: 04-logging、05-cpu-primitives、11-cds、12-ci、14-c1、23-stub、29-method-handles、30-entry-points、31-unsafe、34-nmt、45-math、46-sa(部分有非 JFR 面)
> 说明: 无 JFR 事件 ≠ 不可观测——04/34 走 jcmd(VM.log/VM.native_memory),11 走 jcmd VM.cds,23 走 JMC CodeCachePage,46 走 jhsdb,14 的编译层数在 Compilation 事件里有 native 标志。

---

## 三、v1 矩阵存疑项验证结果

| v1 标注 | v2 实测 | 结论 |
|---|---|---|
| 域 08 "JFR ExecutionSample state=INTERPRETED" | ExecutionSample.state 字段实证 | ✅ 确认 |
| 域 29 "待验证 jdk.MethodHandleInlining" | 170 事件无 MethodHandle | ❌ 确认不存在 → 域 29 降为 ✗ |
| 域 13/15 编译素材 | Compilation/CompilerPhase/CompilerInlining 全存在 | ✅ 确认,补 CompilerInlining |
| 域 18 safepoint | Safepoint* 5 事件,2710 条实测 | ✅ 确认(写作素材量级) |
| 域 20 VM 操作 | ExecuteVMOperation 2709 条 + VMOperationPage + VM.events | ✅ 确认(三来源) |
| 域 37 泄漏 | OldObjectSample + MemoryLeakPage + JOverflow + MAT | ✅ 确认(四来源) |

---

## 四、建议行动(v2)

1. **KP v4**: 新增"170 事件 × 48 域"索引表(上表)+ "74 规则"清单——写作素材检索入口
2. **写作素材库建设**: 阶段 1 实操按域归档事件样例(已有 rec-demo.jfr 含 90 类有数据事件)
3. **篇 1 大纲**: 补 "Event Browser 是域级素材检索入口"——按域查事件(替换"事件列表"笼统描述)
4. **域 18/20/19 写作素材预标注**: SafepointBegin(2710)/ExecuteVMOperation(2709)/GCPhaseParallel(229万)事件量级=可直接引用的实证数字
5. **篇 6 补规则引擎素材**: 74 条规则 = "JMC 自动分析"不再是黑盒(引用规则→事件→域链条)
