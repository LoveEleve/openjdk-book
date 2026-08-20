# 03. 为什么 C2 还要三套引擎？— `IGVN + CCP + Escape Analysis`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论 C2 优化中最关键的三套机制：IGVN、CCP、Escape Analysis，以及它们如何在 `Compile::Optimize` 中交错运行。LoopOpts 和 SuperWord 放到下一篇展开。
>
> **前置依赖**：[15-c2-compiler/01 — 为什么 C2 要换世界观？— `Ideal Graph = Node + Type + IGVN`](01-c2-ideal-graph.md)、[15-c2-compiler/02 — Ideal Graph 是怎么长出来的？— `Parse + GraphKit`](02-c2-parse-graphkit.md)、[12-ci/02 — `ciTypeFlow + BCEscapeAnalyzer`](../12-ci/02-ci-typeflow-escape.md)
> → **后续**：[15-c2-compiler/04 — `Loop Optimization + SuperWord`：循环变换与向量化](04-c2-loops.md)

上一篇我们把 Parse 和 GraphKit 讲完了：到 Parse 结束时，C2 手里已经有了一张 Ideal Graph，图上既有控制流、数据流、内存流，也带着 JVMState、异常边和 safepoint 状态。

看到这里，很容易冒出一个自然想法：既然图都有了，IGVN 也已经会做 `Ideal/Value/Identity`、类型传播和全局值编号，那后续优化是不是就交给 IGVN 一把梭就行了？

答案是否定的。

真正的问题是：**图上存在的“优化缺口”并不是一种。**

- 有些问题是局部图形和等价值复用，IGVN 最擅长；
- 有些问题是“这条控制流根本走不到”或“这个值其实恒定”，这需要 CCP 的乐观常量传播；
- 还有些问题是“这个对象其实可以不分配”，这属于 Escape Analysis 的对象去向证明。

也就是说，C2 不是缺一个更大的万能优化器，而是图上本来就有三类不同的信息缺口，需要三套互补机制分别去补。

更进一步说，这三者的地位还不完全对称：**CCP 和 Escape Analysis 更像专门负责产出新事实的引擎，而 IGVN 更像负责把这些新事实压回整张图、直到重新稳定下来的统一收敛器。**

先把这一句记住：**IGVN、CCP 和 Escape Analysis 不是三套并列的“再优化一遍”工具，而是分别解决局部形状、控制可达性/常量、对象逃逸三种不同问题。**

## 先试两个最自然的误解，看看为什么都不对

### 误解一：IGVN 已经很强了，它应该能一把梭搞定一切

这是一种很有诱惑力的想法。IGVN 既会图改写，又会类型传播，还会常量化和全局值编号，听起来几乎已经像个总管。

但 IGVN 的强项是：**围绕单个节点及其 def-use 邻域，看有没有局部图改写、类型变窄、值合并的机会。**

它并不天然回答另一些问题，比如：

- 一条 Region 之所以变死，不只是因为局部代数式，而是因为前面控制流上的某个条件被整体证明为常量；
- 一个对象能否彻底不分配，不只是看某个 `AllocateNode` 周边的小片段，而是要看整张图里谁引用了它、字段怎样传播、调用时如何逃逸。

这些都不是单个节点局部就能看穿的事实。它们需要另一套面向“可达性”和“对象去向”的分析模型。

### 误解二：CCP 和 EA 不过是在 IGVN 之后再跑一遍图优化

第二个误解正好走到另一个极端：既然 CCP 和 EA 也都在图上工作，那它们是不是只是在 IGVN 做完后再做一轮更专门的图清理？

这也不对。它们处理的问题维度完全不同。

CCP 的核心不是“再做一轮代数折叠”，而是**从控制流和类型角度，证明某些节点永远只能取一个值、某些 Region 根本不可达**。它盯的是“图上的哪些路径其实是假路”。

EA 的核心也不是“再看一遍节点值”，而是**把对象、局部变量、字段、调用关系重新投影成一张 ConnectionGraph，证明某个对象会不会逃出方法、会不会全局可见、会不会足够安全到能标量替换**。它盯的是“图上的哪些分配其实可以不存在”。

所以 CCP 和 EA 不是 IGVN 的重复劳动，而是分别给图补上了 IGVN 不擅长的两种事实：控制可达性，和对象去向。

## IGVN 的真实地位：它更像“统一收敛器”而不是三引擎之一

如果去看 `Compile::Optimize`，你会发现 IGVN 并不是在一个固定位置跑一次就结束，而是夹在多个阶段之间反复出现。

