# 卷 2 · 运行时深处

> 一套以 **OpenJDK 11u / HotSpot / Linux / x86_64** 为基线的源码阅读卷。
>
> 这不是按源码目录排列的类名索引，而是从“读者真正想知道什么”出发，把 JVM 的对象、线程、编译器、GC、工具和诊断机制串成一条可以走通的路径。

## 这卷解决什么问题

当 Java 程序执行一行代码时，HotSpot 同时在处理几套互相牵制的系统：

- 对象要有对象头、类元数据和可追踪的引用；
- 字节码要经过解释器、C1、C2，最后变成可以执行和回收的机器码；
- 线程要在 safepoint、锁、handshake 和 JNI 状态之间安全切换；
- GC 要在应用线程继续修改对象图时，仍然知道哪些对象活着、哪些引用可能跨 Region；
- JFR、JMX、Attach、JVMTI、SA 要把 JVM 内部状态暴露给外部工具；
- 崩溃、反优化、类重定义和代码清扫还要在这些系统之间保持一致。

卷 2 的主线就是把这些“运行时为什么必须这样做”的问题拆开，再用源码把答案钉住。

## 适合谁阅读

这卷面向已经会使用 Java、希望理解 HotSpot 内部机制的读者，尤其适合：

- 想从 JVM 源码解释 GC、JIT、锁、线程或内存问题的 Java 开发者；
- 正在阅读 OpenJDK 源码，但容易在 C++ 类型、平台代码和运行时状态之间迷路的工程师；
- 需要把 JFR、JMX、JVMTI、Attach、SA 等工具输出追溯到 HotSpot 实现的性能和诊断人员。

不要求先掌握全部 HotSpot 源码，但建议熟悉 Java 对象模型、基本 C++ 语法、操作系统进程/线程和 x86_64 调用约定。每篇文章都会在需要的位置补足局部前置知识。

## 从哪里开始

### 如果你第一次读 HotSpot

按基础到执行的顺序读：

1. [ClassFile 解析与类加载](07-classfile-classloader/01-classfile-parser.md)
2. [对象与类元数据：`oopDesc`、`Klass`、常量池](06-oops/01-markoop-oopdesc.md)
3. [解释器：字节码、模板和运行时](08-interpreter/01-bytecodes-definition.md)
4. [线程与状态：JavaThread、SMR、Handshake](17-threads/01-thread-hierarchy.md)
5. [Safepoint：VM 如何让线程停下来](18-safepoint/01-safepoint-orchestration.md)
6. [C1：字节码如何变成编译图](14-c1-compiler/01-c1-pipeline-ir.md)
7. [C2：为什么要先换成 Ideal Graph](15-c2-compiler/01-c2-ideal-graph.md)
8. [物理栈帧与虚拟栈帧](24-frame/01-physical-frame.md)

### 如果你关心性能与 GC

1. [CodeCache：机器码的家](16-code-cache/01-codeblob-heap.md)
2. [G1 Region 与堆布局](26-g1-gc/01-heapregion.md)
3. [并发标记与 SATB](26-g1-gc/02-concurrent-marking.md)
4. [RSet 与 CardTable](26-g1-gc/03-rem-set.md)
5. [分配、晋升与 Humongous 对象](26-g1-gc/04-allocation.md)
6. [Mixed GC 策略](26-g1-gc/05-mixed-gc-policy.md)
7. [屏障与 Full GC 根处理](26-g1-gc/06-g1-barrier.md)

### 如果你关心工具、诊断与生产问题

1. [JNI Handle 与 Fast Path](27-jni/01-handle-system.md)
2. [JVMTI Agent 与事件系统](28-jvmti/01-agent-architecture.md)
3. [JFR Recorder 与事件元数据](32-jfr/01-recorder-engine.md)
4. [JMX MemoryService 与 JMM 接口](33-jmx/01-memory-service.md)
5. [AttachListener 与 JDK Attach API](36-attach/01-attach-listener.md)
6. [HeapDumper 与 hprof](37-heap-dumper/01-heap-dumper.md)
7. [Serviceability Agent：core、ptrace 与 ELF](46-sa-postmortem/01-sa-postmortem.md)
8. [vmError：`hs_err_pid.log` 如何写出](48-utilities/01-vmerror.md)

