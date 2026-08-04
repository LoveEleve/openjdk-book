# g1_policy()->init——策略引擎绑定堆与 CSet

> **本文定位**：`G1CollectedHeap::initialize()` 第 1677 行。`expand()` 之后堆内存就绪，G1Policy 的 `init()` 绑定此前构造时为 NULL 的 `_g1h` 和 `_collection_set` 指针，首次计算 young list 的目标长度，并启动 CSet 的增量构建。
>
> **前置依赖**：[ch11/08](08-expand-heap-regions.md)（expand 完毕，堆已就绪）。

---

## 1. 执行位置与背景

ch11/04 构造 G1Policy 时，两个关键指针被故意设为 NULL：

```cpp
// G1Policy 构造函数
_g1h(NULL),               // 等 init() 绑定
_collection_set(NULL),     // 等 init() 绑定
```

原因是循环依赖——G1Policy 在 `G1CollectedHeap` 构造函数中创建（`:1431`），此时 `G1CollectedHeap` 自己还没构造完，`_collection_set` 也在后面才创建。如果 Policy 的初始化列表里就直接调 `_g1h->xxx()`，空指针崩溃。

现在 `expand()` 返回了——堆内存就绪、Region 数组就绪、`_collection_set` 对象也有了。`g1_policy()->init(this, &_collection_set)` 补上最后一块拼图。

---

## 2. `G1Policy::init()`——四件事

源码（`g1Policy.cpp:79-96`）：

```cpp
void G1Policy::init(G1CollectedHeap* g1h, G1CollectionSet* collection_set) {
    _g1h = g1h;                                              // ① 绑定堆指针
    _collection_set = collection_set;                         //   绑定 CSet 指针

    if (!adaptive_young_list_length()) {
        _young_list_fixed_length = _young_gen_sizer.min_desired_young_length();
    }
    _young_gen_sizer.adjust_max_new_size(_g1h->max_regions()); // ② 调节新生代上限

    _free_regions_at_end_of_collection = _g1h->num_free_regions(); // ③ 记录空闲数

    update_young_list_max_and_target_length();                  // ④ 算 young list 目标
    _collection_set->start_incremental_building();              // ⑤ 启动 CSet 构建
}
```

逐行解释：

### 2.1 绑定 `_g1h` 和 `_collection_set`

```cpp
_g1h = g1h;
_collection_set = collection_set;
```

ch11/04 构造时这两个字段为 NULL——所有依赖它们的方法（`collector_state()`、`_analytics` 的数据采集等）在此之前都不能调用。绑定后，G1Policy 可以通过 `_g1h` 访问整个堆的状态（Region 数量、空闲列表、DCQ 等），通过 `_collection_set` 管理回收候选。

### 2.2 根据实际堆大小校准新生代范围

```cpp
if (!adaptive_young_list_length()) {
    _young_list_fixed_length = _young_gen_sizer.min_desired_young_length();
}  // 默认 _adaptive_size = true → 跳过；仅 -XX:NewRatio 或 NewSize==MaxNewSize 时执行
_young_gen_sizer.adjust_max_new_size(_g1h->max_regions());
```

`_young_gen_sizer` 是 G1Policy 构造时创建的 `G1YoungGenSizer`（ch11/04）。关键：构造时 `max_regions()` 未知，所以 `_min_desired_young_length` 和 `_max_desired_young_length` **初始都为 0**（`g1YoungGenSizer.cpp:31`）。

`adjust_max_new_size(max_regions)`（`:111-123`）调 `recalculate_min_max_young_length()` 用百分比重算：

```cpp
void recalculate_min_max_young_length(uint number_of_heap_regions, ...) {
    switch (_sizer_kind) {
        case SizerDefaults:  // ← 默认分支（没设 -XX:NewSize / -XX:MaxNewSize）
            *min = calculate_default_min_length(number_of_heap_regions);
                  // = max_regions × G1NewSizePercent / 100 → 5% × 2048 ≈ 102 个 Region
            *max = calculate_default_max_length(number_of_heap_regions);
                  // = max_regions × G1MaxNewSizePercent / 100 → 60% × 2048 ≈ 1228 个 Region
            break;
        // SizerNewRatio / SizerMaxAndNewSize / ... 等其他分支略
    }
}
```

**8GB 堆（2048 Region）的默认结果**：min = 102 Region（408MB），max = 1228 Region（~4.8GB）。

`!adaptive_young_list_length()` ——默认 `_adaptive_size = true`，所以这句话默认**不执行**。只在用户设了 `-XX:NewRatio` 或 `NewSize == MaxNewSize` 时才走固定长度路径。

> **生产建议**：不要手动设 `-XX:NewSize` / `-XX:MaxNewSize`，让 G1 自适应——G1Policy 会根据每次 GC 的历史数据动态调整 young list 目标长度，手动固定值反而会限制 GC 效率。

### 2.3 记录当前空闲 Region 数

```cpp
_free_regions_at_end_of_collection = _g1h->num_free_regions();
```

`expand(8GB)` 刚执行完，2048 个 Region 全在 `_free_list` 上——所以这个值就是 2048。后续每次 GC 后会更新，G1Policy 用它来判断"堆是否紧张、是否需要扩堆"。

### 2.4 首次计算 young list 目标长度

```cpp
update_young_list_max_and_target_length();
```

**先区分三组容易混淆的变量**：

