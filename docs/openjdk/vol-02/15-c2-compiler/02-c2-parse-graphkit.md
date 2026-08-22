# 02. Ideal Graph 是怎么长出来的？— `Parse + GraphKit`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 C2 前端如何把字节码一步步灌进 Ideal Graph：`Parse` 如何像抽象解释器一样推进 JVMState，`GraphKit` 如何把控制、内存、异常和 safepoint 状态织进图里。后续优化引擎（IGVN/CCP/EA）放到下一篇。
>
> **前置依赖**：[15-c2-compiler/01 — 为什么 C2 要换世界观？— `Ideal Graph = Node + Type + IGVN`](01-c2-ideal-graph.md)、[12-ci/02 — `ciTypeFlow + BCEscapeAnalyzer`](../12-ci/02-ci-typeflow-escape.md)、[13-jit-framework/01 — `CompileBroker` 编译队列](../13-jit-framework/01-compile-broker-queue.md)
> → **后续**：[15-c2-compiler/03 — `IGVN + CCP + Escape Analysis`：C2 优化三引擎](03-c2-optimizations.md)

上一篇我们把 C2 的世界观立住了：它不用 C1 那种“块 + 指令”的块式 IR，而是先换成一张统一的 Ideal Graph，再让 `Node + Type + IGVN` 互相推动，把优化推到全局不动点。

但那一篇讲的还是“图长成以后”会发生什么。真正更原始的问题还没回答：**这张图到底是怎么长出来的？**

字节码明明还是一条条栈机器指令。`iload`、`ifnull`、`invokevirtual`、`new`、异常表、safepoint、内联、OSR——这些东西怎么会变成一张统一控制/数据/内存边的 Ideal Graph？

答案不在一个“节点工厂”里，而在两个角色的配合里：

- `Parse` 像一台抽象解释器，沿着字节码和基本块推进当前 JVM 状态；
- `GraphKit` 则把这份 JVM 状态投影到图里：当前控制点是谁、当前内存切片是谁、当前局部变量和表达式栈上是什么节点、异常和 safepoint 又该如何保留。

所以，本篇真正要回答的问题不是“Parse 有哪些函数”，而是：

**为什么 Parse 既像解释器、又像图构造器？GraphKit 又为什么必须维护一整份 JVMState map，而不是像普通 builder 一样只管 new 节点连边？**

先把答案压成一句人话：**C2 前端不是“顺序读字节码然后随手建图”，而是像解释器一样一步步推进抽象执行状态；区别只是，解释器推进的是具体值，Parse 推进的是由节点组成的 JVMState，而 GraphKit 负责把这份状态编进图里。**

---

## 1. 先试两个最自然的理解，看看为什么都不对

### 误解一：Parse 只是顺序读字节码、new 节点

这是最容易想象的模型：读到 `iload` 就建个 load 节点，读到 `iadd` 就建个加法节点，读到 `ifnull` 就建个判断节点，顺着字节码一路拼下去，最后自然就得到一张图。

问题在于，C2 前端面对的不是一条单一路径。

字节码有基本块、有分支、有异常边、有回边、有 OSR 入口，还有内联后套进来的 callee 方法。你如果只是“顺序 new 节点”，马上就会遇到几个无法回避的问题：

- 分支汇合时，局部变量和表达式栈的状态怎么合并？
- 某条路径被证明永远走不到时，图该在哪里停下？
- 调用点如果被内联，callee 的局部变量、返回值和异常状态怎么接回 caller？
- 回边 safepoint 为什么只在某些地方插，而不是每条边都插？
- 当前内存状态到底指向哪一个 `MergeMemNode` 切片？

这说明 Parse 真正维护的不是“当前建到第几个节点”，而是“当前 JVM 抽象执行状态是什么”。节点只是这份状态的一种物理表达。

### 误解二：GraphKit 只是一个写图方便的小工具类

第二个误解也很常见：既然 Parse 是前端主角，那 GraphKit 可能只是帮忙封装一些 `new AddINode`、`make_load`、`set_control` 之类便捷 API 的工具箱。

这只说对了一层表面。

GraphKit 真正重要的不是“省几行代码”，而是它手里握着当前 `JVMState` 的 map。当前控制边是什么、当前内存状态是什么、locals/stack/monitor 在 map 上落在哪些槽位、当前 safepoint 需要附哪些 JVMState 边——这些都不是“节点工厂”会关心的事，却是 Parse 必须随时维护的前端世界状态。

所以 GraphKit 不是 builder 的语法糖，它是 Parse 手里的**状态管理器**。没有这层，C2 就很难在建图期同时保住 Java 语义、内存语义和去优化恢复语义。

---

## 2. Parse 不是线性扫描字节码，而是按基本块驱动建图

C2 前端并不是从 bci 0 读到 return 就完了。`Parse` 构造时就先拿到 `ciTypeFlow` 给出的块骨架：

