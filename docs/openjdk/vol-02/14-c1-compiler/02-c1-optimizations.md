# 02. C1 为什么还敢做优化？— `Canonicalizer + ValueMap + Optimizer`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 C1 在 HIR 前后期做的那批“低成本清理”：`Canonicalizer`、`ValueMap`、`Optimizer`、空检查消除、范围检查消除。C2 式深层全局优化不在本文范围内。
>
> **前置依赖**：[14-c1-compiler/01 — C1 为什么快？— 管线、HIR 与“把栈机器翻成图”](01-c1-pipeline-ir.md)、[12-ci/02 — 编译器怎么知道“类型”与“逃逸”？— `ciTypeFlow + BCEscapeAnalyzer`](../12-ci/02-ci-typeflow-escape.md)
> → **后续**：[14-c1-compiler/03 — `LinearScan + LIR → x86` 码](03-c1-register-codegen.md)

上一篇我们已经把 C1 的主线钉住了：它不是小号 C2，而是一条为低延迟设计的显式化流水线。先把栈式字节码翻成 HIR 图，再迅速降成 LIR，最后发机器码，必要时随时 bailout。

但一旦你真的接受了“C1 首先追求快”这个前提，马上又会冒出一个反问：**既然它这么在乎速度，为什么还要做优化？为什么不把 naive HIR 原样送下去，赶紧发码算了？**

这个问题很关键。因为它逼我们看到 C1 和 C2 的另一个根本差别：C1 不是“不优化”，而是**只做那些在建图期和 HIR 早期就能低成本兑现、而且能明显减轻后面负担的清理动作。**

换句话说，C1 优化的目标不是“做尽可能多”，而是“尽快把垃圾扔掉”。

先记住这句结论。后面你看到 `Canonicalizer`、`ValueMap`、`Optimizer`、空检查消除、范围检查消除时，就不会把它们看成“C1 也在偷偷模仿 C2”，而会把它们看成：**为了让 LIR 和发码别背着一堆显而易见的垃圾继续跑，前端顺手做的便宜清理。**

## 先试两个最自然的极端，看看为什么都不对

### 极端一：C1 既然追求快，那就完全别做优化，直接发码

这是最容易想到的极端做法。既然 tiered compilation 选 C1 的原因就是“赶快出结果”，那前端还做什么值复用、空检查消除、代数化简？这些看起来不都是额外成本吗？

问题在于，不做任何清理并不是真的“省事”。

naive HIR 如果原样往后传，会把许多显而易见的冗余带给后面的每一段：

- `a + 0`、`x == x` 这种一眼就能看穿的结构还得继续占节点、占 use-count、占寄存器分配视野；
- 同块里重复算两遍完全一样的值，LIR 和寄存器分配器也得跟着再背一遍；
- 能证明非空的对象还留着 NullCheck，能证明边界安全的数组访问还留着 RangeCheck，后面就得继续处理这些控制流和异常边；
- 基本块里一堆本来能收缩掉的控制流与死块还挂在图上，整个后端看到的图都会更脏。

也就是说，**完全不优化，不是省成本，而是把本来可以极便宜消掉的垃圾，一路带到更贵的阶段去处理。**

对 C1 这种强调低延迟的编译器来说，这反而不划算。

### 极端二：既然要做优化，那就尽量做成小号 C2

另一种极端正好相反：既然不清理不行，那索性多做一点，把前端图尽量洗得更干净一些。看起来每多做一步，后面的代码质量就会更好。

但这又会踩到 C1 的核心禁区：**优化本身也要花时间。**

一旦优化开始追求更深的全局推理、更复杂的别名与控制流变换、更昂贵的数据流不动点分析，编译器就会迅速偏离 “tiered 快路径” 的目标。那时它不再是“先给系统一个足够好的结果”，而开始朝“尽量逼近最优结果”滑去，这本来就是 C2 的工作。

所以 C1 能做的，不是“尽量多”，而是“严格筛选那些便宜到值得当场做掉的动作”。

这也是为什么你在 C1 里看到的优化，大多都有一个共同特点：

- 要么发生在节点刚 append 时；
- 要么发生在 HIR 还没离开前端时；
- 要么只盯着很局部、很明确的冗余；
- 很少依赖长距离、深层、昂贵的全局推理。

一旦理解了这个边界，C1 的优化集合就会显得非常合理。

