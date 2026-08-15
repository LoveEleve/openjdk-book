# 05. Chaitin — 图着色寄存器分配 O(n²)

> 🔴 Deep | IFG + Coalesce + Simplify + Select + Spill/Split
> 读者处境: IGVN+Optimizations 后的 C2 graph 有 50-200 个理想寄存器(LRG)。物理 x86-64 只有 16 个 GPR(rax-r15) + 16 个 XMM(xmm0-xmm15)。50→32 映射——哪些存活寄存器？哪些 spill 到栈？Chaitin-Briggs 图着色 O(n²) vs C1 Linear Scan O(n)——精确代价的体现。

### 1. "IFG — Interference Graph (干涉图)"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/05 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"为每个 Node 分配 LRG;计算 LRG live range [first_use, last_use)" 简化错(重要)**: 真实=**对每个基本块单次逆向扫描**(ifg.cpp:317-319 注释 "single reverse pass over each basic block"): 从 live-out 集倒走,定义值移出 live 集前与一切存活值干涉(interfere_with_live :291),输入加入 live 集;**Copy 指令不产生干涉**(:350-352 "Copies do not define a new value and so do not interfere")
> - **"_hint_color" 编造(重要)**: 不存在;真实=**_copy_bias**(chaitin.hpp:67 "Index of LRG which we want to share color")+**bias_color**(:689 "Helper function which implements biasing heuristic");另有 _risk_bias(:66 想避免的颜色);bias 目标是 copy 两端同色减少 spill code
> - **"build_ifg_virtual (ifg.cpp:311-820)/build_ifg_physical (:821-900)"** ✓(:311/:821);**ifg.cpp 929 行** ✓;**Register_Allocate (chaitin.cpp:336)** ✓
> - **build_ifg_physical 真职责**: 物理寄存器约束+**寄存器压力计算**(Pressure int/float,INTPRESSURE x86_64=13 c2_globals_x86.hpp:51,非 16——含保留寄存器),超压返回 must_spill 计数;大纲"caller-saved 不可跨 call"的机制在 liveness/RegMask(call def 杀 caller-saved),不在 build_ifg_physical
> - **Register_Allocate 编排**: de_ssa(:373 虚拟 copy)/gather_lrg_masks+live.compute(:386-387)/stretch_base_pointer_live_ranges(:397)/build_ifg_virtual(:409)/aggressive coalesce(:425-426)+insert_copies(:429)/build_ifg_physical(:450)/must_spill 预分裂(:462)


场景: `a=Load[i]; b=Add(a,c); d=Mul(b,e); return d`——4 个虚拟寄存器(LRG)。IFG 分析: a 和 b 同时存在(load→add)→edge。b 和 d 同时存在(add→mul)→edge。a 和 d 不重叠→无 edge。3 edges。

**build_ifg + LRG** (`ifg.cpp:311-820`):
```
PhaseChaitin::build_ifg_virtual():
  → 遍历所有 MachNode——为每个 Node 分配 LRG(Live Range Group)
  → 计算 LRG 的 live range: [first_use, last_use)
  → 两个 LRG 活性重叠 → IFG edge(干涉)
  → build_ifg_physical() (ifg.cpp:821-900):
      把 MachProj(物理寄存器约束)加入 IFG——caller-saved regs 不可跨 call 存活
[C++: ifg.cpp:929行——IFG adjacency matrix 用 bitset 存储——每个 LRG 的干涉邻居集]
[x86: 16 GPR(General Purpose)+16 XMM(Floating Point/SIMD)+8 x87(FP stack, 老式)]
```
- 源码: `ifg.cpp:311-400` (build_ifg_virtual) + `ifg.cpp:821-870` (build_ifg_physical) + `chaitin.cpp:336-400` (Register_Allocate 入口)

- 关键设计: **LRG 合并**——copy instruction(mov rax,rdi)的 src 和 dst——如果无 IFG edge→可以合并为一个 LRG(coalesce)→消除 copy。**Bias Coloring**: 每个 LRG 有 `_hint_color`——上次使用的寄存器编号——选择同一寄存器减少 spill code。

### 2. "Simplify + Coalesce — 图缩减"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/05 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **行号漂移(重要)**: **Simplify 在 chaitin.cpp:1199**(大纲"chaitin.cpp:200-330"错);**Select 在 :1447**(大纲"400-600"错);**Split 在 reg_split.cpp:496**(大纲"chaitin.cpp:600-800"错);**coalesce_driver 在 coalesce.cpp:128**(大纲"50-200"错),coalesce 本体 :447(aggressive)/:798(conservative)
> - **"spill_cost 最低的 LRG" 半对**: 真实=**score()=raw_score(_cost,_area) 最小**(chaitin.cpp:99/:103-113 注释 "Bigger area lowers score, encourages spilling...Bigger cost raise score, prevents spilling";Simplify :1266-1274 "Time to pick a potential spill guy",:1292 "Smaller cost/area wins")——**cost/area 比值**不是裸 cost
> - **_cost/_area 引用对**(chaitin.hpp:56-57: "2 for loads/1 for stores times block freq"/"Sum of all simultaneously live values")✓
> - **"Briggs Optimistic Coloring/Chaitin 原版无限循环" 无据**: 源码无 Briggs 命名;乐观性真实存在(Simplify 把高 score 候选先入栈,Select 才定夺),但"Chaitin 原版"对比无出处——删;终止保证=工程上限(_trip_cnt 24/27,chaitin.cpp:523-529)+check_node_count
> - **coalesce 两档**: aggressive(SSA 虚拟 copy,chaitin.cpp:425-426)+conservative(spill 后,spill 分裂后度数仍低才合,:492/:566);OptoCoalesce 是 develop(c2_globals.hpp:244)release 不可调


