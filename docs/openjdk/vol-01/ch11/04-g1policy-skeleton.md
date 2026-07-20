# G1Policy 构造骨架：G1 运行时决策引擎的诞生

> **本文定位**：背景知识文章。G1 是 server-style 软实时 GC——它承诺在 `MaxGCPauseMillis` 内完成每次暂停。要做到这点，G1 每次 GC 后必须做 3 个决策：何时触发并发标记、young gen 放多少 region、CSet 选哪些 old region。这些决策不能拍脑袋——要基于历史数据预测未来。`G1Policy` 就是这个"历史 + 预测 + 决策"的引擎。本文从 3 个决策需求出发，看 G1Policy 的构造函数如何为每个决策准备对应的子组件。
>
> **前置依赖**：ch11/02（Region 大小——Policy 构造需要 GrainBytes 作为空间参数）。
>
> **阅读提示**：本文只讲构造骨架——"G1Policy 需要做什么 → 构造函数为每个决策准备了什么零件"。Analytics 的 19 序列在 ch11/05、MMU + IHOP 在 ch11/06。读完本文你需要能回答：G1Policy 的 4 个核心子对象如何服务于 3 个决策。

---

## 1. G1 运行时要做的 3 个决策

G1 不是"等堆满了再 GC"的简单收集器。它在每次 GC 暂停后都要回答 3 个问题：

| 决策 | 问题 | 错误的后果 |
|------|------|-----------|
| **IHOP 触发** | "old gen 占用达到多少时启动并发标记？" | 太早 → marking 浪费 CPU；太晚 → mixed GC 来不及回收，堆满 OOM |
| **Young gen 大小** | "下次 GC 回收多少个 young region？" | 太多 → 暂停超时；太少 → 回收效率低，GC 频繁 |
| **CSet 选择** | "mixed GC 时选哪些 old region？" | 选错 → 回收了少量垃圾的 region，浪费时间 |

每个决策都需要**预测**——而预测需要**历史数据**：

- 预测"下次 GC 多久" → 需要知道"过去 GC 多久"（`_recent_gc_times_ms`）
- 预测"拷贝多少对象" → 需要知道"过去拷贝速率"（`_cost_per_byte_ms`）
- 预测"marking 多久" → 需要知道"过去 marking 多久"（`_concurrent_mark_remark_times_ms`）
- 预测"old gen 晋升速率" → 需要知道"过去晋升多少"（`_alloc_rate_ms_seq`）

`G1Policy` 就是承载这些历史数据和预测逻辑的对象。它在 `G1CollectedHeap` 构造时创建（`g1CollectedHeap.cpp:1431`）：

```cpp
_g1_policy(new G1Policy(_gc_timer_stw)),
```

`_gc_timer_stw`（STW GC 计时器）记录每次暂停的各阶段时间戳，传给 G1Policy 用于初始化 `_phase_times`。`_gc_tracer_stw`（G1 追踪器）将 GC 事件推送到 JFR/JMX。

---

## 2. 构造函数——为 3 个决策准备零件

```cpp
/* === src/hotspot/share/gc/g1/g1Policy.cpp:49-71 === */

49  G1Policy::G1Policy(STWGCTimer* gc_timer) :
50    _predictor(G1ConfidencePercent / 100.0),                      // 预测引擎: σ=0.5
51    _analytics(new G1Analytics(&_predictor)),                      // 历史数据库: 19序列
52    _remset_tracker(),                                             // RSet 追踪策略
53    _mmu_tracker(new G1MMUTrackerQueue(                            // 暂停时间约束: 64槽环
54        GCPauseIntervalMillis / 1000.0, MaxGCPauseMillis / 1000.0)),
55    _old_gen_alloc_tracker(),                                      // Old gen 分配量追踪
56    _ihop_control(create_ihop_control(                             // IHOP 决策器
57        &_old_gen_alloc_tracker, &_predictor)),
58    _policy_counters(new GCPolicyCounters("GarbageFirst", 1, 2)),   // PerfData: jstat可见
59    _young_list_fixed_length(0),                                   // Young list 固定长度(占位)
60    _short_lived_surv_rate_group(new SurvRateGroup()),              // Eden 存活率追踪
61    _survivor_surv_rate_group(new SurvRateGroup()),                 // Survivor 存活率追踪
62    _reserve_factor((double) G1ReservePercent / 100.0),            // 预留因子: 0.10
63    _reserve_regions(0),                                           // 预留 region 数(占位)
64    _rs_lengths_prediction(0),                                     // RSet 长度预测(占位)
65    _initial_mark_to_mixed(),                                      // IM→Mixed 时间追踪
66    _collection_set(NULL),                                         // ← NULL: init() 绑定
67    _g1h(NULL),                                                    // ← NULL: init() 绑定
68    _phase_times(new G1GCPhaseTimes(gc_timer, ParallelGCThreads)),  // 30+ 阶段计时器
69    _tenuring_threshold(MaxTenuringThreshold),                     // 晋升阈值: 15
70    _max_survivor_regions(0),                                      // 最大 survivor(占位)
71    _survivors_age_table(true),                                    // 年龄分布表
72    _collection_pause_end_millis(os::javaTimeNanos()               // 上次 GC 结束时间戳
73        / NANOSECS_PER_MILLISEC) {
74  }
```

