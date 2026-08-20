# 03. 虚拟值怎么落到机器？— `LinearScan + LIR → x86` 码

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论 C1 后端从 HIR 到机器码的核心问题：LIR 如何承接 HIR，LinearScan 如何在有限物理寄存器下安置虚拟值，spill/split 与边上的 move 如何保持数据流连通，以及 `LIR_Assembler` 如何在保留 JVM 运行时语义的前提下发出机器码。`Runtime1` 与完整帧布局放到下一篇。
>
> **前置依赖**：[14-c1-compiler/01 — C1 为什么快？— 管线、HIR 与“把栈机器翻成图”](01-c1-pipeline-ir.md)、[14-c1-compiler/02 — C1 为什么还敢做优化？— `Canonicalizer + ValueMap + Optimizer`](02-c1-optimizations.md)、[02-assembler/01 — `CodeBuffer` 与 `AbstractAssembler`](../02-assembler/01-codebuffer-abstract-assembler.md)
> → **后续**：[14-c1-compiler/04 — `Runtime1 + FrameMap`：C1 runtime 与栈帧](04-c1-runtime-frame.md)

上一篇我们把 C1 的前端讲完了：字节码先变成 HIR，HIR 再变成 LIR，最后才会发机器码。

但“LIR → 机器码”之间还隔着一个很硬的现实：HIR/LIR 里的值数量可以很多，真实 CPU 的寄存器却很少。

一个方法里可能同时活着十几个、几十个虚拟值，而 x86_64 的通用寄存器和浮点寄存器数量都有限。更麻烦的是，C1 不能为了省事把值随便丢掉，因为 JVM 还要求：

- 调用点和 safepoint 能找到活跃 oop；
- 异常发生时能恢复解释器需要的状态；
- 去优化时能把当前机器帧还原成 Java 层状态；
- 分支汇合后，同一个逻辑值在不同路径上可能已经落在不同位置。

所以，本篇真正的问题不是“LinearScan 是什么算法”，而是：**C1 如何在极短编译时间里，把无限数量的虚拟值安置到有限的寄存器或栈槽，同时保持数据流、GC、异常和去优化语义都不被破坏？**

答案可以先压成一句话：

**C1 先把 HIR 操作降成 LIR，再把每个 LIR 操作数的生命周期压成 Interval/Range；LinearScan 按线性位置快速分配寄存器，冲突时用 spill、split 和 reload 把值暂时放到栈上；最后 LIR_Assembler 只负责把已经解决资源位置的低层操作逐条发成机器码，并补齐 patch、oopmap、异常和去优化接口。**

## 先试三个最自然的办法，看看为什么都不行

### 朴素方案一：每个虚拟值永久占一个物理寄存器

这是最直观的映射：HIR/LIR 里有多少值，就给每个值分一个寄存器，后面发码时直接替换名字。

问题是物理寄存器根本不够。更重要的是，绝大多数值并不会从方法入口一直活到方法出口。一个临时加法结果可能只活几条指令，一个分支上的对象引用可能只在一条路径有效。如果让它们永久占用寄存器，寄存器会被大量短命值浪费掉。

所以寄存器分配的真正问题不是“虚拟值有多少”，而是“每个值在什么位置活着、什么时候再次使用”。这正是生命周期分析要回答的事。

### 朴素方案二：寄存器不够时，全部放栈

第二个方案更保守：寄存器只给最紧急的值，其他一律 spill 到栈。这样最简单，也不用费心判断该挤掉谁。

但这会把 C1 的机器码变成一串高频 load/store。每次算术都要从栈取操作数，再把结果写回栈；调用之间也会增加大量搬运。编译器虽然很快跑完，生成出来的代码却会立刻把这部分成本还给应用。

C1 的目标不是“编译器越快越好”，而是在 tiered compilation 的时间预算里取得可接受的运行代码。因此它必须保留一套轻量启发式：尽量把当前真正需要的值留在寄存器，把暂时不急着用的值挤到栈。

### 朴素方案三：让 `LIR_Assembler` 发码时临时解决一切

第三个方案是把问题拖到最后：LIR 先保留大量虚拟操作数，发码时看到寄存器冲突再临时插 load/store，顺便处理分支、异常、oopmap 和去优化状态。

这会让发码器承担两种完全不同的职责：一边理解目标平台指令，一边重新推理整个程序的数据生命周期。这样不仅会让 `LIR_Assembler` 变复杂，也会让“资源位置是否已经一致”变成发码过程中的动态问题。

