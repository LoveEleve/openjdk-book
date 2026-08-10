# 03. LinearScan + LIR → x86 码

> 🔴 Deep | 11 KP 中的 2 个核心机制
> 读者处境: HIR 优化完了——如何把虚拟寄存器映射到物理寄存器？C2 用 graph coloring (O(n²))——C1 用 linear scan (O(n))——速度快 10x——精度损失可接受。

### 1. LinearScan — O(n) 寄存器分配

场景: C1 需要把 15 个虚拟 HIR 值 (Value*) 映射到 8 个物理 GPR。C1 用 linear scan: Interval 按 start 排序→scan→逐个 assign→冲突的 spill 到栈。

**LinearScan** (`c1_LinearScan.hpp.cpp`):
- `Interval`: 每个虚拟 value→一个 Interval——`[start, end]`——value 的活跃范围
- 「WALK」: 按 start position 排序→依次: 当前 Interval 需要寄存器→找空闲 (end < current start)→空闲→assign。无空闲→spill 一个 (end 最远的)→栈 slot
- [C++: LinearScan::add_register_hint(Interval*, reg)——上次这个虚拟 value 分配到哪个寄存器——如果 hint reg 空闲→assign same register——减少 move。如果 hint reg 被占用→assign 新 reg→需要 move]
- x86 FpuStack: x87 浮点栈 (ST0-ST7)——LinearScan 特化——`c1_LinearScan_x86.cpp`→`fpu_stack_alloc()`——处理 x87 的栈式 register file

**Spill 处理** (`c1_LinearScan.cpp:400-800`):
- Spill: 寄存器不够→value 存栈→后续使用时 load→stack slot——`_spill_slots` 分配
- Split: 大 Interval 拆成两段——中间不活跃的部分用栈 slot——两端的活跃部分用寄存器——减少 spill 惩罚
- [C++: Linear scan 的 spill 策略——spill 时选择 end 最远的 Interval——因为它在最长时间内被冲突——期望下一次 reuse 也 spill]

### 2. LIR → LIRAssembler → x86

**LIRGenerator** (`c1_LIRGenerator.hpp.cpp`):
- HIR Instruction→`LIR_Op`——每个 HIR node 映射到一组 LIR ops: `Add(x, y)`→`LIR_Op2(lir_add, x_opr, y_opr, result_opr)`
- x86 特化: `c1_LIRGenerator_x86.cpp`——`LIR_Op2::emit_code(compiler)`→x86 variants——复杂指令 (division) 需要多个 LIR ops

**LIRAssembler** (`c1_LIRAssembler.hpp.cpp`):
- `emit_code(BlockList*)`: 遍历每个 block→`emit_lir_list(block->lir_ops)`→每个 LIR_Op→`emit_opX()`
- [x86: `LIR_Assembler::emit_op2(LIR_Op2*)`——lir_add: `addl reg, reg` 或 `addl mem, reg` or vise versa——根据 operands 类型选择指令格式]
- Peephole: 相邻 move——`mov rax, rbx; mov rbx, rax`→消除 (no-op)。`mov rax, 0; add rax, rcx`→`lea rax, [rcx]`

---

### 核心悬念

**"Linear scan: O(n) 寄存器分配——15 虚拟→8 物理——冲突的 spill 到栈——end 最远的 spill 优先级最高。"** — C2 的 Chaitin graph coloring O(n²) 更精确——C1 用 linear scan 追求速度——毫秒级编译。下一篇: Runtime1——C1 把 new/checkcast/lock delegate 到 C++。

> → [04-c1-runtime-frame.md](04-c1-runtime-frame.md)
