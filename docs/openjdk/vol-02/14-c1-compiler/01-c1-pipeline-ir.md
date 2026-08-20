# 01. C1 为什么快？— 管线、HIR 与“把栈机器翻成图”

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 C1 编译器从字节码到机器码的总体前端流水线：`build_hir`、`emit_lir`、`emit_code_body`，以及其中最关键的 `GraphBuilder`、`ValueStack`、HIR/LIR 角色分工。具体优化趟次细节放到下一篇展开。
>
> **前置依赖**：[13-jit-framework/02 — 为什么先 C1 再 C2？— `TieredThresholdPolicy` 5 层编译策略](../13-jit-framework/02-tiered-compilation-policy.md)、[12-ci/01 — JIT 怎么看到 Java 类？— `ciObject` 镜像体系](../12-ci/01-ci-overview-mirror.md)、[08-interpreter/01 — 一条字节码的“档案”在哪？— Bytecode 定义表](../08-interpreter/01-bytecodes-definition.md)
> → **后续**：[14-c1-compiler/02 — C1 优化：`Canonicalizer + ValueMap + Optimizer`](02-c1-optimizations.md)

上一篇讲分层策略时，我们已经知道一件事：tiered compilation 之所以先把大量热点送进 C1，而不是一步到 C2，是因为 C1 更快，能更早给系统一份机器码结果。

但“C1 更快”这句话如果只停在这里，其实几乎没解释任何东西。

真正的问题是：**C1 为什么能快？它到底做了什么样的取舍，才让一个基于栈式字节码的编译器前端，能很快把 Java 方法变成可发机器码的中间表示？**

这里至少有两层困惑：

- C1 为什么不是“小号 C2”，却仍然能完成从字节码到机器码的整条管线？
- Java 字节码明明是一台隐式操作数栈机器，C1 又是怎么把它翻成一张显式数据流图的？

这两层合起来，才是这篇真正要打穿的问题。

先把答案压成一句人话：**C1 快，不是因为它“少做一点优化”这么简单，而是因为它从一开始就把自己设计成一条低延迟降级流水线：先把栈机语义显式化成 HIR 图，在建图时顺手做最便宜的规范化和局部去重；再把图线性化成 LIR，并用速度优先的 LinearScan 分配寄存器；最后直接发码、补齐异常和去优化入口，必要时随时 bailout。**

只要这句抓住了，后面 `GraphBuilder`、`ValueStack`、`Phi`、`LinearScan` 看起来就不再是零散部件，而是同一条“为了快而专门裁剪”的流水线上的不同环节。

## 先试两个最自然的理解，看看为什么都不对

### 误解一：C1 只是“关掉很多优化的 C2”

这是最常见的第一反应。既然 C2 是最终优化器，C1 看起来像“快编译器”，那它是不是本质上就是一版更克制、更少优化、更快返回结果的 C2？

不是。

它们最大的差别不是“开多少优化开关”，而是**整条管线的目标函数不同**。C2 从 IR 设计到全局分析再到寄存器分配，核心都偏向“愿意多花时间，换更好代码”；C1 则从最前面的表示转换开始，就围着“尽快把字节码变成一份可运行机器码”来设计。

这意味着 C1 的快并不是最后一步突然快，而是从最早的表示选择开始就在省时间：

- 它先很快把栈机语义显式化，而不是一开始就进入更复杂的全局图世界；
- 它在建图时就顺手做最便宜的规范化与局部值编号，而不是等所有东西都建完再统一折腾；
- 它选择 LinearScan 这种速度优先的寄存器分配器，而不是更重的全局最优策略；
- 它随时允许 bailout，而不是死守“既然开始编了就一定要编到底”。

所以把 C1 看成“小号 C2”，会错过一个最重要的设计事实：**它不是少做一点，而是从头到尾就不是同一种编译器。**

### 误解二：字节码到机器码不过就是顺序翻译

另一个常见误区是把字节码想得太“直译器化”：遇到 `iload` 就 load，遇到 `iadd` 就 add，遇到 `if_icmp` 就 cmp+jump，似乎只要顺着字节码走一遍就能很快发出机器码。

