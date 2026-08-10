# C1 Compiler 第一遍产出：快速编译器

> vol-04 · 域 28 · 🔴 A | Pass 1 扫描完成
> 源码：`c1/` 49文件, 41074行 | 三阶段编译流水线

## 继承树/调用图

```
Bytecode (ciBytecodeStream)
 │
 └──┐ GraphBuilder (c1_GraphBuilder.hpp:38)
    │    ├── ScopeData 栈: 内联层级管理
    │    ├── BlockList: bci→block 映射
    │    └── build_hir(): 字节码→HIR
    │        输出: IR (BlockBegin→BlockEnd CFG)
    ▼
┌─────────────────────────────────────────────────────────┐
│                    HIR (High-Level IR)                    │
│  Instruction 层级 (c1_Instruction.hpp):                   │
│    ├── ArithmeticOp (IntArithmetic/FloatArithmetic)       │
│    ├── LogicOp (And/Or/Xor)                               │
│    ├── CompareOp / IfOp / IfInstanceOf                    │
│    ├── LoadField / StoreField / LoadIndexed / StoreIndexed │
│    ├── Invoke / NewInstance / NewArray / NewObjectArray   │
│    ├── Return / Throw / MonitorEnter / MonitorExit        │
│    ├── Phi / Constant / Local / UnsafeOp / AccessField    │
│    └── ShiftOp / Convert / NegateOp / ArrayLength         │
│                                                          │
│  HIR Optimizations:                                      │
│    ├── Canonicalizer  → 常量折叠/代数简化                  │
│    ├── Optimizer      → 块级优化/死代码消除               │
│    ├── ValueMap       → 全局值编号(GVN)                   │
│    └── RangeCheckElimination → 冗余边界检查消除            │
└─────────────────────────────────────────────────────────┘
 │
 └──┐ LIRGenerator (c1_LIRGenerator.hpp)
    │    ├── visit() 遍历每个 HIR Instruction
    │    ├── FrameMap: 栈帧/调用约定布局
    │    └── emit_lir(): HIR→LIR
    │        输出: LIR_List (LIR_Op* 链表)
    ▼
┌─────────────────────────────────────────────────────────┐
│                    LIR (Low-Level IR)                     │
│  LIR_Op 层级:                                            │
│    ├── LIR_Op0  (label/branch/return/nop)               │
│    ├── LIR_Op1  (move/nullCheck/return/condBranch)       │
│    ├── LIR_Op2  (arith/logic/compare/shift/convert/      │
│    │              cmove/addressing)                      │
│    ├── LIR_Op3  (allocation)                             │
│    ├── LIR_OpCall (static/virtual/opt_virtual/array)     │
│    ├── LIR_OpLabel/Goto/Jump/Condition                    │
│    └── LIR_MoveOp (spill/split resolving)                │
│                                                          │
│  LinearScan (c1_LinearScan.hpp:101):                     │
│    ├── build_intervals: 为每个虚拟寄存器建活跃区间        │
│    ├── allocate_registers: 线性扫描分配物理寄存器         │
│    ├── resolve_data_flow: 插入 spill/reload             │
│    └── 输出: 所有 LIR_Opr 已映射到物理寄存器/栈槽         │
└─────────────────────────────────────────────────────────┘
 │
 └──┐ LIRAssembler (c1_LIRAssembler.hpp)
    │    ├── 遍历 LIR_List
    │    ├── emit_op(): 每条 LIR_Op → 机器指令
    │    ├── C1_MacroAssembler: 平台特定汇编生成
    │    └── 输出: CodeBuffer (含机器码 + oop maps)
    ▼
install_code() → nmethod → CodeCache
```

## 基本元素分解

1. **Compilation** — 一次 C1 编译的顶级上下文。持有 `_hir`(IR*)、`_allocator`(LinearScan*)、`_frame_map`(FrameMap*)、`_code`(CodeBuffer)。三阶段入口：`build_hir()`→`emit_lir()`→`emit_code_body()`。`c1_Compilation.hpp:61`

2. **GraphBuilder** — 字节码→HIR 的翻译器。通过 `ScopeData` 栈管理内联深度，用 `BlockList` 维护 bci→block 映射。`iterate_bytecodes_for_block()` 逐字节码翻译——每个 bytecode 调一个 `visit_*()` 方法产出 HIR Instructions。内联通过 `try_inline()` 递归调用 GraphBuilder。`c1_GraphBuilder.hpp:38`

3. **Instruction 层级** — HIR 的节点系统。共 40+ 子类，覆盖所有 JVM 字节码语义。关键：每个 Instruction 携带 `ValueStack`（deoptimization 时的解释器状态快照）、`ExceptionState`（异常路径）、`BlockBegin`/`BlockEnd`（CFG 信息）。`c1_Instruction.hpp:287`

