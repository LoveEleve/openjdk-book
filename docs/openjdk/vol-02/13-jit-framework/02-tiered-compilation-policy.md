# 02. 为什么先 C1 再 C2？— `TieredThresholdPolicy` 5 层编译策略

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 tiered compilation 的策略脑：`TieredThresholdPolicy` 如何根据调用计数、回边计数、profile 成熟度、编译器负载和 CodeCache 压力，决定方法的下一跳编译层级。C1/C2 管线本身不在本文展开。
>
> **前置依赖**：[13-jit-framework/01 — 谁决定编译、怎么排队、谁执行？— `CompileBroker` 编译队列](01-compile-broker-queue.md)、[08-interpreter/03 — 解释器怎么安全地调 C++？— `InterpreterRuntime`](../08-interpreter/03-interpreter-runtime.md)、[12-ci/02 — 编译器怎么知道“类型”与“逃逸”？— `ciTypeFlow + BCEscapeAnalyzer`](../12-ci/02-ci-typeflow-escape.md)
> → **后续**：[14-c1-compiler/01 — C1 管线 + HIR — 字节码→编译图](../14-c1-compiler/01-c1-pipeline-ir.md)

上一篇我们已经把 broker 这条异步流水线拆开了：解释器和策略层生产“编译意愿”，`CompileBroker` 把它变成任务，编译线程异步消费。

但 broker 其实故意不回答一个更关键的问题：**为什么这个方法这次该上 level 3，而不是 level 2？为什么有时先 OSR 再补普通编译？为什么有些方法直接到 level 1，另一些却从解释器直接跳到 level 4？**

这些问题都属于 `TieredThresholdPolicy`。

如果只看表面，tiered compilation 很容易被想成一条整齐的楼梯：解释器是 0，接着 1、2、3，最后 4，方法够热就顺着一级级往上爬。但真实实现并不是一条固定台阶，而是一套不断在四件事之间找平衡的动态决策系统：

- 尽快让热点跑上机器码，不要让启动期全堵在解释器；
- 尽快但不过量地收集 profile；
- 别让慢编译器队列堵死，导致方法长时间泡在又慢又重的 profiling 代码里；
- 别让 CodeCache 压力把整套系统拖垮。

所以，本篇真正该记住的一句话不是“tiered 有 5 层”，而是：

**`TieredThresholdPolicy` 的本质不是安排固定阶梯，而是在每次事件发生时，动态回答“此刻最划算的下一跳是什么”。**

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：既然 C2 最强，那热点直接上 C2 不就完了？

这听起来特别合理。既然 C2 产出的代码通常最好，那何必要绕一圈 C1？方法一热，直接交给最终优化器，不就省掉中间状态了？

问题在于，C2 的“好”是以“慢”为代价的。它擅长做深优化，但并不擅长在方法刚刚变热、profile 还不成熟的时候立刻给系统一份低延迟反馈。如果所有热点一开始都直奔 C2，应用在预热阶段会把大量时间花在等慢编译器出结果上。

更糟的是，C2 做得好的很多优化本来就依赖 profile。没有足够调用频率、类型分布和分支行为数据，C2 要么拿不到该有的信息，要么只能基于更保守的前提工作。这样一来，既慢，还不一定马上值回票价。

这就是为什么 tiered compilation 的第一目标不是“尽快把所有热点都升级到最强优化器”，而是“尽快让热点离开解释器，同时把 profile 慢慢攒够”。

### 朴素方案二：那就老老实实 0→1→2→3→4 一层层爬

如果直接上 C2 太激进，另一个自然想法就是严格分层：解释器先到 1，再到 2，再到 3，最后 4。这样看起来既渐进，又有条理。

可真实方法并不需要同一条升级路径。

有些方法非常 trivial，比如 accessor、constant getter。这类方法即便交给 C2，也未必能比一个轻量 C1 版本好多少，却要付出更高的编译成本。对它们来说，“纯 C1 结束”反而就是最划算的终点。

另一些方法并不需要先经过 1。因为 level 1 的特点不是“所有方法的第一站”，而是“没有 profile 的纯 C1 代码”。普通热点方法如果真正目标是收集 profile，再逐层通向 C2，那么从解释器直接去 level 3，往往比机械踩过 1 和 2 更划算。

