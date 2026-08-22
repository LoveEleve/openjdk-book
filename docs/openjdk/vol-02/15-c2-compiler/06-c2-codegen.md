# 06. 理想图为什么还不能直接发码？— `Matcher + GCM + Output`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 C2 从“平台无关图”走到“平台相关机器码”的最后一公里：`.ad` 规则、`Matcher`、全局代码调度、块布局和 `Compile::Output`。宏节点展开留到下一篇单独讲。
>
> **前置依赖**：[15-c2-compiler/05 — 为什么 C2 不用 LinearScan？— `Chaitin + IFG + spill-split-recycle`](05-c2-register-alloc.md)、[15-c2-compiler/01 — 为什么 C2 要换世界观？— `Ideal Graph = Node + Type + IGVN`](01-c2-ideal-graph.md)、[14-c1-compiler/02 — C1 为什么还敢做优化？— `Canonicalizer + ValueMap + Optimizer`](../14-c1-compiler/02-c1-optimizations.md)
> → **后续**：[15-c2-compiler/07 — `PhaseMacroExpand`：高层抽象→低层 MachNode 展开](07-c2-macro-intrinsics.md)

上一章寄存器终于分完了。到这个时刻，C2 手里已经有：

- 一张被各种优化收敛过的 Ideal Graph；
- 一批已经拿到物理寄存器或栈槽的机器级 live range；
- 一套足以落成最终代码的控制流骨架。

这时候很容易冒出一个自然想法：寄存器都安排妥当了，后端是不是只差“把每个节点翻译成对应机器指令”这最后一步？

答案依然是否定的。

真正缺的东西有三层：

- **平台模式选择**：`AddI` 在 x86 上到底变成 reg-reg、reg-imm 还是 reg-mem 形式？一个 `LoadI` 是否能直接折进 `AddI`？
- **顺序与布局**：同样一堆 `MachNode`，块顺序、分支方向、冷热路径摆放不同，代码质量会差很多；
- **落字节与附属信息**：prolog/epilog、重定位、OopMap、CodeBuffer 偏移、短跳转扩展、指令 bundling，都还没有真正完成。

所以，本篇真正要回答的问题不是“Matcher 有什么函数”，而是：**理想图和寄存器都已经准备好了，为什么 C2 还不能直接发码？平台差异、寻址折叠、调度和重定位信息到底还缺什么，才逼得它必须再接一层 `Matcher + Output` 的机器节点世界？**

先把答案压成一句人话：**Ideal Graph 表达的是平台无关的运算关系，寄存器分配表达的是谁占哪个资源，但两者都还没回答“x86 上这团子图最便宜该变成哪条指令、哪些 load 能折进使用者、哪些块该怎么摆、哪些字节与重定位信息该如何一起落地”。Matcher 用 `.ad` 规则把理想节点归约成 `MachNode`，GCM 与块布局决定指令顺序，`Output` 最后把这些机器节点真正压进 `CodeBuffer`。**

---

## 1. 先试两个最自然的理解，看看为什么都不对

### 误解一：理想图已经足够具体了，直接 emit 就行

这是最容易想到的错误直觉。Ideal Graph 里已经有 `AddI`、`LoadI`、`If`、`Call`，看起来只差把这些节点一个个翻成机器指令。

问题在于，Ideal Graph 里的节点语义仍然是**平台无关**的。`AddI(dst, LoadI(src))` 到底应该变成两条指令：先 load 再 add，还是一条带 memory 操作数的 `addl dst, [src]`？这不是理想图自己能回答的。

同样，某个地址模式能不能被目标 ISA 吃掉、某种常量能不能做立即数、某条比较是否天然更新 flags、某个返回值该落在哪组机器寄存器里，这些都不是“图优化问题”，而是**目标机描述问题**。

所以理想图即便已经极度收敛，它也仍然只是“做什么”，还不是“用哪条指令、什么操作数形式来做”。

### 误解二：Matcher 不过就是一个“节点名翻译器”

第二个常见误解正好走向另一边：既然理想图不能直接发码，那 Matcher 大概就是一张“`AddI -> addl`”“`LoadI -> movl`” 的翻译表。

这也远远低估了它。

