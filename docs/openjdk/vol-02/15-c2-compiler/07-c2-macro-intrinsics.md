# 07. PhaseMacroExpand — 高层抽象→低层 MachNode 展开

> **前置依赖**:[15-c2-compiler/03 — IGVN + CCP + Escape Analysis: C2 优化三引擎](openjdk/vol-02/15-c2-compiler/03-c2-optimizations.md):EA 的 eliminate_macro_nodes(标量替换/锁消除)在这里,本篇讲 expand_macro_nodes(最终展开);[15-c2-compiler/06 — Matcher + Code Generation: DFA 指令选择 → x86 机码](openjdk/vol-02/15-c2-compiler/06-c2-codegen.md):展开后的纯 MachNode 交给 Matcher/Output;[15-c2-compiler/05 — Chaitin: 图着色寄存器分配 O(n²)](openjdk/vol-02/15-c2-compiler/05-c2-register-alloc.md):展开产物进入 RA
> → **后续**:[15-c2-compiler/08 — library_call.cpp: 6991 行的 intrinsic 世界](openjdk/vol-02/15-c2-compiler/08-c2-library-calls.md)
> 关联域: 19-sync(monitor 底层)、23-stub(数组拷贝 stub)、16-code-cache(nmethod)

## 宏节点的一生

`Allocate`/`AllocateArray`/`Lock`/`Unlock`/`ArrayCopy` 这类节点在优化期被 IGVN 与 EA "挂起"(标记 `Flag_is_macro`,进 Compile 的宏节点列表),是因为它们**要么该被消除(EA 证明),要么展开成本高(一个分配点展开成 ~200 个节点)**,提前展开会污染优化视图。`PhaseMacroExpand` 是它们的"审判日"——03 篇讲了 EA 后的 `eliminate_macro_nodes`(能消的消),本篇讲循环优化之后、Matcher 之前的 **`expand_macro_nodes`**(剩下的必须展开成真机器指令)。顺带纠正大纲四处: `eliminate_locking_nodes` 函数名与行号都不对(真实 `eliminate_locking_node` macro.cpp:2182);`scalar_replacement` 在 :759 而非 100-400;`expand_arraycopy_node` 在 macroArrayCopy.cpp:1106 而非 50-300;"FastLockNode→cmpxchg 直接发码"不存在——展开产生的是调用/分支结构,不是裸 cmpxchg。

## 1. expand_macro_nodes — 编排

`expand_macro_nodes`(macro.cpp:2645)是 15 域 C2 管线(compile.cpp:2432-2440 调用)的最后一次结构变换:

```cpp
// macro.cpp:2645-2657(截取核心,逐字)
bool PhaseMacroExpand::expand_macro_nodes() {
  // Last attempt to eliminate macro nodes.
  eliminate_macro_nodes();
  if (C->failing())  return true;

  // Make sure expansion will not cause node limit to be exceeded.
  // Worst case is a macro node gets expanded into about 200 nodes.
  // Allow 50% more for optimization.
  if (C->check_node_count(C->macro_count() * 300, "out of nodes before macro expansion" ) )
    return true;

  // Eliminate Opaque and LoopLimit nodes. Do it after all loop optimizations.
  bool progress = true;
```

流程: **①最后试一次消除**(eliminate_macro_nodes,03 篇已拆);②**节点预算**(一个宏节点最坏展开成约 200 节点,按 `macro_count*300` 预算,注释 "Allow 50% more for optimization");③**清理临时节点**(Opaque1/2 → 替换为输入、LoopLimit → 入 IGVN worklist、`MaxL/MinL → CMoveL`、OuterStripMinedLoop 调整,:2656-2721);④**arraycopy 先行**(:2723-2740,注释 "For ReduceBulkZeroing, we must first process all arraycopy nodes before the allocate nodes are expanded"——数组拷贝会消费分配,顺序必须固定);⑤**主循环**(:2744-2771): 按类分派 `expand_allocate`/`expand_allocate_array`(:1987)/`expand_lock_node`(:2259)/`expand_unlock_node`(:2497),不可达宏节点直接摘除;⑥收尾 `_igvn.optimize()` + GC 屏障集的宏展开(:2773-2777)。

## 2. 分配的两条出路 — 消除与展开

**能消除的**(EA 证明 NoEscape+scalar_replaceable): `eliminate_allocate_node`(macro.cpp:1091,四道门在 03 篇已拆)→ `scalar_replacement`(:759)把分配拆成字段级定义,`process_users_of_allocation`(:946)删除 Store、消除 GC 屏障(03 篇已证: 2 亿次循环 new Point,EA 开 0 次 GC)。**必须在堆上存在的**: `expand_allocate`(:1981)→ `expand_allocate_common`(:1286)生成 `slow_result_path/fast_result_path` 两个 Region 分支——**快路径内联 TLAB bump,initial_slow_test(太大/需 GC)与 TLAB 满才跳慢路径调用**(`OptoRuntime::new_instance_Java`,:1286-1290;注释 "The initial slow comparison is a size check",:1310;dtrace 探针或 `-XX:-UseTLAB` 强制全慢,:1321-1326)。这条"快速路径内联、慢路径调用"的结构与 14-c1/04 域 Runtime1 的分配 stub 同构,`-XX:-UseTLAB` 也是 14-c1/04 篇验证过的间接观察手段。

