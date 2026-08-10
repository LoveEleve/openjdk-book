# PROMPT: 请撰写 03-Mixed-GC-Policy.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**故障**: 线上 8GB 堆 G1，Old Gen 使用率从 45% 涨到 85%，`jstat -gcutil <pid> 1000` 显示 Mixed GC 持续触发但 FGC 计数（FGC: 列）也在增长。`-XX:+PrintGCDetails` 日志显示：

```
[GC pause (G1 Evacuation Pause) (mixed), 0.1234567 secs]
   [Eden: 512.0M(512.0M)->0.0B(512.0M) Survivors: 64.0M->64.0M Heap: 6.5G(8.0G)->6.2G(8.0G)]
 [GC concurrent-mark-end, 0.0012345 secs]
 [GC pause (G1 Evacuation Pause) (mixed), 0.0987654 secs]
   [Eden: 512.0M(512.0M)->0.0B(512.0M) Survivors: 64.0M->64.0M Heap: 6.1G(8.0G)->5.9G(8.0G)]
```
Mixed GC 回收量递减 (6.5→6.2→6.1→5.9)，但 Old Gen 仍然 55%+。每次 Mixed GC 只选 2-3 个 Old region 却还有 15-20 个候选 (`G1NumberOfOldRegionsToPrint=20`)。

**三步诊断**:
```bash
# 1. 查看 GC 效率
jstat -gcutil <pid> 1000 | awk '{print $1, $4, $5, $9}'
# 关注: OU (Old Used) 下降速率 vs Mixed GC 次数
# 若 OU/GC < 5% → Mixed GC 效率不足

# 2. GDB 检查 G1Policy 决策变量
gdb -ex "break g1Policy.cpp:1216" \
    -ex "run" \
    -ex "print _g1->collection_set()->candidates()->num_regions()" \
    -ex "print _g1->collection_set()->bytes_used_before()" \
    --args java -jar app.jar
# 期望: candidates 数量 vs 实际选择数量差异

# 3. GC 日志分析 IHOP 触发点
rg "humongous" gc.log | tail -20
rg "to-space exhausted" gc.log
# 异常: IHOP=45 却已经 85% Old Gen 才启动 marking → 标记跟不上分配
```

**反事实**: 如果 G1 没有 IHOP 自适应，所有部署都用固定的 `-XX:InitiatingHeapOccupancyPercent=45` → 大堆 (64GB) 标记太早浪费 CPU，小堆 (2GB) 标记太晚来不及 → Full GC 概率上升。如果 Mixed GC 没有 `next_gc_should_be_mixed` 终止条件 → Mixed GC 无限循环直到堆空 → 暂停时间无上界 → SLA 违约。如果 CSetChooser 不按 gc_efficiency 排序而按 reclaimable bytes 排序 → 可能先选回收量大的 region 但其中大部分对象仍 live → 复制成本高但回收少 → 暂停超时。

---

## §一 Task + Narrative + Beginner Callouts

### Task

撰写 `03-Mixed-GC-Policy.md`，深度分析 G1 的 Mixed GC 执行全链路和策略决策引擎。重心在**运行时决策循环**：从 Concurrent Mark Cleanup 后 CSet 选择 → 按 gc_efficiency 排序 → Mixed GC 逐次执行 → next_gc_should_be_mixed 终止判定 → Young-Only 回退 — 以及 IHOP 自适应预测何时启动下一轮标记。

读者已完成 Phase 01 的 `08-G1-Policy-Analytics` (1403行，G1Policy 8 子组件初始化、Analytics 17 个 TruncatedSeq 创建、IHOP 控制) 和 `09-G1-Concurrent-Marking-Infra` (720行，G1ConcurrentMark 构造、双 Bitmap + CMTask×13)。本文聚焦"所有基础设施已就绪"后，Policy 如何**运行时决策**每次 GC 的类型、Mixed GC 如何选择 CSet、IHOP 如何自适应预测。

### Narrative

"Concurrent Mark 的 Cleanup 阶段结束后，G1Policy::record_concurrent_mark_cleanup_end 被调用。它做三件事：① CollectionSetChooser::rebuild 将 clean cards bytes 计算存活率，按 gc_efficiency = reclaimable / survivable bytes 排序 old region；② next_gc_should_be_mixed 决定下次 GC 是否进入 Mixed 模式——条件是 Chooser 非空且剩余可回收空间 > G1HeapWastePercent(5%)；③ 如果通过，set_in_young_gc_before_mixed 将状态设为"InNextYoungGc"。下一次 Young GC 的 record_collection_pause_end 看到此状态，切换到 Mixed 模式：finalize_old_part 从 Chooser 中按 gc_efficiency 降序弹出 candidate region 加入 CSet，每次 Mixed GC 有一个时间预算（predicted_young_time + predicted_mixed_time ≤ pause_target）。每轮 Mixed GC 后重新调用 next_gc_should_be_mixed 检查是否继续。当条件不满足（候选耗尽或 reclaimable% ≤ waste threshold），状态切换回 Young-Only。这个决策链背后是 14 个 TruncatedSeq 支撑的 Analytics 预测模型——衰减平均 (davg + sigma×stddev) 预测每次 pause time, card scan cost, evacuation cost。IHOP 自适应用同样的衰减平均模型预测 marking start threshold = target_occupancy × (100 - heap_waste%) / 100 - (pred_marking_time × pred_promotion_rate + young_size)。若实际 threshold < 静态配置，IHOP 提前启动 marking——这是 G1 '自适应'的核心。"

### Interview Story Format Answer（必须出现在 §一 末尾）

"G1 的 Mixed GC 不是一次性回收所有 old region——它是渐进式的。Concurrent Mark 结束后，CSetChooser::rebuild (collectionSetChooser.cpp:305) 遍历所有非空的 old region，计算每个的 gc_efficiency = (reclaimable_bytes / non_reclaimable_bytes)。sort_regions (collectionSetChooser.cpp:124) 按这个比率降序排列——效率高的先选。finalize_old_part (g1CollectionSet.cpp:464) 在每次 Mixed GC 的 pause 开始时从 Chooser 头部弹出 candidate：先计算 min/max_old_cset_length — min 由 G1MixedGCLiveThresholdPercent(85%) 决定，max 由时间预算决定。循环弹出直到四个终止条件之一触发：(1)达到 max 上限、(2)累计 reclaimable% 已低于 G1HeapWastePercent、(3)预测暂停时间超预算且已达 min、(4)Chooser 耗尽。每次 Mixed GC 后 record_collection_pause_end (g1Policy.cpp:643) 更新 14 个 TruncatedSeq——按序: alloc_rate → pause_times → cost_per_card → cost_per_entry → cost_per_byte → young_other → non_young_other → constant_other_time → pending_cards → rs_lengths → young_list → ihop_prediction → concurrent_refine → 最终调用 next_gc_should_be_mixed (g1Policy.cpp:1216) 决定是否继续 Mixed 模式。IHOP 自适应 get_conc_mark_start_threshold (g1IHOPControl.cpp:126) 用公式: threshold = actual_threshold - (pred_marking_time_sec × pred_promotion_rate_bytes_per_ms + young_size)。pred_marking_time 来自 g1Analytics 的 davg + sigma × stddev 衰减平均。如果标记跟不上分配(new allocation during marking > threshold 余量)，IHOP 在下一轮提前启动—这形成了一个自我纠正的反馈环。"

### Beginner Callout Boxes（文档中必须出现的 ≥7 个 callout 框）

> **Mixed GC vs Young GC**: Young GC 只疏散 Eden + Survivor 到 Survivor/Old region——CSet 全由 young region 组成。Mixed GC 在 Young GC 基础上增加部分 old region——CSet 包含所有 young region + CSetChooser 选择的 old region。Mixed GC 的"mixed"指 CSet 中 young + old 混合，而非 GC 算法混合。两种暂停都走同一条 `do_collection_pause_at_safepoint()` 代码路径，区别仅在于 CSet 内容和 `g1CollectorState::is_mixed()` 分支。

> **gc_efficiency (回收效率)**: `gc_efficiency = reclaimable_bytes / predicted_evacuation_time`。reclaimable_bytes = region used - region live (由 concurrent mark liveness 计算)。predicted_evacuation_time = predicted_copy_time + predicted_card_merge_time。这个公式优化的是"单位时间的回收量"——选效率高的 region 意味着用最少暂停时间回收最多空间。如果按 pure reclaimable bytes 排序，可能先选 100MB 的 huge region 但其中 95MB 是 live (5MB 回收)，后选 10MB 但 9MB 垃圾的 region (9MB 回收)——前者暂停时间长但回收少。

