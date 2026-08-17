# 05. 什么时候做 Young？什么时候做 Mixed？— 策略与集合选择

> **前置依赖**:[26-g1-gc/02 — 应用还在跑——你怎么知道谁活着？— 并发标记 + SATB](02-concurrent-marking.md):remark 后 `_next_marked_bytes` 就位,本篇的 Mixed GC 靠它选 Old Region;[26-g1-gc/04 — new Object() 在 G1 里走到哪？— 分配与晋升](04-allocation.md):分配路径与 humongous 触发 Concurrent Start;[26-g1-gc/03 — Region A 里谁引用了 Region B？— RSet + CardTable 并发细化](03-rem-set.md):CSet 扫描依赖 RSet
> → **后续**:[26-g1-gc/06 — G1BarrierSet + Pre/Post Write Barrier](06-g1-barrier.md)
> 关联域: 26-02(标记)、26-03(RSet)、26-04(分配)、25-gc-framework(GC 框架)

G1 的暂停不是"每次全堆"。它有三种形态: **Young-only**(只收年轻代)、**Mixed**(年轻代 + 选中的老年代 Region)、**Full**(全堆压缩)。本篇回答两个问题:

1. 什么时候该启动并发标记(IHOP);
2. Mixed GC 时哪些 Old Region 值得进 CSet,以及怎么保证暂停不超时。

核心是 `G1Policy` 这个策略层:它用 IHOP 控制标记时机,用 `G1Predictions` 预测暂停时间,用 `CollectionSetChooser` 按 GC 效率选 Old Region。

---

## 1. IHOP — 什么时候开始并发标记

### 为什么不能等老年代满了才标记

并发标记需要时间。如果等老年代快满才启动,标记还没跑完,分配就把堆塞爆,只能 Full GC。所以 G1 要**提前**在老年代占用达到某个阈值时启动标记,让标记在堆真正耗尽前完成。

这个阈值就是 IHOP(Initiating Heap Occupancy Percent)。

### 静态 IHOP:固定百分比

`G1StaticIHOPControl`(g1IHOPControl.hpp:85-103):

```cpp
// g1IHOPControl.hpp:85-103(截取核心,逐字)
class G1StaticIHOPControl : public G1IHOPControl {
  // Most recent mutator time between the end of initial mark to the start of the
  // first mixed gc.
  double _last_marking_length_s;
 protected:
  double last_marking_length_s() const { return _last_marking_length_s; }
 public:
  G1StaticIHOPControl(double ihop_percent, G1OldGenAllocationTracker const* old_gen_alloc_tracker);

  size_t get_conc_mark_start_threshold() {
    guarantee(_target_occupancy > 0, "Target occupancy must have been initialized.");
    return (size_t) (_initial_ihop_percent * _target_occupancy / 100.0);
  }
```

静态 IHOP 就是 `_initial_ihop_percent * _target_occupancy / 100`。`InitiatingHeapOccupancyPercent` 默认 **45**(gc_globals.hpp:223),即老年代占用到目标容量的 45% 时启动标记。

### 自适应 IHOP:学习分配速率和标记时长

但固定 45% 不够聪明:如果分配快、标记慢,45% 可能太晚;如果分配慢,45% 又太早。`G1AdaptiveIHOPControl` 用历史数据预测。

`G1AdaptiveIHOPControl` 的成员(g1IHOPControl.hpp:109-125):

```cpp
// g1IHOPControl.hpp:109-125(截取核心,逐字)
class G1AdaptiveIHOPControl : public G1IHOPControl {
  size_t _heap_reserve_percent; // Percentage of maximum heap capacity we should avoid to touch
  size_t _heap_waste_percent;   // Percentage of free heap that should be considered as waste.

  const G1Predictions * _predictor;

  TruncatedSeq _marking_times_s;
  TruncatedSeq _allocation_rate_s;

  // The most recent unrestrained size of the young gen. This is used as an additional
  // factor in the calculation of the threshold, as the threshold is based on
  // non-young gen occupancy at the end of GC. For the IHOP threshold, we need to
  // consider the young gen size during that time too.
  size_t _last_unrestrained_young_size;
```

