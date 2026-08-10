> **Phase**：[01-jvm-startup]
> **前置**：[02-G1-Heap-Startup]（G1 堆内存布局 + 6 Mapper + Card Table + SATB 队列）
> **配套**：[09-G1-Concurrent-Marking-Infra]（G1ConcurrentMark 构造函数 + 并发精炼 + 线程创建）
> **后续依赖本文**：所有 GC 运行时 Phase 依赖本文创建的 Policy 决策引擎
> **阅读收益**：深度理解 G1Policy 8 个子组件的创建链——G1Predictions 线性回归 → G1Analytics 17 个 TruncatedSeq 衰减平均预测 → G1MMUTrackerQueue 64 元素环形队列暂停追踪 → G1IHOPControl 自适应/静态阈值 → SurvRateGroup×2 存活率预测 → G1GCPhaseTimes 28 Phase 并行计时 → GCPolicyCounters PerfData 暴露 → G1MonitoringSupport 3+2+5 JMX 计数器 + initialize_serviceability 3 个 MemoryPool。量化总内存开销 ~43KB。

---

# 08-G1-Policy-Analytics — G1 决策引擎与监控基础设施

## §〇 Production Scenario — IHOP 阈值与 GC 暂停预测

```bash
$ java -Xms8g -Xmx8g -XX:+UseG1GC \
    -XX:MaxGCPauseMillis=200 \
    -XX:G1ConfidencePercent=50 \
    -XX:InitiatingHeapOccupancyPercent=45 \
    MyApp
```

GC 日志中出现 `[GC pause (G1 Evacuation Pause) (young), 0.0234567 secs]` —— 23ms 的 young GC 暂停。JVM 如何决定该暂停是否"合规"？如何预测下次 GC 需要多少时间？如何判断"该开始并发标记了"（IHOP 阈值）？

这三个问题的答案在 `G1Policy` 及其 8 个子组件中：`G1Analytics` 用 17 个 TruncatedSeq 历史序列预测暂停时间的每个组成部分；`G1MMUTrackerQueue` 用 64 元素环形队列追踪 GC 暂停是否超出 `MaxGCPauseMillis` 目标；`G1IHOPControl`（自适应模式）动态调整堆占用阈值；`SurvRateGroup×2` 预测对象存活率以确定 Survivor/Eden 大小；`G1MonitoringSupport` 把这些信息暴露为 JMX MBean。

**反事实**：如果 G1 没有预测模型（G1Analytics）→ 每次 GC 暂停时间完全不可预测 → 无法判断当前暂停是否合规 → 无法动态调整 young gen 大小 → 要么暂停超标（用户体验差），要么过于保守导致堆利用率低。17 个 TruncatedSeq 用最近 10 次 GC 数据做加权平均预测，每个 Seq 对应暂停时间的一个独立成本因子。

**三步诊断**：

```bash
# 1. 查看 GC 暂停预测 vs 实际
jcmd <pid> VM.flags | grep -E "MaxGCPauseMillis|G1ConfidencePercent|InitiatingHeapOccupancyPercent"
jstat -gcutil <pid> 1000
# GCT (GC Time) 列显示 GC 时间百分比

# 2. 查看 IHOP 阈值变化
grep -E "concurrent-mark-start|IHOP" gc.log
# 期望看到: concurrent-mark-start threshold = X.XB, IHOP = YY%

# 3. GDB 查看 Policy 内部状态
gdb -ex "break G1Policy::record_collection_pause_end" \
    -ex "run" \
    -ex "print _mmu_tracker" \
    -ex "print _analytics->_recent_gc_times_ms.last()" \
    -ex "print _ihop_control->get_conc_mark_start_threshold()" \
    --args java -Xms8g -Xmx8g -XX:+UseG1GC -jar app.jar
# 期望: recent_gc_times_ms 包含最近的暂停时间序列
```

**额外诊断工具**：

```bash
# strace — 追踪 PerfData mmap 共享内存
strace -e trace=mmap -f java -version 2>&1 | grep "shared"
# 期望看到: mmap(NULL, ... MAP_SHARED ...)  — PerfData 内存区域

# jstack — 查看所有 GC 线程
jstack <pid> | grep -E "GC.*Thread|G1.*Conc"
# 期望看到: "GC Thread#0" ~ "GC Thread#12" (ParallelGCThreads 个)

# /proc/<pid>/maps — 查看 PerfData mmap 区域
grep "hsperfdata" /proc/<pid>/maps
# 期望看到: hsperfdata 共享内存区域（G1MonitoringSupport 的计数器在此）
```

---

## §一 G1 Policy 层初始化全链路

### 1.1 G1Policy 构造函数 — 8 个子组件创建链

`G1CollectedHeap` 构造函数（`g1CollectedHeap.cpp:1508`）在初始化列表中执行 `_g1_policy(new G1Policy(_gc_timer_stw))`——这触发了 G1 最复杂的对象创建链。

`G1Policy` 构造函数（`g1Policy.cpp:50-72`）初始化列表按声明顺序创建 8 个子组件：

```cpp
// g1Policy.cpp:50-72
G1Policy::G1Policy(STWGCTimer* gc_timer) :
  _predictor(G1ConfidencePercent / 100.0),                          // :51 — 值对象
  _analytics(new G1Analytics(&_predictor)),                         // :52
  _remset_tracker(),                                                // :53 — 值对象
  _mmu_tracker(new G1MMUTrackerQueue(GCPauseIntervalMillis / 1000.0,
                                      MaxGCPauseMillis / 1000.0)),  // :54
  _old_gen_alloc_tracker(),                                         // :55 — 值对象
  _ihop_control(create_ihop_control(&_old_gen_alloc_tracker,
                                    &_predictor)),                  // :56
  _policy_counters(new GCPolicyCounters("GarbageFirst", 1, 2)),     // :57
  _young_list_fixed_length(0),                                      // :58
  _short_lived_surv_rate_group(new SurvRateGroup()),                // :59
  _survivor_surv_rate_group(new SurvRateGroup()),                   // :60
  _reserve_factor((double) G1ReservePercent / 100.0),               // :61
  _reserve_regions(0),                                              // :62
  _rs_lengths_prediction(0),                                        // :63
  _collection_set(NULL),                                            // :65
  _g1h(NULL),                                                       // :66
  _phase_times(new G1GCPhaseTimes(gc_timer, ParallelGCThreads)),    // :67
  _tenuring_threshold(MaxTenuringThreshold),                        // :68
  _max_survivor_regions(0),                                         // :69
  _survivors_age_table(true),                                       // :70
  _collection_pause_end_millis(os::javaTimeNanos() / NANOSECS_PER_MILLISEC) { // :72
}
```

**两阶段初始化**：`_g1h` 和 `_collection_set` 在构造时设为 NULL，真正的绑定在 `init()` 中完成（`g1Policy.cpp:80-97`）：

```cpp
void G1Policy::init(G1CollectedHeap* g1h, G1CollectionSet* collection_set) {
  _g1h = g1h;
  _collection_set = collection_set;
  // ... INST_LOG_GC 插桩代码
}
```

> **为什么需要两阶段初始化？** Policy 对象在 G1CollectedHeap 构造的初始化列表中创建（`:1508`），此时 Heap 对象自身尚未完全构造——`_hrm`、`_card_table` 等成员还是 NULL。`init()` 在 `G1CollectedHeap::initialize()` 的 Step 16（`:2286`）调用，此时 Heap 已完全初始化。

析构函数（`g1Policy.cpp:74-76`）的清理顺序：

```cpp
G1Policy::~G1Policy() {
  delete _ihop_control;   // 多态析构
  delete _mmu_tracker;    // 多态析构
  delete _analytics;      // 释放 17 个 TruncatedSeq
}
```

**初始化列表创建的对象汇总**：

| # | 对象 | 类型 | 分配方式 | 大小估算 |
|---|------|------|---------|---------|
| 1 | `_predictor` | `G1Predictions` | 值对象（栈上） | ~16B |
| 2 | `_analytics` | `G1Analytics*` | new（堆） | ~1.2KB |
| 3 | `_remset_tracker` | `G1RemSetTrackingPolicy` | 值对象 | ~24B |
| 4 | `_mmu_tracker` | `G1MMUTrackerQueue*` | new（堆） | ~1.1KB |
| 5 | `_old_gen_alloc_tracker` | `G1OldGenAllocationTracker` | 值对象 | ~40B |
| 6 | `_ihop_control` | `G1IHOPControl*` | new（堆） | ~120B (Adaptive) |
| 7 | `_policy_counters` | `GCPolicyCounters*` | new（堆） | ~324B |
| 8 | `_short_lived_surv_rate_group` | `SurvRateGroup*` | new（堆） | ~68B + 动态 |
| 9 | `_survivor_surv_rate_group` | `SurvRateGroup*` | new（堆） | ~68B + 动态 |
| 10 | `_phase_times` | `G1GCPhaseTimes*` | new（堆） | ~2.7KB |

> **💡 G1Predictions 值对象**：`_predictor(G1ConfidencePercent / 100.0)` 直接在 Policy 对象体内分配。`G1ConfidencePercent=50` → 置信度 = 0.5。这不是"50% 准确率"——是预测区间的覆盖概率。`get_new_prediction(seq)` 返回 `davg() + confidence × sd()`——即均值 + 0.5 个标准差，偏向乐观的预测。

### 1.2 G1Analytics — 17 个 TruncatedSeq 的预测模型

`G1Analytics` 构造函数（`g1Analytics.cpp:73-117`）创建 19 个 TruncatedSeq（其中 17 个独立序列 + 2 个用于暂停记录）：

```cpp
// g1Analytics.cpp:73-117
G1Analytics::G1Analytics(const G1Predictions* predictor) :
    _predictor(predictor),
    _recent_gc_times_ms(new TruncatedSeq(NumPrevPausesForHeuristics)),          // 10
    _concurrent_mark_remark_times_ms(new TruncatedSeq(NumPrevPausesForHeuristics)), // 10
    _concurrent_mark_cleanup_times_ms(new TruncatedSeq(NumPrevPausesForHeuristics)), // 10
    _alloc_rate_ms_seq(new TruncatedSeq(TruncatedSeqLength)),                   // 10
    _prev_collection_pause_end_ms(0.0),
    _rs_length_diff_seq(new TruncatedSeq(TruncatedSeqLength)),                  // 10
    _cost_per_card_ms_seq(new TruncatedSeq(TruncatedSeqLength)),                // 10
    _cost_scan_hcc_seq(new TruncatedSeq(TruncatedSeqLength)),                   // 10
    _young_cards_per_entry_ratio_seq(new TruncatedSeq(TruncatedSeqLength)),     // 10
    _mixed_cards_per_entry_ratio_seq(new TruncatedSeq(TruncatedSeqLength)),     // 10
    _cost_per_entry_ms_seq(new TruncatedSeq(TruncatedSeqLength)),               // 10
    _mixed_cost_per_entry_ms_seq(new TruncatedSeq(TruncatedSeqLength)),         // 10
    _cost_per_byte_ms_seq(new TruncatedSeq(TruncatedSeqLength)),                // 10
    _cost_per_byte_ms_during_cm_seq(new TruncatedSeq(TruncatedSeqLength)),      // 10
    _constant_other_time_ms_seq(new TruncatedSeq(TruncatedSeqLength)),          // 10
    _young_other_cost_per_region_ms_seq(new TruncatedSeq(TruncatedSeqLength)),  // 10
    _non_young_other_cost_per_region_ms_seq(new TruncatedSeq(TruncatedSeqLength)), // 10
    _pending_cards_seq(new TruncatedSeq(TruncatedSeqLength)),                   // 10
    _rs_lengths_seq(new TruncatedSeq(TruncatedSeqLength)),                      // 10
    _recent_prev_end_times_for_all_gcs_sec(new TruncatedSeq(NumPrevPausesForHeuristics)) { // 10

  // 种子值注入
  _recent_prev_end_times_for_all_gcs_sec->add(os::elapsedTime());
  _prev_collection_pause_end_ms = os::elapsedTime() * 1000.0;

  int index = MIN2(ParallelGCThreads - 1, 7u);
  _rs_length_diff_seq->add(rs_length_diff_defaults[index]);
  _cost_per_card_ms_seq->add(cost_per_card_ms_defaults[index]);
  _cost_scan_hcc_seq->add(0.0);
  _young_cards_per_entry_ratio_seq->add(young_cards_per_entry_ratio_defaults[index]);
  _cost_per_entry_ms_seq->add(cost_per_entry_ms_defaults[index]);
  _cost_per_byte_ms_seq->add(cost_per_byte_ms_defaults[index]);
  _constant_other_time_ms_seq->add(constant_other_time_ms_defaults[index]);
  _young_other_cost_per_region_ms_seq->add(young_other_cost_per_region_ms_defaults[index]);
  _non_young_other_cost_per_region_ms_seq->add(non_young_other_cost_per_region_ms_defaults[index]);

  // 保守启动 — remark 和 cleanup 初始值偏高估计
  _concurrent_mark_remark_times_ms->add(0.05);
  _concurrent_mark_cleanup_times_ms->add(0.20);
}
```