> **TruncatedSeq 衰减平均 (Decaying Average)**: `TruncatedSeq` 是 G1 的核心统计结构——保留最近 N 次采样的环形缓冲区（通常 N=5-10）。davg (衰减平均) = 新值 × α + 旧平均 × (1-α)，α 默认 0.7 (G1ConfidencePercent/100)。这给最近样本更大权重——快速适应模式变化 (如 allocation rate 突变)，同时保留历史趋势。`predict()` = davg + σ × stddev，其中 σ = 1.0 (G1ConfidencePercent as sigma)。这提供的是"乐观估计 + 一个标准差的安全边际"——预测值比平均值高一个标准差，减少低估暂停时间的概率。

> **G1HeapWastePercent (5%)**: Mixed GC 不是因为"还有垃圾"就继续——当剩余可回收空间 < heap_size × G1HeapWastePercent/100 时，next_gc_should_be_mixed 返回 false。理由是：继续 Mixed GC 的成本（暂停时间、复制 live object）超过回收收益——剩下的垃圾会在下一轮 concurrent mark 后作为"free region"被 Cleanup 直接回收，无需 Mixed GC 逐对象复制。5% 是平衡点：太高 → Mixed GC 过早停止、Full GC 风险上升；太低 → Mixed GC 多轮、总暂停时间增加。

> **MMUTracker 暂停预测**: `G1MMUTracker` (g1MMUTracker.cpp) 维护一个 64 元素的环形队列 (`G1MMUTrackerQueueElem`)，每个元素记录一次 GC pause 的 `(start_time, end_time)`。`add_pause()` (g1MMUTracker.cpp:80) 追加新暂停——队列满时滑动窗口覆盖最旧的。`when_sec(current_time, desired_pause_length)` (g1MMUTracker.cpp:117) 预测从现在起何时可以插入一个长度为 desired_pause_length 的暂停——基于滑动窗口内的历史暂停间距计算。原理: 如果过去 N 次暂停间距约 2s，则回答 ~2s。用于 `report_mmu_if_needed` 和 G1 的 pause time budget 计算。

> **疏散失败恢复 (Evac Failure Recovery)**: Young/Mixed GC 中如果 to-space 没有足够空间复制对象（survivor region 满、free region 耗尽），`G1ParScanThreadState::copy_to_survivor_space` 中的 CAS forwarding pointer 失败→ 转换为 self-forwarded pointer (对象 header 的 forwarding pointer 指向自己)。恢复阶段 `remove_self_forwarding_pointers()` (g1EvacFailure.cpp:100) 遍历所有 self-forwarded 对象，清除 forwarding pointer，将对象标记为 pinned（不移动），原地保留在 from-region。这种对象在下次 GC 仍可通过 RSet 追踪到（保留原始地址）。关键约束: 疏散失败后 CSet 中原计划回收的 region 不能直接 free——它们仍包含 live object → 这些 region 晋升为 old region 等待下次 Mixed/Full GC。

> **Phase 状态机 (g1CollectorState)**: G1 的收集状态由 `G1CollectorState` (g1CollectorState.hpp) 管理，主要状态: `YoungOnly` → 纯 Young GC 模式；当 `need_to_start_conc_mark()` 为 true → `InitiateConcMark` → 下个 Young GC 变成 Initial Mark GC → 并发标记完成后 `set_in_young_gc_before_mixed()` → 状态为 `DuringMarking` (中间态) → 下次 GC 切换: `set_in_young_only_phase(false)` → `Mixed`；每次 Mixed GC 后 `next_gc_should_be_mixed()` 判定 → 继续 Mixed 或 `set_in_young_only_phase(true)` → 回 `YoungOnly`。整个周期: YoungOnly → InitiateConcMark → DuringMarking → YoungOnly(过渡) → Mixed → YoungOnly。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux (TencentOS Server 4.2)。

Source roots:
- `src/hotspot/share/gc/g1/g1Policy.hpp/cpp` — 决策引擎核心 (:329/:1324 行)
- `src/hotspot/share/gc/g1/g1Analytics.hpp/cpp` — 预测模型衰减平均 (:219/:500+ 行)
- `src/hotspot/share/gc/g1/g1IHOPControl.hpp/cpp` — IHOP 自适应控制 (:120/:300+ 行)
- `src/hotspot/share/gc/g1/g1CollectorState.hpp` — Young Only↔Mixed 状态机 (:100+ 行)
- `src/hotspot/share/gc/g1/collectionSetChooser.hpp/cpp` — CSet 排序/选择 (:90/:200+ 行)
- `src/hotspot/share/gc/g1/g1CollectionSet.hpp/cpp` — CSet 管理 + finalize_old_part (:130/:250+ 行)
- `src/hotspot/share/gc/g1/g1HeapSizingPolicy.hpp/cpp` — 堆大小自适应 expansion_amount (:80/:200+ 行)
- `src/hotspot/share/gc/g1/g1MMUTracker.hpp/cpp` — 暂停时间 64 元素环形追踪 (:100/:200+ 行)
- `src/hotspot/share/gc/g1/g1EvacFailure.hpp/cpp` — 疏散失败 Self-forwarded 恢复 (:90/:263 行)
- `src/hotspot/share/gc/g1/evacuationInfo.hpp` — 疏散统计 (:80 行)
- `src/hotspot/share/gc/g1/g1InitialMarkToMixedTimeTracker.hpp` — 时间追踪 (:60 行)
- `src/hotspot/share/gc/g1/g1YoungGCTraceTime.hpp` — 日志追踪 (:50 行)

