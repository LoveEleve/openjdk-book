# PROMPT: 请撰写 08-MixedGC-Policy.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**G1 Mixed GC 策略引擎 — G1Policy 如何用 liveness 数据做 CSet 选策、IHOP 自适应触发 CM、pause time 预测模型、young/mixed 交替调度**

### 核心故事线（禁止做源码翻译机！）

你已经读了 07，知道 Cleanup 结束时 `CollectionSetChooser::sort_regions()` 按 `_gc_efficiency` 降序排列了一份 Old Region 候选列表。**但有了列表不等于 Mixed GC 会立即开始**——G1Policy 还需要回答 5 个灵魂问题：

1. **下一轮 GC 是 Young-only 还是 Mixed？** `next_gc_should_be_mixed()` 怎么判定？
2. **如果做 Mixed，这轮选几个 Old Region？** `calc_default_old_cset_region_length()` 怎么基于 pause time 预测算出"还能塞几个 Old"？
3. **Mixed GC 做几轮才停？** 什么时候 `abort_time_to_mixed_tracking()`？什么时候 `clear_collection_set_candidates()`？
4. **IHOP 怎么自适应调整？** 它从 `G1YoungRemSetSamplingThread` 周期采样 RSet 大小的数据，怎么影响 CM 触发阈值？
5. **G1Analytics 预测模型如何影响每一步决策？** pause time 预测、liveness 预测、RSet size 预测分别被哪些决策消费？

**★ 和 07 的边界**：07 讲 liveness 数据的**生产端**——bitmap→live_words→marked_bytes→live_bytes→reclaimable→gc_efficiency→CSet 候选排序。本文讲 liveness 数据的**消费端**——G1Policy 如何读这些数据来做 Mixed GC 决策。07 的末尾说"候选列表就绪"，本文从这里接棒。

**★ 和 04 的边界**：04 讲了 RSet 三级结构的内部实现。本文引用的 RSet size（`rs_length`、`card_num`）来自 04 的结构，但本文**不重述**三级结构——只关心"RSet 大小作为预测模型的输入"。

**★ 和 03 的边界**：03 讲 Young GC 四阶段执行。当本文说"Mixed GC 的 Evacuation 阶段需要额外 Evacuate Old Region"时，指向 03 的 Evacuation 流程（copy_to_survivor_space），但**不重述**。

---

### 完整的故事线

```
Cleanup 完成 → CollectionSetChooser 候选列表就绪
    ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 决策引擎: G1Policy                                                   │
│                                                                     │
│ 问 1: next_gc_should_be_mixed()?                                    │
│   判定条件:                                                          │
│   (a) cset_chooser()->is_empty()? → false                           │
│   (b) remaining_reclaimable_bytes > G1HeapWastePercent×capacity?     │
│   (c) 没有正在进行的 concurrent mark?                                │
│   → 三者全满足 → set_in_young_gc_before_mixed(true)                    │
│     → 下一轮: "Pre-Mixed" Young GC（清理 Eden+Survivor）               │
│     → 再下一轮: 第一轮 Mixed GC                                        │
│                                                                     │
│ 问 2: 每轮 Mixed GC 选几个 Old Region？                               │
│   calc_default_old_cset_region_length():                             │
│     pause_target_ms = MaxGCPauseMillis                               │
│     predicted_young_time = predict_young_cset_time_ms()              │
│     remaining_time = pause_target_ms - predicted_young_time           │
│     → 预测:"剩下的时间还能 Evacuate 几个 Old Region?"                  │
│     → 从 CSetChooser 按 gc_efficiency 降序取前 N 个                    │
│     → N = 能塞下的 + 安全边际                                         │
│                                                                     │
│ 问 3: 做几轮停？                                                     │
│   每轮 Mixed GC 后：                                                 │
│   (a) 候选列表空了? → abort_time_to_mixed_tracking()                  │
│   (b) _gc_efficiency 不够? → 剩余候选的回收效率太低 → 停止             │
│   (c) 新一轮 CM 又被 IHOP 触发了? → 这轮 Mixed 是最后一轮              │
│                                                                     │
│ 问 4: IHOP 怎么自适应?                                               │
│   G1AdaptiveIHOPControl::update_allocation_info():                   │
│     每次 Young GC 后：                                               │
│       used_old_gc_end → _last_unrestrained_young_length              │
│       更新 old gen allocation rate 预测                              │
│     G1YoungRemSetSamplingThread:                                     │
│       周期采样 per-Region RSet 大小 → 更新 RSet size 趋势             │
│     → 综合 old allocation rate + marking time 预测 → IHOP 阈值调整    │
│                                                                     │
│ 问 5: G1Analytics 预测了什么?                                        │
│   predict_rs_scan_time_ms(card_num)    → CSet 大小决策               │
│   predict_object_copy_time_ms(bytes)   → CSet 大小决策               │
│   predict_young_other_time_ms(1)       → Young GC pause 预测         │
│   predict_non_young_other_time_ms(1)   → Mixed GC pause 预测         │
│   predict_old_gen_allocation_rate()     → IHOP 阈值调整               │
│   predict_marking_time_ms()             → IHOP triggering 判定        │
└─────────────────────────────────────────────────────────────────────┘
    ↓
Prepare Mixed GC → X 轮 Mixed GC → 回到 Young-only → 等待下一轮 CM
```

