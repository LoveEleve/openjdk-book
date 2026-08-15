# 03. IGVN + CCP + Escape Analysis — C2 优化三引擎

> **前置依赖**:[15-c2-compiler/01 — C2 Ideal Graph: Node + Type + IGVN](openjdk/vol-02/15-c2-compiler/01-c2-ideal-graph.md):IGVN 的 transform_old 五步与类型格在这里,本篇的三个引擎共用这套地基;[15-c2-compiler/02 — Parse + GraphKit: 字节码→Ideal Graph](openjdk/vol-02/15-c2-compiler/02-c2-parse-graphkit.md):Parse 铺出的海量节点网,本篇讲怎么被优化;[12-ci/02 — ciTypeFlow 与 escape 分析](openjdk/vol-02/12-ci/02-ci-typeflow-escape.md):C1 的浅层 bcEscapeAnalyzer 与 C2 的 ConnectionGraph 对照
> → **后续**:[15-c2-compiler/04 — 循环优化: LoopNode + unrolling + SuperWord](openjdk/vol-02/15-c2-compiler/04-c2-loops.md)
> 关联域: 12-ci(bcEscapeAnalyzer 对照)、09-memory-core(分配底层)、19-sync(锁消除)

## 一图三引擎

02 篇结束时 Parse 留下一张"海量 Node 网"。C2 优化期的三个引擎各有分工: **IGVN**(01 篇)在局部把代数表达式化简、值编号去重; **CCP**(Conditional Constant Propagation)沿控制流传播常量、判死不可达分支; **Escape Analysis** 判断哪些堆分配可以不发生。它们不是三个独立 pass——IGVN 在 CCP 与 EA 的每个间隙都会重跑,EA 消除分配的"最后一刀"要等 `PhaseMacroExpand`。这篇拆 CCP 与 EA 两个新引擎,并纠正大纲三处: CCP 不是"从 BOTTOM 逆风传播"而是**全部 TOP 初始化后的乐观前向传播**;EA 的"compute_escape DFS"是图构建 + 沿边传播而非从分配点搜索;`ArgEscape → field loads 转寄存器` 在源码里不存在。

## 1. IGVN — 引擎中的引擎

01 篇已把 `transform_old` 五步与 `optimize` 主循环讲透,这里只补它的**调度地位**: `Compile::Optimize`(compile.cpp:2220)里 IGVN 出现在六个位置(compile.cpp:2247-2254 Parse 后 / :2321 EA 后 / :2332 宏消除后 / :2388-2391 CCP 后 / :2424 range-check cast 后 / :2454 opaque4 后),每个结构变换阶段之后都靠它收敛。CCP 与 EA 都**寄生**在 IGVN 之上——PhaseCCP 继承 PhaseIterGVN,EA 直接接收 `PhaseIterGVN*` 参数(escape.cpp:97)——所以"三引擎"更像是"两个引擎 + 一个收敛器"。

## 2. CCP — 乐观的常量传播

场景: 图里某个 `If` 的测试条件是常量(`if (x > 0)` 而 x 的类型已被窄化成 `[1,max]`),两分支里只有一支可达。CCP 的机制是 **Wegman-Zadeck 风格的乐观分析**(phaseX.cpp:1811 注释 "Conditional Constant Propagation, ala Wegman & Zadeck"): 先把**所有节点类型设为 TOP**(乐观假设,phaseX.cpp:1848-1851 "Initialize all types to TOP, optimistic analysis"),再从 `C->root()` 入 worklist 前向传播:

```cpp
// phaseX.cpp:1847-1859(截取核心,逐字)
void PhaseCCP::analyze() {
  // Initialize all types to TOP, optimistic analysis
  for (int i = C->unique() - 1; i >= 0; i--)  {
    _types.map(i,Type::TOP);
  }

  // Push root onto worklist
  Unique_Node_List worklist;
  worklist.push(C->root());

  // Pull from worklist; compute new value; push changes out.
  // This loop is the meat of CCP.
  while( worklist.size() ) {
```

循环里每弹出一个节点: `n->Value(this)` 重算类型,若**比当前类型更宽(widen)** 就 `set_type` 并把用户入队(phaseX.cpp:1865-1903)——乐观分析的关键性质是**类型只增不减**(assert "ccp_type_widens ... Not monotonic",:1830-1831),所以 worklist 必然收敛。大纲说"从 StartNode type=BOTTOM 启动逆风传播控制流"是错的——方向正好相反,起点是 root,初值是 TOP。

常量条件消除发生在 `transform_once`(phaseX.cpp:2043-2113)。它不做代数化简(那是 IGVN 的事),只做两件事: **①类型是单例就换成常量节点**(`makecon(t)`,TOP 换成 `C->top()`,:2046-2085);**②不可达的 Region 直接切割**:

```cpp
// phaseX.cpp:2056-2083(截取核心,逐字)
    if( !n->is_Con() ) {
      if( t != Type::TOP ) {
        nn = makecon(t);        // ConNode::make(t);
        NOT_PRODUCT( inc_constants(); )
      } else if( n->is_Region() ) { // Unreachable region
        // Note: nn == C->top()
        n->set_req(0, NULL);        // Cut selfreference
        bool progress = true;
        uint max = n->outcnt();
        DUIterator i;
        while (progress) {
          progress = false;
          // Eagerly remove dead phis to avoid phis copies creation.
          for (i = n->outs(); n->has_out(i); i++) {
            Node* m = n->out(i);
            if (m->is_Phi()) {
              assert(type(m) == Type::TOP, "Unreachable region should not have live phis.");
              replace_node(m, nn);
              ...
```

分支判死的链条是: `IfNode::Value` 看测试条件类型——`TypeInt::ZERO` 返回 `TypeTuple::IFFALSE`、`TypeInt::ONE` 返回 `TypeTuple::IFTRUE`(ifnode.cpp:51-67),于是另一支的 IfProj 类型变 TOP;TOP 沿着控制边传播到 Region;`transform_once` 遇到类型 TOP 的 Region 就**切断它的自引用边、把它的死 Phi 全部替换成 top**(:2060-2082)——被消除分支上的整棵子树随之失去引用,由后续 IGVN 的 `remove_dead_node` 清掉。CCP 之后 `igvn = ccp; igvn.optimize()`(compile.cpp:2388-2391)把这个结果收敛进哈希表。

*关键设计: IGVN 是"悲观"的——每个节点用自己的当前输入类型重算,类型只会变窄;CCP 是"乐观"的——先假设全部 TOP,能证明多少是多少,类型只会变宽。两者互补: 乐观假设让 CCP 能沿"尚未证明不可达"的路径推进,一旦证明常量就消除分支;而类型只增不减保证了终止。代价是 CCP 需要整图扫描(analyze 的 worklist 从 root 播遍全图),所以它只在优化中期跑一次,不像 IGVN 那样处处收敛。*

**实证边界**: CCP 的常量分支在 **javac 层就被折叠**了——`if (1==1)` 编译后只剩 `bipush 10`([实证](planning/outlines/00-jvm-tools/materials/commands/15-c2-optimizations-demo.txt)第 4 段),连 `static final int MODE=3` 这种"运行期常量"也是编译期常量(javac 折叠 `mode()` 成 `x*2`)。CCP 真正处理的是**图中才出现**的常量: 内联后值恒定的参数、类型窄化后的比较、Phi 合并出的单例。release 构建没有 flag 能直接打印 CCP 的行为(`TracePhaseCCP` 是 notproduct,c2_globals.hpp:632),能看到的只有 CITime 阶段树里的 "Cond Const Prop"(01 篇素材第 6 段)。

## 3. Escape Analysis — 证明"可以不分配"

场景: 循环里 `new Point(x, y)` 用完即弃。EA 要回答: 这个对象**逃不逃出方法**?不逃,就能把堆分配整个抹掉。C2 的 EA 是 **ConnectionGraph(连接图)**: 把图上的理想节点映射成三类 PointsTo 节点——`JavaObject`(分配点: Allocate/AllocateArray/ConP/常量对象…)、`LocalVar`(局部变量: Phi/Proj/CheckCastPP…)、`Field`(AddP 代表的字段或数组元素),外加一个 `phantom_obj` 兜底(escape.hpp:85-107 的类清单注释)。三类节点的逃逸状态定义在枚举里:

```cpp
// escape.hpp:153-161(截取核心,逐字)
  typedef enum {
    UnknownEscape = 0,
    NoEscape      = 1, // An object does not escape method or thread and it is
                       // not passed to call. It could be replaced with scalar.
    ArgEscape     = 2, // An object does not escape method or thread but it is
                       // passed as argument to call or referenced by argument
                       // and it does not escape during call.
    GlobalEscape  = 3  // An object escapes the method or thread.
  } EscapeState;
```

**NoEscape = 可标量替换**("It could be replaced with scalar",注释原话)——这是三个级别里唯一能消除堆分配的;ArgEscape 只是"作为参数传出去且调用内不逃逸",**对象还在堆上**——大纲说"ArgEscape → field loads 转 register"在源码里不存在,ArgEscape 能带来的是锁消除、指针比较优化这类次级收益。

`compute_escape`(escape.cpp:118-343)不是大纲说的"从每个 AllocateNode DFS/BFS",而是**四步图算法**:

- **①建图**: `add_node_to_connection_graph` 遍历**所有**理想节点(:148-197 的 worklist 循环),按节点类型建 PointsTo 节点并连边(`LocalVar →P> JavaObject`、`Field →P> JavaObject`、`JavaObject →F> Field`,escape.hpp:100-107),延迟边随后用 `add_final_edges` 消解(:202-206)。
- **②传播**: `complete_connection_graph`(:233-238)沿边传播逃逸状态——**GlobalEscape 节点指向的一切标 GlobalEscape,ArgEscape 同理**(escape.hpp:107-112 注释原文)。
- **③调整**: 对 NoEscape 对象 `adjust_scalar_replaceable_state`(:256-257)——**逃逸不逃逸 ≠ 可标量替换**: 被数组拷贝、被安全点调试信息引用、类型不精确等原因会让对象"不逃逸但不可拆",状态逐级下调(:1757)。
- **④内存图分离**: 对可标量替换的分配 `split_unique_types`(:319-341,实现 :3058)——把分配对象的内存从公共 MergeMem 里**拆出独占别名域**(要求 `C->AliasLevel() >= 3 && EliminateAllocations`,:321),这样后续 IGVN 才能对该对象做精确的 load/store 优化。

**最后一刀在 PhaseMacroExpand**: EA 只是"证明",消除分配发生在 `eliminate_macro_nodes`(macro.cpp:2567)——先做锁消除(`eliminate_locking_node`,:2593-2595),再对 `Allocate`/`AllocateArray` 调 `eliminate_allocate_node`(:2610-2613)。后者有**四道门**: `EliminateAllocations` 开关、JVMTI pop frame 不可用、`_is_non_escaping`(EA 打的标记)、`can_eliminate_allocation` 检查安全点引用(macro.cpp:1091-1116);通过后 `scalar_replacement`(:759,在 :1128 调用)把分配拆成字段级定义,随后 `process_users_of_allocation`(:946)处理字段访问——**Store 被直接删除**(值留在 def-use 图里,store 的 memory 边直通,`replace_node(n, n->in(MemNode::Memory))`,:959-961),**Load 经由 IGVN 的类型传播解析为字段的唯一定义值**,GC 屏障一并消除(eliminate_gc_barrier)——堆分配、屏障、内存加载一起消失。Compile::Optimize 里的编排(compile.cpp:2307-2337): `ConnectionGraph::do_analysis(this, &igvn)`(:2316)→ `igvn.optimize()`(:2321)→ `PhaseMacroExpand::eliminate_macro_nodes`(:2328-2333)。循环优化之后还有一次 `expand_macro_nodes`(:2432-2440)——把**剩余**的宏节点(真正的分配/锁/数组拷贝)展开成机器级节点,那是"必须发生的分配"。

**实证**([素材](planning/outlines/00-jvm-tools/materials/commands/15-c2-optimizations-demo.txt)第 1/2 段): 2 亿次循环内 `new Point(i, i+1)` 且不逃逸——**EA 开(默认)**: 0 次 GC,70ms;`-XX:-EliminateAllocations` 关闭后: **6 次 GC Pause、每次 570MB 分配、459ms(6.5 倍)**。同一个方法、同样的字节码,只差一个 flag——这就是标量替换的量级。`DoEscapeAnalysis`/`EliminateAllocations` 都是 product flag(c2_globals.hpp:527/:540)所以能开关对照;`PrintEliminateAllocations` 是 notproduct(:543),release 无法打印"++++ Eliminated: N Allocate"(macro.cpp:1147-1152 的打印段)。

*关键设计: EA 把"对象会不会逃逸"变成一张可传播的图——每个理想节点只有一次映射(JavaObject/LocalVar/Field),逃逸状态沿边单调上升(NoEscape→ArgEscape→GlobalEscape),所以传播必然收敛。精确性来自两个地方: 逐字段的 `Field` 节点让"字段逃逸"与"对象逃逸"分开计数;`scalar_replaceable` 与 `escape` 两个维度分开判定——不逃逸是必要条件,可拆性是充分条件。这比 12-02 域 C1 的 bcEscapeAnalyzer(字节码级、保守)深一个量级,也因此只在 C2 的优化中期跑一次。*

## 核心悬念

三个引擎的分工落定: **IGVN** 处处收敛(六次调用)、**CCP** 乐观传播常量并切断不可达分支(全 TOP 初始化 → root 前向 worklist → transform_once 常量替换与 Region 切割)、**EA** 用 ConnectionGraph 证明 NoEscape 并用 PhaseMacroExpand 完成标量替换(开关对照: 0 次 GC vs 6 次 GC)。但最常被优化的代码不是直线——**循环**。C2 的循环优化(循环不变量外提、剥皮、展开、范围检查消除、以及 SuperWord 向量化)是建立在 LoopNode/CountedLoopNode 上的另一套体系,而且它在编译期管线里占据了比 EA 更长的篇幅。下一篇: 循环。

> → [15-c2-compiler/04 — 循环优化: LoopNode + unrolling + SuperWord](openjdk/vol-02/15-c2-compiler/04-c2-loops.md)