## `Canonicalizer` 的关键不在“会化简什么”，而在“为什么要当场化简”

C1 里最能体现“便宜优化必须尽早做”的，就是 `Canonicalizer`。

它不是在 HIR 全部建完之后跑的一大段清理程序，而是在 `GraphBuilder::append_with_bci()` 里，节点准备入链的那一刻就立刻被调用。更直接一点说：**某个 HIR 节点刚被建出来，还没真的挂进图，Canonicalizer 就先上去看它值不值得活下来。** `share/c1/c1_GraphBuilder.cpp:2299`、`share/c1/c1_GraphBuilder.cpp:2300`、`share/c1/c1_GraphBuilder.cpp:2301`

而 `Canonicalizer` 自己的构造函数也把这一点写得很死：构造时就 `x->visit(this)`，没有第二阶段，没有“等所有节点都准备好了再统一 canonicalize 一遍”的意思。`share/c1/c1_Canonicalizer.hpp:57`、`share/c1/c1_Canonicalizer.hpp:59`

这背后的设计动机非常重要。对 C1 来说，最便宜的优化时机，往往不是“等全图都建完”，而是“这个节点刚出现、你还记得上下文、也还没把它传染给更多后续阶段”的那一刻。

如果一条 `ArithmeticOp` 本来就等价于已有值，或者一个 `If` 本来就能直接收成 `Goto`，那当然越早消掉越好。越晚消掉，它就越可能污染后续的 use-count、ValueMap、块结构甚至异常边。

所以 `Canonicalizer` 的第一价值，不是规则有多聪明，而是**它把“该早扔的垃圾”扔在了最早的时机。**

## `Canonicalizer` 真正做的，是便宜的局部恒等、折叠和控制流收缩

理解了时机，再看它具体做什么，就不会高估也不会低估它。

在 `do_Op2` 这一类逻辑里，最典型的三类事情是：

- 两边是同一值时的恒等化简，比如 `x - x -> 0`、`x & x -> x`、`x ^ x -> 0`；
- 两边都是常量时的常量折叠，比如 int/long 的加减乘除余数与位运算；
- 一边是特殊常量时的局部简化，比如 `x + 0 -> x`、`x - 0 -> x`、`x | 0 -> x`、`x & 0 -> 0`。 `share/c1/c1_Canonicalizer.cpp:77`、`share/c1/c1_Canonicalizer.cpp:79`、`share/c1/c1_Canonicalizer.cpp:85`、`share/c1/c1_Canonicalizer.cpp:92`、`share/c1/c1_Canonicalizer.cpp:95`、`share/c1/c1_Canonicalizer.cpp:115`、`share/c1/c1_Canonicalizer.cpp:153`、`share/c1/c1_Canonicalizer.cpp:160`、`share/c1/c1_Canonicalizer.cpp:162`、`share/c1/c1_Canonicalizer.cpp:167`

这里最值得抓住的是边界感。它确实会做常量折叠和恒等律，但它不是一个“大而全代数优化器”。它做的全是那种**看一眼就知道值回票价**的改写。

控制流这边也一样。`do_If` 会先把常量挪到右边，然后处理几类非常便宜的模式：

- `If(a cond a)` 直接变成 `Goto`；
- `If(常量 cond 常量)` 直接编译期决定走哪条边；
- `If((a cmp b) cond rc)` 会进一步尝试收缩成更简单的 `If` 甚至 `Goto`。 `share/c1/c1_Canonicalizer.cpp:712`、`share/c1/c1_Canonicalizer.cpp:714`、`share/c1/c1_Canonicalizer.cpp:719`、`share/c1/c1_Canonicalizer.cpp:732`、`share/c1/c1_Canonicalizer.cpp:736`、`share/c1/c1_Canonicalizer.cpp:744`、`share/c1/c1_Canonicalizer.cpp:750`、`share/c1/c1_Canonicalizer.cpp:763`

这一步特别能说明 C1 的优化审美：不是“先把 CFG 全建完，再跑一轮复杂控制流优化”，而是“如果我在你刚进图时就能看出你其实只是个 `Goto`，那我为什么还要让你先以 `If` 的身份污染图？”

这也顺手澄清一个经常被讲错的点：`Canonicalizer` 不是方法内联器。它处理的是节点级、局部结构级的化简，不负责把 getter/setter 之类的方法体塞进来。内联决策与调用处理是在 GraphBuilder 那条方法调用路径上，不在这里。