---

### 核心叙事线（14 个"为什么"问题，每个必须有源码回答）

**❓ 触发决策**

1. **❓ `next_gc_should_be_mixed()` 的三个判定条件各从哪来？每个条件的阈值为什么那样设？**

   **子问题**：
   (a) `cset_chooser()->is_empty()` — 候选空 → 无 Old Region 可回收 → 必须 Young-only
   (b) `remaining_reclaimable_bytes > G1HeapWastePercent × capacity` — 为什么不是 `reclaimable > 0` 而是要和 `G1HeapWastePercent` 比？因为需要 Mixed GC 的固定开销（RSet update、重建）被回收收益覆盖
   (c) ★ 如果有 concurrent mark in progress → 不能立即 mixed？因为 CM 还没结束，liveness 数据不可用
   (d) ★ `_in_young_gc_before_mixed` 标志是什么？为什么需要这个额外的 Young GC？
     → 在 Prepare Mixed 之前必须做一轮 Young GC：清理 Eden+Survivor，把 fragmented 的 old region CSet 空间腾出来

2. **❓ `record_concurrent_mark_cleanup_end()` 之后，G1Policy 的状态机发生了什么变化？**

   **子问题**：
   (a) `collector_state()->set_in_young_gc_before_mixed(true)` — 下一轮 Young GC 是"Pre-Mixed"的
   (b) `collector_state()->set_mark_or_rebuild_in_progress(false)` — CM 周期已结束
   (c) ★ `_g1h->increment_old_marking_cycles_completed(true)` 的作用？（FullGCCount_lock 通知：如果 Java 线程通过 `System.gc()+ExplicitGCInvokesConcurrent` 等待 CM 周期完成，这里会通知它）

**❓ CSet 大小决策**

3. **❓ `calc_default_old_cset_region_length()` 怎么预测"还能塞几个 Old Region"？**

   **子问题**：
   (a) `predict_young_cset_time_ms()` — 预测本轮 Young-only 部分的耗时
   (b) ★ `_pending_cards_at_gc_start` — 待处理的 dirty card 数，来源是 GC 开始时从所有 log buffers（`DirtyCardQueueSet`）汇总的 dirty card 总量。这些是 mutator 在 GC 间写入但还没被 Refine 线程处理完的 card entries。为什么这个值影响 Young GC 预测？因为 RSet 扫描时间 = card_num × 单位卡扫描时间 — 更多 pending cards = 更多 RSet 扫描。
     → 追踪来源：`G1RemSet::prepare_for_oops_into_collection_set_do()` → `DirtyCardQueueSet::apply_closure_to_all_completed_buffers()`
   (c) ★ `remaining_time = pause_target - predicted_young_time` — 如果 Young 本身预测就超过 target 了怎么办？
     → `expand_young_list_target_length()` ← ★ 函数名叫 "expand" 但实际效果是**缩减 CSet**
     → 为什么？因为 `_young_list_target_length` 是**下限值**（理想最小值），"expand" 是从下限往上调——但调整的目标是压缩实际 CSet
     → 这个命名陷阱是"为什么不能只看函数名"的经典例子
   (d) ★ 为什么不用 `_gc_efficiency` 直接算 N，而是用一个循环从 CSetChooser 顶部逐个试？
     → 因为 `predicted_time_per_region` 不是固定值——每个 Region 的 RSet 大小不同，预测耗时不同
     → 必须逐个叠加预测时间，直到累积超过 remaining_time
   (e) ★ 安全边际：`G1OldCSetRegionThresholdPercent`（默认 10%）= 预测时间×90% = 保守估计

4. **❓ `finalize_old_cset_part()` 怎么确定最终的 Old CSet？**

   **子问题**：
   (a) 从 `CollectionSetChooser` 候选列表中按排序顺序逐个取出
   (b) 每个 Region 预测的加上它后的累积时间 → 如果超出 `prediction_by_length` → break
   (c) ★ 为什么在 `add_old_region_to_cset()` 中还要 check `should_add()`？
     → 因为从 Cleanup 到真正 Mixed GC 之间，可能有 Region 状态变化（变成 pinned、live_bytes 超过阈值）
   (d) ★ 什么情况下"Mixed GC 一个 Old Region 都不选"？Young 耗时预测就已接近 pause target

**❓ Mixed GC 执行和收尾**

