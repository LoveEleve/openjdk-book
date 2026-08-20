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

## 先试两个最自然的理解，看看为什么都不对

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

## Parse 不是线性扫描字节码，而是按基本块驱动建图

C2 前端并不是从 bci 0 读到 return 就完了。`Parse` 构造时就先拿到 `ciTypeFlow` 给出的块骨架：

- `_tf = TypeFunc::make(method())`
- `_iter.reset_to_method(method())`
- `_flow = method()->get_flow_analysis()` `share/opto/parse1.cpp:425`、`share/opto/parse1.cpp:426`、`share/opto/parse1.cpp:427`

也就是说，Parse 一开始就不是“毫无结构地解释字节码”，而是站在一份已经分析好的控制流骨架上工作。

随后它会 `init_blocks()`、`build_exits()`、`create_entry_map()`，再把方法入口块当成第一次 merge 的目标，然后进入 `do_all_blocks()`。`share/opto/parse1.cpp:549`、`share/opto/parse1.cpp:550`、`share/opto/parse1.cpp:552`、`share/opto/parse1.cpp:555`、`share/opto/parse1.cpp:556`、`share/opto/parse1.cpp:600`、`share/opto/parse1.cpp:603`

`do_all_blocks()` 的主循环按逆后序（RPO）扫所有块。只有那些已经 merge 成功、而且还没解析过的块，才会被 `load_state_from(block)` 后交给 `do_one_block()`。死块直接跳过；在不可归约循环场景下，还可能需要多轮扫描才能把所有块都解析完。`share/opto/parse1.cpp:631`、`share/opto/parse1.cpp:635`、`share/opto/parse1.cpp:638`、`share/opto/parse1.cpp:641`、`share/opto/parse1.cpp:643`、`share/opto/parse1.cpp:649`、`share/opto/parse1.cpp:659`、`share/opto/parse1.cpp:705`、`share/opto/parse1.cpp:712`

这里最值得记住的是：**Parse 的最小工作单元不是“下一条字节码”，而是“在当前 JVMState 下，解析一个已准备好的基本块”。**

这正是它和解释器最大的相似之处：解释器也必须知道当前控制流来到哪里、局部变量和栈上有哪些值，只不过它推进的是真实值，而 Parse 推进的是节点化的抽象状态。

## `do_one_block` / `do_one_bytecode`：像解释器一样推进状态，像编译器一样建节点

真正的解析动作发生在 `do_one_block()` 里。它会反复：

- 调整迭代器到当前 bci；
- 更新 `parse_bci`；
- 如果到达块尾，就 `merge(bci())` 并停下；
- 否则调用 `do_one_bytecode()`；
- 处理异常边；
- 再继续下一条字节码。源码里的主循环就长这样：先 `iter().next()`，再 `set_parse_bci(iter().cur_bci())`，遇到块尾 `merge(bci())`，若 type flow 预判这里必 trap 就直接 `uncommon_trap(trap_index)`，否则执行 `do_one_bytecode()` 再 `do_exceptions()`。`share/opto/parse1.cpp:1489`、`share/opto/parse1.cpp:1491`、`share/opto/parse1.cpp:1494`、`share/opto/parse1.cpp:1496`、`share/opto/parse1.cpp:1498`、`share/opto/parse1.cpp:1511`、`share/opto/parse1.cpp:1516`、`share/opto/parse1.cpp:1529`、`share/opto/parse1.cpp:1534`

这段结构很像解释器循环，但 `do_one_bytecode()` 干的已经不是“执行指令”，而是“把这条指令对当前 JVMState 的影响翻成图上的状态变化”。

有些字节码甚至几乎不生成新节点。比如 `iload`/`fload` 系列只是把当前 local 槽位上的节点压回表达式栈：`push(local(i))`。也就是说，C2 前端的表达式栈装的不是数值，而是节点引用。`share/opto/parse2.cpp:2014`、`share/opto/parse2.cpp:2015`、`share/opto/parse2.cpp:2020`、`share/opto/parse2.cpp:2021`

而像 `iadd` 这种真正创建新值的 bytecode，才会显式 `new AddINode(a, b)`，并且不是先把节点原样挂上去，而是立刻交给 `_gvn.transform(...)`。这又把上一篇的 Ideal Graph 逻辑接回来了：**建图和初步理想化从一开始就是交织在一起的。** `share/opto/parse2.cpp:2250`、`share/opto/parse2.cpp:2251`、`share/opto/parse2.cpp:2252`