**两种序列长度**：

| 常量 | 值 | 用途 |
|------|-----|------|
| `TruncatedSeqLength` | 10 | 常规统计序列 |
| `NumPrevPausesForHeuristics` | 10 | GC 暂停相关序列 |

虽然当前两者都是 10，但语义上分开允许独立调优。`_recent_gc_times_ms` 用 `NumPrevPausesForHeuristics` 因为它直接影响 young gen sizing——需要与暂停预测关联。

**8 种预设种子配置**：

`index = MIN2(ParallelGCThreads - 1, 7)`——线程数 1-8+ 分别对应不同预设成本因子。例如 `cost_per_card_ms_defaults[0]` 为单线程的卡片扫描成本，`cost_per_card_ms_defaults[7]` 为 8+ 线程的成本。这是基于经验的：更多线程 → 并行扫描 → 每卡成本降低，但原子操作竞争增加。

**20 个 predict_* API**（`g1Analytics.hpp:114-158`）：

```cpp
double predict_alloc_rate_ms() const;
double predict_cost_per_card_ms() const;
double predict_scan_hcc_ms() const;
double predict_rs_update_time_ms(size_t pending_cards) const;  // = pending_cards × cost_per_card + scan_hcc
double predict_young_cards_per_entry_ratio() const;
double predict_mixed_cards_per_entry_ratio() const;
size_t predict_card_num(size_t rs_length, bool for_young_gc) const;
double predict_rs_scan_time_ms(size_t card_num, bool for_young_gc) const;
double predict_object_copy_time_ms(size_t bytes_to_copy, bool during_concurrent_mark) const;
double predict_constant_other_time_ms() const;
double predict_young_other_time_ms(size_t young_num) const;       // = young_num × cost_per_region
double predict_non_young_other_time_ms(size_t non_young_num) const;
double predict_remark_time_ms() const;
double predict_cleanup_time_ms() const;
```

`predict_rs_update_time_ms(pending_cards)` 是线性组合：`pending_cards × predict_cost_per_card_ms() + predict_scan_hcc_ms()`。这是 G1 暂停预测的核心——RS 更新是 young GC 暂停的最大组成部分。

**TruncatedSeq 衰减平均算法**（`AbsSeq.cpp`）：

```
davg() = old_value × alpha + new_observation × (1 - alpha)
alpha = DefaultDavgAlpha = 0.7
```

> **💡 TruncatedSeq 预测原理**：每个 TruncatedSeq 存储最近 10 次观测值。预测时用指数衰减加权平均——最近一次权重 30%（`1-alpha=0.3`），越旧权重越小（×0.7 每步衰减）。这与简单移动平均（SMA）不同——SMA 对异常值同等权重，一次 Full GC 的异常长时间会持续影响 SMA 10 个周期，预测严重偏大。`G1Analytics` 有 17 个这样的序列，每个对应 GC 暂停时间的一个成本因子。

**反事实**：如果不用 TruncatedSeq 而用简单移动平均（SMA）→ SMA 对异常值同等权重 → 一次 Full GC 的异常长时间会持续影响 SMA 10 个周期 → 预测严重偏大 → young gen 缩得过小 → 频繁 GC。TruncatedSeq 的指数衰减给旧数据更低权重，异常值影响快速衰减。

### 1.3 G1IHOPControl — 静态 vs 自适应 IHOP

IHOP 控制是一个三层类层次（`g1IHOPControl.hpp:38-153`）：

```cpp
// 基类 (g1IHOPControl.hpp:38-81)
class G1IHOPControl : public CHeapObj<mtGC> {
protected:
  double _initial_ihop_percent;
  size_t _target_occupancy;
  double _last_allocation_time_s;
  const G1OldGenAllocationTracker* _old_gen_alloc_tracker;
public:
  virtual size_t get_conc_mark_start_threshold() = 0;
  virtual void update_allocation_info(double allocation_time_s, size_t additional_buffer_size);
  virtual void update_marking_length(double marking_length_s) = 0;
};

// 静态实现 (g1IHOPControl.hpp:85-103)
class G1StaticIHOPControl : public G1IHOPControl {
  double _last_marking_length_s;
  size_t get_conc_mark_start_threshold() {
    return (size_t)(_initial_ihop_percent * _target_occupancy / 100.0);
  }
};

// 自适应实现 (g1IHOPControl.hpp:109-153)
class G1AdaptiveIHOPControl : public G1IHOPControl {
  size_t _heap_reserve_percent;    // G1ReservePercent=10
  size_t _heap_waste_percent;      // G1HeapWastePercent=5
  const G1Predictions* _predictor;
  TruncatedSeq _marking_times_s;      // 值对象，10 entries, alpha=0.95
  TruncatedSeq _allocation_rate_s;    // 值对象，10 entries, alpha=0.95
  size_t _last_unrestrained_young_size;
};
```

**工厂方法**（`g1Policy.cpp:849-860`）：

```cpp
G1IHOPControl* G1Policy::create_ihop_control(
    const G1OldGenAllocationTracker* old_gen_alloc_tracker,
    const G1Predictions* predictor) {
  if (G1UseAdaptiveIHOP) {
    return new G1AdaptiveIHOPControl(InitiatingHeapOccupancyPercent,
                                     old_gen_alloc_tracker, predictor,
                                     G1ReservePercent, G1HeapWastePercent);
  } else {
    return new G1StaticIHOPControl(InitiatingHeapOccupancyPercent,
                                   old_gen_alloc_tracker);
  }
}
```

**自适应模式的核心计算公式**（`G1AdaptiveIHOPControl::get_conc_mark_start_threshold()`）：

```
threshold = target_occupancy - (allocation_rate × predicted_marking_time + heap_waste + reserve)
```

其中：
- `allocation_rate` = `_predictor->get_new_prediction(&_allocation_rate_s)`——预测的老年代分配速率
- `predicted_marking_time` = `_predictor->get_new_prediction(&_marking_times_s)`——预测的并发标记耗时
- `heap_waste` = `_heap_waste_percent × target_occupancy / 100`——容忍的碎片空间
- `reserve` = `_heap_reserve_percent × target_occupancy / 100`——安全余量

**自适应 TruncatedSeq 的 alpha=0.95**：比 G1Analytics 的 0.7 更平滑——因为 allocation rate 和 marking time 变化更缓慢，需要更长历史窗口避免过度反应。

> **💡 IHOP 自适应 vs 静态**：`G1UseAdaptiveIHOP=true`（默认）时，`G1AdaptiveIHOPControl` 根据历史标记耗时和分配速率动态计算 threshold。`false` 时 `G1StaticIHOPControl` 固定返回 `IHOP% × target_occupancy`。自适应模式需要 2 个额外的 TruncatedSeq（各 10×8B + 对象头 ≈ 120B each）。

**反事实**：如果只用静态 IHOP（`-XX:G1UseAdaptiveIHOP=false`）→ 阈值固定 → 如果 allocation rate 突然飙升（如批量数据导入），标记可能来不及在堆满前完成 → 触发 evacuation failure 或 Full GC。自适应模式根据实际 allocation rate 和 marking time 动态调低阈值。

### 1.4 G1MMUTrackerQueue — 64 元素环形队列的暂停追踪

`G1MMUTrackerQueue` 用 64 元素环形队列追踪 GC 暂停是否超出 `MaxGCPauseMillis` 目标（`g1MMUTracker.hpp:107-143`，`g1MMUTracker.cpp:42-142`）。

**数据结构**：

```cpp
// g1MMUTracker.hpp:84-103
class G1MMUTrackerQueueElem {
private:
  double _start_time;  // GC 暂停开始时间（秒）
  double _end_time;    // GC 暂停结束时间（秒）
public:
  double duration() { return _end_time - _start_time; }
};

// g1MMUTracker.hpp:107-143
class G1MMUTrackerQueue : public G1MMUTracker {
  enum PrivateConstants { QueueLength = 64 };
  G1MMUTrackerQueueElem _array[QueueLength];  // 64 × 16B = 1KB
  int _head_index;
  int _tail_index;
  int _no_entries;
};
```

**构造函数**（`g1MMUTracker.cpp:42-48`）：

```cpp
G1MMUTrackerQueue::G1MMUTrackerQueue(double time_slice, double max_gc_time) :
  G1MMUTracker(time_slice, max_gc_time),  // time_slice = GCPauseIntervalMillis/1000
  _head_index(0),
  _tail_index(trim_index(_head_index+1)),  // tail 领先 head 1 位
  _no_entries(0) { }
```

**`add_pause(start, end)` 入队逻辑**（`g1MMUTracker.cpp:56-79`）：

```cpp
void G1MMUTrackerQueue::add_pause(double start, double end) {
  remove_expired_entries(end);           // 先清理过期条目
  if (_no_entries == QueueLength) {
    // 队列满：覆盖最旧条目（头尾同时前移）
    _head_index = trim_index(_head_index + 1);
    _tail_index = trim_index(_tail_index + 1);
  } else {
    _head_index = trim_index(_head_index + 1);
    ++_no_entries;
  }
  _array[_head_index] = G1MMUTrackerQueueElem(start, end);
}
```

**`calculate_gc_time(current_time)` 累加窗口内总 GC 时间**（`g1MMUTracker.cpp:67-83`）：

```cpp
double G1MMUTrackerQueue::calculate_gc_time(double current_time) {
  double gc_time = 0.0;
  double limit = current_time - _time_slice;   // 时间窗口左边界
  for (int i = 0; i < _no_entries; ++i) {
    int index = trim_index(_tail_index + i);
    G1MMUTrackerQueueElem *elem = &_array[index];
    if (elem->end_time() > limit) {
      if (elem->start_time() > limit)
        gc_time += elem->duration();           // 完全在窗口内
      else
        gc_time += elem->end_time() - limit;   // 部分在窗口内（裁剪）
    }
  }
  return gc_time;
}
```

**`when_sec(current_time, pause_time)` 核心算法**（`g1MMUTracker.cpp:100-142`）：

```cpp
double G1MMUTrackerQueue::when_sec(double current_time, double pause_time) {
  double adjusted_pause_time =
    (pause_time > max_gc_time()) ? max_gc_time() : pause_time;
  double earliest_end = current_time + adjusted_pause_time;
  double limit = earliest_end - _time_slice;
  double gc_time = calculate_gc_time(earliest_end);
  double diff = gc_time + adjusted_pause_time - max_gc_time();
  if (is_double_leq_0(diff)) return 0.0;  // 可以立即开始

  // 遍历队列，找到 diff 被消耗完的时间点
  int index = _tail_index;
  while (1) {
    G1MMUTrackerQueueElem *elem = &_array[index];
    if (elem->end_time() > limit) {
      if (elem->start_time() > limit)
        diff -= elem->duration();
      else
        diff -= elem->end_time() - limit;
      if (is_double_leq_0(diff))
        return elem->end_time() + diff + _time_slice - adjusted_pause_time - current_time;
    }
    index = trim_index(index+1);
  }
}
```

> **💡 MMU (Minimum Mutator Utilization)**：`MaxGCPauseMillis` 不是单次暂停限制，是 MMU 约束——在 `GCPauseIntervalMillis=500` 时间窗口内，所有 GC 暂停的总时间不能超过 `MaxGCPauseMillis=200`。`when_sec()` 计算"还需要等多久才能在不违反 MMU 的情况下执行一次 pause_time 的 GC"。返回 0.0 表示可以立即开始。

**反事实**：如果没有 MMU 追踪 → GC 可能连续发生 → mutator 得不到 CPU 时间 → 吞吐量骤降。`when_sec()` 强制 GC 间插入最小 mutator 时间，保证 mutator 利用率 ≥ (1 - 200/500) = 60%（默认）。

### 1.5 SurvRateGroup — 对象存活率预测

