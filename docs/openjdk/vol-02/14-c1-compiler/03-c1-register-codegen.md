# 03. LinearScan + LIR → x86 码

> **前置依赖**:[14-c1-compiler/01 — C1 管线 + HIR: 字节码→编译图](01-c1-pipeline-ir.md):三大步管线里的 emit_lir 在这篇展开;[14-c1-compiler/02 — C1 优化: Canonicalizer + ValueMap + Optimizer](02-c1-optimizations.md):优化完的 HIR 是分配器的输入;[02-assembler/01 — CodeBuffer 与 AbstractAssembler: JIT 的"草稿纸"和"笔"](openjdk/vol-02/02-assembler/01-codebuffer-abstract-assembler.md):机器码落进 CodeBuffer
> → **后续**:[14-c1-compiler/04 — Runtime1 + FrameMap: C1 runtime 与栈帧](04-c1-runtime-frame.md)
> 关联域: 24-frame(帧布局)、16-code-cache(01 的 nmethod 注册)

## 虚拟寄存器怎么落到物理寄存器

HIR/LIR 里的操作数是**虚拟寄存器**(无数量限制);机器只有 16 个通用寄存器。C1 用 **线性扫描分配器**(LinearScan)做映射: 按指令位置单趟扫描,冲突的虚拟寄存器**溢出到栈**(spill)。这篇拆三层: **LinearScan 的分配流程**(Interval 是 Range 链表、activate/alloc 双路径、spill 策略)、**LIR 到机器码**(LIRGenerator 产 LIR_Op,LIR_Assembler 逐 op 发码)、以及**两个大纲修正**: "spill 选 end 最远"其实选 **use 位置最晚**;x86 的 peephole 是**空实现**——真正的 LIR 优化是 EdgeMoveOptimizer。

## 1. LinearScan: 区间链表 + 单趟扫描

`LinearScan::do_linear_scan`(c1_LinearScan.cpp:3100-3130)的流程: 指令编号 → 局部/全局活跃集(`compute_local_live_sets`/`compute_global_live_sets`)→ **build_intervals**(为每个虚拟寄存器建 Interval)→ 排序 → **allocate_registers**(:1656-1690,**LinearScanWalker 按 CPU/FPU 两类各扫一遍**,:1683/:1689)→ `resolve_data_flow`(块边插 move,异常处理器另解)→ `propagate_spill_slots`(定帧大小)。

**Interval 不是单一 [start, end]**: 它由 **Range 链表**组成(c1_LinearScan.hpp:455-470,Range 有 `_from/_to/_next`;Interval 类 :501+)——一个虚拟寄存器的活跃期可能不连续(跨分支),每个活跃段是一个 Range;Interval 还挂 `_assigned_reg`、`_register_hint`(:563)、`_current_split_child`/`_canonical_spill_slot`(分裂子区间体系)。

**扫描核心在 LinearScanWalker::activate_current**(:5792-5855): 激活一个区间时——已经分配了栈槽的(方法参数等,`must_start_in_memory`)**先 split 再在首次使用点 load 回寄存器**(:5802-5812);普通区间走 `combine_spilled_intervals`(不相交区间共享 spill 槽)→ **`alloc_free_reg`(有空寄存器直接给)或 `alloc_locked_reg`(没有则挤掉别人)**(:5834-5840)。**挤掉谁由 `find_locked_reg` 决定**(:5504-5524)——遍历被占寄存器,选 **`_use_pos[i]` 最晚**的那个(:5508-5510): 它的占用者在下一次使用前有最长空闲,期间可以 spill 到栈再 load 回来,代价最小——**不是大纲说的"end 最远"**。被挤的区间 `split_for_spilling`(:5227)拆开,栈槽段+寄存器段之间插 move。`resolve_data_flow` 处理块边: 同一虚拟寄存器在不同块落到不同寄存器/栈时,在边上插 move。

## 2. LIR → 机器码

01 篇说过 `emit_lir()` 里 `LIRGenerator` 按线性扫描序把 HIR 指令转成 **LIR_Op 序列**(`Add(x,y)` → `LIR_Op2(lir_add, x, y, result)`;x86 特化在 `c1_LIRGenerator_x86.cpp`)。分配完成后的 LIR 由 **LIR_Assembler** 发码: `emit_code`(c1_LIRAssembler.cpp:214)遍历块 → `emit_block` → `emit_lir_list`(:268)逐 op 调 `emit_op0/1/2`(:598/:504/:695,x86 实现在 c1_LIRAssembler_x86.cpp,`lir_add` 按操作数形态选 `addl reg,reg`/`addl mem,reg` 等)。

**LIR 层的真正优化在 LinearScan 尾部**(c1_LinearScan.cpp:3152-3155): `EdgeMoveOptimizer::optimize`(块边的冗余 move 消除,实现 :5861/:5949/:6014)+ `ControlFlowOptimizer`。**大纲的 "peephole: 相邻 move 消除" 是编造**——`LIR_Assembler::peephole` 在 x86 上是**空实现**(c1_LIRAssembler_x86.cpp:3994,`void LIR_Assembler::peephole(LIR_List*) {}`,注释 "In particular sparc uses this for delay slot filling")。

## 3. x87 与实证边界

`c1_LinearScan_x86.cpp` 有 FPU 栈分配器(`allocate_fpu_stack` :35)——**仅 x87 模式**(`use_fpu_stack_allocation`,JDK11 x86_64 默认 SSE 走普通寄存器分配),大纲的 "ST0-ST7 特化" 只在非 LP64 的 x87 路径生效。[实证](planning/outlines/00-jvm-tools/materials/commands/14-c1-register-codegen-demo.txt)与 02 篇一致: release 下 `TraceLinearScanLevel` 是 develop,LinearScan 的分配过程只能源码推演;PrintAssembly 无 hsdis 时给出 nmethod 布局(C1 sum 的 main code 352 字节,C2 224——C1 少优化的代价)。*关键设计: 线性扫描的"快"来自单趟扫描与启发式 spill,而 interval 分裂(register 段+spill 段交替)让溢出惩罚可控——这是 C1 在毫秒级编译预算里的核心权衡*。

## 核心悬念

分配与发码拆完: LinearScan 是"Interval(Range 链表)+ 单趟扫描 + activate/alloc_free/alloc_locked"的分配器,spill 目标选 use 位置最晚的寄存器;LIR_Assembler 逐 op 发码,x86 的 peephole 空挂、LIR 优化是 EdgeMoveOptimizer+ControlFlowOptimizer;x87 FPU 栈仅在 x87 模式。机器码出来了,但 C1 还有一半没讲: **慢路径**——new/checkcast/锁这些指令,解释器有对应的 runtime,编译器怎么办?C1 把复杂操作**委托给 C++ 的 Runtime1**(而不是内联生成所有机器码),还有编译后帧与解释器帧的互转。下一篇: Runtime1 与 C1 帧。

> → [14-c1-compiler/04 — Runtime1 + FrameMap: C1 runtime 与栈帧](04-c1-runtime-frame.md)
