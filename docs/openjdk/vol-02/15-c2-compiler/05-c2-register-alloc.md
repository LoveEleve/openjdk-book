# 05. Chaitin — 图着色寄存器分配 O(n²)

> **前置依赖**:[15-c2-compiler/04 — Loop Optimization + SuperWord: 循环变换与向量化](openjdk/vol-02/15-c2-compiler/04-c2-loops.md):循环优化后的图进入 RA;向量节点需要多寄存器对齐分配;[15-c2-compiler/01 — C2 Ideal Graph: Node + Type + IGVN](openjdk/vol-02/15-c2-compiler/01-c2-ideal-graph.md):RA 消费的是经过 Matcher 的机器节点;[14-c1-compiler/03 — LinearScan + LIR → x86 码](openjdk/vol-02/14-c1-compiler/03-c1-register-codegen.md):C1 的线性扫描分配,本篇的对照系
> → **后续**:[15-c2-compiler/06 — Matcher + Code Generation: DFA 指令选择 → x86 机码](openjdk/vol-02/15-c2-compiler/06-c2-codegen.md)
> 关联域: 14-c1(LinearScan 对照)、16-code-cache(nmethod)、24-frame(帧布局)

## 把图塞进 16 个寄存器

优化结束的理想图经过 Matcher 变成机器节点,但"用哪个寄存器"还没定。C2 用 **Chaitin 图着色**: 每个值的存活区间(Live Range Group, LRG)是图的顶点,两个 LRG 若在某时刻同时存活则连一条**干涉边**(IFG, Interference Graph);给图着色 = 让相邻顶点不同色 = 让同时存活的值用不同寄存器;颜色不够就 **spill** 到栈。这与 C1 的线性扫描(14-c1/03)是两种哲学: 线性扫描沿指令序列单遍分配(O(n)),图着色全局建图再约简(号称 O(n²))——精度换成本。顺带纠正大纲三处: `_hint_color` 不存在(真实是 `_copy_bias` + `bias_color`);Simplify/Select/split 的行号全错(Simplify 在 chaitin.cpp:1199 而非 200-330);"Chaitin-Briggs 一定终止"的证明不存在,真实是 `_trip_cnt` 工程上限。

## 1. IFG 与 LRG — 谁和谁不能同色

`Register_Allocate`(chaitin.cpp:336)是总入口。第一步是 **liveness + 干涉图**: `PhaseLive` 算活性,`build_ifg_virtual`(ifg.cpp:311)建图——注意它不是大纲说的"计算每个 LRG 的 [first_use, last_use) 区间",而是**对每个基本块做一次逆向扫描**(注释 "The IFG is built by a single reverse pass over each basic block",ifg.cpp:317-319):

```cpp
// ifg.cpp:311-333(截取核心,逐字)
void PhaseChaitin::build_ifg_virtual( ) {
  Compile::TracePhase tp("buildIFG_virt", &timers[_t_buildIFGvirtual]);

  // For all blocks (in any order) do...
  for (uint i = 0; i < _cfg.number_of_blocks(); i++) {
    Block* block = _cfg.get_block(i);
    IndexSet* liveout = _live->live(block);

    // The IFG is built by a single reverse pass over each basic block.
    // Starting with the known live-out set, we remove things that get
    // defined and add things that become live (essentially executing one
    // pass of a standard LIVE analysis). Just before a Node defines a value
    // (and removes it from the live-ness set) that value is certainly live.
    // The defined value interferes with everything currently live.  The
    // value is then removed from the live-ness set and it's inputs are
    // added to the live-ness set.
    for (uint j = block->end_idx() + 1; j > 1; j--) {
      Node* n = block->get_node(j - 1);

      // Get value being defined
      uint r = _lrg_map.live_range_id(n);
```

从块尾的 live-out 集出发倒走: 一条指令**定义**的值在被移出 live 集的那一刻,与**当前一切存活值**干涉(`interfere_with_live`,ifg.cpp:291);然后指令的输入加入 live 集。有一个关键豁免——**Copy 指令不产生干涉**(ifg.cpp:350-352 "Copies do not define a new value and so do not interfere"),这正是合并不了时插入 copy 的合法性来源: copy 的 src/dst 可以同色。

LRG 携带分配决策所需的度量(chaitin.hpp:50-67):

```cpp
// chaitin.hpp:56-67(截取核心,逐字)
  double _cost;                 // 2 for loads/1 for stores times block freq
  double _area;                 // Sum of all simultaneously live values
  double score() const;         // Compute score from cost and area
  ...
  uint _risk_bias;              // Index of LRG which we want to avoid color
  uint _copy_bias;              // Index of LRG which we want to share color
```

