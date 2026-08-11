# 06. Matcher + Code Generation — DFA 指令选择 → x86 机码

> 🟡 Working | Matcher + ADL + GCM + Output
> 读者处境: IGVN 优化后的 C2 Ideal Graph(平台无关的 Node)——Matcher 将 AddI→x86 `addl`、LoadI→`movl`、IfNode→`cmpl+jcc`。36815 行 .ad 文件(x86.ad+x86_32.ad+x86_64.ad)是 x86 ISA 的完整描述——ADL 编译器(adlc)编译为 C++ DFA matcher。

### 1. "ADL — Architecture Description Language (.ad 文件)"

场景: `x86_64.ad:instruct addI_reg_reg(rRegI dst, rRegI src1, rRegI src2)`——描述`AddI` Node 到 x86 `addl` 指令的 DFA pattern。adlc(Architecture Description Language Compiler)编译 .ad→生成 `ad_x86_64.cpp/hpp`——包含 DFA 转移表。

**ADL 格式** (`cpu/x86/x86_64.ad:line ~1000`):
```
instruct addI_reg_reg(rRegI dst, rRegI src1, rRegI src2) %{
  match(Set dst (AddI src1 src2));           // Match pattern: dst = src1 + src2
  effect(DEF dst, USE src1, USE src2);       // Register usage
  format %{ "addl    $dst, $src2" %}         // Assembly output format
  ins_encode %{                               // C++ code to emit instruction
    __ addl($dst$$Register, $src2$$Register);
  %}
  ins_pipe(ialu_reg_reg);                    // Pipeline class(scheduling hint)
%}
```
[x86: 每条 x86 指令在 .ad 中有多种变体——addI_reg_reg / addI_reg_mem / addI_mem_reg / addI_imm8——Matcher 选择最优 variant]
- 源码: `cpu/x86/x86_64.ad:1000-1200` (addI variants) + `cpu/x86/x86.ad:5000-6000` (shared x86 instructions)

- 关键设计: **ADL 是 C2 的平台适配层**——10 个 .ad 文件(约 37000 行) 包含 x86 ISA 的完整语义。新架构(ARM/RISC-V)只需重写 .ad 文件——不需要修改 C2 核心。**adlc** 编译 .ad→C++ DFA 转移表——`MachNode` 子类(每个 instruct→一个 MachNode 类)。`format %{}` 中的文本用于 `-XX:+PrintOptoAssembly` 输出。

### 2. "Matcher — Ideal→MachNode(DFA 匹配)"

场景: IGVN 后的 Ideal Graph 有 `AddI(LoadI(mem,idx), ConI(8))`→Matcher 识别为 `addI_reg_imm8` pattern→生成 `MachAddI_reg_imm8`(addl reg, 8)。

**Matcher::match + xform** (`matcher.cpp:176-250`):
```
Matcher::match():
  → 遍历 Ideal Graph all Nodes
  → match_tree(n) (matcher.cpp:1359)——递归匹配子树→build MachNode tree
  → xform(n) (matcher.cpp:979)——将 Ideal Node→MachNode + insert extra nodes(load/store)
  → DFA: 状态转移表 由 adlc 生成——每个 Ideal opcode→start state→transition→accept state(MachNode)
[C++: matcher.cpp:2695行——标签化 Node×opcode×input types→MachNode subclass]
[x86: 指令选择优先——reg_reg > reg_imm > reg_mem > mem_imm——最小化 memory ops]
```
- 源码: `matcher.cpp:176-220` (match 主循环) + `matcher.cpp:979-1050` (xform 转换) + `matcher.cpp:1359-1450` (match_tree 递归匹配)

- 关键设计: **成本模型(cost)**——DFA 中每个 transfer 有 cost——Matcher 选择总 cost 最低的匹配路径。**reg_reg 优先于 mem_reg**——register-to-register addl 比 memory-to-register addl 快 3x。**mem_reg 在 L1 cache hit 时可能比 reg_imm+load 组合更快**——Matcher 考虑 ILP(instruction-level parallelism)的折衷。

### 3. "GCM + Block Scheduling → Output"

场景: MachNode 图已经平台相关——GCM(Global Code Motion)按执行频率调度 MachNode 到 basic blocks——Output 阶段穿越 `PhaseOutput::Output()`→`CodeBuffer` 生成最终机码。

**GCM + Output** (`gcm.cpp + output.cpp`):
```
PhaseCFG::do_global_code_motion():
  → 计算每个 basic block 的执行频率(profile data)
  → schedule MachNodes——frequent blocks first(L1 cache hot)
  → Anti-Dependency 解决: insert spill code if scheduler changes reg usage

PhaseOutput::Output():
  → 遍历所有 basic blocks 中的 MachNodes
  → each MachNode.emit() → 写入 CodeBuffer(机码字节流)
  → peephole optimization: 相邻指令的 NOP 消除 / 冗余 mov 消除
  → finalize: 填充 jmp 目标地址 → fix relocations
```
- 源码: `gcm.cpp:100-500` (global code motion) + `output.cpp:50-300` (Output → emit machine bytes)

- 关键设计: **GCM 调度基于频率优先**——hot path 指令聚合在相邻 cache line→减少 I-cache miss。**Anti-Dependency**: 如果调度改变了 reg→reg 的顺序(如 mov rax,rbx 在 cmp rax,rdi 之后)可能导致使用旧值→GCM 检测并插入 spill。

---

### 核心悬念

**"ADL(.ad 文件, 36815行)→adlc 编译为 DFA 转移表→Matcher(Ideal→MachNode, cost model 选最优 variant)→GCM(频率调度→I-cache 友好)→Output(emit machine bytes→CodeBuffer)。36600 行 .ad = C2 的 x86 ISA 硬编码——平台适配只需换 .ad。"** — 下一篇: PhaseMacroExpand——高层优化展开为低层 MachNode。

> → [07-c2-macro-intrinsics.md](07-c2-macro-intrinsics.md)
