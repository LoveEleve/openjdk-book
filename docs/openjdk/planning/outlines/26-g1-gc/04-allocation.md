# 04. new Object() 在 G1 里走到哪？— 分配与晋升

> 🔴 Deep | 5 KP 中的分配路径
> 读者处境: 普通对象(≤50%Region size)→Eden bump allocation → GC→survivor copy → promote to Old。巨型对象(>50% Region)→直接分配在 Humongous Region——跳过 survivor。

### 1. "三层分配器" — G1Allocator + PLAB + TLAB

场景: `new Object()` 在 Java code→TLAB fast path(>95% hit rate)→TLAB 满了→allocate new TLAB from G1Allocator→TLAB 用 Eden Region 填充→Eden Region 满了→触发 Young GC。

**G1Allocator 三层** (`g1Allocator.hpp:40-120 + g1AllocRegion.hpp:40-80`):
```
Mutator 分配:
  TLAB(Thread Local Allocation Buffer) — fast, bump pointer, ~10 cycles
  → full → G1AllocRegion(retire old, allocate new Eden Region) — CAS required
GC Promotion:
  G1PLAB(Promotion Local Allocation Buffer) — per GC thread, ~10 cycles
  → full → G1AllocRegion for Survivor/Old — shared CAS
```
- 源码: `g1Allocator.hpp:40-120` + `g1AllocRegion.hpp:40-80`
- 关键设计: Mutator 分离 Old allocation region——有的对象直接晋升 Old(GC 期间判定条件不好)->直接分配到 Old Region→不经 Survivor。避免 "Survivorfull→immediate promotion→Old Region" 的双跳开销
- [C++: TLAB::allocate 在 compiled code 中 inline——`check(top+size<=end); add top,size; return old_top`——3 条 x86 指令。若失败→`mov rax,thread; call G1CollectedHeap::allocate_new_tlab`——slow path 但不常见]

### 2. "Humongous——大于半个 Region"

场景: `byte[3MB]` → Region size=2MB→Humongous。分配在两个连续 Region 中——Starts+Continues。Evacuation 时不 move Humongous(避免 ~3MB copy 开销)。

**Humongous allocation** (`g1CollectedHeap.cpp:300-500 + g1Allocator.cpp:200-400`):
```
humongous_obj_allocate(size):
  if (size > 50% * G1HeapRegionSize):
    → find N contiguous free Regions(N = ceil(size/G1HeapRegionSize))
    → allocate StartsHumongous in first, ContinuesHumongous in remaining
    → G1CollectedHeap::humongous_allocate(bypasses G1Allocator)
```
- 源码: `g1CollectedHeap.cpp:300-500` humongous allocate
- 关键设计: Humongous 从不被 evacuation——GC worker 不 copy 它们(overhead 太大)。Humongous 在 Full GC 时才 compaction。Fragment 风险——如果 region fragmentation 高→Humongous allocation fail→Full GC triggered
- [C++: 找 N 个连续 free Regions 用 `G1HeapRegionManager::allocate_free_regions_starting_at`——扫描 region table→找到满足的起点→把 region 标记为 HumongousStarts+HumongousContinues]

### 3. "GC 中的分配——PLAB"

场景: GC 期间——Survivor 和 Old Regions 需要分配 space 给 evacuated objects。每 GC worker 有自己的 PLAB——避免全局锁。

**G1PLAB** (`g1Allocator.cpp:400-600`):
```
PLAB allocate:
  1. worker owns private PLAB → bump pointer allocate → fast (1 instruction)
  2. PLAB full → retire → request new PLAB from G1Allocator's Survivor/Old Region
  3. new PLAB: CAS allocate from shared region top pointer
```
- 源码: `g1Allocator.cpp:400-600` + `plab.cpp:40-80` base PLAB logic
- 关键设计: PLAB 和 TLAB 共用同一个 bump pointer 逻辑——PLAB 在 GC 的 Evacuation Pause 期间使用。Survivor PLAB 和 Old PLAB 分别有自己大小(waste target = PLABWasteTargetPercent, 避免 overfill)

---

### 核心悬念

**"G1Allocator 三层: TLAB(bump,fast)→AllocRegion(CAS)→PLAB(GC promotion)。Humongous(>50% Region) 直接分在连续 Starts+Continues Regions——永不 evacuation。"** — 下一篇: Mixed GC + 策略。

> → [05-mixed-gc-policy.md](05-mixed-gc-policy.md)