还有些时候，系统甚至会因为 C2 队列太长，故意让方法先去 level 2，而不是 level 3。也就是说，层级迁移不仅取决于“这个方法有多热”，还取决于“当前编译系统有多忙”。

所以“严格爬楼梯”这条路看起来有秩序，实际上会让 trivial 方法、热点方法、OSR 场景和负载反馈全都被同一条僵硬路径绑死。

到这里先立一个路标：这一篇真正要追的，不是“每层名字叫什么”，而是“为什么不同方法、不同事件、不同系统负载下，下一跳会不同”。

## 五层都是什么，但 1 并不是“常规第一站”

先把地形图摆清楚。HotSpot 的 `CompLevel` 定义了五个层级：

- `0`：解释器；
- `1`：纯 C1；
- `2`：C1 + 调用/回边计数；
- `3`：C1 + 完整 profiling；
- `4`：C2 或 JVMCI 的 full optimization。

现稿里已经引用了这组枚举，最重要的是要把它们的语义拆开：`1`、`2`、`3` 都属于 C1 世界，但收集信息的丰富程度不同；`4` 才是“慢但强”的最终优化层。

真正容易被讲错的是 `1`。它并不是“所有方法从解释器出来后自然先踩一下的第一级台阶”。`TieredThresholdPolicy::is_trivial()` 明确把 accessor 和 constant getter 当作 trivial 方法，而 `common()` 一开头就对 trivial 方法直接给出 `CompLevel_simple`。也就是说，level 1 更像一种**特例终点**，而不是通用第一站。`share/runtime/tieredThresholdPolicy.cpp:82`、`share/runtime/tieredThresholdPolicy.cpp:84`、`share/runtime/tieredThresholdPolicy.cpp:85`、`share/runtime/tieredThresholdPolicy.cpp:86`、`share/runtime/tieredThresholdPolicy.cpp:720`、`share/runtime/tieredThresholdPolicy.cpp:721`

这一步非常关键。因为一旦把 level 1 误解成“所有方法都会先到的一级”，后面所有路径都会被读偏。真实世界里，最常见的普通热点路径根本不是 `0→1→2→3→4`。

## 真正的核心在 `common()`：它决定的不是“下一层”，而是“下一跳”

`TieredThresholdPolicy` 里最该记住的函数不是某个具体阈值判断，而是 `common()`。头文件已经把它定位得很清楚：给定一个 predicate，决定一个方法是否应该迁移到另一个 level。也就是说，它不是死板楼梯，而是通用状态转移函数。`share/runtime/tieredThresholdPolicy.hpp:173`、`share/runtime/tieredThresholdPolicy.hpp:176`、`share/runtime/tieredThresholdPolicy.hpp:179`、`share/runtime/tieredThresholdPolicy.hpp:180`

而源码里紧贴着 `common()` 的那段大注释，实际上就是 tiered policy 的总路线图。最重要的几条路径是：

- `0 -> 3 -> 4`：最常见路径；
- `0 -> 2 -> 3 -> 4`：C2 队列太忙，先 limited profile；
- `0 -> (3 -> 2) -> 4`：任务还在队列里时又因为负载反馈降回 2；
- `0 -> 3 -> 1` 或 `0 -> 2 -> 1`：方法后来被识别为 trivial，或者 C2 编不了但 C1 还能编；
- `0 -> 4`：有时不需要重新 profile，或者 C1 失败。 `share/runtime/tieredThresholdPolicy.cpp:676`、`share/runtime/tieredThresholdPolicy.cpp:684`、`share/runtime/tieredThresholdPolicy.cpp:685`、`share/runtime/tieredThresholdPolicy.cpp:689`、`share/runtime/tieredThresholdPolicy.cpp:694`、`share/runtime/tieredThresholdPolicy.cpp:700`、`share/runtime/tieredThresholdPolicy.cpp:704`

这张图本身就已经击穿了“固定爬楼梯”的误解：HotSpot 不是在顺序走 1/2/3/4，而是在不同上下文下选不同下一跳。

