# OpenJDK 域发现 v3.1 — 运行时全覆盖验证版

> 2026-08-08 | v3 经运行时全覆盖审查（18 遗漏修复 + 5 统计修正）
>
> v3 审查维度：逐域文件归属验证 + cpu/x86 平台层 + unix/linux 平台层 + 孤儿文件 + 遗漏库 + 域边界合理性
>
> v3.1 审查维度：runtime/ 173 文件逐文件归属验证 + prims/79 文件验证 + services/56 文件验证
>
> v3.1 发现：runtime/ 18 文件遗漏、JVMTI 文件数偏差 15、jni_misc.hpp 幽灵引用等 5 处统计错误 — 全部修正。
>
> 数据来源：`/data/workspace/jdk11u/src/` 全量源码树扫描

---

## 范围说明

**纳入**: HotSpot C++ (hotspot/) + JDK JVM 运行时 Native 层 (java.base/ + jdk.hotspot.agent/ + java.instrument/ + jdk.attach/ + jdk.management/ + jdk.management.agent/ + java.management/ + jdk.net/)

**排除**: JDK 加密/安全库（libsunec, libj2pkcs11, libj2gss, libjaas, libprefs）

**构建工具排除**（不编译进 libjvm.so）:
- `share/adlc/` — ADL 编译器（21 文件/24,433 行），从 `.ad` 文件生成 C2 指令匹配代码。`CompileJvm.gmk` 的 `JVM_EXCLUDES += adlc` 排除。作为构建工具说明（非正文域）。
- `share/precompiled/precompiled.hpp` — 预编译头，纯构建优化。

---

## 一、核心基础设施（5 域）

### 1. OS 抽象层

| 层级 | 源文件 | 规模 |
|------|------|:--:|
| share/ | `runtime/os.cpp` + `os.hpp` + `os.inline.hpp` + `os_ext.hpp` + `os_perf.hpp` + `abstract_vm_version.*` + `vm_version.*` | 11 文件 |
| os/linux/ | `os_linux.*` (3) + `os_share_linux.hpp` + `osThread_linux.*` (2) + `threadCritical_linux.cpp` + osContainer (4) + cgroup* (6) + decoder_linux.cpp + os_perf_linux.cpp | ~21 文件 |
| os/posix/ | `os_posix.*` (2) + `semaphore_posix.*` (2) + `threadLocalStorage_posix.cpp` + `jvm_posix.cpp` + `vmError_posix.cpp` | 7 文件 |
| os_cpu/linux_x86/ | `assembler_linux_x86.cpp` + `os_linux_x86.cpp` + `thread_linux_x86.cpp` + `vm_version_linux_x86.cpp` (+ 12 未编译的 32 位/BSD 文件) | 16 文件 |
| cpu/x86/ extra | `vm_version_x86.*` (2) + `vm_version_ext_x86.*` (2) | +4 文件 |

> **v2→v3 修正**: 移除 8 个非 OS 文件（flags→域 3, attachListener→域 34, DCmd→域 33, PerfData→域 36, vmStructs→域 44）。补充 vm_version 等。osThread/semaphore/threadLocalStorage/threadCritical 归入 Threads(域 17)/Sync(域 19)。

### 2. Assembler

| 层级 | 源文件 | 规模 |
|------|------|:--:|
| share/asm/ | `assembler.*` (3) + `codeBuffer.*` (2) + `macroAssembler.*` (2) + `register.*` (2) | 9 文件 / 3,169 行 |
| cpu/x86/ | `assembler_x86.*` (3) + `macroAssembler_x86.*` (3) + macroAssembler_x86 数学变体 (9) + `register_x86.*` (2) + `register_definitions_x86.cpp` + `vmreg_x86.*` (3) + `codeBuffer_x86.hpp` + `registerMap_x86.*` (2) + `bytes_x86.hpp` + `copy_x86.hpp` + `globalDefinitions_x86.hpp` + `globals_x86.hpp` + `icache_x86.*` (2) | ~29 文件 |
| **合计** | | **~38 文件 / ~28,200 行** |

> **v2→v3 修正**: 行数严重低估（文档写 3,169 行，原因为只统计了 share/asm/；x86 侧 macroAssembler 系列 ~25,000 行未计入）。补充 cpu/x86 register 核心文件。28,200 行接近 30,000 巨型域阈值——知识规划时需评估是否按巨型域处理。

### 3. Arguments & Flags

| 源文件 | 规模 |
|------|:--:|
| `runtime/arguments.*` (4) + `runtime/globals.*` (4) + `runtime/globals_ext.hpp` (2) + `runtime/flags/` (13) | 21 文件 |
| `services/writeableFlags.*` (2) | +2 |
| `os/linux/globals_linux.hpp` + `c1_globals_linux.hpp` + `c2_globals_linux.hpp` | +3 |
| `cpu/x86/globals_x86.hpp` + `c1_globals_x86.hpp` + `c2_globals_x86.hpp` | +3 |
| **合计** | **29 文件 / ~15,000 行** |

> **v2→v3 修正**: 补充 6 个平台 flag 文件（原被域 1 或无归属吸收）。writeableFlags 从 services/ 拉入（写 flag 入口）。