## 七层地图

这卷按依赖关系组织成七层。层次是帮助理解的路线，不是要求所有读者逐篇通读。

| 层 | 主题 | 主要域 |
|---|---|---|
| 1. 地基 | 操作系统、原子、日志、数学与工具原语 | [01-os](01-os/01-platform-detection.md)、[05-cpu-primitives](05-cpu-primitives/01-atomic-and-memory-order.md)、[45-math-library](45-math-library/01-poly-approximation.md)、[48-utilities](48-utilities/01-vmerror.md) |
| 2. 原语 | 汇编、参数、对象头、代码缓存和 native 边界 | [02-assembler](02-assembler/01-codebuffer-abstract-assembler.md)、[03-arguments-flags](03-arguments-flags/01-flag-definition-system.md)、[06-oops](06-oops/01-markoop-oopdesc.md)、[16-code-cache](16-code-cache/01-codeblob-heap.md)、[42-core-native](42-core-native/01-jni-system.md) |
| 3. 对象与类 | ClassFile、类加载、Klass、堆和线程 | [07-classfile-classloader](07-classfile-classloader/01-classfile-parser.md)、[09-memory-core](09-memory-core/01-universe-heap.md)、[17-threads](17-threads/01-thread-hierarchy.md) |
| 4. 执行与帧 | 解释器、同步、Stub、Frame、Unsafe 和校验 | [08-interpreter](08-interpreter/01-bytecodes-definition.md)、[19-sync](19-sync/01-lock-hierarchy.md)、[23-stub](23-stub/01-stub-entry.md)、[24-frame](24-frame/01-physical-frame.md)、[31-unsafe-whitebox](31-unsafe-whitebox/01-unsafe-api.md)、[44-class-verification](44-class-verification/01-verifier.md) |
| 5. VM 核心 | CDS、CI、JIT 框架、safepoint、VM operation、JNI 和监控 | [11-cds](11-cds/01-cds-overview-dump.md)、[12-ci](12-ci/01-ci-overview-mirror.md)、[13-jit-framework](13-jit-framework/01-compile-broker-queue.md)、[18-safepoint](18-safepoint/01-safepoint-orchestration.md)、[20-vm-operations](20-vm-operations/01-vm-operation.md)、[27-jni](27-jni/01-handle-system.md)、[39-runtime-monitoring](39-runtime-monitoring/01-service-thread.md) |
| 6. JIT 与 GC | C1、C2、共享运行时、GC 框架、JVMTI、MH、JMX、网络 | [14-c1-compiler](14-c1-compiler/01-c1-pipeline-ir.md)、[15-c2-compiler](15-c2-compiler/01-c2-ideal-graph.md)、[21-shared-runtime](21-shared-runtime/01-runtime-stubs.md)、[25-gc-framework](25-gc-framework/01-barrier-access.md)、[26-g1-gc](26-g1-gc/01-heapregion.md)、[28-jvmti](28-jvmti/01-agent-architecture.md)、[29-mh](29-mh/01-invoke-chain.md)、[33-jmx](33-jmx/01-memory-service.md)、[43-nio-net](43-nio-net/01-tcp-epoll.md) |
| 7. 工具与上层 | Deoptimization、Attach、HeapDumper、PerfData、Launcher、Instrumentation 和 DCmd | [22-deoptimization](22-deoptimization/01-deopt-decision.md)、[30-jvm-entry](30-jvm-entry/01-jvm-entry-points.md)、[32-jfr](32-jfr/01-recorder-engine.md)、[34-nmt](34-nmt/01-tracking.md)、[35-dcmd](35-dcmd/01-dcmd-framework.md)、[36-attach](36-attach/01-attach-listener.md)、[37-heap-dumper](37-heap-dumper/01-heap-dumper.md)、[38-perfdata](38-perfdata/01-perfdata.md)、[40-launcher](40-launcher/01-launch-flow.md)、[41-zip-jimage](41-zip-jimage/01-zip.md)、[46-sa-postmortem](46-sa-postmortem/01-sa-postmortem.md)、[47-instrumentation](47-instrumentation/01-jplis-agent.md) |

