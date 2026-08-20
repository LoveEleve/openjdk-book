# 04. 为什么循环要单独优化？— `CountedLoop + PhaseIdealLoop + SuperWord`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论 C2 的循环层级优化：`CountedLoop` 识别、`PhaseIdealLoop` 结构变换、pre/main/post 分期、loop predication 和 SuperWord 向量化。寄存器分配与最终机器码放到后续章节。
>
> **前置依赖**：[15-c2-compiler/01 — 为什么 C2 要换世界观？— `Ideal Graph = Node + Type + IGVN`](01-c2-ideal-graph.md)、[15-c2-compiler/02 — Ideal Graph 是怎么长出来的？— `Parse + GraphKit`](02-c2-parse-graphkit.md)、[15-c2-compiler/03 — 为什么 C2 还要三套引擎？— `IGVN + CCP + Escape Analysis`](03-c2-optimizations.md)、[13-jit-framework/02 — 为什么先 C1 再 C2？— `TieredThresholdPolicy`](../13-jit-framework/02-tiered-compilation-policy.md)
> → **后续**：[15-c2-compiler/05 — `Chaitin`：图着色寄存器分配](05-c2-register-alloc.md)

上一篇我们讲了 C2 的三套优化引擎：IGVN 负责图收敛，CCP 负责常量与控制可达性，Escape Analysis 负责对象去向。

但循环不是“普通图优化多跑几次”就能处理的对象。

`for (int i = 0; i < n; i++) a[i] = b[i] + c[i]` 这段代码表面上只是一个 `Region`、一个 `Phi`、一个加法、一次比较和一条回边。可如果 C2 想把它优化到位，真正要回答的问题却是：

- 这是一个可计算 trip count 的计数循环吗？
- 每次迭代的步长是否固定？
- 哪些检查可以从循环体抬到入口只做一次？
- 循环体能否按 4 次或 8 次展开？
- 展开后是否能得到相邻的 load/add/store，组成向量 pack？
- 不对齐的开头和无法整除的尾巴怎么处理？

这些问题的共同点是：**优化对象不再是某个节点，而是整轮迭代的规律。**

所以 C2 会先把一团普通回边控制流识别成 `CountedLoop`，再交给 `PhaseIdealLoop` 和 `SuperWord` 这套独立的循环世界。它们做的不是“把节点再化简一下”，而是把循环重新分期、重新组织，最后把重复执行的标量操作打包成向量操作。

先记住这一句：**循环优化先看形状，再谈节点；先证明整轮迭代有规律，再决定是否值得展开、去检查和向量化。**

## 先试两个最自然的办法，看看为什么都不够

### 朴素方案一：循环只是普通控制流多跑几次，IGVN/CCP/EA 足够了

这是一个合理的想法。IGVN 能化简节点，CCP 能切掉不可达分支，EA 能消除不必要的分配，那循环似乎只需要让这些引擎多跑几遍。

问题是，这些引擎主要围绕节点、类型、可达性和对象引用工作。它们不会自动把一段控制流抽象成“第几次迭代、初值是多少、步长是多少、上界在哪里”。

没有这个循环级模型，C2 很难安全地完成这些变换：

- 把逐次数组边界检查提升成一次性入口谓词；
- 把循环体复制四份并正确调整 limit；
- 判断展开后的尾部应该落在哪条 post-loop；
- 判断四个 load 是否真的相邻、没有内存依赖冲突；
- 为向量主循环准备对齐的起点。

所以循环需要自己的分析对象和变换策略，而不是单纯增加普通节点 pass 的次数。

### 朴素方案二：向量化就是把相邻四条指令合成一条

这也只对了一小部分。

如果原始循环体只有一次迭代中的一条 `a[i] = b[i] + c[i]`，向量化器看不到四组相邻的同构操作。它需要循环先展开，才能把 `i`、`i+1`、`i+2`、`i+3` 这些迭代的操作摆在一起。

即使操作已经相邻，向量化器还要确认：

- memory reference 的 base、scale 和 offset 是否匹配；
- load/store 之间是否存在依赖；
- 循环是否是适合 SuperWord 的 counted main-loop；
- 主循环入口是否满足对齐和 pre-loop 条件；
- 剩余不足一个向量宽度的迭代由谁处理。

