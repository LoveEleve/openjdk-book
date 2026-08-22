# Vol-02 核心知识覆盖矩阵

> 用途：内部维护与范围声明，不作为书籍正文首页展示。
> 基线：OpenJDK 11u / HotSpot / Linux / x86_64。
> 更新时间：2026-08-21。

## 结论先行

Vol-02 已覆盖 HotSpot 主干运行时的主要知识链：对象与类、类加载、解释器、编译器、代码缓存、线程与同步、Safepoint、反优化、GC、JNI/JVMTI、监控、诊断和 Linux 上的服务性工具。

它可以作为一套完整的 **OpenJDK 11u HotSpot 主干源码阅读卷**，但不应宣传为 OpenJDK 全部模块的百科全书。矩阵中的“覆盖”表示本卷有可进入的源码阅读路径，不表示覆盖该子系统的每一个平台实现、每一种 GC 或每一个外围 JDK 模块。

## 覆盖等级

- **核心**：有连续多篇文章，解释角色、状态、数据流、关键源码和设计取舍；可以作为该主题的主要阅读入口。
- **深入**：有完整机制链和关键实现细节，但范围集中在一个实现、平台或问题切片。
- **入口**：有文章介绍核心结构和调用链，适合建立模型；不等于该子系统的完整专著。
- **边界**：正文明确涉及，但主要用于解释与其他机制的连接，不能单独视为该主题的完整覆盖。
- **范围外**：当前卷没有系统展开，读者需要另建专题或改读其他版本/平台。

## 主干运行时矩阵