Build: `make hotspot`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so`

Syscall 速查表:
| syscall | man 页面 | 用途 | 调用位置 |
|---------|---------|------|---------|
| `futex` | `man 2 futex` | Safepoint 同步、Monitor 锁 | SafepointSynchronize::block() |
| `clock_gettime` | `man 2 clock_gettime` | Pause time 计时 | os::elapsedTime() |
| `sched_yield` | `man 2 sched_yield` | GC 线程自旋让步 | os::naked_yield() |
| `mmap` | `man 2 mmap` | Region 按需 commit | G1RegionToSpaceMapper |
| `munmap` | `man 2 munmap` | Region uncommit (heap sizing down) | HeapRegionManager |

/proc 接口:
| 接口 | 内容 | 诊断价值 |
|------|------|---------|
| `/proc/<pid>/maps` | mmap 映射表 | 验证 heap expansion 后新 region 的 mmap 段出现 |
| `/proc/<pid>/smaps` | 映射详情 + RSS | 检查 uncommit 后 RSS 是否释放(Pss=0) |

JVM 全局状态:
| 变量 | 类型 | 位置 | 诊断价值 |
|------|------|------|---------|
| `_g1h->_collector_state` | `G1CollectorState` | g1CollectedHeap.hpp | 当前 Phase 状态 (YoungOnly/Mixed/DuringMarking) |
| `_policy->_analytics` | `G1Analytics` | g1Policy.hpp | 14 个 TruncatedSeq 当前值 |
| `_policy->_ihop_control` | `G1IHOPControl` | g1Policy.hpp | IHOP 自适应 vs Static 当前阈值 |
| `_policy->_mmu_tracker` | `G1MMUTracker` | g1Policy.hpp | 64 元素暂停历史环形队列 |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **g1Policy.cpp** | `src/hotspot/share/gc/g1/g1Policy.cpp` | ~1324 | `record_collection_pause_end`(:643), `next_gc_should_be_mixed`(:1216), `record_concurrent_mark_cleanup_end`(:1110), `maybe_start_marking`(:847) | **决策枢纽** — 所有运行时 GC 决策的汇聚点 |
| 2 | **g1Analytics.cpp** | `src/hotspot/share/gc/g1/g1Analytics.cpp` | ~500 | `report_rs_lengths`(:150), `report_alloc_rate`(:120), `predict_non_young_other_time_ms`(:314), `compute_pause_time_ratio` | **预测引擎** — 14 个 TruncatedSeq 衰减平均 + davg+sigma×stddev |
| 3 | **g1IHOPControl.cpp** | `src/hotspot/share/gc/g1/g1IHOPControl.cpp` | ~300 | `get_conc_mark_start_threshold`(:126), `update_marking_length`(:160), `update_allocation_info`(:140) | **IHOP 自适应** — 动态计算标记启动阈值 |
| 4 | **g1CollectorState.hpp** | `src/hotspot/share/gc/g1/g1CollectorState.hpp` | ~100 | `set_in_young_only_phase`, `set_initiate_conc_mark`, `set_in_mixed_phase`, `in_young_only_phase`, `in_mixed_phase` | **状态机** — YoungOnly/Mixed/DuringMarking 切换 |
| 5 | **collectionSetChooser.cpp** | `src/hotspot/share/gc/g1/collectionSetChooser.cpp` | ~200 | `rebuild`(:305), `sort_regions`(:124), `peek`(:?), `pop`(:?), `is_empty`(:?) | **CSet 选择器** — 按 gc_efficiency 排序 + 迭代器弹出 |
| 6 | **g1CollectionSet.cpp** | `src/hotspot/share/gc/g1/g1CollectionSet.cpp` | ~250 | `finalize_old_part`(:464), `calculate_optional_region_target`(:?), `add_old_region`(:?) | **CSet 管理** — 时间预算内的 old region 选取 |
| 7 | **g1HeapSizingPolicy.cpp** | `src/hotspot/share/gc/g1/g1HeapSizingPolicy.cpp` | ~200 | `expansion_amount`(:50), `shrink_amount`(:?), `can_shrink`(:?) | **堆大小自适应** — GC overhead 阈值判定 + scale_factor |
| 8 | **g1MMUTracker.cpp** | `src/hotspot/share/gc/g1/g1MMUTracker.cpp` | ~200 | `add_pause`(:80), `when_sec`(:117), `when_max_gc_sec`(:90) | **暂停时间预测** — 64 元素环形队列 + 滑动窗口预测 |
| 9 | **g1EvacFailure.cpp** | `src/hotspot/share/gc/g1/g1EvacFailure.cpp` | ~263 | `remove_self_forwarding_pointers`(:100), `restore_after_evac_failure`(:76), `forward_to_self`(:?) | **疏散失败恢复** — Self-forwarded ptr 清除 + region 保留 |
| 10 | **evacuationInfo.hpp** | `src/hotspot/share/gc/g1/evacuationInfo.hpp` | ~80 | `EvacuationInfo` struct: `_evacuation_failed`, `_collectionset_regions`, `_bytes_copied` | 疏散统计 — 跨阶段传递的疏散元数据 |
| 11 | **g1InitialMarkToMixedTimeTracker.hpp** | `src/hotspot/share/gc/g1/g1InitialMarkToMixedTimeTracker.hpp` | ~60 | `record_pause`, `record_initial_mark_start`, `during_initial_mark_pause`(:?) | 时间追踪 — Initial Mark 到 Mixed GC 的时间窗口 |
| 12 | **g1YoungGCTraceTime.hpp** | `src/hotspot/share/gc/g1/g1YoungGCTraceTime.hpp` | ~50 | `G1YoungGCTraceTime` RAII 计时 + 日志输出 | 日志追踪 — young/mixed GC 的 Unified Logging 输出 |

---

## §四 Deep Dive Question Groups（≥8 组，含 counterfactual）

### 4.1 ★★★ Policy 决策枢纽 — record_collection_pause_end 的 14 个序列更新

```
问题：
  ① record_collection_pause_end (g1Policy.cpp:643) 在每次 Young/Mixed GC 暂停结束时被调用。
     它按什么顺序更新 14 个 TruncatedSeq？顺序是否重要？
     答案方向: 更新顺序必须是:
       alloc_rate → pause_times → cost_per_card → cost_per_entry → cost_per_byte 
       → young_other_per_region → non_young_other_per_region → constant_other_time
       → pending_cards → rs_lengths → young_list → ihop_prediction → concurrent_refine
       → 最终调用 need_to_start_conc_mark() 做 marking 启动决策
     顺序重要性: alloc_rate 必须先更新因为 need_to_start_conc_mark 依赖最新的 allocation rate 
     来预测 marking 期间的 promotion 速率。pause_times 必须早于 cost_per_xxx 因为 
     cost model 基于 pause time 计算。ihop_prediction 在 need_to_start_conc_mark 前更新——后者
     读取最新的 IHOP 阈值决策是否启动标记。
     
     追问: 如果 alloc_rate 在 pause_times 之后更新会怎样？
     → need_to_start_conc_mark() 读取的 alloc_rate 是上一轮的值——如果 allocation rate 突发增长
     20%，旧值会使 marking start 延迟一轮 → Old Gen 多填 200MB → Full GC 风险上升。
     
  ② record_collection_pause_end 内部根据 g1CollectorState 做分支的逻辑是什么？
     答案方向: 内部根据 g1CollectorState 做分支:
       - in_young_only_phase() → 纯 Young GC 后处理: 更新 young list target、计算 reallocate 量
       - in_mixed_phase() → Mixed GC 后处理: 额外调用 next_gc_should_be_mixed 判定是否继续
       - 共同路径: 更新 allocation rate、更新 MMUTracker、更新 IHOP prediction、更新 survivor 预测
     Mixed 路径的额外工作: 调用 cset_chooser()->verify()、更新 mixed gc count、
     调用 report_ihop_statistics()

  Counterfactual: 如果 record_collection_pause_end 不在 pause 结束时集中计算，而是分散在代码各处？
     答案方向: 拆散导致部分指标更新时其他指标仍是 old world state → 互相引用的计算产生
     transient inconsistency → 一个 pause 的决策可能基于相邻两个 pause 的混合数据 →
     need_to_start_conc_mark 的 alloc_rate 和 ihop_prediction 不在同一时间点 →
     阈值偏差 10-15% → 系统性早/晚启动 marking。
```

### 4.2 ★★★ Mixed GC 判定 — next_gc_should_be_mixed 的双条件

```
问题：
  ① next_gc_should_be_mixed (g1Policy.cpp:1216) 的两个拒绝条件是什么？每个的触发边界？
     答案方向: 
       条件 1: cset_chooser()->is_empty() → 候选 old region 为空
         触发时: 前序 concurrent mark 未发现任何有可回收空间的 old region
         或所有候选已被之前的 Mixed GC 消耗完
       
       条件 2: reclaimable_percent <= G1HeapWastePercent (默认 5%)
         计算: reclaimable_bytes = sum(candidate->gc_efficiency() × candidate->live_bytes())
         或类似公式——剩余可回收空间占 heap 百分比
         如果 < 5%，继续 Mixed GC 的成本超过收益——剩下的垃圾留给下次 concurrent mark 的
         Cleanup 阶段直接回收整个 region 而非逐对象复制
       
       追问: G1HeapWastePercent=5 和 G1MixedGCLiveThresholdPercent=85 的决策关系？
       → LiveThreshold(85%) 控制"一个 region 里有 ≥85% live object 就不加入 CSet"
         选择阶段: 太 live 的不选（复制成本 > 回收收益）
       → WastePercent(5%) 控制"剩余可回收总量 < 5% heap 就停止 Mixed GC"
         终止阶段: 垃圾太少不值得继续
         两者是不同阶段的过滤器——LiveThreshold 过滤单个 region，WastePercent 过滤全局状态
  
  ② 如果 next_gc_should_be_mixed 返回 true 但实际 GC 中又发现没有空间复制对象？
     答案方向: 这是 Mixed GC 的最坏情况——CSet 包含 old region 但 to-space 不足。
     evacuation_failed 标志在 EvacuationInfo 中置位 → to-space exhausted 处理:
       - 未完成的 evacuation: self-forwarded pointer 保证对象不丢失
       - 恢复阶段 (g1EvacFailure.cpp): remove_self_forwarding_pointers() 清除恢复标记
       - 受影响的 CSet region 标记为 "pinned"——保留 live objects 在原位
       - 这些 region 晋升为 old——下次 concurrent mark 重新评估
     这种 case 下 next_gc_should_be_mixed 下次一定返回 false —— 
     pinned region 不增加 Chooser 候选且 reclaimable% 已低于阈值。

  Counterfactual: 如果 next_gc_should_be_mixed 只有一个条件(只检查 Chooser 非空)？
     答案方向: Mixec GC 会追逐最后 1% 的垃圾——每轮回收 < G1HeapWastePercent 时
     继续暂停复制大量 live object 只为回收极少量垃圾。一个 8GB heap, 5% = 400MB → 
     WastePercent=5 意味剩余垃圾 <400MB 时停止。移除后 Mixed GC 继续直到所有 old region 清空——
     可能多 5-8 轮 GC——增加 600ms+ 总暂停时间而仅回收 400MB。这是典型的
     diminishing returns 保护机制。