所以向量化不是最后撒一层指令语法糖，而是整个循环整形过程的兑现结果。

## `CountedLoop`：为什么它是所有循环待遇的门票

C2 不会把每个带回边的 Region 都当成高质量计数循环。`PhaseIdealLoop::is_counted_loop()` 会先检查非常严格的形状。

循环头必须是一个合适的 `RegionNode`，拥有 self、entry、loop-back 三类控制输入；entry 和 backedge 都不能缺失，也不能已经是 `TOP`；回边控制还必须落在 `IfTrue` 或 `IfFalse` 上。`share/opto/loopnode.cpp:372`、`share/opto/loopnode.cpp:375`、`share/opto/loopnode.cpp:377`、`share/opto/loopnode.cpp:380`、`share/opto/loopnode.cpp:382`、`share/opto/loopnode.cpp:384`、`share/opto/loopnode.cpp:389`、`share/opto/loopnode.cpp:400`、`share/opto/loopnode.cpp:403`

接着它还要找到回边测试里的 `BoolNode`、整型比较、递增节点和循环不变量 limit。源码明确拒绝 pointer/float compare，因为后续 trip count、展开和边界变换需要的是可计算的整数计数关系。`share/opto/loopnode.cpp:410`、`share/opto/loopnode.cpp:414`、`share/opto/loopnode.cpp:421`、`share/opto/loopnode.cpp:424`、`share/opto/loopnode.cpp:427`

为什么这么严格？因为后续所有高级待遇都在押注一个事实：**循环不是任意回边，而是一个可以用初值、步长和边界描述的迭代机器。**

一旦识别失败，C2 仍然可能对普通 loop 做 peeling 或 unswitch，但它不能放心地套用完整的 counted-loop 展开、范围检查消除和 SuperWord 流程。

## `PhaseIdealLoop`：循环优化不是一次 pass，而是先重建循环世界

`PhaseIdealLoop::build_and_optimize()` 的前半段并没有马上展开循环，而是先搭建循环分析基础：

- 建立 `IdealLoopTree` 根；
- `build_loop_tree()` 建立嵌套循环树；
- `beautify_loops()` 拆共享 header、补循环 landing pad；
- 建 dominator 信息；
- `build_loop_early()` 与 `build_loop_late()` 计算节点的合法控制位置；
- 在这个基础上识别 counted loop。 `share/opto/loopnode.cpp:3096`、`share/opto/loopnode.cpp:3111`、`share/opto/loopnode.cpp:3150`、`share/opto/loopnode.cpp:3171`、`share/opto/loopnode.cpp:3215`、`share/opto/loopnode.cpp:3217`、`share/opto/loopnode.cpp:3229`

这套流程说明 `PhaseIdealLoop` 不只是“给每个循环跑一个优化函数”，它先把整张 Ideal Graph 重新投影成一棵循环树，并为每个节点建立“属于哪个循环、最早/最晚能放在哪里、谁支配谁”的循环视图。

只有有了这个视图，C2 才能讨论：

- 某个 load 是否是循环不变量；
- 某个检查是否能移动到 loop entry；
- 某个节点是否应该被复制进 pre-loop 或 post-loop；
- 某个循环是否可以被 SuperWord 当成一个完整 main-loop 消费。

所以循环优化的第一步不是“动循环”，而是**先建立循环世界。**

## `iteration_split`：为什么 C2 不直接展开，而是先把循环分期

真正的结构变换入口是 `iteration_split_impl()`。它先计算 trip count，处理单迭代循环和空循环；非 counted loop 则走 partial peel、peeling 或 unswitch；counted loop 才进入更完整的展开、范围检查和对齐策略。`share/opto/loopTransform.cpp:3273`、`share/opto/loopTransform.cpp:3279`、`share/opto/loopTransform.cpp:3282`、`share/opto/loopTransform.cpp:3286`、`share/opto/loopTransform.cpp:3293`、`share/opto/loopTransform.cpp:3295`、`share/opto/loopTransform.cpp:3300`、`share/opto/loopTransform.cpp:3309`、`share/opto/loopTransform.cpp:3311`

对于 counted loop，它会根据策略决定是否：