| 子系统 | 对应域 | 等级 | 已覆盖的核心问题 | 主要边界 |
|---|---|---:|---|---|
| 操作系统与平台抽象 | [01-os](vol-02/01-os/01-platform-detection.md) | 核心 | 平台探测、虚拟内存、线程同步、信号与 safepoint 触发 | 以 Linux 为主，其他 OS 只保留接口边界 |
| 汇编与机器码生成 | [02-assembler](vol-02/02-assembler/01-codebuffer-abstract-assembler.md) | 深入 | CodeBuffer、寄存器/操作数编码、x86 assembler、MacroAssembler | 以 x86/x86_64 为主；其他 ISA 非系统覆盖 |
| 参数与 Flag | [03-arguments-flags](vol-02/03-arguments-flags/01-flag-definition-system.md) | 入口 | Flag 声明、解析、管理和启动参数边界 | 不覆盖所有产品/诊断参数的逐项语义 |
| 日志 | [04-logging](vol-02/04-logging/01-tag-and-selection.md) | 入口 | 日志标签、选择和输出配置 | 不覆盖所有日志 tag 的业务语义 |
| 原子与内存序 | [05-cpu-primitives](vol-02/05-cpu-primitives/01-atomic-and-memory-order.md) | 深入 | CAS、LOCK、内存屏障、SafeFetch 和平台实现 | 以 x86/Linux 细节为主 |
| 对象模型 | [06-oops](vol-02/06-oops/01-markoop-oopdesc.md) | 核心 | mark word、Klass 层次、InstanceKlass/ArrayKlass、常量池、Access API | 不展开所有 Java 类库对象的特殊布局 |
| ClassFile 与类加载 | [07-classfile-classloader](vol-02/07-classfile-classloader/01-classfile-parser.md) | 核心 | ClassFile、Verifier、Symbol/StringTable、SystemDictionary、ClassLoader、JPMS | 不覆盖所有类库层面的模块加载策略 |
| 解释器 | [08-interpreter](vol-02/08-interpreter/01-bytecodes-definition.md) | 核心 | 字节码定义、模板解释器、InterpreterRuntime、链接与重写 | 以模板解释器为主，不覆盖所有平台解释器细节 |
| 堆与虚拟内存 | [09-memory-core](vol-02/09-memory-core/01-universe-heap.md)、[10-metaspace](vol-02/10-metaspace/01-metaspace-overview.md) | 核心 | Universe、CollectedHeap、VirtualSpace、Arena、Metaspace | 不覆盖所有 GC 专属堆实现 |
| CDS | [11-cds](vol-02/11-cds/01-cds-overview-dump.md) | 深入 | dump、mmap、共享类恢复和接线 | 以 JDK 11u CDS 为主 |
| 编译器接口 | [12-ci](vol-02/12-ci/01-ci-overview-mirror.md) | 深入 | ci 镜像、TypeFlow、逃逸摘要、Arena、replay 和 runtime 工厂 | 不等同于完整 C1/C2 IR 教程 |
| 编译调度 | [13-jit-framework](vol-02/13-jit-framework/01-compile-broker-queue.md) | 核心 | CompileBroker、编译队列、分层策略和资源压力 | 不展开所有编译器服务线程细节 |
| C1 | [14-c1-compiler](vol-02/14-c1-compiler/01-c1-pipeline-ir.md) | 核心 | HIR/LIR、优化、LinearScan、寄存器与 Runtime1/FrameMap | 重点是 JDK 11u C1 主干和 x86 |
| C2 | [15-c2-compiler](vol-02/15-c2-compiler/01-c2-ideal-graph.md) | 核心 | Ideal Graph、Parse/GraphKit、IGVN/CCP/EA、循环、RA、Codegen、Macro/Intrinsic | 不覆盖 C2 每个优化 pass 的全部细节 |
| CodeCache | [16-code-cache](vol-02/16-code-cache/01-codeblob-heap.md) | 核心 | CodeBuffer、CodeBlob、CodeHeap、segmap、nmethod 生命周期、重定位、依赖和 IC | AOT 路径只作边界说明 |
| 线程 | [17-threads](vol-02/17-threads/01-thread-hierarchy.md) | 核心 | Thread/JavaThread 层次、状态、SMR、Handshake、接口守卫 | 不覆盖所有 OS 线程实现差异 |
| Safepoint 与 VM Operation | [18-safepoint](vol-02/18-safepoint/01-safepoint-orchestration.md)、[20-vm-operations](vol-02/20-vm-operations/01-vm-operation.md) | 核心 | 发起、阻塞、轮询、验证、VM 操作和后台初始化 | 不覆盖每种 VM Operation 的业务实现 |
| 同步 | [19-sync](vol-02/19-sync/01-lock-hierarchy.md) | 深入 | 锁层次、ObjectMonitor、enter/exit/wait、内部锁 | 以 JDK 11u monitor 实现为主 |
| Shared Runtime | [21-shared-runtime](vol-02/21-shared-runtime/01-runtime-stubs.md) | 核心 | Runtime Stub、c2i/i2c adapter、异常处理和 Java/C++ 边界 | 不覆盖所有 runtime entry 的逐项实现 |
| 反优化与帧 | [22-deoptimization](vol-02/22-deoptimization/01-deopt-decision.md)、[24-frame](vol-02/24-frame/01-physical-frame.md) | 核心 | 反优化决策、UncommonTrap、Physical/Virtual Frame、OopMap、栈扫描 | 不覆盖所有调试器呈现层 |
| StubRoutines | [23-stub](vol-02/23-stub/01-stub-entry.md) | 深入 | Stub 生成、Arraycopy、数学/加密桩与 CodeCache 落点 | 平台重点为 x86 |
| GC 通用框架 | [25-gc-framework](vol-02/25-gc-framework/01-barrier-access.md) | 核心 | BarrierSet、CollectedHeap、ReferenceProcessor、WorkGang/TaskQueue、OopStorage | 各 GC 的完整策略在其他域 |
| G1 | [26-g1-gc](vol-02/26-g1-gc/01-heapregion.md) | 核心 | Region、并发标记/SATB、RSet、CardTable、分配、Mixed、Barrier、Full GC Roots | 重点是 G1；不是所有收集器总论 |
| JNI | [27-jni](vol-02/27-jni/01-handle-system.md)、[42-core-native](vol-02/42-core-native/01-jni-system.md) | 核心 | Handle、Fast Path、Check、系统调用、进程和 native 边界 | 不覆盖 JNI 全部函数逐项实现 |
| JVMTI | [28-jvmti](vol-02/28-jvmti/01-agent-architecture.md) | 深入 | Agent、Env、Capability、事件发布、RedefineClasses、TagMap | 不覆盖所有 JVMTI 函数语义 |
| MethodHandle | [29-mh](vol-02/29-mh/01-invoke-chain.md) | 深入 | invoke 链、MemberName、LambdaForm、x86 跳转与 adapter 演进 | 以 JDK 11u 实现为主 |
| JVM Entry | [30-jvm-entry](vol-02/30-jvm-entry/01-jvm-entry-points.md) | 深入 | JVM_ENTRY、JavaCalls、反射和 StackWalk | 不覆盖所有 native JVM entry |
| Unsafe/WhiteBox | [31-unsafe-whitebox](vol-02/31-unsafe-whitebox/01-unsafe-api.md) | 入口 | Unsafe API、WhiteBox 和测试/诊断入口 | 不覆盖全部 Unsafe intrinsic |

## 观测、工具与诊断矩阵

