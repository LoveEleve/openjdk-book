# 07. 为什么这些高层节点要留到最后？— `PhaseMacroExpand`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 C2 优化后期的宏节点审判：`PhaseMacroExpand` 如何处理 `Allocate`、`AllocateArray`、`Lock`、`Unlock`、`ArrayCopy` 等高层节点，以及为什么这些节点被故意保留到循环优化和寄存器分配之后才统一裁决。library call intrinsic 的更大世界放到下一篇单讲。
>
> **前置依赖**：[15-c2-compiler/03 — 为什么 C2 还要三套引擎？— `IGVN + CCP + Escape Analysis`](03-c2-optimizations.md)、[15-c2-compiler/06 — 理想图为什么还不能直接发码？— `Matcher + GCM + Output`](06-c2-codegen.md)、[15-c2-compiler/05 — 为什么 C2 不用 LinearScan？— `Chaitin + IFG + spill-split-recycle`](05-c2-register-alloc.md)
> → **后续**：[15-c2-compiler/08 — `library_call.cpp`：6991 行的 intrinsic 世界](08-c2-library-calls.md)

到了前一篇，理想图已经被平台化、调度、寄存器分配，离最终机器码只剩最后一公里。

可如果你回头看图里，还会发现一批很奇怪的节点：`Allocate`、`AllocateArray`、`Lock`、`Unlock`、`ArrayCopy`……它们明明都已经非常接近“具体动作”，却还没有早早被砍成一堆 MachNode。

这就会逼出一个很自然的问题：**既然 C2 迟早都要把这些高层操作降成机器节点，为什么不在 Parse 后、甚至 Matcher 前就早点展开？**

答案是：它们的命运在更早阶段根本还没决定。

- 某个 `Allocate` 可能会被 EA 证明成根本不需要存在；
- 某个 `Lock` 可能在锁消除后整个蒸发；
- 某个 `ArrayCopy` 可能因为源/目标类型与长度关系，走完全不同的 fast path 或 slow path；
- 某些节点只是临时保护结构（例如 `Opaque`、`LoopLimit`），在循环优化之后就该消失。

所以这些节点不是“还没来得及展开”的半成品，而是**故意保留的高层占位符**。它们被延迟到 `PhaseMacroExpand`，就是为了等前面各路优化把“能不能删”“该走哪条路径”“还剩什么控制流”这些信息都喂成熟，再做最后一次统一审判。

先把答案压成一句人话：**宏节点不是编译器偷懒没降完的节点，而是延迟决策的载体。C2 故意让它们活到优化后期：能消的零成本消失，不能消的再按当前最成熟的信息展开。**

---

## 1. 先试两个最自然的办法，看看为什么都不对

### 误解一：Parse 后就把所有高层节点都展开，后面只优化低层图

这看起来很直接。既然最终都要变成机器相关节点，那就早点展开，省得后面还带着这些“高层语义”节点满图跑。

问题在于，越早展开，越会污染优化视图。

一个 `Allocate` 一旦变成完整 fast/slow path 控制流，图规模会立刻暴涨；EA 原本想要证明“这个对象其实不必存在”就会难得多。锁节点也是同样道理：如果过早展开成锁记录、fast path、slow path 调用和内存屏障，后面再做锁消除就得跨一大堆细碎控制流去回收残局。

数组拷贝也一样。真正 fast path 取决于元素类型、别名、长度等条件；过早展开会把“一个抽象数组拷贝语义”变成很多细节节点，既加重优化成本，又掩盖高层结构信息。

所以 Parse 后立刻展开，不是“提早完成工作”，而是把后续优化最宝贵的高层语义视野自己打碎。

### 误解二：那就一直留着，反正最后统一翻译就行

另一种极端是相反方向：既然太早展开不好，那就什么也别动，全都留到最后直接翻译成机器节点。

这也不对。因为其中很多节点最终的最优命运根本不是“翻译成机器节点”，而是“完全消失”。

比如 `Allocate`：如果 EA 已经证明它 `NoEscape` 且 `scalar_replaceable`，那最好的结果不是展开成 fast/slow path 分配逻辑，而是根本别分配。`Lock` 也是如此：如果锁节点已经被标记成 eliminated，再去展开它只是在制造本来不需要存在的控制流。

