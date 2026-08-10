# OpenJDK 域发现 v2 — 基于 JDK 11u 实际源码

> 2026-08-08 | 从头梳理，不以旧 43 域清单为基础
>
> 数据来源：`/data/workspace/jdk11u/src/` 全量源码探索

---

## 一、核心基础设施（4 域）

| # | 域 | 源码路径 | 规模 |
|:--:|------|------|:--:|
| 1 | OS 抽象层 | `runtime/os.*` + `hotspot/os/linux/` + `hotspot/os/posix/` | 7+ 文件 |
| 2 | Assembler | `asm/` + `cpu/x86/assembler_x86.*` + `macroAssembler_x86.*` | ~30 文件 (3169行) |
| 3 | Arguments & Flags | `runtime/arguments.*` + `runtime/globals.*` + `runtime/flags/` + `services/writeableFlags.*` | ~14 文件 |
| 4 | Logging | `logging/` | 37 文件 (5292行) |

## 二、对象模型（1 域）

| # | 域 | 源码路径 | 规模 |
|:--:|------|------|:--:|
| 5 | OOPs | `oops/` | 87 文件 (38424行) |

## 三、类加载与解释（2 域）

| # | 域 | 源码路径 | 规模 |
|:--:|------|------|:--:|
| 6 | ClassFile & ClassLoader | `classfile/` | 75 文件 (46169行) |
| 7 | Interpreter | `interpreter/` | 40 文件 (16639行) |

## 四、内存子系统（3 域）

| # | 域 | 源码路径 | 规模 |
|:--:|------|------|:--:|
| 8 | Memory 核心 | `memory/` (allocation, universe, heap, virtualspace, arena, guardedMemory) | ~50 文件 |
| 9 | Metaspace | `memory/metaspace/` | 子目录 (~20 文件) |
| 10 | CDS | `memory/filemap.*` + `memory/heapShared.*` | ~10 文件 |

## 五、执行引擎（5 域）

| # | 域 | 源码路径 | 规模 |
|:--:|------|------|:--:|
| 11 | Compiler Interface (ci) | `ci/` | 74 文件 (20932行) |
| 12 | JIT Framework | `compiler/` | 24 文件 (11733行) |
| 13 | C1 编译器 | `c1/` | 49 文件 (41074行) |
| 14 | C2 编译器 | `opto/` | 129 文件 (139595行) 🔴 巨型域 |
| 15 | Code Cache | `code/` | 47 文件 (23189行) |

## 六、运行时核心（7 域）— 从 173 文件 runtime/ 拆分

| # | 域 | 源码路径 | 规模 |
|:--:|------|------|:--:|
| 16 | Threads | `runtime/thread.*` + `runtime/threadSMR.*` + `runtime/handshake.*` | 12 文件 |
| 17 | Safepoint | `runtime/safepoint.*` + `runtime/safepointMechanism.*` + `runtime/safepointVerifiers.*` | 7 文件 |
| 18 | Synchronization | `runtime/objectMonitor.*` + `runtime/synchronizer.*` + `runtime/biasedLocking.*` + `runtime/mutex.*` + `runtime/park.*` | 17 文件 |
| 19 | VM Operations | `runtime/vmOperations.*` + `runtime/vmThread.*` | 4 文件 |
| 20 | Shared Runtime | `runtime/sharedRuntime.*` | 5 文件 |
| 21 | Deoptimization | `runtime/deoptimization.*` | 2 文件 |
| 22 | Stub Routines | `runtime/stubRoutines.*` + `runtime/stubCodeGenerator.*` | 4 文件 |

> **runtime/ 总览**: 173 文件 / 77779 行。上述 7 域覆盖约 51 文件，其余为 infrastructure（handles, timer, frame, vframe, signature, reflection, javaCalls, icache 等），归入对应域或作为辅料。

## 七、GC 子系统（2 域）

| # | 域 | 源码路径 | 规模 |
|:--:|------|------|:--:|
| 23 | GC Framework | `gc/shared/` | 178 文件 (36653行) 🔴 巨型域 |
| 24 | G1 GC | `gc/g1/` | 195 文件 (45692行) 🔴 巨型域 |

> ⚠️ JDK 11u 只有 G1 GC 一种实现（默认 GC）。无 CMS/Parallel/Serial。GC Framework 共享层包含 Reference Processing、BarrierSet、CollectedHeap、PLAB 等跨 GC 机制。

## 八、Native 接口（5 域）