C1 反而把职责拆开：LinearScan 先解决值该放在哪里，LIR_Assembler 后解决“这个已经确定位置的操作如何编码成目标指令”。

所以后端的核心不是“发码器聪明”，而是**在发码之前，先把资源位置问题解决到足够明确。**

## LIR 为什么是必要的中间层

HIR 里的 `ArithmeticOp`、`Invoke`、`LoadField` 仍然携带较丰富的 Java 语义。它适合做前端优化和控制流处理，却还没有把所有机器约束显式化。

LIR 的位置就在中间：它比 HIR 更接近机器，已经可以表达寄存器、栈位置、调用、分支、内存访问、barrier、patching 等低层操作；但它又没有直接绑定成 x86 指令，因此 LinearScan 仍能在它上面统一做生命周期和寄存器分配。

C1 的 `emit_lir()` 先构造 `LIRGenerator`，按 HIR 的线性扫描顺序遍历图，生成 LIR；随后创建 `LinearScan` 并运行 `do_linear_scan()`。`share/c1/c1_Compilation.cpp:253`、`share/c1/c1_Compilation.cpp:256`、`share/c1/c1_Compilation.cpp:259`、`share/c1/c1_Compilation.cpp:267`、`share/c1/c1_Compilation.cpp:270`、`share/c1/c1_IR.cpp:1223`、`share/c1/c1_IR.cpp:1224`

这一步的真正意义是把问题拆成两层：

- `LIRGenerator` 决定“这个 HIR 语义要变成什么低层操作”；
- `LinearScan` 决定“这些低层操作的输入输出放在哪些寄存器或栈槽”。

如果没有 LIR，前端语义和目标指令编码会过早纠缠，C1 就很难保持自己的低延迟结构。

## LinearScan 的全流程：先知道谁活着，再决定放哪

`LinearScan::do_linear_scan()` 的顺序非常能说明它的工作哲学：

1. 给 LIR 指令编号；
2. 计算局部和全局 live set；
3. 构造 Interval；
4. 排序；
5. 分配寄存器；
6. 解决控制流边上的数据流位置；
7. 确定 spill slot 与帧大小；
8. 清理多余 spill move，分配真实寄存器编号，再做边 move 与控制流优化。 `share/c1/c1_LinearScan.cpp:3100`、`share/c1/c1_LinearScan.cpp:3103`、`share/c1/c1_LinearScan.cpp:3107`、`share/c1/c1_LinearScan.cpp:3111`、`share/c1/c1_LinearScan.cpp:3118`、`share/c1/c1_LinearScan.cpp:3121`、`share/c1/c1_LinearScan.cpp:3125`、`share/c1/c1_LinearScan.cpp:3136`、`share/c1/c1_LinearScan.cpp:3151`

这条顺序很重要。LinearScan 不是看到一条 LIR 指令就随便分一个寄存器，而是先建立“哪些值在哪些位置活着”的全局视图，再做资源分配。

它的快，来自于这套全局视图是以**线性位置**组织的，而不是建立一个复杂的全局最优搜索。对 C1 来说，知道足够好的活跃区间和下一次使用位置，就已经能做出足够好的寄存器选择。

## Interval 为什么不是简单的 `[start, end]`

如果一个虚拟值在方法里从位置 10 活到位置 100，看起来可以把它表示成 `[10,100]`。但真实控制流一旦有分支，这个表示就太粗了。

一个值可能在一条路径上从位置 10 活到 30，在另一条路径上从 80 活到 100，中间的 31 到 79 根本没有使用。把它粗暴写成一个连续区间，会让寄存器分配器以为这个值一直占着寄存器，浪费资源。

所以 LinearScan 的 Interval 不是一个简单的首尾区间，而是由多个 Range 组成的链。每个 Range 描述一段连续活跃区间；多个 Range 合在一起，才能表达分支和循环造成的不连续生命周期。

这也为 split 铺路。一个 Interval 可以在某个位置被切开：前半段留在寄存器，后半段进 spill slot；或者某个循环热区留在寄存器，冷路径放到栈上。这样“spill”就不再意味着一个值从头到尾都住在栈里，而只是它在某一段生命周期里暂时离开寄存器。

这就是为什么 Interval/Range 结构是 C1 后端的关键：**它让编译器可以按生命周期片段安排资源，而不是对整个方法做粗糙的永久绑定。**

## 寄存器冲突时，LinearScan 怎么选该被挤走的值