它维护两个 `TruncatedSeq`(截断序列,只保留最近样本):

- `_marking_times_s`:每次标记时长;
- `_allocation_rate_s`:老年代分配速率。

`G1UseAdaptiveIHOP` 默认 **true**(g1_globals.hpp:48),所以默认走自适应路径。`create_ihop_control`(g1Policy.cpp:739-750)根据这个 flag 决定创建 `G1AdaptiveIHOPControl` 还是 `G1StaticIHOPControl`。

大纲里"IHOP 默认 45%、范围 25-45%"的"25-45%"是编造的。真实情况是: `InitiatingHeapOccupancyPercent` 默认 45,且 `G1UseAdaptiveIHOP` 默认 true,自适应算法会在这个初始值基础上动态调整。

---

## 2. G1Predictions — 暂停时间预测模型

### 预测 = 均值 + sigma × 标准差

`G1Predictions`(g1Predictions.hpp:31-60):

```cpp
// g1Predictions.hpp:31-60(截取核心,逐字)
class G1Predictions {
 private:
  double _sigma;

  double stddev_estimate(TruncatedSeq const* seq) const {
    double estimate = seq->dsd();
    int const samples = seq->num();
    if (samples < 5) {
      estimate = MAX2(seq->davg() * (5 - samples) / 2.0, estimate);
    }
    return estimate;
  }
 public:
  G1Predictions(double sigma) : _sigma(sigma) {
    assert(sigma >= 0.0, "Confidence must be larger than or equal to zero");
  }

  double get_new_prediction(TruncatedSeq const* seq) const {
    return seq->davg() + _sigma * stddev_estimate(seq);
  }
};
```

预测公式是 `davg + sigma * stddev_estimate`:

- `davg`:样本均值;
- `stddev_estimate`:样本标准差,样本 < 5 时用均值缩放(避免小样本标准差失真);
- `_sigma`:置信系数。

大纲说"exponential weighted moving average variant"不准确。`TruncatedSeq` 是**截断序列**(只保留最近 N 个样本),不是指数加权移动平均。预测是"均值 + sigma×标准差",给暂停时间留安全余量。

---

## 3. Mixed GC 的触发 — 不是每次 GC 都 Mixed

### `next_gc_should_be_mixed`:候选老年代 + 可回收比例

`G1Policy::next_gc_should_be_mixed`(g1Policy.cpp:1084-1103):

```cpp
// g1Policy.cpp:1084-1103(截取核心,逐字)
bool G1Policy::next_gc_should_be_mixed(const char* true_action_str,
                                       const char* false_action_str) const {
  if (cset_chooser()->is_empty()) {
    log_debug(gc, ergo)("%s (candidate old regions not available)", false_action_str);
    return false;
  }

  // Is the amount of uncollected reclaimable space above G1HeapWastePercent?
  size_t reclaimable_bytes = cset_chooser()->remaining_reclaimable_bytes();
  double reclaimable_percent = reclaimable_bytes_percent(reclaimable_bytes);
  double threshold = (double) G1HeapWastePercent;
  if (reclaimable_percent <= threshold) {
    log_debug(gc, ergo)("%s (reclaimable percentage not over threshold). candidate old regions: %u reclaimable: " SIZE_FORMAT " (%1.2f) threshold: " UINTX_FORMAT,
                        false_action_str, cset_chooser()->remaining_regions(), reclaimable_bytes, reclaimable_percent, G1HeapWastePercent);
    return false;
  }
  log_debug(gc, ergo)("%s (candidate old regions available). candidate old regions: %u reclaimable: " SIZE_FORMAT " (%1.2f) threshold: " UINTX_FORMAT,
                      true_action_str, cset_chooser()->remaining_regions(), reclaimable_bytes, reclaimable_percent, G1HeapWastePercent);
  return true;
}
```