| # | 域 | 源码路径 | 规模 |
|:--:|------|------|:--:|
| 25 | JNI | `prims/jni.*` + `runtime/jniHandles.*` + `prims/jniCheck.*` | ~8 文件 |
| 26 | JVMTI | `prims/jvmti*` | ~30 文件 |
| 27 | Method Handles | `prims/methodHandles.*` | 2 文件 |
| 28 | JVM Entry | `prims/jvm.*` + `prims/nativeLookup.*` | ~6 文件 |
| 29 | Unsafe & WhiteBox | `prims/unsafe.*` + `prims/whitebox.*` | ~5 文件 |

> **prims/ 总览**: 70 文件 / 46390 行。

## 九、可观测性（8 域）

| # | 域 | 源码路径 | 规模 |
|:--:|------|------|:--:|
| 30 | JFR | `jfr/` | 215 文件 (33539行) 🔴 巨型域 |
| 31 | JMX & Management | `services/management.*` + `jdk.management/` (native) | ~12 文件 |
| 32 | NMT | `services/memTracker.*` + `services/nmt*` + `services/virtualMemoryTracker.*` + `services/malloc*` | ~15 文件 |
| 33 | Diagnostic Commands | `services/diagnostic*` | ~8 文件 |
| 34 | Attach API | `services/attachListener.*` + `jdk.attach/` (native) | ~8 文件 |
| 35 | Heap Dumper | `services/heapDumper.*` | ~4 文件 |
| 36 | PerfData | `runtime/perfData.*` + `runtime/perfMemory.*` | 5 文件 |
| 37 | Runtime Monitoring | `runtime/serviceThread.*` + `services/classLoadingService.*` + `services/runtimeService.*` + `services/threadService.*` | ~6 文件 |

> **services/ 总览**: 56 文件 / 20072 行。

## 十、JDK Native 层（9 域）

> ⚠️ 源码位置不在 `hotspot/share/` 下，在 `java.base/`、`jdk.hotspot.agent/`、`java.instrument/`、`jdk.attach/`、`jdk.management/` 等模块。

| # | 域 | 源码路径 | 规模 |
|:--:|------|------|:--:|
| 38 | Launcher (libjli.so) | `java.base/share/native/libjli/` | 12 文件 (5401行) |
| 39 | ZIP & JIMAGE | `java.base/share/native/libzip/` + `libjimage/` | 43 文件 (29022行) |
| 40 | Core Native (libjava.so) | `java.base/share/native/libjava/` | 48 文件 (6802行) |
| 41 | NIO & Net | `java.base/share/native/libnio/` + `libnet/` + `jdk.net/` | 14 文件 |
| 42 | Class Verification | `java.base/share/native/libverify/` | 2 文件 (4692行) |
| 43 | Math Library | `java.base/share/native/libfdlibm/` | 59 文件 (6438行) |
| 44 | SA Postmortem | `jdk.hotspot.agent/linux/native/libsaproc/` | 12 文件 (3872行) |
| 45 | Instrumentation Agent | `java.instrument/share/native/libinstrument/` | ~20 文件 |
| 46 | JNI Headers | `java.base/share/native/include/` | 2 文件 (2088行) |

---

## 巨型域识别

以下域满足巨型域判定标准（文件数 ≥ 100 或行数 ≥ 30000），需拆 6-10 篇独立知识规划：

| 域 | 文件数 | 行数 | 建议拆分 |
|:--:|:--:|:--:|------|
| C2 Compiler (域14) | 129 | 139595 | 8-10 篇 |
| G1 GC (域24) | 195 | 45692 | 8-10 篇 |
| GC Framework (域23) | 178 | 36653 | 6-8 篇 |
| JFR (域30) | 215 | 33539 | 6-8 篇 |

---

## 与旧 43 域清单的关键差异

| 对比维度 | 旧清单 | 新清单 |
|------|------|------|
| 域总数 | 43 | **46** |
| runtime/ 拆分 | 1 个域 "Threads" | **7 个域** (Threads, Safepoint, Sync, VMOps, SharedRuntime, Deopt, StubRoutines) |
| prims/ 拆分 | 1 个域 "JNI 层" | **5 个域** (JNI, JVMTI, MethodHandles, JVM Entry, Unsafe) |
| services/ 拆分 | 混合归入可观测性 | **7 个独立域** |
| GC | 认为有 GC Framework + Reference + G1 | **只有 G1** (JDK 11u 无 CMS/Parallel/Serial) |
| OOPs 定位 | 归类为 vol-01 地基 | **独立域**（87 文件 38424 行） |
| JNI Headers | 缺失 | **新增** |

---

## 后续步骤

1. 确认域清单 → 调整 knowledge-planning/ 目录结构（按 10 组组织）
2. 为每个域创建知识规划文件
3. 从域 1 OS 抽象层开始逐源提取