- `_cost`: 2(loads)/1(stores)×块频率——**热路径里的 LRG 代价高,spill 它更疼**;
- `_area`: 同时存活值之和——**面积大的 LRG spill 掉能释放更多寄存器**;
- `score()` = `raw_score(_cost, _area)`(chaitin.cpp:99/:103,注释 "Bigger area lowers score, encourages spilling this live range. Bigger cost raise score, prevents spilling")——**cost/area 比值越小越先被 spill**;
- `_copy_bias`: 希望与谁同色(来自 copy 的另一端)——**偏置着色**(`bias_color`,chaitin.hpp:689 "Helper function which implements biasing heuristic")让 copy 两端尽量同色,减少 spill code。大纲的 `_hint_color` 不存在。

`Register_Allocate` 的后续编排(:373-570): `de_ssa`(:373,SSA 出局,插入"虚拟 copy"——与 C1 的 SSA→LIR 出局同构)→ `gather_lrg_masks` + `live.compute`(:386-387)→ 基指针存活区间延伸到 GC 点(:397)→ `build_ifg_virtual`(:409)→ **aggressive coalesce**(PhaseAggressiveCoalesce,coalesce.cpp:447,:425-426)→ `insert_copies`(:429)→ 重建 live + `build_ifg_physical`(:450,物理寄存器约束 + **寄存器压力计算**——int/float 两路 Pressure 统计每块峰值压力(`INTPRESSURE` x86_64=13 等,c2_globals_x86.hpp:51,非 16——含保留寄存器),超可用数就返回 `must_spill` 计数,:823-836)→ 若 `must_spill` 先预分裂(:462)。

*关键设计: 干涉图是"同时存活"关系的一次性编码——逆向扫描天然得到每个定义点与存活集的干涉,无需显式区间;copy 不干涉 + 偏置着色是"图着色消除拷贝"的支点: 能合则合(消 copy),不能合则偏置同色(消 spill code)。*

## 2. Simplify + Coalesce — 图约简与拷贝合并

`Simplify`(chaitin.cpp:1199)把 IFG 约简成一个栈: **度数低于可用寄存器数的 LRG 必然可着色**,入栈并从 IFG 摘除(邻居度数随之下降,可能连锁进低度列表,:1206-1261);当低度列表为空(剩下的都是高度数)时,选 **score() 最小**的 LRG 作为"潜在 spill 候选"入栈(:1266-1274,注释 "Time to pick a potential spill guy")——注意它是**乐观**的: 候选只是先入栈,**不保证真 spill**,等 Select 阶段看有没有颜色。这就是大纲说的"Briggs Optimistic Coloring"的实质——但源码里没有 Briggs 命名,"Chaitin 原版无限循环"的对比也无从考证。

```cpp
// chaitin.cpp:1263-1274(截取核心,逐字)
    // Check for got everything: is hi-degree list empty?
    if( !_hi_degree ) break;

    // Time to pick a potential spill guy
    uint lo_score = _hi_degree;
    double score = lrgs(lo_score).score();
    double area = lrgs(lo_score)._area;
    double cost = lrgs(lo_score)._cost;
    bool bound = lrgs(lo_score)._is_bound;
```

**coalesce 在 Simplify 之前与之后各跑一轮**: `PhaseAggressiveCoalesce`(chaitin.cpp:425-426,按块频率从高到低,coalesce.cpp:128-134)在 SSA 出局的虚拟 copy 上激进合并——src/dst 无干涉就并成一个 LRG,合并失败才落成真 copy(`insert_copies`,chaitin.cpp:429);spill 分裂后的 `PhaseConservativeCoalesce`(chaitin.cpp:492/:566,保守合并——只有当合并后 LRG 度数仍低于可用寄存器数才合)收敛出 final 图。`OptoCoalesce` 是 develop flag(c2_globals.hpp:244)——release 下合并策略不可调。

*关键设计: Simplify 的"低度必可着色"是图着色的核心引理——度数 < N 的顶点总能找到空颜色,所以约简栈里越靠下的 LRG 越"难"染;spill 候选的选择用 score(cost/area)而不是裸 cost——热路径保护(高 cost)与全局利益(高 area 释放寄存器)的权衡。coalesce 的激进/保守两档对应"多消拷贝"与"保证可着色"的取舍。*

## 3. Select + Split — 逆序着色与 spill-split-recycle