5. **❓ Mixed GC 和 Young GC 在执行层面有什么不同？G1Policy 怎么记录每轮的回收量？**

   **子问题**：
   (a) `record_collection_pause_end()` — 每轮结束后更新统计
   (b) `_g1h->bytes_absorbed_from_old_region()` — 我们从 Old 中 Evacuate 了多少 live_bytes
   (c) ★ 每轮 Mixed GC 后 CSetChooser 的候选列表怎么更新？`remove_from_front(n)` 移除已回收的
   (d) ★ `_collection_set->bytes_used_before()` vs `_collection_set->bytes_used_after()` — 回收效果度量
   (e) `gc_eff1 > gc_eff2 → -1` 的排序效果：高回收效率的先被 Evacuate → 第一轮 Mixed GC 回收最多

6. **❓ Mixed GC 做几轮停？三种终止条件的精确逻辑？**

   **子问题**：
   (a) **条件 1 — 候选列表空了**：`cset_chooser()->is_empty()` → `abort_time_to_mixed_tracking()` → 回到 Young-only
   (b) **条件 2 — gc_efficiency 不够**：`last_old_gc_before_restart()` — 即使候选非空，但如果剩余候选的回收效率太低（预测耗时 > 回收收益）→ 做这最后一轮 Mixed 后停
   (c) **条件 3 — 新 CM 被触发**：`gcs_are_young()` 的 override — pending 的 `set_initiate_conc_mark_if_possible(true)` → 本轮是最后一轮 Mixed
   (d) ★ 条件 2 和 3 的先后顺序：IHOP 可能在 Mixed GC 几轮之间触发新 CM → 即使还有候选，也要在 `last_old_gc_before_restart()` 返回 true → 做最后一轮 → 切回 Young-only
   (e) ★ `_initial_mark_to_mixed_tracker` 的计时作用

**❓ IHOP 自适应**

7. **❓ IHOP 阈值怎样从 `G1IHOPControl::get_conc_mark_start_threshold()` 自适应调整？**

   **子问题**：
   (a) `G1AdaptiveIHOPControl`（默认，不是 static IHOP）vs `G1StaticIHOPControl`
   (b) ★ 输入信号：
     - 每次 Young GC 后：`update_allocation_info(used_bytes, young_length, ...)` → `_last_allocation_time_s`、`_last_unrestrained_young_length`、`_allocation_rate_s`
     - G1YoungRemSetSamplingThread 周期采样 → RSet size 估计
   (c) ★ 预测逻辑（需从 `g1IHOPControl.cpp` 的 `get_conc_mark_start_threshold()` grep 验证真实公式）：
     ```
     核心思想：Old Gen 在 marking_time 期间不能被 allocation 耗空
     需要保证：old_occupied_at_start + allocation_rate × marking_time ≤ heap_capacity
     → 推导出 IHOP 阈值（Old Gen 占用的安全上限）
     ★ 注意：G1ReservePercent 是百分比（默认 10），在公式中是 fraction (=0.1)，不是字节数
     ```
   (d) ★ 为什么 adaptive 值要和 `_static_ihop_percent` 做加权折中而不是直接用 adaptive 预测值？
     → 避免 allocation rate 突变导致 IHOP 剧烈抖动，加权平均提供"软过渡"
   (e) ★ `G1ReservePercent`（默认 10%）的 headroom：总堆预留 10% → IHOP 实际上限 ~90% — 如果调到 5% 或 20% 影响什么？

8. **❓ `G1YoungRemSetSamplingThread` 怎么工作？它提供的采样数据怎样影响 IHOP？**

   **子问题**：
   (a) 采样线程的生命周期：什么时候创建、什么时候 sleep、什么时候终止？
   (b) ★ `sample_young_list_rs_length()` — 采样当前 Young List 的 RSet 总长度
   (c) ★ `G1Policy::revise_young_list_target_length_if_necessary()` — 根据采样反馈调整 Young target length
   (d) 为什么需要单独的采样线程？RSet 在 GC 之间持续变化（mutator 写入产生 new dirty cards），必须周期性采样才能看到趋势
   (e) 采样结果如何反馈给 `_analytics->report_rs_lengths()` → 影响 `predict_rs_scan_time_ms()`

**❓ G1Analytics 预测模型**

9. **❓ G1Analytics 的线性回归模型怎么工作？预测了什么、怎么被消费？**

   **子问题**：
   (a) `predict_rs_scan_time_ms(card_num)` — RSet 扫描预测
   (b) `predict_object_copy_time_ms(bytes_to_copy)` — 对象复制预测
   (c) `predict_young_other_time_ms` / `predict_non_young_other_time_ms` — 其他 overhead
   (d) ★ 每个预测如何更新？`report_rs_scan_time_ms(actual_time, card_num)` — 每次 GC 后用实际值回传更新回归模型
   (e) ★ `G1Predictions` 是什么？`get_new_prediction(seq)` → 基于 `TruncatedSeq`（衰减序列）做线性回归 → 给个数、回时间
   (f) ★ 为什么用 TruncatedSeq 而不是简单的 moving average？衰减序列对最近的 GC 给更高权重 → 快速适应 workload 变化

