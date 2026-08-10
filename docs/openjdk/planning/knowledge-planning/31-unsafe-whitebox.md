# 域 31: Unsafe & WhiteBox — 知识规划

> 源码: prims/unsafe.* + whitebox.* + forte.* | 9文件 | 🟡 普通域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| unsafe.hpp/cpp | **Unsafe — JDK 底层访问**: ~200 native 方法(compareAndSwapInt/putOrderedInt/getObjectVolatile/allocateInstance/defineAnonymousClass/park/unpark/setMemory), 绕过 Java 安全模型(不检查访问权限), 直接内存/字段/数组操作 | High |
| whitebox.hpp/cpp + wbtestmethods/ | **WhiteBox — JVM 测试 API**: GC/Compiler/CodeCache/Class/Method 等的内部测试入口, wbtestmethods(测试用例用), WB_EnqueueInitializerForObj(测试 Reference processing) | Medium |
| forte.hpp/cpp | **Forte — AsyncGetCallTrace**: 安全点外栈采样(不暂停 JVM), Agent_OnLoad + JvmtiExport, 用于 JFR/async-profiler 的性能采样 | Medium |

*3 知识点*

## 02 聚合 — P1/P2

### P1
| KP | 出现文件 |
|----|---------|
| Unsafe ~200 native 方法 | unsafe.*, whitebox.cpp(共用内部函数) |

### P2
| KP | 出现文件 |
|----|---------|
| WhiteBox 测试 API | whitebox.*, wbtestmethods/* |

### P3 (1)
| KP | 文件 |
|----|------|
| Forte async stack trace | forte.* |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| Unsafe — JVM 底层访问的完整接口 | JDK 内部最底层的访问 API——通过 Unsafe JDK 类实现了 `AtomicInteger`(CAS)、`ConcurrentHashMap`(putOrderedObject)、`DirectByteBuffer`(allocateMemory) 等核心并发/内存特性。绕过所有 Java 安全检查——仅限 JDK 内部类访问——通过 `jdk.internal.misc.Unsafe`(Java 9+) 或 `sun.misc.Unsafe`(legacy)。`park/unpark` 实现了 `LockSupport` 的底层——是 Java 并发的基石 |

### 🟡 Working (1 KP)
| KP | 说明 |
|----|------|
| WhiteBox 测试 API | JVM 开发和测试专用——GC/Compiler/CodeCache 内部白盒测试。通过 `-XX:+UnlockDiagnosticVMOptions -XX:+WhiteBoxAPI` 开启 |

### 🟢 Surface (1 KP)
| KP | 说明 |
|----|------|
| Forte (AsyncGetCallTrace) | 安全点外栈采样——JFR 和 async-profiler 共用 |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | Unsafe — JVM 底层 API | "AtomicInteger.compareAndSet 在 JVM 里怎么实现？park/unpark 怎么工作？" |
| 2 | WhiteBox + Forte | "JVM 开发者怎么测试 GC 内部行为？AsyncGetCallTrace 怎么不在 safepoint 采栈？" |
