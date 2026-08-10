# C2 Compiler 第一遍产出：激进优化编译器

> vol-04 · 域 29 · 🔴 A | Pass 1 扫描完成
> 源码：`opto/` 129文件, 139595行

## 核心架构图

```
Parse (GraphKit)
  │  bytecode → Sea-of-Nodes graph
  │  InlineTree: 多层内联管理
  │  CallGenerator: 各种调用的策略对象
  ▼
PhaseIterGVN (全局值编号+理想化)
  │  每个Node有Ideal()方法 → 返回简化等价Node
  │  "iterative": 反复应用直到不动点
  ▼
PhaseIdealLoop (循环优化)
  │  循环展开 / 谓词化 / 向量化 / 范围检查消除
  │  识别CountedLoop → 分析步长/边界 → 激进变换
  ▼
PhaseMacroExpand (宏展开)
  │  AllocateNode → TLAB fast path / slow call
  │  LockNode → 粗化 + fast/slow lock
  │  ArrayCopyNode → intrinsic dispatch
  ▼
ConnectionGraph (逃逸分析)
  │  跟踪对象的引用传播 → 标量替换
  │  EliminateLocks: 消除无竞争的锁
  ▼
PhaseChaitin (图着色寄存器分配)
  │  Build IFG → Coalesce → Color → Spill
  │  Briggs-Chaitin 风格: 乐观着色
  ▼
Matcher (指令选择)
  │  AD文件→MachNode DFA→指令发射
  ▼
Output (代码生成)
  │  CodeBuffer → nmethod → CodeCache

内存模型: Node(数据) + Type(类型) + Ideal(理想化) 三要素
  ├── Control edge: 控制流依赖
  ├── Data edge: 数据流依赖  
  └── Memory edge: 内存排序依赖
```

## 基本元素分解

1. **Compile** — 一次 C2 编译的全局上下文。持有 ideal graph(_root/_start)、Type 表、PhaseGVN/IGVN、InlineTree、ConnectionGraph。主流程：Parse → Inline → IGVN → IdealLoop → MacroExpand → Escape Analysis → Chaitin → Matcher → Output。`compile.hpp`

2. **Node** — Sea-of-Nodes 的基础节点。每个 Node 有多个输入边(in)、Type(`bottom()`)、`Ideal()`(返回简化等价Node)。关键概念：Node 不知道自己属于哪个 block——block 是 PhaseCFG 阶段后期分配的。"Sea-of-Nodes"的意思就是"所有节点漂浮在理想图海中，通过边连接，没有基本块的边界"。`node.hpp`

3. **PhaseIterGVN** — 迭代全局值编号。维护 hash table，hash → 相同操作的节点共享同一值。`transform()` 先 hash_find → 找到等价节点就替换 → 找不到就 Ideal() 简化 → 再次 hash（可能产生新的等价节点）。"Iter"就是反复执行直到不动点——每次 Ideal() 可能打开新的优化窗口。`phaseX.hpp`

4. **GraphKit** — 理想图构建工具包。提供 `store_to_memory()`、`load_from_memory()`、`set_control()` 等高级操作，隐藏了 Sea-of-Nodes 内存依赖链的复杂性。每个 Java 字节码对应 GraphKit 中的几个 Node 操作。`graphKit.hpp`

5. **PhaseIdealLoop** — 循环优化引擎。识别 CountedLoop（有明确步长和边界的循环），应用：循环展开(unrolling)、循环谓词化(predication)向循环外提升范围检查、向量化(vectorization)识别 SIMD 模式、剥离(peeling)。`loopnode.hpp`

6. **ConnectionGraph** — 逃逸分析的连接图。从 AllocateNode 出发，跟踪对象引用是否逃逸出当前方法。NoEscape → 标量替换（对象字段变成局部变量）、ArgEscape → 无法标量替换但不能被其他线程看到（可消除锁）、GlobalEscape → 可能被任何地方引用（不做优化）。`escape.hpp`

7. **PhaseMacroExpand** — 宏节点展开。AllocateNode（`new`）展开为 TLAB 分配的汇编序列或 slow call；LockNode 展开为 fast lock（CAS mark word）或 slow call。这些是 C2 不交给 Matcher 的特殊节点——因为它们展开后变成多个 MachNode。"宏节点"= "需要分解成多个子操作的高级操作"。`macro.hpp`

8. **PhaseChaitin** — 图着色寄存器分配。Briggs-Chaitin 算法：(1) Build IFG(干涉图) — 需要同一时刻同时在寄存器中的 variables 之间有边；(2) Coalesce — 合并 copy 相关的变量减少 move；(3) Simplify — 重复删除 degree < k 的节点（k=可用寄存器数）；(4) Spill — 如果所有节点都 degree ≥ k，选一个 spill 代价最低的溢出；(5) Select — 逆序分配颜色。`chaitin.hpp`

9. **Matcher** — 平台感知的指令选择。AD 文件（`x86_64.ad`）描述了每个 MachNode 对应的机器指令模式。Matcher 用 DFA（确定有限状态自动机）从 ideal graph 中匹配模式并生成 MachNode 图——每条 MachNode 对应 1-N 条汇编指令。`matcher.hpp`

10. **InlineTree** — 多层内联管理器。树结构——根是正在编译的方法，每个子节点是一个候选内联目标。与 C1 的 ScopeData 栈的根本区别：InlineTree 支持晚内联(late inlining)——先编译外层，稍后再 inline 子树（如果 profiling 数据支持）。这是 C2 实现增量内联的关键。`callGenerator.hpp`

## 标记问题（≥5）

1. **[设计决策] Sea-of-Nodes vs CFG IR** — 为什么 C2 选择 Sea-of-Nodes 而不是 C1 的 CFG 表示？Sea-of-Nodes 对 IGVN/Floating 优化的优势是什么？代价是什么（PhaseCFG 必须后期重建 block 表示）？

2. **[关键算法] PhaseIterGVN 的不动点收敛** — 如何保证 Ideal()+hash 的反复迭代一定收敛？什么情况下 C2 会因为在两个等价形式之间"来回震荡"而失败？

3. **[设计决策] InlineTree 晚内联 vs C1 的早内联** — 为什么 C2 要在 IGVN 之后再内联一些方法？晚内联打开了什么优化窗口？代价是什么（需要反嵌已生成的代码）？

4. **[逃逸分析] ConnectionGraph 的精度和限制** — 它能分析哪些类型的逃逸？不能分析哪些？（虚拟调用？反射？数组？）和 Graal 的逃逸分析有什么精度差异？

5. **[循环优化] 循环谓词化 range check 提升** — C2 如何在循环外插入谓词来消除循环内的范围检查？这和 C1 的 RangeCheckElimination 有什么根本区别？

6. **[寄存器分配] Chaitin 的乐观着色 vs LinearScan 的悲观着色** — 图着色为什么可能 spill 比线性扫描少 2-3x？乐观着色的代价是什么（可能需要多轮 spill→rebuild IFG→recolor）？

7. **[跨域] C2 和 ci/SharedRuntime 的交互** — C2 如何通过 ci 读取 profiling 数据？如何生成 uncommon trap？SharedRuntime 的 deoptimization blob 如何在 C2 的代码中触发？

8. **[代码生成] Matcher 的 DFA 指令选择** — AD 文件如何描述指令模式？DFA 使用什么算法来匹配？当多个模式匹配同一个 subgraph 时如何消歧？