一个新 Interval 激活时，`activate_current()` 会先处理几类特殊情况：方法参数可能必须从栈开始，某些值也必须先落在内存；普通 Interval 则先尝试合并不相交的 spill 区间，再尝试拿空闲寄存器。`share/c1/c1_LinearScan.cpp:5792`、`share/c1/c1_LinearScan.cpp:5799`、`share/c1/c1_LinearScan.cpp:5804`、`share/c1/c1_LinearScan.cpp:5807`、`share/c1/c1_LinearScan.cpp:5813`、`share/c1/c1_LinearScan.cpp:5817`、`share/c1/c1_LinearScan.cpp:5823`、`share/c1/c1_LinearScan.cpp:5826`

如果没有空闲寄存器，才进入 `alloc_locked_reg()`，尝试挤掉当前已经占用寄存器的 Interval。这里最容易被讲错的是 spill 选择标准。

它不是简单选“结束位置最远”的那个，而是看寄存器占用者的下一次使用位置。`find_locked_reg()` 遍历候选寄存器，比较 `_use_pos[i]`，选择下一次使用最晚的那个。直觉很简单：**谁最晚才会再次用到，就先把谁挤到栈上，当前这段时间可以把寄存器让给眼前更急的值。** `share/c1/c1_LinearScan.cpp:5504`、`share/c1/c1_LinearScan.cpp:5507`、`share/c1/c1_LinearScan.cpp:5511`、`share/c1/c1_LinearScan.cpp:5512`、`share/c1/c1_LinearScan.cpp:5522`

被挤出去的 Interval 会 split，为它安排 spill slot，等下一次真的需要它时再 reload 回寄存器。这个选择不是理论最优，但在 C1 的编译时间预算里非常划算：它只需要快速查看下一次使用位置，就能做出相当合理的局部决策。

所以 LinearScan 的关键不是“不会 spill”，而是**让 spill 尽量发生在值暂时不急用的地方，并用 split 限制 spill 的覆盖范围。**

## 为什么 block edge move 是必需的

即使每个 Interval 都已经分配了位置，控制流边上仍然可能出现一个问题：同一个逻辑值，在前驱块结束时位于寄存器 A，在后继块入口却被分配到寄存器 B，或者一条路径在寄存器里，另一条路径已经在 spill slot 里。

如果不处理，这两块之间的数据流语义就断了。

`resolve_data_flow()` 就负责在这些控制流边上插入必要的 move；异常处理器还有单独的 resolve 路径。之后 LinearScan 尾部再用 `EdgeMoveOptimizer::optimize()` 和 `ControlFlowOptimizer::optimize()` 清理多余 move 与控制流结构。`share/c1/c1_LinearScan.cpp:1793`、`share/c1/c1_LinearScan.cpp:3121`、`share/c1/c1_LinearScan.cpp:3122`、`share/c1/c1_LinearScan.cpp:3151`、`share/c1/c1_LinearScan.cpp:3153`、`share/c1/c1_LinearScan.cpp:3154`

这一步特别能说明寄存器分配不是“给每个值贴标签”这么简单，而是要保证**跨基本块的值位置在边上重新对齐**。

因此，C1 后端的完整顺序其实是：先分配，允许路径之间暂时不一致；再在边上补齐 move；最后把明显冗余的 move 清掉。这样既保持分配器简单，又不会把复杂的全局位置协调塞进每一步分配决策里。

## LIR_Assembler 发码：它不是重新分配，而是把已经解决的问题编码出来

资源位置解决之后，才轮到 `LIR_Assembler`。

`LIR_Assembler::emit_code()` 遍历 HIR 的 block 列表，逐个调用 `emit_block()`；`emit_block()` 再把当前块的 LIR list 交给 `emit_lir_list()`；后者逐个取出 `LIR_Op`，检查 code space，然后调用各类具体 emit 函数。`share/c1/c1_LIRAssembler.cpp:214`、`share/c1/c1_LIRAssembler.cpp:219`、`share/c1/c1_LIRAssembler.cpp:221`、`share/c1/c1_LIRAssembler.cpp:231`、`share/c1/c1_LIRAssembler.cpp:262`、`share/c1/c1_LIRAssembler.cpp:268`、`share/c1/c1_LIRAssembler.cpp:271`、`share/c1/c1_LIRAssembler.cpp:275`

这时候 LIR 操作数已经基本知道自己在哪：寄存器、栈槽、常量或内存地址。于是 assembler 的主要职责变成：