Matcher 并不是按“单节点对单指令”机械映射，而是在看一整棵理想子树能否被更便宜的机器规则吞掉。例如一个 `AddI(dst, LoadI(src))` 与一个单独的 `LoadI`+`AddI` 不同，它有机会匹配成一条 reg-mem 机器规则，直接少一条指令、少一次寄存器压力。

这就是为什么 `.ad` 规则里不仅有 `match`，还有 `ins_cost`、`ins_encode`、`ins_pipe`：Matcher 不是简单翻译，而是在做**最小成本模式选择**。

---

## 2. `.ad`：为什么平台适配不是 scattered if/else，而是一套规则语言

C2 不把平台适配散落在一堆 `if (x86) { ... } else if (arm) { ... }` 里，而是用 Architecture Description（`.ad`）把一条机器规则打包描述出来。

一条 `instruct` 规则通常同时包含：

- `match(...)`：要匹配的理想子图；
- `effect(...)`：副作用，如 flags 被写；
- `opcode(...)`：目标指令码；
- `ins_encode(...)`：最终发码动作；
- `ins_pipe(...)`：流水线/调度类别；
- `ins_cost(...)`：匹配成本。

这比“节点名翻译表”丰富得多。它把语义、成本、编码和调度前提放进同一个规则单元里，意味着平台适配不只是“能不能发出这条指令”，还包括“值不值得匹配成这条指令”。

所以 `.ad` 的真正意义，不是“把汇编模板写在文件里”，而是：**把平台指令选择的知识变成可计算的规则系统。**

---

## 3. Matcher：真正做的是“标注 + 最小成本归约”

`Matcher::match()` 的前半段会做很多准备：初始化返回值寄存器 mask、根据方法签名和调用约定布置参数寄存器和栈槽、计算 `_old_SP/_new_SP` 这类帧布局信息。也就是说，Matcher 一上来就在把“平台调用约定”灌进这次编译。`matcher.cpp:176-345`

然后它会 `find_shared(C->root())`、`find_shared(C->top())`，把可以共享和不能作为树内部节点的对象先标记出来；再把 old-space 的理想节点逐步 `xform` 到 new-space 的机器节点世界。

真正的核心在 `match_tree()`。它会：

1. 以当前理想节点为根，建立 `State`；
2. 调 `Label_Root` 给整棵输入树打匹配状态标签；
3. 在根状态里找**最小成本**的合法规则；
4. 用 `ReduceInst(...)` 把这棵理想子树归约成 `MachNode`。`matcher.cpp:1359-1405`

这就是 Matcher 最该记住的一点：**它不是在翻译节点，而是在给子树做状态标注，再按成本最小原则把子树归约成目标机节点。**

`ReduceInst()` 则把这个“归约”变成具体对象：生成 `MachNode`，处理 instruction/chain rule，把 control、memory、AddP base 等 Matcher 不自动消费的边也补回去，还会调用 `MachNode::Expand(...)` 处理 1-to-many 扩展。`matcher.cpp:1653-1726`

所以“平台相关化”不是一个薄薄的翻译层，而是**理想图子树到机器节点世界的一次结构性压扁。**

---

## 4. GCM 与块布局：为什么指令顺序依然是独立问题

即使 `MachNode` 已经选出来了，后端仍然没有结束。因为“选了哪些机器节点”和“这些机器节点最终按什么顺序执行”是两回事。

`PhaseCFG::do_global_code_motion()` 会先建 dominator tree，再 `estimate_block_frequency()`，最后 `global_code_motion()`。这说明调度不是可有可无的后处理，而是显式独立的一步。`gcm.cpp:1612-1645`

`estimate_block_frequency()` 本身又不只是“给块打分”。它会专门把 leading to uncommon trap 的分支压到极低频，因为那些路径理论上大多只会真走一次——走到了通常就意味着 deopt。

这说明调度和块布局在 C2 里承担的是另一类职责：**把机器节点以更符合热点分布、依赖关系和分支局部性的顺序摆出来。**

所以 GCM 不是在“美化块顺序”，而是在为最后的机器码布局做代价优化。Matcher 选出“用什么指令”，GCM 决定“这些指令在哪里、按什么顺序出现”——两者缺一不可。

---