问题在于，Java 字节码是一台**隐式操作数栈机器**。`iload`/`istore`、`dup`、`swap`、`invokevirtual` 这些指令的意义大量依赖“当前操作数栈长什么样”。如果你不先把这种栈语义显式化，后端很难知道“两个值之间的真实 def-use 关系是什么”“一个分支汇合后这个槽位现在是谁”“这个值在哪些地方被用到”。

也就是说，编译器真正的第一步不是“直接翻机器码”，而是先把“隐式栈上的数据搬运”翻成“显式节点之间的引用关系”。只有这样，后面才谈得上值复用、控制流汇合、寄存器分配和去优化状态记录。

所以 C1 再快，也绕不开图化；它只是把这一步做得特别贴近低延迟目标。

## C1 的真实管线：不是六步模板，而是三大步

如果只看顶层入口，C1 的骨架其实很干净。`Compiler::compile_method` 最后真正干活的是 `Compilation`，而 `Compilation::compile_java_method()` 把主流程清清楚楚切成三段：

1. `build_hir()`
2. `emit_lir()`
3. `emit_code_body()` `share/c1/c1_Compilation.cpp:370`、`share/c1/c1_Compilation.cpp:385`、`share/c1/c1_Compilation.cpp:395`、`share/c1/c1_Compilation.cpp:403`

这三步的意义不是“课本式分层”，而是非常明确的降级链：

- 先把字节码翻成高层、图化、仍保留 Java 语义味道的 HIR；
- 再把 HIR 降成更接近机器的 LIR，并在这一步做寄存器分配；
- 最后由 LIR_Assembler 发机器码，并补齐异常、去优化、unwind 等入口。

更能体现 C1 风格的是，bailout 点几乎撒满全程。`compile_java_method()` 一开始就会因为方法带异常处理器而可能直接退出；如果方法需要 profile，但 MDO 建不出来，也会 bailout；`BailoutAfterHIR`、`BailoutAfterLIR` 这种开关甚至专门允许在中途收工。`share/c1/c1_Compilation.cpp:373`、`share/c1/c1_Compilation.cpp:375`、`share/c1/c1_Compilation.cpp:381`、`share/c1/c1_Compilation.cpp:382`、`share/c1/c1_Compilation.cpp:389`、`share/c1/c1_Compilation.cpp:390`、`share/c1/c1_Compilation.cpp:276`、`share/c1/c1_Compilation.cpp:280`

这说明 C1 的哲学不是“无论如何都要完整编完”，而是**只要收益还划算就继续，一旦代价太高或条件不合适就及时退回解释器。**

## `build_hir` 不只是“建图”，它已经承担了 C1 前端的大部分实质工作

很多人第一次看名字，会把 `build_hir()` 理解成“只是把 HIR 图搭出来，真正的东西在后面”。源码恰恰说明相反：C1 前端的大部分实质工作，其实都挤在这一段里。

`build_hir()` 的第一步是 `_hir = new IR(this, method(), osr_bci())`。也就是说，HIR 图本身不是后面某个 pass 才慢慢冒出来的，而是一开场就创建 `IR`，由它再通过 `IRScope::build_graph()` 拉起 `GraphBuilder` 去真正构建图。`share/c1/c1_Compilation.cpp:153`、`share/c1/c1_Compilation.cpp:154`、`share/c1/c1_IR.cpp:125`、`share/c1/c1_IR.cpp:126`、`share/c1/c1_IR.cpp:127`

图建完后，`build_hir()` 并没有立刻收工，而是继续做了一串仍然属于“前端整理”的动作：

- `optimize_blocks()`
- `split_critical_edges()`
- `compute_code()`
- 可选的全局值编号 GVN
- 非 OSR 场景下的 Range Check Elimination
- 空检查消除
- `compute_use_counts()` `share/c1/c1_Compilation.cpp:175`、`share/c1/c1_Compilation.cpp:180`、`share/c1/c1_Compilation.cpp:185`、`share/c1/c1_Compilation.cpp:196`、`share/c1/c1_Compilation.cpp:198`、`share/c1/c1_Compilation.cpp:215`、`share/c1/c1_Compilation.cpp:234`、`share/c1/c1_Compilation.cpp:242`

这里最值得记住的是源码注释那句：`the control flow must not be changed from here on`。它正好点破了 `build_hir()` 在干什么：到 `compute_code()` 这一刻，C1 希望前端图与控制流骨架已经基本成形，后面就该进入更接近后端消费的阶段了。`share/c1/c1_Compilation.cpp:194`、`share/c1/c1_Compilation.cpp:195`

