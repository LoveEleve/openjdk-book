# 01. C2 Ideal Graph: Node + Type + IGVN — C2 的节点海

> **前置依赖**:[14-c1-compiler/04 — Runtime1 + FrameMap: C1 runtime 与栈帧](openjdk/vol-02/14-c1-compiler/04-c1-runtime-frame.md):C1 的完整画像,本篇讲 C2 的对立面——它的 IR 是图不是块;[13-jit-framework/01 — 谁决定编译、怎么排队、谁执行?— CompileBroker 编译队列](openjdk/vol-02/13-jit-framework/01-compile-broker-queue.md):C2 编译任务怎么进来;[12-ci/01 — JIT 怎么看到 Java 类?— ciObject 镜像体系](openjdk/vol-02/12-ci/01-ci-overview-mirror.md):C2 读的 ci 镜像在这里
> → **后续**:[15-c2-compiler/02 — Parse + GraphKit: 字节码→Ideal Graph](openjdk/vol-02/15-c2-compiler/02-c2-parse-graphkit.md)
> 关联域: 12-ci(编译期镜像)、13-jit-framework(编译入口)、16-code-cache(nmethod 产物)

## C1 的"够用"之上,是一张图

C1 的 HIR 是**块 + 指令**的线性 IR:每个基本块一串指令,Phi 在块头汇合。这种结构好编译、快出码,但"全局"优化很难做——一个值跨块流动,要么建 Phi 要么做数据流分析。C2 换了一条路:它把整个方法建成**一张图**——每个操作是一个节点,节点之间用边连接,控制流、数据流、内存流都是同一种边。这张"节点海"(sea of nodes)让优化算法直接在图上跑:一个节点被化简,顺着边就能找到所有受影响的消费者。

这篇拆 C2 IR 的三个支柱: **Node**(图节点与三类边)、**Type**(节点上的类型格)、**IGVN**(在图上迭代到不动点的优化引擎)。顺带纠正大纲三处: `Ideal()` 返回 `NULL` 表示"无变化"而非 `this`;`TypePtr::NotNull` 的真实名字是 `NOTNULL`,且 `Null meet NotNull = BotPTR`(矛盾,不是"放弃 nullness");`igvn.cpp` 在 JDK11 不存在,`hash_find_insert` 在 `phaseX.cpp`。

## 1. Node — 图节点与三类边

`int sum = a + b` 编译时,Parse 构建三个节点: `ParmNode`(方法参数 a)、`ParmNode`(参数 b)、`AddINode`(a+b)。AddI 的输入边指向两个 Parm。关键在于 **`in()`/`out()` 是双向 def-use 边**,不是 C1 的"谁持有谁的指针":

```cpp
// node.hpp:282-301(截取核心,逐字)
  Node **_in;                   // Array of use-def references to Nodes
  Node **_out;                  // Array of def-use references to Nodes

  // Input edges are split into two categories.  Required edges are required
  // for semantic correctness; order is important and NULLs are allowed.
  // Precedence edges are used to help determine execution order and are
  // added, e.g., for scheduling purposes.  They are unordered and not
  // duplicated; they have no embedded NULLs.  Edges from 0 to _cnt-1
  // are required, from _cnt to _max-1 are precedence edges.
  node_idx_t _cnt;              // Total number of required Node inputs.

  node_idx_t _max;              // Actual length of input array.

  // Output edges are an unordered list of def-use edges which exactly
  // correspond to required input edges which point from other nodes
  // to this one.  Thus the count of the output edges is the number of
  // users of this node.
  node_idx_t _outcnt;           // Total number of Node outputs.
```

`_in[]` 是"我依赖谁",`_out[]` 是"谁依赖我"——后者正是 IGVN 能"改一个节点、顺着边级联"的物理基础。节点本身从 `Compile::node_arena()`(Arena,09-03 域)批量分配,`operator delete` 是**空操作**——死节点不真正销毁,由 Arena 一次性回收(node.hpp:231-240 "Delete is a NOP")。

**三类边如何区分**: 输入边按**索引位置**约定,而不是打标签。对控制敏感的节点(Region/If/Proj/Call/Load/Store 等)用 `in(0)` 放**控制边**(最近的 IfTrue/IfFalse/Region 投影);纯算术节点反过来——`AddNode` 构造时第一个输入传 `NULL`(`Node(0,in1,in2)`,addnode.hpp:44),**in(0) 槽存在但恒为 NULL**,表示"没有控制输入,可以随意浮动"(loopopts.cpp:1379 "has no control edge (can float about)"),最终位置由全局调度(GCM)决定;读写内存的节点另有**内存边**——`MemNode` 的枚举明确写着每个槽的含义:

