# C2 Compiler — 文章大纲

> vol-04 · 域 29 · 🔴 A | 基于 Pass 0+1 探索笔记
> Pass 1 产出：10 基本元素 / 8 标记问题
>
> **→ 从 C1**：C1 编译的代码很快但不够激进——虚调用假设只有一种 receiver、循环展开 64 次、逃逸分析把堆分配变成栈分配——这些是 C2 的领域。C2 编译器篇见。

## 概念依赖

先修：C1（了解"快"编译器的限制）、ci（通过 ciMethodData 读 profiling 数据——C2 所有激进优化的燃料）、JIT Framework（CompileBroker 调 C2 的场景）。Interpreter 不是直接先修——C2 通过 ci 层读 MethodData，不直接碰解释器内部。

C2 是 JIT 系统中代码生成质量的终极之地。Level 4 的方法在这里被编译，使用完整的 profiling 数据驱动去虚拟化、内联、逃逸分析、循环优化和向量化。代价是编译速度慢——C2 比 C1 慢 5-10x，但生成的代码快 2-3x。

## 叙事计划

**开篇场景**：一个方法跑完了 Level 3（C1+全 profiling），`TieredThresholdPolicy` 判定"值得让 C2 做一次完整的激进编译"。CompileBroker 分配了一个 C2 编译器线程。现在，这个线程有 profiling 数据、有字节码、有"不在乎编译时间"的授权——它会做什么？答案是：把代码放进一个巨大的图里，然后一遍遍地"压扁"这个图。

**第一层：Sea-of-Nodes — 代码变成一个巨大的图**

C2 的核心直觉：**所有代码都是图**。不是 C1 的基本块链，不是 JVM 字节码，而是一个无固定 block 边界的 `Node` 图——每个 `Node` 有输入边（`in(i)`），输出到其他 Node。图中有三种边：

| 边类型 | 语义 | 例子 |
|------|------|------|
| Control edge | "必须先执行这个才能执行我" | IfNode → IfTrue/IfFalse |
| Data edge | "我的输入数据由这个 Node 产生" | AddNode(x, y) 的 x/y 边 |
| Memory edge | "在这个内存操作之前必须完成那个内存操作" | Store→Load 的 memory ordering |

同一个图中混合三种边 = "Sea of Nodes"——Node 不局部于任何 block，可以在 PhaseCFG 阶段后期"浮动"到任意 block。"浮动"能力是 C2 许多优化的基础——一个纯算术 Node（如 `AddI`）最初挂在 IfTrue 分支下，但如果它的两个输入都不依赖控制流，它可以"浮"到 IfTrue 之前执行。

`root()` 是所有控制/内存的最终祖先，`top()` 是"死路径"的标记（类似 C1 的不可达块）。整个图从 root 往下走控制流，从 start 往下走数据流，从内存根往下走内存序——三个视角看同一个图。

**第二层：IGVN — 图的"压扁机"**

`PhaseIterGVN`（IGVN：Iterative Global Value Numbering）是 C2 优化心脏。它维护一个 hash table：每个 Node 按操作码+输入 hash → 相同 hash 的 Node 可互相替换。流程：

```
transform(node):
  hash = hash(node)
  existing = hash_find(hash)
  if (existing 与 node 等价):
    replace node with existing  // 值编号 – 共享相同计算
    return
  ideal = node.Ideal()         // 理想化 – Node 自己知道怎么变简单
  if (ideal != node):
    replace node with ideal    // 例: 0 + x → x
    return
  hash_insert(node, hash)      // 插入 hash table
```

"Iterative"意味着反复执行：每次 Ideal() 产生的简化可能让其他 Node 的输入改变 → 新输入改变了它们的 hash → hash table 中的等价节点可能不再等价 → 重新 hash → 重新 Ideal()。这个过程持续到不动点——没有 Node 的 hash 再改变。`_worklist` 跟踪需要重处理的 Node。

