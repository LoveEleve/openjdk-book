# 03. IGVN + CCP + Escape Analysis — C2 优化三引擎

> 🔴 Deep | 迭代值编号 + 条件常量传播 + 逃逸分析
> 读者处境: C2 的优化 pipeline 有三层——IGVN(Ideal→Value→Identity 循环迭代), CCP(常量通过控制流传播消除死代码), Escape Analysis(ConnectionGraph→NoEscape/ArgEscape/GlobalEscape→scalar replacement消除堆分配)。三者接力——IGVN 在前通过代数化简降低图复杂度→CCP 利用 IGVN 的精确类型做常量传播→EA 在优化后的图上做逃逸判断。

### 1. "IGVN — 迭代全局值编号 (Ideal→Value→Identity 三环)"

场景: `int x = a + 0; return x * 1;` — Parse 产生 AddI(Parm(a),ConI(0))→MulI(AddI,ConI(1))。IGVN 第一轮: AddI::Ideal()→Identity() 检测 x+0=x→返回 Parm(a)→替换 AddI。第二轮: MulI(Parm(a),ConI(1))→Identity() 检测 x*1=x→返回 Parm(a)。两轮→整图坍缩为单节点 Parm(a)。

**PhaseIterGVN 主循环** (`phaseX.cpp:1223-1270`):
```
PhaseIterGVN::optimize():
  while _worklist 非空:
    n = _worklist.pop()
    Node* k = n->Ideal(this, can_reshape)  // 第一步: 代数化简 hook
    if k != n: replace(n, k); n = k        // 被替换→continue
    n->Value(this)                          // 第二步: 重新计算 Type
    Node* i = n->Identity(this)             // 第三步: x+0→x / x*1→x
    if i != n: replace(n, i)
    add_users_to_worklist(n)                // consumers 可能因类型更精确而受益
[C++: phaseX.cpp:2326行——IGVN 是 C2 优化的心脏——所有 Node 的 Ideal()/Value()/Identity() 都在此迭代]
```
- 源码: `phaseX.cpp:1223-1270` (optimize 主循环) + `phaseX.cpp:1267-1280` (transform 单节点) + `phaseX.cpp:1584-1636` (add_users_to_worklist → 递归添 consumers)

- 关键设计: **fixpoint 迭代**——不是 fixed-pass 优化(C1 走两遍 Linear Scan→Code Gen)。IGVN 反复迭代直到 worklist 为空——每轮可能触发新的优化机会(Node 类型变窄→consumer 可能有新 Identity 匹配)。`add_users_to_worklist` 不仅添直接 consumers——还递归添 `_out` 边的 Cascading Effect。**hash_find_insert**(`igvn.cpp`) 的值编号在 `Identity()` 层——如果两个 Node 的 opcode+inputs hash 相同→已存在→replace with existing→全局 CSE。

### 2. "CCP — Conditional Constant Propagation (条件常量传播)"

场景: `if (true) { x = 10 } else { x = 20 }` — Parse 产生 IfNode+两个分支的返回 Node。CCP 从 TOP lattice 开始——IfNode 的 condition=con(1)→true 分支已知→false 分支标记 unreachable→消除 false 分支的全部 Node→Phi 合并时只需 true 分支的值→x=10。

**PhaseCCP** (`phaseX.cpp:1994-2100`):
```
PhaseCCP::transform(n):
  → 初始全部 Node type = TOP(未知)
  → 从 StartNode type=BOTTOM 启动——逆风传播控制流
  → IfNode condition 为常量→消除一个分支(标记 unreachable)
  → meet() 操作合并分支类型——TypeInt[0,10].meet(TypeInt[5,15])→TypeInt[0,15]
  → IGVN 在 CCP fixpoint 后用更精确的类型重新 transform
[C++: phaseX.cpp:1994-2100——CCP 不做代数化简(那是 IGVN 的工作)——只传播类型和消除不可达分支]
```
- 源码: `phaseX.cpp:1994-2020` (CCP::transform) + `phaseX.cpp:1862` (SafePointNode 跟踪)

- 关键设计: CCP 的拓扑是从**调用者向下**传播类型信息——与 IGVN 的**自底向上**(从叶子 Node→向上 Idealize/Identity)互补。CCP 能发现 `if(Constants.COMPILE_TIME)` 这类条件→消除全部测试覆盖率工具代码(如果常量=false 则整条分支被消除)。

### 3. "Escape Analysis — ConnectionGraph(三个级别)"

场景: `Point p = new Point(x,y); list.add(p); return p.x + p.y;` — `p` 通过 `list.add(p)` 参数逃逸→ArgEscape→不能消除堆分配。但 `p.x` 和 `p.y` 的 field loads 仍可消除——用 local variable 替代(不经过堆→load→register——直接 register)。

**ConnectionGraph** (`escape.cpp:97-118`):
```
ConnectionGraph::do_analysis(C, igvn):
  → 构建 PointsToNode: JavaObject(分配点)/LocalVar(局部变量)/Field(对象字段)
  → add_edge/deferred_edge: 建立引用关系(LocalVar→Store→Field / Field→Load→LocalVar)
  → compute_escape(): DFS/BFS 从每个 AllocateNode 出发→搜索所有引用路径
     • 到达 static field? → GlobalEscape(全局逃逸——不可消除)
     • 到达 Return/Argument? → ArgEscape(传出去——field loads 可消除)
     • 只在方法内? → NoEscape(完全局部——标量替换消除分配)
[C++: escape.cpp:3698行——C2 的 EA 比 C1 的 bcEscapeAnalyzer 精确得多——Flow-Sensitive+Field-Sensitive]
```
- 源码: `escape.cpp:97-115` (do_analysis 入口) + `escape.cpp:118-150` (compute_escape DFS) + `escape.cpp:200-500` (build_graph)

- 关键设计: **NoEscape → Scalar Replacement** 消除整个堆分配——AllocateNode→拆为 per-field 的 local variables——LoadField→read local——StoreField→write local——完全消除 heap alloc + GC write barrier + memory load。**ArgEscape → Field Load Elimination**——对象仍存在堆上但 field loads 转为 register reads。

---

### 核心悬念

**"IGVN(Ideal→Value→Identity fixpoint迭代)→CCP(TOP lattice→常量传播消除死分支)→Escape Analysis(ConnectionGraph→NoEscape→堆分配全消除)。三者接力——C2 的优化是活体——不是固定 pass 列表。"** — 下一篇: Loops — LoopNode + unrolling + SuperWord 向量化。

> → [04-c2-loops.md](04-c2-loops.md)