控制流字节码更能体现“解释器式推进 + 图构造”的双重身份。`do_ifnull()` 和 `do_if()` 先根据 profile 得到分支概率，再建 `BoolNode`、`IfNode`、`IfTrueNode` / `IfFalseNode`，接着分别带着当前状态沿 taken / untaken 路继续推进，最后在目标 bci 处 `merge()`。如果某条边被判定为冷到不值得编，就直接 `uncommon_trap` 停掉那条路径。`share/opto/parse2.cpp:1449`、`share/opto/parse2.cpp:1456`、`share/opto/parse2.cpp:1468`、`share/opto/parse2.cpp:1482`、`share/opto/parse2.cpp:1491`、`share/opto/parse2.cpp:1503`、`share/opto/parse2.cpp:1505`、`share/opto/parse2.cpp:1529`、`share/opto/parse2.cpp:1602`

所以 `do_one_bytecode()` 的本质不是“翻译指令”，而是：**根据这条字节码的 Java 语义，改写当前 JVMState map，并把改写投影到 Ideal Graph 上。**

## 内联不是建图后的优化阶段，而是建图方式本身的一部分

在 C2 里，调用点最有代表性地暴露了这个世界观。`do_call()` 当然会先做一大串现场准备：清理死 locals、解析 callee、看 receiver、暂时弹出参数，把当前状态同步成可交给 call generator 的 `JVMState`。但这些准备动作都不是重点；真正的分水岭只有一个：**这个调用点接下来是保留成调用边界，还是递归触发一次新的 Parse。** `share/opto/doCall.cpp:423`、`share/opto/doCall.cpp:427`、`share/opto/doCall.cpp:439`、`share/opto/doCall.cpp:504`、`share/opto/doCall.cpp:548`、`share/opto/doCall.cpp:549`

关键判断在 `call_generator()`。它不是“调用以后再决定是否内联”，而是在建图时就决定：这个调用点到底是保持调用边界，还是直接把 callee 的字节码铺进 caller 的图。`share/opto/doCall.cpp:551`、`share/opto/doCall.cpp:553`、`share/opto/doCall.cpp:555`

如果它选中的是 `ParseGenerator`，那接下来的动作不是“做个内联替换 pass”，而是直接 `new Parse(jvms, method(), _expected_uses)`，递归建出 callee 的整张子图，再通过 `transfer_exceptions_into_jvms()` 把异常状态接回 caller。也就是说，**内联一旦成立，callee 从这一刻起就不再是“一个将来可能被展开的调用”，而已经是 caller 图的一部分。** `share/opto/callGenerator.cpp:84`、`share/opto/callGenerator.cpp:97`、`share/opto/callGenerator.cpp:99`、`share/opto/callGenerator.cpp:108`、`share/opto/callGenerator.cpp:110`

这就是为什么“内联”在 C2 里更应该被理解成一种**建图方式**，而不是单独的“后优化阶段”。一旦内联决定通过，调用边界在图刚出生的时候就已经消失了，后面的 IGVN、CCP、EA 才能在 caller/callee 跨方法范围内继续传播。

## GraphKit 的核心不是“new 节点”，而是维护当前 JVMState map

如果说 Parse 是“按字节码推进状态”的那一层，那么 GraphKit 就是这份状态在图里的具体载体。

最核心的对象是 `_map`，但更精确地说：GraphKit 当前持有的是一份 **附着在 `SafePointNode` 上的 JVMState 映射**。`JVMState` 自己记录 locals/stack/args/monitors/scalars 在 map 上的槽位区间，而 `map()` 则给出承载这些槽位的 `SafePointNode*`。也就是说，`_map` 不是“JVMState 本身”，而是 JVMState 在图里的物理载体。`share/opto/callnode.hpp:230`、`share/opto/callnode.hpp:231`、`share/opto/callnode.hpp:233`、`share/opto/callnode.hpp:234`、`share/opto/callnode.hpp:235`、`share/opto/callnode.hpp:236`、`share/opto/callnode.hpp:237`、`share/opto/callnode.hpp:238`、`share/opto/callnode.hpp:257`、`share/opto/callnode.hpp:258`、`share/opto/callnode.hpp:296`