### 4. Logging

| 源文件 | 规模 |
|------|:--:|
| `logging/` 全部 37 文件 | 5,292 行 |

> **v2→v3 状态**: 干净，无修正。内部结构自洽（配置/装饰/输出/选择/消息）。

### 5. CPU Primitives [新建域]

| 源文件 | 规模 |
|------|:--:|
| `runtime/atomic.hpp` + `orderAccess.*` (2) + `prefetch.*` (2) + `icache.*` (2) + `registerMap.hpp` + `javaFrameAnchor.hpp` + `safefetch.inline.hpp` | 10 文件 |
| `cpu/x86/icache_x86.*` (2) + `javaFrameAnchor_x86.hpp` + `runtime_x86_32.cpp` + `runtime_x86_64.cpp` + `rdtsc_x86.*` (2) + `disassembler_x86.hpp` + `jvmciCodeInstaller_x86.cpp` | 9 文件 |
| **合计** | **~20 文件 / ~2,200 行** |

> **v2→v3 新增**: 原 atomic/orderAccess/icache/prefetch 等 9 个文件在 runtime/ 中无域认领。是 VM 所有子系统依赖的最底层原语（内存序/原子操作/指令缓存/预取）。与域 1 OS 分离——OS 是平台系统调用层，本域是 CPU 指令级原语。

---

## 二、对象模型（1 域）

### 6. OOPs 🔴 巨型域

| 源文件 | 规模 |
|------|:--:|
| `oops/` 全 87 文件 | 38,424 行 |
| `runtime/handles.*` (3) + `runtime/unhandledOops.*` (2) — Handle/HandleMark 和未处理 oop 追踪 | +646 行 + 218 行 |

**内部聚类（拆 6-8 篇）**:
- **对象模型本体**: oop, markOop, instanceOop, objArrayOop, typeArrayOop, arrayOop, compressedOops, klass, instanceKlass (4025行), arrayKlass, objArrayKlass, typeArrayKlass, metadata, compiledICHolder
- **运行时元数据**: constantPool (2614行), constMethod, cpCache, method (2481行), methodData (4283行), methodCounters, klassVtable (1648行), fieldInfo, fieldStreams, symbol, annotations
- **Access API (GC 屏障)**: access, accessBackend (15753行), accessDecorators — JDK11 引入的 Barrier 抽象层, 物理在 oops/ 但概念偏 GC

> **v2→v3 修正**: **新增巨型域标注**（38,424 行≥30,000）。`access*` 系列（~16,000 行）概念偏 GC（域 23），物理在 oops/——知识规划时需声明跨域归属。`symbol.*` 与域 7（classfile/symbolTable）强关联。

---

## 三、类加载与解释（2 域）

### 7. ClassFile & ClassLoader 🔴 巨型域

| 源文件 | 规模 |
|------|:--:|
| `classfile/` 全 75 文件 | 46,169 行 |
| `runtime/signature.*` (2) + `runtime/fieldDescriptor.*` (3) + `runtime/fieldType.*` (2) — 签名/字段描述解析 | +935 行 + 419 行 + 164 行 |

**内部聚类（拆 6-8 篇）**:
- **类文件解析+校验**: classFileParser (6463行), stackMapFrame, stackMapTable, verifier (2913行), bytecodeAssembler
- **类加载+解析**: classLoader (2182行), classLoaderData, dictionary, systemDictionary (3058行), placeholders, loaderConstraints, resolutionErrors, defaultMethods
- **符号/字符串表**: symbolTable (755行), stringTable (876行), compactHashtable (980行), vmSymbols (1679行)
- **Java 类镜像**: javaClasses (4586行) — 可独立成篇
- **模块系统**: modules, moduleEntry, packageEntry

> **v2→v3 修正**: **新增巨型域标注**（46,169 行≥30,000）。CDS 相关 4 文件（classListParser, sharedPathsMiscInfo, systemDictionaryShared, metadataOnStackMark）物理在此但概念属域 11 CDS——需显式声明归属防跨域断裂。

### 8. Interpreter

| 层级 | 源文件 | 规模 |
|------|------|:--:|
| share/interpreter/ | 40 文件（含 templateInterpreter, templateTable, bytecode, linkResolver, oopMapCache, rewriter 等）| 16,639 行 |
| cpu/x86/ | `templateTable_x86.*` (2) + `templateInterpreterGenerator_x86.*` (3) + `abstractInterpreter_x86.cpp` + `interp_masm_x86.*` (2) + `interpreterRT_x86.*` (5) | 10 文件 / 10,636 行 |
| **合计** | | **50 文件 / ~27,200 行** |

> **v2→v3 修正**: 补充 cpu/x86 解释器实现（10 文件/10,636 行）。模板表/模板生成器是解释器机制的核心实现——不能只算 share/ 层。

---

## 四、内存子系统（3 域）

### 9. Memory 核心

| 源文件 | 规模 |
|------|:--:|
| `memory/` 顶层（allocation, universe, virtualspace, heap, arena, guardedMemory, iterator, memRegion, oopFactory, resourceArea 等） | 34 文件 / 12,269 行 |

