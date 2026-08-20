# 05. 为什么 C2 不用 LinearScan？— `Chaitin + IFG + spill-split-recycle`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 C2 的寄存器分配：`PhaseChaitin`、LRG、IFG、coalesce、select、split 以及它们如何把 Matcher 之后的机器节点放进有限寄存器。Matcher/指令选择与最终发码放到下一篇。
>
> **前置依赖**：[15-c2-compiler/04 — 为什么循环要单独优化？— `CountedLoop + PhaseIdealLoop + SuperWord`](04-c2-loops.md)、[15-c2-compiler/01 — 为什么 C2 要换世界观？— `Ideal Graph = Node + Type + IGVN`](01-c2-ideal-graph.md)、[14-c1-compiler/03 — 虚拟值怎么落到机器？— `LinearScan + LIR → x86` 码](../14-c1-compiler/03-c1-register-codegen.md)
> → **后续**：[15-c2-compiler/06 — `Matcher + Code Generation`：DFA 指令选择 → x86 机码](06-c2-codegen.md)

C1 到了后端，会把值压成 Interval，然后用 LinearScan 单趟把它们安置进寄存器或栈槽。对 C1 来说，这非常合理：它要低延迟，前面做的优化也偏局部，寄存器分配最好别再把编译时间拉长。

但 C2 到这里不满足了。

原因不是“图着色听起来更高级”，而是前面那整套全局优化已经把值关系做得更复杂、更值得精打细算：

- 值会跨块、跨 Phi、跨循环、跨向量节点活很久；
- coalesce、EA、loop opts、vector packs 已经尽量把图压得更紧凑，后端如果再用太粗糙的分配，很容易把前面赢回来的局部性和寄存器重用率又还给 spill；
- 某些值的 spill 代价差别极大：热路径上的 load/store、copy 链、向量值、基指针，都不是“一 spill 了之”能公平处理的。

所以，这一篇真正的问题不是“图着色算法怎么教科书化地工作”，而是：**为什么 C2 愿意在寄存器分配阶段付出更高编译成本，用全局干涉图、着色、spill-split-recycle 来换更好的寄存器利用率？**

先把答案压成一句话：**C2 不用 LinearScan，不是因为它嫌单遍扫描不够时髦，而是因为它前面已经把图优化到了值得认真安排资源的位置。于是它先把值压成 LRG，再把“同时活着”的关系编码成 IFG，用 simplify/select 着色；颜色不够时也不满足于永久 spill，而是 split live range、重建 liveness/IFG、再来一轮，直到全局活跃关系能塞进有限寄存器。**

## 先试两个最自然的办法，看看为什么都不够

### 误解一：C2 完全可以沿用 C1 的 LinearScan

这是最直接的想法。C1 已经证明了线性扫描可以工作，而且很快。C2 既然最后也要把值放进寄存器，那为什么不继续沿用同一种分配器？

问题在于，C2 的值关系已经不再像 C1 那么局部。

前面那些全局优化把程序重写得更紧：

- 值可能跨越更长的控制流范围；
- Phi 合并和图改写会让“同一个逻辑值”的生存区域更破碎、更交叠；
- 向量化和复杂 matcher 结果又会引入多寄存器需求和更高的局部压力；
- coalesce 的收益也更大，因为 copy 链一旦压掉，后端的 move 和 spill 量会一起下降。

LinearScan 当然仍然能分配，但它更擅长“沿指令顺序做局部决策”，不那么擅长在一张已经被全局优化扭曲过的活跃关系图上，做尽量全局的寄存器重用安排。

所以 C2 不是不能用 LinearScan，而是**觉得这张图值得花更多分配时间。**

### 误解二：寄存器不够就 spill，spill 了就住栈，没必要再折腾 split

另一个常见误解是：既然寄存器不够，spill 本来就是合理结局，那值一旦 spill 到栈上，后面就认命待在栈里，没必要再 split/recycle 一轮又一轮。

这听起来节省编译时间，但它会直接损耗前面全局优化的收益。

