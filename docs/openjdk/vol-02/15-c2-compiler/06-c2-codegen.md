# 06. Matcher + Code Generation — DFA 指令选择 → x86 机码

> **前置依赖**:[15-c2-compiler/05 — Chaitin: 图着色寄存器分配 O(n²)](openjdk/vol-02/15-c2-compiler/05-c2-register-alloc.md):RA 消费的机器节点由本篇产生;[15-c2-compiler/01 — C2 Ideal Graph: Node + Type + IGVN](openjdk/vol-02/15-c2-compiler/01-c2-ideal-graph.md):理想图是匹配的输入;[14-c1-compiler/02 — C1 优化: Canonicalizer + ValueMap + Optimizer](openjdk/vol-02/14-c1-compiler/02-c1-optimizations.md):C1 的 LIR 生成与 C2 的 Matcher 对照
> → **后续**:[15-c2-compiler/07 — PhaseMacroExpand: 高层抽象→低层 MachNode 展开](openjdk/vol-02/15-c2-compiler/07-c2-macro-intrinsics.md)
> 关联域: 02-assembler(汇编器/CodeBuffer)、16-code-cache(nmethod)、04-logging(PrintOptoAssembly)

## 平台适配层与最后一公里

理想图是平台无关的: `AddI(a,b)` 在 x86 上该变 `addl`,在 ARM 上该变 `add`。C2 的平台适配层是 **.ad 文件**(Architecture Description)——x86 平台三份(x86.ad 9834 行 + x86_32.ad 13656 行 + x86_64.ad 13325 行,共 **36815 行**),每条 `instruct` 规则描述"某个理想节点子图 → 一条 x86 指令";构建期的 **adlc** 工具(GensrcAdlc.gmk,源码在 share/adlc/)把它编译成 C++ DFA 匹配代码(生成物 ad_x86_64.cpp/hpp **不在源码树**)。运行时 `Matcher` 用 DFA 把理想节点归约成 `MachNode`,`PhaseCFG` 调度,`PhaseChaitin` 分配寄存器(05 篇),最后 `Compile::Output` 发码进 CodeBuffer。顺带纠正大纲五处: `PhaseOutput` 类不存在(发码是 `Compile::Output`);addI 规则在 x86_64.ad:7473 而非 :1000;`MachNode::peephole` 默认返回 NULL——**C2 的 x86 peephole 也是空实现**;"Anti-Dependency 插 spill" 无据;".ad 约 37000 行" 的数字对但"10 个文件"错(就 3 个)。

## 1. ADL — 用 .ad 描述整个 ISA

一条 `instruct` 规则是"匹配模板 + 编码"的打包。以 x86_64 的整数加法为例(x86_64.ad:7473-7519,五个变体):

```cpp
// x86_64.ad:7473-7500(截取核心,逐字)
instruct addI_rReg(rRegI dst, rRegI src, rFlagsReg cr)
%{
  match(Set dst (AddI dst src));
  effect(KILL cr);

  format %{ "addl    $dst, $src\t# int" %}
  opcode(0x03);
  ins_encode(REX_reg_reg(dst, src), OpcP, reg_reg(dst, src));
  ins_pipe(ialu_reg_reg);
%}

instruct addI_rReg_imm(rRegI dst, immI src, rFlagsReg cr)
%{
  match(Set dst (AddI dst src));
  effect(KILL cr);

  format %{ "addl    $dst, $src\t# int" %}
  opcode(0x81, 0x00); /* /0 id */
  ins_encode(OpcSErm(dst, src), Con8or32(src));
  ins_pipe( ialu_reg );
%}

instruct addI_rReg_mem(rRegI dst, memory src, rFlagsReg cr)
%{
  match(Set dst (AddI dst (LoadI src)));
  effect(KILL cr);

  ins_cost(125); // XXX
```