## 域索引

| 域 | 入口 | 关注的问题 |
|---|---|---|
| 01-os | [平台与信号](01-os/01-platform-detection.md) | JVM 如何认识操作系统、线程和信号 |
| 02-assembler | [CodeBuffer 与汇编器](02-assembler/01-codebuffer-abstract-assembler.md) | 指令、寄存器和宏汇编如何落地 |
| 03-arguments-flags | [Flag 定义](03-arguments-flags/01-flag-definition-system.md) | JVM 参数如何声明、解析和管理 |
| 04-logging | [日志标签](04-logging/01-tag-and-selection.md) | 日志输出如何选择和发布 |
| 05-cpu-primitives | [原子与内存序](05-cpu-primitives/01-atomic-and-memory-order.md) | CAS、屏障和 SafeFetch |
| 06-oops | [对象头](06-oops/01-markoop-oopdesc.md) | mark word、Klass 与 Access API |
| 07-classfile-classloader | [ClassFile 解析](07-classfile-classloader/01-classfile-parser.md) | 类文件如何进入运行时 |
| 08-interpreter | [字节码定义](08-interpreter/01-bytecodes-definition.md) | 解释器如何执行 Java 方法 |
| 09-memory-core | [Universe 与堆](09-memory-core/01-universe-heap.md) | HotSpot 内存世界从哪里开始 |
| 10-metaspace | [Metaspace](10-metaspace/01-metaspace-overview.md) | 类元数据如何分配和回收 |
| 11-cds | [CDS](11-cds/01-cds-overview-dump.md) | 共享类如何被 dump、加载和接线 |
| 12-ci | [编译器接口](12-ci/01-ci-overview-mirror.md) | JIT 如何获得稳定的运行时视图 |
| 13-jit-framework | [CompileBroker](13-jit-framework/01-compile-broker-queue.md) | 编译请求如何排队和调度 |
| 14-c1-compiler | [C1](14-c1-compiler/01-c1-pipeline-ir.md) | 低延迟编译如何完成 |
| 15-c2-compiler | [C2 Ideal Graph](15-c2-compiler/01-c2-ideal-graph.md) | 全局优化如何在图上进行 |
| 16-code-cache | [CodeCache](16-code-cache/01-codeblob-heap.md) | 机器码如何安置、反查和回收 |
| 17-threads | [线程层次](17-threads/01-thread-hierarchy.md) | JavaThread、SMR 和 Handshake |
| 18-safepoint | [Safepoint](18-safepoint/01-safepoint-orchestration.md) | JVM 如何协调全体线程 |
| 19-sync | [锁与 ObjectMonitor](19-sync/01-lock-hierarchy.md) | monitorenter、wait/notify 和内部锁 |
| 20-vm-operations | [VM Operation](20-vm-operations/01-vm-operation.md) | VM 线程如何执行全局操作 |
| 21-shared-runtime | [共享运行时](21-shared-runtime/01-runtime-stubs.md) | Stub、适配器、异常和 Java/C++ 边界 |
| 22-deoptimization | [反优化](22-deoptimization/01-deopt-decision.md) | 编译代码如何退回解释执行 |
| 23-stub | [StubRoutines](23-stub/01-stub-entry.md) | 桩代码如何生成并进入 CodeCache |
| 24-frame | [Physical Frame](24-frame/01-physical-frame.md) | 物理帧、虚拟帧与 GC 扫描 |
| 25-gc-framework | [Barrier 与 Heap](25-gc-framework/01-barrier-access.md) | GC 通用接口、任务队列和 OopStorage |
| 26-g1-gc | [G1 Region](26-g1-gc/01-heapregion.md) | Region、标记、RSet、分配和回收策略 |
| 27-jni | [JNI Handle](27-jni/01-handle-system.md) | JNI 如何安全地跨越 Java/VM 边界 |
| 28-jvmti | [JVMTI Agent](28-jvmti/01-agent-architecture.md) | Agent、能力和事件系统 |
| 29-mh | [MethodHandle](29-mh/01-invoke-chain.md) | 签名多态、LambdaForm 和 adapter |
| 30-jvm-entry | [JVM Entry](30-jvm-entry/01-jvm-entry-points.md) | Java 调用如何进入 VM |
| 31-unsafe-whitebox | [Unsafe](31-unsafe-whitebox/01-unsafe-api.md) | 不安全内存访问与测试入口 |
| 32-jfr | [JFR Recorder](32-jfr/01-recorder-engine.md) | 事件、录制、采样与二进制输出 |
| 33-jmx | [MemoryService](33-jmx/01-memory-service.md) | JMX 如何观察 JVM 内存与 GC |
| 34-nmt | [NMT Tracking](34-nmt/01-tracking.md) | native 内存如何被追踪和报告 |
| 35-dcmd | [DCmd Framework](35-dcmd/01-dcmd-framework.md) | 诊断命令如何注册和执行 |
| 36-attach | [AttachListener](36-attach/01-attach-listener.md) | 外部工具如何连接活 JVM |
| 37-heap-dumper | [HeapDumper](37-heap-dumper/01-heap-dumper.md) | 堆如何导出成 hprof |
| 38-perfdata | [PerfData](38-perfdata/01-perfdata.md) | 运行时统计如何低成本发布 |
| 39-runtime-monitoring | [ServiceThread](39-runtime-monitoring/01-service-thread.md) | 后台服务线程如何串起延迟工作 |
| 40-launcher | [Launcher](40-launcher/01-launch-flow.md) | Java 命令如何启动 JVM |
| 41-zip-jimage | [Zip/JImage](41-zip-jimage/01-zip.md) | 模块镜像和压缩资源如何读取 |
| 42-core-native | [JNI System](42-core-native/01-jni-system.md) | native 系统调用如何接入 JVM |
| 43-nio-net | [TCP/UDP/文件系统](43-nio-net/01-tcp-epoll.md) | Java NIO 如何落到 Linux |
| 44-class-verification | [Verifier](44-class-verification/01-verifier.md) | 字节码安全性如何被证明 |
| 45-math-library | [数学近似](45-math-library/01-poly-approximation.md) | Math intrinsic 和 StubRoutines |
| 46-sa-postmortem | [SA Postmortem](46-sa-postmortem/01-sa-postmortem.md) | core、ptrace 和 ELF 符号 |
| 47-instrumentation | [Instrumentation](47-instrumentation/01-jplis-agent.md) | Java agent 如何进入目标 JVM |
| 48-utilities | [vmError](48-utilities/01-vmerror.md) | 崩溃报告、并发位图和工具基础设施 |

## 阅读这卷的方式

每篇文章尽量遵循同一套节奏：

1. 先提出一个运行时问题；
2. 推演一个直觉但不够好的方案；
3. 给出 HotSpot 的角色、状态和数据流；
4. 用源码锚点验证关键判断；
5. 在结尾把局部机制接回下一篇。

因此不建议把本卷当作类名词典从头搜索。更有效的方式是：先沿一条路线建立整体模型，再通过域索引回到具体机制。

## 版本与平台边界

- 主要源码基线是 OpenJDK 11u。
- 许多底层章节以 Linux/x86_64 为具体落点；汇编、寄存器、信号、ptrace 和部分默认参数不能直接视为跨平台事实。
- JDK 17/21 的实现已经在若干领域发生变化，尤其是偏向锁、ObjectMonitor、CodeCache、JVMTI、GC 和内部工具链。
- 阅读其他版本时，应先验证文中的源码路径、生成文件、平台实现和默认参数，再迁移结论。