`common()` 里最经典的一段是从 `CompLevel_none` 出发的分支。它先递归问一个问题：**如果当前方法已经在 full-profile 层，是否会直接跳到 full optimization？** 如果答案是会，那当前解释器方法也可以直接把下一跳定成 4；否则再看当前的调用/回边计数有没有达到阈值。若达到了，还要再看 C2 队列负载：负载大时去 2，负载正常时去 3。`share/runtime/tieredThresholdPolicy.cpp:736`、`share/runtime/tieredThresholdPolicy.cpp:737`、`share/runtime/tieredThresholdPolicy.cpp:738`、`share/runtime/tieredThresholdPolicy.cpp:740`、`share/runtime/tieredThresholdPolicy.cpp:762`、`share/runtime/tieredThresholdPolicy.cpp:763`、`share/runtime/tieredThresholdPolicy.cpp:764`、`share/runtime/tieredThresholdPolicy.cpp:766`

这段逻辑最值得记住的，不是哪条 if，而是背后的思路：**当前该去哪一层，不只看“我热不热”，还看“如果我现在去某层，会不会在系统当前负载下更划算”。**

## 为什么 level 2 存在：它不是装饰台阶，而是“排队减速带”

如果只看名字，`CompLevel_limited_profile` 很容易被当成 `full_profile` 的过渡层，似乎存在也行，不存在也行。实际恰恰相反，level 2 的存在理由非常具体，而且正好说明 tiered policy 的现实主义。

`common()` 在 `CompLevel_none` 分支里有一段非常直白的注释：C1 生成的 full-profile 代码比 limited-profile 代码大约慢 30%。如果 C2 队列已经很长，而系统还把方法都一股脑推去 level 3，那这些方法会在“等待 C2”的这段时间里长时间泡在更慢的 profiling 代码里。为了解决这个问题，HotSpot 才引入了反馈机制：C2 队列够长时，先编一个 level 2 版本，等负载下来再补 level 3。`share/runtime/tieredThresholdPolicy.cpp:755`、`share/runtime/tieredThresholdPolicy.cpp:756`、`share/runtime/tieredThresholdPolicy.cpp:757`、`share/runtime/tieredThresholdPolicy.cpp:758`、`share/runtime/tieredThresholdPolicy.cpp:759`、`share/runtime/tieredThresholdPolicy.cpp:760`

这说明 level 2 并不是“台阶摆在那里，顺手踩一下”，而是一块很明确的减速带：**当最终优化器太忙时，用更便宜的半 profile 版本顶一下，不让方法在重 profiling 代码里空耗。**

一旦理解了这一点，很多表面上“绕路”的迁移其实就不再奇怪。因为策略并不是在追求“路径最短”，它在追求的是“在当前系统负载下，总成本最低”。

## 阈值不是一个数，而是“两档计数 + 动态缩放”

很多人谈 tiered policy 时最容易把注意力全放到“默认阈值是多少”。这当然重要，但如果只记一个定值，会把整个策略讲扁。

`call_predicate_helper` 和 `loop_predicate_helper` 展示的是两类不同门槛：

- 调用路径：要么调用次数单独达标，要么调用次数和回边次数协同达标；
- 回边路径：直接看回边计数。 `share/runtime/tieredThresholdPolicy.cpp:44`、`share/runtime/tieredThresholdPolicy.cpp:51`、`share/runtime/tieredThresholdPolicy.cpp:55`、`share/runtime/tieredThresholdPolicy.cpp:58`、`share/runtime/tieredThresholdPolicy.cpp:65`、`share/runtime/tieredThresholdPolicy.cpp:72`、`share/runtime/tieredThresholdPolicy.cpp:75`、`share/runtime/tieredThresholdPolicy.cpp:77`

这已经说明“够热”本身就不是一个单一数字，而是按调用热点和循环热点分成了两套判据。