这就是为什么 GraphKit 绝不是一个“省几行 new Node” 的 helper。它持有的是**当前 Java 抽象执行状态**：

- `control()` 指向当前控制边；
- `memory(alias_idx)` 指向当前别名类别的内存状态；
- 局部变量和表达式栈都是 map 上的节点槽位；
- monitor 与 scalar replacement 信息也挂在这张 map 上。

一旦理解这一点，GraphKit 的很多函数就显得非常自然。比如 `memory(alias_idx)` 不是“随便找一条内存边”，而是从当前 `MergeMemNode` 里按别名类别取对应切片，再把它类型标成 `Type::MEMORY`。`share/opto/graphKit.cpp:1477`、`share/opto/graphKit.cpp:1478`、`share/opto/graphKit.cpp:1479`、`share/opto/graphKit.cpp:1480`

进一步看，`make_load()` 和 `store_to_memory()` 也不是单纯 new 一个 load/store 节点。它们会先从当前 map 里取出对应 alias slice，再建节点、transform 节点、必要时把结果重新登记进 GVN 或 map。也就是说，这些 helper 真正维护的是“当前程序点的图上内存状态”。`share/opto/graphKit.cpp:1514`、`share/opto/graphKit.cpp:1525`、`share/opto/graphKit.cpp:1532`、`share/opto/graphKit.cpp:1534`、`share/opto/graphKit.cpp:1542`、`share/opto/graphKit.cpp:1552`、`share/opto/graphKit.cpp:1570`、`share/opto/graphKit.cpp:1571`

这一步最值得记住的一句话是：**GraphKit 不是节点工厂，而是图状态管理器。**

## MergeMem：C2 为什么连“内存流”都要切片挂在图上

在 C2 里，内存不是一根笼统的“当前内存状态”链，而是按 alias category 切片。GraphKit 每次 `memory(alias_idx)` 取的是某个特定别名类别的切片，`store_to_memory()` 也只更新对应切片，再把它重新挂回 map。`share/opto/graphKit.cpp:1477`、`share/opto/graphKit.cpp:1493`、`share/opto/graphKit.cpp:1501`、`share/opto/graphKit.cpp:1571`

这件事特别重要，因为它让 C2 可以在图层面把“对象字段内存”“数组元素内存”“raw memory”等不同内存类别隔离开。一个数组元素 store 不必污染所有字段 load；一条不相干的内存边也不该挡住另一类访问的优化。

所以 MergeMem 不是一个实现细节，而是 C2 把“内存流也图化”的核心装置。没有它，Ideal Graph 就只能在控制和数据上统一，内存依赖仍然得靠旁路结构维护。

## safepoint 和异常边为什么必须在 Parse 期就接进图

如果 Parse 只负责建纯业务节点，而把 safepoint、异常、去优化这些东西留给后处理，再晚点补，其实会更简单。但 C2 不能这么干，因为这些语义本来就是程序状态的一部分。

`safepoint` 就是最典型的例子。`add_safepoint()` 会先判断当前控制后面是不是紧跟着一个 guaranteed safepoint 的 call 或已有 SafePoint；如果是，就不重复插。否则它会：

- 先 `kill_dead_locals()` 清理调试状态里的死值；
- 克隆当前内存状态成新的 `MergeMemNode`；
- 创建 `SafePointNode`；
- 接上 control / IO / memory / ReturnAdr / FramePtr；
- 按需接入轮询页地址；
- 最后把整条 JVMState 边挂到这个 safepoint 上。 `share/opto/parse1.cpp:2234`、`share/opto/parse1.cpp:2246`、`share/opto/parse1.cpp:2247`、`share/opto/parse1.cpp:2254`、`share/opto/parse1.cpp:2257`、`share/opto/parse1.cpp:2273`、`share/opto/parse1.cpp:2278`、`share/opto/parse1.cpp:2286`、`share/opto/parse1.cpp:2298`、`share/opto/parse1.cpp:2300`

这里最关键的是：**Parse 期挂上的是 JVMState 边，而不是机器级 OopMap。** 它保留的是“当前 Java 语义状态是什么”。真正的机器级 OopMap 还要等寄存器分配后，根据值到底落在哪些寄存器和栈槽再生成。