> **v2→v3 修正**: 文档 v2 写 "~50 文件"，实际顶层 51 文件中 17 个属 Metaspace/CDS——移正后核心仅 34 文件。binaryTreeDictionary 和 freeList 虽物理在此但主消费者是 Metaspace，随域 10 走。

### 10. Metaspace

| 源文件 | 规模 |
|------|:--:|
| `memory/metaspace/` 子目录（32 文件） | 5,741 行 |
| `memory/` 顶层 metaspace* 文件（12 文件） | +5,634 行 |
| `memory/binaryTreeDictionary.*` + `freeList.*`（4 文件） | +1,937 行 |
| **合计** | **48 文件 / ~13,300 行** |

> **v2→v3 修正**: v2 仅算子目录（~20 文件）。顶层 12 个 metaspace* 文件 + binaryTreeDictionary（chunkManager 依赖）必须并入。metaspaceShared.cpp（2,184 行）与域 11 CDS 强相关——知识规划时需声明跨域归属。

### 11. CDS (Class Data Sharing)

| 来源目录 | 源文件 | 规模 |
|------|------|:--:|
| `memory/` | `filemap.*` + `heapShared.*` + `metaspaceShared.*` | 7 文件 / ~5,400 行 |
| `classfile/` | `classListParser.*` + `sharedPathsMiscInfo.*` + `systemDictionaryShared.*` + `compactHashtable.*` | 8 文件 / ~3,500 行 |
| `prims/` | `cdsoffsets.*` | 2 文件 / 122 行 |
| `share/include/` | `cds.h` (65行) — CDS 公共接口 | +1 |
| **合计** | | **18 文件 / ~9,000 行** |

> **v2→v3 修正**: v2 写 "~10 文件" 严重低估。CDS 跨 4 个目录分布，是典型的横切域。知识规划需覆盖三地实现：归档构建（metaspaceShared）、归档文件（filemap）、类加载侧集成（classListParser/systemDictionaryShared）、偏移表（cdsoffsets）。

---

## 五、执行引擎（5 域）

### 12. Compiler Interface (ci)

| 源文件 | 规模 |
|------|:--:|
| `ci/` 全 74 文件 | 20,932 行 |

> **v2→v3 状态**: 准确，无修正。单一内聚域（ci* 镜像对象层级），内部自然聚类：环境/入口、字节码分析、核心包装对象。

### 13. JIT Framework

| 源文件 | 规模 |
|------|:--:|
| `compiler/` 全 24 文件 | 11,733 行 |
| `runtime/compilationPolicy.*` (2) + `runtime/tieredThresholdPolicy.*` (2) — 分层编译策略（物理在 runtime/ 但功能属 JIT 框架） | +2,179 行 |

> **边界备注**: `oopMap.cpp/.hpp` 物理在 compiler/ 但逻辑描述编译产物中的 oop 位置，被 GC 消费。保持现状，知识规划中标注。

### 14. C1 编译器

| 层级 | 源文件 | 规模 |
|------|------|:--:|
| share/c1/ | 49 文件 | 41,074 行 |
| cpu/x86/ | `c1_*_x86.*` (16 文件) | 10,676 行 |
| **合计** | | **65 文件 / ~51,750 行** |

> **v2→v3 修正**: 补充 cpu/x86 C1 文件（代码生成器、线性扫描、LIR 汇编器等——与 share/ 同样核心）。

### 15. C2 编译器 🔴 巨型域

| 层级 | 源文件 | 规模 |
|------|------|:--:|
| share/opto/ | 129 文件 | 139,595 行 |
| `share/libadt/` (3 文件: dict/set/vectset — C2 使用的抽象数据类型) | +~2,000 行 |
| cpu/x86/ | `c2_globals_x86.hpp` + `c2_init_x86.cpp` + `depChecker_x86.*` (2) + .ad 文件 (3: x86.ad 9834行 / x86_32.ad 13656行 / x86_64.ad 13325行) | 7 文件 / 37,037 行 |
| **合计** | | **136 文件 / ~176,573 行** |

> **v2→v3 修正**: 补充 cpu/x86 C2 文件。AD 文件 36,815 行是 x86 指令描述（ADL 编译器输入），C2 指令选择/匹配/寄存器分配的核心数据源。建议拆 8-10 篇。

### 16. Code Cache

| 层级 | 源文件 | 规模 |
|------|------|:--:|
| share/code/ | 47 文件 | 23,189 行 |
| share/asm/ | `codeBuffer.*` (2) — CodeBuffer 是代码生成的缓冲抽象，物理在 asm/ 但逻辑属本域 | 1,909 行 |
| cpu/x86/ | 13 文件（compiledIC/nativeInst/relocInfo/vmreg/vtableStubs 的 x86 版） | 2,951 行 |
| **合计** | | **62 文件 / ~28,000 行** |

> **v2→v3 修正**: 补充 asm/codeBuffer（域 2 也在用，但主消费方是代码生成→Code Cache）。补充 cpu/x86 13 文件。补充 runtime/sweeper.*（NMethodSweeper 清理 nmethod）。

---

## 六、运行时核心（7 域）+ Frame Stack Walking [新建]

### 17. Threads