| 子系统 | 对应域 | 等级 | 已覆盖的核心问题 | 主要边界 |
|---|---|---:|---|---|
| JFR | [32-jfr](vol-02/32-jfr/01-recorder-engine.md) | 核心 | Recorder、事件元数据、采样、Binary Writer、Leak Profiler、JNI instrumentation | 不覆盖所有事件类型的业务定义 |
| JMX | [33-jmx](vol-02/33-jmx/01-memory-service.md) | 深入 | MemoryService、JMM 接口、GC notifier 与 flags | 重点是 HotSpot 对 MXBean 的实现边界 |
| NMT | [34-nmt](vol-02/34-nmt/01-tracking.md) | 深入 | native 内存 tracking、账本与报告 | 不覆盖所有 malloc 调用点 |
| DCmd | [35-dcmd](vol-02/35-dcmd/01-dcmd-framework.md) | 核心 | 命令注册、参数解析、Builtin DCmd | 不逐项展开全部命令业务 |
| Attach | [36-attach](vol-02/36-attach/01-attach-listener.md) | 核心 | Listener、socket IPC、JDK Attach、agent loading | Linux socket 实现为主 |
| HeapDumper | [37-heap-dumper](vol-02/37-heap-dumper/01-heap-dumper.md) | 深入 | dump 触发、对象遍历、压缩和 hprof 输出 | 不覆盖所有 hprof 消费端 |
| PerfData | [38-perfdata](vol-02/38-perfdata/01-perfdata.md) | 深入 | 共享统计区、采样和低成本发布 | 不覆盖所有 PerfData counter |
| Runtime Monitoring | [39-runtime-monitoring](vol-02/39-runtime-monitoring/01-service-thread.md) | 入口 | ServiceThread、Timer、延迟工作和统计 | 不覆盖所有后台线程 |
| Launcher | [40-launcher](vol-02/40-launcher/01-launch-flow.md) | 深入 | 启动链、参数和平台边界 | 不覆盖所有启动器平台分支 |
| Zip/JImage | [41-zip-jimage](vol-02/41-zip-jimage/01-zip.md) | 入口 | Zip、JImage 和模块资源读取 | 不覆盖完整 ZIP/JImage 格式规范 |
| NIO/网络/文件系统 | [43-nio-net](vol-02/43-nio-net/01-tcp-epoll.md) | 深入 | TCP/epoll、UDP/DNS、文件系统 native 边界 | Linux 实现为主 |
| Class Verification | [44-class-verification](vol-02/44-class-verification/01-verifier.md) | 深入 | Verifier、VerificationType、类型状态与安全证明 | 不覆盖所有字节码校验错误案例 |
| Math Library | [45-math-library](vol-02/45-math-library/01-poly-approximation.md) | 入口 | 多项式近似、StubRoutines、native 数学路径 | 不覆盖完整 libm 或所有架构实现 |
| Serviceability Agent | [46-sa-postmortem](vol-02/46-sa-postmortem/01-sa-postmortem.md) | 深入 | core、ptrace、ELF program headers、符号和地址读取 | Linux postmortem/live process 路径为主 |
| Instrumentation | [47-instrumentation](vol-02/47-instrumentation/01-jplis-agent.md) | 深入 | JPLIS agent、Agent-Class、agentmain 与启动/Attach 入口 | 不覆盖所有 Java agent 框架 |
| Utilities | [48-utilities](vol-02/48-utilities/01-vmerror.md) | 深入 | vmError、ConcurrentHashTable、BitMap、stream、UTF8/JSON | 不覆盖所有 utilities 类 |

## 明确不在本卷主线中的内容

以下不是“遗漏但尚未发现”的隐性缺口，而是本卷主动控制范围后的边界：

### 其他垃圾收集器的完整实现

本卷深入 G1 和 GC 通用框架，但没有把以下收集器分别写成完整专题：

- Serial/DefNew 的完整回收流程；
- Parallel Scavenge/Parallel Old 的完整策略和任务组织；
- CMS 的并发标记、清扫和增量更新写屏障；
- ZGC、Shenandoah 等 JDK 11u 中的低停顿收集器实现。

它们可以复用 `25-gc-framework`、`24-frame`、`18-safepoint` 和 `27-jni` 的基础模型，但不能把 G1 章节直接当作其他收集器的实现说明。

### JVMCI、Graal 与替代编译器路径

C1/C2、CI、CompileBroker 和 CodeCache 已覆盖 HotSpot 主干编译链；JVMCI/Graal 的完整编译器接口、JVMCI 编译线程和 Graal 编译器内部图结构不在本卷主线。

### 非 Linux/x86_64 平台

Windows、macOS、BSD、AArch64、RISC-V、S390 等平台通常共享 HotSpot 的上层协议，但信号、线程、寄存器、调用约定、汇编器、CodeCache 对齐和 native I/O 路径可能不同。本卷不能替代这些平台的源码阅读。

### JDK 17/21 及更高版本的实现变化

本卷以 OpenJDK 11u 为事实基线。后续版本中，偏向锁移除、ObjectMonitor 重构、GC 实现、JFR/JVMTI、CodeCache 和内部工具链都可能出现结构变化。跨版本阅读时，应先重新核对源码路径和调用链。

### Java 类库与应用框架

本卷解释 HotSpot 和与 HotSpot 紧密耦合的 JDK native/工具路径，不覆盖完整 Java SE 类库、Spring、Netty、数据库、容器或应用框架实现。

## 使用矩阵的方式

- 想建立 HotSpot 总体模型：先读首页的三条阅读路线，再沿七层地图推进。
- 想查某个具体子系统：使用上面的域入口和等级，不要把“入口”误读为“完整专著”。
- 想迁移到 JDK 17/21 或其他平台：先看对应边界段，再从同域文章重新核对源码。
- 想发现下一批可扩写内容：优先从“范围外”中选择一个主题，单独建立新卷或专题，不要把现有卷的完成状态描述成“缺章节”。
