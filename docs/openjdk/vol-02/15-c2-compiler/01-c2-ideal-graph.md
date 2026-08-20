# 01. 为什么 C2 要换世界观？— `Ideal Graph = Node + Type + IGVN`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 C2 最核心的三件基础设施：`Node`、`Type` 和 `IGVN`。它们共同决定了 C2 为什么不用 C1 那套“块 + 指令”的世界，而是先把程序表示换成一张统一图。Parse/GraphKit 如何逐字节码建这张图，放到下一篇展开。
>
> **前置依赖**：[14-c1-compiler/04 — C1 机器码怎么安全“逃生”？— `Runtime1 + FrameMap + OopMap`](../14-c1-compiler/04-c1-runtime-frame.md)、[13-jit-framework/01 — `CompileBroker` 编译队列](../13-jit-framework/01-compile-broker-queue.md)、[12-ci/01 — `ciObject` 镜像体系](../12-ci/01-ci-overview-mirror.md)
> → **后续**：[15-c2-compiler/02 — `Parse + GraphKit`：字节码→Ideal Graph](02-c2-parse-graphkit.md)

前面整整一个 C1 域，我们都在强调同一件事：C1 追求的是低延迟，所以它选择块式 HIR、轻量优化、LinearScan 和 Runtime1 这种“够用就好”的编译组织方式。

到了 C2，这套世界观突然就不够了。

C1 当然也有图，也有 Phi，也能跨块传播值，但它的基本组织单元依然是“基本块里的一串指令”。这很适合快编译，却天然不擅长把控制流、数据流、内存依赖和类型传播揉成一个统一的优化问题。

于是 C2 干脆先做了一件更激进的事：**不是在 C1 的块式 IR 上再多加几趟 pass，而是先把程序表示整个换掉。**

它换成了什么？一张图：

- 每个操作是一个 `Node`；
- 控制流、数据流、内存流都变成边；
- 每个节点再顶着一个 `Type`，表示“这个节点在运行期可能取哪些值”；
- 然后由 `IGVN` 沿着图的 def-use 关系和类型信息，反复做图改写、类型收窄、常量化和全局值编号，直到整张图稳定。

所以，本篇真正要回答的问题不是“`Node` 有哪些字段”，也不是“`Type` 有什么子类”，而是：

**为什么 C2 需要先换成一张统一图，再让 `Node + Type + IGVN` 互相推动，才能把优化真正推到全局？**

先把答案压成一句人话：**C2 的关键变化不是“优化更多”，而是“先换世界观”——控制、数据和内存都画成图边；节点的可能取值都刻进类型格；然后用 worklist 驱动的 IGVN，让每一次局部改写都沿图自动传播，直到整张图不再有新变化。**

## 先试两个最自然的理解，看看为什么都不对

### 误解一：C2 只是“更猛的 C1”

这是最常见的第一反应。既然 C1 已经能把字节码变成 HIR、做一些优化，再发机器码，那 C2 会不会只是“把同样的事情做得更深、更久、更聪明”？

这只说对了一半。C2 确实更愿意花时间做深度优化，但它真正的根变化不是“优化力度”，而是**程序表示本身**。

在 C1 世界里，虽然值之间也能引用，块头也有 Phi，但控制流仍然主要通过基本块边界组织，指令天然被塞在块里。跨块优化要么靠 Phi，要么靠额外数据流分析 pass，把信息在块之间搬来搬去。

C2 则更进一步：它不再把“控制流、数据流、内存流”拆开给不同结构管理，而是直接塞进同一张图。这样一来，一个节点只要被改写，所有使用它的地方天然就能沿 def-use 边被找到；一个类型一旦变窄，也会直接影响依赖它的消费者节点。

所以 C2 不是“在 C1 世界里做更多”，而是**先把世界搭成一个更适合全局传播的形状。**

### 误解二：IGVN 不就是“多跑几遍 Canonicalizer”吗

第二个误解也很常见。看到 C2 里有 `Ideal`、`Identity`、常量折叠、全局值编号，很多人会下意识把它想成“比 C1 多几趟、更强一点的规范化”。

问题在于，C1 大量优化仍然是“固定位置发生一次”或“固定趟次跑一遍”。而 IGVN 不是固定次数的 pass，它是一套**会被图变化重新激活的传播机制**。

一个节点的 `Ideal()` 改写可能让用户节点暴露出新的常量；一个节点 `Value()` 算出的类型一旦变窄，又会让更多比较、分支、Phi 和内存节点变得可化简；全局值编号把两个等价节点并掉后，它们的用户又会重新排队再看一遍。