```

### 4.3 ★★★ CSet 选择算法 — Chooser::rebuild → sort_regions → finalize_old_part

```
问题：
  ① CollectionSetChooser::rebuild (collectionSetChooser.cpp:305) 如何计算每个 region 的 gc_efficiency？
     答案方向: rebuild 在 concurrent mark cleanup 结束时调用，对每个非空 old region:
       1. 读取 liveness 数据 (concurrent mark bitmap 计算结果)
       2. 计算 reclaimable_bytes = region->used() - live_bytes 
       3. 如果 reclaimable == 0: 跳过 (纯 live region)
       4. 如果 live_bytes > region_size × G1MixedGCLiveThresholdPercent / 100: 跳过 (太 live)
       5. 否则: 计算 gc_efficiency = reclaimable_bytes / non_reclaimable_bytes
          或 reclaimable_bytes / predicted_evacuation_time
       关键: gc_efficiency 是一个比率——不是纯回收量。低 live ratio 的 region 效率高。
     
     追问: 为什么用比值而非绝对值？
     → 200MB region with 190MB live (10MB 回收) vs 20MB region with 18MB live (2MB 回收):
       效率: 10/190=5.3% vs 2/18=11.1% → 选后者。前者需复制 190MB 才回收 10MB。
       绝对值排序: 先选大 region → 暂停时间长回收少 → 时间预算内只能选 1-2 个。
  
  ② sort_regions (collectionSetChooser.cpp:124) 的排序稳定性和数据结构是什么？
     答案方向: 排序结果存入 Chooser 内部的有序容器（可能是 vector 或 region 指针排序）。
     排序是 stable 的吗？——如果两个 region gc_efficiency 相等，顺序由原始扫描顺序决定。
     Chooser 提供 iterator 接口: peek() 看但不取出，pop() 取出顶部（最高效率）。
     pop 后效率次高的自动成为新顶部——整个过程是 O(log N) 的 heap sort。
  
  ③ finalize_old_part (g1CollectionSet.cpp:464) 的四个终止条件是什么？优先级顺序？
     答案方向: 条件按优先级:
       (1) 达到 max_old_cset_length — 绝对上限，防止 CSet 过大
       (2) 累计 reclaimable_percent ≤ G1HeapWastePercent — 回收效率已不足
       (3) predicted_pause_time > pause_time_target && 已达 min_old_cset_length — 
          暂停预测超预算，但必须满足最小选择数（保证进度）
       (4) Chooser 耗尽 — 所有候选都已处理
     
     强行添加 override: 如果预测暂停超预算但未达 min_old_cset_length，
     仍然添加——这保证即使预测悲观，每轮 Mixed GC 也有最小进度。
     min_old_cset_length = min(G1OldCSetRegionThresholdPercent × candidates, max_old_cset_length)
     
     追问: max_old_cset_length 是如何计算的？
     → 基于 pause_time_target - predicted_young_time 的余量逆推。
     predicted_young_time 来自 g1Analytics::predict_young_other_time_ms() + 
     predict_young_collection_time_ms()。剩余 budget 除以 predicted_old_region_other_time_ms 
     得出最大 old region 数。

  Counterfactual: 如果 finalize_old_part 不按 gc_efficiency 排序而用 LIFO (后进先出)？
     答案方向: LIFO 模拟的是"最后创建的 old region 最可能是垃圾"的推测——
     类似 generational hypothesis 但在 old generation 内部的变体。但 old region 的
     liveness 与创建时间无直接关系——一个创建 10 分钟前的 old region 可能仍有 90% live
     (长期缓存)，而刚创建的 old region 可能 10% live (短期晋升后变成垃圾)。
     gc_efficiency 基于 actual liveness 而非 creation time → 始终更准确。
```

### 4.4 ★★★ IHOP 自适应 — get_conc_mark_start_threshold 动态阈值

```
问题：
  ① get_conc_mark_start_threshold (g1IHOPControl.cpp:126) 的自适应公式是什么？
     答案方向: threshold = actual_threshold - (pred_marking_time × pred_promotion_rate + young_size)
       
       actual_threshold = target_occupancy × (100 - G1HeapWastePercent) / 100
         其中 target_occupancy = 1.0 - (1.0 - IHOP/100) / G1ReservePercent
         示例: IHOP=45, ReservePercent=10 → target_occupancy = 1 - (1-0.45)/0.9 = 0.389 → 38.9%
       
       pred_marking_time = davg(marking_times) + sigma × stddev(marking_times)
         marking_times 是 G1Analytics 的一个 TruncatedSeq——存最近 N 次标记的耗时
       
       pred_promotion_rate = davg(alloc_rates) — 预测标记期间的晋升/分配速率
       
       young_size = _g1_policy->young_list_target_length() × HeapRegion::GrainBytes
         预测下次 Young GC 时的 young generation 大小
       
       整体含义: 必须在 Old Gen 到 actual_threshold 之前，提前 (pred_marking_time × promotion_rate + young_size) 启动标记 —
       保证标记完成时 Old Gen 还未超 actual_threshold。
     
     追问: 为什么用 davg + sigma × stddev 而非纯 max？
     → pure max 过于保守——如果某次 marking 异常慢（STW 导致），所有后续标记都基于
       这个极端值 → 标记过早启动 → CPU 浪费。davg + sigma 是统计学上的"一个标准差
       置信区间"—覆盖 ~84% 情况同时避免极端值主导。
  
  ② IHOP 自适应 vs Static 模式的区别在哪？
     答案方向: G1AdaptiveIHOPControl vs G1StaticIHOPControl。
       Static: 直接用 -XX:InitiatingHeapOccupancyPercent 作为阈值——
         Old Gen 使用率 ≥ IHOP% × heap_size → 立即启动标记。不预测 marking 时间。
         简单但有风险: marking 可能来不及完成就满 Old Gen。
       Adaptive: 用上面的公式动态计算阈值——预测 marking 需要的时间和期间分配量。
         threshold = actual_threshold - marking_overhead — 越标记越久 overhead 越大 → 越早启动。
         形成自适应反馈环: marking 变慢 → 下次更早启动 → 给更多时间完成 → marking 可能变快。
     
     追问: 什么时候 Adaptive 退化到 Static？
     → 没有足够的历史标记数据时（前几次 GC），TruncatedSeq 未填满，
       predict_marking_time 返回初始值→ formula 退化为接近 actual_threshold →
       效果类似 Static。随数据积累逐渐收敛到 true adaptive。

  Counterfactual: 如果 IHOP 用 wall-clock timer 而非 allocation-rate-based prediction？
     答案方向: 定时器方案: "每 5 秒启动一次 marking" — 简单但忽略 allocation rate。
     低分配率场景: 5 秒内仅分配 50MB → marking 可以 2 秒内完成 → 浪费 3 秒 CPU。
     高分配率场景: 5 秒内分配 2GB → marking 需要 8 秒 → Old Gen 在 3 秒后已满 → Full GC。
     allocation-rate-based prediction 的好处: 预测的是"还剩多少空间"而非"过了多少时间"—
     与 GC 的真正约束(OOM 而非时间预算)直接对齐。
```

### 4.5 ★★★ Analytics 预测模型 — 衰减平均 (davg) 与置信加权

```
问题：
  ① G1Analytics 的 predict() 方法中 davg + sigma × stddev 为什么是合理的设计？
     答案方向: davg (decaying average) = α × new_value + (1-α) × old_avg, α = G1ConfidencePercent/100 ≈ 0.7。
       这比算术平均更快适应变化——如果 alloc_rate 从 100MB/s 跳到 200MB/s:
         算术平均 (10元素): (100×9 + 200)/10 = 110 → 需要 10 次采样才收敛
         davg (α=0.7): 0.7×200 + 0.3×100 = 170 → 一次采样就接近新值
     
     sigma × stddev = (G1ConfidencePercent as sigma, 默认 1.0) × sqrt(variance)
       这是 "安全边际" — predict = 预测均值 + 预测波动。如果 past values 波动大
       (stddev 大)，说明系统不稳定→ 预测值加更大的安全边际 → 更保守的决策。
       如果波动小 → 安全边际也小 → 更激进的决策。
     
     追问: G1ConfidencePercent 设为 50 vs 100 的行为差异？
     → α=0.5: davg 半历史半当前 → 慢适应, 适合稳态 workload
        σ=0.5: 半个标准差边际 → 预测接近均值 → 50% 概率低估
       α=1.0: davg = 当前值 → 快适应但无平滑 → 对噪声敏感
        σ=1.0: 一个标准差 → 84% 概率不低估 → 较保守
  
  ② 14 个 TruncatedSeq 分别追踪什么指标？它们之间的依赖关系？
     答案方向: 依赖链:
       alloc_rate → 影响 heap_sizing (allocation rate 高 → expand), 影响 IHOP (promotion 预测)
       pause_times → 影响 MMUTracker → 影响 pause_time_target
       cost_per_card/cost_per_entry/cost_per_byte → 影响 evacuation cost prediction
       young_other_per_region → 影响 predicted_young_other_time_ms
       non_young_other_per_region → 影响 predicted_old_region_other_time_ms
       constant_other_time_ms → 基线 other time (与 GC 规模无关的固定开销)
       pending_cards → 影响 predicted_card_merge_time
       rs_lengths → 影响 predicted_scan_rs_time
       young_list → 影响 young_target_length
       ihop_prediction → 影响 need_to_start_conc_mark
       concurrent_refine → 影响 concurrent refine thread 数量自适应
     所有序列汇聚到: pause_time_prediction → CSet size → Mixed GC 轮数

  Counterfactual: 如果去掉 stddev 安全边际，predict() = davg 纯均值？
     答案方向: davg 约 50% 概率低估实际值。pause_time_prediction 系统性偏低 →
     finalize_old_part 选择过多 old region → 暂停频繁超时 → SLA 违约。
     在大规模 heap（64GB+）中，pause time variance 可以高达 50% → 低估导致的
     暂停超时可达 100ms+ → 用户可见 GC 抖动。sigma × stddev 的成本是略微保守
     (可能少选 old region 延长 Mixed GC 轮数)，但收益是暂停时间可预测。
