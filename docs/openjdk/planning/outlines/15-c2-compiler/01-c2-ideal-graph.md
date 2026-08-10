# 01. C2 Ideal Graph — Node + Type + IGVN

> 🔴 Deep | 16 KP 中的 3 个核心机制
> 读者处境: C2 的最核心——Ideal Graph。不是 basic block based (C1)——是 sea-of-nodes (Graph): Node 有 def-use edges——算法运行在图上。

### 1. Node — C2 图节点

场景: `int sum = a + b`——Parse 产生三个 Node: ParmNode(a), ParmNode(b), AddNode(sum)——AddNode 的 `_in[0]`=Parm_a, `_in[1]`=Parm_b。`_out[0]`→Edge to next consumer。

**Node** (`node.hpp.cpp`):
- `_in[_cnt]`: input edges——这个 Node 依赖的其他 Node。`_out`: output edges——谁会消费这个 Node 的结果
- `Opcode()`: Node 的类型——`Op_AddI`/`Op_LoadI`/`Op_If`/`Op_CallStaticJava`...
- `Ideal(PhaseGVN*, bool)` // 优化 hook——返回优化后的 Node 或 this。`Ideal` 实现每个 Node 的优化逻辑
- `Value(PhaseGVN*)`: 返回此 Node 的 Type——`TypeInt::INT` 或 `TypePtr::NULL_PTR`——确定类型 lattice
- [C++: Node 的 ref counting——`_out` edges 持有 Node* (no refcount)——Graph 或 `PhaseIterGVN` 负责 dead node 删除。Node 被 remove→`uncast(X)`→`hash_delete()`——从 IGVN hash table 移除]
- Sea-of-nodes: 不同于 C1 的 basic block based IR——C2 的 Node 是**控制、数据和内存的统一 DAG**——每个 Node 可以同时有 control edge+data edge+memory edge

### 2. Type — C2 类型 lattice

**Type** (`type.hpp.cpp`):
- `Type::TOP` (未知)——`Type::BOTTOM` (矛盾/不可能)——`TypeInt[lo,hi]` (整数范围)——`TypePtr::NULL_PTR`
- `Type::meet(t1, t2)`: 两个类型的"最小上界"——`TypeInt[0,10].meet(TypeInt[5,15])`→`TypeInt[0,15]`——范围扩大
- [C++: Type lattice 用途——Phi 节点 merge——if/else 的两分支 merge——第一个分支 TypeInt[0,10]——第二分支 TypeInt[20,30]——merge→TypeInt[0,30]——范围扩大——但不失去信息——因为两分支都包含在此范围内]
- `TypePtr::add_offset(int)`: 对象字段访问——`Obj+offset`——返回字段的类型

### 3. IGVN — 迭代全局值编号

**IGVN** (`igvn.hpp.cpp` + `phaseX.cpp`):
- `IGVN::transform(Node*)`: 反复调 `Node::Ideal()`→`Node::Value()`→`Node::Identity()`——每轮可能替换 Node——直到 fixpoint
- Waitlist: 需要重新 transform 的 Node——`_worklist`——每个 idealization 后 add consumers
- [C++: IGVN 的迭代——fixpoint。`Ideal()` 可能简化 Add(Add(x,y),0)→Add(x,y)——然后 `Value()` re-evaluate Type——然后 `Identity()` 检查 `x+0→x`——如果变化→重新 transform 整个 graph——直到无变化]
- C2 图的高效更新: IGVN 中 hash table 存储所有 Node——`hash_find(Node*)`→找等效 Node——替代→删除旧 Node

---

### 核心悬念

**"C2 的 graph——Node 有 def-use edges——sea-of-nodes——不是 C1 的 basic blocks。"** — Type lattice: TOP→BOTTOM——meet 操作扩大范围。IGVN 迭代: Ideal→Value→Identity——直到 fixpoint——优化比 C1 深 10x。下一篇: Parse——字节码怎么变成这些 Node。

> → [02-c2-parse-graphkit.md](02-c2-parse-graphkit.md)