C2 的大部分强大优化不来自"智能算法"——来自 400+ 种 Node 子类的 `Ideal()` 方法。`AddINode::Ideal()` 知道 `AddI(ConI(0), x) → x`，`IfNode::Ideal()` 知道 `If(ConstBool(true), ...) → IfTrue-only`。所有"小聪明"加起来 = C2 的大智慧。

IGVN 之后 C2 还跑几轮"全图级"优化相位：

1. **PhaseCCP** (Conditional Constant Propagation，`phaseX.hpp:584`): 在 IGVN 的基础上做全局常量传播——发现 `if(x==5)` 是真的，把 x 对应的所有使用替换为常量 5。与 IGVN 的区别：IGVN 看局部（Node + 直接输入），CCP 看全局（传播到所有使用点）。

2. **PhaseStringOpts** (`stringopts.hpp:34`): 识别 `StringBuilder` / `StringBuffer` 的 append 模式串，直接展开为 StringConcat 的 intrinsics——省去 StringBuilder 对象的分配和 GC。

3. **OpaqueNode 守卫** (`opaquenode.hpp:34,115`): `Opaque1Node` 是循环谓词的"防盗栏"——阻止 IGVN 或 CCP 在对循环进行激进变换时把谓词错误地折叠回去。在所有优化完成后，CMacroExpand 移除 Opaque1（它们已完成守卫任务）。`Opaque4Node` 用于循环 striping 后的退出条件验证。

4. **EliminateBoxing** (`compile.hpp:368`): 消除 Integer.valueOf(x) / .intValue() 的装箱/拆箱对——如果 C2 能证明值没有逃逸，装箱对象本身被消除。

**第三层：增量内联 — 先编译外层再内联子树**

C2 的内联策略与 C1 有根本区别：不是"遇到 invoke 时决定是否内联"，而是"先编译外层，再对收集到的调用点做 targeting 内联"。这由 `InlineTree`（`callGenerator.hpp`）管理——树根是正在编译的方法，叶节点是需要晚内联的 target。

`inline_incrementally()` 的循环逻辑：
```
while (inlining_progress && _late_inlines.length > 0):
  if (live_nodes > LiveNodeCountInliningCutoff):
    // 图太大→先用 IdealLoop 压缩 → 腾出空间
    PhaseIdealLoop ideal_loop(igvn, LoopOptsNone)
  inline_incrementally_one(igvn)  // 内联一个候选方法
  igvn.optimize()                  // GVN 清理内联产生的冗余
```

为什么是增量而不是全量？因为内联会产生大量新 Node——如果全量内联后再做 GVN，hash table 的重计算代价巨大（O(n²) per inline）。增量内联 = "内联一个 → GVN 清理 → 再内联下一个" = 每步的 cleanup 复杂度是 O(k) per inline。

还有一个关键：晚内联需要 profiling 数据。`methodData->call_count()` 和 `methodData->receiver_type_data()` 告诉 C2 哪些调用点可以内联（hot enough）以及 receiver 的实际类型（用于去虚拟化）——C1 花 Level 3 时间去采集这些数据，C2 消费它们。

**第四层：逃逸分析 — "不需要堆的就不用它"**

`ConnectionGraph`（`escape.hpp`）从 `AllocateNode` 出发，跟踪对象引用在 ideal graph 中的传播路径，判断对象是否逃逸出当前方法：

| 分类 | 含义 | 优化动作 |
|------|------|------|
| NoEscape | 对象只在当前方法内使用 | **标量替换**：对象的字段变成局部变量，分配本身消除 |
| ArgEscape | 对象被传给被内联的调用 | **锁消除**：对象 lock 不需要在 heap 上（只能被当前线程看见） |
| GlobalEscape | 对象可能被其他线程/方法访问 | 不做优化 |

标量替换的收益巨大：`Point p = new Point(x, y); use(p.x); use(p.y)` → `use(x); use(y)` ——没有堆分配，没有 GC 压力，没有 TLAB 开销。逃逸分析是 C2 和 C1 之间最显眼的差距——C1 不做逃逸分析，所有 `new` 都走 TLAB 分配。

