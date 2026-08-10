# Deoptimization 第一遍产出：编译→解释器的安全回退

> vol-04 · 域 30 · 🟡 B | Pass 1 扫描完成
> 源码：`runtime/deoptimization.*` 2422行 + `runtime/vframeArray.*` 911行

## 架构图

```
编译代码 (nmethod) 执行中
  │  ▶ 假设被打破: class loaded / null check failed / loop limit hit
  │
  ▼
[调用约定桥接]
  │  SharedRuntime::deopt_blob / uncommon_trap_blob
  │  保存 callee-saved registers → 进入 C++ 世界
  ▼
┌───────────────────────────────────────────────────────────┐
│                Deoptimization (AllStatic)                   │
│                                                           │
│  Phase 1: fetch_unroll_info()                              │
│  ┌─────────────────────────────────────────────────┐     │
│  │ 1. 读 compiled frame (frame::sender_for_compiled) │     │
│  │ 2. 遍历 nmethod → ScopeDesc → DebugInfoReadStream │     │
│  │ 3. 为每个内联层创建 compiledVFrame               │     │
│  │ 4. create_vframeArray: compiledVFrame[] → 解释器帧│     │
│  │ 5. realloc_objects: 重建标量替换的对象            │     │
│  │ 6. 返回 UnrollBlock (帧大小+PC+寄存器块)         │     │
│  └─────────────────────────────────────────────────┘     │
│         │                                                 │
│         ▼ (UnrollBlock 传给汇编 stub)                      │
│  Phase 2: 汇编 stub (deopt handler blob)                   │
│  ┌─────────────────────────────────────────────────┐     │
│  │ 1. 按 UnrollBlock 在栈上分配解释器帧空间       │     │
│  │ 2. 调用 unpack_frames() (C++)                   │     │
│  │ 3. 恢复 callee-saved registers                  │     │
│  │ 4. 设置解释器 PC → 跳到解释器继续执行           │     │
│  └─────────────────────────────────────────────────┘     │
│                                                           │
│  Phase 3: unpack_frames() + 后处理                        │
│  ┌─────────────────────────────────────────────────┐     │
│  │ 1. 为每帧填充: locals/monitors/expr_stack/return │     │
│  │ 2. reassign_fields: fill scalar-replaced objects │     │
│  │ 3. relock_objects: 重建 monitor 锁状态           │     │
│  │ 4. update_method_data: 记录 trap 到 MDO         │     │
│  │ 5. 根据 DeoptAction 决定: 保留/重编/标记不可编译│     │
│  └─────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────┘
  │
  ▼
解释器继续执行 (在安全回退点)
```

## 基本元素分解

1. **Deoptimization** — `AllStatic` 去优化引擎。提供 `uncommon_trap()`（编译器主动触发）、`deoptimize()`（运行时被动触发）、`fetch_unroll_info()`（读编译帧构造 vframeArray）、`unpack_frames()`（写解释器帧到栈）。`deoptimization.hpp:36`

2. **DeoptReason** — 30+ 种去优化原因。分两类：(a) 每字节码记录的（null_check/range_check/class_check/bimorphic 等 — 8 种），(b) 每方法记录的（unloaded/uninitialized/predicate/loop_limit_check 等 — 15+ 种）。每种 reason 对应一种被打破的编译器假设。`deoptimization.hpp:42-104`

3. **DeoptAction** — 去优化后对 nmethod 的处理动作。4 种：`Action_none`（只解释不失效）、`Action_maybe_recompile`（可重编）、`Action_reinterpret`（失效+重置IC+可能重编）、`Action_make_not_compilable`（永久标记不可编）。Reason→Action 映射表定义在 `deoptimization.cpp`。`deoptimization.hpp:108-115`

4. **UnrollBlock** — 去优化的"蓝图"。从 `fetch_unroll_info()` 返回给汇编 stub，包含：每帧的大小（_frame_sizes）、每帧的 PC（_frame_pcs）、callee-saved 寄存器块、caller adjustment、return type。汇编 stub 按此蓝图在栈上重建解释器帧。`deoptimization.hpp:178-211`

5. **vframeArray** — 解释器帧的虚拟表示。通过 `create_vframeArray()` 从编译帧创建——遍历 nmethod 的 ScopeDesc/PCDesc/DebugInfoReadStream，为每个内联层生成 `compiledVFrame`，包含该层的方法/BCI/局部变量/操作数栈/monitors。`vframeArray.hpp`

6. **realloc_objects** — 重建标量替换对象的函数。C2 逃逸分析如果标量替换了对象（NoEscape→字段变局部变量），去优化时必须"反向替换"——在堆上分配真实对象，从寄存器/栈中恢复字段值。`deoptimization.hpp:162`

7. **UnpackType** — 4 种展开模式。`Unpack_deopt`（正常去优化，从 PC 恢复执行）、`Unpack_exception`（异常待处理，跳到 handler）、`Unpack_uncommon_trap`（C2 uncommon trap，重执行当前字节码）、`Unpack_reexecute`（C1 的重试模式）。不同模式对应不同的执行恢复策略。`deoptimization.hpp:127-133`

8. **MonitorValue / ObjectValue** — 去优化信息中的锁和对象值表示。`MonitorValue` 描述在 deopt 时需要重新锁住的 monitor（持有 monitor 的 oop + BasicLock 位置）。`ObjectValue` 描述标量替换对象在去优化时需要重新分配的对象（字段值来源列表）。

## 标记问题（≥5）

1. **[设计决策] 30+ DeoptReason 的设计原理** — 为什么需要这么多种 reason？每种 reason 对应什么被打破的编译器假设？Null check/receiver type check/loop limit——为什么不能合为"assumption_failed"一个 reason？

2. **[关键流程] fetch_unroll_info→UnrollBlock→unpack_frames 的三阶段怎么串联** — 编译帧的寄存器值怎么映射到解释器帧的局部变量表？ScopeDesc/PCDesc/DebugInfoReadStream 的协作方式是什么？

3. **[设计决策] realloc_objects 的复杂度** — 标量替换的对象在 deopt 时需要"反标量化"——在堆上分配对象+填充字段。这和正常 new 有什么区别？为什么要在 deopt 时做这件事（而不是在编译代码中就预留"un-scalarize"路径）？

4. **[策略设计] DeoptAction 的选择逻辑** — Reason_none→Action_none、Reason_null_check→Action_maybe_recompile？reason-action 映射表的设计原则是什么？什么时候必须 mark_not_compilable？

5. **[并发安全] deopt 过程中其他线程看到的栈** — 去优化在重建解释器帧时，其他线程可能通过 safepoint 扫描这个线程的栈——看到半建完的帧怎么办？

6. **[跨域] uncommon_trap 和 C2 的 profiling 反馈环路** — C2 插入了 uncommon trap→运行时触发→update_method_data 记录到 MDO→下次编译时 C2 读 MDO→调整优化决策。这个反馈怎么工作？Trap 计数如何影响 C2 的重编译决策？