场景: LRG 度数为 3(<16 个物理寄存器)——总能着色→push stack。度数>16→选 spill cost 最低的 LRG→标记 spill→从 IFG 移除→继续。

**Simplify + Coalesce** (`coalesce.cpp + chaitin.cpp`):
```
PhaseChaitin::Simplify():
  while IFG 非空:
    找 Degree < N(物理寄存器数) 的 LRG:
      push stack(总能着色)
      从 IFG 移除此 LRG + 所有 edges
    如果无 Degree<N:
      选择 spill_cost 最低的 LRG
      mark_for_spill → push stack(以后可能不用 spill)
      从 IFG 移除 → 继续

PhaseChaitin::coalesce() (coalesce.cpp:50-200):
  遍历所有 copy nodes(mov reg,reg):
    if src 和 dst 无 IFG edge → merge 为一个 LRG → 消除 copy
    else → mark bias → select 时选同一颜色
```
- 源码: `coalesce.cpp:50-200` (coalesce 主循环) + `chaitin.cpp:200-330` (Simplify)

- 关键设计: **_cost = 2 for loads / 1 for stores × block_freq**(`chaitin.hpp:56`)**——hot blocks(high profiling frequency)的 spill cost 自然更高→spill 决策最小化 hot path 影响。**_area** 是 LRG 跨越的指令范围——大面积 LRG spill 后释放更多寄存器供其他 LRG 使用(降低总分 spill)。`score = raw_score(_cost, _area)` 综合两者决定 spill 优先级。**Briggs 改进**: Chaitin 原版 spill 后立即重着色→可能无限循环。Briggs 版: Optimistic Coloring——先假设全部可着色→Spill 只在真需要时。

### 3. "Select + Split — 着色与 Spill"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/05 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"split 后重新 Simplify" 只说半截(重要)**: 真实=**spill-split-recycle 全循环**(chaitin.cpp:522-570): Select 返回 spills→while(spills): Split(reg_split.cpp:496)→compact(:542)→**重建 liveness+IFG**(:546-558)→conservative coalesce(:566)→再 Simplify/Select;每轮 _trip_cnt 上限 24/27(:523-529 "failed spill-split-recycle sanity check")——终止靠工程预算非证明
> - **"split 插入 spill code(store→stack/reload)" 半对**: split_DEF(:148)/split_USE(:190)按 def/use 拆分插 spill 拷贝;**split_Rematerialize(:318)能重算的值不 spill 直接重物化**
> - **Select 细节**: re_insert 回 IFG(:1469)/邻居颜色 SUBTRACT(:1503)/choose_color(:1529);**栈槽 chunk 机制**(RegMask::CHUNK_SIZE,:1538-1541 "Bump register mask up to next stack chunk"——AllStack LRG 无颜色时滚动到下一块)
> - **补充**: 低度必可着色引理(Simplify :1206-1261 入栈+摘除+邻居度连锁下降);_must_spill 在 build_ifg_physical 返回(:450)并预分裂(:462),Simplify 里 _must_spill LRG 已在低度列表(:1249)
> - **实证**: CITime Regalloc 阶段树(RADemo.heavy 32 局部变量: Ctor Chaitin/Build IFG(virt+phys)/Compute Liveness/Regalloc Split/Postalloc Copy Rem/Fixup Spills/Coalesce 1-3/Simplify/Select,素材第 1 段;01 篇素材第 6 段同构);VerifyRegisterAllocator notproduct(c2_globals.hpp:285)/OptoCoalesce develop(:244)


场景: Stack 从底 pop→assign 任意空闲颜色。如果无空闲→LRG 被 spill→`PhaseChaitin::split(spilled_lrg)`→拆为小间隔→插入 spill code(store→stack)和 reload code(load←stack)。

**Select + Split** (`chaitin.cpp:400-600`):
```
PhaseChaitin::Select():
  while stack 非空:
    lrg = stack.pop()
    color = 从 {0..N-1} 选一个未与 lrg 干涉的颜色
    if color 可用: lrg._reg = color
    else: mark_for_spill(lrg) → PhaseChaitin::split(lrg)

PhaseChaitin::split(lrg) (chaitin.cpp:600-800):
  将 spilled LRG 拆为多个小范围(per-use):
    每个 use 前插入 reload(spill_slot→temp reg)
    每个 def 后插入 spill(temp reg→stack slot)
  → 循环回到 Simplify 重新着色(现在干涉更少)
```
- 源码: `chaitin.cpp:336-600` (Register_Allocate→Simplify→Select→Split 全流程) + `chaitin.cpp:600-800` (split + spill code insertion)

- 关键设计: **Split 的哲学**——不是真的"spill到永久的栈位置"——是拆 live range 变短——短 LRG 有更少的干涉→更容易着色。Split 后重新走 Simplify→Select——循环直到全部着色或确定无法着色。**Proof**: Chaitin-Briggs 一定终止——每轮 spill 至少一个 LRG→干涉图缩小→最终 Degree 降到 < N。

---

### 核心悬念

**"Chaitin O(n²): IFG(干涉图)→Simplify(度数小于N入栈)→Coalesce(消除copy)→Select(pop栈→assign颜色)→Split(spill后拆开→重新Simplify)。比C1 LinearScan O(n)精确得多——loop内spill cost 10x惩罚→hot paths优先寄存器。"** — 下一篇: Matcher——ADL(Architecture Description Language)→DFA→x86 指令选择。

> → [06-c2-codegen.md](06-c2-codegen.md)