但更重要的是，这些阈值不是死的。`threshold_scale()` 会根据当前队列负载和 CodeCache 压力动态抬高或放大阈值。它先看当前层级对应编译器的队列长度与编译线程数，算出一个 `k`；然后如果还允许冲到 full optimization，而且当前层级不是 full optimization，就进一步查看对应 CodeBlob 类型的 CodeCache 压力，必要时再指数抬高阈值。`share/runtime/tieredThresholdPolicy.cpp:558`、`share/runtime/tieredThresholdPolicy.cpp:559`、`share/runtime/tieredThresholdPolicy.cpp:560`、`share/runtime/tieredThresholdPolicy.cpp:561`、`share/runtime/tieredThresholdPolicy.cpp:563`、`share/runtime/tieredThresholdPolicy.cpp:567`、`share/runtime/tieredThresholdPolicy.cpp:568`、`share/runtime/tieredThresholdPolicy.cpp:569`、`share/runtime/tieredThresholdPolicy.cpp:570`

也就是说，阈值的真正含义不是“方法跑到某个固定数就升级”，而是“在当前系统负载下，方法是否热到值得消耗下一层的编译资源”。

这也是为什么单独背几个默认值远远不够。默认值只是底稿，真正决定升级与否的，是“计数 × 当前缩放系数”这套动态阈值。

## `event()` 为什么要分成 CALL 和 LOOP 两路

到了真正运行期，Tiered policy 不是定时巡检，而是被事件驱动的。`event()` 就是入口：计数器溢出后，它先处理 counter overflow，再按 `bci` 区分这次事件到底是普通调用入口触发，还是循环回边触发。`share/runtime/tieredThresholdPolicy.cpp:371`、`share/runtime/tieredThresholdPolicy.cpp:383`、`share/runtime/tieredThresholdPolicy.cpp:392`、`share/runtime/tieredThresholdPolicy.cpp:394`

这条分流非常关键，因为“方法被频繁调用”和“方法里的某个循环疯狂回边”不是同一种热点。

- CALL 事件走 `method_invocation_event()`，目标是判断普通入口版本是否该升级；
- LOOP 事件走 `method_back_branch_event()`，目标是判断 OSR 版本是否该升级。

而且 LOOP 路径不是“只管 OSR，不管别的”。它在决定 OSR 之后，还会顺手检查普通入口是不是也该升。这样一来，你在 `PrintCompilation` 里看到“先 `%3` 再 `3`，再 `%4` 再 `4`”就不再奇怪了：这是循环热点与普通入口升级并行推进的正常表现。`share/runtime/tieredThresholdPolicy.cpp:398`、`share/runtime/tieredThresholdPolicy.cpp:399`、`share/runtime/tieredThresholdPolicy.cpp:401`、`share/runtime/tieredThresholdPolicy.cpp:884`、`share/runtime/tieredThresholdPolicy.cpp:889`、`share/runtime/tieredThresholdPolicy.cpp:895`、`share/runtime/tieredThresholdPolicy.cpp:903`、`share/runtime/tieredThresholdPolicy.cpp:914`、`share/runtime/tieredThresholdPolicy.cpp:917`、`share/runtime/tieredThresholdPolicy.cpp:921`

这一步最值得记住的结论是：**CALL 与 LOOP 不是两种触发方式的细节差异，而是两条不同升级语义的入口。**

## 为什么 profile 不一定非等 level 3 代码到场才开始收集

很多人会下意识觉得：既然 full profiling 对应 level 3，那 profile 应该等方法先编成 level 3 版本，再开始认真收。实际上 HotSpot 比这更现实。

`should_create_mdo()` 明确写了另一种策略：如果方法当前还在解释器层，而且 C2 队列负载没高到不该收 profile，就可以在解释器阶段先开始 profiling。判断条件还会乘上 `Tier0ProfilingStartPercentage` 这类系数。`share/runtime/tieredThresholdPolicy.cpp:636`、`share/runtime/tieredThresholdPolicy.cpp:639`、`share/runtime/tieredThresholdPolicy.cpp:640`、`share/runtime/tieredThresholdPolicy.cpp:641`、`share/runtime/tieredThresholdPolicy.cpp:643`、`share/runtime/tieredThresholdPolicy.cpp:645`、`share/runtime/tieredThresholdPolicy.cpp:646`

