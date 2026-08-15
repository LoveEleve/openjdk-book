# 01. C2 Ideal Graph — Node + Type + IGVN

> 🔴 Deep | 16 KP 中的 3 个核心机制——C2 IR 基础
> 读者处境: C2 的 IR 不是 C1 的 basic block based——是 **sea-of-nodes** (graph): Node 有 def-use edges(`_in`/`_out`), 算法运行在图上。每个 Node 有 `Ideal()`(优化 hook)/`Value()`(类型推导)/`Identity()`(代数化简)——三个方法形成 IGVN 的迭代三环。

### 1. "Node — sea-of-nodes 的图节点"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"Ideal() 返回优化后的 Node 或 this(NOP=无优化)" 错(重要)**: 返回 **NULL=无变化**(默认实现 node.cpp:1144-1146);**改了图必须返回新根**(原地改输入也返回 this);**禁止返回旧节点**(返回旧节点走 Identity,node.cpp:1100-1138 "treatise" 注释)
> - **"AddNode 的 in[0]=Parm_a" 场景错**: `AddNode` 构造 `Node(0,in1,in2)`——第一个参数是 **NULL 控制槽**(addnode.hpp:44),in(0) 存在但恒 NULL(控制无关节点可浮动,loopopts.cpp:1379);in(1)=a/in(2)=b;场景实为 Parse 期 `_gvn.transform`(parse2.cpp:2250-2253)当场折叠
> - **"_cnt 当前 input edge 数量" 半对**: `_cnt`=**required 输入数**(node.hpp:291),`_max`=数组长度(:293),required 与 precedence 两类边(:285-290)
> - **补充机制**: ①三类边按**索引位置**约定——in(0)=控制(Region/If/Load 等)、数据边 in(1..)、MemNode 专属内存边槽(memnode.hpp:52-58 Control/Memory/Address/ValueIn);"sea of nodes"注释在 loopnode.hpp:992;②节点内存=node_arena 分配+**delete 是 NOP**(node.hpp:231-240);③身份=Opcode()(node.hpp:786,classes.hpp 宏表生成 opcodes.hpp:31-49)+class_id/_flags 位(node.hpp:736-760)+DEFINE_CLASS_QUERY 位掩码查询(:792-800);④ParmNode=StartNode 投影(callnode.hpp:101-106,parse1.cpp:831);⑤建图即优化(单遍 PhaseGVN,非两个阶段)


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

### 2. "Type — C2 类型 lattice"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"TypePtr::NotNull" 名字错**: 真实 **`TypePtr::NOTNULL`**(type.hpp:919)
> - **"TypePtr(NULL).meet(NotNull)→Ptr(放弃 nullness)" 错(重要)**: ptr_meet 表(type.cpp:2460-2468)**Null∩NotNull=BotPTR(空集=矛盾)**——类型矛盾即死路径,不是"放弃 nullness"
> - **"子类覆写 meet_helper()" 错**: 覆写的是 **xmeet**(type.hpp:241 虚函数);meet→meet_helper(type.cpp:848,处理 narrow/speculative)→xmeet 分派
> - **行号漂移**: Type 类 :74、TYPES 枚举 :78-118、TOP/BOTTOM :412-421、TypeInt :537、TypePtr :813(大纲"48-230"为旧范围)
> - **补充机制**: ①TypeInt::make 走 **hash-cons**(type.cpp:1429-1449+707-745)类型全局唯一不可变,比较即指针相等;TypeInt::xmeet "Expand covered set"(:1487-1489)扩并集;xdual=翻转 hi/lo(:1494-1497);②不同类指针 meet 退 NotNull+类 LCA(:3977-3986)、不同常量退 NotNull(:3963-3972);③PhiNode::Value 起点 TOP 逐路 **meet_speculative**(cfgnode.cpp:918-1009,:1007);④join=dual(meet(dual))(type.hpp:244-253)


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

### 3. "IGVN — 迭代全局值编号 (Ideal→Value→Identity 三环)"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"igvn.cpp:100-200" 文件不存在**: JDK11 无 igvn.cpp;NodeHash::hash_find_insert 在 **phaseX.cpp:143-198**
> - **"transform 三环(Ideal→Value→Identity)" 不全(重要)**: 真实 **transform_old 五步**(phaseX.cpp:1283-1402): ①Ideal 循环(返回 NULL 停,每次把旧节点用户入队)②Value 重算类型(变窄→set_type+raise_bottom_type+用户入队)③**singleton→makecon 换常量**④apply_identity ⑤**hash_find_insert 全局 CSE**——大纲漏③⑤
> - **"IGVN 第一轮折叠 x+0/x*1" 错(重要)**: 折叠在 **Parse 期单遍 PhaseGVN::transform_no_reclaim 就发生**(phaseX.cpp:864-924 同款流程无 worklist;AddNode::Identity 对称双侧检查 addnode.cpp:56-61/MulNode::Identity mulnode.cpp:52-61;parse2.cpp:2252)——图中不会出现 AddI(x,0);IGVN 价值=worklist 迭代到不动点+全局值编号+can_reshape 结构改写
> - **补充机制**: ①worklist 初值=Parse 期 for_igvn 清单(phaseX.cpp:992-993),Parse 末尾先 PhaseRemoveUseless(compile.cpp:844)再 Optimize;②optimize 守卫=check_node_count(compile.hpp:907-914,余量 NodeLimitFudgeFactor×2,c2_globals.hpp:471)+**K=1024×live_nodes 死循环判定**(globalDefinitions.hpp:255,phaseX.cpp:1235);③NodeHash 75% 扩容(phaseX.hpp:82-83);subsume_node 剪边重连(:1527);remove_dead_node;④IGVN 在 Optimize 中多次运行(compile.cpp:2247-2254/:2321/:2332/:2388-2391/:2424/:2454),阶段名 phasetype.hpp;⑤实证边界: PrintIdeal/PrintIdealGraph **notproduct**(c2_globals.hpp:101/:371)release 拒启;PrintOptoAssembly diagnostic 但实现 NOT_PRODUCT(compile.cpp:718-733/output.cpp:1554)release 静默;PrintCompilation/-Xlog:jit+compilation、CITime 阶段树、PrintInlining(diagnostic)可用


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

---

### 核心悬念

**"C2 ideal graph: sea-of-nodes(control+data+memory 统一 DAG)→Type lattice(meet/join)→IGVN(Ideal→Value→Identity fixpoint 迭代)。不是 C1 的 basic blocks——算法在图上运行——优化比 C1 深一个数量级。"** — 下一篇: Parse——字节码怎么变成这些 Node。

> → [02-c2-parse-graphkit.md](02-c2-parse-graphkit.md)