| 变量 | 存于 | 值（8GB 堆） | 含义 |
|------|------|------------|------|
| `_young_gen_sizer._min_desired_young_length` | G1YoungGenSizer | 102 | §2.2 百分比算的——新生代下限（5%） |
| `_young_gen_sizer._max_desired_young_length` | G1YoungGenSizer | 1228 | §2.2 百分比算的——新生代上限（60%） |
| `_young_list_target_length` | **G1Policy** | 本次算出来 | ★ young Region 数量上限——超了就拒绝再分 Eden，分配失败触发 Young GC |

§2.2 的 min/max 是 G1YoungGenSizer 的"硬边界"。本节算的 `_young_list_target_length` 是 G1Policy 的"运行时动态值"——每次 GC 后重新算，在硬边界内自适应浮动。

**什么是 `_young_list_target_length`**——G1 允许的 young（Eden+Survivor）Region 数量上限。当应用分配导致 young Region 数达到这个值时，`should_allocate_mutator_region()` 返回 false——拒绝再从 free list 拿新的 Eden Region（`g1Policy.cpp:861-865`）。分配失败 → 触发 Young GC。

**为什么需要动态计算**——Young Region 太少 → GC 太频繁，吞吐量差。Young Region 太多 → 每次 GC 扫描的 Region 多，停顿时间超标。G1Policy 在"吞吐量"和"停顿时间"之间找一个平衡点。

**怎么算**（`g1Policy.cpp:197-276`）——两层调用：

```
① _analytics->predict_rs_lengths()         预测本次 GC 的 RSet 扫描长度
   ↓                                         （初始化时没有历史数据，返回预设估算值）
② update_young_list_max_and_target_length(rs_lengths)
   ├── young_list_target_lengths(rs_lengths) 计算 target 范围
   │     ├── base_min_length = survivor_regions_count() = 0（初始化时无 GC）
   │     ├── desired_min_length = 确保至少一个 Eden Region
   │     ├── desired_max_length = 基于剩余空间的硬上限
   │     ├── calculate_young_list_target_length(rs_lengths, ...)
   │     │     用 RSet 成本预测 + GC 停顿目标算出理想值
   │     └── clamp 到 [desired_min, desired_max]
   └── update_max_gc_locker_expansion()       调 _young_list_max_length（GC locker 容忍上限）
```

初始化时没有 GC 历史数据——Analytics 返回的是保守预设值，第一次 target 计算结果为 **102 个 Region**（8GB 堆，debug 实测值）。正是 §2.2 中 `_min_desired_young_length` 的下限（5% × 2048 = 102）——初始保守策略直接取下限值。

`update_max_gc_locker_expansion()`（`:886-898`）同步计算 `_young_list_max_length`——比 target 多 5% 的 GC locker 扩展余量：

```cpp
expansion_region_num = ceil(GCLockerEdenExpansionPercent / 100.0 × target)
                     = ceil(5% × 102) = ceil(5.1) = 6
_young_list_max_length = target + 6 = 102 + 6 = 108
```

GC locker 持有期间允许临时多分配几个 Eden Region，避免在 locked 期间触发 GC。

后续每次 GC 后有了真实数据，G1Policy 会重新调用此方法自适应调整。
## 3. `_collection_set->start_incremental_building()`——启动 CSet 构建

```cpp
_collection_set->start_incremental_building();
```

`start_incremental_building()`（`g1CollectionSet.cpp:124-135`）所做的是**重置增量构建的统计计数器**，并标记构建开始：

```cpp
void G1CollectionSet::start_incremental_building() {
    _inc_bytes_used_before = 0;           // 本次增量构建的已用字节数
    _inc_recorded_rs_lengths = 0;         // 累计 RSet 长度
    _inc_predicted_elapsed_time_ms = 0.0; // 累计预测耗时
    _inc_build_state = Active;            // ★ 启动增量构建
}
```

从此刻起，CSet 进入**增量构建**模式——后续 Mutator 分配触发 Young GC 时，young Region 在 GC 暂停中逐步被加入 CSet。

---

## 4. 完整执行流

```
g1_policy()->init(this, &_collection_set)
├── _g1h = this                     ← 绑定堆指针（之前 NULL）
├── _collection_set = &_collection_set ← 绑定 CSet 指针（之前 NULL）
├── _young_gen_sizer.adjust_max_new_size(max_regions)
├── _free_regions_at_end_of_collection = num_free_regions()
├── update_young_list_max_and_target_length()
│     └── calculate_young_list_target_length(BaseTime, FreeRegions, TargetPause)
│           → young_list_target_length ≈ (200ms - 2ms) / 0.5ms = 397
│           → young_list_max_length = target_length × 1.2
└── _collection_set->start_incremental_building()
      → clear() + 设 Active + 启动计时
```

---

## 5. 结果

`g1_policy()->init()` 返回后：

- ✅ `_g1h` 不再为 NULL——所有依赖 heap 的 Policy 方法可以正常调用
- ✅ `_collection_set` 不再为 NULL——CSet 管理可用
- ✅ `_young_list_target_length` 有了首次计算值（~397 个 Region）
- ✅ `_young_list_max_length` 有上限值（~476 个）
- ✅ CSet 进入了增量构建模式——等待首次 Young GC

下一步 `SATBMarkQueueSet::initialize()`（ch11/10）——继续阅读。