| 源文件 | 规模 |
|------|:--:|
| `runtime/thread.*` (3) + `threadSMR.*` (3) + `handshake.*` (2) | 8 文件 / 9,943 行 |
| `runtime/osThread.*` (2) + `threadStatisticalInfo.hpp` + `threadWXSetters.inline.hpp` + `threadLocalStorage.hpp` + `threadCritical.hpp` | 6 文件 |
| `runtime/interfaceSupport.*` (2) — 线程状态转换（`ThreadInVMfromJava` 等） | 912 行 |
| **合计** | **16 文件 / ~10,900 行** |

> **v2→v3 修正**: v2 声称 12 文件但 pattern 只覆盖 8 文件。补充 osThread（从域 1 移出——osThread 是 JavaThread 的 OS 层对象，归属 Threads 更合理）及 interfaceSupport 等。

### 18. Safepoint

| 源文件 | 规模 |
|------|:--:|
| `runtime/safepoint.*` (2) + `safepointMechanism.*` (3) + `safepointVerifiers.*` (2) | 7 文件 / 2,296 行 |

> **v2→v3 状态**: 准确。

### 19. Synchronization

| 源文件 | 规模 |
|------|:--:|
| `runtime/objectMonitor.*` (3) + `synchronizer.*` (2) + `biasedLocking.*` (2) + `mutex.*` (2) + `mutexLocker.*` (2) + `basicLock.*` (2) + `rtmLocking.*` (2) + `park.*` (2) | 17 文件 / 9,330 行 |
| `runtime/semaphore.*` (2) | +103 行 |
| **合计** | **19 文件 / 9,433 行** |

> **v2→v3 修正**: v2 文档 pattern 缺 mutexLocker/basicLock/rtmLocking（只在声称的 17 文件数中隐含）。补充 semaphore（信号量同步原语）。

### 20. VM Operations

| 源文件 | 规模 |
|------|:--:|
| `runtime/vmOperations.*` (2) + `vmThread.*` (2) + `task.*` (2) + `init.*` (2) | 8 文件 / 2,527 行 |

> **v2→v3 修正**: 补充 task.*（周期性后台任务调度，被 WatcherThread 使用——WatcherThread 定义在 vmThread 中）。补充 init.*（VM 启动引导序列——`init_globals()`/`vm_init_globals()` 显式初始化顺序）。

### 21. Shared Runtime

| 层级 | 源文件 | 规模 |
|------|------|:--:|
| share/runtime/ | `sharedRuntime.*` (2) + `sharedRuntimeTrans.cpp` + `sharedRuntimeTrig.cpp` + `sharedRuntimeMath.hpp` | 5 文件 / 5,634 行 |
| cpu/x86/ | `sharedRuntime_x86.cpp` + `sharedRuntime_x86_32.cpp` (3,246) + `sharedRuntime_x86_64.cpp` (4,003) | 3 文件 / 7,340 行 |
| **合计** | | **8 文件 / ~13,000 行** |

> **v2→v3 修正**: 补充 cpu/x86 sharedRuntime（调用约定、i2c/c2i 转换桥实现，核心体量在 x86 侧）。

### 22. Deoptimization

| 源文件 | 规模 |
|------|:--:|
| `runtime/deoptimization.*` (2) | 2,890 行 |

> **v2→v3 状态**: 保持 2 文件。但 deopt 重度依赖 Frame 家族（域 24），知识规划需声明跨域依赖。

### 23. Stub Routines

| 层级 | 源文件 | 规模 |
|------|------|:--:|
| share/runtime/ | `stubRoutines.*` (2) + `stubCodeGenerator.*` (2) | 4 文件 / 1,302 行 |
| cpu/x86/ | `stubRoutines_x86.*` (4) + `stubGenerator_x86_32.cpp` (3,952) + `stubGenerator_x86_64.cpp` (6,138) | 6 文件 / 10,777 行 |
| **合计** | | **10 文件 / ~12,000 行** |

> **v2→v3 修正**: 补充 cpu/x86 stub 生成（stub 的实际机器码生成在 x86 侧）。

### 24. Frame & Stack Walking [新建域]

| 源文件 | 规模 |
|------|:--:|
| `runtime/frame.*` (3) + `vframe.*` (3) + `vframe_hp.*` (2) + `vframeArray.*` (2) + `stackValue.*` (2) + `stackValueCollection.*` (2) + `monitorChunk.*` (2) + `rframe.*` (2) + `extendedPC.hpp` | 19 文件 / 5,801 行 |
| cpu/x86/ | `frame_x86.*` (3) + `registerMap_x86.*` (2) | 5 文件 / 1,206 行 |
| **合计** | | **24 文件 / ~7,000 行** |

> **v2→v3 新增**: v2 中 19 个 Frame/Deopt 族文件是 runtime/ 中最大孤儿组。概念高度内聚（全部处理栈帧表示、虚拟帧、去优化帧重建），服务对象不限于 deopt（解释器、GC 根扫描、JVMTI、JFR 栈采样均依赖）。域 22（Deoptimization）声明依赖本域。

---

## 七、GC 子系统（2 域）

### 25. GC Framework 🔴 巨型域