而真正执行这件事的，就是 `method_invocation_event()` 和 `method_back_branch_event()` 一开头那几行：只要 `should_create_mdo()` 为真，就调用 `create_mdo()`；而 `create_mdo()` 自己也很克制，native、abstract、accessor、constant getter 这些方法直接跳过，其余才会在没有 MDO 时调用 `Method::build_interpreter_method_data`。`share/runtime/tieredThresholdPolicy.cpp:884`、`share/runtime/tieredThresholdPolicy.cpp:886`、`share/runtime/tieredThresholdPolicy.cpp:887`、`share/runtime/tieredThresholdPolicy.cpp:905`、`share/runtime/tieredThresholdPolicy.cpp:909`、`share/runtime/tieredThresholdPolicy.cpp:663`、`share/runtime/tieredThresholdPolicy.cpp:664`、`share/runtime/tieredThresholdPolicy.cpp:670`、`share/runtime/tieredThresholdPolicy.cpp:671`

翻译成人话就是：**HotSpot 不想傻等 level 3 代码先编好再开始攒 profile，它会在解释器里就提前开 profile，这样等 C1/C2 真来吃数据时，饭已经先煮上了。**

这也再次说明，分层策略真正优化的是“整体时间”，不是“状态看起来多整齐”。

## `TieredStopAtLevel` 不是简单地“只剩前 N 级”，而是把后续所有下一跳都截掉

最后还有一个很常用的调试开关：`TieredStopAtLevel`。它不是一个事后过滤器，而是直接进了 `common()` 的返回值：`return MIN2(next_level, (CompLevel)TieredStopAtLevel);`。`share/runtime/tieredThresholdPolicy.cpp:815`

这个位置特别说明问题：`TieredStopAtLevel` 改的不是“哪些编译结果最后允许安装”，而是“策略在算下一跳时，允许它看见的最高终点”。

所以把它设成 1，不是“仍然按原策略走，只是最后不让上更高层”，而是等于把整套策略裁成“纯 C1 世界”；设成 3，则把 full optimization 整个从下一跳候选里移掉，所有方法最多只会走到 full-profile C1。

这就是为什么这个开关在调试编译器行为时特别有用：它不是单纯限制结果，而是直接改变策略空间。

## 收网：分层策略不是爬楼梯，而是在动态选“下一跳”

现在可以把整篇压成一张总图了。

tiered compilation 的五层并不是一条人人都要走的固定楼梯。对 HotSpot 来说，真正的问题从来不是“当前在第几层”，而是“此刻最值得往哪一层跳”。`TieredThresholdPolicy` 通过 `common()`、`call_predicate`、`loop_predicate`、`threshold_scale()`、CALL/LOOP 两条事件路径，以及解释器里提前建 MDO 的逻辑，同时平衡了启动延迟、profile 成熟度、C1/C2 队列负载和 CodeCache 压力。结果就是：普通热点常走 `0→3→4`，C2 忙时会绕到 `2`，trivial 方法可能直接停在 `1`，循环热点则经常先 OSR 再补普通入口。`share/runtime/tieredThresholdPolicy.hpp:179`、`share/runtime/tieredThresholdPolicy.cpp:676`、`share/runtime/tieredThresholdPolicy.cpp:715`、`share/runtime/tieredThresholdPolicy.cpp:762`、`share/runtime/tieredThresholdPolicy.cpp:798`、`share/runtime/tieredThresholdPolicy.cpp:819`、`share/runtime/tieredThresholdPolicy.cpp:884`、`share/runtime/tieredThresholdPolicy.cpp:903`

所以，本篇最核心的一句话不是“tiered 有 5 层”，而是：

**分层策略不是按 `0→1→2→3→4` 爬楼梯，而是在每次事件发生时，根据热度、profile、队列负载和空间压力，动态选择最划算的下一跳。**

只要这句抓住了，下一篇进入 C1 内部就顺了：当策略说“现在该去 level 3”时，C1 到底是怎样把字节码变成 HIR，再一路编成机器码的。

> → [14-c1-compiler/01 — C1 管线 + HIR — 字节码→编译图](../14-c1-compiler/01-c1-pipeline-ir.md)
