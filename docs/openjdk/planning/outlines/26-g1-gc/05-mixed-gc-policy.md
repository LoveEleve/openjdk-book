# 05. 什么时候做 Young？什么时候做 Mixed？— 策略与集合选择

> 🔴 Deep | 5 KP 中的 GC 调度
> 读者处境: G1 有 3 种 GC: Young-only(仅收集 young)、Mixed(收集 young + selected old)、Full(全堆 compact)。怎么决定 "现在做什么？" 策略层用 IHOP 控制并发标记时机 + G1Predictions 预测 pause time + Collection Set 按 liveness×cost 选 Old Regions。

### 1. "IHOP——什么时候开始并发标记？"

场景: Old gen 慢慢增长——不能等到 80%才标记(标记速度赶不上分配速度)。IHOP 在 Old gen 到达 ~45%时触发并发标记——给标记足够时间完成。

**IHOP (Initiating Heap Occupancy Percent)** (`g1IHOPControl.hpp:40-100 + g1Policy.cpp:200-400`):
```
_ihop_percent = 45% (默认 static) 或 adaptive:
G1AdaptiveIHOPControl:
  → 学习 allocation rate(Young→Old promotion rate per GC)
  → 学习 concurrent marking speed(bytes marked per ms)
  → 预测: "若现在开始标记，会在 occupancy > mixed GC capacity 前完成吗？"
  → 如果否→降低 IHOP(更早标记)
```
- 源码: `g1IHOPControl.hpp:38-153` + `g1Policy.cpp:739-750`(create_ihop_control)
- 关键设计: 自适应 IHOP 是反馈控制——输入: allocation rate + marking time。输出: 理想 IHOP value。conservative:IHOP 过低→标记频繁→ overhead。aggressive:IHOP 过高→标记跟不上→Full GC more likely
- ⚠️ 漂移修正: ①`InitiatingHeapOccupancyPercent` 默认 **45**(gc_globals.hpp:223),"范围 25-45%"编造;②`G1UseAdaptiveIHOP` 默认 **true**(g1_globals.hpp:48),默认走 `G1AdaptiveIHOPControl`(学习 `_allocation_rate_s` + `_marking_times_s` 两个 TruncatedSeq,g1IHOPControl.hpp:109-153),大纲"marking speed(bytes/ms)"不准,实际是 marking time;③`G1StaticIHOPControl::get_conc_mark_start_threshold` = `_initial_ihop_percent * _target_occupancy / 100`(g1IHOPControl.hpp:94-97)

### 2. "集合选择——哪些 Old Region 值得收集？"

场景: Concurrent marking 完成→现在知道每个 Old Region 的 liveness(存活对象百分比)。Mixed GC 需选择: "哪些 Old Region 收集？"——选 liveness 低的(回收空间多)、evacuation cost 低的(子对象引用少)。

**G1Policy 集合选择** (`g1Policy.cpp:400-700 + g1CollectionSet.cpp:80-200`):
```
选择 Collection Set(CSet):
  1. 所有 Young Regions(必须收集——Young GC unavoidable)
  2. 选择 Old Regions:
     a) sort by (liveness_bytes / region_size) * per_region_evacuation_cost
     b) 累加 select 直到 predicted_pause ≤ MaxGCPauseMillis(默认 200ms)
     c) 剩余 Old Regions 留给下一轮 Mixed GC
  3. 如果 no candidates worth collecting(liveness all high)→stop Mixed GC
```
- 源码: `g1Policy.cpp:1084-1146` + `g1CollectionSet.cpp:356-549`
- 关键设计: CSet Pinning——如果某个 Old Region 有 GCLocker active(thread in JNI critical)→pin 住不收集→等下一轮。Concurrent refinement 保证 dirty card data 准确——RS liveness 信息是 stale-safe(over-estimate存活 = don't collect safe, underestimate存活 = risk)
- ⚠️ 漂移修正: ①候选容器是 **CollectionSetChooser**(cset_chooser(),g1CollectionSet.cpp:45-47),不是 `G1CollectionSetCandidates`;②排序按 **gc_efficiency = reclaimable_bytes / predict_region_elapsed_time_ms**(heapRegion.cpp:142-153),不是"liveness×cost";③`next_gc_should_be_mixed` 要求 cset_chooser 非空 **且** reclaimable% > `G1HeapWastePercent`(默认 5)(g1Policy.cpp:1084-1103);④`finalize_collection_set` 先 `finalize_young_part` 扣 base+young 时间,再 `finalize_old_part` 用剩余预算选 old(g1CollectionSet.cpp:356-419);⑤min/max old cset 长度由 `calc_min_old_cset_length`(候选/G1MixedGCCountTarget 默认 8)与 `calc_max_old_cset_length`(堆×G1OldCSetRegionThresholdPercent 默认 10)约束

### 3. "pause time prediction 模型"

**G1Predictions** (`g1Predictions.hpp:30-60 + g1Policy.cpp:600-800`):
```
record pausing times:
  per-region evacuation cost = f(#objects, #cards, #refs to scan)
  predicted_pause = avg_cost_region × num_regions + safety_margin(std*2)
  → ensure predicted ≤ MaxGCPauseMillis(默认 200ms)
```
- 源码: `g1Predictions.hpp:31-60`
- 关键设计: 预测公式 `get_new_prediction = davg + sigma * stddev_estimate`(g1Predictions.hpp:57-59);`stddev_estimate` 样本<5 时用 `davg*(5-samples)/2` 兜底(:41-48)。如果历史 pause time consistently over target→G1 reduces number of regions in CSet
- ⚠️ 漂移修正: 不是 "exponential weighted moving average variant",`TruncatedSeq` 是**截断序列**(只保留最近 N 样本),不是指数加权;预测 = 均值 + sigma×标准差(给暂停留安全余量)

---

### 核心悬念

**"IHOP 自适应学习 alloch rate+mark speed→优化标记触发时机。CSet 按 liveness×cost 选择 Old Regions——Predicted pause≤MaxGCPauseMillis。"** — 下一篇: G1BarrierSet。

> → [06-g1-barrier.md](06-g1-barrier.md)
