# create_heap —— G1CollectedHeap 与 G1Policy 的诞生

> **本文定位**：`initialize_heap` 阶段 1。在堆内存预留之前，JVM 要先选 GC 类型、创建堆对象和策略对象。本文跟着 `create_heap` 的执行流走：选 GC → new G1CollectorPolicy → new G1CollectedHeap → G1Policy 构造。
>
> **前置依赖**：[ch11/01](01-initialize-heap-overview.md)（initialize_heap 五阶段全景）。

---

## 1. 执行位置

`Universe::initialize_heap()` 的第一行就是 `create_heap()`：

```cpp
CollectedHeap* Universe::initialize_heap() {
  _collected_heap = create_heap();    // ← 阶段 1：本文讲这里
  return _collected_heap->initialize(); // ← 阶段 2：ch11/05-09 讲
}
```

---

## 2. create_heap —— 三行代码

`create_heap` 的核心是 `GCArguments::create_heap_with_policy()`（`gcArguments.inline.hpp:30`）——一个模板函数，三行代码完成堆对象创建：

```cpp
template <class Heap, class Policy>
CollectedHeap* GCArguments::create_heap_with_policy() {
  Policy* policy = new Policy();        // 1. 创建策略对象
  policy->initialize_all();             // 2. 初始化策略（校验堆大小参数）
  return new Heap(policy);              // 3. 创建堆对象
}
```

G1 模式下（`G1Arguments::create_heap` at `g1Arguments.cpp:151`），模板参数实例化为 `Heap=G1CollectedHeap, Policy=G1CollectorPolicy`，所以这三行实际执行的是：

```cpp
G1CollectorPolicy* policy = new G1CollectorPolicy();   // 1
policy->initialize_all();                              // 2
return new G1CollectedHeap(policy);                    // 3
```

**选 GC 类型**（`-XX:+UseG1GC` / `UseZGC` / `UseParallelGC`）只是决定模板参数——不同 GC 用不同的 Heap/Policy 组合，三行代码的结构不变。

### 步骤 1: new G1CollectorPolicy

`G1CollectorPolicy` 继承自 `CollectorPolicy`，负责**堆大小参数**——`_initial_heap_byte_size`、`_max_heap_byte_size`、`_heap_alignment`。这些参数来自命令行 `-Xms` / `-Xmx`。

**注意区分两个 Policy**：
- `G1CollectorPolicy` —— 堆大小参数（静态配置，启动时确定）
- `G1Policy` —— 运行时策略引擎（动态决策，每次 GC 后更新）

### 步骤 2: initialize_all

`CollectorPolicy::initialize_all()` 校验堆大小参数对齐——`_initial_heap_byte_size` 和 `_max_heap_byte_size` 要对齐到 `HeapRegion::GrainBytes`（Region 大小）。失败则 `vm_exit_during_initialization`。

### 步骤 3: new G1CollectedHeap(policy)

`G1CollectedHeap` 构造函数（`g1CollectedHeap.cpp:1418`）接收 `G1CollectorPolicy*`，但内部又 `new` 了一个 `G1Policy`：

```cpp
G1CollectedHeap::G1CollectedHeap(G1CollectorPolicy* collector_policy) :
  _collector_policy(collector_policy),                      // 存 G1CollectorPolicy（堆大小参数）
  _gc_timer_stw(new STWGCTimer()),                          // STW GC 计时器
  _gc_tracer_stw(new G1NewTracer()),                        // GC 事件追踪
  _g1_policy(new G1Policy(_gc_timer_stw)),                  // ← 创建 G1Policy（运行时策略）
  _collection_set(this, _g1_policy),                        // CSet（引用 Policy）
  _bot(NULL),                                               // ← NULL：等 initialize()
  _hot_card_cache(NULL),                                    // ← NULL
  _g1_rem_set(NULL),                                        // ← NULL
  // ... 其他字段大部分 NULL
{ }
```

**构造函数只做三件事**：
1. 创建 `G1Policy`（运行时策略引擎）—— 4 个核心子对象（第 4 节展开）
2. 创建 `G1CollectionSet`（引用 Policy）
3. 其余字段（`_bot`/`_hot_card_cache`/`_g1_rem_set` 等）都是 NULL，等 `initialize()` 填充

---

## 3. 字段总览——两个对象里有什么

### G1Policy 的 21 个字段