- 完全展开或 unswitch；
- peel 一部分迭代；
- 做 range check elimination；
- 做对齐；
- 做固定因子 unroll。 `share/opto/loopTransform.cpp:3316`、`share/opto/loopTransform.cpp:3321`、`share/opto/loopTransform.cpp:3326`、`share/opto/loopTransform.cpp:3334`、`share/opto/loopTransform.cpp:3349`、`share/opto/loopTransform.cpp:3350`

如果 RCE、对齐或展开任意一个策略成立，C2 就会切换到 pre/main/post 模型。源码直接写了：这些条件满足时，将 normal loop 转换为 pre/main/post loops。`share/opto/loopTransform.cpp:3362`、`share/opto/loopTransform.cpp:3365`、`share/opto/loopTransform.cpp:3371`

这说明“展开循环”只是一个局部动作，真正的结构目标是：**把不同职责拆到不同循环中，让主循环变得干净而规则。**

## pre / main / post：三段循环分别替主循环背什么债

`insert_pre_post_loops()` 的实现不是一个抽象概念，它真的会创建 post-loop，再 clone 原循环生成 pre-loop，并调整主循环的边界与控制。`share/opto/loopTransform.cpp:1396`、`share/opto/loopTransform.cpp:1407`、`share/opto/loopTransform.cpp:1410`、`share/opto/loopTransform.cpp:1437`、`share/opto/loopTransform.cpp:1445`、`share/opto/loopTransform.cpp:1447`

三段循环的职责可以这样理解：

- **pre-loop**：先跑掉少量不适合主循环的迭代，处理剥皮、入口谓词和对齐准备；
- **main-loop**：只保留规则、展开后、适合 RCE 和向量化的主体；
- **post-loop**：处理展开因子无法整除的零头，也承接剩余的边界检查。

因此，`n % 4` 的最后 1～3 次迭代属于 post-loop 的职责，不是 strip mining 的含义。

C2 的 `do_unroll()` 会读取 counted loop 的 init、limit、stride，调整主循环边界，并复制循环体。它还会先检查循环入口形状是否满足 zero-trip guard 等约束；形状不对，展开直接放弃。`share/opto/loopTransform.cpp:1910`、`share/opto/loopTransform.cpp:1912`、`share/opto/loopTransform.cpp:1942`、`share/opto/loopTransform.cpp:1948`、`share/opto/loopTransform.cpp:1951`、`share/opto/loopTransform.cpp:1962`、`share/opto/loopTransform.cpp:1972`

所以三循环模型不是“为了代码看起来复杂”，而是把三种互相冲突的要求拆开：入口处理、主体吞吐、尾部完整性。

## loop predication：为什么要把逐次检查抬到入口

循环体里最常见的浪费之一，是每次迭代都做同一个可整体证明的检查。例如 `a[i]`、`a[i+1]`、`a[i+2]` 的边界检查，如果循环边界和数组长度已经足够明确，就不需要在每次迭代里重复验证。

`loop_predication_impl()` 只对满足条件的 loop 工作：必须启用 `UseLoopPredicate`，循环头必须是 LoopNode，正常 counted loop 还要满足测试方向等约束；iteration-split loop 和某些 strip-mined loop 会被跳过。`share/opto/loopPredicate.cpp:1329`、`share/opto/loopPredicate.cpp:1330`、`share/opto/loopPredicate.cpp:1332`、`share/opto/loopPredicate.cpp:1343`、`share/opto/loopPredicate.cpp:1347`、`share/opto/loopPredicate.cpp:1351`、`share/opto/loopPredicate.cpp:1352`

通过这些门槛后，C2 会在 loop entry 附近寻找或插入 predicate，把原本分散在循环体中的逐次条件，提升成一次性入口条件。条件成立时进入一个可以少做检查的主循环；不成立时则保留失败路径或去优化路径。

这不是简单地“删除 if”，而是把安全性证明从每次迭代搬到了整轮循环入口：**用一次整轮前提检查，换掉循环体里的重复检查。**

## SuperWord：向量化不是最后撒糖，而是循环整形的兑现