也就是说，IGVN 真正重要的不是“它会做哪些规则”，而是：**图一旦有局部变化，它会沿依赖边把影响继续推下去，直到没有节点再能从别人的变化中获益。**

这和“多跑几遍固定 pass”是两种完全不同的工作方式。

## `Node`：为什么 C2 要把控制、数据和内存都画成边

C2 先换掉的，是程序的形状。

`Node` 最核心的两个字段是 `_in` 和 `_out`。源码注释写得非常直接：`_in` 是 use-def 引用数组，`_out` 是 def-use 引用数组。也就是说，一个节点既知道“我依赖谁”，也知道“谁依赖我”。`share/opto/node.hpp:282`、`share/opto/node.hpp:283`

更重要的是，输入边还分成两类：required edges 和 precedence edges。required edges 是语义正确性必须要有的输入，顺序有意义，也允许 `NULL`；precedence edges 则主要帮助决定执行顺序，不允许重复和内嵌 `NULL`。`share/opto/node.hpp:285`、`share/opto/node.hpp:286`、`share/opto/node.hpp:287`、`share/opto/node.hpp:289`、`share/opto/node.hpp:291`

这套设计的关键在于：**控制、数据和内存，不再靠不同数据结构分头维护，而是统一编码在节点输入边的位置约定里。**

这也是为什么一个普通算术节点和一个内存节点的 `in(i)` 语义完全不同。纯算术节点往往可以没有真实控制输入，于是 `in(0)` 可能是 `NULL`，表示它可以在图里浮动；内存节点则会明确有控制、内存和地址槽位。这样，优化器面对的是一张统一的图，而不是一堆“这个 pass 看基本块、那个 pass 看内存表、另一个 pass 看 def-use 链”的分裂世界。

`Node` 的寿命管理也呼应了这张图的规模。它们统一从 `Compile::current()->node_arena()` 分配，`operator delete` 是 NOP。也就是说，C2 根本没打算让节点各自做细粒度释放；它依赖的是 Arena 批量回收，而死节点清理由优化阶段在图逻辑上处理。`share/opto/node.hpp:231`、`share/opto/node.hpp:232`、`share/opto/node.hpp:233`、`share/opto/node.hpp:237`、`share/opto/node.hpp:238`

这一步非常值得停下来记一句：**C2 的“图”不是一张画出来方便看的草图，而是它真正的程序表示与优化工作面。**

## `Node` 不是被动数据结构：`Identity / Value / Ideal` 三钩子决定它如何参与优化

C2 里每个节点都不是“等着 pass 来改”的被动物体。`Node` 基类直接定义了三个统一钩子：

- `Identity(PhaseGVN*)`
- `Value(PhaseGVN*)`
- `Ideal(PhaseGVN*, bool can_reshape)` `share/opto/node.cpp:1081`、`share/opto/node.cpp:1087`、`share/opto/node.cpp:1144`

默认行为本身就很有意思：

- `Identity()` 默认返回 `this`，表示“没找到更好的既有节点”；
- `Value()` 默认返回 `bottom_type()`，也就是最坏情况类型；
- `Ideal()` 默认返回 `NULL`，表示“这节点已经够理想了，没有图改写”。 `share/opto/node.cpp:1081`、`share/opto/node.cpp:1082`、`share/opto/node.cpp:1087`、`share/opto/node.cpp:1088`、`share/opto/node.cpp:1144`、`share/opto/node.cpp:1145`

这三个钩子之所以重要，是因为它们把三类完全不同的优化动作拆开了：

- `Identity` 负责说“我其实等价于某个已有节点”；
- `Value` 负责说“如果看我的输入类型，我运行时可能值的集合更精确了”；
- `Ideal` 负责说“我可以把自己或周围子图重写成更好的形状”。

尤其是 `Ideal()` 的返回值契约，非常容易被误解。源码注释写得极细：

- 只要做了任何图改写，就必须返回改写后子图的根，即使根还是 `this`；
- 不能从 `Ideal()` 返回一个“旧节点”，想返回旧节点要走 `Identity()`；
- 除了 `this` 指针本身，不能去修改旧节点，因为旧节点可能被别的用户共享。 `share/opto/node.cpp:1095`、`share/opto/node.cpp:1100`、`share/opto/node.cpp:1101`、`share/opto/node.cpp:1106`、`share/opto/node.cpp:1107`、`share/opto/node.cpp:1112`、`share/opto/node.cpp:1113`、`share/opto/node.cpp:1118`