10. **❓ `MMUTracker` 的 pause time 预测和调度怎么影响 GC 频率？**

    **子问题**：
    (a) `add_pause(end_time, duration)` — 记录每次 GC pause
    (b) ★ `when_sec(start_time, pause_tolerance)` — "从现在开始，最早什么时候可以做下一次 GC"？
    (c) ★ 如果不断触发 GC（Young GC 太频繁），MMUTracker 会强制延迟下次 GC → 确保应用的实际停顿比例不超过目标
    (d) `GCPauseIntervalMillis`（默认 0，即不限制 GC 频率）→ 如果设非 0，强制相邻 GC 之间最小间隔
    (e) 为什么 `delay_to_keep_mmu()` 在 `run_service()` 中调用？ → CM 的 Remark 和 Cleanup 在延迟窗口之外

**❓ Young/Mixed 交替调度**

11. **❓ Young-only → Mixed → Young-only 的完整状态转换是什么？**

    **子问题**：
    (a) `_in_young_gc_before_mixed` → Next GC = Young + "这是在 Mixed 之前" → GC type = `DuringMarkOrRebuild`
    (b) Next GC = Mixed (in_mixed_phase()) → 开始选 Old CSet
    (c) `abort_time_to_mixed_tracking()` → 切回 `in_young_only_phase(true)` → 状态复位
    (d) ★ `record_young_collection_choice(bool)` — "为什么选 Young-only 而不是 Mixed？"的统计
    (e) ★ `_initial_mark_to_mixed_tracker` 的实时计时 → `print_mixed_gc_transition_stats()`

**❓ 面试层**

12. **❓ G1Policy 每分钟做多少决策？它的"大脑"模型是什么？**

    **要求**：一句话总结 G1Policy 的输入和输出，然后展开 5 个核心决策的触发时机和判定逻辑。

13. **❓ IHOP 默认 45%，为什么不是 50%？为什么不是 30%？调大或调小有什么后果？**

    **要求**：
    - 45% = `InitiatingHeapOccupancyPercent` 默认值
    - 调到 50%：CM 触发更晚 → Old 更满 → allocation rate 高时可能在 CM 完成前 Old 耗尽 → evacuation failure 风险
    - 调到 30%：CM 触发更早 → 并发标记做很多轮 → CPU 浪费，但 Old 占用量始终低
    - ★ 自适应 IHOP 怎么避免这两种极端？

14. **❓ Mixed GC 为什么能"选择性回收"？这和 Full GC 的区别在什么地方？**

    **要求**：
    - Mixed GC = Young GC + Evacuate 部分 Old Region（基于 gc_efficiency 选择）
    - Full GC = 全堆标记 + 滑动压缩（所有 Region，包括 Young+Old，一次性回收）
    - Mixed GC 每次只回收一小批 Old → pause 时间可控
    - Full GC 一次性回收所有 → pause 时间不可控（可能数百 ms 到秒）
    - Mixed GC 的前提：有准确的 liveness 数据（来自 CM）+ 排序好的候选列表

---

### 禁止行为

- ❌ 把 07 的 `_gc_efficiency` 计算再讲一遍——已经讲透了，引用即可
- ❌ 把 03 的 Young GC Evacuation 四阶段重述——Mixed GC 和 Young GC 的 Evacuation 机制相同，区别只在 CSet 组成
- ❌ 把 04 的 RSet 三级结构再说一遍
- ❌ 只说"G1Analytics 预测 pause time"——**必须回答：预测了什么、每个预测是线性回归还是别的算法、训练数据从哪来、更新频率是多少、被谁消费**
- ❌ 只说"IHOP 自适应调整"——**必须回答：输入信号有哪些、每个信号的采样频率、内部状态机、阈值调整公式**
- ❌ 把 `CollectionSetChooser::sort_regions()` 内部实现再说一遍——07 已经讲了比较器 `order_regions()`
- ❌ 把 MMUTracker 当黑箱

### 要求行为

- ✅ **★ 每节以"❓ 为什么..."开头**
- ✅ **★ 全文核心叙事线**：Cleanup 完成（候选就绪）→ G1Policy 五问决策 → Prepare Mixed → X 轮 Mixed GC → 回到 Young-only
- ✅ **★ 每条 if 语句都问"为什么"**：
  - 为什么 `remaining_reclaimable_bytes > G1HeapWastePercent × capacity` 而不是 `> 0`？
  - 为什么 IHOP 要 adaptive 而不是 static？
  - 为什么 Mixed GC 用 `calc_default_old_cset_region_length()` 的"逐个累加"策略而不是固定 N？
  - 为什么 `_in_young_gc_before_mixed` 要多做一轮 Young GC？