```cpp
// memnode.hpp:52-58(截取核心,逐字)
  enum { Control,               // When is it safe to do this load?
         Memory,                // Chunk of memory is being loaded from
         Address,               // Actually address, derived from base
         ValueIn,               // Value to store
         OopStore               // Preceeding oop store, only in StoreCM
  };
```

于是同一个 `LoadI` 节点同时牵着三条链: 控制链(什么时候可以安全读,`in(0)`)、内存链(读哪块内存——`in(MemNode::Memory)`,挂在最近的 Store 或 `MergeMemNode` 上)、地址链(`in(MemNode::Address)`)。"sea of nodes" 的说法在源码注释里原样出现(loopnode.hpp:992 "Dominators for the sea of nodes";domgraph.cpp:386 "Compute the dominator tree of the sea of nodes")。

Parse 每遇到一条字节码就建节点并**立即交给 GVN 化简**(parse2.cpp:2250-2253)——"建图"和"优化"在 C2 里不是两个阶段:

```cpp
// parse2.cpp:2250-2253(截取核心,逐字)
  case Bytecodes::_iadd:
    b = pop(); a = pop();
    push( _gvn.transform( new AddINode(a,b) ) );
    break;
```

`a`、`b` 是 parse1.cpp:831 从 `StartNode` 投影出来的 `ParmNode`(callnode.hpp:101-106),`_gvn` 是编译期全程持有的单遍 GVN(PhaseGVN)。**每个节点的身份**由三样东西决定: `Opcode()`(node.hpp:786,返回 `Op_AddI`/`Op_LoadI`/`Op_If` 等枚举,枚举由 classes.hpp 的宏表生成,opcodes.hpp:28-49)、`class_id` 与 `_flags` 位标志(如 `Flag_is_Con`/`Flag_is_macro`,node.hpp:736-760)、以及类型。`is_Add()/as_Add()` 这类查询由 `DEFINE_CLASS_QUERY` 宏展开成位掩码测试(node.hpp:792-800)。

**三个优化钩子**是所有节点共同的接口(node.hpp:977-986):

- `Identity(PhaseGVN*)` — 返回"与我等价的既有节点"(`x+0 → x` 的加法单位元);默认返回 `this`(node.cpp:1081-1083)。
- `Value(PhaseGVN*)` — 用输入的类型算出本节点的类型,默认返回最坏情况 `bottom_type()`(node.cpp:1087-1089)。
- `Ideal(PhaseGVN*, bool can_reshape)` — 图改写: 返回改写后子图的根节点;默认返回 `NULL` = "已经很理想了"(node.cpp:1144-1146)。

`Ideal` 的返回值约定是 C2 最容易被误解的地方——大纲写"返回优化后的 Node 或 this(NOP=无优化)"。源码的规矩更细(node.cpp:1091-1146 的大段注释,即 node.hpp:984 说的 "read the treatise"):

```cpp
// node.cpp:1100-1138(截取核心,逐字)
// The Ideal call almost arbitrarily reshape the graph rooted at the 'this'
// pointer.  If ANY change is made, it must return the root of the reshaped
// graph - even if the root is the same Node.  Example: swapping the inputs
// to an AddINode gives the same answer and same root, but you still have to
// return the 'this' pointer instead of NULL.
//
// You cannot return an OLD Node, except for the 'this' pointer.  Use the
// Identity call to return an old Node; basically if Identity can find
// another Node have the Ideal call make no change and return NULL.
//
// You cannot modify any old Nodes except for the 'this' pointer.  Due to
// sharing there may be other users of the old Nodes relying on their current
// semantics.  Modifying them will break the other users.
```

三条铁律: **①返回 `NULL` = 无变化**(默认);**②改了图必须返回新根**(原地改输入也返回 `this`);**③想返回"别的旧节点"走 Identity,不许从 Ideal 里返回旧节点**——因为 IGVN 对 Ideal 的返回值会当作新根继续循环理想化,而旧节点的用户会被入队重新处理,返回值约定错了就破坏 worklist 一致性。

*关键设计: 把控制流、数据流、内存流统一成同一张图的边,优化就变成了纯粹的图变换——改写一个节点,def-use 边自动暴露所有消费者;而 C1 的块结构让"跨块优化"必须显式建 Phi。代价是图必须小心维护:`set_req` 每次改写都同步更新双向边,死节点靠 IGVN 回收(remove_dead_node)。*

## 2. Type — 节点上的类型格

