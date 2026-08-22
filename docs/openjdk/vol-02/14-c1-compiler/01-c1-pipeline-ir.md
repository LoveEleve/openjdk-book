# 01. C1 为什么快？— 管线、HIR 与“把栈机器翻成图”

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 C1 编译器从字节码到机器码的总体前端流水线：`build_hir`、`emit_lir`、`emit_code_body`，以及其中最关键的 `GraphBuilder`、`ValueStack`、HIR/LIR 角色分工。具体优化趟次细节放到下一篇展开。
>
> **前置依赖**：[13-jit-framework/02 — 为什么先 C1 再 C2？— `TieredThresholdPolicy` 5 层编译策略](../13-jit-framework/02-tiered-compilation-policy.md)、[12-ci/01 — JIT 怎么看到 Java 类？— `ciObject` 镜像体系](../12-ci/01-ci-overview-mirror.md)、[08-interpreter/01 — 一条字节码的“档案”在哪？— Bytecode 定义表](../08-interpreter/01-bytecodes-definition.md)
> → **后续**：[14-c1-compiler/02 — C1 优化：`Canonicalizer + ValueMap + Optimizer`](02-c1-optimizations.md)

上一章讲分层策略时，我们已经知道一件事：tiered compilation 之所以先把大量热点送进 C1，而不是一步到 C2，是因为 C1 更快，能更早给系统一份机器码结果。

但“C1 更快”这句话如果只停在这里，几乎没有解释任何东西。

本篇要回答的核心问题是:

1. C1 为什么不是“小号 C2”，却仍然能完成从字节码到机器码的整条管线？
2. Java 字节码明明是一台隐式操作数栈机器，C1 又怎么把它翻成显式数据流图？
3. 它怎样在编译快的同时，仍然处理 Phi、异常、去优化、栈图和寄存器分配？

答案先压成一句话:**C1 的快不是简单少做优化，而是从表示选择开始就为低延迟设计：`GraphBuilder` 用 `ValueStack` 把隐式栈翻成显式 HIR，建图时即时做便宜规范化和局部值编号；`emit_lir` 把图线性化并交给 LinearScan；`emit_code_body` 发码并补齐异常、去优化、unwind，然后必要时随时 bailout。**

---

## 1. 两个朴素方案为什么都不对

### 方案一：C1 只是“关掉很多优化的 C2”

既然 C2 是最终优化器，C1 看起来像“快编译器”，那它是不是本质上就是一版更克制、更少优化、更快返回结果的 C2？

不是。

两者最大的差别不是“开多少优化开关”，而是**整条管线的目标函数不同**。C2 从 IR 设计到全局分析再到寄存器分配，核心都偏向“愿意多花时间，换更好代码”；C1 则从最前面的表示转换开始，就围着“尽快把字节码变成一份可运行机器码”来设计。

这意味着 C1 的快不是最后一步突然快，而是从最早的表示选择开始就在省时间:

- 很快把栈机语义显式化，而不是一开始就进入更复杂的全局图世界;
- 建图时顺手做最便宜的规范化与局部值编号，而不是等所有东西都建完再统一处理;
- 选择 LinearScan 这种速度优先的寄存器分配器;
- 随时允许 bailout，而不是死守“既然开始编了就一定要编到底”。

所以把 C1 看成“小号 C2”，会错过一个最重要的设计事实:**它不是少做一点，而是从头到尾就不是同一种编译器。**

### 方案二：字节码到机器码不过就是顺序翻译

另一个误区是把字节码想得太“直译器化”：遇到 `iload` 就 load，遇到 `iadd` 就 add，遇到 `if_icmp` 就 cmp+jump，似乎顺着字节码走一遍就能发出机器码。

问题在于，Java 字节码是一台**隐式操作数栈机器**。`iload`/`istore`、`dup`、`swap`、`invokevirtual` 的意义大量依赖当前操作数栈。如果不先把这种栈语义显式化，后端不知道真实的 def-use 关系，也不知道分支汇合后某个槽位到底来自哪条路径。

所以 C1 再快，也绕不开图化。它只是把这一步做得特别贴近低延迟目标。

---

## 2. C1 的真实管线：三大步

`Compilation::compile_java_method()` 把主流程切成三段:

1. `build_hir()`
2. `emit_lir()`
3. `emit_code_body()`。`c1_Compilation.cpp:370-403`

这三步不是课本式分层，而是一条明确的降级链:

- 先把字节码翻成仍保留 Java 语义的 HIR 图;
- 再把 HIR 降成更接近机器的 LIR，并在这一步做寄存器分配;
- 最后由 `LIR_Assembler` 发机器码，补齐异常、去优化、unwind 等入口。

更能体现 C1 风格的是，bailout 点几乎撒满全程。方法带异常处理器、需要 profile 但 MDO 建不出来、`BailoutAfterHIR`、`BailoutAfterLIR` 等条件，都可能让 C1 中途收工。`c1_Compilation.cpp:373-390`、`:276-280`

C1 的哲学不是“无论如何都要完整编完”，而是:**只要收益还划算就继续，一旦代价太高或条件不合适就及时退回解释器。**

---

## 3. `build_hir`：不只是建图,而是前端整理

`build_hir()` 的第一步是创建 `IR`，再由 `IRScope::build_graph()` 拉起 `GraphBuilder` 真正构建图。`c1_Compilation.cpp:153-154`、`c1_IR.cpp:125-127`

图建完后，`build_hir()` 并没有立刻收工，而是继续做一串仍属于前端整理的动作:

- `optimize_blocks()`
- `split_critical_edges()`
- `compute_code()`
- 可选的全局值编号 GVN
- 非 OSR 场景下的 Range Check Elimination
- 空检查消除
- `compute_use_counts()`。`c1_Compilation.cpp:175-242`

源码注释有一句非常关键：`the control flow must not be changed from here on`。它说明 `build_hir()` 的职责不是“先把一张粗糙图交出去”，而是要在进入后端前把控制流骨架基本固定。

C1 前端因此不是“先无脑建完，再慢慢整理”，而是**边建边让图变得适合后端快速接手**。

---

## 4. GraphBuilder：把栈机器翻成显式 def-use 图

真正的转换发生在 `GraphBuilder`。它不是简单“遇到一条字节码生成一个节点”，而是在不断把栈机的隐式状态翻成控制流和数据流图。

### 控制流先变成图的块与边

`_goto()` 会创建 `Goto` 节点，把目标指向 `BlockBegin`；`if_node()` 会取出 true/false successor，创建 `If` 节点，把条件值、两个分支块和必要状态挂上去。分支在这里已经不再是字节码偏移，而是图里的块和边。`c1_GraphBuilder.cpp:1207-1227`

### append 时即时整理

绝大多数带 BCI 的新指令会经过 `append_with_bci()`。它先跑 `Canonicalizer`，再根据 `UseLocalValueNumbering` 去 `ValueMap` 查重，然后才决定是否把节点挂到 IR。`c1_GraphBuilder.cpp:2299-2313`

所以很多廉价优化不是后处理 pass，而是在节点 append 的瞬间发生。**Canonicalizer 首先是建图期的即时动作，不是一个必须等图完整后才启动的大阶段。**

如果节点没被消掉，`append_with_bci()` 还会继续做：

- 指令数超过 `InstructionCountCutoff` 就 bailout;
- 如果是 `StateSplit`，立即复制状态;
- 如果节点可能 trap，立即挂异常处理边。`c1_GraphBuilder.cpp:2321-2356`

这说明 `GraphBuilder` 同时在做四件事:显式化控制流、显式化数据流、顺手做便宜优化、挂上状态和异常边。

---

## 5. `ValueStack`：真正把“隐式栈”翻成“显式图”

在 HIR 世界里，局部变量和操作数栈里装的不是值本身，而是**产出这些值的指令节点引用**。

`Instruction.hpp` 直接把这件事钉死了:`typedef Instruction* Value`。也就是说，在 C1 前端里，一个值就是产生它的那条指令。`c1_Instruction.hpp:116-117`

于是:

- `iload` / `aload` 不必生成一条新 load 指令，更多时候只是把 local 槽里已有的 `Value` 推回栈顶;
- `Constant`、`ArithmeticOp`、`LoadField`、`Invoke` 才是产生新值的节点;
- 分支汇合时，一个槽位可能来自多条前驱路径，就必须用 `Phi` 表示。

`ValueStack::setup_phi_for_stack()` 和 `setup_phi_for_local()` 会在块入口的栈槽或 local 槽位上塞入新的 `Phi` 节点。`c1_ValueStack.cpp:176-190`

这就是“栈机器 → 图机器”最关键的一跳:

- 字节码世界：数据依赖靠 push/pop 时序隐式表达;
- HIR 世界：数据依赖改成节点之间的显式引用;
- 操作数栈：不再是最后要落到物理栈上的东西，而是前端维护的一份 Value 引用表。

一旦想通这一点，C1 为什么必须先建图、而不能直接顺序发码，就彻底说通了。