- `_tf = TypeFunc::make(method())`
- `_iter.reset_to_method(method())`
- `_flow = method()->get_flow_analysis()`。`parse1.cpp:425-427`

也就是说，Parse 一开始就不是“毫无结构地解释字节码”，而是站在一份已经分析好的控制流骨架上工作。

随后它会 `init_blocks()`、`build_exits()`、`create_entry_map()`，再把方法入口块当成第一次 merge 的目标，然后进入 `do_all_blocks()`。`parse1.cpp:549-603`

`do_all_blocks()` 的主循环按逆后序（RPO）扫所有块。只有那些已经 merge 成功、而且还没解析过的块，才会被 `load_state_from(block)` 后交给 `do_one_block()`。死块直接跳过；在不可归约循环场景下，还可能需要多轮扫描才能把所有块都解析完。`parse1.cpp:631-712`

这里最值得记住的是：**Parse 的最小工作单元不是“下一条字节码”，而是“在当前 JVMState 下，解析一个已准备好的基本块”。**

---

## 3. `do_one_block` / `do_one_bytecode`：像解释器一样推进状态，像编译器一样建节点

真正的解析动作发生在 `do_one_block()` 里。它会反复：

- 调整迭代器到当前 bci；
- 更新 `parse_bci`；
- 如果到达块尾，就 `merge(bci())` 并停下；
- 否则调用 `do_one_bytecode()`；
- 处理异常边；
- 再继续下一条字节码。`parse1.cpp:1489-1534`

这段结构很像解释器循环，但 `do_one_bytecode()` 干的已经不是“执行指令”，而是“把这条指令对当前 JVMState 的影响翻成图上的状态变化”。

有些字节码甚至几乎不生成新节点。比如 `iload`/`fload` 系列只是把当前 local 槽位上的节点压回表达式栈：`push(local(i))`。也就是说，C2 前端的表达式栈装的不是数值，而是节点引用。`parse2.cpp:2014-2021`

而像 `iadd` 这种真正创建新值的 bytecode，才会显式 `new AddINode(a, b)`，并且不是先把节点原样挂上去，而是立刻交给 `_gvn.transform(...)`。这又把上一篇的 Ideal Graph 逻辑接回来了：**建图和初步理想化从一开始就是交织在一起的。** `parse2.cpp:2250-2252`

控制流字节码更能体现“解释器式推进 + 图构造”的双重身份。`do_ifnull()` 和 `do_if()` 先根据 profile 得到分支概率，再建 `BoolNode`、`IfNode`、`IfTrueNode` / `IfFalseNode`，接着分别带着当前状态沿 taken / untaken 路继续推进，最后在目标 bci 处 `merge()`。如果某条边被判定为冷到不值得编，就直接 `uncommon_trap` 停掉那条路径。`parse2.cpp:1449-1602`

所以 `do_one_bytecode()` 的本质不是“翻译指令”，而是：**根据这条字节码的 Java 语义，改写当前 JVMState map，并把改写投影到 Ideal Graph 上。**

---

## 4. 内联不是建图后的优化阶段，而是建图方式本身的一部分

在 C2 里，调用点最有代表性地暴露了这个世界观。`do_call()` 当然会先做一大串现场准备：清理死 locals、解析 callee、看 receiver、暂时弹出参数，把当前状态同步成可交给 call generator 的 `JVMState`。但这些准备动作都不是重点；真正的分水岭只有一个：**这个调用点接下来是保留成调用边界，还是递归触发一次新的 Parse。** `doCall.cpp:423-555`

关键判断在 `call_generator()`。它不是“调用以后再决定是否内联”，而是在建图时就决定：这个调用点到底是保持调用边界，还是直接把 callee 的字节码铺进 caller 的图。

如果它选中的是 `ParseGenerator`，那接下来的动作不是“做个内联替换 pass”，而是直接 `new Parse(jvms, method(), _expected_uses)`，递归建出 callee 的整张子图，再通过 `transfer_exceptions_into_jvms()` 把异常状态接回 caller。也就是说，**内联一旦成立，callee 从这一刻起就不再是“一个将来可能被展开的调用”，而已经是 caller 图的一部分。** `callGenerator.cpp:84-110`

这就是为什么“内联”在 C2 里更应该被理解成一种**建图方式**，而不是单独的“后优化阶段”。

---

## 5. GraphKit 的核心不是“new 节点”，而是维护当前 JVMState map

如果说 Parse 是“按字节码推进状态”的那一层，那么 GraphKit 就是这份状态在图里的具体载体。

最核心的对象是 `_map`，但更精确地说：GraphKit 当前持有的是一份 **附着在 `SafePointNode` 上的 JVMState 映射**。`JVMState` 自己记录 locals/stack/args/monitors/scalars 在 map 上的槽位区间，而 `map()` 则给出承载这些槽位的 `SafePointNode*`。`callnode.hpp:215-296`