```

### 4.6 ★★★ Phase 状态机 — YoungOnly → InitiateConcMark → Mixed 完整流转

```
问题：
  ① G1CollectorState (g1CollectorState.hpp) 的完整状态流转是什么？
     答案方向: 状态枚举和流转:
       
       YoungOnly ──[need_to_start_conc_mark()=true]──→ 标记为需要
       ↓
       InitiateConcMark ──[下个 Young GC = Initial Mark GC]──→ 进入标记
       ↓
       DuringMarking ──[并发标记运行中]──→ (this is a substate)
       ↓
       [record_concurrent_mark_cleanup_end] → set_in_young_gc_before_mixed()
       ↓
       YoungOnly (过渡一帧) ──[下一GC pause]──→ set_in_young_only_phase(false)
       ↓
       Mixed ──[每次 Mixed GC 后 next_gc_should_be_mixed()]──→
       ├── true: 继续 Mixed
       └── false: set_in_young_only_phase(true) → YoungOnly
       
       状态标签 vs 状态:
       _young_only_phase: 是否纯 Young GC 模式 (true=YoungOnly, false=Mixed+)
       _in_mixed_phase: 是否当前在 Mixed GC 轮次中
       _initiate_conc_mark: 是否下次 GC 是 Initial Mark
       _during_marking: 并发标记是否运行中
       _gcs_are_young: 历史遗留标志 (always true in G1 after JDK-8067341)
  
  ② need_to_start_conc_mark (g1Policy.cpp:?) 的判定条件和 4 个调用者？
     答案方向: 4 个调用者:
       1. maybe_start_marking (g1Policy.cpp:847) — 常规路径: 每次 pause 后检查
       2. attempt_allocation_humongous — Humongous 分配失败时检查
       3. attempt_allocation_at_safepoint — Safepoint 中分配失败时检查
       4. record_full_collection_end — Full GC 后检查
     
     判定条件:
       - Old Gen 使用率 ≥ IHOP threshold (自适应或静态)
       - 非 during_marking (不在标记中)
       - 非 Full GC 正在进行
       - 有足够的 free region 支持标记
       → 满足 → set_initiate_conc_mark() — 下次 GC 做 Initial Mark
     
     追问: 为什么 Humongous allocation failure 也要检查 need_to_start_conc_mark？
     → Humongous 分配失败意味着 Old Gen 空间不足——如果不立即启动标记，
       region 转为 Old 却无法分配 Humongous → 下一次 Young GC 也无济于事
       (Young GC 不回收 Old) → 最终 Full GC。提前触发 marking 可以尽早
       识别可回收 Humongous → eager reclaim → 释放空间。

  Counterfactual: 如果 Mixed GC 完成后不检查 next_gc_should_be_mixed，直接回到 YoungOnly？
     答案方向: 会出现"标记一回合一暂停"——每轮 concurrent mark 后只做一次 Mixed GC。
     Cleanup 计算有 30 个 old region 需要回收，但 Mixed GC 只选 5 个 → 剩下 25 个
     region 的垃圾要等下一轮标记。如果下一轮标记耗时 5 秒而分配速率高 → 
     这 5 秒内又产生 20 个 new garbage old region → 总待回收量从 25 增加到 45 →
     每次标记只回收一部分 → 垃圾堆积 → Full GC。多轮 Mixed GC 的"消化"能力
     是 G1 维持堆健康的关键——一轮消化不完分多轮，避免标记启动的延迟成本。
```

### 4.7 ★★★ MMU Tracker — add_pause 环形队列 + when_sec 时间预测

```
问题：
  ① G1MMUTracker::add_pause (g1MMUTracker.cpp:80) 的环形队列实现原理？
     答案方向: 64 元素的 `G1MMUTrackerQueueElem` 环形队列:
       struct G1MMUTrackerQueueElem { double end_time; double pause_time; };
       add_pause(current_time, pause_length):
         先检查 overrun——如果 current_time - oldest_entry.start_time > MMU window (50ms)
         → 丢弃最老的暂停记录（滑动窗口）
         → 将新暂停追加到队尾
         → _head_index = (_head_index + 1) % 64
       队列满时: head_index 追上尾 → 覆盖最老的（环形缓冲的自然行为）
     
     追问: MMU window (GCPauseIntervalMillis, 默认 50ms 或 500ms) 如何影响预测？
     → window 定义的是"看多远的历史"——小 window (50ms): 只看最近 50ms 内的暂停
       → 密集的连续 GC 间隙小 → when_sec 回答 ~0 (没有安全窗口)
       → 大 window (500ms): 平均暂停间隔 200ms → when_sec 回答 ~200ms
     window 的选择: 受 -XX:GCPauseIntervalMillis 和实际 GC 频率影响。
  
  ② when_sec (g1MMUTracker.cpp:117) 如何预测"何时可以插入一个 N 秒的暂停"？
     答案方向: 输入: current_time + desired_pause_length (N 秒)
       遍历环形队列中所有暂停:
         计算每个暂停与前一个暂停的间隔 = this.end_time - prev.end_time
         如果间隔 ≥ desired_pause_length → 这个间隔可以容纳新暂停
            且 current_time - this.end_time < MMU_window → 预测为现在可用 (return 0)
         否则 → 返回 MMU_window - (current_time - oldest_entry.start_time) 或 0
       实际逻辑: 找最近符合要求的间隔位置，如果没找到 → 等窗口刷新
     when_sec 用于: pause time budget 计算 → 决定 GC 的 frequency 和 duration。
     

  Counterfactual: 如果 MMUTracker 不维护滑动窗口而只看最近一次暂停？
     答案方向: 最近一次暂停可能是突发 GC 的异常值——100ms 暂停后 5ms 后可能
     需要下一轮 GC → 仅基于最近一次 (100ms) 预测 → 估计还需 400ms 才能暂停
     → 错过最佳回收窗口。滑动窗口捕获暂停的 pattern 而非单点——如果 pattern 是
     每 200ms 一次 30ms 暂停 → 预测正确。如果 pattern 是集群式 (3 次 30ms
     在 100ms 内然后 1s 静默) → 滑动窗口也能正确识别集群结束后是安全期。
```

### 4.8 ★★★ Heap Sizing — expansion_amount 的 GC overhead 阈值

```
问题：
  ① expansion_amount (g1HeapSizingPolicy.cpp:50) 的 GC overhead 阈值判定逻辑是什么？
     答案方向: GC overhead = GC 时间 / (GC 时间 + 应用时间) 在过去 N 秒内。
       如果 overhead < GCTimeRatio (默认 99 → 1% overhead) → 可以 expand
       如果 overhead ≥ GCTimeRatio → GC 太重，不应该 expand (expand 会增加 GC 时间)
     
     expansion_amount = max(min_heap_expansion, scale_factor × heap_bytes)
       scale_factor 基于:
         - current_heap_size / min_heap_size 的比率
         - GC overhead 的超出量 (overhead - GCTimeRatio)
         - 目标: overhead 接近目标 → scale_factor 大; overhead 远超目标 → 不 expand
     
     expansion_amount 之后 add_to_expanded_heap_size (更新内部记账)
     
     追问: 什么情况下 expansion_amount = 0？
     → (1) GC overhead > GCTimeRatio → GC 太频繁，加内存只会让 GC 更频繁
       (2) 已达 MaxHeapSize
       (3) 没有可 commit 的 reserved region (vm reservations 不足)
  
  ② shrink_amount 的判定条件与 expand 对称吗？
     答案方向: 不完全对称。shrink 检查:
       - heap 使用率 < GCTimeRatio 的目标（空闲太多）
       - 至少有 MinHeapFreeRatio 的空闲
       - 上次 GC 不是 Full GC
       - 不是 during concurrent mark (标记期间不 shrink)
     不对称性: expand 允许在 GC overhead 低时做 (heuristic)，但 shrink 不允许在
     任何 GC 敏感期间做 (strict)——shrink 的 uncommit 可能引起 TLB flush + 
     page fault cascade → 毫秒级延迟 → 如果在 GC 前发生 → pause 延长。

  Counterfactual: 如果 expansion_amount 不考虑 GC overhead 只检查 free space？
     答案方向: 只看 free space: "free < 10% → expand 10% heap"。如果 free low 
     但原因不是 allocation 而是 fragmentation (humongous objects 造成的碎块)
     → expand 不会解决 fragmentation → expand 增加 heap 但 GC 仍无法回收 → 
     heap 更大的 Full GC 时间更长 → 恶性循环。GC overhead 检查作为安全阀:
     "如果 GC 已经太频繁，加内存只会让每次 GC 更慢"。
