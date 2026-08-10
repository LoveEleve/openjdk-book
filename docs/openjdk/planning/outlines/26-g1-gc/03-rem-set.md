# 03. Region A 里谁引用了 Region B？— RSet + CardTable 并发细化

> 🔴 Deep | 5 KP 中的跨 Region 引用追踪
> 读者处境: G1 收集 Region Y(Young)——需要知道 Old Region X 中哪些 field 指向 Region Y 的对象。如果 scan 所有 Old Regions→太慢。RSet 给每个 Region 存 "谁引用了我的对象"→只 scan 那些 Old Regions。

### 1. "RSet — 每 Region 的引用反查表"

场景: G1 的 Evacuation Pause 选择了 100 个 Young Regions——需要找到哪些 Old Regions 引用了它们。RSet 在 Young Region 的 `_rem_set` 字段中存了这个信息——"Old Region #345 的 card #23 有 ref 到我"。

**RSet 三级 coarsening** (`g1RemSet.hpp:40-120 + heapRegionRemSet.hpp:40-150`):
```
Sparse (稀疏): per-card entry(直接存 card index)——<128 entries
Fine (精细): per-region bitmap(bit per card)——≥128 entries
Coarse (粗): "这个 Region 整体 dirty"——不再追踪具体 cards
```
- 源码: `heapRegionRemSet.hpp:40-150` SparsePRT/FinePRT/CoarsePRT
- 关键设计: 自适应升级——card entries 超过 Sparse 阈值→升级为 Fine(bitmap, O(1) per card insert)。Fine 满了→升级为 Coarse(这个 Region 总是 dirty)。Coarse 在 GC 时开销最大(must scan whole Region)但只在极端 case 触发
- 关键设计: 为什么不是 always Fine(bitmap per region)？Young Region 的 incoming refs 少(<5)——Sparse 比 Fine 省内存(~10x)。大多数 Region 永远不需要 Fine
- [C++: SparsePRT 用 hash table(SparsePRTEntry) 存储 card indices。阈值=`G1RSetSparseRegionEntries`(默认4)。Fine=PerRegionTable 用 `BitMap`(bit per card, ~256 cards/Young Region→32 bytes)。Coarse 不分配额外内存——仅在 `PerRegionTable` 中设置 coarse tag]

**G1RemSet scan** (`g1RemSet.cpp:100-300`):
```
scan RS for Collection Set Regions:
  1. iterate dirty cards in RS→find old regions→scan their cards
  2. G1ParScanThreadState::do_oop_work→evacuate(forward oop to to-region)
  3. if card was dirty but object is dead→skip
```
- 源码: `g1RemSet.cpp:100-300` + `g1RemSetSummary.cpp:statistics`

### 2. "并发细化——Mutator 写 card→Concurrent Refinement 处理"

场景: Mutator 线程写入 obj.field→post-write barrier 标记 card dirty→加入 dirty card queue。Concurrent refinement thread 在后台 batch 处理 dirty card→更新 RS。不用 concurrent refinement→dirty card 累积 GC 时爆炸→pause time 飙升。

**并发细化** (`g1ConcurrentRefine.hpp:40-100`):
```
G1ConcurrentRefineThread:
  while(true) {
    get_completed_dirty_card_buffer()
    → refine_card(card_ptr, worker_id)
      → 扫描该 card 的 objects→检查 field→更新 target region 的 RSet
  }
```
- 源码: `g1ConcurrentRefineThread.cpp:40-150`
- 关键设计: activation thresholds——黄色区(heap occupancy 45-60%): 1 thread→绿色区(>60%): 2+ threads。基于 `G1ConcRefinementGreenZone/YellowZone/RedZone`。采样 refinement rate→动态调整
- [C++: refinement thread 用 `os::set_native_priority(near max)`——优先级高于 mutator threads。这是必要的——如果 refinement 落后 mutator→dirty card queue 暴涨→GC 时 O(N²) scan]

---

### 核心悬念

**"RSet 每 Region 存储 incoming refs——三级 coarsening(Sparse→Fine→Coarse)自适应升级。Concurrent Refinement 后台批处理 card→更新 RS。"** — 下一篇: 分配与晋升。

> → [04-allocation.md](04-allocation.md)