4. **LIRGenerator** — HIR→LIR 的翻译器。`visit()` 遍历 HIR block，每个 Instruction 调用对应的 LIR emitter 方法。关键职责：虚拟寄存器分配（临时 LIR_Opr）、调用约定映射（使用 FrameMap）、deoptimization 信息生成。`c1_LIRGenerator.hpp`

5. **LinearScan** — 线性扫描寄存器分配器。核心算法：为每个虚拟寄存器建立一个 live interval（从最早定义到最后使用），按 start 排序后线性扫描，为区间分配物理寄存器——区间重叠的不能分配同一寄存器。与图着色对比：O(n) vs O(n²)，注册使用率 ~70-80% vs ~90-95%，编译速度快 2-5x。`c1_LinearScan.hpp:101`

6. **LIRAssembler** — LIR→机器码的最终翻译。每条 LIR_Op 调用对应的 `emit_*()` 方法，使用 `C1_MacroAssembler` 生成实际机器指令。输出到 CodeBuffer 中，含 OopMap（GC 点位）和 ExceptionTable。`c1_LIRAssembler.hpp`

7. **Canonicalizer + Optimizer** — HIR 优化通道。Canonicalizer 做局部简化（常量折叠、代数恒等），Optimizer 做块级优化（死代码消除、合并连续相同操作）。`c1_Canonicalizer.hpp`、`c1_Optimizer.hpp`

8. **RangeCheckElimination** — 专用于消除冗余数组边界检查。`arr[i] + arr[j]` 两个边界检查，如果 i 和 j 的范围可以推断且都在 bounds 内，消除第二个。对热循环中的数组访问收益显著。`c1_RangeCheckElimination.hpp`

9. **FrameMap** — C1 的调用约定管理器。决定参数在哪、返回值在哪、哪些寄存器被调用者保存/调用者保存、栈帧布局。与 SharedRuntime 的 `java_calling_convention()` 配合生成 adapter。`c1_FrameMap.hpp`

10. **C1_MacroAssembler** — 平台相关的汇编辅助类（x86）。继承自 `MacroAssembler`，添加 C1 特定 helper（如 `load_parameter()`、`unlock_object()`、`verify_oop()`）。`c1_MacroAssembler.hpp`

## 标记问题（≥5）

1. **[设计决策] HIR+LIR 两级 IR vs 单级 IR** — 为什么 C1 需要两级中间表示？为什么不直接字节码→LIR 或字节码→HIR→机器码？HIR 承载了什么优化只能在"接近字节码"层面做？LIR 承载了什么映射只能"接近机器码"层面做？`c1_IR.hpp` vs `c1_LIR.hpp`

2. **[算法选择] 线性扫描 vs 图着色寄存器分配** — C1 选线性扫描的关键权衡是什么？图着色的寄存器使用率更高（>90%）但需要构建干涉图（O(n²)）。线性扫描是如何把 O(n²) 降到 O(n) 的？牺牲了什么？`c1_LinearScan.cpp` 中的 Interval 和 Range 类

3. **[内联策略] C1 的 ScopeData 栈内联机制** — 与 C2 的 inlining tree 相比，C1 的内联为什么用简单的 ScopeData 栈？`try_inline()` 中是怎么和 CompilationPolicy 交互决定是否内联的？C1 的内联深度限制是什么？`c1_GraphBuilder.cpp`

4. **[deoptimization] ValueStack 如何支撑 C1 的去优化** — 每条 HIR Instruction 携带 ValueStack（当前字节码位置的所有局部变量和操作数栈的状态）。为什么 C1 需要这么细粒度的 deoptimization 支持？这和 C2 的 uncommon trap 有什么关系？`c1_ValueStack.hpp`

5. **[范围检查消除] RangeCheckElimination 的保守性** — 它怎么推断数组索引的值范围？用的是什么算法（SSA-based value range analysis？）？在什么情况下会保守地保留检查？`c1_RangeCheckElimination.cpp`

6. **[设计决策] C1 的 profiling 支持** — C1 的 Level 2（limited profile）和 Level 3（full profile）在哪些阶段插入了 profiling 代码？这些 profiling 数据如何影响自己（Level 3→4 的过渡）？`c1_LIRGenerator` 中的 profile 相关代码

7. **[显式 Null Check]** — C1 在生成的代码中显式插 null check（与 C2 的隐式异常相反）。为什么？C1 的寄存器分配不够密集所以显式检查的收益不大？还是因为 C1 编译的代码跑的时间短，null check 开销占比小？

8. **[跨域] LIRGenerator 与 FrameMap 的交互** — FrameMap 为每个参数/返回值分配 VMReg 位置，LIRGenerator 在使用这些 VMReg 时如何映射到 LIR_Opr？参数传递中的 calling convention 和 LIR 寄存器分配之间如何协调？

9. **[跨域] C1 Runtime1 — 编译代码调回 C++ 的 stub** — `c1_Runtime1.cpp` 提供了哪些 C1 专门的 runtime 入口（如 `new_instance`、`new_type_array`、`monitorenter` 等）？这些和 SharedRuntime 的 RuntimeStub 有什么不同？