在 EA 路径里，`ConnectionGraph::do_analysis(this, &igvn)` 做完以后，马上又来一次 `igvn.optimize()`，用于把 EA 暴露出来的新常量、新别名关系和死边收敛进图。接着 `PhaseMacroExpand` 真正消掉宏节点后，又会再来一次 `igvn.optimize()`。之后进入 CCP，`PhaseCCP ccp(&igvn)` 先做乐观传播，随后 `igvn = ccp; igvn.optimize();` 再把 CCP 造成的常量化和不可达剪枝收敛回主图。`share/opto/compile.cpp:2308`、`share/opto/compile.cpp:2316`、`share/opto/compile.cpp:2321`、`share/opto/compile.cpp:2328`、`share/opto/compile.cpp:2332`、`share/opto/compile.cpp:2375`、`share/opto/compile.cpp:2376`、`share/opto/compile.cpp:2380`、`share/opto/compile.cpp:2388`、`share/opto/compile.cpp:2390`

这说明 IGVN 更像是一个**统一收敛器**：

- 某个专门分析器先注入新事实；
- IGVN 再把这些事实沿图传播，直到局部改写、值编号和类型变窄都稳定。

所以与其说“三引擎并列”，不如说：**两个专门引擎（CCP、EA）不断往图里喂新事实，而 IGVN 负责把这些事实真正消化成一张更小、更窄、更稳定的图。**

## CCP：为什么要从 `TOP` 出发做乐观前向传播

CCP（Conditional Constant Propagation）最容易被讲错的地方，是它到底从哪里开始、往哪个方向传播。

源码注释一开头就把算法来源点出来：Wegman & Zadeck 风格的 Conditional Constant Propagation。构造 `PhaseCCP` 时会清掉 IterGVN 的节点缓存，然后直接进入 `analyze()`。`share/opto/phaseX.cpp:1811`、`share/opto/phaseX.cpp:1812`、`share/opto/phaseX.cpp:1815`、`share/opto/phaseX.cpp:1817`

`analyze()` 的第一步不是把所有类型设成 `BOTTOM`，也不是从某个“已知常量节点”往回推，而是：**把所有节点类型先初始化成 `TOP`，然后从 root 开始前向 worklist 传播。** `share/opto/phaseX.cpp:1847`、`share/opto/phaseX.cpp:1848`、`share/opto/phaseX.cpp:1849`、`share/opto/phaseX.cpp:1854`、`share/opto/phaseX.cpp:1855`、`share/opto/phaseX.cpp:1859`

这正好揭示了 CCP 的乐观本质。它不是先假设“哪里都不通”，而是先假设“哪里都还可能通，值也都还可能宽”，然后一边通过 `Value()` 重新求节点类型，一边只要某个节点类型发生变化，就把用户继续压入 worklist。`share/opto/phaseX.cpp:1865`、`share/opto/phaseX.cpp:1866`、`share/opto/phaseX.cpp:1875`、`share/opto/phaseX.cpp:1876`、`share/opto/phaseX.cpp:1901`

而且 CCP 要求传播单调：源码里的 `ccp_type_widens` 断言就是在保护“类型只能 widen，不可来回震荡”。也就是说，它是靠单调增广事实来收敛，而不是靠来回试探。`share/opto/phaseX.cpp:1830`、`share/opto/phaseX.cpp:1831`

这和 IGVN 很不一样。IGVN 更像基于当前输入类型做“悲观精化”；CCP 则是从 `TOP` 出发，用乐观可达性视角去证明哪些东西其实更具体、更单一。

## CCP 真正消掉的，不是代数式，而是“根本走不到”的图

如果把 CCP 只理解成“多做一点常量折叠”，就低估它了。

真正的关键在 `transform_once()`。它当然会把 singleton 类型换成常量节点，但更重要的是：**当一个 Region 的类型变成 `TOP`，它会被当作不可达 region 直接切掉，自引用先断开，再把死 Phi 急切地替换成 top。** `share/opto/phaseX.cpp:2043`、`share/opto/phaseX.cpp:2045`、`share/opto/phaseX.cpp:2056`、`share/opto/phaseX.cpp:2057`、`share/opto/phaseX.cpp:2060`、`share/opto/phaseX.cpp:2062`、`share/opto/phaseX.cpp:2068`、`share/opto/phaseX.cpp:2071`、`share/opto/phaseX.cpp:2083`

这就是 CCP 和 IGVN 的职责边界最清楚的一幕：

- IGVN 更擅长说“这个节点和另一个节点等价”“这个节点类型变窄了”“这个节点可以常量化”；
- CCP 则特别擅长说“沿着当前控制与类型事实，这一整块 region 根本不可达了”。