| 源文件 | 规模 |
|------|:--:|
| `gc/shared/` 顶层 153 文件 + c1/ (6) + c2/ (6) + stringdedup/ (13) | 178 文件 / 36,653 行 |
| cpu/x86/gc/shared/ (6 文件: BarrierSet 汇编层实现) | 749 行 |
| **合计** | **184 文件 / ~37,400 行** |

> **v2→v3 修正**: 补充 cpu/x86/gc/ 屏障汇编层。重大发现：gc/shared/ 中约 26% (~9,500 行) 是经典代际模型（genCollectedHeap, generation, space, cardGeneration, adaptiveSizePolicy 等）——在 G1-ONLY 构建中是**编译进二进制但从不实例化的死代码**。经 `macros.hpp` 确认：
> ```cpp
> #define INCLUDE_CMSGC 0
> #define INCLUDE_PARALLELGC 0
> #define INCLUDE_SERIALGC 0
> #define INCLUDE_G1GC 1
> ```
> 知识规划必须区分"活跃机制"与"历史遗留"——不能把死代码当作活跃机制写。
>
> **建议拆 8 篇**: ①BarrierSet(GC↔Compiler 桥,含三层) ②Reference Processing(15f/3368行,值得 2 篇) ③Collector 选择与参数 ④Heap 基类与分配(TLAB+PLAB 合并 1 篇) ⑤OopStorage+并发工作基础设施 ⑥经典代际模型(作为对比素材,非主文) ⑦GC 统计与可观测 ⑧字符串去重共享层。

### 26. G1 GC 🔴 巨型域

| 源文件 | 规模 |
|------|:--:|
| `gc/g1/` 顶层 191 文件 + c1/ (2) + c2/ (2) | 195 文件 / 45,692 行 |
| cpu/x86/gc/g1/ (2 文件: G1BarrierSet 汇编层) | 668 行 |
| **合计** | **197 文件 / ~46,360 行** |

**建议拆 8-10 篇**: ①G1CollectedHeap 核心 ②并发标记 ③RSet/卡表/并发细化 ④Heap Region 与空间映射 ⑤分配与晋升 ⑥策略/预测/集合选择 ⑦Full GC ⑧BarrierSet G1 实现(三层) ⑨阶段统计/监控 ⑩字符串去重(G1 侧)+根处理（⑨⑩可考虑合并）。

> **v2→v3 修正**: 补充 cpu/x86 G1 屏障汇编层。确认 JDK11u G1-ONLY 构建。

---

## 八、Native 接口（5 域）

### 27. JNI

| 源文件 | 规模 |
|------|:--:|
| `prims/jni.*` (2) + `jniCheck.*` (2) + `jniFastGetField.*` (2) + `jniExport.hpp` | 7 文件 |
| `runtime/jniHandles.*` (3) + `jfieldIDWorkaround.hpp` + `jniPeriodicChecker.*` (2) | 6 文件 |
| cpu/x86/ `jniFastGetField_x86_32.cpp` + `jniFastGetField_x86_64.cpp` + `jniTypes_x86.hpp` | 3 文件 |
| **合计** | **16 文件** |

> **v2→v3 修正**: 补充 jniFastGetField（原遗漏）。补充 cpu/x86 平台文件。

### 28. JVMTI

| 源文件 | 规模 |
|------|:--:|
| `prims/jvmti*` (46 文件, 含 jvmti.xml 14993行) | ~46 文件 |
| `prims/methodComparator.*` (2) + `resolvedMethodTable.*` (2) | +4 文件 |
| `runtime/relocator.*` (2) — 字节码重写（JVMTI RedefineClasses 核心工具） | +908 行 |
| `prims/privilegedStack.*` (2) — 特权栈帧探测 | +131 行 |
| **合计** | **~54 文件** |

> **v2→v3 修正**: 补充 4 个遗漏文件（methodComparator, resolvedMethodTable, relocator, privilegedStack）。

### 29. Method Handles

| 源文件 | 规模 |
|------|:--:|
| `prims/methodHandles.*` (2) | 1,827 行 |
| cpu/x86/ `methodHandles_x86.*` (2) | 704 行 |
| **合计** | **4 文件 / ~2,500 行** |

### 30. JVM Entry Points

| 源文件 | 规模 |
|------|:--:|
| `prims/jvm.*` (2) + `nativeLookup.*` (2) + `stackwalk.*` (2) + `perf.cpp` + `jvm_misc.hpp` | 8 文件 |
| `share/include/jvm.h` (1,342行) — JVM API 公共声明（域 30 的接口面） | +1 |
| `runtime/javaCalls.*` (2) + `java.*` (2) + `reflection.*` (2) + `reflectionUtils.*` (2) | +8 文件 |
| **合计** | **17 文件** |

> **v2→v3 修正**: 补充 stackwalk, perf, javaCalls, java, reflection 等原本孤儿文件。javaCalls 是 C++ 调用 Java 方法的桥接——应归这里是 JVM 入口的下行通路。

### 31. Unsafe & WhiteBox & Forte

| 源文件 | 规模 |
|------|:--:|
| `prims/unsafe.*` (2) + `whitebox.*` (3) + `wbtestmethods/` (2) + `forte.*` (2) | 9 文件 |

> **v2→v3 修正**: 并入 forte（AsyncGetCallTrace 分析器原生接口，原遗漏）。