标量替换与**安全点**的接口是 `SafePointScalarObjectNode`(callnode.hpp:492): 被拆掉的对象在安全点处已无 oop 可扫,但 deopt 时还需要它的字段值——该节点记录 `_first_index`/`_n_fields`(注释 "states of the scalarized object fields are collected",:493-496),把字段值挂在 JVMS 的标量区(scloff,02 篇的槽位布局)供 deopt 重建与 GC 扫描。这就是大纲说"GC 仍可 trace 这些值"的准确机制——不是寄存器里的值,是挂在 deopt 数据里的快照。

## 3. 锁与数组拷贝的展开

**锁的两条出路**: ①**消除**——`eliminate_locking_node`(macro.cpp:2182): 检查 `is_eliminated()`(标记来自 EA 的 `non_esc_obj`,03 篇 optimize_ideal_graph 里 EliminateLocks 打的标),命中就**连同 MemBarAcquireLock/MemBarReleaseLock 一起拆掉**、FastLock 唯一用户时也删(:2223-2236/:2240-2250)——`synchronized(new Object())` 的锁在展开阶段整个蒸发;②**展开**——`expand_lock_node`(:2259): 生成 `fast_lock_region` + `slow_path` 结构(有偏锁模式检测的快速路径与慢路径分支,:2266-2272)——展开产物是**分支与控制流**,不是大纲说的"cmpxchg 直接发码"(真正发 cmpxchg 的是运行时/汇编 stub,23-stub 域的 SharedRuntime 锁助手;这里只是接线)。大纲的"嵌套 synchronized 合并为单锁"表述也偏了: 嵌套锁主要靠**消除**(对象不逃逸全消),"coarsening"是 `mark_eliminated_locking_nodes`(:2577)对合并锁标记的再处理,不是"两个 FastLockNode 合并成一个"。

**数组拷贝**: `expand_arraycopy_node`(macroArrayCopy.cpp:1106)按 ArrayCopyNode 的形态分派——`clonebasic`(裸内存克隆,直接走 `clone_at_expansion`)、`copyof`/`cloneoop`(对象数组,带屏障)、普通 arraycopy;统一落到 `generate_arraycopy`(:278)做**编译期检查**(源/目标类型、长度,能静态证安全的才走快速路径,:1154-1157 注释 "Compile time checks...we do not make a fast path for this call")与类型特化(disjoint/conjoint 与基本类型分派)——大块拷贝实现在 23-stub 域的 stub 生成器里(按元素宽度选最快的向量拷贝循环,23-stub/02 已拆),这里生成对桩的调用或就地展开拷贝。实证([素材](planning/outlines/00-jvm-tools/materials/commands/15-c2-macro-demo.txt)第 1 段): `System.arraycopy` 在 PrintInlining 里显示 `intrinsic`(0 字节 native 方法被 intrinsic 替换);`lockElim` 方法整体内联(`synchronized(new Object())` 的锁走消除路径)。

*关键设计: 宏节点是"延迟决策"的载体——EA 之前不展开(保持优化视图干净),EA 之后先消除(能消的零成本),循环优化之后才展开(此时图已定型,展开结果不会被后续优化推翻)。展开本身也分层: arraycopy 先于分配(互相依赖),Opaque 等临时节点随手清掉,最后整体 IGVN 收敛——每个阶段的顺序都有依赖理由。*

## 核心悬念

15 域收官: C2 的全管线在此闭合——**Parse**(字节码→理想图)→ **IGVN/CCP/EA**(三引擎优化,宏节点挂起)→ **循环优化**(pre/main/post 三循环 + SuperWord)→ **Matcher**(.ad 规则选指令)→ **Chaitin**(图着色分配)→ **PhaseMacroExpand**(宏节点审判: 能消的消、必留的展开)。此后图里只有纯 MachNode,交给 Output 发码。但整条管线里藏着一类特殊的"优化"还没讲: **intrinsic**——`System.arraycopy`、`Math.sin`、`StringBuilder.append` 这类方法不按字节码编译,而是在 Parse 阶段直接被 `LibraryCallKit` 替换成理想图子图(library_call.cpp,6991 行,optp 最大的源文件)。这是 C2 性能的隐藏引擎。下一篇: intrinsic 世界。

> → [15-c2-compiler/08 — library_call.cpp: 6991 行的 intrinsic 世界](openjdk/vol-02/15-c2-compiler/08-c2-library-calls.md)