SuperWord 不会拿任意循环就开始找四条相邻指令。`SuperWord::transform_loop()` 首先检查架构是否有向量宽度，当前 loop 是否是有效 counted loop，是否已经完成必要的 unroll 分析，main-loop 的控制流是否足够简单，回边是否没有额外控制用户，以及 main-loop 是否能找到合适的 pre-loop end。`share/opto/superword.cpp:97`、`share/opto/superword.cpp:99`、`share/opto/superword.cpp:102`、`share/opto/superword.cpp:105`、`share/opto/superword.cpp:123`、`share/opto/superword.cpp:125`、`share/opto/superword.cpp:128`、`share/opto/superword.cpp:143`、`share/opto/superword.cpp:153`、`share/opto/superword.cpp:155`、`share/opto/superword.cpp:157`

这些门槛已经说明：**SuperWord 消费的是前面循环整形的结果，而不是原始循环。**

进入 `SLP_extract()` 后，它会依次：

- `construct_bb()` 把循环主体组织成可处理的 block；
- `dependence_graph()` 构建依赖图；
- 计算节点深度；
- 找相邻 memory references；
- 按相同 base、连续偏移和依赖关系扩展 pack；
- `combine_packs()` 合并并行 pack；
- 过滤不合格 pack；
- 最后 schedule。 `share/opto/superword.cpp:450`、`share/opto/superword.cpp:463`、`share/opto/superword.cpp:468`、`share/opto/superword.cpp:471`、`share/opto/superword.cpp:503`、`share/opto/superword.cpp:507`、`share/opto/superword.cpp:509`、`share/opto/superword.cpp:513`、`share/opto/superword.cpp:526`、`share/opto/superword.cpp:533`、`share/opto/superword.cpp:535`

因此向量化并不是“看到四个 AddI 就换成 AddVI”。它需要先证明：

- 四个操作来自同一个规律迭代；
- 地址访问相邻；
- memory dependence 允许并行；
- 主循环已经被展开到有足够相邻操作；
- 对齐和尾部处理已经有 pre/post loop 承担。

这就是为什么 SuperWord 是循环整形的最后兑现，而不是独立魔法。

## strip mining、pre/main/post、unroll：三个概念不能混在一起

pre/main/post 是为了把入口处理、主体吞吐和尾部迭代分开；unroll 是复制主循环体、调整步长与 limit；SuperWord 是在规则主循环中寻找可并行 pack。

strip mining 则是另一类结构：它通常在计数循环外再包一层，用于把主循环与 safepoint 轮询等运行时约束分开。它不是“主循环 + 尾标量循环”的别名，也不能拿 post-loop 的零头处理去解释 strip mining。

区分这几个概念非常重要，否则读者会把“向量宽度带来的尾部处理”“循环展开”“safepoint 外壳”误认为同一种拆分。

## 收网：循环优化先识别整轮规律，再把规律兑现成分期与向量

现在可以把整篇压成一张总图了。

C2 先用 `is_counted_loop()` 检查回边、比较、stride、limit 和控制流形状，只有能被描述成计数迭代的循环，才有资格进入完整待遇；`PhaseIdealLoop` 随后建立循环树、支配关系和节点控制位置，再由 `iteration_split_impl()` 根据剥皮、展开、RCE、对齐策略切成 pre/main/post；loop predication 把逐次检查提升为入口谓词；最后 SuperWord 在已经规则、展开、具备 pre-loop 前提的 main-loop 上做依赖分析、相邻引用发现、pack 合并和调度。`share/opto/loopnode.cpp:372`、`share/opto/loopnode.cpp:427`、`share/opto/loopnode.cpp:3111`、`share/opto/loopnode.cpp:3180`、`share/opto/loopTransform.cpp:3273`、`share/opto/loopTransform.cpp:3365`、`share/opto/loopPredicate.cpp:1329`、`share/opto/superword.cpp:97`、`share/opto/superword.cpp:450`

所以，本篇最核心的一句话不是“C2 会展开循环并做向量化”，而是：

**循环优化的核心是先把普通回边控制流识别成 CountedLoop，再把整轮迭代当作优化对象：分期、去检查、展开、对齐，最后才有资格向量化。**

下一篇进入 C2 的寄存器分配：循环和向量化已经把图变得更快、更宽，但最终仍然要把这些节点放进有限的物理寄存器里。

> → [15-c2-compiler/05 — `Chaitin`：图着色寄存器分配](05-c2-register-alloc.md)