---

## 九、可观测性（8 域）

### 32. JFR 🔴 巨型域

| 源文件 | 规模 |
|------|:--:|
| `jfr/` 217 文件（非 215），10 子目录 | 34,828 行 |

**子目录结构**: dcmd(2) / instrumentation(4) / jni(12) / leakprofiler(47, 含 chains/checkpoint/sampling/utilities) / metadata(3) / periodic(15, 含 sampling/) / recorder(76, 含 checkpoint/stacktrace/storage/stringpool/types/traceid) / support(15) / utilities(20) / writers(20)。

> **v2→v3 修正**: 文件数 215→217。JFR 是树状架构（recorder/ 最深 4 级子目录）。建议拆 6-8 篇。

### 33. JMX & Management

| 源文件 | 规模 |
|------|:--:|
| `services/management.*` (2) + `memoryManager.*` (2) + `memoryPool.*` (2) + `memoryService.*` (2) + `memoryUsage.hpp` + `gcNotifier.*` (2) + `lowMemoryDetector.*` (2) + `writeableFlags.*` (2) | ~17 文件 |
| JDK Native: `jdk.management/` (libmanagement_ext, 39 文件) | 3,706 行 C |
| JDK Native: `jdk.management.agent/` (libmanagement_agent, ~400 行) | ~400 行 C |
| JDK Native: `java.management/` (libmanagement, 10 文件) — JMM 桥接层 | 924 行 C |
| `share/include/jmm.h` (349行) — JMM 接口定义 | 含在上 |
| **合计** | **~66 文件** |

> **v2→v3→v3.3 修正**: 补充 gcNotifier, lowMemoryDetector, writeableFlags（原遗漏）。补充 libmanagement_agent + libmanagement（JVM 运行时桥接，FINAL 扫描发现）。补充 jmm.h 头文件归属。

### 34. NMT

| 源文件 | 规模 |
|------|:--:|
| `services/memTracker.*` (2) + `nmtCommon.*` (2) + `nmtDCmd.*` (2) + `virtualMemoryTracker.*` (2) + `mallocTracker.*` (3) + `mallocSiteTable.*` (2) + `memBaseline.*` (2) + `memReporter.*` (2) + `allocationSite.hpp` | ~18 文件 |

> **v2→v3 状态**: v2 覆盖完整，补充 allocationSite.hpp。

### 35. Diagnostic Commands

| 源文件 | 规模 |
|------|:--:|
| `services/diagnosticArgument.*` (2) + `diagnosticCommand.*` (3) + `diagnosticFramework.*` (2) | 7 文件 |
| `os/linux/trimCHeapDCmd.*` (2) — 从域 1 移入 | +2 文件 |
| **合计** | **9 文件** |

### 36. Attach API

| 源文件 | 规模 |
|------|:--:|
| `services/attachListener.*` (2) + `dtraceAttacher.*` (2) | 4 文件 |
| `os/linux/attachListener_linux.cpp` — 从域 1 移入 | +1 文件 |
| JDK Native: `jdk.attach/` (libattach, ~2,067 行 C) | 30 文件 |
| **合计** | **35 文件** |

### 37. Heap Dumper

| 源文件 | 规模 |
|------|:--:|
| `services/heapDumper.*` (2) + `heapDumperCompression.*` (2) | 4 文件 |

### 38. PerfData

| 源文件 | 规模 |
|------|:--:|
| `runtime/perfData.*` (3) + `perfMemory.*` (2) + `statSampler.*` (2) | 7 文件 |
| `os/linux/os_perf_linux.cpp` + `perfMemory_linux.cpp` — 从域 1 移出 | +2 文件 |
| **合计** | **9 文件** |

### 39. Runtime Monitoring

| 源文件 | 规模 |
|------|:--:|
| `runtime/serviceThread.*` (2) + `timer.*` (2) + `timerTrace.*` (2) + `memprofiler.*` (2) + `threadHeapSampler.*` (2) | 10 文件 |
| `services/classLoadingService.*` (2) + `runtimeService.*` (2) + `threadService.*` (2) + `threadIdTable.*` (2) | 8 文件 |
| **合计** | **18 文件** |

> **v2→v3 修正**: 补充 threadIdTable, timer, memprofiler, threadHeapSampler 等遗漏。

---

## 十、JDK JVM 运行时 Native 层（8 域）

> ⚠️ 源码在 `java.base/`、`jdk.hotspot.agent/`、`java.instrument/` 等模块。  
> ⚠️ v2 所有域均仅列 share/native/ 路径——漏掉了 **unix/linux 平台层源码**。v3 已全量修正。  
> ⚠️ 加密安全类库（libsunec, libj2pkcs11, libj2gss, libjaas, libprefs）**已排除**。  
> ⚠️ libmanagement_ext 和 libattach 已归入域 33（JMX）和域 36（Attach API）。

### 40. Launcher (libjli.so) + java 入口