- `match(...)`: 匹配的理想子图(`AddI dst src`、`AddI dst (LoadI src)`——寄存器-内存变体把 Load 并进加法,少一条指令);
- `effect(KILL cr)`: 副作用(此指令写 flags 寄存器);
- `opcode(0x03)` / `opcode(0x81, 0x00)`: 指令操作码;
- `ins_encode(...)`: 发码 C++ 序列(宏汇编调用);
- `ins_pipe(...)`: 流水线/调度类;
- **`ins_cost(125)`**: 匹配成本——Matcher 在多个可匹配规则里选**总成本最小**的路径。

adlc(Architecture Description Language Compiler)在**构建期**把这些规则编译成 C++: 每个 `instruct` 生成一个 `MachNode` 子类,DFA 转移逻辑生成到 ad_x86_64.cpp/hpp(构建物,不在源码树;adlc 自身的源码在 share/adlc/dfa.cpp,`DFA_PRODUCTION` 宏是它生成的状态标注代码)。新架构适配 = 重写 .ad 文件 + 少量 C2 接口,核心优化器不动——这就是 C2 平台适配层的设计。

*关键设计: .ad 是"指令语义 + 成本 + 编码"的三合一描述。成本显式写在规则里(ins_cost),而不是编译器硬编码"reg_reg 优先"——大纲的"优先顺序"是 ins_cost 数字的体现;`ins_cost(125)` 这类注释 "// XXX" 表明成本是人工标的近似值,不是实测。*

## 2. Matcher — 理想图 → MachNode

`Code_Gen`(compile.cpp:2476-2580)的编排: `Matcher matcher; matcher.match()`(:2489-2497)→ `PhaseCFG cfg; cfg.do_global_code_motion()`(:2514-2518)→ `PhaseChaitin regalloc; Register_Allocate()`(:2523-2533)→ 块排序(`PhaseBlockLayout` 频率布局或循环对齐,:2535-2544)→ `PhasePeephole`(:2546-2550)→ `postalloc_expand`(:2552-2555)→ **`Output()`**(:2557-2560,"Convert Nodes to instruction bits in a buffer")。

`Matcher::match`(matcher.cpp:176)的流程: `find_shared` 标记共享节点(:310,只有非共享节点才能作为匹配树的内部节点)→ 新旧节点空间切换(:322)→ `xform(C->top())` 递归转机器节点(:343-345)。核心是 `match_tree`(matcher.cpp:1359)的**最小成本匹配**:

```cpp
// matcher.cpp:1386-1405(截取核心,逐字)
  // The minimum cost match for the whole tree is found at the root State
  uint mincost = max_juint;
  uint cost = max_juint;
  uint i;
  for( i = 0; i < NUM_OPERANDS; i++ ) {
    if( s->valid(i) &&                // valid entry and
        s->_cost[i] < cost &&         // low cost and
        s->_rule[i] >= NUM_OPERANDS ) // not an operand
      cost = s->_cost[mincost=i];
  }
  if (mincost == max_juint) {
#ifndef PRODUCT
    tty->print("No matching rule for:");
    s->dump();
#endif
    Matcher::soft_match_failure();
    return NULL;
  }
  // Reduce input tree based upon the state labels to machine Nodes
  MachNode *m = ReduceInst( s, s->_rule[mincost], mem );
```

`State` 对象携带 DFA 标注结果(`_rule`/`_cost`,由 adlc 生成的转移代码填充),match_tree 在根状态里挑**成本最低的合法规则**,`ReduceInst`(:1653)按规则归约出 MachNode。匹配失败(`No matching rule`)→ `soft_match_failure` → 方法不可编译——不是所有理想图都能匹配,失败是编译期错误不是崩溃。

*关键设计: 匹配是"标注 + 归约"两段式——先沿树自底向上打状态标签(成本累计),再在根选最低成本规则自上而下归约。`AddI(dst, LoadI(src))` 能被 `addI_rReg_mem` 的 match 吞掉,说明 Load 可以"折叠"进使用它的指令——这是指令选择里最值钱的优化(少一条指令、少一次寄存器压力)。*

## 3. GCM 调度与发码

