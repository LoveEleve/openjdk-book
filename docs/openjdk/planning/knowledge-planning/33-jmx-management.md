# 域 33: JMX & Management — 知识规划

> 源码: services/management.* + memoryManager.* + memoryPool.* + gcNotifier.* + lowMemoryDetector.* + writeableFlags.* + JDK Native(jdk.management/ + java.management/) + jmm.h | ~66文件 | 🟡 大域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| services/management.hpp/cpp + jmm.h | **Management — JMM 接口**: jmm_GetVersion/jmm_GetOptionalSupport/jmm_GetInputArguments/jmm_GetMemoryUsage, JMM 接口(JVM↔JDK management bridge) | High |
| services/memoryService.hpp/cpp + memoryManager.hpp/cpp + memoryPool.hpp/cpp | **MemoryService — 内存管理**: MemoryService(per-GC memory tracking), MemoryManager(G1/Parallel/Serial manager 对象), MemoryPool(Eden/Survivor/Old/Metaspace/CodeCache pools), MemoryUsage 统计 | High |
| services/gcNotifier.hpp/cpp + lowMemoryDetector.hpp/cpp | **GC Notifier + Low Memory Detector**: notification on GC(com.sun.management.GcInfo), low memory trigger(threshold exceeded→ManagementFactory notification), sensor registration per MemoryPool | Medium |
| services/writeableFlags.hpp/cpp | **WriteableFlags — 运行时可写标志**: set_flag_value(修改 JVM 标志 at runtime), HotSpotDiagnosticMXBean 依赖 | Medium |
| jdk.management/ (39文件 C, libmanagement_ext) | **Management_ext (C): HotSpotDiagnostic jni 实现, diagnosticCommand/flag/thread dump via native code | Medium |
| java.management/ (10文件 C, libmanagement) | **Management (C): JMM interface 的 thin wrapper, jmm_GetMemoryUsage/jmm_GetThreadInfo | Low |
| jdk.management.agent/ (~400行 C) | **Management Agent**: -javaagent JMX connector startup | Low |

*7 知识点*

## 02 聚合 — P1/P2

### P1
| KP | 出现文件 |
|----|---------|
| MemoryService + MemoryPool tracking | services/memory*.*(6文件), jmm.h(接口声明), JDK Native management impl |

### P2
| KP | 出现文件 |
|----|---------|
| JMM Interface (jmm.h) | jmm.h, services/management.cpp, java.management/ |

### P3
| KP | 文件 |
|----|------|
| GC Notifier | gcNotifier.* |
| LowMemoryDetector | lowMemoryDetector.* |
| WriteableFlags | writeableFlags.* |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| MemoryService + MemoryPool/MemoryManager 层次 | JVM 的内存管理接口——`MemoryService` 管理所有 MemoryManager(G1/ZGC/Parallel各一个)和 MemoryPool(~10 个: Eden/Survivor/Old/Metaspace/CodeCache/Compressed Class Space)。每个 Pool 有 usage/peakUsage/collectionUsage statistics。GC 后 update——Jconsole 据此显示 heap curve。MemoryManager 的 notification 让 GC info 从 JVM→JMX→JDK |

### 🟡 Working (2 KP)
| KP | 说明 | 为什么 🟡 |
|----|------|------|
| JMM Interface (JMMX_*) | jmm.h 声明了 ~20 个 JMM_* 函数——JDK management agent 通过它查询 JVM 内存状态 | 是 thin bridge——逻辑不深 |
| LowMemoryDetector + GC Notifier | per-pool threshold + sensor 系统——超出阈值→send notification | 辅助通知——不影响 JVM 运行 |

### 🟢 Surface (1 KP)
| KP | 说明 |
|----|------|
| WriteableFlags + Management_ext/agent | runtime flag 修改 + JDK C thin wrapper |

## 04 聚类 — 3篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | MemoryService + MemoryPool | "JConsole 怎么知道 Eden 用了多少？heap curve 数据来自哪里？" |
| 2 | JMM 接口 + JDK Management | "JDK 怎么查询 JVM 内存状态？jmm.h 接口是什么？" |
| 3 | GC Notifier + LowMemory + Flags | "怎么在内存接近溢出时得到通知？运行时可改哪些标志？" |