- ✅ **★ Mermaid 图 ≥5 张**：
  1. G1Policy 的 5 个核心决策流程图（什么时候 Young/Mixed/停止/新 CM）
  2. CSet 大小决策的详细过程（predicted_time 怎么算、怎么叠加）
  3. Mixed GC 执行序列图（Prepare → Round 1 → Round 2 → ... → back to Young-only）
  4. IHOP 自适应调整的状态机（输入信号 → 更新 → 阈值变化）
  5. G1Analytics 预测模型：预测输入-输出表 + 消费关系 Mermaid 图（拆为表+图，不要一张图塞 24 个标注）
- ✅ **★ GDB 验证 ≥7 条**：
  1. Break on `G1Policy::next_gc_should_be_mixed` → 验证三个判定条件的实际值
  2. Break on `calc_default_old_cset_region_length` → 验证 Young time 预测 + remaining time
  3. Break on `finalize_old_cset_part` → 验证逐个 Region 的累积预测时间
  4. Break on `record_concurrent_mark_cleanup_end` → 验证 `_in_young_gc_before_mixed` 标志
  5. Break on `G1AdaptiveIHOPControl::update_allocation_info` → 验证 allocation rate 更新
  6. Break on `G1Analytics::predict_rs_scan_time_ms` → 验证线性回归的输入和输出
  7. Break on `CollectionSetChooser::rebuild` → 验证候选列表的大小和排序
  8. Print `_initial_mark_to_mixed_tracker` 的状态 — 验证 CM→Mixed 的时间线
- ✅ **★ 设计替代分析 ≥3 处**：
  1. 如果没有自适应 IHOP，用 static 45% → 代价是什么？
  2. 如果 CSet 选策按 `reclaimable_bytes` 排序而不是 `gc_efficiency` → 后果？
  3. 如果 Mixed GC 不"选择部分 Old Region"而是全部 Old → 这就是 Full GC，pause 是否可控？
- ✅ **★ 面试友好**：§七 面试问题 ≥10 个
- ✅ **★ 和 07/04/03 的精确边界**：
  - 07 → 本文：Cleanup 完成（CSet 候选就绪）→ G1Policy 接管
  - 04 → 本文：RSet size（rs_length）作为 G1Analytics 的输入 — 只引用不重述
  - 03 → 本文：Mixed GC 的 Evacuation 和 Young GC 一样 — 引用 [03 §3.3] 不重述
- ✅ **★ 交叉引用精确**：gc_efficiency → [07 §六]；sort_regions → [07 §六]；RSet 结构 → [04 §三]；IHOP 触发 CM → [07 §二 2.1]；Young GC Evacuation → [03 §三]

---

### 额外要求：用"决策视角"而不是"执行视角"写作

本文和 03 最大的区别：03 是"执行视角"（GC 正式开始后，每一步做什么），本文是"决策视角"（在 GC 开始前，G1Policy 怎么决定做不做 GC、做什么类型、选几个 Region）。

> 所以全文应该像"G1Policy 是一个 AI 模型，它读取堆的状态、历史数据、RSet 采样，然后输出决策"——每节回答"为什么系统选择 X 而不是 Y"。