这也说明 C1 的前端不是“先无脑建完，再慢慢想办法整理”，而是在 HIR 阶段就尽量把图修到一个适合后端快速接手的状态。

## GraphBuilder 的本质：它在把“栈机器”翻成“显式 def-use 图”

真正的魔法发生在 `GraphBuilder`。它的工作不是“顺着字节码生成节点”这么简单，而是在不断把栈机的隐式状态，翻成一张显式的控制流 + 数据流混合图。

先看控制流。像 `_goto()` 这样的函数会直接创建 `Goto` 节点，目标是某个 `BlockBegin`；`if_node()` 则取出 true/false successor 块，创建 `If` 节点，把当前条件值、两个分支块和必要的状态一起挂上去。也就是说，分支跳转在这里已经不再是“字节码偏移”，而是图里的块与边。`share/c1/c1_GraphBuilder.cpp:1207`、`share/c1/c1_GraphBuilder.cpp:1208`、`share/c1/c1_GraphBuilder.cpp:1217`、`share/c1/c1_GraphBuilder.cpp:1221`、`share/c1/c1_GraphBuilder.cpp:1222`、`share/c1/c1_GraphBuilder.cpp:1227`

再看“建图时即时整理”这件事。所有新指令真正入链，都会经过 `append_with_bci()`。而它一上来做的第一件事不是 `_last->set_next(instr)`，而是先跑 `Canonicalizer`，再根据 `UseLocalValueNumbering` 去 `ValueMap` 里查重。也就是说，C1 的很多规范化和局部去重根本不是“后处理 pass”，而是在节点 append 的那一刻就发生了。`share/c1/c1_GraphBuilder.cpp:2299`、`share/c1/c1_GraphBuilder.cpp:2300`、`share/c1/c1_GraphBuilder.cpp:2301`、`share/c1/c1_GraphBuilder.cpp:2308`、`share/c1/c1_GraphBuilder.cpp:2311`、`share/c1/c1_GraphBuilder.cpp:2313`

这正好击穿一个很常见的误解：**Canonicalizer 不是一个独立大阶段，它首先是建图期的即时规范化动作。**

如果新节点没被消掉，`append_with_bci()` 才会真的把它链到 IR 上。紧接着还会做三件特别能体现 C1 风格的事：

- 指令数超过 `InstructionCountCutoff` 就设置 bailout；
- 如果这是 `StateSplit`，立刻把状态拷进去；
- 如果它可能 trap，立刻挂上异常处理边。 `share/c1/c1_GraphBuilder.cpp:2321`、`share/c1/c1_GraphBuilder.cpp:2325`、`share/c1/c1_GraphBuilder.cpp:2329`、`share/c1/c1_GraphBuilder.cpp:2342`、`share/c1/c1_GraphBuilder.cpp:2343`、`share/c1/c1_GraphBuilder.cpp:2355`、`share/c1/c1_GraphBuilder.cpp:2356`

所以 `GraphBuilder` 从来不只是“建个 AST”。它是在边走字节码边显式化控制流、显式化数据流、顺手做便宜优化、顺手挂状态与异常边。

## 真正把“隐式栈”翻成“显式图”的，不是某条 bytecode handler，而是 `ValueStack`

要真正看懂 C1，必须跨过一个心智坎：在 HIR 世界里，局部变量和操作数栈里装的不是“值本身”，而是**产出这些值的指令节点引用**。

`Instruction.hpp` 直接把这件事钉死了：`typedef Instruction* Value;`。也就是说，在 C1 前端里，一个值就是“产生它的那条指令”。`share/c1/c1_Instruction.hpp:116`、`share/c1/c1_Instruction.hpp:117`

这样一来，很多字节码的意义就会突然发生变化。比如 `iload`/`aload` 不再等于“生成一条 load 指令”；它更多是在把某个 local 槽里已经保存的 `Value` 再推回当前栈顶。相反，真正产出新值的往往是 `Constant`、`ArithmeticOp`、`LoadField`、`Invoke` 这些节点。

