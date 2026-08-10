# 05. Chaitin — 图着色寄存器分配 O(n²)

> 🔴 Deep | C2 的 O(n²) vs C1 的 O(n) — 精确代价

场景: C2 graph 有 50+ 个理想 (virtual) 寄存器——只有 16 个物理 GPR + 16 个 XMM——50→32 映射——哪些存寄存器？哪些 spill 到栈？Chaitin-Briggs 图着色找到最优。

### 1. IFG — Interference Graph

**IFG** (`ifg.cpp`):
- Node→LRG (Live Range Group)——两个 LRG 在同一 time point 活性重叠→IFG edge
- IFG 的 edge 数量——O(N²)——N 个 LRG——最坏 N² edges——sparse (大部分 LRG 不重叠)
- [C++: `PhaseChaitin::build_ifg_physical()`——遍历所有基本块——计算每个 LRG 的 `[start, end)` 范围——两个范围重叠→IFG edge。内存: IFG adjacency matrix]

### 2. Simplify + Coalesce

**Coalesce** (`coalesce.cpp`): 查找 copy instructions (mov reg,reg)——如果 src 和 dst 无 IFG edge→coalesce——两个 LRG merge→消除 copy。Bias: PhaseChaitin——`select_bias_color`——选择 hint color (上次使用的寄存器)——减少 move 插入。

**Simplify**: 从 IFG 移除 Degree < N (物理寄存器数) 的 LRG→push stack——因为总能着色。Degree > N→选择 spill cost 最低的 LRG→spill (存栈)→继续。

### 3. Select + Spill

**Select** (`chaitin.cpp`): pop stack→assign 任意空闲颜色。如果无空闲→mark for spill→`PhaseChaitin::split(spilled_lrg)`——split into small intervals——`PhaseSplit`。

---

### 核心悬念

**"Chaitin O(n²)——精确但慢——适合 C2 分钟级编译。"** — C1 LinearScan O(n) 牺牲精度换速度。下一篇: Matcher——ADL→x86。

> → [06-c2-codegen.md](06-c2-codegen.md)