| 字段 | 类型 | 初始值 | 作用（一句话） |
|---|---|---|---|
| `_predictor` | G1Predictor | confidence=0.5 | 预测引擎——基于历史数据预测未来成本 |
| `_analytics` | G1Analytics* | new | 历史数据库——19 个滑动窗口序列 |
| `_remset_tracker` | G1RemSetTrackingPolicy | 默认 | RSet 追踪策略——决定哪些 Region 的 RSet 要更新 |
| `_mmu_tracker` | G1MMUTrackerQueue* | new | 暂停时间约束——64 槽环形缓冲记录最近 GC 暂停 |
| `_old_gen_alloc_tracker` | G1OldGenAllocationTracker | 默认 | Old gen 分配量追踪——给 IHOP 用 |
| `_ihop_control` | G1IHopControl* | create | IHOP 决策器——决定何时启动并发标记 |
| `_policy_counters` | GCPolicyCounters* | new | PerfData——jstat 可见 |
| `_young_list_fixed_length` | uint | 0 | Young list 固定长度（非自适应模式用） |
| `_short_lived_surv_rate_group` | SurvRateGroup* | new | Eden 存活率追踪——晋升阈值决策 |
| `_survivor_surv_rate_group` | SurvRateGroup* | new | Survivor 存活率追踪——晋升阈值决策 |
| `_reserve_factor` | double | G1ReservePercent/100 | 预留因子——计算 young list 目标长度时预留 |
| `_reserve_regions` | uint | 0 | 预留 region 数（占位，GC 时填） |
| `_rs_lengths_prediction` | size_t | 0 | RSet 长度预测（占位，GC 时填） |
| `_initial_mark_to_mixed` | G1InitialMarkToMixedTimeTracker | 默认 | IM→Mixed 时间追踪——防止 mixed GC 拖太久 |
| `_collection_set` | G1CollectionSet* | **NULL** | CSet 引用（延迟到 init() 绑定） |
| `_g1h` | G1CollectedHeap* | **NULL** | 堆引用（延迟到 init() 绑定） |
| `_phase_times` | G1GCPhaseTimes* | new | GC 阶段计时器——30+ 计时器 |
| `_tenuring_threshold` | uint | MaxTenuringThreshold(15) | 晋升阈值——对象存活几次后晋升 old |
| `_max_survivor_regions` | uint | 0 | 最大 survivor region 数（占位，GC 时填） |
| `_survivors_age_table` | G1SurvivorRegions | true | 年龄分布表——记录各年龄对象占用 |
| `_collection_pause_end_millis` | jlong | 当前时间 | 上次 GC 结束时间戳——计算 GC 间隔 |

**核心子对象 4 个**（第 4 节展开）：`_analytics` / `_mmu_tracker` / `_ihop_control` / `_phase_times`
**NULL 延迟绑定 2 个**（第 5 节展开）：`_collection_set` / `_g1h`
**其余 15 个**：配置参数或占位，后续 GC 后自适应调整

### G1CollectedHeap 的字段

构造函数初始化列表 + 构造函数体内创建，共约 42 个字段。按状态分三类：

**构造时创建（非 NULL）**：

| 字段 | 作用（一句话） |
|---|---|
| `_collector_policy` | 堆大小参数容器（-Xms/-Xmx） |
| `_g1_policy` | ★ 运行时策略引擎 |
| `_collection_set` | ★ CSet 容器 |
| `_gc_timer_stw` | STW GC 计时器 |
| `_gc_tracer_stw` | GC 事件追踪（JFR 用） |
| `_memory_manager` / `_full_gc_memory_manager` | JMX 内存管理器（Young/Old） |
| `_dirty_card_queue_set` | 脏卡队列集（写屏障产生） |
| `_is_alive_closure_stw` / `_is_alive_closure_cm` | 存活判断闭包（STW/CM 各一份） |
| `_is_subject_to_discovery_stw` / `_is_subject_to_discovery_cm` | 引用发现判断闭包 |
| `_preserved_marks_set` | 标记保存集（疏散失败时用） |
| `_old_set` / `_humongous_set` | Old/Humongous Region 集合 |
| `_humongous_reclaim_candidates` | Humongous 回收候选 |
| `_survivor_evac_stats` / `_old_evac_stats` | 撤离统计（PLAB 大小自适应） |
| `_workers`（构造函数体） | GC 工作线程池 |
| `_verifier`（构造函数体） | 堆验证器 |
| `_allocator`（构造函数体） | 对象分配器 |
| `_heap_sizing_policy`（构造函数体） | 堆大小策略（扩展/收缩） |

**NULL 等 initialize() 创建**（ch11/05-09 讲）：