`SurvRateGroup` 追踪每个 age（在 CSet 中的年龄位置）的对象存活率（`survRateGroup.hpp:32-89`，`survRateGroup.cpp:34-135`）。

**数据结构**：

```cpp
// survRateGroup.hpp:32-89
class SurvRateGroup : public CHeapObj<mtGC> {
  size_t  _stats_arrays_length;       // 数组当前容量
  double* _accum_surv_rate_pred;      // 累积存活率预测数组
  double  _last_pred;                 // 最后一个 age 的预测值
  TruncatedSeq** _surv_rate_pred;     // 每个 age 一个 TruncatedSeq 指针数组

  size_t _region_num;                 // 本次 GC 的 region 数
  int _all_regions_allocated;
  size_t _setup_seq_num;
};
```

**初始化种子值**（`survRateGroup.cpp:42-55`）：

```cpp
void SurvRateGroup::reset() {
  _all_regions_allocated = 0;
  _setup_seq_num = 0;
  _last_pred = 0.0;
  _region_num = 1;

  for (size_t i = 0; i < _stats_arrays_length; ++i)
    delete _surv_rate_pred[i];
  _stats_arrays_length = 0;

  stop_adding_regions();  // 分配 length=1 的数组

  const double initial_surv_rate = 0.4;  // 种子：40% 存活率
  _surv_rate_pred[0]->add(initial_surv_rate);
  _last_pred = _accum_surv_rate_pred[0] = initial_surv_rate;

  _region_num = 0;
}
```

**动态扩容**（`survRateGroup.cpp:57-70`）：

```cpp
void SurvRateGroup::stop_adding_regions() {
  if (_region_num > _stats_arrays_length) {
    _accum_surv_rate_pred = REALLOC_C_HEAP_ARRAY(double, _accum_surv_rate_pred, _region_num, mtGC);
    _surv_rate_pred = REALLOC_C_HEAP_ARRAY(TruncatedSeq*, _surv_rate_pred, _region_num, mtGC);
    for (size_t i = _stats_arrays_length; i < _region_num; ++i) {
      _surv_rate_pred[i] = new TruncatedSeq(10);  // 每个 age 一个 10-entry 序列
    }
    _stats_arrays_length = _region_num;
  }
}
```

**存活率记录**（`survRateGroup.cpp:72-103`）：

```cpp
void SurvRateGroup::record_surviving_words(int age_in_group, size_t surv_words) {
  double surv_rate = (double)surv_words / (double)HeapRegion::GrainWords;
  _surv_rate_pred[age_in_group]->add(surv_rate);
}
```

**累积存活率预测**（`survRateGroup.cpp:105-135`）：

```cpp
void SurvRateGroup::finalize_predictions(const G1Predictions& predictor) {
  double accum = 0.0;
  double pred = 0.0;
  for (size_t i = 0; i < _stats_arrays_length; ++i) {
    pred = predictor.get_new_prediction(_surv_rate_pred[i]);
    if (pred > 1.0) pred = 1.0;         // cap at 100%
    accum += pred;
    _accum_surv_rate_pred[i] = accum;   // 累积存活率 = sum(pred[0..i])
  }
  _last_pred = pred;
}
```

**超出数组范围的外推**（`survRateGroup.hpp:76-83`）：

```cpp
double accum_surv_rate_pred(int age) const {
  if ((size_t)age < _stats_arrays_length)
    return _accum_surv_rate_pred[age];
  else {
    double diff = (double)(age - _stats_arrays_length + 1);
    return _accum_surv_rate_pred[_stats_arrays_length-1] + diff * _last_pred;
  }
}
```

**物理含义**：`accum_surv_rate_pred(age)` 表示"经过 age+1 次 GC 后对象仍然存活的累计概率"。这用于计算 tenuring threshold——当累积存活率超过 Survivor 容量时，晋升对象到 Old。

**反事实**：如果没有存活率预测 → 无法动态调整 Survivor 大小 → 要么 Survivor 太小（对象过早晋升到 Old → 增加 Mixed GC 频率），要么 Survivor 太大（浪费年轻代空间 → Eden 太小 → 频繁 Young GC）。存活率预测是 G1 自适应 tenuring threshold 的基础。

### 1.6 G1GCPhaseTimes — 28 Phase × N Worker 的阶段计时

`G1GCPhaseTimes` 记录每个 GC 并行阶段的各线程耗时（`g1GCPhaseTimes.hpp:39-368`）。

**GCParPhases 枚举**（`:45-79`）——按执行顺序：

```cpp
enum GCParPhases {
  GCWorkerStart,           // 0
  ExtRootScan,             // 1  — 外部根扫描（JNI handles, etc.）
  ThreadRoots,             // 2
  UniverseRoots,           // 3
  JNIRoots,                // 4
  ObjectSynchronizerRoots, // 5
  ManagementRoots,         // 6
  SystemDictionaryRoots,   // 7
  CLDGRoots,               // 8
  JVMTIRoots,              // 9
  AOTCodeRoots,            // 10 — 条件编译 INCLUDE_AOT
  CMRefRoots,              // 11
  UpdateRS,                // 12 — ★ 关键：RSet 更新
  ScanRS,                  // 13 — ★ 关键：RSet 扫描
  CodeRoots,               // 14
  ObjCopy,                 // 15 — ★ 关键：对象复制
  Termination,             // 16 — 终止检测
  GCWorkerEnd,             // 17
  StringDedupQueueFixup,   // 18
  StringDedupTableFixup,   // 19
  RedirtyCards,            // 20
  RedirtiedCards,          // 21
  FreeCollectionSet,       // 22
  YoungFreeCollectionSet,  // 23
  NonYoungFreeCollectionSet, // 24
  RebuildFreeList,         // 25
  MergePSS,                // 26
  GCParPhasesSentinel      // 27 — 数组长度标记
};
```

**核心数据结构 — `WorkerDataArray<double>`**：

每个阶段一个 `WorkerDataArray<double>*`（`:99`），存储各 GC 线程的耗时。`uninitialized()` 哨兵值为 `max_value`——区分"未参与线程"和"耗时=0 的线程"。

**子计数器**（`:81-91`）：
- `ScanRSScannedCards` / `ScanRSClaimedCards` / `ScanRSSkippedCards` — ScanRS 阶段的卡片统计
- `UpdateRSProcessedBuffers` / `UpdateRSScannedCards` / `UpdateRSSkippedCards` — UpdateRS 阶段统计

**串行阶段时间**（约 30 个 double 字段）：`_cur_collection_par_time_ms`、`_cur_clear_ct_time_ms`、`_cur_ref_proc_time_ms`、`_cur_expand_heap_time_ms` 等。

**print() 输出格式**：`[Ext Root Scanning (ms): Min: 0.1, Avg: 0.3, Max: 0.5, Diff: 0.4, Sum: 2.4]`

> **💡 G1GCPhaseTimes 的 28 个 Phase**：每个 Phase 记录所有 GC worker 线程的时间——`WorkerDataArray<double>[ParallelGCThreads]`。GC 结束后 `print()` 输出 Min/Avg/Max/Diff/Sum。Diff（Max-Min）反映工作负载不均衡——Diff 过大意味着某个 worker 的 ScanRS/ObjCopy 任务远超其他 worker，是性能调优的关键指标。

### 1.7 GCPolicyCounters — PerfData 策略计数器

`GCPolicyCounters` 构造函数（`gcPolicyCounters.cpp:30-64`）在 `"policy"` 命名空间下创建 6 个 PerfData 计数器：

```cpp
// gcPolicyCounters.cpp:30-64
GCPolicyCounters::GCPolicyCounters(const char* name, int collectors, int generations) {
  if (UsePerfData) {
    EXCEPTION_MARK;
    ResourceMark rm;
    _name = PerfDataManager::create_string_constant(SUN_GC, counter_name("name"), name, CHECK);
    _collectors = PerfDataManager::create_constant(SUN_GC, counter_name("collectors"),
                                                    PerfData::U_None, collectors, CHECK);
    _generations = PerfDataManager::create_constant(SUN_GC, counter_name("generations"),
                                                     PerfData::U_None, generations, CHECK);
    _max_tenuring_threshold = PerfDataManager::create_constant(SUN_GC,
        counter_name("maxTenuringThreshold"), PerfData::U_None, MaxTenuringThreshold, CHECK);
    _tenuring_threshold = PerfDataManager::create_variable(SUN_GC,
        counter_name("tenuringThreshold"), PerfData::U_None, MaxTenuringThreshold, CHECK);
    _desired_survivor_size = PerfDataManager::create_variable(SUN_GC,
        counter_name("desiredSurvivorSize"), PerfData::U_Bytes,
        (jlong)MaxTenuringThreshold, CHECK);
  }
}
```

**6 个计数器**：

| 计数器 | 类型 | 初始值 | 用途 |
|--------|------|--------|------|
| `name` | string_constant | "GarbageFirst" | GC 策略标识 |
| `collectors` | constant | 2 | Young+Mixed GC |
| `generations` | constant | 2 | Young+Old |
| `maxTenuringThreshold` | constant | 15 | 最大晋升阈值 |
| `tenuringThreshold` | variable | 15 | 当前晋升阈值（动态） |
| `desiredSurvivorSize` | variable (Bytes) | 15 | 期望 Survivor 大小 |

> **`UsePerfData` 守卫**：整个构造体被 `if (UsePerfData)` 包裹（`:33`），禁用 perfdata 时零开销。PerfData 通过 mmap(MAP_SHARED) 共享内存暴露给 `jstat` 读取（见 `man 5 proc` `/proc/<pid>/maps` 中的 hsperfdata 区域）。

### 1.8 G1MonitoringSupport — JMX 监控栈

`G1MonitoringSupport` 构造函数（`g1MonitoringSupport.cpp:98-225`）创建完整的 JMX 计数器层次：

```cpp
// g1MonitoringSupport.cpp:98-225 (关键段落)
G1MonitoringSupport::G1MonitoringSupport(G1CollectedHeap* g1h) :
    _g1h(g1h),
    _incremental_collection_counters(NULL),    // :100
    _full_collection_counters(NULL),           // :101
    _conc_collection_counters(NULL),           // :102
    // ... 全部指针初始化为 NULL
{
  _overall_reserved = g1h->max_capacity();     // :119
  recalculate_sizes();                          // :126

  // 3 个 CollectorCounters
  _incremental_collection_counters = new CollectorCounters(    // :138-143
    "G1 incremental collections", 0);           // collector.0
  _full_collection_counters = new CollectorCounters(           // :145-147
    "G1 stop-the-world full collections", 0);   // collector.1
  _conc_collection_counters = new CollectorCounters(           // :149-151
    "G1 stop-the-world phases", 0);             // collector.2

  // 2 个 GenerationCounters
  _old_collection_counters = new G1OldGenerationCounters(      // :171
    "old", _old_collection_max_size, _old_committed + pad, _old_committed + pad);
  _young_collection_counters = new G1YoungGenerationCounters(  // :188
    "young", _young_gen_max, _young_gen_committed + pad, _young_gen_committed + pad);

  // 5 个 HSpaceCounters
  _old_space_counters = new HSpaceCounters(                    // :177
    "old", 0, old_max, old_committed + pad, old_committed + pad);
  _eden_counters = new HSpaceCounters(                         // :190
    "eden", 0, eden_max, eden_committed + pad, eden_committed + pad);

  // S0: max_capacity=0 — G1 不使用
  _from_counters = new HSpaceCounters(                         // :203-206
    "survivor", 1, 0 /* max */, 0, 0);
  // S1: max_capacity=整个堆 — G1 只用这一个 Survivor
  _to_counters = new HSpaceCounters(                           // :210-217
    "survivor", 2, survivor_max /* max_heap_size */,
    survivor_committed + pad, survivor_committed + pad);

  _from_counters->update_used(0);  // :223 — S0 永久置零
}
```

**3 CollectorCounters + 2 GenerationCounters + 5 HSpaceCounters**：

| 计数器 | 类型 | JMX 路径 | 含义 |
|--------|------|---------|------|
| `collector.0` | `CollectorCounters` | `G1 incremental collections` | Young/Mixed GC 次数+时间 |
| `collector.1` | `CollectorCounters` | `G1 stop-the-world full collections` | Full GC 次数+时间 |
| `collector.2` | `CollectorCounters` | `G1 stop-the-world phases` | Remark/Cleanup STW 阶段 |
| `generation.0` | `G1YoungGenerationCounters` | `young` | 年轻代 |
| `generation.1` | `G1OldGenerationCounters` | `old` | 老年代 |
| `gen.0.space.0` | `HSpaceCounters` | `Eden` | Eden 空间 |
| `gen.0.space.1` | `HSpaceCounters` | `Survivor 0` | **S0, max=0, 不用** |
| `gen.0.space.2` | `HSpaceCounters` | `Survivor 1` | **S1, 实际 Survivor** |
| `gen.1.space.0` | `HSpaceCounters` | `Old` | Old 空间 |