## `ValueMap`：为什么值复用也要分“当场局部”和“后续全局”两层

光把明显的算术与分支节点化简掉还不够。另一类很浪费的东西是：**完全相同的值被反复重新建出来。**

这就是 `ValueMap` 的任务。`find_insert()` 的逻辑很直接：

- 先看这个值有没有 hash；
- 有 hash 就沿桶链表找；
- 若哈希相同、值没被 kill，而且 `is_equal()`，就复用旧值；
- 否则把新值插进去。 `share/c1/c1_ValueMap.cpp:109`、`share/c1/c1_ValueMap.cpp:111`、`share/c1/c1_ValueMap.cpp:115`、`share/c1/c1_ValueMap.cpp:119`、`share/c1/c1_ValueMap.cpp:130`、`share/c1/c1_ValueMap.cpp:136`、`share/c1/c1_ValueMap.cpp:141`

乍一看这是个普通哈希缓存，但它有两个特别能体现 C1 风格的细节。

第一个是**跨块命中要 pin**。如果命中的旧值来自另一个 block，而且它不是常量，就要 `pin(Instruction::PinGlobalValueNumbering)`。原因写得很直白：否则这个值可能根本没被真正求值。也就是说，C1 不会因为“看起来一样”就盲目跨块复用，它知道控制流世界里“值相等”和“值一定已经在所有路径上都算出来了”不是同一回事。`share/c1/c1_ValueMap.cpp:123`、`share/c1/c1_ValueMap.cpp:124`、`share/c1/c1_ValueMap.cpp:126`

第二个是 kill 语义。内存、数组、字段一旦发生写入，相关 load 结果就不能再安全复用，所以 `ValueMap` 明确提供了 `kill_memory()`、`kill_array()`、`kill_field()`、`kill_all()`。也就是说，它不是“无脑全局缓存”，而是一张带别名失效边界的值复用表。`share/c1/c1_ValueMap.cpp:196`、`share/c1/c1_ValueMap.cpp:200`、`share/c1/c1_ValueMap.cpp:204`、`share/c1/c1_ValueMap.cpp:213`

这也解释了为什么值编号分两层。

- 在 `append_with_bci()` 里跑的是当场、局部、最便宜的 Local Value Numbering；
- 在 `build_hir()` 里单独拉起的 `GlobalValueNumbering`，则是在图成形后再做一轮更全的复用整理。

两层都服务于同一个目标：**能便宜复用的值，就别让后面的 LIR 和寄存器分配再背一遍。** 但它们的代价与适用范围不同，所以时机也不同。

## `Optimizer`：C1 仍然愿意花一点钱把控制流结构修平

除了节点级化简和值复用，C1 在 HIR 阶段还留了一点点“结构整理”的预算。这个预算体现在 `Optimizer` 上。

`Optimizer` 本身的接口就很克制：只有 `eliminate_conditional_expressions()`、`eliminate_blocks()`、`eliminate_null_checks()` 这几类事情。它不是一个“大而全优化框架”，而是一只专门负责把 CFG 和检查节点再抹平一层的轻量工具。`share/c1/c1_Optimizer.hpp:31`、`share/c1/c1_Optimizer.hpp:36`、`share/c1/c1_Optimizer.hpp:40`、`share/c1/c1_Optimizer.hpp:41`、`share/c1/c1_Optimizer.hpp:42`

在 `IR::optimize_blocks()` 里，C1 会根据 profiling 需求和开关做条件表达式消除与块消除。翻译成人话，这一步就是在问：**有没有一些控制流骨架已经足够明显，值得我现在就把它修平，而不要带着它们一路进入后端？** `share/c1/c1_IR.cpp:277`、`share/c1/c1_IR.cpp:279`、`share/c1/c1_IR.cpp:280`、`share/c1/c1_IR.cpp:287`、`share/c1/c1_IR.cpp:288`

这仍然符合 C1 的整体哲学。它愿意做一点控制流整理，但前提是：

- 这件事很便宜；
- 清理掉之后，后面每一层都能受益；
- 它不要求昂贵的全局重写。

所以别把这里想成“C1 也在做复杂 CFG surgery”；它做的是“能顺手修平的地方就顺手修平”。

## 为什么空检查和范围检查值得在 C1 做