---

## 6. HIR：控制流、数据流、状态快照的混合图

`Instruction.hpp` 的节点族已经把 HIR 的形状暴露出来了: `Phi`、`Constant`、`LoadField`、`StoreField`、`ArrayLength`、`ArithmeticOp`、`NullCheck`、`Invoke`、`NewInstance`、`CheckCast`、`MonitorEnter`、`BlockBegin`、`Goto`、`If`、`Return`、`Throw` 等。`c1_Instruction.hpp:48-95`

这不是 AST。

- `BlockBegin` / `BlockEnd` 表示控制流;
- `StateSplit` 保存字节码状态;
- `Phi` 表示控制流汇合后的值;
- `can_trap()` 节点携带异常边;
- safepoint、调用点、去优化点都需要状态快照。

所以 HIR 是一张**控制流 + 数据流 + 运行时状态点**的混合图。后端要消费的不只是“算术依赖”，还包括异常、safepoint、去优化和调用状态恢复的信息。

---

## 7. `emit_lir` 与 LinearScan：后半程继续优先“快”

前端把图建出来之后，不会直接发机器码，而是先降成 LIR。`emit_lir()` 会构造 `LIRGenerator`，按 `hir()->iterate_linear_scan_order(&gen)` 生成 LIR；之后创建 `LinearScan` 分配器并执行 `do_linear_scan()`。`c1_Compilation.cpp:253-270`、`c1_IR.cpp:1223-1224`

这一步揭示了 C1 的后端取舍:它没有在 HIR 上直接完成最终发码，而是先把 HIR 线性化成更接近机器的低层表示，再用速度优先的寄存器分配器把虚拟操作数映射到物理寄存器与栈槽。

LinearScan 不是为了理论最优寄存器分配，而是为了在编译速度和代码质量之间做一个适合分层编译的折中。前端追求低延迟，后端也不会突然换成重型全局最优分配器。

---

## 8. `emit_code_body`：快但不省正确性设施

到了 `emit_code_body()`，`LIR_Assembler` 才真正出场。它准备 `CodeBuffer` 和 `oop_recorder`，构造 `C1_MacroAssembler` 与 `LIR_Assembler`，再由 `lir_asm.emit_code(hir()->code())` 把 LIR 发成机器码。`c1_Compilation.cpp:340-352`

但 C1 的“快”不是“发完主体指令就结束”。`emit_code_epilog()` 还要补齐:

- 慢路径 stubs;
- 异常入口;
- 去优化 handler;
- MethodHandle 专用 deopt handler;
- unwind handler。`c1_Compilation.cpp:285-316`

这些设施不能省，否则机器码无法和 JVM 的异常、去优化、栈解帧协议接上。最后 `install_code()` 通过 `_env->register_method(...)` 注册 frame 大小、oopmap、异常表、隐式异常表、编译器类型等信息，成为最终的 `nmethod`。`c1_Compilation.cpp:408-422`

C1 的快不是粗糙直译，而是**把必须正确的运行时协定补齐之后，避免不符合 tiered 快路径目标的重活**。

---

## 9. 误解澄清与收网

1. **C1 是“小号 C2”吗?** 不是。两者从表示、分析、寄存器分配到目标函数都不同。
2. **C1 可以顺序扫描字节码直接发机器码吗?** 不行。它必须先用 `ValueStack` 把隐式栈变成显式 Value/def-use 图。
3. **HIR 是 AST 吗?** 不是。HIR 是控制流、数据流和运行时状态点的混合图。
4. **Canonicalizer 只在最后的优化阶段运行吗?** 不只。`GraphBuilder::append_with_bci()` 建图时就会即时调用它。
5. **C1 快是不是因为不补异常/去优化/unwind?** 不是。这些设施仍会在 `emit_code_epilog()` 里补齐。

把这一篇压成三句话:

- **C1 的快从表示选择开始**：`GraphBuilder` + `ValueStack` 把栈机显式化，建图时顺手做廉价整理。
- **HIR → LIR → LinearScan → 机器码** 是低延迟降级流水线，必要时随时 bailout。
- **快不等于粗糙**：异常、oopmap、去优化、unwind 和 nmethod 安装仍然完整保留。

下一篇: C1 优化——`Canonicalizer + ValueMap + Optimizer` 这些正式优化趟次，哪些值得花时间，哪些直接跳过。

> → [14-c1-compiler/02 — C1 优化：`Canonicalizer + ValueMap + Optimizer`](02-c1-optimizations.md)