也正因为 locals 和 stack 存的是 `Value`，控制流汇合点上才必须用 `Phi` 来代表“这个槽位现在可能来自多条前驱路径”。`ValueStack::setup_phi_for_stack()` 和 `setup_phi_for_local()` 做的就是这件事：在块入口的栈槽或 local 槽位上塞一个新的 `Phi` 节点。`share/c1/c1_ValueStack.cpp:176`、`share/c1/c1_ValueStack.cpp:179`、`share/c1/c1_ValueStack.cpp:180`、`share/c1/c1_ValueStack.cpp:186`、`share/c1/c1_ValueStack.cpp:189`、`share/c1/c1_ValueStack.cpp:190`

这就是“栈机器 → 图机器”最关键的一跳。

在字节码世界里，数据依赖靠 push/pop 的时序隐式表达；在 HIR 世界里，数据依赖改成了节点之间的显式引用。操作数栈不再是最后要落到物理栈上的东西，而只是前端在建图期维护的一份“当前 Value 引用表”。

一旦想通这一点，C1 为什么必须先建图、而不能直接顺序发码，就彻底说通了。

## HIR 图上到底长什么：它不是 AST，而是控制流 + 数据流混合体

`Instruction.hpp` 里那大片前置声明，其实已经把 HIR 世界的基本形状暴露得很清楚了。你能看到 `Phi`、`Constant`、`LoadField`、`StoreField`、`ArrayLength`、`ArithmeticOp`、`NullCheck`、`Invoke`、`NewInstance`、`CheckCast`、`MonitorEnter`、`BlockBegin`、`Goto`、`If`、`Return`、`Throw`。`share/c1/c1_Instruction.hpp:48`、`share/c1/c1_Instruction.hpp:52`、`share/c1/c1_Instruction.hpp:60`、`share/c1/c1_Instruction.hpp:68`、`share/c1/c1_Instruction.hpp:72`、`share/c1/c1_Instruction.hpp:73`、`share/c1/c1_Instruction.hpp:86`、`share/c1/c1_Instruction.hpp:88`、`share/c1/c1_Instruction.hpp:94`、`share/c1/c1_Instruction.hpp:95`

这份层次特别值得注意的一点是：`BlockBegin` 和 `BlockEnd` 都是图节点的一部分，`StateSplit` 也是节点的一部分。也就是说，HIR 不是“只有表达式树”的局部数据流图，而是一张把控制流块、可抛异常状态、调用点状态都揉在一起的混合图。

这也解释了为什么 `append_with_bci()` 会对 `StateSplit` 额外保存状态拷贝、对 `can_trap()` 的节点额外挂异常边。C1 前端要交给后端的，不只是算术依赖关系，而是一张能够支撑 safepoint、异常、去优化、调用状态恢复的运行时图。

所以把 HIR 想成 AST，是不够的；把它想成“控制流图 + 数据流图 + 状态快照点”的混合体，才更接近真实语义。

## `emit_lir` 和 `LinearScan`：C1 后半程为什么继续优先“快”

前端把图建出来之后，并不会直接发机器码，而是先降成 LIR。`emit_lir()` 做的事情很清楚：先构造 `LIRGenerator`，然后按 `hir()->iterate_linear_scan_order(&gen)` 这个顺序生成 LIR；接着再创建 `LinearScan` 分配器，执行 `do_linear_scan()`。`share/c1/c1_Compilation.cpp:253`、`share/c1/c1_Compilation.cpp:256`、`share/c1/c1_Compilation.cpp:259`、`share/c1/c1_Compilation.cpp:267`、`share/c1/c1_Compilation.cpp:270`、`share/c1/c1_IR.cpp:1223`、`share/c1/c1_IR.cpp:1224`

这一步本身就揭示了 C1 的后端取舍：它并没有在 HIR 上直接做“最后发码”，而是先把 HIR 线性化成更接近机器的低层表示，再用速度优先的寄存器分配器把虚拟操作数映射到物理寄存器与栈槽。

为什么偏偏是 LinearScan？因为它不是为了给出理论最优寄存器分配结果，而是为了在编译速度和代码质量之间做一个对分层编译很划算的折中。对 C1 来说，这种折中是整条管线的自然延续：前端已经在追求低延迟，后端也不会突然换成一套更重的全局最优算法去拖慢尾巴。

所以 `emit_lir` 这一步的意义，不只是“顺便做个寄存器分配”，而是：**继续把 HIR 那个相对丰富的图，压缩成一个后端能快速扫过去并快速绑定硬件资源的表示。**