> **💡 G1 只用 S1 做 Survivor**：传统分代 GC 在 S0/S1 之间 ping-pong 复制。G1 的 Survivor 是一组离散 Region——所有 Survivor Region 统一报告为 S1（`generation.0.space.2`）。S0（`generation.0.space.1`）的 max=0，始终为 0。这是为了兼容 `jstat -gc` 的期望格式（young gen 必须有 3 个 space），但实际 G1 不区分 from/to。

### 1.9 G1CollectedHeap 构造函数遗漏成员

`G1CollectedHeap` 构造函数（`g1CollectedHeap.cpp:1490-1582`）中有一些成员不在 02-G1-Heap-Startup 中讨论：

**G1HeapVerifier**（`:1551`）：

```cpp
// g1HeapVerifier.hpp:44-52 — G1VerifyType 枚举（位掩码）
enum G1VerifyType {
  G1VerifyYoungNormal     = 1,    // Young-only GC 后
  G1VerifyConcurrentStart = 2,    // 并发标记开始
  G1VerifyMixed           = 4,    // Mixed GC 后
  G1VerifyRemark          = 8,    // Remark 暂停后
  G1VerifyCleanup         = 16,   // Cleanup 暂停后
  G1VerifyFull            = 32,   // Full GC 后
  G1VerifyAll             = -1,   // 所有 GC 类型
};
```

6 种验证类型通过位掩码组合——`_enabled_verification_types` 是静态 int，`-XX:VerifyGCType=young-normal,mixed` → `1|4=5`。

**G1HeapSizingPolicy**（`:1555`）：

```cpp
// g1HeapSizingPolicy.hpp:33-63
class G1HeapSizingPolicy {
  static const uint MinOverThresholdForGrowth = 4;  // 连续 4 次超标才扩展
  G1CollectedHeap* _g1h;
  const G1Analytics* _analytics;
  uint _num_prev_pauses_for_heuristics;
  uint _ratio_over_threshold_count;   // 超标次数
  double _ratio_over_threshold_sum;   // 超标幅度累加
  uint _pauses_since_start;           // 窗口内暂停数
};
```

> **💡 G1HeapSizingPolicy 的扩展决策**：不是"堆满了就扩"。基于 GC 开销比——如果 `(gc_time / (gc_time + mutator_time)) > (1 / (1 + GCTimeRatio))` 且连续超过 `MinOverThresholdForGrowth=4` 次 → 触发堆扩展。扩展量由 `expansion_amount()` 计算。`GCTimeRatio=19`（默认）→ GC 时间超过 5% 即触发。

**PreservedMarksSet**（`:1527`）：

```cpp
// preservedMarks.hpp:100-147
class PreservedMarksSet {
  bool _in_c_heap;                    // true (G1 用 C-Heap)
  uint _num;
  Padded<PreservedMarks>* _stacks;    // 每个 worker 一个，Padded 防止 false sharing
};
```

> **💡 PreservedMarks 机制**：Evacuation failure 发生时，GC 线程无法将对象复制到目标 Region → 必须保持对象在原位置 → 但对象可能已经被 forward（mark word 被修改为 forwarding pointer）→ `PreservedMarks::push(oop, mark)` 保存原始 mark word → GC 结束后 `restore()` 恢复所有被修改的 mark word。`Padded<>` 包装确保每个 worker 的 PreservedMarks 在独立 cache line。

**其他遗漏成员**：
- `G1ArchiveAllocator*` — 归档分配器（CDS 支持）
- `G1EvacStats × 2` — Eden 和 Survivor 的 evacuation 统计
- `ReferenceProcessor × 2` — STW 和并发引用处理器
- `HeapRegionSet × 2` — `_old_set` 和 `_archive_set`

### 1.10 EvacuationFailedInfo 数组

`g1CollectedHeap.cpp:1567-1573` 创建 13 个 EvacuationFailedInfo（每个 GC 线程一个）：

```cpp
// copyFailedInfo.hpp:32-93 — 类层次
class CopyFailedInfo : public CHeapObj<mtGC> {
  size_t _first_size;       // 第一个失败对象大小（代表性）
  size_t _smallest_size;    // 最小失败对象大小（诊断碎片化）
  size_t _total_size;       // 失败对象总大小（衡量严重程度）
  uint _count;              // 失败次数
};

class PromotionFailedInfo : public CopyFailedInfo {
  traceid _thread_trace_id; // JFR 线程追踪 ID
};

class EvacuationFailedInfo : public CopyFailedInfo {
  // 空类体 — 直接继承基类
};
```

> **💡 EvacuationFailedInfo 的三级统计**：`_first_size`（第一个失败对象大小——通常是最大对象触发失败）→ `_smallest_size`（最小失败对象——说明 PLAB 碎片化严重）→ `_total_size`（失败对象总大小——衡量整体失败程度）→ `_count`（失败次数）。这些数据反馈给 G1Analytics 调整下次 GC 的 Eden 大小。

每个 EvacuationFailedInfo 约 44B（4×size_t + uint + padding + CHeapObj 头），13 个 = ~572B。

### 1.11 initialize_serviceability — MemoryPool 注册

`g1CollectedHeap.cpp:2538-2550`：

```cpp
void G1CollectedHeap::initialize_serviceability() {
    _eden_pool = new G1EdenPool(this);         // :2539
    _survivor_pool = new G1SurvivorPool(this); // :2540
    _old_pool = new G1OldGenPool(this);        // :2541

    _full_gc_memory_manager.add_pool(_eden_pool);       // :2543
    _full_gc_memory_manager.add_pool(_survivor_pool);   // :2544
    _full_gc_memory_manager.add_pool(_old_pool);        // :2545

    _memory_manager.add_pool(_eden_pool);               // :2547
    _memory_manager.add_pool(_survivor_pool);           // :2548
    _memory_manager.add_pool(_old_pool, false);         // :2549 — always_affected_by_gc=false
}
```

**关键**：`_old_pool` 以 `always_affected_by_gc=false` 注册到 `_memory_manager`（Young/Mixed GC 的 manager）。这意味着 Young/Mixed GC 不会触发 Old Pool 的 JMX `MemoryNotification`——因为 Young/Mixed GC 通常不回收 Old Gen。只有 Full GC（`_full_gc_memory_manager`）必然影响 Old Pool。

**反事实**：如果 Old Pool 也标记 `always_affected_by_gc=true` → 每次 Young GC 后 jconsole 都会收到 Old Gen 的 MemoryNotification → jconsole 刷新 UI → 但实际上 Old Gen 使用量没变 → 虚假通知浪费 CPU。

**3 个 G1MemoryPool 的类型继承**：`G1EdenPool`/`G1SurvivorPool`/`G1OldGenPool` → `G1MemoryPoolSuper` → `CollectedMemoryPool` → `MemoryPool`。`G1MemoryPoolSuper::get_memory_usage()` 动态调用 `_g1h->g1_policy()->mem_usage(type)` 计算——因为 G1 Region 的 type 随时变化，不能缓存。

### §一 末尾 — Interview Story Format Answer

"`G1Policy` 构造函数（`g1Policy.cpp:50-72`）在初始化列表中创建 8 个决策组件：`G1Predictions`（线性回归，置信度=G1ConfidencePercent/100=0.5，`:51`）→ `G1Analytics`（`:52`，17 个 TruncatedSeq，每个长度 10，存储 `cost_per_card_ms`/`alloc_rate`/`rs_length_diff` 等成本因子的最近 10 次观测值，用 alpha=0.7 的指数衰减加权平均做预测——`davg() = old×0.7 + new×0.3`）→ `G1MMUTrackerQueue`（`:54`，64 元素环形队列，每元素 `G1MMUTrackerQueueElem` 16B，追踪 GC 暂停是否超出 MaxGCPauseMillis 目标——`when_sec()` 计算下次 GC 前需要等待的时间，`calculate_gc_time()` 累加时间窗口内 GC 总时间，含边界裁剪）→ `G1IHOPControl`（`:56`，`G1UseAdaptiveIHOP=true` 时 `G1AdaptiveIHOPControl` 维护 `_marking_times_s` 和 `_allocation_rate_s` 两个 TruncatedSeq(alpha=0.95)，动态调整 heap occupancy 阈值使并发标记在堆满前完成；false 时 `G1StaticIHOPControl` 固定返回 `IHOP% × target_occupancy`）→ `GCPolicyCounters`（`:57`，PerfData 命名空间 `policy`，暴露 `tenuringThreshold` 和 `desiredSurvivorSize` 到 jstat）→ `SurvRateGroup×2`（`:59-60`，`short_lived` 和 `survivor`，每个 Region age 一个 TruncatedSeq(10)，追踪对象存活率——初始种子 0.4（40%），`accum_surv_rate_pred[i]` 累积 i 个 age 后的预期存活率）→ `G1GCPhaseTimes`（`:67`，28 个 GCParPhases × ParallelGCThreads 个 Worker 的 `WorkerDataArray<double>` 数组，记录 ExtRootScan/UpdateRS/ScanRS/ObjCopy/Termination 等阶段的每线程耗时）。

`G1CollectedHeap` 构造函数遗漏子系统：`G1HeapVerifier`（`:1551`，`_enabled_verification_types` 静态位掩码，YoungNormal=1/ConcurrentStart=2/Mixed=4/Remark=8/Cleanup=16/Full=32）→ `G1HeapSizingPolicy`（`:1555`，`_ratio_over_threshold_count` 追踪 GC 开销比是否持续超出 GCTimeRatio，`MinOverThresholdForGrowth=4` 次触发堆扩展）→ `EvacuationFailedInfo[13]`（`:1567-1573`，每个 GC 线程一个，记录 `_first_size`/`_smallest_size`/`_total_size`/`_count`）→ `PreservedMarksSet`（`:1527`，`_stacks` 数组每个 worker 一个 `Padded<PreservedMarks>`，每个 PreservedMarks 含 `Stack<OopAndMarkOop>` 用于 evacuation failure 时保存 mark word）。

`G1MonitoringSupport`（`:2403`，~1.1KB）创建 3 个 CollectorCounters（collector.0: incremental collections, collector.1: full collections, collector.2: concurrent STW phases）+ 2 个 GenerationCounters（generation.0: young, generation.1: old）+ 5 个 HSpaceCounters（gen.0.space.0: Eden, gen.0.space.1: S0/max=0 不用, gen.0.space.2: S1/实际 Survivor, gen.1.space.0: Old）。`initialize_serviceability()`（`:2538-2550`）创建 3 个 G1MemoryPool（Eden/Survivor/OldGen）注册到 2 个 GCMemoryManager，其中 Old Pool 以 `always_affected_by_gc=false` 注册。总内存开销约 43KB（不含 SurvRateGroup 动态扩展）。"

### 1.12 G1YoungGenSizer — 年轻代尺寸启发式 (<code>_young_gen_sizer</code>, `g1Policy.hpp:99`)

`G1YoungGenSizer` 是一个值对象（约 12B：enum 4B + 2×uint 8B = 12B），负责根据 JVM 参数和堆大小计算年轻代的 min/max Region 数边界。

**五种模式**（`g1YoungGenSizer.hpp:68-74`）:

| 模式 | 触发条件 | min young length | max young length | `_adaptive_size` |
|------|---------|------------------|------------------|-------------------|
| `SizerDefaults` | 无 `-Xmn`/`NewSize`/`MaxNewSize`/`NewRatio` | `G1NewSizePercent=5%` × HeapRegions | `G1MaxNewSizePercent=60%` × HeapRegions | `true` |
| `SizerNewSizeOnly` | 仅 `-XX:NewSize=N` | `N/RegionSize` | `G1MaxNewSizePercent` × HeapRegions | `true` |
| `SizerMaxNewSizeOnly` | 仅 `-XX:MaxNewSize=N` | `G1NewSizePercent` × HeapRegions | `N/RegionSize` | `true` |
| `SizerMaxAndNewSize` | `NewSize` + `MaxNewSize` 同时设置 | `NewSize/RegionSize` | `MaxNewSize/RegionSize` | `min≠max` 时为 `true` |
| `SizerNewRatio` | 仅 `-XX:NewRatio=N` | `heap/(N+1)` | `heap/(N+1)` | `false` (固定) |