| 来源 | 源文件 | 规模 |
|------|------|:--:|
| share/native/libjli/ | java.c (2390) + args.c + parse_manifest.c + wildcard.c + jli_util.* + 其他 | 12 文件 / 5,401 行 |
| share/native/launcher/ | main.c + defines.h | 2 文件 / 337 行 |
| unix/native/libjli/ | java_md_solinux.c + java_md_common.c + java_md.h | 4 文件 / 1,363 行 |
| unix/native/launcher/ | jexec.c | 1 文件 / 359 行 |
| `unix/native/libjsig/` + `jspawnhelper/` | 信号链(351行) + 进程spawn辅助(152行) | +503 行 |
| **合计** | | **~21 文件 / ~7,960 行** |

### 41. ZIP & JIMAGE

| 源文件 | 规模 |
|------|:--:|
| `libzip/` JDK 胶水层（zip_util.c 1658行 等 6 文件） | 2,711 行 |
| `libzip/zlib/` 内嵌第三方 zlib（30 文件，不计入书内容） | 25,524 行 |
| `libjimage/`（imageFile.cpp 等 10 文件）+ unix 平台 (1) | 2,688 行 |
| **合计（书内容）** | **~5,400 行** |

> **v2→v3 修正**: zlib 是第三方代码，不应计入规模。实际可写内容约 5,400 行。

### 42. Core Native (libjava.so)

| 来源 | 源文件 | 规模 |
|------|------|:--:|
| share/native/libjava/ | 48 文件（反射/IO/进程/对象/系统/字符串/异常 等 6+ 主题） | 6,802 行 |
| unix/native/libjava/ | 23 文件（ProcessHandle, ProcessImpl, TimeZone, UnixFileSystem 等） | ~5,160 行 |
| linux/native/libjava/ | ProcessHandleImpl_linux.c + CgroupMetrics.c | 329 行 |
| `share/native/include/` | jni.h (1973), jvmticmlr.h, classfile_constants.h.template, jni_md.h | 2,726 行 |
| **合计** | | **~77 文件 / ~15,000 行** |

> **v2→v3 修正**: v2 仅列 share/ 层 (48f/6802行)，补充 unix/linux 平台层 (+~5500行)。**域 46 JNI Headers 合并入本域**（只有声明无实现，作为开篇参考章节）。

### 43. NIO & Net

| 来源 | 源文件 | 规模 |
|------|------|:--:|
| share/native/libnio/ | 2 文件（share 层几乎为空） | 73 行 |
| unix/native/libnio/ | 20 文件（Net.c 814行, UnixNativeDispatcher.c 1244行 等） | ~4,600 行 |
| linux/native/libnio/ | EPoll, LinuxNativeDispatcher, LinuxWatchService | 481 行 |
| share/native/libnet/ | 8 文件 | 939 行 |
| unix/native/libnet/ | 17 文件（NetworkInterface 2172行, PlainDatagramSocket 2221行 等） | ~10,300 行 |
| linux/native/libnet/ | linux_close.c | 454 行 |
| jdk.net/ (libextnet) | 4 文件 | 632 行 |
| **合计** | | **~55 文件 / ~17,500 行** |

> **v2→v3 修正**: v2 写 "14 文件"——这是全组最严重的低估。libnio 的 share/ 层几乎为空，所有实现在 unix/linux 平台层。建议内部拆分为 NIO 通道实现与 Net 网络栈两个子簇。

### 44. Class Verification (libverify.so)

| 源文件 | 规模 |
|------|:--:|
| `share/native/libverify/`: check_code.c (4418行), check_format.c, opcodes.in_out | 4 文件 / 4,959 行 |

> **v2→v3 修正**: 文件数 2→4（补充 opcodes.in_out）。check_code.c 4418 行是完整字节码校验算法——文件少但内容密集，值得独立篇章。

### 45. Math Library (libfdlibm)

| 源文件 | 规模 |
|------|:--:|
| `share/native/libfdlibm/`: 57 个 .c 数学函数 + fdlibm.h + jfdlibm.h | 59 文件 / 6,448 行 |

### 46. SA Postmortem (libsaproc)

| 源文件 | 规模 |
|------|:--:|
| `jdk.hotspot.agent/linux/native/libsaproc/`: ps_core.c (1134), ps_proc.c, LinuxDebuggerLocal.c, symtab.c, libproc_impl.c 等 | 12 文件 / 3,872 行 |

### 47. Instrumentation Agent (libinstrument)

| 源文件 | 规模 |
|------|:--:|
| share/native/libinstrument/ (19 文件) + unix/ (3 文件) | 22 文件 / 5,331 行 |

---

## 十一、基础库 & 公共设施（1 域）[v3.2 BUILD 验证新增]

> ⚠️ BUILD 系统交叉验证发现：`share/utilities/` 目录 101 文件 / 25,426 行整目录编译进 libjvm.so 但未被任何域认领。这是 v3 审查的最大单一遗漏。

### 48. Utilities & Infrastructure

| 源文件 | 规模 |
|------|:--:|
| `share/utilities/` 全 101 文件（36 .cpp 编译进 libjvm.so）| 25,426 行 |
| `share/metaprogramming/` 16 文件（C++ 模板元编程 type traits，被 accessBackend 等大量引用）| 834 行 |

