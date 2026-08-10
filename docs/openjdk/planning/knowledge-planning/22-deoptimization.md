# 域 22: Deoptimization — 知识规划

> 源码路径: hotspot/share/runtime/deoptimization.*
> 源码量: 2 文件 / ~2,890 行 | 🟡 普通域（重度依赖域16 CodeCache + 域24 Frame）

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| deoptimization.hpp:42-104 | **DeoptReason — 20+ 种逆优化原因**: null_check/null_assert/range_check/class_check/array_check/intrinsic/bimorphic/profile_predicate/unloaded/uninitialized/unreached/unhandled/constraint/div0/age/predicate/loop_limit/speculate_class/speculate_null/rtm_state/unstable_if/tenured | High |
| deoptimization.hpp:108-115 | **DeoptAction — 5 种处理措施**: Action_none(只解释,不使nmethod无效), Action_maybe_recompile(重编译nmethod,不需失效), Action_reinterpret(失效nmethod,重置IC,可能重编译), Action_make_not_entrant(失效nmethod,重编译), Action_make_not_compilable(失效nmethod+不再编译) | High |
| deoptimization.hpp:116-130 | **trap_state 编码**: 31-bit packed(3 action + 5 reason + 23 debug_id)——存MethodData的_trap_data中, trap_reason_limit=Reason_TRAP_HISTORY_LENGTH(per-bci记录上限) | High |
| deoptimization.cpp:uncommon_trap | **uncommon_trap — deopt 入口**: 从UncommonTrapBlob触发→Deoptimization::uncommon_trap(thread, trap_request, fr, bci)→判断DeoptReason→执行DeoptAction→标记nmethod not_entrant→调用unpack重建帧 | High |
| deoptimization.cpp:unpack_deoptimization | **unpack_deoptimization**: 创建vframeArray(编译帧→虚拟解释器帧), recreate vframe chain(scope→locals→monitors→bcp), 分配解释器栈帧(populate→copy scope values→link frames), 最后frame→return解释器入口 | High |
| deoptimization.cpp:make_not_compilable | **make_not_compilable**: 调用Method::set_not_compilable(comp_level)→防止后续编译请求。trap_count>PerBytecodeTrapLimit(默认100)→永久禁编译该方法的该level | High |
| deoptimization.cpp:fetch_unroll_info | **fetch_unroll_info**: 从编译帧 gather debug info(scope/oop/locals/expressions/monitors)→填充UnrollBlock(vframeArray+返回帧大小+caller参数) | Medium |

*7 个知识点*

## 02 聚合

### P1 — 系统级共识
| KP | 出现文件 |
|----|---------|
| uncommon_trap → unpack_deoptimization → vframeArray 管线 | deoptimization.*, frame.hpp(域24), scopeDesc.hpp(域16), vframeArray.hpp |

### P2 — 局部重要
| KP | 出现文件 |
|----|---------|
| DeoptReason + DeoptAction 决策表 | deoptimization.hpp, methodData.hpp(域6, trap counters), dependencies.hpp(域16, dep失效触发) |

### P3 — 孤立
| KP | 文件 |
|----|------|
| trap_state 31-bit 编码 | deoptimization.hpp |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (2 KP)
| KP | 为什么 🔴 |
|----|---------|
| DeoptReason→DeoptAction 决策表 | 不是所有 deopt 都会使 nmethod 失效——null_check 可能是 rare event→Action_maybe_recompile(保留nmethod,重新profiling)。class_check 是类型假设破产→Action_make_not_entrant(失效后重新编译更保守的假设)。unloaded/reached_limit→Action_make_not_compilable(永久禁编译,防止反复deopt)。这个决策表决定了 JIT"乐观优化"的成本上限 |
| uncommon_trap→vframeArray→unpack 帧重建管线 | deopt 的核心工程——从编译帧重建解释器帧。不是"扔掉重来"——是"反编译内联树变回栈帧链"。vframeArray 每层存放一个 scope 的 locals+expressions+monitors——unpack 逐个栈帧 allocate+populate——最后 frame 包含 caller bci 和正确的方法——解释器从断点继续执行 |

### 🟡 Working — 有设计但非核心 (2 KP)
| KP | 说明 | 为什么 🟡 非 🔴 |
|----|------|------|
| trap_state 31-bit 编码 | 3+5+23 bit packed——存 MethodData 中用于 profiling 反馈 | 是编码细节——理解不改变deopt机制认知 |
| fetch_unroll_info | 从编译帧提取 debug info | 是 unpack 的准备步骤——自身不决定 deopt 行为 |

### 🟢 Surface — 了解即可 (1 KP)
| KP | 说明 |
|----|------|
| make_not_compilable 阈值 | PerBytecodeTrapLimit=100→永久禁编译——防止 hot 方法反复 deopt-recompile loop |

## 04 聚类 — 文章拆分: 2篇

| 篇 | 标题 | 覆盖 KP | 核心问题 |
|:--:|------|:--:|------|
| 1 | Deopt 决策 — 什么时候逆优化？ | 20+ DeoptReason, 5 DeoptAction, MethodData counters, trap history, 依赖失效通知 | "一段编译好的代码——什么时候 JVM 决定'你不行了，回解释器'？" |
| 2 | Deopt 执行 — 从编译帧回到解释器 | uncommon_trap→unpack_deoptimization→vframeArray→unpack frames→populate→解释器入口 | "从编译代码回退到解释器——栈帧怎么变？局部变量从哪来？" |