异常边同样不是后处理。`do_one_block()` 在每条 bytecode 之后都会 `do_exceptions()`；如果当前方法根本没有 handler，就直接 `throw_to_exit(ex_map)` 向外层出口合并；若有 handler，则 `catch_inline_exceptions(ex_map)` 把异常状态接入当前图。调用内联后，异常状态又通过 `transfer_exceptions_into_jvms()` 并回 caller。也就是说，“图上有没有异常出口、当前路径是不是直接 `uncommon_trap` 了”，从 Parse 期开始就是图的组成部分。`share/opto/parse1.cpp:905`、`share/opto/parse1.cpp:917`、`share/opto/parse1.cpp:918`、`share/opto/parse1.cpp:922`、`share/opto/parse1.cpp:926`、`share/opto/callGenerator.cpp:108`、`share/opto/callGenerator.cpp:110`

把这一段和 safepoint 放在一起看，就能看出一条更统一的线：**Parse 期接进图的并不只是“业务节点”，而是整份 Java 运行时状态骨架——正常路径、异常路径、safepoint 恢复点都从出生开始就是图的一部分。** 这正是 Parse 像解释器的另一个侧面：它不只是知道“下一条指令是什么”，它还在不断问“这条路径现在是不是已经死了”“这一步会不会把状态带到异常出口”“当前 map 还能不能继续往下推”。

## OSR 更能说明 Parse 维护的是“状态”，不是“从头翻译源码”

如果 Parse 只是“从方法头顺序翻译字节码”，那 OSR 就会变得很难解释。因为 OSR 编译不是从 bci 0 进入，而是从某个循环中间开始接手。

源码里这件事处理得非常明确：顶层 parse 如果是 OSR，会改用 `get_osr_flow_analysis(osr_bci())`，并把 `_tf` 换成 OSR 专用 `TypeFunc`。随后从 `entry_map` 里拿出 OSR buffer，再调用 `load_interpreter_state(osr_buf)` 把解释器此刻的 locals、stack 和 monitor 状态导入当前 JVMState。`share/opto/parse1.cpp:505`、`share/opto/parse1.cpp:507`、`share/opto/parse1.cpp:521`、`share/opto/parse1.cpp:570`、`share/opto/parse1.cpp:571`、`share/opto/parse1.cpp:574`

这一步特别有说服力：**Parse 不是简单地从字节码文本生成图，它真正需要的是“当前 Java 执行状态”。** OSR 只是把这个事实暴露得更明显——入口不是方法头，而是解释器已经跑到的中间状态。

## 收网：Parse 像解释器一样推进状态，GraphKit 像图态管理器一样把状态接进图

现在可以把整篇压成一张总图了。

C2 的 Ideal Graph 不是自动长出来的。`Parse` 先站在 `ciTypeFlow` 给出的块骨架上，按 RPO 驱动逐块解析；块内再由 `do_one_bytecode()` 像解释器一样推进当前抽象执行状态：有些字节码只是移动 map 上已有节点，有些会立即 `_gvn.transform(new Node)`，分支会拆路径并在 `merge()` 处会合，内联则直接递归 `new Parse(...)` 把 callee 图铺进 caller 图。与此同时，`GraphKit` 维护的 `JVMState` map 始终跟着走：control、memory、locals、stack、monitors、safepoint 和异常边都不是后补的旁路信息，而是图本身的一部分。`share/opto/parse1.cpp:427`、`share/opto/parse1.cpp:631`、`share/opto/parse2.cpp:2250`、`share/opto/doCall.cpp:548`、`share/opto/callGenerator.cpp:97`、`share/opto/graphKit.cpp:1477`、`share/opto/parse1.cpp:2234`、`share/opto/callnode.hpp:230`

所以，这一篇最核心的一句话不是“Parse 负责建图，GraphKit 负责辅助”，而是：

**Parse 像解释器一样推进 JVMState，GraphKit 把这份 JVMState 织进 Ideal Graph，于是字节码语义、控制流、内存流、异常和 safepoint 从出生开始就属于同一张图。**

只要这句抓住了，下一篇优化三引擎就好理解了：IGVN、CCP、Escape Analysis 之所以能在图上做全局工作，前提正是这张图从一开始就已经把 Java 语义状态完整地接进来了。

> → [15-c2-compiler/03 — `IGVN + CCP + Escape Analysis`：C2 优化三引擎](03-c2-optimizations.md)