图有了,还要给每个节点一个"运行期可能取值"的抽象。C2 用**类型格**(Type lattice): 越靠近格顶越"宽泛未知",越靠近格底越"精确",最底 `Type::BOTTOM` 是空集(不可能)。格顶 `Type::TOP` 是"未知"(type.hpp:78-118 的枚举,`:412-421` 的静态成员)。

`int y = (x > 0) ? x : 0` 在图中是一个 `PhiNode`(cfgnode.hpp:120)合并两路: 真分支的 x 类型 `TypeInt[1, max_jint]`,假分支的常量 0 类型 `TypeInt[0,0]`。`PhiNode::Value` 把各路输入用 `meet_speculative` 逐路合并(cfgnode.cpp:918-1009),起点 `Type::TOP`:

```cpp
// type.cpp:1455-1490(截取核心,逐字)
const Type *TypeInt::xmeet( const Type *t ) const {
  // Perform a fast test for common case; meeting the same types together.
  if( this == t ) return this;  // Meeting same type?

  ...
  // Expand covered set
  const TypeInt *r = t->is_int();
  return make( MIN2(_lo,r->_lo), MAX2(_hi,r->_hi), MAX2(_widen,r->_widen) );
}
```

区间型的 meet 是"扩并集": `[0,10] meet [5,15] = [0,15]`——比未知(TOP)精确,比单支路粗。`TypeInt::make` 走 **hash-cons**: 相同类型的实例全局唯一、创建后不可变(type.cpp:1429-1449;type.cpp:707-745 "Do the hash-cons trick"),所以类型比较只是指针比较。

指针类型的 meet 走 **`ptr_meet` 查找表**(type.cpp:2460-2468)——这里藏着一个大纲写反的关键点:

```cpp
// type.cpp:2460-2468(截取核心,逐字)
const TypePtr::PTR TypePtr::ptr_meet[TypePtr::lastPTR][TypePtr::lastPTR] = {
  //              TopPTR,    AnyNull,   Constant, Null,   NotNull, BotPTR,
  { /* Top     */ TopPTR,    AnyNull,   Constant, Null,   NotNull, BotPTR,},
  { /* AnyNull */ AnyNull,   AnyNull,   Constant, BotPTR, NotNull, BotPTR,},
  { /* Constant*/ Constant,  Constant,  Constant, BotPTR, NotNull, BotPTR,},
  { /* Null    */ Null,      BotPTR,    BotPTR,   Null,   BotPTR,  BotPTR,},
  { /* NotNull */ NotNull,   NotNull,   NotNull,  BotPTR, NotNull, BotPTR,},
  { /* BotPTR  */ BotPTR,    BotPTR,    BotPTR,   BotPTR, BotPTR,  BotPTR,}
};
```

`Null` 与 `NotNull` 的 meet 是 **`BotPTR`**(空集)——"既空又非空"不可能成立,不是大纲说的"放弃 nullness 信息变成 Ptr"。这正是 C2 用类型矛盾剪死路径的机制: 一个节点类型变成空集,依赖它的分支/Phi 就判死,最终由 IGVN 的 `remove_dead_node` 或后续阶段清掉。同格的关系由 `xmeet`/`xdual` 虚函数分派(`meet()` → `meet_helper` → `xmeet`,type.hpp:224-241): 同类精确值 meet 不变,不同类指针 meet 退到 `NotNull` + 类层次最低公共祖先(type.cpp:3977-3986),不同常量 meet 退 `NotNull`(两个不同的对象不可能是同一个,type.cpp:3963-3972)。

`dual()` 是绕格心"镜像"(type.hpp:236-238): 区间型就是**翻转 hi/lo**(type.cpp:1494-1497 "Dual: reverse hi & lo; flip widen")——`[0,10]` 的 dual 是 `[10,0]`,即"区间补集",用于按 `join = dual(meet(dual()))` 构造上界(type.hpp:244-253)。

*关键设计: 类型是"价值集"的抽象——格顶 TOP 是"什么值都可能"(最不精确但永远安全),格底 BOTTOM 是"没有值"(矛盾即死代码)。Phi 合并用 meet 取"两种可能都覆盖的最精确类型",优化器拿这个类型去消除空指针检查、类型检查,甚至把整个分支判死。类型不可变 + hash-cons 让"比较类型"变成指针相等,IGVN 的热路径因此极快。*

## 3. IGVN — 迭代到不动点的优化引擎