| 字段 | 作用 | 哪篇讲 |
|---|---|---|
| `_card_table` | 卡表 | ch11/05 |
| `_bot` | 对象边界索引 | ch11/06 |
| `_hot_card_cache` | 热卡缓存 | ch11/05 |
| `_g1_rem_set` | 跨 Region 引用追踪 | ch11/06 |
| `_cr` | 并发细化线程（ConcurrentRefine） | ch11/08 |
| `_g1mm` | 监控支持（JMX） | ch11/09 |
| `_ref_processor_stw` / `_ref_processor_cm` | 引用处理器（STW/CM 各一份） | ch11/09 |
| `_young_gen_sampling_thread` | 年轻代 RSet 采样线程 | ch11/08 |
| `_archive_allocator` | 归档分配器（CDS 用） | — |
| `_eden_pool` / `_survivor_pool` / `_old_pool` | JMX 内存池 | ch11/09 |

**计数器/状态**：

| 字段 | 初始值 | 作用 |
|---|---|---|
| `_summary_bytes_used` | 0 | 已用字节汇总 |
| `_old_marking_cycles_started` / `_completed` | 0 / 0 | 标记周期计数 |
| `_has_humongous_reclaim_candidates` | false | 是否有 Humongous 回收候选 |
| `_expand_heap_after_alloc_failure` | true | 分配失败后是否扩展堆 |
| `_in_cset_fast_test` | 默认 | CSet 快速测试位图 |

**核心就两个**：`_g1_policy`（策略引擎）+ `_collection_set`（CSet）。其余要么是 NULL 等 initialize()，要么是监控/计数器基础设施。

---

## 4. G1Policy 的 4 个核心子对象

`G1Policy` 构造函数（`g1Policy.cpp:49`）创建 4 个核心子对象，服务于 G1 运行时的 4 个决策：

### 4.1 G1 要做哪 4 个决策

每次 GC 暂停后，G1Policy 要回答：

| 决策 | 问题 | 错误的后果 |
|---|---|---|
| **IHOP 触发** | old gen 占用达到多少时启动并发标记？ | 太早 → marking 浪费 CPU；太晚 → mixed GC 来不及，堆满 OOM |
| **Young gen 大小** | 下次 GC 前分配多少个 region 作为 young？ | 太大 → 回收全部 young 时暂停超时；太小 → GC 频繁 |
| **晋升阈值** | 对象存活几次 GC 后晋升到 old gen？ | 太高 → survivor 溢出；太低 → old gen 增长过快 |
| **CSet 选择** | mixed GC 时选哪些 old region？ | 选错 → 回收了少量垃圾的 region，浪费时间 |

每个决策都需要**预测**——预测需要**历史数据**。

### 4.2 4 个核心子对象怎么服务于 4 个决策

| 核心子对象 | 服务于的决策 | 怎么做 |
|---|---|---|
| `_analytics` + `_predictor` | Young gen 大小 + CSet 选择 | 19 个滑动窗口记录历史成本（每 card 扫描耗时、每 byte 拷贝耗时等），EWMA 预测下次成本 → 算出"多少 region 能在目标暂停内回收完" + "每个 old region 的回收效率" |
| `_mmu_tracker` | Young gen 大小 + IHOP | 64 槽环形缓冲记录最近暂停 → `max_gc_time()` 返回 `MaxGCPauseMillis` 作为 young list 计算和 CSet 构建的时间预算 |
| `_ihop_control` | IHOP 触发 | 预测 marking 耗时 × old gen 晋升速率 → 算出"marking 期间需要多少空间" → 反推触发阈值 |
| `_phase_times` | 所有决策的数据来源 | 30+ 计时器记录每次 GC 各阶段耗时 → GC 结束后喂给 Analytics 的 19 个序列 |

**晋升阈值**由 `_survivors_age_table` + 两个 `SurvRateGroup` 支撑——每次 GC 时根据 `_young_list_target_length` 和 `SurvivorRatio` 算出 `desired_survivor_size`，再在年龄表上找到"累积存活量超过 desired_size 的最小年龄"作为新的 `_tenuring_threshold`。

### 4.3 数据循环

构造完成后，每次 GC 暂停后 G1Policy 执行完整的数据循环：

```
GC 结束
  → _phase_times 记录各阶段耗时（30+ 个 double）
  → _analytics 报告 19 个序列（cost_per_card、cost_per_byte、alloc_rate...）
  → _mmu_tracker 追加本次暂停（add_pause）
  → _ihop_control 更新分配速率和 marking 时间预测
  → 根据预测重新计算 young list 目标长度
  → update_survivors_policy 重算晋升阈值
  → 决定是否触发 concurrent marking
```