空检查和范围检查消除，是另一类特别划算的动作。

`IR::eliminate_null_checks()` 的逻辑非常直接：构造一个 `Optimizer`，如果 `EliminateNullChecks` 开关允许，就去做空检查消除。也就是说，它并不是某个深埋在后端的隐藏小技巧，而是 HIR 阶段公开的一步整理。`share/c1/c1_IR.cpp:297`、`share/c1/c1_IR.cpp:299`、`share/c1/c1_IR.cpp:300`

为什么值得？因为多余的 NullCheck 不只是多一条条件，它还会带着异常边、状态点和控制流复杂性一路往后走。只要前端已经足够确定某个对象非空，那早点删掉，后面每层都会更轻。

范围检查消除也一样。`RangeCheckElimination::eliminate()` 一上来先看一件很实在的事：这个方法里到底有没有 `AccessIndexed`。没有，就不做；有，才构造 `RangeCheckEliminator`。也就是说，连这一步都先做了一个非常便宜的收益判断。`share/c1/c1_RangeCheckElimination.cpp:46`、`share/c1/c1_RangeCheckElimination.cpp:47`、`share/c1/c1_RangeCheckElimination.cpp:49`、`share/c1/c1_RangeCheckElimination.cpp:50`

这再次暴露出 C1 的偏好：**只在“我已经看到确实有这类垃圾，而且清掉它很划算”的时候才动手。**

所以空检查和范围检查消除在 C1 里不是锦上添花，而是符合它成本模型的前端减负动作。清掉这些显而易见的守卫，后面的 LIR、更底层的寄存器分配和发码自然会轻很多。

## 这些优化共同追求的，不是“最优 HIR”，而是“别把垃圾继续带下去”

把 `Canonicalizer`、`ValueMap`、`Optimizer`、空检查消除、范围检查消除放在一起看，就会发现它们有非常强的共同气质：

- 都发生得很早；
- 都瞄准特别明确的冗余；
- 都尽量避免昂贵的全局推理；
- 都追求“做掉这一步以后，后面的表示更轻、更平、更少废节点”。

这说明 C1 的优化成功标准，根本不是“把 HIR 打磨到多漂亮”，而是：**让 naive HIR 别再带着显而易见的垃圾继续走进 LIR 和发码。**

这就是为什么这篇的主角看起来不像传统意义上的“优化大招”。它们都更像清洁工，而不是艺术家。

但对 C1 来说，这种清洁工恰恰最重要。因为它需要的是快编译，不是深优化；可快编译也不能让后端背着一车没必要的破烂前行。

## 收网：C1 优化的目标不是做最多，而是尽快把垃圾扔掉

现在可以把整篇压成一张总图了。

C1 之所以在低延迟前提下仍然敢做优化，不是因为它偷偷朝 C2 靠近，而是因为它非常严格地筛选了“什么值得在前端就顺手做掉”。`Canonicalizer` 在 `append_with_bci()` 的那一刻，就把局部恒等、常量折叠和明显的控制流收缩当场做掉；`ValueMap` 则把相同值复用掉，并在必要时用 pin 与 kill 保护正确性；`Optimizer`、空检查消除和范围检查消除只做那些图上已经显而易见、而且清理后能显著减轻后端负担的结构整理。它们共同的目标不是“把 HIR 变成最优 HIR”，而是**在不破坏低延迟目标的前提下，尽快把图里的便宜垃圾扔掉。** `share/c1/c1_Canonicalizer.hpp:57`、`share/c1/c1_GraphBuilder.cpp:2299`、`share/c1/c1_ValueMap.cpp:109`、`share/c1/c1_IR.cpp:277`、`share/c1/c1_IR.cpp:297`、`share/c1/c1_RangeCheckElimination.cpp:46`

所以，这一篇最核心的一句话不是“C1 有 Canonicalizer、ValueMap 和 Optimizer”，而是：

**C1 的优化哲学不是做尽可能多，而是把那些最便宜、最确定、最能减轻后端负担的清理动作尽早做掉。**

只要这句抓住了，下一篇 `LinearScan + LIR → x86` 就好理解了：前端之所以要先把图清干净，不是为了炫耀 HIR，而是为了让寄存器分配和发码阶段走得更快、更直。

> → [14-c1-compiler/03 — `LinearScan + LIR → x86` 码](03-c1-register-codegen.md)