所以 C2 需要的是两步，而不是一步：

1. 先在最晚时机再做最后一次“能不能消”的裁决；
2. 对真正必须活下来的高层节点，再做最终展开。

这正是 `PhaseMacroExpand` 的核心职责。

---

## 2. `expand_macro_nodes`：真正的“最后审判”长什么样

`Compile::Optimize` 里，MacroExpand 是在 loop opts、EA、CCP、IGVN 都跑完之后才登场的。源码位置也很明确：`TracePhase tp("macroExpand")`，随后 `PhaseMacroExpand mex(igvn); mex.expand_macro_nodes()`。`compile.cpp:2432-2436`

这已经说明它的时机不是随便挑的：**它发生在高层优化基本定型之后。**

`expand_macro_nodes()` 自己的开头也把自己的定位写得很直白：`Last attempt to eliminate macro nodes.` 也就是说，它不是一进来就展开，而是先 `eliminate_macro_nodes()`，再看还剩什么。`macro.cpp:2645-2647`

紧接着它会做节点预算检查：最坏情况下一个宏节点可能展开成大约 200 个节点，因此先用 `macro_count() * 300` 估算余量，不够就直接放弃编译。这个细节特别能说明：宏展开不是“轻松的最后转换”，而是图规模会显著放大的危险动作。`macro.cpp:2650-2653`

随后还有两层清理与排序：

- 先把 `LoopLimit`、`Opaque1/2`、某些 `CallStaticJava` 宏节点等临时保护结构从宏列表里摘掉，重新扔回 IGVN worklist；
- 再强制 **arraycopy 先行展开**，之后才进入 allocate/lock/unlock 的主循环。`macro.cpp:2656-2744`

这说明 MacroExpand 不是一个“遍历宏节点挨个翻译”的薄阶段，而是一个**带依赖顺序的最后审判程序**：先消、再清临时结构、再按拓扑顺序展开剩余宏节点，最后 `_igvn.optimize()` 收尾。`macro.cpp:2773-2774`

---

## 3. 分配的两条出路：先问“能不能不存在”，再问“怎么存在”

对象分配是宏节点最典型的一类命运分叉。

如果 EA 之前已经证明某个 `Allocate` 是 `NoEscape` 且满足标量替换条件，那么 `eliminate_allocate_node()` 会走“让它不存在”的路线。`macro.cpp:1091-1144`

而且这里还要注意一个经常被讲扁的边界：EA 不是直接删除分配，真正删除是在 `eliminate_allocate_node()` 里通过 `scalar_replacement()` 和 `process_users_of_allocation()` 落刀。也就是说，“证明可消”和“真正消掉”在 C2 里是分阶段的。

另一条路是“这个对象必须存在”。这时 `expand_allocate()` / `expand_allocate_common()` 才会真正生成 fast path + slow path 结构：快路径内联 TLAB bump 之类的分配序列，慢路径则准备 Runtime/Stub 调用。这里最该记住的不是某条 if，而是这条分工：**对象分配不是天生就要被展开，只有在已经证明不能消掉之后，展开才有意义。**

这也正说明宏节点为什么要保留到这里：太早展开，EA 就失去了一次“让它不存在”的机会。

---

## 4. 锁的两条出路：锁消除与锁展开也必须等到最后

锁节点的命运和分配完全同构。

如果 `AbstractLockNode` 已经被标成 eliminated，`eliminate_locking_node()` 会把它连同相关的 `MemBarAcquireLock` / `MemBarReleaseLock` 一起拆掉；必要时连 `FastLockNode` 自己也可以被顶掉。`macro.cpp:2182-2252`

也就是说，锁在 MacroExpand 阶段并不是“必然展开”的，它的第一种命运也是完全消失。

只有那些无法消掉的锁，才会进入 `expand_lock_node()`。而这里也要避免一个常见误解：它不是直接在这一步把最终平台指令（例如 cmpxchg）一条条发出来，而是生成机器节点级别的 fast path / slow path 控制结构，让后续 matcher/output 再去做真正的平台化和编码。`macro.cpp:2258-2272`

所以锁的故事再次说明：**MacroExpand 不是简单翻译，而是统一裁决“消失还是展开”。**

---

## 5. 为什么 arraycopy 要先于 allocate 展开

