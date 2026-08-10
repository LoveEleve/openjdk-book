# 域 28: JVMTI — 知识规划

> 源码路径: hotspot/share/prims/jvmti* (46文件) + methodComparator.* + relocator.* + resolvedMethodTable.* + privilegedStack.*
> 源码量: ~54 文件 | 🟡 大域（含 jvmti.xml 规范14993行）

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| jvmtiEnv.hpp/cpp + jvmtiEnvBase.hpp/cpp + jvmtiEnvThreadState.hpp | **JvmtiEnv — Agent 环境**: 每 JVMTI agent 一个 JvmtiEnv 实例, jvmtiCapabilities(能力集: can_tag_objects/can_generate_breakpoint_events 等 ~100 种), JvmtiEventCallbacks(回调注册), SetEventNotificationMode(JVMTI_ENABLE/JVMTI_DISABLE) | High |
| jvmtiRedefineClasses.hpp/cpp | **RedefineClasses — 类重定义**: 字节码替换(类热更新), 旧类→新类 metamorposis, invalidate nmethod(deopt compiled code), constant_pool merge, methodComparator("旧字节码≈新字节码?") | High |
| jvmtiImpl.hpp/cpp + jvmtiTagMap.hpp/cpp | **JVMTI Implementation**: 标签系统(JVMTI_HEAP_REFERENCE), jvmtiEventController(事件分派), jvmtiThreadState(per-thread JVMTI state), JvmtiDeferredEventQueue(延迟事件) | High |
| jvmtiEventController.hpp/cpp | **事件控制器**: event enabled/disables bitset, 每线程 JvmtiEventEnabled flag, check JvmtiExport::should_post_event→dispatch to agent callback | Medium |
| methodComparator.hpp/cpp | **MethodComparator**: 字节码逐条比较——RedefineClasses 需要 "新旧方法是否等效?"——如果字节码一致→保留 nmethod(不需要 deopt); 反之→失效 nmethod | Medium |
| relocator.hpp/cpp | **Relocator — 字节码重写**: 在 RedefineClasses 重写类字节码时, 修正 constant_pool 索引, 跳转目标, line_number_table 等重定位信息 | Medium |
| resolvedMethodTable.hpp/cpp | **ResolvedMethodTable**: Method*→索引映射, 用于 JVMTI Breakpoint 的快速方法查找 | Medium |
| jvmti.xml (14993行) | **JVMTI Specification**: XML 格式的 JVMTI 规范定义——所有 Capability/Event/Function 的正式定义和参数描述 | Low (规范文档) |
| privilegedStack.hpp/cpp | **PrivilegedStack**: 特权栈帧——doPrivileged 调用栈探测, AccessController 权限检查 | Low |

*9 知识点*

## 02 聚合 — P1/P2/P3

### P1 (≥5)
| KP | 出现文件 |
|----|---------|
| JvmtiEnv + Capability + Event 系统 | jvmtiEnv.*, jvmtiImpl.*, jvmtiEventController.*, jvmtiRedefineClasses.cpp, jvmtiTagMap.* |

### P2 (2-4)
| KP | 出现文件 |
|----|---------|
| RedefineClasses (类重定义) | jvmtiRedefineClasses.*, methodComparator.*, relocator.*, resolvedMethodTable.* |

### P3 (1-2)
| KP | 文件 |
|----|------|
| PrivilegedStack | privilegedStack.* |

## 03 深度分类

### 🔴 Deep (2 KP)
| KP | 为什么 🔴 |
|----|---------|
| JvmtiEnv + Capability + Event Dispatch | JVMTI 的核心——agent 通过 capability 声明需要哪些功能(JVM 据此决定是否开启相关数据收集), 通过 SetEventNotificationMode 控制事件流(event bitset per-thread→JvmtiEventController→deferred events→fire to agent)。Capability 两阶段: phase_start 声明→phase_live 真正启用。Event 分派走 fast path: check bit→dispatch→return |
| RedefineClasses + MethodComparator | JVMTI 的最复杂特性——运行时替换类的字节码: 旧类→GC root扫描→失效相关 nmethod(not_entrant)→重新解析→新方法表→重新编译。MethodComparator 比较新旧字节码——如果一致→保留 nmethod(不需要 deopt)→如果方法签名变→完全失效 nmethod。ClassFileParser 重新解析新类, constant_pool merge 处理新旧常量池差异 |

### 🟡 Working (2 KP)
| KP | 说明 | 为什么 🟡 |
|----|------|------|
| JvmtiTagMap (HEAP_REFERENCE) | JVMTI FollowReferences——标记对象→生成堆引用图→用于 heap dump/profiling | 是 JVMTI 的高级特性——不是所有 agent 需要 |
| ResolvedMethodTable + Relocator | Method→索引映射 + 字节码重写 | RedefineClasses 的辅助工具 |

### 🟢 Surface (1 KP)
| KP | 说明 |
|----|------|
| PrivilegedStack / jvmti.xml spec | 权限检查 + XML 规范 |

## 04 聚类 — 3篇

| 篇 | 标题 | 核心问题 | 预估 |
|:--:|------|------|:--:|
| 1 | JVMTI Agent 架构 | "JVMTI agent 怎么装载？capability 系统怎么工作？事件怎么分派？" | 核心 |
| 2 | RedefineClasses — 运行时换类 | "怎么不重启 JVM 替换一个类的字节码？" | 核心 |
| 3 | 辅助设施 (TagMap + 事件分派细节) | "JVM 怎么为每个对象打 tag？事件延迟队列怎么处理？" | 深度 |
