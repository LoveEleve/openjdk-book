# 05. Chaitin — 图着色寄存器分配 O(n²)

> 🔴 Deep | IFG + Coalesce + Simplify + Select + Spill/Split
> 读者处境: IGVN+Optimizations 后的 C2 graph 有 50-200 个理想寄存器(LRG)。物理 x86-64 只有 16 个 GPR(rax-r15) + 16 个 XMM(xmm0-xmm15)。50→32 映射——哪些存活寄存器？哪些 spill 到栈？Chaitin-Briggs 图着色 O(n²) vs C1 Linear Scan O(n)——精确代价的体现。

### 1. "IFG — Interference Graph (干涉图)"

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