`PhaseCFG::do_global_code_motion`(gcm.cpp:1612)三步: `build_dominator_tree` → **`estimate_block_frequency`**(:1625,按 IfNode 概率估计块频率,uncommon trap 分支压到极低,:1629-1636)→ `global_code_motion`(:1458,含 schedule_early :308 / schedule_late :1280——晚调度从后往前把节点尽量下沉到**靠近使用点**,缩短存活区间,为 RA 减负)。大纲说"GCM 检测 Anti-Dependency 并插 spill"是编造的——**调度只重排顺序,spill 是 RA(05 篇)的事**;块频率的消费方是 `PhaseBlockLayout`(compile.cpp:2540,block.cpp 的 Trace 构建——把高频后继块排在一起减少跳转)与循环对齐。

发码在 **`Compile::Output`**(output.cpp:57,大纲的"PhaseOutput"类在 JDK11 不存在): 入口 MachPrologNode 序言(:71-77),然后逐块逐指令 `n->emit(*cb, _regalloc)`(:1394)——每个 MachNode 的 `emit` 调宏汇编器把机器码写进 **CodeBuffer**,重定位信息(调用目标、常量池地址)由 MachNode 的 reloc 逻辑在 emit 时写入。大纲的"peephole: NOP 消除/冗余 mov 消除"是编造的——**C2 的 `MachNode::peephole` 默认返回 NULL**(machnode.cpp:415-417),x86 没有重写,`PhasePeephole` 框架(phaseX.cpp:2140-2159)存在但钩子全空;这与 14-c1/03 域发现的 C1 peephole 空实现(注释 "sparc uses this for delay slot filling")如出一辙——**两代编译器的 x86 peephole 都是空壳**,"消除冗余 mov"在 JDK11 x86 上不发生。

**实证**([素材](openjdk/planning/outlines/00-jvm-tools/materials/commands/15-c2-codegen-demo.txt)第 1 段): CITime 显示 Code_Gen 的完整阶段——`Matcher`/`Scheduler`/`Regalloc`/`Block Ordering`/`Peephole`/`Build OOP maps`/`Code Installation`(01 篇素材第 6 段同构)。`OptoPeephole` 是 develop_pd(c2_globals.hpp:150,x86_64 默认 true 但钩子空)、`PrintOptoPeephole` 是 notproduct(:162);`format %{}` 的文本用于 PrintOptoAssembly,而该 flag 的实现在 01 篇已证是 NOT_PRODUCT(release 不可见)——发码细节在 release 下既看不到也调不了,能观察的只有阶段计时与最终运行结果。

*关键设计: 指令选择(Matcher/ins_cost)+ 调度(GCM/频率)+ 分配(Chaitin)+ 发码(Output/CodeBuffer)是四段流水,每段消费前段的产物、喂给后段。.ad 文件是唯一的平台入口——规则的 match 决定指令形态,ins_cost 决定取舍,ins_encode 决定字节;改平台 = 改 .ad,这就是 36815 行描述文件的全部意义。*

## 核心悬念

平台相关化收官: **.ad**(36815 行三文件描述 x86 ISA,instruct 规则 = match+effect+opcode+ins_cost+ins_encode)→ **Matcher**(find_shared 标记共享 → State 标注 → 最小 cost 选规则 → ReduceInst 归约 MachNode,Load 折叠进使用指令)→ **GCM**(频率估计 + 早/晚调度 → PhaseBlockLayout 块布局)→ **Output**(Compile::Output 逐指令 emit 进 CodeBuffer,reloc 同步写入;peephole 空实现)。到此,理想图彻底变成了 x86 机器码。但还有一类节点没被处理——**宏节点**(Allocate/Lock/ArrayCopy): 它们在优化期被 IGVN/EA 挂起,还没展开成机器指令。下一篇: PhaseMacroExpand。

> → [15-c2-compiler/07 — PhaseMacroExpand: 高层抽象→低层 MachNode 展开](openjdk/vol-02/15-c2-compiler/07-c2-macro-intrinsics.md)