```

---

## §五 Article Structure

```
§〇 生产场景 — Mixed GC 回收效率递减 → Full GC
  ★ 真实 GC 日志: Mixed GC 连续触发但 Heap 使用率不降
  ★ Root cause: IHOP 启动过晚 + Chooser 效率低 (gc_efficiency 排序错配)
  ★ 三步诊断: jstat → GDB G1Policy → GC 日志 IHOP 分析
  ★ 反事实: 无 IHOP 自适应 → 固定 45% 阈值对不同 heap 一刀切

§一 ★★★ Mixed GC + Policy 全链路决策引擎
  ❓ 从 Concurrent Mark Cleanup 到 Mixed GC 最后一轮，策略引擎如何决策每一步
  1.1 G1CollectorState 状态机全景: YoungOnly → InitiateConcMark → DuringMarking → Mixed → YoungOnly
  1.2 record_concurrent_mark_cleanup_end: Cleanup 后重建 Chooser + 判断 Mixed 启动
  1.3 record_collection_pause_end: 每次 pause 后更新 14 个 TruncatedSeq 的顺序和依赖
  1.4 next_gc_should_be_mixed: 双条件判定(Candidate 非空 + reclaimable% > 5%)
  1.5 finalize_old_part: 按 gc_efficiency 降序迭代 + 4 个终止条件
  1.6 IHOP 自适应: get_conc_mark_start_threshold 自适应公式 vs Static 固定阈值
  1.7 Analytics 预测模型: davg + sigma × stddev 衰减平均 + 14 个 TruncatedSeq 依赖图
  1.8 MMU Tracker: add_pause 64 元素环形队列 + when_sec 下次可暂停时间预测
  1.9 Heap Sizing: expansion_amount 的 GC overhead 阈值 + shrink 非对称约束
  1.10 ★ Mermaid: G1 Policy Decision State Machine — 从 Cleanup 到 Mixed 停止
      Lanes: G1Policy / CollectionSetChooser / Analytics / MMUTracker / IHOPControl
  1.11 ★ 面试 Story Format 答案 — 从 need_to_start_conc_mark 到 Mixed 停止的完整决策叙事

§二 ★★★ 7 Beginner Callout 框
  2.1 Mixed GC vs Young GC (CSet 内容的本质区别)
  2.2 gc_efficiency (回收效率 = reclaimable / evacuation_time)
  2.3 TruncatedSeq 衰减平均 (davg + sigma × stddev)
  2.4 G1HeapWastePercent 5% (收益递减的终止阈值)
  2.5 MMUTracker 暂停预测 (64 元素环形滑动窗口)
  2.6 疏散失败恢复 (Self-forwarded ptr + remove_self_forwarding_pointers)
  2.7 Phase 状态机 (YoungOnly → Mixed → YoungOnly 完整周期)

§三 ★★ Analytics 预测模型剖析
  ❓ 14 个 TruncatedSeq 的每个追踪什么？davg + sigma×stddev 如何收敛？
  3.1 14 序列逐一分析: alloc_rate, pause_times, cost_per_card, ..., concurrent_refine
  3.2 依赖链图: 哪些序列是其他序列的输入
  3.3 davg 衰减速度: α=0.7 的收敛曲线 vs α=0.5 vs α=0.9
  3.4 安全边际: σ=1.0 的统计基础 (84% 覆盖) vs σ=1.5 (93%) vs σ=0 (50%)

§四 ★★ CSet 选择算法完整剖析
  ❓ Chooser::rebuild → sort_regions → finalize_old_part 三步走
  4.1 rebuild: liveness → reclaimable → gc_efficiency 计算
  4.2 sort_regions: 排序算法 + 数据结构 (O(N log N) heap sort)
  4.3 finalize_old_part: calc_min/max → peek+pop 循环 → 4 终止条件
  4.4 具体示例: 10 candidate regions 的完整选择过程 (含数值表格)

§五 ★★ IHOP 自适应控制深度分析
  ❓ threshold = actual_threshold - (pred_marking × rate + young) 的每项来源
  5.1 actual_threshold: target_occupancy × (100 - waste%) / 100 的推导
  5.2 pred_marking_time: davg + σ × stddev 如何从 marking_times 序列计算
  5.3 pred_promotion_rate: alloc_rate 如何转换为标记期间的晋升预测
  5.4 young_size: young_list_target 的预测依据
  5.5 Adaptive vs Static 对比: 何时退化、何时表现最佳

§六 ★ MMU 暂停时间追踪
  ❓ 64 元素环形队列如何预测"何时可以暂停"
  6.1 add_pause 滑动窗口: overrun 检查 + 旧数据丢弃
  6.2 when_sec 预测算法: 遍历历史间隔找匹配窗口
  6.3 MMU 窗口大小 (GCPauseIntervalMillis) 对预测准确度的影响
  6.4 Pause time budget 计算: MMUTracker → max_pause_time → CSet size

§七 ★ Heap Sizing 自适应伸缩
  ❓ expansion_amount + shrink_amount 的 GC overhead 阈值博弈
  7.1 expansion: GC overhead < GCTimeRatio 时 scale_factor 计算
  7.2 shrink: 非对称约束(标记期间禁止) + uncommit 物理开销 (TLB flush)
  7.3 scale_factor 变化曲线: heap_size / min_heap_size 如何影响扩展幅度

§八 ★★ 疏散失败恢复机制
  ❓ to-space exhausted 后对象如何不丢失
  8.1 触发条件: free region 耗尽 + survivor region 满
  8.2 copy_to_survivor_space 中的 CAS self-forwarding ptr
  8.3 remove_self_forwarding_pointers: 清除 + 标记 pinned
  8.4 CSet region 保留晋升: 对下次 Mixed/Full GC 的影响

§九 ★ Phase 完整流转示例 — 从 Young-Only 到 Mixed 并回到 Young-Only
  ❓ 一次完整的标记→Mixed GC 周期的数值推演
  9.1 初始状态: 8GB heap, Old Gen 45%, allocation rate 100MB/s
  9.2 Phase 1: IHOP threshold 触发 marking → Initial Mark GC
  9.3 Phase 2: Concurrent Mark 5 秒 → Cleanup → Chooser 有 20 candidate
  9.4 Phase 3: Mixed GC × 4 轮，每轮选 5-6 old region
  9.5 Phase 4: next_gc_should_be_mixed = false → 回 YoungOnly
  9.6 总回收量 + 时间线表

§十 诊断工具五件套
  ❓ strace + jcmd + jstat + GDB + /proc 完整诊断
  10.1 jstat: -gcutil 追踪 Mixed GC 效率 (OU 下降速率)
  10.2 jcmd: VM.flags + GC.heap_info 查看 IHOP/G1HeapWastePercent/Chooser 候选数
  10.3 GDB: G1Policy 内部变量 — _analytics 14 个 TruncatedSeq, _mmu_tracker 队列, _collector_state
  10.4 strace: clock_gettime + futex 追踪 GC 暂停的实际时间 vs 预测
  10.5 /proc/smaps: 验证 expansion/shrink 后的物理内存变化

§十一 Cross-Reference
  ❓ → Phase 01 08-G1-Policy-Analytics: Analytics 初始化 (17 个 TruncatedSeq 创建)
  ❓ → Phase 01 09-G1-Concurrent-Marking-Infra: Concurrent Mark 双 Bitmap + CMTask 创建
  ❓ → Phase 30 doc-01 Young-GC-Evacuation: Evacuation pipeline 本文的 Mixed GC 共用
  ❓ → Phase 30 doc-02 Concurrent-Marking: 标记给本文 Cleanup 输入 liveness 数据
  ❓ → Phase 30 doc-04 Full-GC: Mixed GC 失败 → Full GC 的最后手段承接
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because Mixed GC 的暂停时间必须可预测，finalize_old_part 在四个终止条件中优先检查时间预算..." — not WHAT "finalize_old_part 有四个终止条件".

2. **3-5 lines source code per claim** — paste relevant C++ code from g1Policy.cpp / g1Analytics.cpp / collectionSetChooser.cpp / g1IHOPControl.cpp, do not describe it. 关键逻辑必须有源码引用。

3. **Mermaid** — 两个图的精确指令:
   - **State Machine**: G1CollectorState 的状态流转图。节点: YoungOnly / InitiateConcMark / DuringMarking / YoungOnly(过渡) / Mixed。边标注触发条件 (need_to_start_conc_mark / record_cleanup_end / next_gc_should_be_mixed)。每边标注 file:line。
   - **Policy Decision Sequence**: 5 lanes — G1Policy / CollectionSetChooser / IHOPControl / MMUTracker / Thread (CMThread). 从 Cleanup 记录到 Mixed 终止的时序交互。必须显示关键函数调用箭头 (record_concurrent_mark_cleanup_end → rebuild → finalize_old_part → record_collection_pause_end → next_gc_should_be_mixed)。