## `emit_code_body` 说明 C1 快，但并不粗糙

到了 `emit_code_body()`，C1 才真正让 `LIR_Assembler` 出场。它先准备 `CodeBuffer` 和 `oop_recorder`，再构造 `C1_MacroAssembler` 和 `LIR_Assembler`，随后由 `lir_asm.emit_code(hir()->code())` 把 LIR 发成机器码。`share/c1/c1_Compilation.cpp:340`、`share/c1/c1_Compilation.cpp:342`、`share/c1/c1_Compilation.cpp:345`、`share/c1/c1_Compilation.cpp:347`、`share/c1/c1_Compilation.cpp:350`、`share/c1/c1_Compilation.cpp:352`

但这里特别值得强调的是：C1 的“快”并不是“发完主体指令就完了”。`emit_code_epilog()` 还会继续补一整套运行时必要设施：慢路径 stubs、异常入口、去优化 handler、MethodHandle 专用 deopt handler、unwind handler。`share/c1/c1_Compilation.cpp:285`、`share/c1/c1_Compilation.cpp:291`、`share/c1/c1_Compilation.cpp:295`、`share/c1/c1_Compilation.cpp:299`、`share/c1/c1_Compilation.cpp:303`、`share/c1/c1_Compilation.cpp:307`、`share/c1/c1_Compilation.cpp:316`

这说明 C1 的快不是靠“省略运行时正确性设施”换来的。它仍然要把异常、去优化、patching、unwind 这些一整套 JVM 运行时协定补齐。`LIR_Assembler` 自己的代码也能看出这一点：哪怕只是 patching stub 的 epilog，都要和 bytecode、`CodeEmitInfo`、重执行语义对应起来。`share/c1/c1_LIRAssembler.cpp:37`、`share/c1/c1_LIRAssembler.cpp:44`、`share/c1/c1_LIRAssembler.cpp:45`、`share/c1/c1_LIRAssembler.cpp:90`、`share/c1/c1_LIRAssembler.cpp:102`

最后 `install_code()` 再通过 `_env->register_method(...)` 把 frame 大小、oopmap、异常表、隐式异常表、编译器类型等信息一起注册成最终的 `nmethod`。到这里，这场低延迟编译才真正落地。`share/c1/c1_Compilation.cpp:408`、`share/c1/c1_Compilation.cpp:412`、`share/c1/c1_Compilation.cpp:417`、`share/c1/c1_Compilation.cpp:419`、`share/c1/c1_Compilation.cpp:422`

所以，这条流水线虽然快，但绝不是粗糙直译器。它只是把“必须正确的部分”补齐之后，尽量避免做那些不符合 tiered 快路径目标的重活。

## 收网：C1 快在“先显式化，再快速降级”，而不是简单少做优化

现在可以把整篇压成一张总图了。

当 tiered 策略把方法送进 C1 时，C1 并不是“小号 C2”地去复制一遍重优化编译器的路子。它做的是另一件事：先在 `build_hir()` 里把栈式字节码翻成一张显式的控制流 + 数据流混合图，建图时顺手做 Canonicalizer 和局部值编号这类最便宜的整理，再把图在 `emit_lir()` 阶段压成 LIR，并用 LinearScan 这种速度优先的寄存器分配器快速绑定硬件资源，最后在 `emit_code_body()` 里发出机器码、补齐异常与去优化入口，并安装成 `nmethod`。`share/c1/c1_Compilation.cpp:141`、`share/c1/c1_Compilation.cpp:253`、`share/c1/c1_Compilation.cpp:340`、`share/c1/c1_GraphBuilder.cpp:2299`、`share/c1/c1_ValueStack.cpp:176`、`share/c1/c1_IR.cpp:1223`

所以，这一篇最核心的一句话不是“C1 有 HIR 和 LIR”，而是：

**C1 的快来自一条为低延迟量身设计的显式化流水线：先把栈机器字节码变成图，再把图快速线性化和发码，必要时随时 bailout。**

只要这句抓住了，下一篇讲 Canonicalizer、ValueMap 和那些正式优化趟次时，就不会再把它们误会成“C1 也想变成 C2”，而会把它们看成这条快编译流水线上仍然划算的整理动作。

> → [14-c1-compiler/02 — C1 优化：`Canonicalizer + ValueMap + Optimizer`](02-c1-optimizations.md)