`EliminateLocks`：同一个对象的 lock/unlock 的 NoEscape 标记使得可以完全消除这对锁。这意味着在 C2 编译的代码中，`synchronized(new Object()) { ... }` 的同步开销被完全移除——连接图和理想图协作的结果。

**第五层：IdealLoop — 循环的终极优化器**

`PhaseIdealLoop` 是最复杂也最昂贵的 C2 优化阶段。它识别 `CountedLoopNode`（有明确步长+边界的循环），然后施加：

| 优化 | 机制 | 收益 |
|------|------|------|
| 循环展开 (unrolling) | `for(i=0;i<8;i++) body` → 8 个 body 的拷贝（消除 i 和 cmp） | 减少分支+为向量化铺路 |
| 循环谓词化 (predication) | 在循环外插入 `if (i<len) { for(...) }` → 循环内消除 bounds check | 热循环中每个迭代省 1-2 个比较 |
| 向量化 (vectorization) | `for(i=0;i<N;i++) A[i]=B[i]+C[i]` → 128/256-bit SIMD 指令一次算 4/8 个元素 | 4-8x 吞吐率 |
| 范围检查消除 (RCE) | 与 C1 的 RCE 同名但算法更激进——使用整个循环的 SSA 约束分析值范围 | C1 RCE 保守，C2 RCE 几乎全部消除 |

循环优化不是"是否需要"的问题——是"需要多少轮"的问题。一个循环可能先展开 → 展开后暴露了新的优化窗口 → 再向量化 → 向量化后又有新的范围检查需要消除 → 再展开。`optimize_loops()` 循环直到 `loop_opts_cnt` 用完或无新的 `major_progress`。

**第六层：Macro Expand — 高级操作的下沉**

`PhaseMacroExpand` 处理在 ideal graph 中保留的"宏节点"——这些节点在优化阶段保留（因为需要看到全貌才能做决策），在代码生成前下沉为底层操作序列：

| 宏节点 | 下沉为 | 优化决策在 retained 期间 |
|------|------|------|
| `AllocateNode` | TLAB 的 bump-pointer alloc + slow call | 是否做了标量替换？→ 全消除 |
| `LockNode` / `UnlockNode` | fast lock (CAS mark word) / slow monitor | 逃逸分析判定？→ 全消除 |
| `ArrayCopyNode` | `System.arraycopy()` intrinsic / memmove | profiling 数据看大小？→ intrinsic |

展开后图会变大——AllocateNode 变成 15-20 个 MachNode（TLAB 分配的汇编序列）。Matcher 会把这些 MachNode 映射到实际机器指令。

`PhaseMacroExpand` 还负责一个与 GC 的交互：在所有分配点插入 GC 屏障。`BarrierSetC2` 接口根据 GC 类型（G1/Shenandoah）插入不同的屏障代码——G1 的 SATB pre-barrier 在每个 store 前插入、card mark post-barrier 在每个 store 后插入。这些屏障是 C2 优化的重要约束——它们限制了 store 的重新排序和消除。

**第七层：图着色寄存器分配 — "每变量的完美家"**

`PhaseChaitin` 是 Briggs-Chaitin 风格的图着色寄存器分配器——与 C1 的 LinearScan 形成 C2 的最大架构差异。步骤：

1. **Build IFG**：为每个活跃变量建干涉图——两个变量如果在同一时间活跃，它们之间有边。
2. **Coalesce**：合并通过 copy 指令相关的变量——消除冗余 move。
3. **Simplify**：重复删除 degree < k 的节点（k = 可用物理寄存器数）。如果能删光所有节点 → 图是 k-着色的。
4. **Spill**：如果所有节点 degree ≥ k → 选一个 spill cost 最低的溢出到栈 → 把所有对它的引用拆成 "load before use, store after def" → 重新建 IFG → Go to 2。
5. **Select**：按删除的逆序分配颜色。

为什么图着色比线性扫描好 2-3x？因为它能在"全局"层面看干涉关系——线性扫描看到 A 和 B 干涉就 spill B，图着色看到 A 和 B 干涉但 B 和所有其他变量都不干涉，可以给 A 和 B 分配不同颜色而不 spill 任何一个。"全局视角"是干涉图的力量。