因此 CCP 的价值并不在于把 `x+0` 再消一遍，而在于把**控制流假路**整个剪掉，让后面的图规模和推理空间一起缩小。

## Escape Analysis：为什么对象去向不是 IGVN/CCP 能单独推出来的

对象逃不逃逸，是另一类完全不同的问题。

IGVN 看到的是节点局部关系，CCP 看到的是常量和可达性，而 EA 需要回答的是：**这个对象是谁引用了它、它的字段又指向谁、它作为参数传进调用后会不会变成外部可见、最终它到底是 NoEscape、ArgEscape 还是 GlobalEscape。**

这就是为什么 C2 为 EA 单独造了一张 ConnectionGraph。源码注释把这张图的节点类型和边语义写得很清楚：JavaObject、LocalVar、Field 这些点之间会连出 `LV -P> JO`、`OF -P> JO`、`JO -F> OF` 这样的边，再沿这些边传播逃逸状态。`share/opto/escape.hpp:85`、`share/opto/escape.hpp:100`、`share/opto/escape.hpp:104`、`share/opto/escape.hpp:105`、`share/opto/escape.hpp:106`、`share/opto/escape.hpp:108`、`share/opto/escape.hpp:109`

`EscapeState` 自己也已经说明了分层：

- `NoEscape`：对象不逃出方法或线程，理论上可以标量替换；
- `ArgEscape`：对象作为参数传到调用，但不全局逃逸；
- `GlobalEscape`：对象最终全局可见。 `share/opto/escape.hpp:153`、`share/opto/escape.hpp:155`、`share/opto/escape.hpp:157`、`share/opto/escape.hpp:160`

这正说明 EA 不是在看“某个 AllocateNode 周围能不能局部化简”，而是在整张对象引用图上证明“这个分配的生存边界到底在哪里”。换句话说，CCP 补的是“这条路径到底通不通”的缺口，而 EA 补的是“这个对象最终会不会跑出去”的缺口。两者都不是 IGVN 本身能凭节点局部形状直接看穿的事实。

## ConnectionGraph 的核心流程：先构图，再传播，再筛可标量替换对象

`compute_escape()` 把这件事拆成非常清楚的五步。

第一步是建图。它从 root 出发遍历 ideal nodes，为每个相关 ideal 节点建立 `PointsToNode`，并把它们收进不同 worklist：ptnodes、java objects、non-escaped candidates、oop fields、arraycopy 等。`share/opto/escape.cpp:118`、`share/opto/escape.cpp:122`、`share/opto/escape.cpp:136`、`share/opto/escape.cpp:139`、`share/opto/escape.cpp:148`、`share/opto/escape.cpp:152`、`share/opto/escape.cpp:153`、`share/opto/escape.cpp:156`、`share/opto/escape.cpp:158`

第二步是补 deferred edges，再把整张图传播完整。真正的传播动作在 `complete_connection_graph(...)` 里：全局逃逸的东西继续把它能指到的东西也标成全局逃逸，`ArgEscape` 也沿边继续扩散。`share/opto/escape.cpp:202`、`share/opto/escape.cpp:203`、`share/opto/escape.cpp:205`、`share/opto/escape.cpp:231`、`share/opto/escape.cpp:233`

第三步才是很多人最容易跳得太快的地方：`NoEscape` 还不等于“已经可标量替换”。源码会再跑 `adjust_scalar_replaceable_state()`，把那些虽然不逃逸、但仍然不适合被拆成标量的对象排除掉，再把真正的候选分配压进 `alloc_worklist`。`share/opto/escape.cpp:240`、`share/opto/escape.cpp:247`、`share/opto/escape.cpp:248`、`share/opto/escape.cpp:256`、`share/opto/escape.cpp:257`、`share/opto/escape.cpp:273`、`share/opto/escape.cpp:274`

第四步是基于 EA 信息做图级优化，比如指针比较和内存屏障的局部改善。第五步才是在 alias level 足够高、允许 `EliminateAllocations` 时，通过 `split_unique_types()` 为可标量替换对象拆分独占内存切片。`share/opto/escape.cpp:295`、`share/opto/escape.cpp:298`、`share/opto/escape.cpp:319`、`share/opto/escape.cpp:320`、`share/opto/escape.cpp:324`

这条链路特别能说明：EA 不是“找到一个不逃逸分配，然后当场把它删了”。它真正干的是先证明，再筛候选，再准备足够精细的内存图条件，给后面真正删除分配的阶段铺路。

## EA 不是最后一刀：真正删除分配发生在 `PhaseMacroExpand`