**`x + 0` 和 `x * 1` 到底在哪一步被消掉?** 大纲把这一幕放在 IGVN 里,但源码比这更早——**Parse 建节点时**,单遍的 `PhaseGVN::transform_no_reclaim`(phaseX.cpp:864-924,和 IGVN 的 `transform_old` 同款流程,只是没有 worklist、不做级联)就已经在化简: `AddNode::Identity` 对称检查两个输入,任一侧类型是加法单位元就返回另一侧(类注释 "We look for "add of zero" as an identity" 在 addnode.hpp:52-54;实现 addnode.cpp:56-61);`MulNode::Identity` 同理消 `x*1`(mulnode.cpp:52-61)。所以图中根本不会出现 `AddI(x, 0)` 节点。IGVN 的真正价值不是"第一轮折叠",而是 **worklist 迭代到不动点 + 全局值编号 + 结构性图改写**(`can_reshape=true`)。

单节点 transform 的完整流程在 `transform_old`(phaseX.cpp:1283-1402),五步:

```cpp
// phaseX.cpp:1283-1402(截取核心,逐字)
Node *PhaseIterGVN::transform_old(Node* n) {
  ...
  // Apply the Ideal call in a loop until it no longer applies
  Node* k = n;
  ...
  Node* i = apply_ideal(k, /*can_reshape=*/true);
  ...
  while (i != NULL) {
    ...
    // Made a change; put users of original Node on worklist
    add_users_to_worklist(k);
    // Replacing root of transform tree?
    if (k != i) {
      // Make users of old Node now use new.
      subsume_node(k, i);
      k = i;
    }
    ...
    i = apply_ideal(k, /*can_reshape=*/true);
  }

  // See what kind of values 'k' takes on at runtime
  const Type* t = k->Value(this);
  ...
  if (type_or_null(k) != t) {
    set_type(k, t);
    // If k is a TypeNode, capture any more-precise type permanently into Node
    k->raise_bottom_type(t);
    // Move users of node to worklist
    add_users_to_worklist(k);
  }
  // If 'k' computes a constant, replace it with a constant
  if (t->singleton() && !k->is_Con()) {
    Node* con = makecon(t);     // Make a constant
    add_users_to_worklist(k);
    subsume_node(k, con);       // Everybody using k now uses con
    return con;
  }

  // Now check for Identities
  i = apply_identity(k);      // Look for a nearby replacement
  if (i != k) {                // Found? Return replacement!
    add_users_to_worklist(k);
    subsume_node(k, i);       // Everybody using k now uses i
    return i;
  }

  // Global Value Numbering
  i = hash_find_insert(k);      // Check for pre-existing node
  if (i && (i != k)) {
    add_users_to_worklist(k);
    subsume_node(k, i);       // Everybody using k now uses i
    return i;
  }

  // Return Idealized original
  return k;
}
```

五步的顺序本身就有讲究: **①Ideal 循环**——反复改写直到返回 NULL,每次改写都把旧节点的用户入队;②`Value()` 重算类型,变窄就缓存进类型表并**把用户入队**(类型精确化是级联优化的燃料);③类型是单例就替换成常量(`makecon`,phaseX.cpp:755-769);④`Identity()` 返回既有等价节点;⑤`hash_find_insert()` **全局 CSE**——`NodeHash` 表里已存在 opcode+输入都相等的节点就替换掉(phaseX.cpp:143-198;表 75% 满时翻倍扩容,phaseX.hpp:82-83)。`subsume_node`(phaseX.cpp:1527)做实际的"剪边重连": 遍历旧节点的 `_out`,把所有用它的边改指向新节点,然后递归清掉死节点。

驱动这一切的是 `optimize()` 的 worklist 主循环(phaseX.cpp:1223-1251):

```cpp
// phaseX.cpp:1223-1251(截取核心,逐字)
void PhaseIterGVN::optimize() {
  ...
  uint loop_count = 0;
  // Pull from worklist and transform the node. If the node has changed,
  // update edge info and put uses on worklist.
  while(_worklist.size()) {
    if (C->check_node_count(NodeLimitFudgeFactor * 2, "Out of nodes")) {
      return;
    }
    Node* n  = _worklist.pop();
    if (++loop_count >= K * C->live_nodes()) {
      DEBUG_ONLY(dump_infinite_loop_info(n);)
      C->record_method_not_compilable("infinite loop in PhaseIterGVN::optimize");
      return;
    }
    DEBUG_ONLY(trace_PhaseIterGVN_verbose(n, num_processed++);)
    if (n->outcnt() != 0) {
      NOT_PRODUCT(const Type* oldtype = type_or_null(n));
      // Do the transformation
      Node* nn = transform_old(n);
      NOT_PRODUCT(trace_PhaseIterGVN(n, nn, oldtype);)
    } else if (!n->is_top()) {
      remove_dead_node(n);
    }
  }
  NOT_PRODUCT(verify_PhaseIterGVN();)
}
```