代价：图着色 O(n²) —— 构建干涉图需要检查每对变量是否同时活跃。对于 LiveNodeCountInliningCutoff（默认~20000 个 live nodes），这个代价值得——Level 4 代码跑得长。

**第八层：Matcher + Output — 图变成机器码**

`Matcher` 使用 AD 文件（`x86_64.ad`，13325 行）驱动指令选择。AD 文件描述的是"ideal node pattern → mach node pattern + x86 instruction encoding"的 DFA 规则：

```
// x86_64.ad 示例：
instruct addI_eReg(rRegI dst, rRegI src) %{
  match(Set dst (AddI dst src));
  format %{ "addl    $dst, $src" %}
  ins_encode %{ __ addl($dst$$Register, $src$$Register); %}
%}
```

Matcher 对 ideal graph 做 DFA 遍历，识别匹配的 pattern，用 `ins_encode` 生成对应汇编。Matcher 还需要处理：
- **Spill Code**：图着色阶段标记的 spill 变量 → Matcher 插入 `load [rsp+offset]` / `store [rsp+offset]`。
- **Calling Convention**：方法入口的参数 move、返回值处理。
- **Scheduling**：MachNode 图经过 PhaseCFG 转化为基本块顺序，再经 `PhaseBlockLayout` 做块内指令调度。

最终 Output 阶段产出 CodeBuffer → `ciEnv::register_method()` → nmethod → CodeCache。

**桥接 Sea-of-Nodes 和机器码的 PhaseCFG**：Sea-of-Nodes 中 Node 没有 block——但机器码需要按 block 顺序发射。`PhaseCFG` 在 Matcher 之前执行——它为每个 Node 分配一个 `Block`，构建控制流图的基本块结构。关键步骤：(1) `build_cfg()` 从 root 的控制流边构建初始 block，(2) `insert_goto_at()` 在需要的地方插入 goto，(3) `schedule_late()` 把 Node "浮"到最晚可能的 block（延迟调度——减少活跃变量的 live range）。之后 Matcher 在 CFG 之上做指令选择。

## 设计权衡

一、**Sea-of-Nodes vs CFG**。Sea-of-Nodes 用 Node 的非局部性换来了"浮动"能力——纯算术 Node 可以跨 block 浮动到最优执行位置。代价是后期必须重建 block 表示（PhaseCFG），且 Node 的内存占用更大（每个 Node 需要维护所有边而非隐式的 block 内顺序）。

二、**IGVN 的不动点 vs 超时风险**。IGVN 理论上可以无限循环（两个等价形式之间来回震荡）——C2 用 `_worklist` 深度限制和 `NodeHash` 稳定性检测来保证收敛。但仍然有 C2 因 Ideal() 循环而 timeout 的已知 bug。

三、**增量内联 vs 全量内联**。增量内联的优点是 cleanup 即时（每步 O(k)），缺点是 late inlines 可能在不需要的上下文（已经做了 scalar replace）中。全量内联的优点是"看到全部画面"但 cleanup 代价高。

四、**图着色 vs 线性扫描**。图着色生成更好的代码但编译时间 O(n²) vs O(n log n)。C2 赌 Level 4 代码会跑很久——编译时间的投入能从运行时收益中收回。这个赌注对热方法大概率正确。

## 核心悬念

**C2 编译器如何把一段字节码变成一个巨大的理想图——再通过 IGVN 压扁、逃逸分析消除、循环优化展开、图着色分配寄存器——每一轮都在"离最优代码更近一步"？C2 的秘诀不是单个算法的智能，而是"让图的每个节点都知道自己的 Ideal 形式，然后反复地让它趋近"。**

**→ 下一域**：C2 编译了最激进的代码，但它做的假设（"这个虚调只有一种 receiver"、"这个循环的边界是 N"）可能会在未来被破坏。当 C2 的假设被打破时，编译后的代码必须从当前执行点"退回"解释器——去优化（Deoptimization）篇见。

## 预估

1 篇，8 层递进 + 4 个设计权衡，预估 4000-5500 行。