## 5. `Compile::Output`：发码不是“for each MachNode emit”这么简单

如果继续沿着“后端只是翻译”这个误解往下想，发码阶段大概只会是：遍历每个 MachNode，调用 `emit()`，写到 `CodeBuffer`。

真实的 `Compile::Output()` 一开头就在做更多事：

- 把 `StartNode` 换成 `MachPrologNode`；
- 为实例方法插入 unverified entry point；
- 在每个 return 之前补 `MachEpilogNode`；
- 初始化 code buffer；
- `ScheduleAndBundle()`；
- `BuildOopMaps()`；
- 最后才 `fill_buffer(cb, blk_starts)` 真正落字节。`output.cpp:57-156`

这说明 Output 处理的不是“指令如何编码”这么单一的问题，而是把 prolog/epilog、块起始偏移、bundling、OopMap、stack bang、重定位和最终缓冲区布局一起压进最终产物。

因此，理想图优化完以后还缺的不只是目标指令形式，还缺**完整的可执行方法壳子**。这层壳子正是 Output 在补。

---

## 6. peephole 空实现反而说明：C2 的主要后端聪明劲不在这里

很多人看到后端，就会自然期待一种“最后再来一轮 peephole，把零碎 mov/NOP 收一收”的优化画面。JDK 11 的 x86 C2 恰恰反过来给了一个很好的提醒：`MachNode::peephole` 默认返回 `NULL`。`machnode.cpp:413-416`

这并不是说后端没有任何小修饰，而是在告诉你：**C2 的主要后端聪明劲并不寄托在最后一层 peephole 补丁上。**

真正影响机器码形态的大头，已经在更早的层次决定了：

- `.ad` 规则决定能不能把一棵子树压成更便宜的机器模式；
- Matcher 决定选哪条规则；
- GCM 和块布局决定这些模式如何排列；
- RA 决定值如何占寄存器和栈槽。

如果这些都做好了，peephole 即便存在，也只是最后小修；如果这些没做好，peephole 根本救不回来。

---

## 7. 把四件事收回到同一个主线：平台语义降级

现在可以把 `.ad`、Matcher、GCM 和 Output 收成一条线了。

- `.ad` 负责声明平台规则：什么理想子图可以匹配成什么机器模式、成本是多少、怎么编码；
- Matcher 负责在这些规则里做“标注 + 最小成本归约”，把 Ideal Graph 子树压成 `MachNode`；
- GCM 与块布局负责决定这些机器节点按什么频率和顺序出现；
- Output 则把 prolog/epilog、OopMap、bundling 和字节布局都补齐，最终真正写进 `CodeBuffer`。

这四件事的共同目标不是“最后做一下翻译”，而是：**把平台无关图语义逐层降成平台相关机器语义。**

---

## 8. 误解澄清与收网

1. **理想图和寄存器都准备好了，就能直接发码吗?** 不能。还缺平台模式选择、调度/布局、重定位与方法壳子落地。
2. **Matcher 只是节点名翻译器吗?** 不是。它对理想子树做状态标注，再按最小成本归约成 `MachNode`。
3. **GCM 只是“美化块顺序”吗?** 不是。它在做全局代码调度和热点路径布局优化。
4. **Output 只是遍历 MachNode 调 emit 吗?** 不是。它要一起补上 prolog/epilog、BuildOopMaps、bundling 和最终缓冲区布局。
5. **peephole 是后端聪明劲的大头吗?** 不是。x86 路径里它几乎是空的，真正的大头在 `.ad` / Matcher / GCM / RA 这些更早层次。

把这一篇压成三句话：

- **Matcher/GCM/Output 解决的不是翻译节点，而是把图彻底变成目标机方法。**
- **Matcher 负责子树到机器模式的最小成本归约，GCM 负责顺序和布局，Output 负责把完整方法壳子落地。**
- **C2 后端的主要聪明劲不在最后的 peephole，而在前面几层对平台语义的逐层降级。**

下一篇: `PhaseMacroExpand`——前面故意没降掉的高层宏节点，怎么在真正发码前被展开成更低层的 MachNode 世界。

> → [15-c2-compiler/07 — `PhaseMacroExpand`：高层抽象→低层 MachNode 展开](07-c2-macro-intrinsics.md)