**构造函数**（`g1YoungGenSizer.cpp:32-71`）解析参数优先级：
- `NewRatio` 与 `NewSize`/`MaxNewSize` 互斥——同时设置时前者被忽略并输出警告（`:35-37`）
- `NewSize > MaxNewSize` 时自动 `FLAG_SET_ERGO(MaxNewSize, NewSize)`（`:50`）——静默修正，不抛错
- `_adaptive_size` 最终值决定 `G1Policy::adaptive_young_list_length()`（`g1Policy.hpp:384`）——`true` 时用暂停预测模型动态调整 young list，`false` 时固定为 `_young_list_fixed_length`

**核心方法** `recalculate_min_max_young_length(number_of_heap_regions)`（`g1YoungGenSizer.cpp:83-111`）用 `switch (_sizer_kind)` 分发五种模式的 min/max 计算。示例（8GB 堆，4MB Region = 2048 个）：
- `SizerDefaults`: min=2048×5%=102 个 (408MB), max=2048×60%=1228 个 (4.9GB)
- `SizerNewRatio=2`: min=max=2048/3=682 个 (2.7GB)

**`adjust_max_new_size()`**（`g1YoungGenSizer.cpp:113-126`）在堆大小变化时更新 `MaxNewSize`——用 `FLAG_SET_ERGO` 而非 `FLAG_SET_CMDLINE`，允许后续重新计算覆盖。

**`heap_size_changed()`**（`g1YoungGenSizer.cpp:128-131`）在堆扩展/收缩后重新计算 min/max young length——只有 `SizerDefaults`/`SizerNewSizeOnly`/`SizerMaxNewSizeOnly` 模式会响应堆大小变化（`SizerMaxAndNewSize` 和 `SizerNewRatio` 有固定计算或用户指定值不变）。

**查询 API**：`min_desired_young_length()`/`max_desired_young_length()`（`g1YoungGenSizer.hpp:97-102`）被 G1Policy 的 `calculate_young_list_desired_min_length()` 和 `calculate_young_list_desired_max_length()` 调用——用户的 `-Xmn`/`NewSize`/`MaxNewSize` 经 G1YoungGenSizer 转为 Region 数边界后，再由暂停预测模型在边界内寻找最优 target。

**反事实**：如果 G1YoungGenSizer 不接受 `heap_size_changed()` 通知 → 堆扩展到 16GB 后 young gen 仍被限制在 8GB 时的 5-60% 范围 → 实际 max young = 8GB×60%=4.8GB 而非 16GB×60%=9.6GB → young gen 被"隐形限制"→ GC 频率比预期更高。`heap_size_changed()` 确保缩放总是相对于当前堆大小。

### 1.12b Young List 三级长度限制 (`g1Policy.hpp:82-87`)

`_young_list_target/fixed/max_length` 构成三层约束，决定 Eden Region 数量：

**`_young_list_target_length`**（`uint`，4B，`:82`）：由 `update_young_list_target_length()` 根据 G1Analytics 暂停预测模型动态计算——"在当前 Eden 大小和 RSet 成本下，能否在 MaxGCPauseMillis 内完成 GC？" 预测超时则缩小 target；有盈余则扩大。

**`_young_list_fixed_length`**（`uint`，4B，`:83`）：当 `_young_gen_sizer.adaptive_young_list_length()=false`（用户设 `NewSize==MaxNewSize`）时，target 固定为 fixed。此时跳过暂停预测——直接使用固定值，保证可复现行为。

**`_young_list_max_length`**（`uint`，4B，`:87`）：上限，受 `_young_gen_sizer.max_desired_young_length()` 约束。GC locker 激活时（JNI `GetPrimitiveArrayCritical` 持有原始指针），`update_max_gc_locker_expansion()` 可临时提升此上限到 `max_desired_young_length`，防止 Eden 无法扩展导致 immediate GC。

**三级约束的设计理由**：`fixed ≤ target ≤ max`。`target` 是暂停预测的输出——"理想值"；`max` 是资源边界——"堆最多给你这么多 Region"；`fixed` 是用户意图——"如果用户要求固定，尊重它"。三者共同决定 `_young_list_target_length` 的最终值。

**反事实**：如果只用 `target` 和 `max` 两级（不用 `fixed`）→ 用户设 `-Xmn=2g`（NewSize=MaxNewSize=2G）→ 但 `adaptive_young_list_length=true` → G1 仍然动态调整 → 用户期望的 2G 固定值被忽略 → 基准测试结果不可复现。`fixed` 层确保 SizerMaxAndNewSize + min=max 时完全尊重用户固定大小意图。

**诊断工具**：
```bash
jcmd <pid> VM.flags | grep -E "NewSize|MaxNewSize|G1NewSizePercent|G1MaxNewSizePercent"
# 查看年轻代尺寸相关参数和模式
jstat -gc <pid> 1000 | awk '{print $5}'  # EU=Eden Used, 观察动态波动
grep -E "Young Gen Sizing" gc.log        # INST_LOG_GC 日志输出
```

### 1.13 RSet 扫描成本预测 — `_max_rs_lengths` 与 `_rs_lengths_prediction`

`_max_rs_lengths`（`g1Policy.hpp:103`，`size_t`，8B）和 `_rs_lengths_prediction`（`:105`，`size_t`，8B）是 G1 暂停时间预测模型的 RSet 维度输入，直接决定 young gen target length。

**`_max_rs_lengths`**：当前 young gen 中单个 Region 的 RSet 最大卡表条目数。由 `record_max_rs_lengths()`（`g1Policy.hpp:132-134`）在 GC 构建 CSet 时写入——用于评估"最坏情况 Region"的 ScanRS 耗时。如果某个 Region 有异常多的跨 Region 引用，它是暂停时间的主导因素。

**`_rs_lengths_prediction`**：预测下次 GC 时 young gen 所有 Region 的 RSet 总长度。两个重载（`g1Policy.hpp:232-233`）：
- `update_rs_lengths_prediction()`：从 G1Analytics 的 `_rs_lengths_seq`（TruncatedSeq，10 entries）取预测值
- `update_rs_lengths_prediction(size_t prediction)`：直接覆盖——用于 `revise_young_list_target_length_if_necessary()` 时修正

输入到 `calculate_young_list_target_length(rs_lengths, base_min, desired_min, desired_max)`（`g1Policy.hpp:222-225`）——该函数的签名揭示：`rs_lengths` 是限制因子，决定"在当前 RSet 扫描成本下，最多能容纳多少 Eden Region 在 MaxGCPauseMillis 内完成 GC"。

**暂停预测的 RSet 维度流水线**：
```
G1Analytics::_rs_lengths_seq (历史序列, TruncatedSeq×10)
  → get_new_prediction → _rs_lengths_prediction
  → predict_card_num(rs_lengths, for_young) = cards_per_entry_ratio × rs_lengths
  → predict_rs_scan_time_ms(card_num) = card_num × cost_per_entry_ms
  → 加上 predict_rs_update_time_ms(pending_cards)
  → predict_base_elapsed_time_ms(pending_cards, scanned_cards)
  → calculate_young_list_target_length()
  → _young_list_target_length
```

**反事实**：如果 `_rs_lengths_prediction` 用固定静态值而非预测模型 → 应用启动早期 RSet 条目极少（预测偏小）→ Eden 过大 → 单次 GC 远超 MaxGCPauseMillis。稳定运行后 RSet 增长至几万条目（预测偏大）→ Eden 过小 → GC 频率飙升 → 吞吐量骤降。`_rs_lengths_seq` 和 `_rs_length_diff_seq` 两个 TruncatedSeq 分别追踪绝对值和增量变化，让预测能跟上应用的行为变化。

**`revise_young_list_target_length_if_necessary()`**（`g1Policy.hpp:296`）是一个实时修正机制：如果当前 young gen 的实际 RSet 长度超过了上次预测值，说明预测偏乐观，立刻重新调用 `update_young_list_target_length(actual_rs_lengths)` 修正 target——不等待下次 GC 预测更新。

**GDB 验证**：
```bash
(gdb) print _g1_policy->_max_rs_lengths
期望: 当前 young gen 最大单 Region RSet 长度（~数百到数千）
(gdb) print _g1_policy->_rs_lengths_prediction
期望: 下次 GC 预测的 RSet 总长度
(gdb) print _g1_policy->_analytics->_rs_lengths_seq->last()
期望: 最近一次实际 RSet 总长
```

### 1.14 `_pending_cards` — 脏卡队列中的待处理卡片数 (`g1Policy.hpp:107`)

`_pending_cards`（`size_t`，8B）追踪 `DirtyCardQueueSet (DCQ)` 中等待处理的脏卡数量——即 mutator 线程写入引用跨越 Region 边界产生的卡表条目，尚未被 Refine/UpdateRS 线程处理。

**生命周期**：
- 每次 GC evacuation pause 开始时，从 DCQ 读取当前 pending 数量（`record_collection_pause_start()`）
- 用于 `predict_base_elapsed_time_ms(pending_cards)`（`g1Policy.hpp:136-138`）——"处理所有 pending 脏卡需要多少时间？"
- 该预测 = `predict_rs_update_time_ms(pending_cards)` + `predict_rs_scan_time_ms(...)` + `predict_constant_other_time_ms()`

**`predict_rs_update_time_ms()` 的线性公式**（`g1Analytics.hpp:127-129`）：
```cpp
return pending_cards × predict_cost_per_card_ms() + predict_scan_hcc_ms()
// cost_per_card_ms 由 TruncatedSeq 追踪（10 entries, alpha=0.7）
// scan_hcc_ms 是 Hot Card Cache 的扫描固定成本
```

**在 G1Analytics 中的序列**：`_pending_cards_seq`（`g1Analytics.cpp:167`）是 19 个 TruncatedSeq 之一，但未像 `_rs_lengths_seq` 那样注入预设种子——因为 pending_cards 没有经验和线程数相关的默认值。第一个预测依赖 `_cost_per_card_ms_seq` 的种子值（`cost_per_card_ms_defaults[index]`）间接工作。

**反事实**：如果没有实时 `_pending_cards` → 只能用历史平均 `cost_per_card_ms × avg_pending_cards` → 当 mutator 突然大量写入引用（如批量 `HashMap.putAll`），pending_cards 可能从 1000 飙到 10000 → 实际 RS 更新时间是预测的 10 倍 → GC 暂停严重超时。`_pending_cards` 让预测模型对"突发写入"敏感。

**GDB 验证**：
```bash
(gdb) print _g1_policy->_pending_cards
期望: 当前 DCQ 中待处理卡片数
(gdb) print _g1_policy->predict_base_elapsed_time_ms(_g1_policy->_pending_cards)
期望: RS update + scan + constant_other 的预测总时间 (ms)
```

### 1.15 AgeTable — 按龄存活对象统计 (`_survivors_age_table`, `g1Policy.hpp:400`)

`AgeTable` 是值对象（~64B：16×4B uint 数组），存储每个 GC age（0-15）在 **本次 GC** 中存活的对象总大小。与 `SurvRateGroup` 互补——一个是"当前快照"，一个是"长期趋势"。

**数据结构**（`ageTable.hpp`）：
- 核心：`uint _sizes[table_size]` 数组（16 个元素 = ages 0-15）
- 每个 age 记录该龄级存活对象的总字节数
- `merge(AgeTable* other)`（`g1Policy.hpp:418-420`）：GC 后各线程的 per-thread age table 汇总到 `_survivors_age_table`

**AgeTable vs SurvRateGroup — 互补关系**：

| 维度 | AgeTable (`_survivors_age_table`) | SurvRateGroup (`_short_lived`/`_survivor`) |
|------|-----------------------------------|---------------------------------------------|
| 对象 | 每个 age 存活 **字节数**（绝对量） | 每个 age 存活 **率**（百分比） |
| 粒度 | 单次 GC 快照 | 多次 GC 的 TruncatedSeq(10) 加权平均 |
| 用途 | `tenuring threshold` 精确决策 | 远程预测（预测未来存活率） |
| 数据来源 | GC 期间各线程 PLAB 存活计数 | 多次 GC 的 `record_surviving_words()` |
| 消费点 | `update_survivors_policy()` | `accum_surv_rate_pred(age)` |
| 时效 | 每次 GC 后 print + reset | 长期维护，alpha=0.7 衰减平均 |