Mixed GC 不是"标记完就连续做"。它有两个门槛:

1. `cset_chooser()` 非空(还有候选 Old Region);
2. 剩余可回收字节占堆的比例 > `G1HeapWastePercent`(默认 **5**,g1_globals.hpp:241)。

如果可回收比例太低,继续 Mixed 不划算,就回到 Young-only。这就是"Mixed 阶段会自然结束"的机制。

### 候选 Region 从哪来

Cleanup 阶段结束时,`G1Policy::record_concurrent_mark_cleanup_end()`(g1Policy.cpp:987-993)先调 `cset_chooser()->rebuild()`(g1Policy.cpp:988)填充候选,再用 `next_gc_should_be_mixed` 决定是否进入 mixed 序列;若否,`clear_collection_set_candidates()`(g1Policy.cpp:992)清空候选。`G1MixedGCLiveThresholdPercent`(默认 **85**)决定阈值:`mixed_gc_live_threshold_bytes = GrainBytes * 85 / 100`,存活字节低于它的 Region 才进候选(collectionSetChooser.hpp:104-105, collectionSetChooser.cpp:280)。

---

## 4. CSet 选择 — 先 Young,再按 GC 效率选 Old

### `finalize_collection_set` 分两步

`G1Policy::finalize_collection_set`(g1Policy.cpp:1143-1146):

```cpp
// g1Policy.cpp:1143-1146(截取核心,逐字)
void G1Policy::finalize_collection_set(double target_pause_time_ms, G1SurvivorRegions* survivor) {
  double time_remaining_ms = _collection_set->finalize_young_part(target_pause_time_ms, survivor);
  _collection_set->finalize_old_part(time_remaining_ms);
}
```

CSet 选择分两步:

1. `finalize_young_part`:先加所有 Young Region(必须收),算出剩余时间预算;
2. `finalize_old_part`:用剩余时间预算选 Old Region。

### `finalize_young_part`:先扣 base time,再加 Young

`G1CollectionSet::finalize_young_part`(g1CollectionSet.cpp:356-398):

```cpp
// g1CollectionSet.cpp:356-398(截取核心,逐字)
double G1CollectionSet::finalize_young_part(double target_pause_time_ms, G1SurvivorRegions* survivors) {
  double young_start_time_sec = os::elapsedTime();

  finalize_incremental_building();

  guarantee(target_pause_time_ms > 0.0,
            "target_pause_time_ms = %1.6lf should be positive", target_pause_time_ms);

  size_t pending_cards = _policy->pending_cards();
  double base_time_ms = _policy->predict_base_elapsed_time_ms(pending_cards);
  double time_remaining_ms = MAX2(target_pause_time_ms - base_time_ms, 0.0);
...
  uint survivor_region_length = survivors->length();
  uint eden_region_length = _g1h->eden_regions_count();
  init_region_lengths(eden_region_length, survivor_region_length);
...
  _bytes_used_before = _inc_bytes_used_before;
  time_remaining_ms = MAX2(time_remaining_ms - _inc_predicted_elapsed_time_ms, 0.0);
...
  return time_remaining_ms;
}
```

关键逻辑:

- 先预测 base time(处理 pending cards 等固定开销);
- `time_remaining = target - base`;
- 加所有 Young Region(eden + survivor),扣掉它们的预测时间;
- 返回剩余时间给 old part。

### `finalize_old_part`:在剩余预算内选 Old Region

`G1CollectionSet::finalize_old_part`(g1CollectionSet.cpp:410-419):

```cpp
// g1CollectionSet.cpp:410-419(截取核心,逐字)
void G1CollectionSet::finalize_old_part(double time_remaining_ms) {
  double non_young_start_time_sec = os::elapsedTime();
  double predicted_old_time_ms = 0.0;

  if (collector_state()->in_mixed_phase()) {
    cset_chooser()->verify();
    const uint min_old_cset_length = _policy->calc_min_old_cset_length();
    const uint max_old_cset_length = _policy->calc_max_old_cset_length();

    uint expensive_region_num = 0;
```