4. **数值示例** — §九 必须有一个完整的"8GB heap, 20 candidate region"的卷积计算示例: Chooser rebuild → gc_efficiency 表(≥5个region的reclaimable/live/efficiency) → Mixed GC × 4 轮每轮的选择过程 → 数值变化表。

5. **7 Beginner callout boxes** — exact text from §一: Mixed GC vs Young GC, gc_efficiency, TruncatedSeq 衰减平均, G1HeapWastePercent 5%, MMUTracker 暂停预测, 疏散失败恢复, Phase 状态机.

6. **Cross-reference at four points**:
   - 在 record_collection_pause_end → "→ Phase 01 08-G1-Policy-Analytics for Analytics initialization (17 TruncatedSeq)"
   - 在 Chooser::rebuild + liveness → "→ Phase 30 doc-02 Concurrent-Marking for marking lifecycle that produces liveness data"
   - 在 finalize_old_part evacuation → "→ Phase 30 doc-01 Young-GC-Evacuation for shared evacuation pipeline"
   - 在 Evac Failure → Full GC → "→ Phase 30 doc-04 Full-GC for Full GC as last resort"

7. **不要写成→应该写成对照表**（源码是证据 20%，原理是正文 80%）:

| 不要写成 | 应该写成 |
|---------|---------|
| "next_gc_should_be_mixed 检查两个条件" | "next_gc_should_be_mixed 在每次 Mixed GC 后决定是否继续——第 1 个拒绝条件 Chooser 为空意味上一轮标记未发现可回收 old region，推测对象幸存率过高或标记覆盖率不足；第 2 个条件 reclaimable ≤ 5% 是经济学决策——继续复制的成本超过让 Cleanup 直接免费回收 region 的成本。源码 (g1Policy.cpp:1216) 验证这两个分支。" |
| "IHOP = target_hwm - marking_overhead" | "IHOP 自适应公式 (g1IHOPControl.cpp:126) 的核心思想是时间预测而非空间阈值：target_hwm 告诉我们'还剩多少空间'，marking_overhead = pred_marking_time × pred_promotion_rate 把时间翻译成空间——'标记耗时内会分配多少'。这个时间→空间的翻译才是自适应的精髓——它使 G1 在不同 allocation rate 下都能在正确的时机启动标记。Static IHOP(固定 45%)实质上假设 allocation rate 恒为零——这在生产环境中几乎不成立。" |
| "finalize_old_part 弹出 Chooser 里的 region" | "finalize_old_part (g1CollectionSet.cpp:464) 是时间预算与回收效率的平衡器：max_old_cset_length 把 pause_target - predicted_young_time 的余量 (ms) 翻译成 old region 数量；peek+pop 的循环在 4 个终止条件中优先检查时间预算——暂停预测超 budget 且已选 min_old_cset_length 时立即停止。min_old_cset_length 的 override 保证了即使预测悲观每轮 Mixed GC 也有最小进度——这防止了预测误差导致的完全停滞。" |
| "record_collection_pause_end 更新统计数据" | "record_collection_pause_end (g1Policy.cpp:643) 是 G1 决策引擎的'思考时间'——14 个 TruncatedSeq 的更新顺序不是任意的：alloc_rate 必须先更新因为 need_to_start_conc_mark 读取它；pause_times 更新在 cost models 之前因为 cost models 依赖 pause time 归一化。这个因果顺序在代码中隐形——违反不会崩溃但会让决策基于上一帧的旧数据做出，积累成系统性偏差。IHOP prediction 的更新位置在 need_to_start_conc_mark 之前确保 marking 启动决策用的是最新的 prediction。" |
| "G1Analytics 用 davg 预测" | "G1Analytics 的 predict() = davg + sigma × stddev 不是预测'最有可能的值'而是'有信心的上界'——α=0.7 的 davg 让模型在 1 次采样内适应分配速率突增 50%（vs 算术平均需 10 次），σ=1.0 的 stddev 提供 ~84% 置信度上界。设计哲学: 低估暂停时间的代价远大于高估——低估导致 Mixed GC 选太多 region → 暂停超时 → 用户体验差；高估导致选 region 太少 → 多一轮 Mixed GC → 仅增加总暂停时间 5% 但 SLA 始终满足。" |
| "MMUTracker 记录暂停" | "G1MMUTracker::add_pause (g1MMUTracker.cpp:80) 维护的 64 元素环形队列不是'历史记录'而是'模式记忆'：每个暂停的 (start_time, end_time) 在滑动窗口内构成暂停间距的分布，when_sec 通过搜索第一个 ≥ desired_pause_length 的间隔来回答'何时能暂停'。64 = 2^6 的选择是硬件友好的——环形索引用位掩码而非取模。MMU window 的大小权衡: 小窗口快速遗忘旧模式但可能误判集群式 GC，大窗口更稳定但响应减慢。" |
| "疏散失败后对象保留在原 region" | "Evacuation Failure Recovery (g1EvacFailure.cpp:100) 的对象保留不是'放弃'而是'延迟到下一轮'：copy_to_survivor_space 中的 CAS forwarding pointer 失败时将对象 header 设为 self-forwarded——对象不移动，forwarding pointer 指向自己。remove_self_forwarding_pointers() 遍历 CSet 清除这些标记，将对象标记为 pinned。关键后果: pinned region 不会被回收 → 保留为 old → 下次 concurrent mark 重新评估 liveness → 如果对象已死（晋升后成了垃圾）→ 下次 Mixed GC 回收。疏散失败是 transient 而非 permanent——它只是推迟回收一轮而非放弃。" |

---

## §七 Output Format

- Markdown file, named `03-Mixed-GC-Policy.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/30-g1-runtime-gc/docs/`
- 元信息头:

```
> **阶段**：[30-g1-runtime-gc]
> **前置**：[01-08-G1-Policy-Analytics]（G1Policy 8 子组件初始化、Analytics 17 个 TruncatedSeq 创建）、[01-09-G1-Concurrent-Marking-Infra]（G1ConcurrentMark 构造、双 Bitmap + CMTask×13）、[30-01-Young-GC-Evacuation]（Evacuation 完整生命周期）
> **配套**：[30-00-Region-Runtime-Allocation]（Region 状态机 + TLAB 分配）、[30-02-Concurrent-Marking]（标记生命周期 → Cleanup 输出 liveness）、[30-04-Full-GC]（Mixed 失败 → Full GC 最后手段）
> **后续依赖本文**：[30-04-Full-GC]（Evac Failure 升级路径依赖本文的疏散失败恢复机制）
> **阅读收益**：追踪 Mixed GC 从 Cleanup 结束到最后一轮的完整决策链——理解 record_collection_pause_end 的 14 个 TruncatedSeq 按序更新、next_gc_should_be_mixed 的双条件终止判定、finalize_old_part 的 gc_efficiency 贪心选择、IHOP 自适应公式 (threshold = target_hwm - marking_overhead)、Analytics 预测模型 (davg + sigma×stddev)、MMUTracker 64 元素环形滑动窗口、expansion_amount 的 GC overhead 阈值；掌握 "Mixed GC 回收递减 → Full GC" 的生产诊断全链路
```

- 目标行数: 3500-5000 lines

---

## §八 Prohibited（≥10）

- ❌ 只说 "next_gc_should_be_mixed 返回 true/false" 而不展示双条件判断的源码和边界——必须展示 g1Policy.cpp:1216 的 Chooser 空检查 + reclaimable_percent vs G1HeapWastePercent 比较
- ❌ 不解释 gc_efficiency 的计算公式——必须展示 reclaimable_bytes / non_reclaimable_bytes 或 / evacuation_time 的除法选择，以及为什么用比值而非绝对值
- ❌ 忽略 record_collection_pause_end 中 14 个序列的更新顺序——必须展示完整的因果依赖链 (alloc_rate 先于 need_to_start_conc_mark 等)
- ❌ 不对 IHOP 自适应做公式展开——必须逐项解释 actual_threshold, pred_marking_time, pred_promotion_rate, young_size 的物理含义和取值来源
- ❌ 跳过 davg + sigma × stddev 的统计原理——必须展示 α=0.7 的衰减速度收敛曲线和 σ=1.0 的 84% 置信度推导
- ❌ 不做 finalize_old_part 的 4 个终止条件的优先级排序——必须展示 (1)max (2)waste% (3)time budget+min (4)exhausted 的顺序和强制添加 override
- ❌ 忘记 MMUTracker 的滑动窗口原理——必须展示环形队列下标更新 and when_sec 的间隙搜索算法
- ❌ 不解释 expansion_amount 中 GC overhead 阈值检查的设计原因——必须对比"只检查 free space"的 counterfactual
- ❌ 忽略 Evac Failure 后 CSet region 的保留晋升机制——必须展示 self-forwarded → remove_self_forwarding_pointers → pinned → old 的完整链
- ❌ 不讲 Phase 状态机的完整周期——必须展示 YoungOnly → InitiateConcMark → DuringMarking → YoungOnly(过渡) → Mixed → YoungOnly 的 7 步流转
- ❌ 不引用 man 手册——至少引用 man 2 futex, man 2 clock_gettime, man 2 mmap, man 2 sched_yield
- ❌ 不要解释 C++ 基础 (虚函数、cast、memory order) 或 Java 基础