---

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:MaxGCPauseMillis=200`
- 默认 IHOP = 45%（自适应）
- 64 位 Linux x86
- `-XX:ConcGCThreads=2 -XX:ParallelGCThreads=4`
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

---

## 三、聚焦源文件（行号需 grep 验证）

| # | 文件 | 模块 | 核心函数/类 | 本文角色 |
|---|------|------|------------|---------|
| 1 | `g1Policy.cpp/.hpp` | gc/g1 | `next_gc_should_be_mixed()`, `calc_default_old_cset_region_length()`, `finalize_old_cset_part()`, `record_collection_pause_end()`, `abort_time_to_mixed_tracking()`, `revise_young_list_target_length_if_necessary()`, `last_old_gc_before_restart()` | ★★★ 5 决策引擎 |
| 2 | `g1CollectorState.hpp` | gc/g1 | `G1CollectorState`, `yc_type()`, `set_in_young_gc_before_mixed()`, `in_mixed_phase()` | ★★ GC 类型判定 |
| 3 | `g1IHOPControl.cpp/.hpp` | gc/g1 | `G1AdaptiveIHOPControl::update_allocation_info()`, `get_conc_mark_start_threshold()` | ★★★ IHOP 自适应 |
| 4 | `g1Analytics.cpp/.hpp` | gc/g1 | `predict_rs_scan_time_ms()`, `predict_object_copy_time_ms()`, `predict_card_num()`, `report_rs_scan_time_ms()`, `predict_alloc_rate_ms()` | ★★★ 预测模型 |
| 5 | `g1Predictions.hpp` | gc/g1 | `G1Predictions`, `get_new_prediction()` | ★★ 线性回归引擎 |
| 6 | `g1MMUTracker.cpp/.hpp` | gc/g1 | `MMUTracker`, `add_pause()`, `when_sec()` | ★★ pause 时间管理 |
| 7 | `collectionSetChooser.cpp` | gc/g1 | `rebuild()`, `sort_regions()`, `should_add()`, `remaining_reclaimable_bytes()` | ★★ 候选列表操作 |
| 8 | `g1YoungRemSetSamplingThread.cpp/.hpp` | gc/g1 | `G1YoungRemSetSamplingThread::run_service()`, `sample_young_list_rs_length()` | ★★ RSet 采样反馈 |
| 9 | `g1CollectionSet.cpp/.hpp` | gc/g1 | `G1CollectionSet`, `add_old_region()`, `bytes_used_before()`, `record_collection_pause()` | ★★ Mixed GC CSet 结构 + 构建 |
| 10 | `g1CollectedHeap.cpp` | gc/g1 | `do_collection_pause()` — policy 决策调用处 | ★★ 钩子消费 |
| 11 | `g1HeapSizingPolicy.cpp/.hpp` | gc/g1 | `G1HeapSizingPolicy`, `resize_if_necessary_after_collection()` | ★ 堆扩缩容 — 影响 Mixed 可用 Region 数 |

**辅助组件（在对应子节中简述）**：

| 组件 | 归属 | 说明 |
|------|:---:|------|
| `g1InitialMarkToMixedTimeTracker` | 08 §四 | CM→Mixed 阶段计时器，start/pause/print 全路径 |
| `TruncatedSeq` (gc/shared/) | 08 §七 | 衰减序列，G1Analytics 各预测的底层数据结构 |

---

## 四、文章结构（§〇 ~ §八 + 附录）

```
§〇 源文件清单（11 文件 + 2 辅助组件，标注模块归属 + grep 验证行号）

§一 ★ 全景 — G1Policy 的五问决策模型
  ❓ G1Policy 每轮 GC 前需要回答哪 5 个问题？
  1.1 Mermaid 1：G1Policy 五问决策流程图
  1.2 G1Policy 的数据输入全景（堆状态 + 历史统计 + RSet 采样 + 候选列表）
  1.3 和 07 的接口：07 交付了什么数据、G1Policy 怎么消费

§二 ★★★ 第一问：下一轮是 Young 还是 Mixed？
  ❓ `next_gc_should_be_mixed()` 的三条件怎么来的？
  2.1 条件 1：候选非空（`!cset_chooser()->is_empty()`）
  2.2 条件 2：回收量超 waste 阈值（`reclaimable > G1HeapWastePercent × capacity`）
     ★ 设计替代：如果不设 waste 阈值，会频繁 Mixed GC 回收少量垃圾 → 浪费 CPU
  2.3 条件 3：无正在进行的 concurrent mark
  2.4 ★ 为什么需要 `_in_young_gc_before_mixed`？Why not skip to Mixed directly？
  2.5 ★ 设计替代：如果 Cleanup 完直接做 Mixed 而不先做一轮 Young-only → 后果？
  2.6 ★ "Prepare Mixed" 这轮 Young GC（`_in_young_gc_before_mixed=true`）和普通 Young GC 的区别：
     它为后续 Mixed GC 准备了什么？为什么 GC type 是 `DuringMarkOrRebuild` 而不是 `Normal`？
     在这轮中，除了正常 Evacuate Eden/Survivor，是否还做了 RSet 相关的准备工作？
  2.8 状态转换：`record_concurrent_mark_cleanup_end()` 源码走读
  2.9 ★ `G1HeapSizingPolicy::resize_if_necessary_after_collection()` — 堆扩缩容怎么影响 Mixed GC 可用 Region 数？

§三 ★★★ 第二问：每轮 Mixed GC 选几个 Old Region？
  ❓ `calc_default_old_cset_region_length()` 怎么动态计算 N？
  3.1 Mermaid 2：CSet 大小决策详细流程
  3.2 预测 Young 部分耗时：`predict_young_cset_time_ms()` 完整公式
  3.3 ★ `remaining_time = pause_target - predicted_young_time` — 用了哪几个 G1Analytics 预测？
  3.4 ★ 如果 Young 部分预测就超时怎么办？→ `expand_young_list_target_length()` 缩小 Young CSet
  3.5 ★ 为什么"从 CSetChooser 顶部逐个试"而不是一次算出 N？
     → 每个 Old Region 的 predicted_time 不同 → 必须逐个叠加
  3.6 ★ 安全边际：`G1OldCSetRegionThresholdPercent=10%` — 为什么保守 10%？
  3.7 `finalize_old_cset_part()` — 最终确定 Old CSet 的源码走读
  3.8 ★ 简述 `G1CollectionSet` 内部数据结构（<50 行）：
     `_collection_set_regions` 怎么存？`eden_region_length/survivor_region_length/old_region_length` 三区怎么分？
     → 缺少这个背景，`add_old_region_to_cset()` 的源码会变成"悬浮代码"——读者不知道 Region 被加入后存在哪