只有 `in_mixed_phase()` 时才选 Old Region。它用 `min_old_cset_length` 和 `max_old_cset_length` 约束数量。

### min/max 约束

`calc_min_old_cset_length` 和 `calc_max_old_cset_length`(g1Policy.cpp:1105-1141):

```cpp
// g1Policy.cpp:1105-1141(截取核心,逐字)
uint G1Policy::calc_min_old_cset_length() const {
  // The min old CSet region bound is based on the maximum desired
  // number of mixed GCs after a cycle. I.e., even if some old regions
  // look expensive, we should add them to the CSet anyway to make
  // sure we go through the available old regions in no more than the
  // maximum desired number of mixed GCs.
  const size_t region_num = (size_t) cset_chooser()->length();
  const size_t gc_num = (size_t) MAX2(G1MixedGCCountTarget, (uintx) 1);
  size_t result = region_num / gc_num;
  // emulate ceiling
  if (result * gc_num < region_num) {
    result += 1;
  }
  return (uint) result;
}

uint G1Policy::calc_max_old_cset_length() const {
  // The max old CSet region bound is based on the threshold expressed
  // as a percentage of the heap size.
  const G1CollectedHeap* g1h = G1CollectedHeap::heap();
  const size_t region_num = g1h->num_regions();
  const size_t perc = (size_t) G1OldCSetRegionThresholdPercent;
  size_t result = region_num * perc / 100;
  // emulate ceiling
  if (100 * result < region_num * perc) {
    result += 1;
  }
  return (uint) result;
}
```

- **min**:候选 Region 数 / `G1MixedGCCountTarget`(默认 **8**),保证最多 8 次 Mixed GC 收完所有候选;
- **max**:堆 Region 数 × `G1OldCSetRegionThresholdPercent`(默认 **10**),限制单次 Mixed 收的老年代比例。

### 排序:按 GC 效率,不是按 liveness 单独排

`CollectionSetChooser::order_regions`(collectionSetChooser.cpp:41-61):

```cpp
// collectionSetChooser.cpp:41-61(截取核心,逐字)
static int order_regions(HeapRegion* hr1, HeapRegion* hr2) {
  if (hr1 == NULL) {
    if (hr2 == NULL) {
      return 0;
    } else {
      return 1;
    }
  } else if (hr2 == NULL) {
    return -1;
  }

  double gc_eff1 = hr1->gc_efficiency();
  double gc_eff2 = hr2->gc_efficiency();
  if (gc_eff1 > gc_eff2) {
    return -1;
  } if (gc_eff1 < gc_eff2) {
    return 1;
  } else {
    return 0;
  }
}
```

候选 Old Region 按 `gc_efficiency()` 排序。`gc_efficiency` 是"可回收字节 / 预测回收时间"的比值——**同时考虑 liveness 和 RSet 成本**,不是大纲说的"liveness×cost"那么简单。注释(collectionSetChooser.cpp:32-40)说明:这样排序会让"存活多 + RSet 大"的 Region 排在后面,如果 Mixed 阶段提前结束,被跳过的正是这些不划算的 Region。

---

## 核心悬念

**G1 的策略层用三件事决定"现在做什么":** IHOP 控制并发标记时机(默认 45%,`G1UseAdaptiveIHOP` 默认 true 时自适应学习分配速率和标记时长);`G1Predictions` 用"均值 + sigma×标准差"预测暂停时间;Mixed GC 只在候选老年代可回收比例超过 `G1HeapWastePercent`(5%)时触发,并按 `gc_efficiency` 排序、受 min/max 约束选 Old Region。**下一篇看 G1 的写屏障:** 前面反复提到的 pre/post barrier 到底在字节码层面做了什么,为什么 G1 的写屏障是"最重"的。

> → [06-g1-barrier.md](06-g1-barrier.md)