`Select`(chaitin.cpp:1447)把约简栈逆序弹出,重新插入 IFG(:1469),**从邻居已占的颜色里排除**(`lrg->SUBTRACT(nlrg.mask())`,:1503),`choose_color` 挑一个空闲色(:1529)。栈槽也有"颜色"——`RegMask::CHUNK_SIZE` 分块,全栈 LRG(AllStack)在当前块无颜色时**滚动到下一块**(:1538-1541,注释 "Bump register mask up to next stack chunk")。选不到色的 LRG 标记 spill,`Select` 返回 spill 数。

真正的 spill 在 **`Split`**(reg_split.cpp:496)与**外层 while 循环**里:

```cpp
// chaitin.cpp:515-534(截取核心,逐字)
  // Select colors by re-inserting LRGs back into the IFG in reverse order.
  // Return whether or not something spills.
  uint spills = Select( );

  // If we spill, split and recycle the entire thing
  while( spills ) {
    if( _trip_cnt++ > 24 ) {
      DEBUG_ONLY( dump_for_spill_split_recycle(); )
      if( _trip_cnt > 27 ) {
        C->record_method_not_compilable("failed spill-split-recycle sanity check");
        return;
      }
    }

    if (!_lrg_map.max_lrg_id()) {
      return;
    }
    uint new_max_lrg_id = Split(_lrg_map.max_lrg_id(), &split_arena);  // Split spilling LRG everywhere
```

大纲说"split 后重新 Simplify"只对了一半——真实是 **spill-split-recycle 全循环**: 每轮 Select 有 spill → `Split` 把 spill 的 LRG 拆短(按 def/use 拆分,`split_DEF` reg_split.cpp:148 / `split_USE` :190,每个分裂点插 spill 拷贝;另有 `split_Rematerialize` :318——**能重算的值不 spill 到栈,直接重物化**)→ `compact`(:542)重编号 → **重建 liveness 与 IFG**(:546-558)→ conservative coalesce(:566)→ 再 Simplify/Select。循环终止靠的不是"数学证明"而是**工程上限**: `_trip_cnt` 超过 24 警告、27 报错放弃编译(:523-529,"failed spill-split-recycle sanity check")+ 每轮 `check_node_count` 节点预算(:537)。每次分裂后 LRG 更短、干涉更少,下一轮更容易着色——这正是"拆 live range 比永久 spill 更优"的设计: 短区间在热路径外可以重新进寄存器。

**实证**([素材](planning/outlines/00-jvm-tools/materials/commands/15-c2-register-alloc-demo.txt)第 1 段): 高寄存器压力方法(32 个局部变量交叉运算)的 CITime 阶段树完整列出 RA 全流程——`Regalloc: 0.001s` 下依次是 `Ctor Chaitin`/`Build IFG (virt)`/`Build IFG (phys)`/`Compute Liveness`/`Regalloc Split`/`Postalloc Copy Rem`/`Fixup Spills`/`Coalesce 1-3`/`Simplify`/`Select`(01 篇素材第 6 段的 Regalloc 段同构,可对照)。`VerifyRegisterAllocator` 是 notproduct(c2_globals.hpp:285)、`OptoCoalesce` 是 develop(:244)——release 下 RA 内部既不能验证也不能调参,阶段计时是唯一直接观察;寄存器分配的正确性只能通过运行结果(heavy 方法算得对)与阶段存在性来间接确认。

*关键设计: 整个 RA 是"约简-重建"的迭代——Simplify 押注低度可着色,Select 兑现颜色,spill 不落地为永久栈槽而是**拆短后重来**;每轮重建 liveness/IFG 的成本高(O(n) 扫描),但换来的是下一轮更小的干涉图。工程终止(24/27 次上限)替代了理论证明——这是 C2 里少见的"靠预算而不是靠证明"的算法。*

## 核心悬念

寄存器分配收官: **IFG**(逆向块扫描建干涉图,LRG 带 cost/area/score 与 copy_bias)→ **Simplify**(低度入栈、score 选 spill 候选)→ **Coalesce**(aggressive/conservative 两档消拷贝)→ **Select**(逆序选色,chunk 滚动处理栈槽)→ **Split**(拆短 + 重物化 + spill-split-recycle 全循环,24/27 次工程上限)。每个 LRG 拿到了寄存器或栈槽,但图还没变成机器码——**Matcher** 把理想节点按 .ad 文件的规则匹配成 x86 指令(向量节点在这里变成 movdqu/paddd),**调度器**排出指令顺序,**发码器**输出字节。下一篇: 指令选择与代码生成。

> → [15-c2-compiler/06 — Matcher + Code Generation: DFA 指令选择 → x86 机码](openjdk/vol-02/15-c2-compiler/06-c2-codegen.md)