`expand_macro_nodes()` 里最容易被忽略、但最能说明它有依赖拓扑的一句注释，就是：为了 `ReduceBulkZeroing`，必须先处理所有 arraycopy，再展开 allocate。`macro.cpp:2723-2724`

这不是任性排序，而是因为 arraycopy 会消费和影响分配相关结构。如果分配先展开，后面 arraycopy 的优化空间、别名关系或零填充处理就可能被打乱。

`expand_arraycopy_node()` 自己也不是单一路径：

- `clonebasic` 直接交给 barrier set 在 expansion 时处理；
- `copyof/copyofrange/cloneoop` 走对象数组路径，先准备 `MergeMem` 和 slow region，再调 `generate_arraycopy`；
- 普通 arraycopy 则先做 compile-time checks，如果无法在编译期验证关键前提，就宁可不做 fast path。`macroArrayCopy.cpp:1106-1157`

这进一步说明宏节点展开不是一条“统一 lower”路径，而是到这个时机才根据足够成熟的信息分流：有的走 clone fast path，有的走对象数组语义，有的直接保留成更慢的调用。

---

## 6. 宏节点为什么故意被保留到这里：前半程需要看见的是“高层语义”，不是“碎控制流”

到这里可以把前面的分配、锁、数组拷贝故事收成同一条设计线。

前半程的 IGVN、CCP、EA、LoopOpts、SuperWord 真正关心的，不是“这个慢路径 call 的第几个 Proj 节点怎么连”，而是更高层的问题：

- 这是一个对象分配语义，还是一个已经可以证明不存在的对象？
- 这是一个锁语义，还是一个已经可以证明不必锁的同步边界？
- 这是一个数组拷贝语义，还是一个必须按元素和障碍细分处理的调用？

如果太早把这些语义打碎成具体控制流和低层节点，前面那些全局优化就会被迫在噪音更大的图上工作。

所以宏节点的真正价值，不在于“先留着以后再翻”，而在于它们作为**延迟决策占位符**，让高层优化阶段能够继续以更抽象、更干净的视图工作。

---

## 7. MacroExpand 之后为什么还要再跑一次 IGVN

很多人会把 MacroExpand 想成 C2 的最后转换：展开完，直接去 Matcher/Output 就好了。

源码并不是这样。`expand_macro_nodes()` 在处理完宏节点后，会明确 `_igvn.optimize()` 再收一轮，然后还要交给 GC barrier set 做剩余宏展开。`macro.cpp:2773-2777`

这再次说明：展开或消除宏节点会重新改变图结构——新的控制边、常量、死节点、内存关系都会冒出来。既然图又变了，IGVN 就还得再回来把这些后效应收敛掉。

所以 MacroExpand 不是“图固定后做一次机械降级”，而是“最后一次大规模结构改写”，并且它之后还要再交给统一收敛器打一遍扫尾。

---

## 8. 误解澄清与收网

1. **Parse 后就把所有高层节点都展开，是不是更省事?** 不是。那会让 EA、锁消除、arraycopy 分析在噪音更大的低层图上工作。
2. **那是不是一直留着，最后统一翻译就行?** 也不对。很多节点的最优命运是“消失”，而不是“翻译”。
3. **MacroExpand 是“统一翻译所有宏节点”吗?** 不是。它先做最后一次消除裁决，再按依赖顺序展开剩余的。
4. **锁在 MacroExpand 阶段必然展开吗?** 不是。它第一种命运就是完全消失。
5. **MacroExpand 之后就不用再优化了吗?** 不是。展开会改变图结构，还要再跑一轮 IGVN 收敛。

把这一篇压成三句话：

- **宏节点是延迟决策占位符：能消的在最后一刻零成本消失，必须留的才在信息最成熟的时候展开。**
- **分配、锁、arraycopy 在 MacroExpand 阶段都有“消失 vs 展开”两条命运。**
- **MacroExpand 不是最终转换，而是最后一次大规模结构改写，之后还要 IGVN 收尾。**

下一篇: `library_call.cpp`——有些高层语义根本不会走普通字节码或普通宏展开，而是在 Parse 阶段就被 `LibraryCallKit` 直接换成更理想的图子结构。

> → [15-c2-compiler/08 — `library_call.cpp`：6991 行的 intrinsic 世界](08-c2-library-calls.md)