# 03. LinearScan + LIR → x86 码

> 🔴 Deep | 11 KP 中的 2 个核心机制
> 读者处境: HIR 优化完了——如何把虚拟寄存器映射到物理寄存器？C2 用 graph coloring (O(n²))——C1 用 linear scan (O(n))——速度快 10x——精度损失可接受。

> ⚠️ 写作期修正(2026-08-15, vol-02/14-c1-compiler/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"Interval: [start, end]" 半对(重要)**: 真实=Interval 由 **Range 链表**组成(c1_LinearScan.hpp:455-470 Range 的 _from/_to/_next;Interval 类 :501+)——活跃段可不连续;Interval 挂 _assigned_reg/_register_hint(:563)/_current_split_child/_canonical_spill_slot(分裂子区间体系)
> - **"spill 时选择 end 最远的 Interval" 半对**: 真实=**find_locked_reg 选 `_use_pos[i]` 最晚的寄存器**(c1_LinearScan.cpp:5504-5524,:5508-5510)——占用者下次使用前空闲最长,spill+reload 代价最小;非"end 最远"
> - **"peephole: 相邻 move 消除" 编造(重要)**: x86 的 **`LIR_Assembler::peephole` 是空实现**(c1_LIRAssembler_x86.cpp:3994,注释 "sparc uses this for delay slot filling");真正 LIR 优化=**EdgeMoveOptimizer+ControlFlowOptimizer**(c1_LinearScan.cpp:3152-3155,allocate 之后)
> - **"x86 FpuStack ST0-ST7 特化" 半对**: c1_LinearScan_x86.cpp:35 allocate_fpu_stack 存在,但仅 **x87 模式**(use_fpu_stack_allocation);JDK11 x86_64 默认 SSE 走普通分配
> - **"LinearScan O(n)" 半对**: do_linear_scan(:3100-3130)=number_instructions→local/global live sets→build_intervals→sort→allocate_registers(LinearScanWalker CPU/FPU 两遍 :1656-1690)→resolve_data_flow(+exception)→propagate_spill_slots;单趟扫描但实现细节多(active/inactive 列表)
> - **register_hint ✓**(hpp:281 add_register_hints/:563-564)
> - **行号漂移**: c1_LinearScan.cpp **6800 行**(大纲 400-800 严重低估);hpp 963;LIRAssembler.cpp 867
> - **缺机制(重要)**: ①activate_current(:5792-5855): 栈槽起始 interval(must_start_in_memory)激活时 **split+load 回寄存器**(:5802-5812);普通=combine_spilled_intervals(不相交共享 spill 槽)→**alloc_free_reg 或 alloc_locked_reg**(:5834-5840);insert_move_when_activated(:5844-5852);②split_for_spilling(:5227);③LIR_Assembler::emit_code(:214)→emit_block→emit_lir_list(:268,peephole 钩子 :269)→emit_op0/1/2(:598/:504/:695);④x86 emit_op2 按操作数形态选指令格式(c1_LIRAssembler_x86.cpp)
> - **实证**: 14-c1-register-codegen-demo.txt(TraceLinearScanLevel 是 develop 不可用;PrintAssembly 无 hsdis 给 nmethod 布局 C1 main code 352>C2 224;机制源码定位)
> - **悬念指向 04 ✓**(04-c1-runtime-frame.md "Runtime1 + FrameMap — C1 runtime 与栈帧")

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