**在 tenuring threshold 中的决策逻辑**（`g1Policy.cpp` `update_survivors_policy()`）：
1. 从 `_survivors_age_table` 读取每个 age 的存活字节数
2. 从 age=0 向上累加存活字节数
3. 当累加值超过 `desired_survivor_size()` 时停止
4. 上一 age 即为 `_tenuring_threshold`——超过该 age 的对象将被晋升到 Old gen
5. `print_age_table()` 输出完整的 age 分布到 GC log

**SurvRateGroup 的辅助角色**：用于"如果 tenuring threshold 降低，释放出来的 Survivor Region 能容纳多少 Eden 存活对象"——即 `desired_survivor_size()` 的计算依赖 SurvRateGroup 的 `accum_surv_rate_pred()` 预测远期存活率。

**反事实**：如果只用 SurvRateGroup 预测而不用 AgeTable → 无法精确知道"当前 Survivor 中每个 age 实际有多少对象存活"→ tenuring threshold 只能靠历史趋势估算 → 可能过早晋升（增加 Mixed GC 频率）或过晚晋升（Survivor 溢出到 Old gen）。AgeTable 是精确的"当前快照"——tenuring threshold 必须是精确的，不能靠"趋势"。

**GDB 验证**：
```bash
(gdb) print _g1_policy->_survivors_age_table
期望: 16 元素数组，每个元素表示该 age 存活字节数
(gdb) print _g1_policy->_tenuring_threshold
期望: 当前晋升阈值 (0-15)，由 update_survivors_policy() 计算
```

### 1.16 `_free_regions_at_end_of_collection` — GC 后空闲 Region 数 (`g1Policy.hpp:101`)

`_free_regions_at_end_of_collection`（`uint`，4B）记录每次 GC evacuation pause 结束后的空闲 Region 数量——是 GC 健康度的最简单但最关键的指标。

**生命周期**：
- 在 `record_collection_pause_end()` 中更新：`_free_regions_at_end_of_collection = _g1h->num_free_regions()`
- 被 `G1HeapSizingPolicy` 读取，用于判断堆扩展/收缩决策
- 作为 `calculate_young_list_target_length()` 的 `base_free_regions` 参数——如果 free regions 太少，即使暂停预测允许，也无法扩展 young gen

**在堆大小决策中的作用**：
```
_free_regions_at_end_of_collection < G1ReservePercent(10%) × total_regions / 100
  → 触发堆扩展检查（减少 GC 频率，保证 mutator 有空间分配）
_free_regions_at_end_of_collection > threshold_high (如 30%)
  → 触发堆收缩检查（释放内存给 OS）
```
扩展决策不是即时的——`G1HeapSizingPolicy`（`g1HeapSizingPolicy.hpp:33-63`）的 `_ratio_over_threshold_count` 需要连续 `MinOverThresholdForGrowth=4` 次 GC 开销比超标才触发扩展。这是 hysteresis（滞后效应）——防止单次异常触发不必要扩展。

**反事实**：如果缺少 `_free_regions_at_end_of_collection` → 无法评估"堆还有多少空余"→ 可能在仍有大量空闲时扩展（浪费内存，`man 2 mmap` `MAP_NORESERVE` 也不能避免虚拟地址空间碎片化），或在堆已近满时仍不扩展（持续 GC，mutator 无法分配 → evacuation failure → Full GC）。

**GDB 验证**：
```bash
(gdb) print _g1_policy->_free_regions_at_end_of_collection
期望: 上次 GC 后空闲 Region 数
(gdb) print _g1h->num_free_regions()
期望: 当前空闲 Region 数（应与上面一致，如果无中间分配）
(gdb) print _g1_policy->_heap_sizing_policy->_ratio_over_threshold_count
期望: 连续 GC 开销比超标次数（<4 时不触发扩展）
```

### 1.17 `_bytes_copied_during_gc` — GC 期间的 evacuation 拷贝字节数 (`g1Policy.hpp:181`)

`_bytes_copied_during_gc`（`size_t`，8B）累加当前 GC 中 evacuation 复制的对象字节数——是衡量 GC 复制效率的核心指标。

**累加逻辑**（`g1Policy.hpp:332-334`）：
```cpp
void record_bytes_copied_during_gc(size_t bytes) {
  _bytes_copied_during_gc += bytes;
}
```
- 在 GC alloc region 退役时调用——每次 PLAB 或 G1AllocRegion 填满时 `retire(true)` 触发
- 在 `note_gc_start()` 时重置为 0（即每次 GC 重新计数）

**度量 evacuation 效率**：
- `bytes_copied / gc_time = evacuation throughput (B/ms)` — 核心吞吐量指标
- 如果 throughput 突然下降 → 可能有对象复制瓶颈：大量跨 Region 引用 → 每次复制都要更新 RSet → write barrier 开销
- 用于更新 G1Analytics 的 `_cost_per_byte_ms_seq`（TruncatedSeq，10 entries）——`cost_per_byte = gc_time / bytes_copied`，预测下次 GC 复制成本

**对暂停预测的反馈**：
```
本次 bytes_copied → update _cost_per_byte_ms_seq
  → predict_object_copy_time_ms(bytes_to_copy, during_cm)
  → 参与 predict_region_elapsed_time_ms(hr) 计算
  → 影响 calculate_young_list_target_length()
```
即"上次拷贝了 500MB → cost_per_byte=0.02ms/MB → 下次预测中，每 100MB 预计耗时 2ms"。

**反事实**：如果缺少 `_bytes_copied_during_gc` → 无法精确计算 GC 复制吞吐量 → G1Analytics 的 `_cost_per_byte_ms_seq` 无数据 → 暂停预测缺少对象复制时间分量 → 要么 young gen 偏大（暂停超时），要么偏小（频繁 GC）。这个计数器是 evacuation 性能调优的基础数据。

**GDB 验证**：
```bash
(gdb) print _g1_policy->_bytes_copied_during_gc
期望: 当前 GC 中已拷贝字节数（GC 完成时 = 总拷贝量）
(gdb) print _g1_policy->_analytics->_cost_per_byte_ms_seq->last()
期望: 最近一次 GC 每字节拷贝成本 (ms/B)
```

### 1.18 G1RemSetTrackingPolicy — RSet 跟踪状态机 (`_remset_tracker`, `g1Policy.hpp:68`)

`G1RemSetTrackingPolicy`（值对象，继承 `CHeapObj<mtGC>`，~8B 虚表指针——类体无数据成员，全部由方法驱动）管理每个 HeapRegion 的 RSet 状态转换：EMPTY（不跟踪）→ UPDATING（重建中）→ COMPLETE（已跟踪）。

**5 个核心状态转换方法**（`g1RemSetTrackingPolicy.hpp:39-54`）：

| 方法 | 调用时机 | 状态转换 |
|------|---------|---------|
| `update_at_allocate(r)` | Region 分配（任何时间） | Young/Humongous→COMPLETE, Old/Archive→EMPTY |
| `needs_scan_for_rebuild(r)` | Remark 阶段 | 判断非 Young/非 Archive/非 Free → 需扫描 |
| `update_before_rebuild(r, live_bytes)` | Remark 阶段（safepoint） | 符合条件的 Old → UPDATING |
| `update_after_rebuild(r)` | Cleanup 阶段（safepoint） | UPDATING→COMPLETE, oversized→drop |
| `update_humongous_before_rebuild(r, is_live)` | Remark 阶段（safepoint） | TypeArray 巨型+未跟踪 → UPDATING |

**`update_at_allocate` — Region 分配时的 RSet 初始化**（`g1RemSetTrackingPolicy.cpp:41-62`）：
```
Young Region → r->rem_set()->set_state_complete()
  # 始终跟踪——Young GC 频繁，RSet 对 Young 回收至关重要
Humongous Region → r->rem_set()->set_state_complete()
  # 支持 eager reclaim——并发标记识别死巨型对象后立即回收
Old Region → r->rem_set()->set_state_empty()
  # 延迟创建——大部分 Old Region 存活率高，不值得建 RSet
Archive Region → r->rem_set()->set_state_empty()
  # CDS Archive 永不移动——永远不需要 RSet
```

**`update_before_rebuild` — Remark 阶段的 RSet 选择性重建**（`g1RemSetTrackingPolicy.cpp:112-153`）：
```cpp
total_live_bytes = live_bytes + (r->top() - r->next_top_at_mark_start())*HeapWordSize;
// live_bytes 来自并发标记的 liveness 数据
// (top - ntams) 是标记后新分配的对象——也视为 live
if (total_live_bytes > 0 &&
    CollectionSetChooser::region_occupancy_low_enough_for_evac(total_live_bytes) &&
    !r->rem_set()->is_tracked()) {
  r->rem_set()->set_state_updating();  // 触发并发 RSet 重建
}
```
关键：只有存活率低的 Old Region 才值得重建 RSet 后 evacuate。存活率高的 Region → RSet 内存浪费 → 不建。

**`update_after_rebuild` — Cleanup 阶段的 RSet 清理**（`g1RemSetTrackingPolicy.cpp:155-192`）：
- UPDATING→COMPLETE：RSet 重建完成，标记为已跟踪
- oversized humongous RSet → `clear_locked(true)`：如果 RSet 太大，丢弃——因为不会尝试 evacuate 这个巨型对象（`!is_potential_eager_reclaim_candidate`）

**无 coarsening 阈值**：RSet 的 Sparse PRT → Fine PRT → Coarse 位图升级逻辑在 `HeapRegionRemSet`（`heapRegionRemSet.cpp`）中。`G1RemSetTrackingPolicy` 只管理 Region 级别的"是否跟踪"状态，不管理 PRT 的内部格式转换。coarsening 阈值是 PRT 的 `_max_fine_entries` 参数控制的。

**反事实**：如果所有 Old Region 从分配就跟踪 RSet → 大部分 Old Region 存活率远高于可 evacuate 阈值 → RSet 内存浪费（每个 Old Region PRT 可达数 KB，大量 Old Region 的 RSet 总内存可达堆的 ~5%）→ `update_before_rebuild` 的延迟跟踪确保只为"值得 evacuate"的少数 Old Region 维护 RSet。

**GDB 验证**：
```bash
(gdb) print _g1_policy->_remset_tracker
期望: 值对象，无数据成员（纯方法驱动状态机）
(gdb) print _g1h->region_at(10)->rem_set()->is_tracked()
期望: Young/Humongous→true, Old/Free/Archive→false (除非 rebuild 后)
(gdb) print _g1h->region_at(10)->rem_set()->state()
期望: Empty/Updating/Complete 枚举值
```

### 1.19 G1OldGenAllocationTracker — 老年代分配速率追踪 (`_old_gen_alloc_tracker`, `g1Policy.hpp:73`)

`G1OldGenAllocationTracker`（值对象，5×size_t=40B）追踪两次 GC 间老年代的分配速率——是 G1AdaptiveIHOPControl 预测"堆满前能完成并发标记吗"的核心数据源。

**5 个成员变量**（`g1OldGenAllocationTracker.hpp:36-50`）：

| 成员 | 大小 | 含义 | 更新者 |
|------|------|------|--------|
| `_last_period_old_gen_bytes` | 8B | 上一周期的老年代总分配（旧+巨型） | `reset_after_gc()` |
| `_last_period_old_gen_growth` | 8B | 上一周期的老年代 **净增长**（扣除 Eager Reclaim） | `reset_after_gc()` |
| `_humongous_bytes_after_last_gc` | 8B | 上次 GC 后巨型对象总大小（基线） | `record_collection_pause_humongous_allocation()` |
| `_allocated_bytes_since_last_gc` | 8B | 本周期非巨型 old gen 分配 | `add_allocated_bytes_since_last_gc()`（每次晋升） |
| `_allocated_humongous_bytes_since_last_gc` | 8B | 本周期巨型对象分配 | `add_allocated_humongous_bytes_since_last_gc()`（每次巨型分配） |

**`reset_after_gc(humongous_bytes_after_gc)` — 结算逻辑**（`g1OldGenAllocationTracker.cpp:37-62`）：
```cpp
// 巨型对象净增长（当前 - 上次基线，考虑 Eager Reclaim 回收）
size_t last_period_humongous_increase =
  humongous_bytes_after_gc > _humongous_bytes_after_last_gc
    ? humongous_bytes_after_gc - _humongous_bytes_after_last_gc
    : 0;  // Eager Reclaim 回收了巨型对象 → 净增长为 0（非负）

// 净增长 = 非巨型晋升 + 巨型净增长
_last_period_old_gen_growth = _allocated_bytes_since_last_gc + last_period_humongous_increase;

// 总分配 = 非巨型晋升 + 巨型总分配（含被回收的）
_last_period_old_gen_bytes = _allocated_bytes_since_last_gc + _allocated_humongous_bytes_since_last_gc;

// 更新基线并重置计数器
_humongous_bytes_after_last_gc = humongous_bytes_after_gc;
_allocated_bytes_since_last_gc = 0;
_allocated_humongous_bytes_since_last_gc = 0;
```