这里最该记住的不是规则条文本身，而是它揭示了 C2 的工作方式：**节点优化不是一个 pass 拿着剪刀在外面乱改图，而是每个节点自己暴露“我能否折叠、能否变窄、能否重写”的统一接口。**

## `Type`：为什么 C2 必须把“可能值集合”刻在图上

光有节点和边还不够。优化器还必须知道：某个节点在运行时可能取什么值。

C2 用 `Type` 做这件事。`Type` 不是“调试信息里的类型注释”，而是一套真正参与优化的格。基类直接提供 `meet`、`join`、`dual` 和它们的辅助函数。`share/opto/type.hpp:224`、`share/opto/type.hpp:228`、`share/opto/type.hpp:236`、`share/opto/type.hpp:240`、`share/opto/type.hpp:247`

对整数区间来说，`TypeInt::xmeet()` 会把两个区间扩成能同时覆盖二者的最小大区间。比如 `[0,10]` 和 `[5,15]` meet 之后得到 `[0,15]`。这不是“求交集”，而是为了给 Phi 和其他合流节点一份同时覆盖多条路径的安全上界。`share/opto/type.cpp:1455`、`share/opto/type.cpp:1457`、`share/opto/type.cpp:1487`、`share/opto/type.cpp:1488`、`share/opto/type.cpp:1489`

`dual()` 则把类型绕格的中心翻过去。对区间型来说，就是反转上下界。这个操作不是炫技，它是 `join` 构造方式的一部分：C2 借助对偶让格在上下两个方向都保持对称。`share/opto/type.hpp:236`、`share/opto/type.hpp:237`、`share/opto/type.cpp:1492`、`share/opto/type.cpp:1494`、`share/opto/type.cpp:1495`

指针类型的地方更能看出格为什么重要。`TypePtr::ptr_meet` 那张表里，`Null` 和 `NotNull` 的 meet 不是“丢掉 null 信息”，而是直接变成 `BotPTR`。也就是说，**“既是 null 又非 null”在格里代表矛盾，不是模糊。** `share/opto/type.cpp:2460`、`share/opto/type.cpp:2465`、`share/opto/type.cpp:2466`

这条语义特别关键，因为它正是 C2 能把某些路径判死、把某些空检查彻底消掉的基础。只有当“类型矛盾”在格里真的是底，而不是“我不确定”，图上的死路才能被真正收缩掉。

所以 `Type` 的本质不是“给节点贴标签”，而是：**把节点运行时可能值的集合刻进图里，让结构改写和类型收窄能够互相喂养。**

## IGVN：为什么必须迭代到不动点，而不是跑固定几趟

有了 `Node` 和 `Type`，最后的问题就是：谁来驱动它们互相传播？答案就是 `PhaseIterGVN`。

它最核心的动作都在 `transform_old()` 里。整段流程可以压成五步：

1. 反复跑 `Ideal()`，直到这个节点的图改写不再继续；
2. 调 `Value()` 重新计算节点类型，如果类型变了，就把用户重新入队；
3. 如果类型已经精确到 singleton，就直接常量化；
4. 再试 `Identity()`，看看是否等价于已有节点；
5. 最后做 `hash_find_insert()`，执行全局值编号。 `share/opto/phaseX.cpp:1283`、`share/opto/phaseX.cpp:1293`、`share/opto/phaseX.cpp:1298`、`share/opto/phaseX.cpp:1320`、`share/opto/phaseX.cpp:1328`、`share/opto/phaseX.cpp:1353`、`share/opto/phaseX.cpp:1361`、`share/opto/phaseX.cpp:1366`、`share/opto/phaseX.cpp:1373`、`share/opto/phaseX.cpp:1381`、`share/opto/phaseX.cpp:1390`

整段最关键的不是“它做了这五件事”，而是每一步几乎都会把旧节点的用户重新放回 worklist。也就是说，**一个节点的局部变化不会停在自己身上，而会沿 def-use 边继续逼着整张图重新考虑。**

这就是为什么 IGVN 不能用“固定跑三趟”“固定跑五趟”来替代。因为你根本不知道一次局部改写最终会触发多少层后续变化：

- 图改写可能暴露新的常量；
- 类型变窄可能让别的 `If` 或 `Phi` 可折叠；
- 常量化又可能触发新的 `Identity` 或 hash CSE；
- 两个节点一旦被 `subsume_node` 合并，它们所有用户都得重新审视。

只有“不停迭代直到没有新变化”这一种组织方式，才能匹配这类互相咬合的传播。