§四 ★★ 第三问：Mixed GC 做几轮？三种终止条件
  ❓ 什么时候 `abort_time_to_mixed_tracking()`？
  4.1 条件 1：候选空 — `cset_chooser()->is_empty()`
  4.2 ★ 条件 2：gc_efficiency 太低 — `last_old_gc_before_restart()` 怎么判断？
     → （需从源码 grep 验证）依赖于两个 G1Analytics 预测值的比较：
       `predicted_old_region_evacuation_time_ms` vs `time_remaining_ms`
       — 如果预测的 Old Evacuation 耗时超过剩下的 pause budget → 这是最后一轮 Mixed
  4.3 ★ 条件 3：新 CM 被触发 — IHOP 在 Mixed GC 期间判定 `set_initiate_conc_mark_if_possible(true)`
  4.4 ★ 三个条件之间的优先级和相互影响（如果同时满足呢？）
  4.5 Mermaid 3：Mixed GC 序列 —— Prepare → Round 1 → Round 2 → ... → termination → Young-only
  4.6 ★ `G1InitialMarkToMixedTimeTracker` — 从 Initial Mark 到 Mixed 结束的完整计时统计（start 在哪？pause 在哪？print 何时调用？）

§五 ★★★ 第四问：IHOP 怎么自适应调整 CM 触发阈值？
  ❓ 从哪些输入信号推导 IHOP 阈值？为什么自适应值要和 static 值"软过渡"？
  5.1 `G1AdaptiveIHOPControl` vs `G1StaticIHOPControl` — 自适应的必要性
  5.2 输入信号逐个分析：
     (a) Young GC 后 `update_allocation_info(used_bytes, young_length, ...)` — old gen occupancy 变化
     (b) `_allocation_rate_s` 的更新模型
     (c) `_last_unrestrained_young_length` 的作用
  5.3 ★ 预测逻辑推导（需从源码 grep 验证真实公式）：
     核心思想：Old Gen 在标记期间不能被 allocation 耗空
     ★ 注意：G1ReservePercent 是百分比（默认 10），在公式中是 fraction (=0.1)
  5.4 ★ G1ReservePercent（10%）的 headroom 设计 — 如果调成 5% 或 20%，影响什么？
  5.5 ★ 设计替代：static IHOP=45% 在 allocation_rate 波动大的 workload 下会出什么问题？
  5.6 `get_conc_mark_start_threshold()` 的完整源码走读

§六 ★★ 第五问（铺垫）：G1YoungRemSetSamplingThread 怎么反馈 IHOP？
  ❓ 采样线程的周期是多少？采样数据怎样进入 G1Analytics 和 IHOP？
  6.1 采样线程的 `run_service()` 周期
  6.2 ★ `sample_young_list_rs_length()` — 采样了什么、采样频率多少
  6.3 ★ `revise_young_list_target_length_if_necessary()` — RSet 大小反馈到 Young target length
  6.4 为什么这个线程是 daemon？需要 `SuspendibleThreadSet` 吗？

§七 ★★ G1Analytics 预测模型全貌
  ❓ 每个预测是线性回归还是别的算法？训练数据从哪来？更新频率？被谁消费？
  7.1 Mermaid 4：G1Analytics 预测架构（每个预测的 input/output/模型/消费方）
  7.2 ★★ `TruncatedSeq` — 三参数深度分析：
     (a) `_length` — 历史样本容量（默认多少？）
     (b) `_alpha` — 指数衰减因子（值多少？怎么影响权重衰减函数？）
     (c) `davg()` 的衰减指数平均公式（给出精确公式，不是文字描述）
     (d) 为什么用 `davg()` 而不是简单 moving average 或 raw maximum？
       → `davg()` 对新数据给更高权重，旧数据的权重指数衰减
       → 快速适应 workload 变化（如 allocation rate 突变、RSet 大小剧变）
  7.3 ★ `G1Predictions::get_new_prediction(seq)` — 基于 `TruncatedSeq` 做线性回归的具体计算（输入是 seq→davg()？还是原始序列？回归系数是什么？）
  7.4 ★ 每个 `report_xxx()` 的调用时机 — 回传训练数据
  7.5 ★ 为什么用衰减序列而不是简单 moving average？快速适应 workload 变化
  7.6 `predict_card_num(rs_length, for_young_gc)` — 为什么 Young 和 non-Young 的预测不同？

§八 MMUTracker — pause time 目标追踪
  ❓ MMUTracker 如何追踪历史 pause 时间？怎么决策"最早什么时候做下一次 GC"？
  8.1 `add_pause(end_time, duration)` — 记录实时 GC pause
  8.2 ★ `when_sec(start_time, pause_tolerance)` — 决策"最早什么时候做下一次 GC"
  8.3 ★ `GCPauseIntervalMillis` 和 MMU 约束的相互作用
  8.4 为什么 `delay_to_keep_mmu()` 在 `run_service()` 中但不在 Young GC 中？
  8.5 ★ 设计替代：如果没有 MMUTracker，超频繁 Young GC 会导致什么？