- 根据操作数形态选择目标指令编码；
- 发出算术、加载、存储、分支、调用等机器指令；
- 处理 patching 与 `CodeEmitInfo`；
- 记录异常、safepoint、调试和去优化需要的信息。

所以不要把 `LIR_Assembler` 想成“一个更聪明的 LinearScan”。它不应该在这里重新解决虚拟值生命周期；它消费的是 LinearScan 已经整理过的低层操作。

这也解释了为什么 x86 的 peephole 并不是 C1 LIR 优化的主角。真正的 LIR 清理已经发生在 LinearScan 尾部的 `EdgeMoveOptimizer` 和 `ControlFlowOptimizer`；assembler 主要承担的是编码与运行时协定。

## 快发码仍然必须保留 JVM 语义

C1 后端虽然追求快，但它发出的不是一段脱离 JVM 的裸机器码。JVM 还要求它能在异常、调用、GC safepoint、类未解析、去优化等情况下回到正确的 Java 语义。

这就是为什么 `emit_code_epilog()` 和 `LIR_Assembler` 需要保留 slow stubs、exception entries、deopt handler、unwind handler。它们不是“发码后的装饰”，而是机器码能够作为 JVM nmethod 运行的必要接头。

比如 patching stub 会通过 `CodeEmitInfo` 知道当前对应哪个 bytecode、需要什么 patch 类型；它还会设置 force reexecute，让 patch 或异常处理完成后能够按 JVM 需要重新执行原 bytecode。`share/c1/c1_LIRAssembler.cpp:37`、`share/c1/c1_LIRAssembler.cpp:44`、`share/c1/c1_LIRAssembler.cpp:45`、`share/c1/c1_LIRAssembler.cpp:49`、`share/c1/c1_LIRAssembler.cpp:90`、`share/c1/c1_LIRAssembler.cpp:92`

最终 `Compilation::install_code()` 会把 frame size、oopmaps、异常表、隐式异常表、编译器对象等信息交给 `env->register_method()`，注册成 nmethod。`share/c1/c1_Compilation.cpp:408`、`share/c1/c1_Compilation.cpp:412`、`share/c1/c1_Compilation.cpp:417`、`share/c1/c1_Compilation.cpp:419`、`share/c1/c1_Compilation.cpp:422`

所以 C1 的“快”有一个明确边界：它可以少做深度优化，可以用启发式寄存器分配，可以把复杂动作交给 Runtime1，但不能省掉 JVM 运行时需要的状态恢复与安全信息。

## 收网：LinearScan 解决的是有限资源安置，LIR_Assembler 解决的是目标编码

现在可以把整篇压成一张总图了。

C1 先把 HIR 降成 LIR，让机器相关操作数和调用/内存/状态约束显式化；然后 LinearScan 先计算 live set，再构造由多个 Range 组成的 Interval，按线性位置快速分配寄存器；寄存器不够时，选择下一次使用更晚的占用者 spill，并用 split、spill slot 和 reload 把生命周期切开；控制流边上如果同一个值落在不同位置，就插入并优化 move；最后 LIR_Assembler 才逐块逐 op 发出机器码，同时保留 patch、oopmap、异常、去优化与 unwind 语义。`share/c1/c1_Compilation.cpp:256`、`share/c1/c1_Compilation.cpp:267`、`share/c1/c1_LinearScan.cpp:3100`、`share/c1/c1_LinearScan.cpp:3111`、`share/c1/c1_LinearScan.cpp:3118`、`share/c1/c1_LinearScan.cpp:3121`、`share/c1/c1_LinearScan.cpp:3153`、`share/c1/c1_LIRAssembler.cpp:214`

所以，本篇最核心的一句话不是“LinearScan 是一个线性寄存器分配器”，而是：

**C1 后端把“虚拟值太多、物理寄存器太少”的问题，转化成生命周期区间、spill/split 和边 move 的快速安置问题；资源位置解决后，LIR_Assembler 才负责把这些已经对齐的操作编码成机器码。**

只要这句抓住了，下一篇 `Runtime1 + FrameMap` 就好理解了：机器码并不是所有事情都自己完成，C1 会把复杂慢路径委托给 Runtime1，而 FrameMap 则负责把这段机器码放进一个 JVM 能识别的栈帧里。

> → [14-c1-compiler/04 — `Runtime1 + FrameMap`：C1 runtime 与栈帧](04-c1-runtime-frame.md)