## 这不是“全图反复扫描”：IGVN 的效率来自 worklist 稀疏传播

看到“不动点迭代”，很容易以为 C2 在做的是“全图一遍遍重扫”。如果真这样，它早就慢得不可接受了。

C2 真实做法更稀疏。`Compile` 在 parse 期就准备了一份 `_for_igvn` 初始 worklist，注释直接说了：这是 Iterative GVN 的起始节点列表。`record_for_igvn()` 本身也只是把节点 push 进这张表。`share/opto/compile.cpp:757`、`share/opto/compile.cpp:758`、`share/opto/compile.cpp:759`、`share/opto/node.hpp:1574`、`share/opto/node.hpp:1575`、`share/opto/node.hpp:1576`

真正运行时，`optimize()` 只是不断从 `_worklist` 里弹出节点：

- 若节点还有用户，就对它做 `transform_old()`；
- 若它已经没用户且不是 top，就把它当死节点清掉；
- 同时用节点数上限和 `K * live_nodes()` 这种守卫防止优化发散。 `share/opto/phaseX.cpp:1223`、`share/opto/phaseX.cpp:1228`、`share/opto/phaseX.cpp:1230`、`share/opto/phaseX.cpp:1231`、`share/opto/phaseX.cpp:1234`、`share/opto/phaseX.cpp:1235`、`share/opto/phaseX.cpp:1241`、`share/opto/phaseX.cpp:1244`、`share/opto/phaseX.cpp:1246`、`share/opto/phaseX.cpp:1247`

也就是说，C2 真正追求的不是“让所有节点每轮都重新思考”，而是“只让那些被变化波及到的节点重新思考”。

这正是 Ideal Graph 统一 def-use 边的巨大收益之一：你不需要猜哪些节点可能被影响，边本身就把传播路径暴露出来了。

## 把三件事收回到同一个闭环：Node 给路径，Type 给精度，IGVN 给传播机制

现在终于可以把 `Node`、`Type` 和 `IGVN` 收成一条主线了。

- 没有 `Node` 统一控制、数据和内存边，局部改写就难以自然波及全图；
- 没有 `Type` 格，节点就不知道自己运行时可能值的集合，也就无法因为类型变窄而继续剪枝、常量化或判死路径；
- 没有 IGVN 的 worklist 传播机制，这些局部变化也很难真正迭代到全局稳定。

这三者合起来，才形成 C2 的核心闭环：

1. 某个节点先因为 `Ideal()` 重写了；
2. 用户节点被入队，再次检查；
3. `Value()` 算出的类型更窄；
4. 类型变窄又触发更多常量化、分支剪死或值合并；
5. 图继续收缩，直到没有节点再能从别人的变化中获益。

这就是 C2 和 C1 最本质的分水岭：**C1 更像一条固定次序的前端流水线，C2 更像一套围绕统一图与类型反复收敛的全局传播系统。**

## 收网：C2 不是“更多 pass”，而是“统一图 + 类型 + 不动点迭代”

现在可以把整篇压成一张总图了。

C2 之所以不沿着 C1 的块式 HIR 继续增强，不是因为后者完全不行，而是因为它不够适合作为全局传播的工作面。C2 干脆把程序先换成一张统一的 Ideal Graph：`Node` 用 `_in/_out` 把控制流、数据流和内存流织在一起；`Type` 把每个节点可能取值的集合刻在图上；`IGVN` 再围绕这张图，用 `Ideal/Value/Identity` 加上 hash CSE 和 worklist，把局部改写持续传播到全局，直到整张图不再变化。`share/opto/node.hpp:282`、`share/opto/node.cpp:1081`、`share/opto/type.hpp:224`、`share/opto/type.cpp:1455`、`share/opto/type.cpp:2460`、`share/opto/phaseX.cpp:1223`、`share/opto/phaseX.cpp:1283`、`share/opto/compile.cpp:757`

所以，这一篇最核心的一句话不是“C2 有 Node、Type 和 IGVN”，而是：

**C2 不是在 C1 的世界里多加几趟优化，而是先换成一张统一图，再让类型精度和 worklist 迭代把优化推到全局不动点。**

只要这句抓住了，下一篇 `Parse + GraphKit` 就好理解了：既然 C2 的世界观已经是这么一张图，那字节码到底是怎么一条条被灌进这张 Ideal Graph 里的，才是下一步真正该追的问题。

> → [15-c2-compiler/02 — `Parse + GraphKit`：字节码→Ideal Graph](02-c2-parse-graphkit.md)