**`_last_period_old_gen_bytes` ≠ `_last_period_old_gen_growth`**：
- `_bytes` = 总分配（全部晋升+巨型），是 mutator 的总输出
- `_growth` = 净增长（总分配 - 被 Eager Reclaim 回收的巨型对象），是 GC 需要回收的"新增垃圾"

**与 G1AdaptiveIHOPControl 的交互**（`g1IHOPControl.cpp` `update_allocation_info()`）：
```cpp
_allocation_rate_s->add(_old_gen_alloc_tracker->last_period_old_gen_growth() / allocation_time_s);
```
每次 GC 后，IHOP 用 `_growth`（净增长）除以时间得到分配速率（B/s），加入 TruncatedSeq（alpha=0.95=更平滑）。这用于预测"标记完成前，老年代净增长多少"——标记完成后需要回收这些新增垃圾。

**反事实**：如果 IHOP 用 `last_period_old_gen_bytes`（总分配）而非 `_growth`（净增长）→ Eager Reclaim 回收的巨型对象不计入净增长 → 但 `_bytes` 仍会计入被回收的分配 → 分配速率被高估 → 预测偏悲观 → IHOP 阈值被压低更多 → 并发标记过早启动 → 增加不必要的标记 CPU 开销。`_growth` 反映"GC 真正需要回收的量"。

**GDB 验证**：
```bash
(gdb) print _g1_policy->_old_gen_alloc_tracker._last_period_old_gen_growth
期望: 上一周期老年代净增长 (B)
(gdb) print _g1_policy->_old_gen_alloc_tracker._allocated_bytes_since_last_gc
期望: 本周期至今的非巨型老年代分配量 (B)
(gdb) print _g1_policy->_ihop_control->_allocation_rate_s->avg()
期望: 老年代分配速率加权平均值 (B/s)
```

### 1.20 G1InitialMarkToMixedTimeTracker — Initial Mark → Mixed GC 的时间窗口 (`_initial_mark_to_mixed`, `g1Policy.hpp:109`)

`G1InitialMarkToMixedTimeTracker`（值对象，~32B：bool(1)+3×double(24)+padding=32B）记录从 Initial Mark 暂停结束到第一个 Mixed GC 开始的墙钟时间，扣除期间的 STW 暂停，得到纯并发标记时间——是 IHOP 预测"下次标记需要多久"的唯一数据源。

**状态机**（`g1InitialMarkToMixedTimeTracker.hpp:35-85`）：

```
IDLE (_active=false)
  → record_initial_mark_end(t) → ACTIVE (_initial_mark_end_time=t)
    → [期间] add_pause(pause_time) — 累加 Young GC/Remark/Cleanup 暂停
    → record_mixed_gc_start(t) → COMPLETE (_mixed_start_time=t, _active=false)
      → last_marking_time() → 获取结果 + 自动 reset → IDLE
```

**三个关键 API**：

| API | 调用者 | 记录 |
|-----|--------|------|
| `record_initial_mark_end(end_time)` | `record_collection_pause_end()` 中 `is_initial_mark_pause()` 时 | IM GC 暂停结束时间 |
| `record_mixed_gc_start(start_time)` | `record_collection_pause_start()` 中 `in_mixed_phase()` 时 | 第一个 Mixed GC 暂停开始 |
| `add_pause(time)` | 各 GC 的暂停记录方法 | IM 到 Mixed 之间所有 GC 暂停的累计时间 |

**`last_marking_time()` 计算公式**（`:63-68`）：
```cpp
double last_marking_time() {
  double result = (_mixed_start_time - _initial_mark_end_time) - _total_pause_time;
  reset();  // 一次性，获取后自动重置
  return result;
}
```

`_total_pause_time` 是 IM 到 Mixed 之间所有非 IM/Mixed GC 暂停时间之和——因为并发标记线程与 mutator 并发运行，但 STW 暂停会暂停 mutator。减去暂停时间得到的 `last_marking_time()` 更准确反映纯并发标记工作量。

**与 G1AdaptiveIHOPControl 的关联**（`g1IHOPControl.cpp` `update_marking_length()`）：
```cpp
void G1AdaptiveIHOPControl::update_marking_length(double marking_length_s) {
  _marking_times_s->add(marking_length_s);
}
```
标记完成后的 Cleanup 阶段调用 `update_marking_length(last_marking_time())` → 将本次纯并发标记耗时加入 TruncatedSeq（alpha=0.95）→ 用于下次 IHOP 自适应预测：`pred_marking_time = _predictor->get_new_prediction(&_marking_times_s)`。

**反事实**：如果 `last_marking_time()` 用 `wall_time()`（不减 `_total_pause_time`）→ IM 到 Mixed 之间发生 3 次 Young GC（正常情况，每次 20ms=60ms）→ 纯并发标记时间被高估 60ms → 预测偏大 → IHOP 阈值被压低 → 提前启动标记 → 标记线程在堆远未满时运行，浪费 CPU。减去暂停时间让 marking time 反映"纯并发工作量"，更准确地支持 IHOP 预测。

**GDB 验证**：
```bash
(gdb) print _g1_policy->_initial_mark_to_mixed._active
期望: true (IM 后) 或 false (其他时间)
(gdb) print _g1_policy->_initial_mark_to_mixed._total_pause_time
期望: IM→Mixed 之间所有 GC 暂停累计 (秒)
(gdb) print _g1_policy->_initial_mark_to_mixed.has_result()
期望: true 仅当 IM 和 Mixed 都已记录
(gdb) print _g1_policy->_ihop_control->_marking_times_s->last()
期望: 最近一次并发标记耗时 (秒)

> **💡 12 个缺失成员的补充意义**：这 12 个成员补齐了 G1Policy 从 16 个覆盖成员到 28 个全成员的最后一环。它们的共同主题是"让预测模型有数据可喂"——`_young_gen_sizer` 给暂停预测提供尺寸边界，`_max_rs_lengths`/`_rs_lengths_prediction`/`_pending_cards` 给暂停预测提供输入数据，`_free_regions_at_end_of_collection`/`_bytes_copied_during_gc` 给暂停预测和堆扩展提供反馈指标，`_survivors_age_table` 给 tenuring threshold 提供精确快照，`_remset_tracker`/`_old_gen_alloc_tracker`/`_initial_mark_to_mixed` 给 IHOP 和 RSet 维护提供策略支持。它们大多是值对象（9/12），总额外内存约 180B——几乎零成本，但功能关键。缺失任何一个，G1 的暂停预测精度和自适应能力都会显著下降。

---
## §二 Standard Environment

### Source Roots

| 文件 | 关键行号 | 角色 |
|------|---------|------|
| `src/hotspot/share/gc/g1/g1Policy.cpp` | `:50-72` (构造), `:80-97` (init), `:849-860` (create_ihop_control) | G1Policy 主类 |
| `src/hotspot/share/gc/g1/g1Policy.hpp` | `:55-215` (成员变量) | G1Policy 类定义 |
| `src/hotspot/share/gc/g1/g1Analytics.cpp` | `:73-117` (构造, 17 个 TruncatedSeq 初始化) | G1Analytics 实现 |
| `src/hotspot/share/gc/g1/g1Analytics.hpp` | `:34-159` (成员变量 + 预测 API) | G1Analytics 类定义 |
| `src/hotspot/share/gc/g1/g1IHOPControl.hpp` | `:38-81` (基类), `:85-103` (Static), `:109-153` (Adaptive) | IHOP 控制类层次 |
| `src/hotspot/share/gc/g1/g1MMUTracker.hpp` | `:50-82` (基类), `:84-103` (QueueElem), `:107-143` (Queue) | MMU 追踪器 |
| `src/hotspot/share/gc/g1/g1MMUTracker.cpp` | `:42-142` (add_pause/when_sec/calculate_gc_time) | MMU 算法实现 |
| `src/hotspot/share/gc/g1/survRateGroup.cpp` | `:34-135` (构造/reset/record/finalize) | 存活率分组 |
| `src/hotspot/share/gc/g1/survRateGroup.hpp` | `:32-91` (成员变量) | SurvRateGroup 类定义 |
| `src/hotspot/share/gc/g1/g1GCPhaseTimes.hpp` | `:39-368` (枚举+成员+print API) | GC 阶段计时器 |
| `src/hotspot/share/gc/g1/gcPolicyCounters.cpp` | `:30-64` (构造, 6 个 PerfData 计数器) | Policy PerfData |
| `src/hotspot/share/gc/g1/g1MonitoringSupport.cpp` | `:98-225` (构造, 3+2+5 计数器) | JMX 监控支持 |
| `src/hotspot/share/gc/g1/g1MonitoringSupport.hpp` | `:117-249` (成员变量) | G1MonitoringSupport 类 |
| `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | `:1490-1582` (构造函数遗漏部分), `:2403` (_g1mm), `:2538-2550` (initialize_serviceability) | G1CollectedHeap 构造 |
| `src/hotspot/share/gc/g1/g1HeapVerifier.hpp` | `:35-121` (类定义 + G1VerifyType 枚举) | 堆验证器 |
| `src/hotspot/share/gc/g1/g1HeapSizingPolicy.hpp` | `:33-63` (类定义 + 扩展决策) | 堆大小策略 |
| `src/hotspot/share/gc/shared/copyFailedInfo.hpp` | `:32-93` (CopyFailedInfo/PromotionFailedInfo/EvacuationFailedInfo) | 复制失败信息 |
| `src/hotspot/share/gc/shared/preservedMarks.hpp` | `:36-147` (PreservedMarks/PreservedMarksSet) | Mark 保存恢复 |

### Build & Binary

```bash
make jdk-image
# 产物: build/linux-x86_64-server-release/jdk/lib/server/libjvm.so
```

### Syscall 速查表

| Syscall | man | 调用点 | 说明 |
|---------|-----|--------|------|
| `mmap` | `man 2 mmap` | PerfData 初始化 | `MAP_SHARED` 共享内存用于 jstat 读取 PerfData 计数器 |
| （本子系统不涉及直接 syscall — 纯 C++ 堆对象 + PerfData mmap 共享内存） |

### /proc 接口速查

| 路径 | man | 作用 | 本文涉及 |
|------|-----|------|---------|
| `/proc/<pid>/maps` | `man 5 proc` | 查看 PerfData mmap 区域 | G1MonitoringSupport 的 PerfData 计数器在此可见 |
| `jstat -gc <pid>` | - | 读取 PerfData 计数器 | GCPolicyCounters + G1MonitoringSupport 的计数器暴露给 jstat |

### 全局状态变量

| 变量 | 类型 | 位置 | 初始值 |
|------|------|------|--------|
| `_g1_policy->_analytics` | `G1Analytics*` | `g1Policy.hpp` | 17 个 TruncatedSeq(10) 含种子值 |
| `_g1_policy->_ihop_control` | `G1IHOPControl*` | `g1Policy.hpp` | Adaptive/Static，threshold = IHOP% × target_occupancy |
| `_g1_policy->_mmu_tracker` | `G1MMUTrackerQueue*` | `g1Policy.hpp` | 64 元素环形队列，初始空 |
| `_g1_policy->_short_lived_surv_rate_group` | `SurvRateGroup*` | `g1Policy.hpp` | 初始种子 surv_rate=0.4 |
| `_g1_policy->_phase_times` | `G1GCPhaseTimes*` | `g1Policy.hpp` | 28 Phase × ParallelGCThreads Worker 数组 |
| `_g1mm` | `G1MonitoringSupport*` | `g1CollectedHeap.hpp` | 3 Collector + 2 Gen + 5 Space Counters |
| `_verifier` | `G1HeapVerifier*` | `g1CollectedHeap.hpp:216` | 6 种验证类型位掩码 |
| `_heap_sizing_policy` | `G1HeapSizingPolicy*` | `g1CollectedHeap.hpp` | `_ratio_over_threshold_count=0` |
| `_evacuation_failed_info_array` | `EvacuationFailedInfo[]` | `g1CollectedHeap.hpp` | ParallelGCThreads 个，初始全 0 |
| `_preserved_marks_set` | `PreservedMarksSet` | `g1CollectedHeap.hpp` | `_in_c_heap=true`，空栈 |
| `_eden_pool/_survivor_pool/_old_pool` | `G1MemoryPool*×3` | `g1CollectedHeap.hpp:1501-1503` | initialize_serviceability() 后创建 |

