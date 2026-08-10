# 域 13: JIT Framework — 知识规划

> 源码路径: hotspot/share/compiler/ + runtime/compilationPolicy.* + runtime/tieredThresholdPolicy.* | 源码量: ~28 文件 / ~13,900 行 | 中型域
> 拆 2 篇

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| compileBroker.hpp.cpp | **CompileBroker — 编译代理**: 编译队列管理 (_compile_queue), compiler threads (C1+C2), submit_compile_task, invoke_compiler_on_method, 编译策略分发 | High |
| compileTask.hpp.cpp | **CompileTask — 编译任务**: method/osr_bci/compile_kind/compile_id, 任务状态 (in_queue/compiling/compiled/failed), 超时检测 | High |
| compilationPolicy.hpp.cpp + tieredThresholdPolicy.hpp.cpp | **CompilationPolicy + TieredThresholdPolicy**: 编译触发决策, invocation/backedge counter 阈值, TieredCompilation 层级选择 (C1/C2/C1-with-profiling), OSR policy | High |
| abstractCompiler.hpp.cpp + compilerDefinitions.hpp.cpp | **AbstractCompiler — 编译器抽象**: C1/C2 的公共接口, compiler_kind, compile_method, 编译器选项 | High |
| compilerDirectives.hpp.cpp + directivesParser.hpp.cpp | **CompilerDirectives — 编译指令**: -XX:CompileCommand, 方法级编译开关 (exclude/inline/dontinline/compileonly), directives file 解析 | Medium |
| compileLog.hpp.cpp | **CompileLog — JIT 编译日志**: 每次编译的详细日志, 方法名/编译层级/时间/message, jitwatch 的输入 | Medium |
| oopMap.hpp.cpp | **OopMap — GC 栈映射**: 编译代码中 OOP 位置, OopMapSet, GC 扫描编译帧的导航 | High |
| methodMatcher.hpp.cpp | **MethodMatcher — 方法匹配**: CompileCommand 的方法名匹配 (通配符/正则), 编译指令的 method selection | Low |

*8 个知识点*

## 02 深度分类

### 🔴 Deep — 核心设计决策 (3 KP)
| KP | 为什么🔴 |
|----|---------|
| CompileBroker + compile queue | 编译队列——优先级排序 (invocation_count+backedge_count)——compiler threads (C1×1, C2×2)——为什么需要单独线程？编译在 safepoint 外进行——不影响 Java 线程。队列管理保证高优先级方法先编译 |
| TieredThresholdPolicy — 分层编译决策 | 5 层：L0(解释器)→L1(C1 no profiling)→L2(C1 basic profiling)→L3(C1 full profiling)→L4(C2)。每次层级提升——需要更多的 invocation counter。L2/L3 的 profiling data 是 L4 (C2) 的输入——没有 profiling→C2 优化降级 |
| OopMap — GC 扫描编译帧 | 编译代码的 OopMapSet——每个 safepoint 的 OOP 位置——GC 扫描编译帧——从 OopMap 找所有 live OOP——更新 forwarding pointer |

### 🟡 Working — 有设计但非核心 (3 KP)
| KP | 说明 |
|----|------|
| CompilerDirectives — 编译指令 | 方法级编译控制 |
| CompileLog — 编译日志 | jitwatch 输入 |
| CompilationPolicy — 基础策略 | 非 Tiered 的简单编译触发 |

### 🟢 Surface — 了解即可 (2 KP)
| KP | 说明 |
|----|------|
| MethodMatcher | 方法名匹配 |
| AbstractCompiler/CompilerDefinitions | 抽象层/定义 |

## 03 聚类 — 教学顺序与文章拆分

### 教学顺序

```
1. 编译队列 — CompileBroker + compile task + compiler threads
2. 编译策略 — TieredCompilation + OopMap
```

### 文章拆分建议

2 篇:

- **01-compile-broker-queue.md** — CompileBroker + CompileTask + compiler threads
- **02-tiered-compilation-policy.md** — TieredThresholdPolicy + CompilerDirectives + OopMap + CompileLog