这又是另一个特别容易讲错的点。很多人把 EA 直接等同于“分配消除”，好像 `compute_escape()` 一旦算出 `NoEscape`，对象就已经不分配了。

源码并不是这样组织的。

`Compile::Optimize` 里，EA 分析完成后会先 `igvn.optimize()` 收敛图，再进入 `PhaseMacroExpand mexp(igvn); mexp.eliminate_macro_nodes();`。也就是说，EA 只是先把“这个宏节点是否可消”这件事证明出来，真正的删除动作在 macro expand 阶段完成。`share/opto/compile.cpp:2316`、`share/opto/compile.cpp:2321`、`share/opto/compile.cpp:2328`、`share/opto/compile.cpp:2329`、`share/opto/compile.cpp:2332`

`eliminate_allocate_node()` 的几道门也写得很明白：

- 必须开 `EliminateAllocations`；
- JVMTI `can_pop_frame()` 不能妨碍；
- 该分配必须 `_is_non_escaping`；
- 如果不是 scalar replaceable，还得满足额外条件；
- 还要通过 `can_eliminate_allocation()` 对 safepoint/debug info 的检查；
- 之后才会进入 `scalar_replacement()` 和 `process_users_of_allocation()`。 `share/opto/macro.cpp:1091`、`share/opto/macro.cpp:1096`、`share/opto/macro.cpp:1099`、`share/opto/macro.cpp:1107`、`share/opto/macro.cpp:1113`、`share/opto/macro.cpp:1128`、`share/opto/macro.cpp:1144`

所以最该记住的边界是：**EA 负责证明“可以消”，MacroExpand 负责真正“把它消掉”。**

这条边界一旦讲清，`NoEscape != 一定被删`、`NoEscape != scalar_replaceable` 这两个容易混淆的点也就顺带清了。

## 把三件事收回到同一个闭环：局部形状、控制可达性、对象去向

现在终于可以把 IGVN、CCP 和 EA 收成同一个优化闭环了。

- IGVN 擅长的是节点局部形状、类型变窄、常量化与值合并；
- CCP 擅长的是把“控制流哪边其实不可能发生”“哪块 Region 根本不可达”这种事实推过整图；
- EA 擅长的是把“这个对象其实可以不存在”这种对象去向结论证明出来。

这三者之间并不是并排工作，而是互相喂数据：

- CCP 切掉不可达控制流后，IGVN 才能继续把死 Phi、死 Region 和新暴露的常量收掉；
- EA 调整内存图和对象候选后，IGVN 又会把新形状、新常量、新等价值关系再收敛一轮；
- MacroExpand 真删掉分配以后，IGVN 还得再回来把这波删除的后效应传播完。

把它压成一个更具体的时序，就是：**专门引擎先产出新事实，IGVN 先收一轮；当 EA 的结论足够强时，MacroExpand 再真正落刀删除宏节点；删除之后图形再次变化，于是 IGVN 再回来把残留传播完。** 这就是为什么 C2 的优化图景更像闭环系统，而不是“一串各自跑一次的 pass”。

## 收网：C2 不是一个万能优化器，而是三套互补引擎 + 一个统一收敛器

现在可以把整篇压成一张总图了。

Ideal Graph 建好以后，C2 并没有交给某个单一“万能优化器”去做一切。它把图上的优化缺口拆成了三类：局部图形和值等价问题交给 IGVN，控制可达性和常量事实交给 CCP，对象去向与分配可消性交给 Escape Analysis。然后又让 IGVN 在这些阶段之间反复回来，持续把新事实收敛进图；最后再由 MacroExpand 把 EA 证明过的分配和宏节点真正消掉。`share/opto/compile.cpp:2308`、`share/opto/compile.cpp:2316`、`share/opto/compile.cpp:2321`、`share/opto/compile.cpp:2328`、`share/opto/compile.cpp:2375`、`share/opto/compile.cpp:2376`、`share/opto/compile.cpp:2380`、`share/opto/compile.cpp:2388`

所以，这一篇最核心的一句话不是“C2 有 IGVN、CCP 和 EA 三种优化”，而是：

**C2 之所以不是一个万能优化器，是因为图上本来就有三种不同缺口：局部形状、控制可达性、对象去向；三套引擎分别补洞，而 IGVN 负责把它们补出来的新事实统一收敛。**

只要这句抓住了，下一篇循环优化和 SuperWord 就好理解了：那已经不是“图能不能更小”的问题，而是“图已经足够稳定之后，循环和向量这类结构性机会还能不能再榨一层”的问题。

> → [15-c2-compiler/04 — `Loop Optimization + SuperWord`：循环变换与向量化](04-c2-loops.md)
