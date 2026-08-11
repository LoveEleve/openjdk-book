# 01. C2 Ideal Graph — Node + Type + IGVN

> 🔴 Deep | 16 KP 中的 3 个核心机制——C2 IR 基础
> 读者处境: C2 的 IR 不是 C1 的 basic block based——是 **sea-of-nodes** (graph): Node 有 def-use edges(`_in`/`_out`), 算法运行在图上。每个 Node 有 `Ideal()`(优化 hook)/`Value()`(类型推导)/`Identity()`(代数化简)——三个方法形成 IGVN 的迭代三环。

### 1. "Node — sea-of-nodes 的图节点"

场景: `int sum = a + b`——Parse 产生三个 Node: ParmNode(a), ParmNode(b), AddNode(sum)。AddNode 的 `_in[0]=Parm_a`, `_in[1]=Parm_b`。`_out[0]→next consumer`。不同于 C1 的链式 IR——C2 的 Node 同时有 control edge + data edge + memory edge——**统一 DAG**。

**Node 结构** (`node.hpp:210-400`):
```
class Node:
  _in[_max]  — input edges: 这个 Node 依赖的其他 Node
  _out       — output edges: 谁会消费这个 Node 的结果
  _cnt       — 当前 input edge 数量
  Opcode()   — Node 的类型: Op_AddI/Op_LoadI/Op_If/Op_CallStaticJava...

三个核心虚拟方法:
  Ideal(PhaseGVN*, bool)  — 优化 hook: 返回优化后的 Node 或 this(NOP=无优化)
  Value(PhaseGVN*)        — 返回此 Node 的 Type: TypeInt::INT 或 TypePtr::NULL_PTR
  Identity(PhaseGVN*)     — 代数化简: AddI(x,0)→x, MulI(x,1)→x
[C++: node.hpp——Node 的 _out edges 持有 Node*(no refcount)——Graph 或 PhaseIterGVN 负责 dead node 删除]
```
- 源码: `node.hpp:210-350` (Node 类定义 + _in/_out edges) + `node.hpp:350-450` (Ideal/Value/Identity 声明)

- 关键设计: **sea-of-nodes = 控制、数据和内存的统一 DAG**——不是 C1 的 basic block based IR。每个 Node 可以同时持有一条 control edge(来自最近的 IfNode/RegionNode)、data edges(来自操作数) 和 memory edge(来自最近的 StoreNode 或 MergeMemNode)。IGVN 在优化时利用三种 edge types 做不同类型优化(control→dead code, data→constant fold, memory→load/store elimination)。

### 2. "Type — C2 类型 lattice"

场景: `if (x > 0) { y = x } else { y = 0 }`——两分支 merge→PhiNode(y)。第一个分支 TypeInt(1,MAX_INT)→第二个分支 TypeInt(0,0)→meet→TypeInt(0,MAX_INT)。范围扩大了——但比 "unknown" (TOP) 精确。

**Type 系统** (`type.hpp:48-230`):
```
Type::TOP     — 未知(初始状态)
Type::BOTTOM  — 矛盾/不可能(死代码)
TypeInt[lo,hi] — 整数范围: TypeInt(0,MAX_INT)
TypePtr::NULL_PTR — 空指针
TypePtr::NotNull  — 非空指针

Type::meet(t1, t2) — 最小上界:
  TypeInt(0,10).meet(TypeInt(5,15)) → TypeInt(0,15)    // 范围扩大
  TypePtr(NULL).meet(TypePtr(NotNull)) → TypePtr(Ptr)   // 放弃 nullness info

Type::dual() — 互补类型(用于 CFG 分析):
  TypeInt(0,10).dual() → TypeInt(MIN, -1) ∪ TypeInt(11, MAX)
[C++: type.hpp:224-260——meet() 操作定义在 Type 基类——子类覆写 meet_helper() 做 specific join]
```
- 源码: `type.hpp:48-150` (TypeInt/TypePtr/TypeLong 定义) + `type.hpp:224-260` (meet/meet_speculative) + `type.hpp:160-230` (TOP/BOTTOM/simple types)

- 关键设计: **Type lattice 的用途**——Phi 节点 merge 多路控制流→meet() 返回最精确的共同类型。如果 meet 结果是 BOTTOM→该执行路径不可达→IGVN 消除整个路径(dead code elimination)。**TypePtr::add_offset(int)**——对象字段访问→Compute field type from class layout→返回字段的精确 Type→IGVN 可以用此信息消除后续的 null check/type check。

### 3. "IGVN — 迭代全局值编号 (Ideal→Value→Identity 三环)"

场景: `int x = a + 0; return x * 1;`——IGVN 第一轮: AddI::Ideal()→Identity() 检测 `x+0=x`→返回 Parm(a)→替换。第二轮: MulI(Parm(a),ConI(1))→Identity() 检测 `x*1=x`→返回 Parm(a)。两轮后整图坍缩为单节点。

**PhaseIterGVN** (`phaseX.cpp:1223-1280`):
```
PhaseIterGVN::optimize() (line 1223):
  while _worklist 非空:
    n = _worklist.pop()
    Node* k = n->Ideal(this, can_reshape)  // 第一步: 代数化简
    if k != n: replace(n, k); n = k; continue
    n->Value(this)                          // 第二步: 重新计算 Type
    Node* i = n->Identity(this)             // 第三步: x+0→x
    if i != n: replace(n, i)
    add_users_to_worklist(n)                // consumers 可能受益于精确类型

PhaseIterGVN::transform(n) (line 1267):
  单节点 transform——调 Ideal→Value→Identity——变化时 re-add to worklist
[C++: phaseX.cpp:1223-1280——fixpoint 迭代——重复直到 worklist 空——C2 优化的心脏]
```
- 源码: `phaseX.cpp:1223-1250` (optimize 主循环) + `phaseX.cpp:1267-1280` (transform 单节点) + `igvn.cpp:100-200` (hash_find_insert→全局 CSE)

- 关键设计: **fixpoint 迭代 vs fixed-pass**——区别于 C1 的 linear scan(两趟规范化)。IGVN 反复迭代——每轮可能触发新的优化机会(Node 类型变窄→consumer 有新的 Identity 匹配)。`add_users_to_worklist` 递归添 `_out` edges→Cascading Effect 确保所有受影响的 Node 重新 transform。**hash_find_insert**(`igvn.cpp`) 值编号——如果两个 Node 的 opcode+inputs hash 同→已存在等价 Node→replace with existing→全局 CSE。

---

### 核心悬念

**"C2 ideal graph: sea-of-nodes(control+data+memory 统一 DAG)→Type lattice(meet/join)→IGVN(Ideal→Value→Identity fixpoint 迭代)。不是 C1 的 basic blocks——算法在图上运行——优化比 C1 深一个数量级。"** — 下一篇: Parse——字节码怎么变成这些 Node。

> → [02-c2-parse-graphkit.md](02-c2-parse-graphkit.md)
