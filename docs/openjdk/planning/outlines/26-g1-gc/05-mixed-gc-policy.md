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
- 源码: `g1IHOPControl.hpp:40-100` + `g1Policy.cpp:200-400`
- 关键设计: 自适应 IHOP 是反馈控制——输入: allocation rate + marking speed。输出: 理想 IHOP value(25-45%)。conservative:IHOP 过低→标记频繁→ overhead。aggressive:IHOP 过高→标记跟不上→Full GC more likely
- [C++: `G1AdaptiveIHOPControl::update_allocation_info`——record allocation bytes since last GC + young gen occupancy → compute promotion rate = (Newly promoted bytes)/(Young GC count)。Marking speed = (bytes scanned during concurrent mark)/(mark time)]

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
- 源码: `g1Policy.cpp:400-700` + `g1CollectionSet.cpp:80-200`
- 关键设计: CSet Pinning——如果某个 Old Region 有 GCLocker active(thread in JNI critical)→pin 住不收集→等下一轮。Concurrent refinement 保证 dirty card data 准确——RS liveness 信息是 stale-safe(over-estimate存活 = don't collect safe, underestimate存活 = risk)
- [C++: `G1CollectionSet::finalize_old_part` ——用 `G1CollectionSetCandidates` 存储 candidate old regions。Collect 顺序: 先 young(always), 再 old(sort by liveness)。Predict pause time = `G1Predictions::predict(pause_time_ms)` 用 historical avg+std]

### 3. "pause time prediction 模型"

**G1Predictions** (`g1Predictions.hpp:30-60 + g1Policy.cpp:600-800`):
```
record pausing times:
  per-region evacuation cost = f(#objects, #cards, #refs to scan)
  predicted_pause = avg_cost_region × num_regions + safety_margin(std*2)
  → ensure predicted ≤ MaxGCPauseMillis(默认 200ms)
```
- 源码: `g1Predictions.hpp:30-60` + `g1Policy.cpp:600-800`
- 关键设计: predictions 是 exponential weighted moving average variant——最近测量权重更高。如果历史 pause time consistently over target→G1 reduces number of regions in CSet

---

### 核心悬念

**"IHOP 自适应学习 alloch rate+mark speed→优化标记触发时机。CSet 按 liveness×cost 选择 Old Regions——Predicted pause≤MaxGCPauseMillis。"** — 下一篇: G1BarrierSet。

> → [06-g1-barrier.md](06-g1-barrier.md)