工作清单初值不是空的: Parse 期每建一个"值得再看一眼"的节点就 `record_for_igvn` 登记进 `Compile::_for_igvn`(compile.cpp:757 "Node list that Iterative GVN will start with"),`PhaseIterGVN` 构造时把整张清单抄进 `_worklist`(phaseX.cpp:992-993)。时序上 Parse 末尾先跑 `PhaseRemoveUseless` 清掉解析产生的死节点(compile.cpp:841-844,注释 "Remove clutter produced by parsing"),`Optimize()` 的第一个动作才是 IGVN 全图迭代。两个守卫是工程细节也是设计声明: 活节点数接近上限时放弃编译(`check_node_count`,compile.hpp:907-914——optimize 里带 `NodeLimitFudgeFactor * 2` 的余量,c2_globals.hpp:471);循环次数超过 **`K * live_nodes()`**(`K = 1024`,globalDefinitions.hpp:255)判定"无限循环"放弃——**IGVN 承诺终止,靠的是这两道闸**。

IGVN 在 C2 管线里不止跑一次。`Compile::Optimize`(compile.cpp:2220)中: Parse 后第一次全图迭代(compile.cpp:2247-2254 "Iterative Global Value Numbering, including ideal transforms"),逃逸分析/宏消除后各一次(:2321/:2332),CCP 之后收尾一次(:2388-2391),range-check cast 与 opaque4 移除后再各补一次(:2424/:2454)。阶段名留在 phasetype.hpp:28-63(`PHASE_ITER_GVN1`/`PHASE_ITER_GVN2`)——这就是 IGVN 的"心脏"地位: 每次结构变换之后都要把它重跑一遍。

**实证边界**: 理想图本身在 release 构建里**不可见**——`PrintIdeal`/`PrintIdealGraph` 都是 notproduct(c2_globals.hpp:101/:371),release 直接拒绝启动([实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/15-c2-ideal-graph-demo.txt)第 3/4 段: "VM option 'PrintIdeal' is notproduct and is available only in debug version of VM");`PrintOptoAssembly` 虽是 diagnostic 标志,但**从标志处理到汇编打印整个包在 `#ifndef PRODUCT` 里**(compile.cpp:718-733;output.cpp:1554 起的 dump 段),release 静默无输出(实证第 5 段)。能观察的是编译事件与阶段计时: `-Xlog:jit+compilation=debug` 显示每个方法的**编译事件**(实证第 1 段: `idn`/`phi` 最终编译到 level 4,`cfold`(常量方法,2 字节)编到 level 1 为止,旧的 level 2 nmethod 全部 `made not entrant`);`-XX:+CITime` 打印完整阶段树——Parse / Optimize(GVN 1 / IGVN / Cond Const Prop / GVN 2)/ Matcher / Scheduler / Regalloc(实证第 6 段)。折叠行为也有一个间接实证: `bigsum()` 里 50 个 `1+1+…` 在 **javac 编译期**就已折叠成 `bipush 50`(字节码 3 字节,实证第 7 段 "bigsum (3 bytes)")——常量折叠从 javac 到 C2 层层都在做。

*关键设计: IGVN 是"懒计算的定点迭代"——只处理 worklist 上的节点,一个节点的类型变窄只把它的**消费者**入队,而不是全图重扫。这比 C1 的"固定趟数"深一个数量级: C1 是规定次数的规范化,C2 是迭代到"再改也不会有新变化"。代价是终止性要靠 K 守卫,而任何新的 `Ideal()` 改写都必须守 node.cpp 的返回值铁律,否则破坏 worklist 一致性。*

## 核心悬念

C2 的世界观在这里立住了: **节点**用双向 def-use 边把控制、数据、内存织成一张图;每个节点顶着一个来自**类型格**的精确类型(TOP 未知、BOTTOM 不可能、区间型 meet 扩并集、指针型 meet 查表——`Null meet NotNull = BotPTR` 即矛盾);**IGVN** 用 worklist 迭代把这三种钩子(`Ideal`/`Value`/`Identity`)+ 哈希 CSE 推到不动点,而且贯穿整个编译期反复运行。但图从哪来? 前面只看到 Parse 一句 `_gvn.transform(new AddINode(a,b))` 和 `record_for_igvn` 的登记——字节码怎么逐步变成这堆节点、控制边怎么在 `do_ifnull`/`merge_common` 里生长、异常边与 safepoint 怎么挂进图里,是下一篇的事。

> → [15-c2-compiler/02 — Parse + GraphKit: 字节码→Ideal Graph](openjdk/vol-02/15-c2-compiler/02-c2-parse-graphkit.md)