---

## §九 Required（≥10）

- ✅ **★ Mermaid 状态机图** — G1CollectorState 完整流转: YoungOnly → InitiateConcMark → DuringMarking → Mixed → YoungOnly. 每条边标注触发条件和 file:line
- ✅ **★ Mermaid 策略决策序列图** — 5 lanes (G1Policy / Chooser / IHOPControl / MMUTracker / CMThread), 从 Cleanup 记录到 Mixed 停止的交互
- ✅ **★ record_collection_pause_end 14 个 TruncatedSeq 更新清单** — 完整顺序 + 依赖链 + 每项的含义
- ✅ **★ next_gc_should_be_mixed 完整源码展示** — g1Policy.cpp:1216 的双条件分支 + reclaimable_percent 计算
- ✅ **★ finalize_old_part 4 终止条件源码** — g1CollectionSet.cpp:464 的 min/max 计算 + peek+pop 循环
- ✅ **★ IHOP 自适应公式逐项展开** — get_conc_mark_start_threshold (g1IHOPControl.cpp:126) 的完整推导
- ✅ **★ davg + sigma × stddev 收敛分析** — α=0.7 vs α=0.5 vs α=0.9 的收敛曲线对比
- ✅ **★ MMU Tracker when_sec 算法源码展示** — g1MMUTracker.cpp:117 的间隙搜索
- ✅ **★ Evac Failure Recovery 完整链** — copy_to_survivor_space CAS → self-forwarded → remove → pinned → old promoted
- ✅ **★ 7 Beginner Callout 框** — exact text from §一
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事: 从 need_to_start_conc_mark 到最后一轮 Mixed GC 的完整决策
- ✅ **★ 不要写成→应该写成对照表** — §六 中的 8 行对照表，每行 must have 源码+原理组合
- ✅ **★ Cross-Reference 4 向** — Phase 01 08/09, Phase 30 doc-00/01/02/04

---

## §十 GDB Verification（≥8 assertions）

```
断言 1: G1CollectorState 查看当前 Phase (g1CollectedHeap.hpp)
  (gdb) attach <pid>
  (gdb) print G1CollectedHeap::heap()->_collector_state
  (gdb) print _young_only_phase → 期望: true (YoungOnly) 或 false (Mixed)
  (gdb) print _in_mixed_phase → 期望: true/false
  (gdb) print _initiate_conc_mark → 期望: false (除非刚触发 marking)
  验证: 状态字段与实际 GC 类型一致

断言 2: record_collection_pause_end 入口 (g1Policy.cpp:643)
  (gdb) break g1Policy.cpp:643
  (gdb) run
  (gdb) print _collector_state->_young_only_phase → 期望: 当前 phase
  (gdb) print _collection_set->candidates()->num_regions() → 期望: Chooser 候选数
  (gdb) continue → 进入序列更新
  (gdb) print _analytics._alloc_rate_sec → 期望: 更新后的 alloc_rate

断言 3: Chooser rebuild 后 gc_efficiency 排序 (collectionSetChooser.cpp:305)
  (gdb) break collectionSetChooser.cpp:305
  (gdb) run → 等待 Cleanup 结束
  (gdb) print _regions.size() → 期望: candidate count (>0 表示有 old region 候选)
  (gdb) print _regions[0]->_gc_efficiency → 期望: 最高效率值
  (gdb) print _regions[-1]->_gc_efficiency → 期望: 最低效率值
  验证: 降序排列 (_regions[0] ≥ _regions[-1])

断言 4: next_gc_should_be_mixed 判定 (g1Policy.cpp:1216)
  (gdb) break g1Policy.cpp:1216
  (gdb) continue → 触发 breakpoint (每次 Mixed GC 后)
  (gdb) print _collection_set->candidates()->is_empty() → 期望: false (还有候选) 或 true
  (gdb) print _collection_set->candidates()->num_regions() → 期望: 剩余候选数
  (gdb) finish → 查看返回值
  (gdb) print $rax → 期望: 1 (继续 Mixed) 或 0 (回 YoungOnly)

断言 5: finalize_old_part 选择过程 (g1CollectionSet.cpp:464)
  (gdb) break g1CollectionSet.cpp:464
  (gdb) print min_old_cset_length → 期望: 最小 old region 数
  (gdb) print max_old_cset_length → 期望: 最大 old region 数
  (gdb) continue 经过 peek+pop 循环
  (gdb) print _collection_set_regions → 期望: 实际选择的 old region 数 (≥ min 且 ≤ max)

断言 6: IHOP 自适应阈值计算 (g1IHOPControl.cpp:126)
  (gdb) break g1IHOPControl.cpp:126
  (gdb) print _target_occupancy → 期望: target_occupancy (0.0-1.0)
  (gdb) print _analytics->predict_marking_length_ms() → 期望: 预测标记耗时 (ms)
  (gdb) print _analytics->predict_promotion_rate_bytes_per_ms() → 期望: 预测晋升速率
  (gdb) finish → 查看返回值
  (gdb) print $xmm0 → 期望: adaptive threshold (% 值)
  验证: threshold ≤ static IHOP% (自适应阈值 ≤ 静态阈值)

断言 7: MMUTracker 暂停队列检查 (g1MMUTracker.cpp:80)
  (gdb) break g1MMUTracker.cpp:80
  (gdb) print _head_index → 期望: 当前头部索引 (0-63)
  (gdb) print _queue[0].end_time → 期望: 最早暂停结束时间
  (gdb) print _queue[_head_index-1].end_time → 期望: 最近暂停结束时间
  (gdb) print _no_entries → 期望: ≤ 64

断言 8: Evac Failure self-forwarded ptr (g1EvacFailure.cpp:100)
  (gdb) break g1EvacFailure.cpp:100 (remove_self_forwarding_pointers)
  先设置条件: jcmd <pid> GC.run (触发疏散压力)
  (gdb) print _num_self_forwarded → 期望: >0 (疏散失败发生)
  (gdb) continue 经过 remove_self_forwarding_pointers
  (gdb) print _num_self_forwarded → 期望: 0 (所有恢复)

断言 9: expansion_amount GC overhead 判定 (g1HeapSizingPolicy.cpp:50)
  (gdb) break g1HeapSizingPolicy.cpp:50
  (gdb) print _gc_overhead → 期望: 当前 GC overhead 比例
  (gdb) print GCTimeRatio → 期望: 99 (默认)
  (gdb) finish → 查看返回值
  (gdb) print $rax → 期望: 0 (GC overhead 太高) 或 >0 (expansion amount in bytes)
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §二 doc-03 承接**：展开 README 中 "CSet 选择 + Mixed GC 执行 + IHOP/MMUTracker 自适应 + Evac Failure 处理" 的所有关键问题 (Q1-Q5)，每个问题对应 §四 的一个 Question Group。

2. **同组边界**:
   - doc-00 (Region Runtime & Allocation) → 提供本文依赖的 HeapRegion 状态机 + G1Allocator 三层分配——本文中 CSet region 的类型转换 (Old → CSet → Free) 需要理解 Region 状态
   - doc-01 (Young GC Evacuation) → 本文 Mixed GC 复用的 evacuation pipeline——finalize_old_part 只决定 CSet 内容，实际疏散由 doc-01 的 G1ParScanThreadState 执行
   - doc-02 (Concurrent Marking) → 本文的 Chooser::rebuild 需要的 liveness 数据来自 doc-02 的 Cleanup 阶段——本文是 doc-02 的"下一步"
   - doc-04 (Full GC) → 本文 Mixed GC 失败（Evac Failure 升级、Concurrent Mode Failure）→ doc-04 的 Full GC 最后手段

3. **全部文档共享 §一 开头语**: "Reader completed Phase 01's 08-G1-Policy-Analytics (G1Policy 8 sub-components initialization, Analytics 17 TruncatedSeq) and 09-G1-Concurrent-Marking-Infra (Concurrent Mark dual Bitmap + CMTask×13). This doc: how Policy makes runtime decisions for every GC type."

4. **方法名一致性提醒**:
   - 使用 `record_collection_pause_end` 而非 `record_young_collection_end`
   - 使用 `next_gc_should_be_mixed` 而非 `should_continue_mixed_GC_set`
   - 使用 `predict_non_young_other_time_ms` 而非 `predict_mixed_other_time_ms`
   - 使用 `expansion_amount` 而非 `resize`