**内部聚类**:
- **基础类型/容器**: accessFlags, bitMap, bytes, constantTag, globalDefinitions, growableArray, hashtable, sizes, utf8
- **输出基础设施**: ostream, defaultStream, xmlstream, json, formatBuffer
- **异常/错误处理**: exceptions, preserveException, vmError, errorReporter
- **ELF/Native 解析**: decoder, elfFile, elfFuncDescTable, elfStringTable, elfSymbolTable
- **同步/并发工具**: globalCounter, singleWriterSynchronizer, spinYield
- **调试/诊断**: debug, events, histogram, internalVMTests
- **其他**: copy, numberSeq, nativeCallStack, virtualizationSupport, ticks

> **分析深度**: 本域为全 VM 依赖的基础设施层。大部分是 template/utility 类，不承载 GC/编译器级设计决策。知识规划时标注为"参考深度"（工作机制了解即可），不要求逐文件深挖。少数值得关注的文件：`decoder.cpp`（native 栈符号解析——崩溃报告核心）、`elfFile.cpp`（ELF 解析）、`vmError.cpp`（VM 崩溃终止流程）。

> **legacy 标注**: `prims/evmCompat.cpp`（52 行 ExactVM 兼容桩）编译进 libjvm.so 但属于历史遗留——4 个空 ShouldNotReachHere 函数，归入本域作 footnote。

---

## 巨型域汇总

| 域 | 文件数 | 行数 | 建议拆分 | 拆分篇数 |
|:--:|:--:|:--:|------|:--:|
| C2 Compiler (域15) | 136 | ~176,000 | 8-10 篇 | 含 .ad 文件 37K |
| G1 GC (域26) | 197 | ~46,000 | 8-10 篇 | |
| GC Framework (域25) | 184 | ~37,000 | 8 篇 | 含 ~26% 死代码 |
| OOPs (域6) | 87 | 38,424 | 6-8 篇 | v3 新增标注 |
| ClassFile (域7) | 75 | 46,169 | 6-8 篇 | v3 新增标注 |
| JFR (域32) | 217 | 34,828 | 6-8 篇 | |
| Assembler (域2) | ~38 | ~28,200 | **评估** | 接近阈值 |
| Utilities (域48) | 101 | 25,426 | 参考深度 | 基础设施层 |

---

## cpu/x86 横切层索引

cpu/x86/ **不是一个独立域**——是每个域的平台镜像层。103 个顶层文件 + 8 个 gc/ 文件 = 111 文件 / ~127,646 行，横跨以下域：

| 归属域 | cpu/x86 文件数 | 行数 |
|------|:--:|:--:|
| Assembler (域2) + CPU Primitives (域5) | ~38 | ~42,000 |
| C2 (域15) | 7 | 37,037 |
| SharedRuntime (域21) | 3 | 7,340 |
| C1 (域14) | 16 | 10,676 |
| StubRoutines (域23) | 6 | 10,777 |
| Interpreter (域8) | 10 | 10,636 |
| Code Cache (域16) | 13 | 2,951 |
| Frame (域24) | 5 | 1,206 |
| GC (域25+26) | 8 | 1,417 |
| MethodHandles (域29) | 2 | 704 |
| JNI (域27) | 3 | 753 |

---

## 与 v2 的变更摘要

| 变更项 | 说明 |
|------|------|
| 域总数 | 46 → **48** (+2 新增 [CPU Primitives, Frame & Stack Walking], +1 BUILD验证新增 [Utilities], -1 合并 [JNI Headers→Core Native]) |
| 域边界修正 | 域 1(OS), 8(Memory), 9(Metaspace), 10(CDS) 完全重定义 |
| cpu/x86 补充 | 9 个域补充平台实现文件 |
| unix/linux 补充 | 3 个 JDK Native 域修正文件数/行数 |
| 巨型域新增 | OOPs (38424行), ClassFile (46169行) |
| 孤儿文件处置 | runtime/ 67 个孤儿 → 分散归入已有域或新域 |
| 遗漏库 | 加回 libmanagement_agent(400行), libjsig(351行), jspawnhelper(152行) |
| 排除库 | libsunec(19K), libj2pkcs11(14K), libj2gss(3.9K), libjaas, libprefs |
| 文件/行数统计 | 17 个域修正了不准确的数字 |
| 死代码识别 | GC Framework 中 26% (~9,500行) 经典代际模型是死代码 |
| BUILD 验证 | 补充 os_cpu/linux_x86/ (16f→域1)、libadt/ (3f→域15)、compilationPolicy (4f→域13)、utilities/ (101f→域48) |
| v3.1 遗漏修复 | runtime/ 18 遗漏全量认领（handles→OOPs, signature/field→ClassFile, init→VMOps, memprofiler→Monitoring） |
| 统计修正 | JVMTI 31→46文件, Arguments 23→21文件, CPU Primitives orderAccess 3→2文件, 幽灵 jni_misc.hpp 删除 |
| v3.3 FINAL 扫描 | java.management/libmanagement 遗漏修复 + share/include/ 头文件归属 + metaprogramming/→域48 + adlc 排除声明 |

---

## 后续步骤

1. 确认 v3.2 域清单（48 域）→ 重组 knowledge-planning/ 目录结构
2. 为 48 域创建知识规划文件桩
3. 从域 1 OS 抽象层开始逐源提取
