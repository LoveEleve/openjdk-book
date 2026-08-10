# 03. IGVN + Escape Analysis — 图优化与逃逸

> 🔴 Deep | 16 KP 中的 2 个核心机制
> 读者处境: Parse 产生了 ~2000 个 Node 的 naive graph。IGVN 迭代——Ideal→Value→Identity 三环——直到 fixpoint——消除 dead code、常量折叠、代数化简。ConnectionGraph (EA) 找到逃逸对象——消除堆分配。

### 1. IGVN — 迭代全局值编号

场景: `int x = a + 0; return x * 1;`——Parse: AddI(Parm(a), ConI(0))→MulI(AddI, ConI(1))。IGVN pass 1: `AddI::Ideal()`→`AddI(x,0)`→`Identity()`→return `x` (x+0=x)。IGVN pass 2: `MulI(x,1)`→`Identity()`→return `x`。两 pass→最终 graph 只有一个 Node: Parm(a)。

**IGVN 实现** (`igvn.cpp + phaseX.cpp`):
- `PhaseIterGVN::transform(Node* n)`: 反复调 `n->Ideal(this, can_reshape)`→`n->Value(this)`→`n->Identity(this)`——每轮可能替代 n (返回不同 Node)。变化→将 n 的所有 `_out` consumers 加入 `_worklist`——因为 consumers 的类型现在可能更精确
- [C++: IGVN 的 worklist——`_worklist`——处理顺序: 优先 worklist 中的 Node。每个 cal (Ideal/Identity) 后→`add_users_to_worklist(n)`——因为 n 的 consumers 现在可能受益于更精确的输入类型 (narrower TypeInt range→consumer 可能化简)。fixpoint: worklist 空→graph 稳定]
- [C++: hash_find_insert——`_table` hashtable——key=Node 的 hash (opcode+inputs)——value=equivalent Node。如果新 Node 与已有 Node hash 同→已经存在→replace with existing。这是 GVN 的核心——值编号]

**Ideal() 优化示例** (`mulnode.cpp + addnode.cpp`):
- `AddI(x, ConI(0))→Ideal()`→return x——`Identity` 钩子——`x+0=x`
- `MulI(x, ConI(1))→Ideal()`→return x
- `SubI(x, x)→Ideal()`→return ConI(0)
- `LShiftI(x, ConI(0))→Ideal()`→return x (<<0 = identity)
- [C++: `Phase::is_diamond_phi()`——`if (cond) { x = a } else { x = b }`→合并为 CMoveI——消除 Phi 的分支——直接条件移动]

**CCP — Conditional Constant Propagation** (`phaseX.cpp:200-500`):
- `PhaseCCP::transform()`——从 TOP lattice 开始——初始所有 Node 值 unknown——解析控制流——发现不可达分支→消除→常量通过控制流传播——`if (true)`→branch known→消除 false 分支

### 2. Escape Analysis — ConnectionGraph

场景: `Point p = new Point(x, y); list.add(p); return p.x + p.y;`——p 被 `list.add(p)`——arg escape——不能 scalar replace 消除分配。但 `p.x` 和 `p.y` 的 field loads 可以保留——不需要 load from heap——改用 load from method local。

**ConnectionGraph** (`escape.cpp:200-1000`):
- 输入: C2 Ideal Graph (all AllocateNode/InitializeNode/LoadNode/StoreNode/ReturnNode)
- 节点: `PointsToNode`——JavaObject (分配点), LocalVar (局部变量), Field (对象字段)
- 边: `AddEdge(from, to, FieldType)`——引用关系——`LocalVar→store→Field`, `Field→load→LocalVar`
- [C++: DFS 逃逸搜索——从每个 `AllocateNode`→BFS/DFS 找所有直接/间接引用——找到 static field→GlobalEscape (不可消除)——找到 Return→ArgEscape (传出方法)——找到 argument to unknown method→ArgEscape。全部未找到→NoEscape (方法内使用——可消除)]
- `_no_escape`: allocation 不逃逸→PhaseMacroExpand 做 scalar replacement (消除 heap allocation→栈或 register)
- `_arg_escape`: 对象作为参数传出去——但 field loads 可消除——C2 可消除 field load→不用从堆读——用 local/register 替代

**Scalar Replacement 前奏**:
- 对于 NoEscape 的 AllocateNode: 不需要 heap allocation——在 PhaseMacroExpand 中——拆为 per-field 的 local variables。每个 LoadField→变成 local read。每个 StoreField→变成 local write。消除: heap allocation + GC write barrier + memory load

---

### 核心悬念

**"IGVN (Ideal→Value→Identity) 三环迭代——worklist 驱动——直到 fixpoint。——ConnectionGraph DFS 找逃逸——NoEscape→scalar replacement 消除堆分配。"** — C2 的优化是活体——每次 IGVN cycle 可能大幅改变 graph 结构——迭代深度远超 C1 的多趟规范化。下一篇: Loops——loop unrolling + predicate。

> → [04-c2-loops.md](04-c2-loops.md)