21 个字段看起来很多，但大部分是占位或配置参数。真正承载决策能力的核心子对象只有 4 个——服务于上述 3 个决策：

| 核心子对象 | 对应的决策 | 怎么做 |
|-----------|-----------|--------|
| `_analytics` + `_predictor` | Young gen 大小 + CSet 选择 | 19 个滑动窗口记录历史成本（每 card 扫描耗时、每 byte 拷贝耗时等），EWMA 预测下次成本 → 算出"多少 region 能在目标暂停内回收完" |
| `_mmu_tracker` | 暂停时间约束 | 64 槽环形缓冲记录最近暂停 → 确保任意 5 秒窗口内 GC 累积不超过 200ms |
| `_ihop_control` | IHOP 触发 | 预测 marking 耗时 × old gen 晋升速率 → 算出"marking 期间需要多少空间" → 反推触发阈值 |
| `_phase_times` | 所有决策的数据来源 | 30+ 计时器记录每次 GC 各阶段耗时 → GC 结束后喂给 Analytics |

其余字段分两类：
- **配置参数**：`_reserve_factor`（0.10，预留空间比例）、`_tenuring_threshold`（15，晋升阈值）
- **占位待填**：`_reserve_regions`、`_rs_lengths_prediction`、`_max_survivor_regions`——构造时写 0，GC 时根据实际数据填入

4 个核心子对象的内部机制分别在 ch11/05（Analytics + 预测）和 ch11/06（MMU + IHOP）展开。本文余下部分讲构造函数无法完成的件事——`_g1h` 和 `_collection_set` 的延迟绑定。

---

## 3. init()——绑定延迟的两个字段

构造函数里有两个字段被故意设为 NULL：

```cpp
_collection_set(NULL),    // ← 等 init() 绑定
_g1h(NULL),               // ← 等 init() 绑定
```

原因是循环依赖——`G1Policy` 在 `G1CollectedHeap` 构造函数中创建（`g1CollectedHeap.cpp:1431`），此刻 `G1CollectedHeap` 自己还没构造完。Policy 里的 `collector_state()` 就是 `return _g1h->collector_state()`——如果此刻调用了任何需要 `_g1h` 的方法，直接空指针崩溃。`_collection_set` 的问题类似——CSet 在 Policy 之后才构造（`g1CollectedHeap.cpp:1432`：`_collection_set(this, _g1_policy)`）。

解法是两段式。构造时只创建不依赖 heap 的独立子组件；等 heap 完全就绪后通过 `init()` 绑定：

```cpp
/* === src/hotspot/share/gc/g1/g1Policy.cpp:79-96 === */

79  void G1Policy::init(G1CollectedHeap* g1h, G1CollectionSet* collection_set) {
80    _g1h = g1h;                                 // 绑定 heap
81    _collection_set = collection_set;           // 绑定 CSet
82
83    assert(Heap_lock->owned_by_self(), "Locking discipline.");
84
85    if (!adaptive_young_list_length()) {
86      _young_list_fixed_length =
87          _young_gen_sizer.min_desired_young_length();
88    }
89    _young_gen_sizer.adjust_max_new_size(
90        _g1h->max_regions());                   // young max 按 heap 实际大小调整
91
92    _free_regions_at_end_of_collection =
93        _g1h->num_free_regions();               // 记录当前空闲 region 数
94
95    update_young_list_max_and_target_length();   // 首次计算 young list 目标长度
96    _collection_set->start_incremental_building(); // 启动增量 CSet 构建
97  }
```

`init()` 在 `G1CollectedHeap::initialize()` 末尾被调用——此时堆已 expand、region 管理就绪。`init()` 做的 4 件事全部依赖 heap 就绪：绑定 `_g1h`/`_collection_set`、查 `max_regions()` 调整 young 上限、查 `num_free_regions()` 记录初始空闲数、算 young list 目标长度。

---

## 4. 构造完成时的状态

构造函数返回时：

- 4 个核心子对象已就位——Analytics（19 序列 + 种子）、MMUTracker（64 槽）、IHOP（自适应模式初始 45%）、PhaseTimes（30+ 计时器）
- `_g1h = NULL`、`_collection_set = NULL`——Policy 还不能做任何有意义的决策
- `SurvRateGroup × 2` 已创建但为空——等待第一次 GC 后才有数据

`init()` 完成后，Policy 拥有 `_g1h` 和 `_collection_set`，可以查询 heap 状态、计算 young list 长度、启动 CSet 构建。此后每次 GC 暂停后，Policy 通过 `record_collection_pause_end` 执行完整的数据循环：

```
GC 结束
  → _phase_times 记录各阶段耗时（30+ 个 double）
  → _analytics 报告 19 个序列（cost_per_card、cost_per_byte、alloc_rate...）
  → _mmu_tracker 追加本次暂停（add_pause）
  → _ihop_control 更新分配速率和 marking 时间预测
  → 根据预测重新计算 young list 目标长度
  → 决定是否触发 concurrent marking
```

这个数据循环的具体实现是 ch11/05（Analytics 怎么从 19 个序列预测成本）和 ch11/06（MMU 怎么约束暂停、IHOP 怎么算触发阈值）的内容。