一个值的生命周期往往不是整段都紧张：

- 它可能只在循环热点内部需要寄存器；
- 过了某个 call 或 merge 之后，短时间内再也用不到；
- 某些路径上密集使用，另一些路径上几乎闲置。

如果一 spill 就永久住栈，你等于把“局部寄存器压力太高”升级成“整个方法都不再值得用寄存器保存这个值”。这通常过于保守。

所以 C2 的真正补救方式不是“spill 后就认输”，而是**把 live range 拆短，允许它在某段时间住栈，在别的段落重新抢回寄存器。** 这正是 split/recycle 存在的理由。

## LRG 与 IFG：为什么先要把“同时活着”编码成图

C2 后端不是直接对 Node 或 MachNode 染色，而是先把它们压缩成 LRG（Live Range Group）。你可以把 LRG 理解为“后端眼里应该共同分配资源的一组活跃关系单元”。

要给 LRG 分寄存器，先得知道谁和谁不能同色。这就是 IFG（Interference Graph）的职责。

`build_ifg_virtual()` 的注释把建图方式写得非常清楚：它对每个基本块做一次逆向扫描，从 live-out 集出发，遇到定义就让“当前定义值”与“此刻 live 集里的所有值”产生干涉，然后把定义移出 live 集，把输入加入 live 集。`share/opto/ifg.cpp:311`、`share/opto/ifg.cpp:317`、`share/opto/ifg.cpp:325`、`share/opto/ifg.cpp:329`

这个过程特别值得理解，因为它说明 IFG 不是“额外造一张图”而已，而是把寄存器冲突这个动态时间问题静态编码成图边：**两个 LRG 只要在某个点同时活着，就不能拿同一个寄存器颜色。**

更重要的是，IFG 比“单个区间的首尾”更贴合 C2 的值关系。C2 前面经历过 Phi 合并、循环变换、向量打包、matcher 重写，真正需要保护的是“谁会与谁同时活着”，而不只是“这个值从哪到哪活着”。IFG 把这种全局重叠关系直接变成邻接边，后面 simplify/select 看到的是资源冲突图，而不是一串线性区间。

还有一个关键特例：copy 不定义新值，因此不产生新的干涉。这恰恰为后面的 coalesce 提供了空间——如果 copy 两端没有真正冲突，后端就有机会把它们染成同色，连这条 copy 本身都省掉。现稿已经抓住这一点，它是整套 C2 RA 哲学的支点之一。

## 为什么 LRG 里不仅有“谁干涉我”，还要记 `_cost/_area/_copy_bias`

寄存器分配不只是一个纯图问题，还是一个代价问题。

`LRG` 里最重要的几个字段已经把这种代价意识暴露出来了：

- `_cost`：spill 这个值有多疼；
- `_area`：它同时占住寄存器资源的面积有多大；
- `_copy_bias`：它最好和谁同色，以便消掉 copy；
- `score()`：用 `cost/area` 之类的折中决定潜在 spill 候选。

这一步的意义很重要：C2 并不是盲目追求“图能染上色就行”，而是在问**哪个值最适合被牺牲、哪个值最值得保住寄存器、哪对值合并同色收益最大**。这和 C1 的“下次使用位置最晚者先挤走”相比，已经是一种更全局的价值排序。

所以 IFG 给的是约束，`score()` 给的是代价偏好，两者一起才构成后面的 simplify/select 决策基础。

## Simplify：为什么低度节点天然适合先压栈

`Simplify()` 的核心思想其实很朴素：如果某个 LRG 的干涉度数已经低到小于可用寄存器数，那它在最终着色时天然更容易找到颜色。所以先把这种“低度节点”摘掉压到 `_simplified` 栈里，再让剩余图继续缩小。`share/opto/chaitin.cpp:1199`、`share/opto/chaitin.cpp:1202`、`share/opto/chaitin.cpp:1206`、`share/opto/chaitin.cpp:1217`、`share/opto/chaitin.cpp:1229`、`share/opto/chaitin.cpp:1232`

