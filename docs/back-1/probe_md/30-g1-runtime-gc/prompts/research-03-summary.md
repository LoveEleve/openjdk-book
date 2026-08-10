# Phase 30 doc-03 分析汇总：Mixed GC + Policy Decision Engine

## 范围
CSet 选择 + Mixed GC 执行 + IHOP/MMUTracker 自适应 + Evac Failure 处理

## 源文件和符号（scout-4 定位，含方法名纠正）

### 核心文件
- g1Policy.hpp/cpp (1324行) — 决策引擎核心
- g1Analytics.hpp/cpp (~500行) — 预测模型（衰减平均）
- g1IHOPControl.hpp/cpp (~300行) — IHOP 自适应
- g1CollectorState.hpp (~100行) — Young Only↔Mixed 状态机
- collectionSetChooser.hpp/cpp (~200行) — CSet 排序/选择
- g1CollectionSet.hpp/cpp (~250行) — CSet 管理
- g1HeapSizingPolicy.hpp/cpp (~200行) — 堆大小自适应
- g1MMUTracker.hpp/cpp (~200行) — 暂停时间追踪
- g1EvacFailure.hpp/cpp (~263行) — 疏散失败恢复
- evacuationInfo.hpp (~80行) — 疏散统计

### 方法名纠正（重要！）
- record_young_collection_end() → record_collection_pause_end() (g1Policy.cpp:643)
- should_continue_mixed_GC_set() → 逻辑在 next_gc_should_be_mixed() (g1Policy.cpp:1216)
- predict_mixed_other_time_ms() → predict_non_young_other_time_ms() (g1Analytics.cpp:314)
- resize() → expansion_amount() (g1HeapSizingPolicy.cpp:50)

### 关键符号
- record_collection_pause_end (g1Policy.cpp:643)
- next_gc_should_be_mixed (g1Policy.cpp:1216)
- finalize_collection_set → finalize_old_part (g1CollectionSet.cpp:464)
- record_concurrent_mark_cleanup_end (g1Policy.cpp:1110)
- get_conc_mark_start_threshold (g1IHOPControl.cpp:126)
- CollectionSetChooser::rebuild + sort_regions (collectionSetChooser.cpp:305,124)
- MMUTracker::add_pause + when_sec (g1MMUTracker.cpp:80,117)

## 实现细节（reader-4 提取）

### next_gc_should_be_mixed 判定条件
1. cset_chooser()->is_empty() → false: 候选为空则直接拒绝
2. reclaimable_percent <= G1HeapWastePercent → false: 剩余可回收空间≤垃圾阈值(5%)

### finalize_old_part 按 gc_efficiency 选取
1. 算边界: calc_min/max_old_cset_length
2. 循环 peek+pop Chooser 中按 gc_efficiency 降序排列的候选
3. 终止条件: (1)达上限 (2)reclaimable%不够 (3)时间超预算且达下限 (4)候选耗尽
4. 强行添加: 预测超预算但未达 min_old_cset_length 仍添加

### record_collection_pause_end 更新 14 个 TruncatedSeq
按序: alloc_rate → pause_times → cost_per_card → cost_per_entry → cost_per_byte
  → young_other_per_region → non_young_other_per_region → constant_other_time
  → pending_cards → rs_lengths → young_list → ihop_prediction → concurrent_refine

### IHOP 自适应公式
threshold = actual_threshold - (pred_marking_time × pred_promotion_rate + young_size)
actual_threshold = target_occupancy × (100 - heap_waste%) / 100
pred_marking_time = davg + sigma × stddev (衰减平均+置信加权)

### Phase 状态流转
Young-Only → need_to_start_conc_mark → initiate_conc_mark → Initial Mark GC
  → 并发标记 → record_concurrent_mark_cleanup_end → set_in_young_gc_before_mixed
  → 下一次GC: set_in_young_only_phase(false) → Mixed
  → 每次Mixed后: next_gc_should_be_mixed? → YES继续/NO回Young-Only

## 调用链（tracer-3 提取）

### Mixed GC 决策链
cleanup → record_concurrent_mark_cleanup_end → Chooser::rebuild + next_gc_should_be_mixed
  → set_in_young_gc_before_mixed → (下次pause) record_collection_pause_end → set_in_mixed_phase

### IHOP 闭环
record_collection_pause_end 同时调用:
  update_ihop_prediction (更新模型) + maybe_start_marking (基于新阈值做决策)

### need_to_start_conc_mark 4 个调用者
maybe_start_marking (常规) + attempt_allocation_humongous + 
attempt_allocation_at_safepoint + record_full_collection_end