这就是为什么 GraphKit 绝不是一个“省几行 new Node” 的 helper。它持有的是**当前 Java 抽象执行状态**：

- `control()` 指向当前控制边；
- `memory(alias_idx)` 指向当前别名类别的内存状态；
- 局部变量和表达式栈都是 map 上的节点槽位；
- monitor 与 scalar replacement 信息也挂在这张 map 上。

`memory(alias_idx)` 不是“随便找一条内存边”，而是从当前 `MergeMemNode` 里按别名类别取对应切片，再把它类型标成 `Type::MEMORY`。`graphKit.cpp:1477-1571`

这一步最值得记住的一句话是：**GraphKit 不是节点工厂，而是图状态管理器。**

---

## 6. safepoint 和异常边为什么必须在 Parse 期就接进图

如果 Parse 只负责建纯业务节点，而把 safepoint、异常、去优化这些东西留给后处理，再晚点补，其实会更简单。但 C2 不能这么干，因为这些语义本来就是程序状态的一部分。

`safepoint` 就是最典型的例子。`add_safepoint()` 会先判断当前控制后面是不是紧跟着一个 guaranteed safepoint 的 call 或已有 SafePoint；如果是，就不重复插。否则它会：

- `kill_dead_locals()` 清理调试状态里的死值；
- 克隆当前内存状态成新的 `MergeMemNode`；
- 创建 `SafePointNode`；
- 接上 control / IO / memory / ReturnAdr / FramePtr；
- 按需接入轮询页地址；
- 最后把整条 JVMState 边挂到这个 safepoint 上。`parse1.cpp:2234-2300`

这里最关键的是：**Parse 期挂上的是 JVMState 边，而不是机器级 OopMap。** 它保留的是“当前 Java 语义状态是什么”。真正的机器级 OopMap 还要等寄存器分配后，根据值到底落在哪些寄存器和栈槽再生成。

异常边同样不是后处理。`do_one_block()` 在每条 bytecode 之后都会 `do_exceptions()`；如果当前方法根本没有 handler，就直接 `throw_to_exit(ex_map)` 向外层出口合并；若有 handler，则 `catch_inline_exceptions(ex_map)` 把异常状态接入当前图。调用内联后，异常状态又通过 `transfer_exceptions_into_jvms()` 并回 caller。也就是说，“图上有没有异常出口、当前路径是不是直接 `uncommon_trap` 了”，从 Parse 期开始就是图的组成部分。

---

## 7. OSR 更能说明 Parse 维护的是“状态”，不是“从头翻译源码”

如果 Parse 只是“从方法头顺序翻译字节码”，那 OSR 就会变得很难解释。因为 OSR 编译不是从 bci 0 进入，而是从某个循环中间开始接手。

源码里这件事处理得非常明确：顶层 parse 如果是 OSR，会改用 `get_osr_flow_analysis(osr_bci())`，并把 `_tf` 换成 OSR 专用 `TypeFunc`。随后从 `entry_map` 里拿出 OSR buffer，再调用 `load_interpreter_state(osr_buf)` 把解释器此刻的 locals、stack 和 monitor 状态导入当前 JVMState。`parse1.cpp:505-574`

这一步特别有说服力：**Parse 不是简单地从字节码文本生成图，它真正需要的是“当前 Java 执行状态”。** OSR 只是把这个事实暴露得更明显——入口不是方法头，而是解释器已经跑到的中间状态。

---

## 8. 误解澄清与收网

1. **Parse 只是顺序 new 节点吗?** 不是。它按基本块和 JVMState 推进,不是线性直译器。
2. **GraphKit 只是语法糖吗?** 不是。它持有附着在 `SafePointNode` 上的 JVMState map，是当前图状态管理器。
3. **内联是建图后的优化阶段吗?** 不是。内联是建图方式本身的一部分，callee 图会直接铺进 caller。
4. **safepoint / 异常边可以后补吗?** 不能。它们是程序状态的一部分，从 Parse 期就必须接进图。
5. **OSR 只是普通 parse 从中间开始吗?** 不止。它要先把解释器当前 locals/stack/monitor 状态导入 JVMState。

把这一篇压成三句话：

- **Parse 像解释器一样推进 JVMState**，只是推进的是节点化的抽象状态而不是具体值。
- **GraphKit 把这份 JVMState 织进 Ideal Graph**，控制、内存、异常和 safepoint 从出生开始就属于同一张图。
- **内联、OSR、异常和 safepoint 都是建图方式的一部分**，不是后面再补的附属信息。

下一篇: `IGVN + CCP + Escape Analysis`——既然图和状态已经完整接进来了，优化三引擎如何在这张图上推到全局不动点。

> → [15-c2-compiler/03 — `IGVN + CCP + Escape Analysis`：C2 优化三引擎](03-c2-optimizations.md)