当低度列表空了，而高干涉节点还没处理完时，算法才开始挑“潜在 spill 候选”。源码写得很坦白：这时候是 `Time to pick a potential spill guy`。也就是说，它不是宣布“这个值已经必 spill”，而是先在约简栈里把它当作最可能被牺牲的对象压下去，等 Select 阶段再看是不是真的走到那一步。`share/opto/chaitin.cpp:1263`、`share/opto/chaitin.cpp:1266`、`share/opto/chaitin.cpp:1267`、`share/opto/chaitin.cpp:1273`

这就是图着色寄存器分配最值得抓住的直觉：**先靠图约简找出“容易染色”的顺序，再在真正分颜色时回头做决定。**

所以 simplify 的作用，不是“已经决定谁 spill”，而是把难题推迟到“图已经尽量被削薄”的那一刻。

## coalesce：为什么寄存器分配还要顺手消 copy

如果寄存器分配只管着色，不管 copy，那么很多虚拟 copy 会在后端变成真 move。这会让前面好不容易压缩好的数据流关系再次膨胀成机器级搬运。

所以 C2 在 simplify/select 之外，还会专门跑 aggressive 和 conservative 两档 coalesce。前者更激进，优先尽量消 copy；后者更保守，避免为了消 copy 把图挤到不可着色。它们的存在说明一件事：**寄存器分配在 C2 里不是“先分完再说”，而是和 copy 结构一起联动优化。**

这和 `_copy_bias` 的存在是同一套哲学：如果两个 live range 没有真正冲突，那后端当然希望它们共用一个颜色，这样等价于把 copy 关系在分配阶段就消掉。

所以 coalesce 不是可有可无的小修饰，而是“减少 move、减少 spill 压力、提高寄存器利用率”的关键配套动作。

## Select：真正分颜色时在做什么

`Select()` 会从 `_simplified` 栈顶逆序弹出 LRG，重新把它插回 IFG，再从邻居已占颜色中扣掉不可用色，然后调用 `choose_color()` 选一个还能用的寄存器颜色。`share/opto/chaitin.cpp:1447`、`share/opto/chaitin.cpp:1452`、`share/opto/chaitin.cpp:1468`、`share/opto/chaitin.cpp:1482`、`share/opto/chaitin.cpp:1503`、`share/opto/chaitin.cpp:1528`、`share/opto/chaitin.cpp:1529`

这里有一个很容易被忽略的细节：栈槽本身也被当作一种“颜色空间”，而且 `AllStack` live range 还会按 chunk 滚动到下一块 stack color 区域。这说明在 C2 RA 里，“着色失败”的含义不是只有“寄存器没了”，还包括“退到另一个资源池里找位置”。`share/opto/chaitin.cpp:1471`、`share/opto/chaitin.cpp:1536`、`share/opto/chaitin.cpp:1538`、`share/opto/chaitin.cpp:1540`

所以 Select 的任务不是简单地给每个值填一个寄存器号，而是：**在图约简顺序已经确定后，尽可能把值放回最好的颜色空间；实在不行，再把问题交给 split。**

## Split：为什么 C2 不接受“一 spill 就长期住栈”

真正体现 C2 风格的地方，在 spill 之后。

`Register_Allocate()` 里第一次 `Select()` 如果有 spill，不是直接收工，而是进入 `while (spills)` 的 `spill-split-recycle` 大循环。每轮都会：

- `Split()` 把需要 spill 的 LRG  everywhere 拆短；
- `compact()` 重新压缩 LRG 编号；
- 重建 liveness；
- 重建 IFG；
- 必要时再做一轮保守 coalesce；
- 再 `Simplify()`、再 `Select()`。 `share/opto/chaitin.cpp:517`、`share/opto/chaitin.cpp:519`、`share/opto/chaitin.cpp:521`、`share/opto/chaitin.cpp:534`、`share/opto/chaitin.cpp:542`、`share/opto/chaitin.cpp:544`、`share/opto/chaitin.cpp:558`、`share/opto/chaitin.cpp:566`、`share/opto/chaitin.cpp:578`、`share/opto/chaitin.cpp:582`