这个循环的具体实现（Analytics 怎么从 19 个序列预测成本、MMU 怎么约束暂停、IHOP 怎么算触发阈值）在 ch11/08 展开。本文只讲构造时准备了哪些"零件"。

---

## 5. 构造/init 两段式——为什么 _g1h 和 _collection_set 要延迟绑定

G1Policy 构造函数里有两个字段被故意设为 NULL：

```cpp
_collection_set(NULL),    // ← 等 init() 绑定
_g1h(NULL),               // ← 等 init() 绑定
```

**原因是循环依赖**——`G1Policy` 在 `G1CollectedHeap` 构造函数中创建（`g1CollectedHeap.cpp:1431`），此刻 `G1CollectedHeap` 自己还没构造完。Policy 里的 `collector_state()` 就是 `return _g1h->collector_state()`——如果此刻调用了任何需要 `_g1h` 的方法，直接空指针崩溃。

`_collection_set` 的问题类似——CSet 在 Policy 之后才构造（`g1CollectedHeap.cpp:1432`：`_collection_set(this, _g1_policy)`）。

**解法是两段式**。构造时只创建不依赖 heap 的独立子组件；等 heap 完全就绪后通过 `init()` 绑定：

```cpp
void G1Policy::init(G1CollectedHeap* g1h, G1CollectionSet* collection_set) {
  _g1h = g1h;                                 // 绑定 heap
  _collection_set = collection_set;           // 绑定 CSet
  // ...
  update_young_list_max_and_target_length();   // 首次计算 young list 目标长度
  _collection_set->start_incremental_building(); // 启动增量 CSet 构建
}
```

`init()` 在 `G1CollectedHeap::initialize()` 末尾被调用（`g1CollectedHeap.cpp:1677`：`g1_policy()->init(this, &_collection_set)`）——此时堆已 expand、region 管理就绪。

---

## 6. 构造完成时的状态

`create_heap` 返回时：

| 已就位 | 状态 |
|---|---|
| `G1CollectorPolicy` | ✅ 堆大小参数已校验 |
| `G1CollectedHeap` 对象 | ✅ 构造完成，但大部分字段 NULL |
| `G1Policy` 的 4 个核心子对象 | ✅ Analytics(19 序列) / MMU(64 槽) / IHOP(初始 45%) / PhaseTimes(30+ 计时器) |
| `G1CollectionSet` | ✅ 创建但为空 |
| `_g1h` / `_collection_set` | ❌ NULL——等 `init()` 绑定 |
| `_bot` / `_hot_card_cache` / `_g1_rem_set` | ❌ NULL——等 `initialize()` 创建 |

**此时堆还没有任何内存**——`mmap` reserve 在 `initialize()` 里做（ch11/03 讲过）。`create_heap` 只是创建了"空壳对象 + 策略引擎"，真正的内存布局在 ch11/05（6 Mapper + HRM）展开。

---

## 7. 概念链

```
initialize_heap 阶段 1: create_heap
  → 选 GC 类型（G1Arguments）
  → new G1CollectorPolicy + initialize_all（堆大小参数校验）
  → new G1CollectedHeap(policy)
    → new G1Policy（4 个核心子对象：Analytics/MMU/IHOP/PhaseTimes）
    → _collection_set(this, _g1_policy)
    → 其余字段 NULL（等 initialize()）

G1Policy 4 个决策 ← 4 个子对象：
  IHOP 触发 ← _ihop_control（预测 marking 耗时 × 晋升速率）
  Young gen 大小 ← _analytics + _mmu_tracker（历史成本预测 + 暂停预算）
  晋升阈值 ← _survivors_age_table + SurvRateGroup（年龄分布）
  CSet 选择 ← _analytics（每个 old region 的回收效率预测）

构造/init 两段式：循环依赖 → _g1h/_collection_set 延迟到 init() 绑定

构造完成 = 空壳对象 + 策略引擎就位，堆内存还没预留
```

---

## 8. 程序员影响

- **`-XX:MaxGCPauseMillis`** —— 设置 G1Policy 的 `_mmu_tracker` 目标，影响 young gen 大小和 CSet 构建的时间预算
- **`-XX:G1HeapWastePercent`** —— CSet 选择时允许的浪费比例，影响 mixed GC 的回收效率
- **`-XX:InitialTenuringThreshold`** —— 晋升阈值初始值（后续 GC 后自适应调整）
- **`-XX:G1MixedGCCountTarget`** —— mixed GC 分多少次回收 old region，影响单次 mixed GC 的停顿

这些参数在 G1Policy 构造时读取，后续每次 GC 后自适应调整。
