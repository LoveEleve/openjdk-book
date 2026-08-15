# 06. Matcher + Code Generation — DFA 指令选择 → x86 机码

> 🟡 Working | Matcher + ADL + GCM + Output
> 读者处境: IGVN 优化后的 C2 Ideal Graph(平台无关的 Node)——Matcher 将 AddI→x86 `addl`、LoadI→`movl`、IfNode→`cmpl+jcc`。36815 行 .ad 文件(x86.ad+x86_32.ad+x86_64.ad)是 x86 ISA 的完整描述——ADL 编译器(adlc)编译为 C++ DFA matcher。

### 1. "ADL — Architecture Description Language (.ad 文件)"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/06 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"x86_64.ad:line ~1000 addI variants" 行号错(重要)**: addI 变体在 **x86_64.ad:7473-7519**(addI_rReg :7473/imm :7484/mem :7495 ins_cost(125)/mem_rReg :7507/mem_imm :7519);"x86.ad:5000-6000 shared" 无据
> - **".ad 约 37000 行" 数字对但"10 个文件"错**: x86 平台就 **3 个文件**(x86.ad 9834+x86_32.ad 13656+x86_64.ad 13325=**36815**);instruct 要素实测=match/effect/opcode/format/ins_encode/ins_pipe/+**ins_cost**
> - **"format %{} 用于 PrintOptoAssembly" 半对**: format 文本确实是 PrintOptoAssembly 的输出,但该 flag 实现 NOT_PRODUCT(01 篇已证 compile.cpp:718-733)——release 不可见
> - **adlc 机制 ✓**: 构建期 GensrcAdlc.gmk 编译 .ad→ad_x86_64.cpp/hpp(生成物不在源码树);adlc 源码在 **share/adlc/**(dfa.cpp 的 DFA_PRODUCTION 生成状态标注,class State 由 adlc 生成)
> - **成本模型 ✓**: match_tree 最小 cost(matcher.cpp:1386-1394)+ins_cost(125)——"reg_reg 优先"是 ins_cost 数字的体现非硬编码顺序


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
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/06 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"Matcher::match (matcher.cpp:176-250)"** ✓(:176);**xform (:979)** ✓;**match_tree (:1359)** ✓;**matcher.cpp 2695 行** ✓
> - **"match_tree 递归匹配子树" 半对**: 真实=State 标注(Label_Root 自底向上打 _rule/_cost 标签)→**根状态最小 cost 选规则**(:1386-1394)→ReduceInst(:1653)归约;匹配失败=soft_match_failure→record_method_not_compilable(编译期错误非崩溃)
> - **"DFA 状态转移表由 adlc 生成"** ✓(adlc/dfa.cpp);**"标签化 Node×opcode×input types→MachNode"** 简化(实为 State/_rule 机制)
> - **"mem_reg 在 L1 cache hit 时...ILP 折衷" 无据**: 删——ins_cost 是人工标的近似值(注释 "// XXX"),无 ILP 权衡逻辑
> - **补编排**: Code_Gen(compile.cpp:2476-2580): Matcher→PhaseCFG/GCM(:2514-2518)→Chaitin(:2523-2533)→块排序 PhaseBlockLayout(:2535-2544)→PhasePeephole(:2546-2550)→postalloc_expand(:2552-2555)→Output(:2557-2560);Matcher::match 流程(find_shared :310/新旧空间 :322/xform 递归 :343-345)


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
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/06 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"PhaseOutput::Output()" 类名错(重要)**: JDK11 无 PhaseOutput 类;发码=**Compile::Output()**(output.cpp:57);emit 循环 n->emit(*cb,_regalloc)(:1394)写 CodeBuffer,reloc 由 MachNode 在 emit 时写入
> - **"gcm.cpp:100-500" 行号错**: do_global_code_motion 在 **gcm.cpp:1612**;global_code_motion :1458;schedule_early :308;schedule_late :1280(晚调度=下沉靠近使用点缩短 live range);estimate_block_frequency :1625(uncommon trap 压低 :1629-1636)
> - **"peephole: NOP 消除/冗余 mov 消除" 编造(重要)**: **MachNode::peephole 默认返回 NULL**(machnode.cpp:415-417),x86 无重写——**C2 x86 peephole 也是空实现**(与 14-c1/03 的 C1 peephole 空实现呼应);PhasePeephole 框架存在(phaseX.cpp:2140-2159)但钩子空;OptoPeephole develop_pd(:150)/PrintOptoPeephole notproduct(:162)
> - **"Anti-Dependency 解决: 插 spill" 编造**: 调度只重排顺序,spill 是 RA 的事
> - **"调度基于频率优先" 半对**: estimate_block_frequency(IfNode 概率)+PhaseBlockLayout(compile.cpp:2540,block.cpp Trace 高频后继连排)与循环对齐;GCM 本身按依赖调度
> - **"finalize: 填充 jmp 地址 fix relocations" 半对**: reloc 由 MachNode emit 时写入 CodeBuffer(非独立 finalize 阶段)
> - **实证**: CITime Matcher/Scheduler/Regalloc/Block Ordering/Peephole/Build OOP maps/Code Installation 阶段(素材第 1 段,01 篇素材第 6 段同构)


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