这条链的含义非常重要：**C2 不接受“寄存器不够，那这个值以后都住栈”的粗糙结局。**

它更愿意做的是：把这个活跃关系拆短，让部分使用点重新有机会拿回寄存器，或者让某些段干脆重物化，而不是长期背着一个高频 spill 值。

这也是为什么 split/recycle 是整套算法的关键，而不是后补救火。没有它，图着色分配就会在第一次颜色不够时迅速退化成大量永久 spill，前面全局优化获得的好处会被后端粗糙分配吞掉。换句话说，split 不是单纯为了“让算法继续跑下去”，而是为了守住前面 IGVN、EA、循环优化和向量化已经替代码赢回来的寄存器局部性与访存质量。

源码里 `_trip_cnt` 的 24/27 次上限，也很能说明它的工程味：算法并不是理论上无限重试，而是靠一条工程预算线防止 spill-split-recycle 发疯。`share/opto/chaitin.cpp:521`、`share/opto/chaitin.cpp:523`、`share/opto/chaitin.cpp:525`、`share/opto/chaitin.cpp:526`

所以 Split 的真正角色可以压成一句话：**它让 spill 从“终身判决”变成“阶段性让位”。**

## 这套高成本 RA，为什么仍然符合 C2 的总体哲学

看到这里，可能会反过来问：既然 spill-split-recycle 这么重，C2 为什么愿意花这笔时间？

答案其实和前面所有 C2 章节一致：因为它前面已经花大力气把图优化到了“值得认真安排资源”的地步。

- Parse + GraphKit 已经把语义织进图；
- IGVN / CCP / EA 已经把图收得更小、更窄；
- 循环与 SuperWord 又让热点路径更密、更宽。

到这个阶段，如果后端还用过于粗糙的寄存器分配，很多前期全局优化换来的局部性、值合并和向量 pack 优势，都会在 spill 和 move 里漏掉。

所以 C2 愿意在 RA 阶段付出更多时间，本质上是在贯彻它一以贯之的哲学：**既然前面已经做了全局优化，那后面也值得做更全局的资源安排。**

## 收网：C2 的 RA 不是单遍扫描，而是全局活跃关系图上的着色与拆分

现在可以把整篇压成一张总图了。

Matcher 之后，C2 先用 `PhaseLive` 算出值在图上的活跃关系，再用 `build_ifg_virtual`/`build_ifg_physical` 把“同时活着”编码成 IFG；LRG 里保存 `cost/area/copy_bias/score` 这些分配偏好；`Simplify` 先把低度节点压栈、把高干涉节点延后；`Select` 再逆序着色；若颜色仍不够，就不接受永久住栈，而是进入 `spill-split-recycle`：拆短 live range、重建 liveness 和 IFG、再跑一轮 coalesce/simplify/select，直到图终于能塞进有限寄存器。`share/opto/chaitin.cpp:336`、`share/opto/ifg.cpp:317`、`share/opto/chaitin.cpp:360`、`share/opto/chaitin.cpp:409`、`share/opto/chaitin.cpp:425`、`share/opto/chaitin.cpp:515`、`share/opto/chaitin.cpp:519`、`share/opto/chaitin.cpp:521`、`share/opto/chaitin.cpp:578`

所以，这一篇最核心的一句话不是“C2 用 Chaitin 图着色寄存器分配”，而是：

**C2 的寄存器分配已经不再是局部顺序问题，而是全局活跃关系图上的着色与拆分问题；spill 也不是终局，而是通过 split/recycle 反复换空间。**

只要这句抓住了，下一篇 `Matcher + Code Generation` 就好理解了：寄存器终于安排妥当，C2 才能把这些机器节点和寄存器结果真正落成 x86 指令与 nmethod。

> → [15-c2-compiler/06 — `Matcher + Code Generation`：DFA 指令选择 → x86 机码](06-c2-codegen.md)