---

## §三 Source Files Table

| # | 源文件 | 关键行号 | 角色 | 在本文讨论 |
|---|--------|---------|------|----------|
| 1 | `src/hotspot/share/gc/g1/g1Policy.cpp` | `:50-72`, `:80-97`, `:849-860` | G1Policy 构造 + init + IHOP 工厂 | §1.1 |
| 2 | `src/hotspot/share/gc/g1/g1Policy.hpp` | `:55-215` | G1Policy 类定义（28 个成员变量） | §1.1 |
| 3 | `src/hotspot/share/gc/g1/g1Analytics.cpp` | `:73-117` | G1Analytics 构造（17 个 TruncatedSeq 种子） | §1.2 |
| 4 | `src/hotspot/share/gc/g1/g1Analytics.hpp` | `:34-159` | G1Analytics 类定义 + 20 个预测 API | §1.2 |
| 5 | `src/hotspot/share/gc/g1/g1IHOPControl.hpp` | `:38-153` | IHOP 类层次（基类+Static+Adaptive） | §1.3 |
| 6 | `src/hotspot/share/gc/g1/g1MMUTracker.hpp` | `:50-143` | MMU 追踪器（基类+QueueElem+Queue） | §1.4 |
| 7 | `src/hotspot/share/gc/g1/g1MMUTracker.cpp` | `:42-142` | MMU 算法实现（add_pause/when_sec） | §1.4 |
| 8 | `src/hotspot/share/gc/g1/survRateGroup.cpp` | `:34-135` | SurvRateGroup 实现 | §1.5 |
| 9 | `src/hotspot/share/gc/g1/survRateGroup.hpp` | `:32-91` | SurvRateGroup 类定义 | §1.5 |
| 10 | `src/hotspot/share/gc/g1/g1GCPhaseTimes.hpp` | `:39-368` | G1GCPhaseTimes（28 Phase 枚举+类定义） | §1.6 |
| 11 | `src/hotspot/share/gc/g1/gcPolicyCounters.cpp` | `:30-64` | GCPolicyCounters（6 个 PerfData） | §1.7 |
| 12 | `src/hotspot/share/gc/g1/g1MonitoringSupport.cpp` | `:98-225` | G1MonitoringSupport 构造 | §1.8 |
| 13 | `src/hotspot/share/gc/g1/g1MonitoringSupport.hpp` | `:117-249` | G1MonitoringSupport 类定义 | §1.8 |
| 14 | `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | `:1490-1582`, `:2403`, `:2538-2550` | 构造函数遗漏 + _g1mm + serviceability | §1.9, §1.10, §1.11 |
| 15 | `src/hotspot/share/gc/g1/g1HeapVerifier.hpp` | `:35-121` | G1HeapVerifier 类 | §1.9 |
| 16 | `src/hotspot/share/gc/g1/g1HeapSizingPolicy.hpp` | `:33-63` | G1HeapSizingPolicy 类 | §1.9 |
| 17 | `src/hotspot/share/gc/shared/copyFailedInfo.hpp` | `:32-93` | CopyFailedInfo 层次 | §1.10 |
| 18 | `src/hotspot/share/gc/shared/preservedMarks.hpp` | `:36-147` | PreservedMarks/PreservedMarksSet | §1.9 |

---

## §四 异常路径分析

### 4.1 G1Policy 构造函数失败

如果 `new G1Analytics(&_predictor)`（`:52`）OOM → 构造函数抛出 `std::bad_alloc` → `_g1_policy` 为 NULL → `G1CollectedHeap::initialize()` 中 `:2286 g1_policy()->init()` 触发 SIGSEGV。但由于 Policy 在 G1CollectedHeap 构造的初始化列表中创建，异常会在 G1CollectedHeap 构造时传播到 `universe_init()` → `init_globals()` → `JNI_CreateJavaVM()` → 返回错误码给 Java launcher。`G1Analytics` 中 19 个 `new TruncatedSeq()` 各自可能 OOM——每个 TruncatedSeq ~56B + `_sequence` 数组 10×8B=80B = ~136B，19 个 = ~2.6KB——在正常启动中极不可能失败。

### 4.2 G1MonitoringSupport OOM

`G1MonitoringSupport` 构造函数（`g1MonitoringSupport.cpp:98-225`）创建 10 个计数器对象——每个 `new CollectorCounters` / `new HSpaceCounters` 可能因 PerfData 的 mmap(MAP_SHARED) 区域满而失败（`man 2 mmap` 返回 `ENOMEM` 或 `ENOSPC`）。`CHECK` 宏（`:145, :177` 等）在 `UsePerfData=true` 时可能抛 `OutOfMemoryError`。但 PerfData 区域通常 ~32MB（由 `PerfMemorySize` 控制），创建计数器本身只消耗几十字节的元数据——失败概率极低。

### 4.3 initialize_serviceability 注册失败

`G1MemoryPool` 的 `add_pool()` 调用 `GCMemoryManager::add_pool()` 检查 pool 是否已注册——如果重复注册会触发 `assert`。3 个 Pool 的创建（`:2539-2541`）可能 OOM——`G1OldGenPool` 构造函数调用 `MemoryPool("G1 Old Gen", ...)` 分配 ~100B 元数据。失败则 `_old_pool = NULL`，后续 `add_pool(_old_pool, false)` 访问 NULL 触发 SIGSEGV。

---

## §五 GDB 断点验证

```
断言 1: G1Policy 构造完成 (g1Policy.cpp:72 之后)
  (gdb) print _g1_policy->_analytics
  期望: 非 NULL — G1Analytics 对象指针
  (gdb) print _g1_policy->_analytics->_recent_gc_times_ms->num()
  期望: 0 (刚构造，无观测值)

断言 2: 17 个 TruncatedSeq 种子值 (g1Analytics.cpp:117 之后)
  (gdb) print _g1_policy->_analytics->_recent_gc_times_ms->avg()
  期望: 0.0 (无观测值)
  (gdb) print _g1_policy->_analytics->_concurrent_mark_remark_times_ms->avg()
  期望: 0.05 (种子值)

断言 3: IHOP 控制类型 (g1Policy.cpp:72 之后)
  (gdb) print _g1_policy->_ihop_control
  期望: 非 NULL
  (gdb) print _g1_policy->_ihop_control->get_conc_mark_start_threshold()
  期望: = IHOP% × target_occupancy

断言 4: MMU Tracker 初始状态 (g1Policy.cpp:72 之后)
  (gdb) print _g1_policy->_mmu_tracker->_no_entries
  期望: 0 (队列空)
  (gdb) print _g1_policy->_mmu_tracker->_head_index
  期望: 0

断言 5: G1MonitoringSupport 计数器 (g1CollectedHeap.cpp:2403 之后)
  (gdb) print _g1mm->_incremental_collection_counters
  期望: 非 NULL (collector.0)
  (gdb) print _g1mm->_to_counters
  期望: 非 NULL (gen.0.space.2, G1 的 Survivor)
  (gdb) print _g1mm->_from_counters->used()
  期望: 0 (S0 始终为 0)

断言 6: initialize_serviceability (g1CollectedHeap.cpp:2550 之后)
  (gdb) print _eden_pool
  期望: 非 NULL
  (gdb) print _old_pool
  期望: 非 NULL
  (gdb) print _memory_manager.num_pools()
  期望: 3

断言 7: EvacuationFailedInfo 数组 (g1CollectedHeap.cpp:1573 之后)
  (gdb) print _evacuation_failed_info_array[0]._count
  期望: 0 (刚构造，无失败)
  (gdb) print _evacuation_failed_info_array[0]._total_size
  期望: 0
```

---

## §六 总内存开销

| 组件 | 大小估算 | 说明 |
|------|---------|------|
| G1Policy | ~200B | 25 个成员（指针+值） |
| G1Predictions | ~16B | 值对象（在 Policy 内） |
| G1Analytics | ~1.2KB | 19 个 TruncatedSeq* + 对象本身 |
| 17 个 TruncatedSeq | ~2.6KB | 每个 ~136B（对象头+_sequence[10]） |
| G1MMUTrackerQueue | ~1.1KB | 64×16B 数组 + 对象头 |
| G1IHOPControl (Adaptive) | ~120B | 基类 + 2 个 TruncatedSeq 值对象 |
| GCPolicyCounters | ~324B | 6 个 PerfData 指针 + PerfData 对象 |
| G1GCPhaseTimes | ~2.7KB | 28×8B 指针 + WorkerDataArray 对象 |
| SurvRateGroup×2 | ~34KB | 动态数组（假设 100 regions） |
| G1MonitoringSupport | ~1.1KB | 10 个计数器指针 + 缓存值 |
| G1HeapVerifier | ~24B | 1 个指针 + static int |
| G1HeapSizingPolicy | ~40B | 4×size_t + 2×uint + 2×指针 |
| EvacuationFailedInfo[13] | ~572B | 13×44B |
| PreservedMarksSet | ~1KB | Padded 数组 + Stack 对象 |
| **总计** | **~43KB** | 不含 SurvRateGroup 动态扩展 |

---

## §七 Cross-Reference

- **前置**：[02-G1-Heap-Startup] — 本文是 02 的深入扩展，覆盖 02 中遗漏的 G1Policy 层和构造函数子系统
- **配套**：[09-G1-Concurrent-Marking-Infra] — G1ConcurrentMark 构造函数 + 并发精炼 + 线程创建。Policy 层（本文）负责决策"何时 GC"，Concurrent Mark 层（09）负责执行"如何标记"
- **后续**：所有 GC 运行时 Phase 依赖本文创建的 Policy 决策引擎：G1Analytics 的序列在每次 GC 后 `add()` 新观测值，G1MMUTrackerQueue 在每次 GC 后 `add_pause()`，SurvRateGroup 在每次 Young GC 后 `record_surviving_words()`

---

## §八 Mermaid 组件关系图

```mermaid
graph TB
    G1CH[G1CollectedHeap<br/>构造函数 :1508]
    G1CH -->|new| GP[G1Policy<br/>g1Policy.cpp:50-72]
    
    GP -->|new| GA[G1Analytics<br/>17 TruncatedSeq<br/>~1.2KB]
    GP -->|new| MMU[G1MMUTrackerQueue<br/>64元素环形队列<br/>~1.1KB]
    GP -->|create_ihop_control| IHOP[G1IHOPControl<br/>Adaptive/Static<br/>~120B]
    GP -->|new| SRG1[SurvRateGroup<br/>short_lived<br/>初始种子0.4]
    GP -->|new| SRG2[SurvRateGroup<br/>survivor<br/>初始种子0.4]
    GP -->|new| GCP[GCPolicyCounters<br/>6 PerfData<br/>~324B]
    GP -->|new| PT[G1GCPhaseTimes<br/>28 Phase × N Worker<br/>~2.7KB]
    GP -->|值对象| PRED[G1Predictions<br/>置信度=0.5]
    GP -->|值对象| OLD[G1OldGenAllocationTracker<br/>5×size_t]
    GP -->|值对象| RS[G1RemSetTrackingPolicy]
    
    G1CH -->|new :1551| HV[G1HeapVerifier<br/>6种验证类型位掩码]
    G1CH -->|new :1555| HSP[G1HeapSizingPolicy<br/>MinOverThresholdForGrowth=4]
    G1CH -->|new :1527| PM[PreservedMarksSet<br/>Padded数组]
    G1CH -->|NEW_C_HEAP_ARRAY :1567| EF[EvacuationFailedInfo[13]<br/>~572B]
    G1CH -->|new :2403| GMS[G1MonitoringSupport<br/>3+2+5计数器<br/>~1.1KB]
    
    G1CH -->|initialize_serviceability :2538| SP[3 G1MemoryPool<br/>Eden/Survivor/OldGen]
    SP -->|add_pool old, false| MGR[GCMemoryManager<br/>Young/Mixed]
    SP -->|add_pool| FMGR[GCMemoryManager<br/>Full GC]
    
    style GP fill:#f9f,stroke:#333,stroke-width:2px
    style GA fill:#bbf,stroke:#333
    style MMU fill:#bbf,stroke:#333
    style IHOP fill:#bbf,stroke:#333
    style GMS fill:#bfb,stroke:#333
```