§九 面试问题合集 ≥10 个
  Q1: G1Policy 是怎么决定做 Young-only 还是 Mixed GC 的？
  Q2: IHOP=45% 为什么是这个值？调大调小有什么后果？
  Q3: Mixed GC 每轮选几个 Old Region？怎么确定的？
  Q4: Mixed GC 做几轮停？什么条件触发停止？
  Q5: G1Analytics 预测了什么？每个预测怎么用？
  Q6: 自适应 IHOP 和静态 IHOP 的区别？为什么需要自适应？
  Q7: Mixed GC 和 Full GC 的区别在什么地方？为什么 Mixed GC 能"选择性回收"？
  Q8: 为什么 CSetChooser 排序后的候选和每轮 Mixed 实际选的 Region 不是一回事？排序是第一关，pause time 预测是第二关。
  Q9: `_in_young_gc_before_mixed` 为什么不能跳过，直接做 Mixed？
  Q10: MMUTracker 怎么保证应用的实际停顿比例不超过目标？
  Q11: G1YoungRemSetSamplingThread 做什么？它的采样结果怎么反馈给 G1Policy？

§十 GDB 验证 + 可证伪断言（≥7 条）
  断言 1: `next_gc_should_be_mixed()` 的三个条件
  断言 2: `calc_default_old_cset_region_length()` 的预测计算
  断言 3: Mixed GC 的候选列表变化
  断言 4: IHOP 自适应阈值更新
  断言 5: `G1Analytics::predict_rs_scan_time_ms` 的线性回归
  断言 6: `CollectionSetChooser::rebuild()` 的排序结果
  断言 7: `_initial_mark_to_mixed_tracker` 的状态
  断言 8: MMUTracker 的 pause 时间统计

§十一 附录：关键 GDB 断点 + GC log 示例
```

---

## 五、交叉引用

| 引用点 | 本文位置 | 目标文档 | 内容简述 |
|--------|---------|---------|---------|
| `_gc_efficiency` 计算 | §三 | `[07 §六]` | reclaimable_bytes / predicted_time |
| `CollectionSetChooser::sort_regions()` | §三 | `[07 §六]` | order_regions 比较器 |
| `record_concurrent_mark_cleanup_end()` | §二 | `[07 §六]` | CSet 候选重建入口 |
| `set_initiate_conc_mark_if_possible` | §四 | `[07 §二 2.1]` | IHOP → CM 触发 |
| `remark()` 中的 `compute_new_sizes()` | §二 | `[07 §五]` | 堆扩缩容判定 |
| RSet 三级结构 | §六 | `[04 §三]` | Sparse/Fine/Coarse |
| Young GC Evacuation | §三 | `[03 §三]` | copy_to_survivor_space 流程 |
| PLAB 分配 | §三 | `[10-PLAB §X]` | GC worker 本地缓冲 |
| Reference Processing | §四 | `[11 §X]` | Mixed GC Phase 3 引用处理 |

---

## 六、写作要求

1. **★ 每节以"❓ 为什么..."开头**
2. **★ 决策视角而非执行视角**：G1Policy 是决策引擎，不是执行引擎
3. **★ 每个 if 语句都问"为什么"** — 不只要说"条件 A → 做 B"，还要说"为什么是 A 不是 A'？"
4. **★ 设计替代分析 ≥3 处**
5. **★ 可证伪断言 ≥7 条**（含 GDB 命令 + 预期输出）
6. **★ Mermaid 图 ≥5 张**
7. **★ 源文件行号全部 grep 验证后再写**
8. **★ 面试友好**：§九 面试 ≥10 个
9. **★ 和 07/04/03 的边界**：07 生产数据 → 本文消费数据；04 提供 RSet size → 本文用做预测输入；03 提供 Evacuation 机制 → 本文说 Mixed GC 额外 Evacuate Old Region

---

## 七、输出格式

- Markdown 文件，命名为 `08-MixedGC-Policy.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 元信息头：标准环境 + 源文件清单（11 文件，行号 grep 验证）+ 前置依赖（必须已读 07/03/04；建议了解 06/05/01）+ 阅读收益
- 阅读收益强调：读完本文后能回答"G1Policy 是怎么做 GC 决策的？什么时候做 Young GC？什么时候 Mixed？每轮 Mixed 选几个 Old Region？IHOP 怎么从 45% 自适应调整？G1Analytics 的线性回归模型预测了什么？MMUTracker 怎么保证 pause 时间目标？"——G1 的全局 GC 决策引擎的每一笔输入和每一个输出都了然于胸
