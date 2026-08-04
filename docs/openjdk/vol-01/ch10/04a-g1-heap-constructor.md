# G1CollectedHeap 构造函数——堆对象空壳的创建

> **本文定位**：`create_heap()` 的最后一步——`new G1CollectedHeap(policy)` 的 75 行构造函数（`g1CollectedHeap.cpp:1418-1492`）。构造时堆内存还没分配，只创建了策略对象、线程池、分配器、引用队列等"空壳组件"。类比就是"先把指挥部建好，再慢慢建仓库"。
>
> **前置依赖**：[ch10/04](04-heap-policy-construction.md)（G1Policy 构造完毕，策略引擎就位）。后续 [ch10/05](05-memory-layout-mapper.md) 进入 `initialize()`。

---

## 1. 执行位置与构造总揽

### 1.1 在 create_heap() 中的位置

ch10/04 讲过，`Universe::initialize_heap()` 中：

```cpp
_collected_heap = GCConfig::arguments()->create_heap();  // → new G1CollectedHeap(policy)
_collected_heap->initialize();                             // → 重头戏（ch10/05 起）
```

`create_heap()` 做了两件事：`new G1CollectorPolicy()`（ch10/02 + ch10/04）和 `new G1CollectedHeap(policy)`（本文）。构造完成时堆地址未知、内存未预留——只是"策略引擎 + 线程池 + 分配器 + 队列"的空壳。

### 1.2 构造函数结构

75 行分成两段（`:1418-1492`）：

```
初始化列表 (~40 行, 1419-1457)
├── NULL 字段 × 12: _young_gen_sampling_thread, _card_table, _eden_pool,
│     _survivor_pool, _old_pool, _ref_processor_stw/cm, _bot,
│     _hot_card_cache, _g1_rem_set, _cr, _g1mm, _archive_allocator
├── 轻量对象: _memory_manager(×2), _gc_timer_stw, _gc_tracer_stw,
│     _g1_policy(new G1Policy), _collection_set(空)
├── PLAB 统计: _survivor_evac_stats, _old_evac_stats
└── 计数: _summary_bytes_used=0, _old_marking_cycles_started=0 等
    _hrm (值成员, 默认构造)                    ← §8 HeapRegionManager 空壳

构造函数体 (~35 行, 1459-1492)
├── _workers          = new WorkGang(...)   ← §2 STW GC 线程池
├── _verifier         = new G1HeapVerifier(this)
├── _allocator        = new G1Allocator(this)    ← §3 对象分配器
├── _heap_sizing_policy  = ...              ← §4 堆大小策略
├── _task_queues      = new RefToScanQueueSet(N)  ← §5 per-worker ref 队列
└── _evacuation_failed_info_array = NEW_C_HEAP_ARRAY(...) ← §6 撤离失败追踪
```

初始化列表大部分是 NULL 指针和简单计数——核心在构造函数体的 6 个对象。下面逐个展开。
---

## 2. 策略引擎组——GC 决策的"大脑"

### 2.1 `_g1_policy`——G1Policy

```cpp
// :1431
_g1_policy(new G1Policy(_gc_timer_stw))
```

`G1Policy` 的完整讲解在后续策略章节。这里只需要知道构造时创建了 4 个核心子对象：`_analytics`（历史数据预测）、`_mmu_tracker`（暂停预算管理）、`_ihop_control`（老年代占用阈值）、`_phase_times`（各阶段计时器）。此时 `_g1h` 和 `_collection_set` 字段为 NULL——等 `initialize()` 末尾 `init()` 绑定。

### 2.2 `_collection_set`——CSet 管理器

```cpp
// :1432
_collection_set(this, _g1_policy)
```

`G1CollectionSet` 构造函数（`collectionSet.cpp:53-72`）把所有字段清零：

```cpp
G1CollectionSet::G1CollectionSet(G1CollectedHeap* g1h, G1Policy* policy) :
    _cset_chooser(new CollectionSetChooser()),  // (1) 创建旧区候选队列
    _collection_set_regions(NULL),              // (2) 初始 NULL——等 initialize() 分配
    _collection_set_cur_length(0),
    _collection_set_max_length(0),
    _inc_build_state(Inactive),                 // (3) 构建状态：未激活
    _eden_region_length(0), _survivor_region_length(0), _old_region_length(0),
    ...
{ }
```

**① `_cset_chooser`**（`CollectionSetChooser`，`collectionSetChooser.hpp:31-66`）——Mixed GC 时**按回收效率排序的 old Region 候选队列**。内部是一个 `GrowableArray<HeapRegion*>`，`front/end` 索引模拟 FIFO 队列。Concurrent Mark 结束后的 cleanup 阶段调用 `rebuild()` 重建——并行遍历所有 Region，筛选出存活率低、RSet 完整的 old Region，按 GC 效率排序。

**(2) `_collection_set_regions`**——**这就是 CSet 本身**。一个 `uint*` 动态数组，每个元素存的是入选 Region 的 HRM index（如 `_cset_regions = [3, 7, 12, 45, ...]`）。GC 暂停中 GC Worker 遍历这个数组，逐个 evacuate 对应的 Region。`_eden_region_length / _survivor_region_length / _old_region_length` 三个计数器标记数组里哪一段是哪种 Region。初始化列表中为 NULL——等 `G1CollectedHeap::initialize()` 末尾 `_collection_set.initialize(max_regions())` 才在 C Heap 上分配 `uint[max_regions]` 数组。

**(3) `_inc_build_state`**——枚举 `Active / Inactive`。构造时 `Inactive`。每次 GC 开始时 `start_incremental_building()` → `Active`（ch10/09 §3），GC 结束时 `stop_incremental_building()` → `Inactive`。只有在 `Active` 状态下才能向 CSet 添加 Region。

**(4) 增量构建统计字段**——在 `start_incremental_building()` 中清零，在每次加入 Region 时累加，GC 开始时快照到正式字段：

| 字段 | 作用 |
|------|------|
| `_inc_bytes_used_before` | 增量构建中 CSet 的已用字节数 |
| `_inc_recorded_rs_lengths` | 累计 RSet 扫描长度（预测暂停时间的输入） |
| `_inc_recorded_rs_lengths_diffs` | RSet 长度差量（并发 refinement 线程异步更新） |
| `_inc_predicted_elapsed_time_ms` | 累计预测暂停耗时 |
| `_inc_predicted_elapsed_time_ms_diffs` | 预测耗时差量（同上，异步更新） |

**(5) 正式统计字段**——GC 暂停开始时从增量字段快照得到：

| 字段 | 作用 |
|------|------|
| `_bytes_used_before` | 本次暂停前 CSet 的已用字节数 |
| `_recorded_rs_lengths` | 本次暂停的 RSet 扫描长度 |

GC 暂停结束时这些字段用于 G1Policy 的 Analytics 更新（预测下一次的成本）。

**为什么构造函数只清零、初始化分两步**——和 `G1Policy` 的 `_g1h` 指针一样，`_collection_set_regions` 数组大小取决于 `max_regions`。构造函数时 `max_regions` 尚未确定（ch10/02 算的是 Region 大小，不是数量），必须等 `initialize()` 中 `expand()` 跑完才知道。

### 2.3 `_soft_ref_policy`——软引用策略

```cpp
// :1422
_soft_ref_policy()
```

`SoftRefPolicy`（`softRefPolicy.hpp`）是 JVM 的**软引用清理策略对象**。软引用（`SoftReference`）是"内存够就留着，紧张就回收"的引用类型。怎么判断"紧不紧张"？

**机制**：每个 `SoftReference` 对象上有个 `timestamp` 字段——mutator 每次调用 `ref.get()` 时，JVM 把当前 `SoftReference.clock`（全局静态时间戳，每次 GC 后更新）写入该对象。GC 时逐个判断：

```cpp
// referencePolicy.cpp:44-55
bool LRUCurrentHeapPolicy::should_clear_reference(oop p, jlong clock) {
    jlong interval = clock - SoftReference::timestamp(p);  // 距离上次访问多久
    return interval > _max_interval;   // 超时 → 清除
}
```

**`_max_interval` 的计算**（`:37-40`）：

```
_max_interval (毫秒) = (上次 GC 后空闲堆的 MB 数) × SoftRefLRUPolicyMSPerMB
```

`SoftRefLRUPolicyMSPerMB` 默认 1000——每 1MB 空闲空间允许软引用多活 1 秒。空闲越多，软引用活得越久；空闲越少（"内存紧张"），存活时间越短，回收越快。

**"全清"模式**：`_should_clear_all_soft_refs` 标志被设为 `true` 时（`System.gc()` + 特定 JVM 参数、或多次分配失败后），绕过 LRU 判断，所有软引用一次清光。默认构造时此标志为 `false`——日常 GC 走 LRU 逐个判断。

> **注脚：为什么 JVM 需要软引用和弱引用两种类型？** 它们的出发点不同——`SoftReference` 服务于**缓存**：内存充裕时多留住对象（避免重复计算/加载），内存紧张时主动清掉（不导致 OOM），所以需要 LRU + 空闲 MB 的策略判断。`WeakReference` 服务于**伴随数据**：某个对象（如 `WeakHashMap` 的 Key）被回收时，和它关联的数据（Value）也应该自动消失——这是正确性要求，不需要看内存是否紧张，Key 没了 Value 就必须清。JVM 引用类型的完整讲解在后续单独章节。

### 2.4 `_heap_sizing_policy`——堆大小策略

```cpp
// :1467
_heap_sizing_policy = G1HeapSizingPolicy::create(this, _g1_policy->analytics());
```

`G1HeapSizingPolicy`（`g1HeapSizingPolicy.hpp:33`）在 GC 后调 `expansion_amount()` 决定扩不扩堆。判断逻辑：取 GC 耗时占比 → 超过阈值累计 4 次 → 缩放因子（0.2~2.0）× 比例 → 对齐到 Region。构造时只存 `_g1h` 指针和 `_analytics` 引用，计数器全部清零。

> **生产环境注意**：`-Xms = -Xmx` 时未提交空间为 0，`expansion_amount()` 始终返回 0——堆从不扩展。这个策略只在 `-Xms < -Xmx`（动态伸缩）时生效。

---

## 3. 线程组——STW GC 线程池

### 3.1 `_workers`——STW GC Worker

```cpp
// :1459-1462
_workers = new WorkGang("GC Thread", ParallelGCThreads,
                        /* are_GC_task_threads */ true,
                        /* are_ConcurrentGC_threads */ false);
_workers->initialize_workers();
```

和 ch10/07 §7.1 的 `_concurrent_workers` 同一套 WorkGang 机制，参数不同：

| | `_workers`（STW） | `_concurrent_workers`（并发） |
|---|---|---|
| 线程数 | `ParallelGCThreads`（8） | `ConcGCThreads`（≈4） |
| 线程类型 | `os::pgc_thread` | `os::cgc_thread` |
| STS 注册 | 否（STW 时自然是安全的） | 是（任务中显式 `SuspendibleThreadSetJoiner`） |
| 什么时候跑 | Young/Mixed GC、Remark、Cleanup | mark_from_roots、rebuild_rem_sets、clear_bitmap |

`initialize_workers()` 链路和 ch10/07 §7.1 完全相同：`NEW_C_HEAP_ARRAY` 分配 GangWorker 数组 → `add_workers(true)` → `WorkerManager::add_workers()` → `for` 循环 `new GangWorker` + `os::create_thread(pgc_thread)` + `os::start_thread()`。

### 3.2 `_young_gen_sampling_thread`——年轻代采样线程

```cpp
// :1420
_young_gen_sampling_thread(NULL)
```

初始 NULL。等 `initialize()` 中 `initialize_young_gen_sampling_thread()` 创建。用于定期采样 young Region 的 RSet 大小——为 G1Policy 的预测提供数据。

---

## 4. 分配组——从堆到对象

### 4.1 `_allocator`——对象分配器

```cpp
// :1465
_allocator = new G1Allocator(this);
```

`G1Allocator`（`g1Allocator.hpp:38`）是 G1 的**对象分配中枢**。管理三类"当前正在用的分配 Region"，每类一个专门的子类：

```
G1Allocator
├── _mutator_alloc_region    (MutatorAllocRegion)     ← 应用线程 new 对象（TLAB/直分配）
├── _survivor_gc_alloc_region (SurvivorGCAllocRegion)  ← GC 中拷贝 young 存活对象到 Survivor
└── _old_gc_alloc_region      (OldGCAllocRegion)       ← GC 中晋升年龄够大的对象到 Old
```

三种分配区对应三种**对象流向**：mutator 创建新对象 → Eden（MutatorAllocRegion）；GC 拷贝 young 存活对象 → Survivor 或 Old（GC 两个 Region）。它们底层共用一个基类，继承关系如下：

```
G1AllocRegion（基类, hpp:41-82）
├── MutatorAllocRegion（hpp:204）       ← 直接继承，无 GC 相关字段
└── G1GCAllocRegion（hpp:249）          ← 继承 + 新增 _stats + _purpose
    ├── SurvivorGCAllocRegion（hpp:265）
    └── OldGCAllocRegion（hpp:271）
```

`G1GCAllocRegion` 给 GC 两个子类增加了两个字段：`G1EvacStats* _stats`（PLAB 大小自适应用的每 Region 统计）和 `InCSetState _purpose`（Young 或 Old，决定分配时标记什么类型）。MutatorAllocRegion 没有这两个字段——它不需要 PLAB 统计，也不知道 GC 的 Young/Old 分类。

构造函数（`g1Allocator.cpp:36-43`）：存 `_g1h` 反向指针，两个 GC 分配区用 `PLABStats` 初始化。`_mutator_alloc_region` 这里不激活——等 `initialize()` 末尾。

#### 底层分配——bump-pointer = CAS 推进 _top

三个子类共用同一套分配逻辑（`g1AllocRegion.inline.hpp:78-91`），核心只有一行：

```cpp
HeapWord* attempt_allocation(size_t word_size) {
    HeapRegion* alloc_region = _alloc_region;          // (1) 读当前 Region
    HeapWord* result = par_allocate(alloc_region, word_size); // (2) CAS: 原 top+size ≤ end → top+=size
    return result;  // NULL = 当前 Region 满了
}
```

`HeapRegion::par_allocate()` 内部是 `Atomic::cmpxchg(new_top, &_top, old_top)`——一条 CPU 指令 + 一个内存屏障，无锁。成功返回分配地址，失败（Region 空间不够）返回 NULL，调用者持 `FreeList_lock` 走慢路径：retire 旧 Region → 从 HRM 空闲列表取新 Region → 在新 Region 上分配。

**为什么 `_alloc_region` 永不为 NULL**——引入一个 dummy Region（永远满的伪 Region，`top() == end()`）。退役后或初始状态下 `_alloc_region` 指向 dummy 而非 NULL，这样 fast-path 里不需要 `if (_alloc_region == NULL) return NULL` 判空——dummy 在 CAS 时自然返回 NULL，和没有活跃 Region 的效果一致，但省了一条分支指令。

---

#### MutatorAllocRegion——应用线程分配 + 保留区减少浪费

```cpp
class MutatorAllocRegion : public G1AllocRegion {
    size_t _wasted_bytes;
    HeapRegion* volatile _retained_alloc_region;  // ★ 保留区
};
```

**当旧 Region 退役时**（`g1AllocRegion.cpp:275-287`）：如果剩余空间 ≥ `MinTLABSize`（至少还够放一个 TLAB）且比已保留的更大，不直接丢弃——暂存到 `_retained_alloc_region`。下次分配优先走 `attempt_retained_allocation()`（`inline:133`）——无锁 CAS 在保留区上切，成功直接返回。失败才回退到 `attempt_allocation()`。

**release()**（`:327-343`）——Mutator 阶段结束（GC 前）时双重退休：先退役 active region，再退役 retained region，统计浪费并清零。

---

#### SurvivorGCAllocRegion——GC 期间把存活对象拷贝到 Survivor

**场景**：Young GC 暂停中，GC Worker 扫描 young Region 里的对象。对象如果还活着，年龄（GC 次数）不够大的拷贝到 Survivor，年龄够大的晋升到 Old。SurvivorGCAllocRegion 就是管理"拷贝到 Survivor"这个流向的分配器——它持有一个 Survivor 类型的 Region，GC Worker 往里面塞拷贝后的对象。

**如何拿到新 Region**：当前 Region 满了 → `allocate_new_region()` → `_g1h->new_gc_alloc_region(word_size, InCSetState::Young)` → HRM 空闲列表取一个 Region → 标记为 `Survivor` 类型 → 设为新的活跃分配区。

```cpp
class SurvivorGCAllocRegion : public G1GCAllocRegion {
    SurvivorGCAllocRegion(G1EvacStats* stats)
    : G1GCAllocRegion("Survivor GC Alloc Region",
                      false /* bot_updates */,      // ★ 不更新 BOT
                      stats, InCSetState::Young) { }
};
```

**它的基类 `G1GCAllocRegion`**（`:249-263`）是 GC 两个分配区（Survivor + Old）的公共部分。持有 `G1EvacStats* _stats`——记录每次分配的字节数和 Region 退役时的浪费，用于自适应调整 PLAB 大小。覆写了 `retire()` 把本次退役的浪费字节计入 `_stats`。

**为什么 `bot_updates = false`**——Young GC 扫 young Region 是 bottom→top **线性全扫**，GC Worker 从 Region 头逐个对象走，不需要 BOT 从"半中间某个地址"反推对象头。源码断言（`heapRegion.inline.hpp:237`）：`assert(is_young(), "we can only skip BOT updates on young regions")`。MutatorAllocRegion 同为 young 区分配，同样是 `false`（构造函数 `:224`）。只有 Old Region 需要部分扫描（脏卡、RSet），所以 Old 是唯一的 `bot_updates=true`。

---

#### OldGCAllocRegion——GC 期间对象晋升到 Old + Card 对齐

```cpp
class OldGCAllocRegion : public G1GCAllocRegion {
    OldGCAllocRegion(G1EvacStats* stats)
    : G1GCAllocRegion("Old GC Alloc Region",
                      true /* bot_updates */,       // Old 区需要 BOT
                      stats, InCSetState::Old) { }

    virtual HeapRegion* release();   // ★ 关键覆写
};
```

**为什么 `bot_updates = true`**——Old 是唯一需要**部分扫描**的 Region 类型。RSet 处理脏卡时，扫描起始地址可能落在对象中间，必须靠 BOT 回退到对象头（ch10/06 §4）。Young Region 是线性全扫，不需要 BOT。所以 Old 是三个分配区中唯一一个更新 BOT 的。

**`release()` 中的 Card 对齐填充**（`g1AllocRegion.cpp:366-392`）——Old Region 退役时，分配位置 `top` 可能没对齐到 Card 边界（Card = 512B）。这时主动填一个 dummy 对象，把 `top` 推到下一个 Card 起始位置：

```cpp
HeapWord* aligned_top = align_up(top, BOTConstants::N_bytes);  // Card = 512B
size_t to_fill = aligned_top - top;                  // 需要补多少字节
if (to_fill >= min_fill_size) {
    attempt_allocation(to_fill);                     // bump top 到 Card 对齐
    fill_with_object(dummy, to_fill);                // 写 dummy 对象头
}
```

**举例**——假设 Old Region 退役时 `top = 偏移 400B`，Card 0 覆盖 0~512B：

```
退役前:
  Card 0: [对象A...对象B....top=400B..........|Card 1: 512B 开始...
           ←── 已经填满 ──→ ← 112B 空隙 →      ↑ 新 Card，还没任何对象
           
退役时（没有对齐填充）:
  Card 0 的 [400, 512) 是空的
  下次 RSet 扫描触发：另一线程扫描 Card 0 的 [400,512)
    → BOT 查"400B 属于哪个对象？" → 最近的对象头在 100B（对象B）
    → BOT 返回 100B，scan 从 100B 开始
    → 但同时 GC 线程可能在这 112B 里写了新对象 X
    → BOT 还不知道 X 的存在 → 并发竞争！

退役时（有对齐填充）:
  填 dummy 对象到 512B
  Card 0: [对象A...对象B...dummy...|Card 1: 512B 开始...
  每个 Card 都以有效对象头开头 → RSet 扫描从 Card 边界开始 → 无竞争
```

**本质**——保证每个 Card 的起始字节就是某个对象（即使是 dummy）的开始位置，这样 RSet 扫描从 Card 边界出发时不需要 BOT 回退到上一张 Card，消除了跨 Card 的并发竞争。

---

#### 三层对比

| | MutatorAllocRegion | SurvivorGCAllocRegion | OldGCAllocRegion |
|---|---|---|---|
| 基类 | G1AllocRegion | G1GCAllocRegion | G1GCAllocRegion |
| 场景 | 应用 new 对象 | GC 拷贝 young→Survivor | GC 晋升→Old |
| bot_updates | false | false | true |
| 特殊行为 | retained region | 无 | Card 对齐填充 |
| 新 Region 来源 | `new_mutator_alloc_region()` | `new_gc_alloc_region(Young)` | `new_gc_alloc_region(Old)` |

#### 生命周期——谁在什么时候被创建、使用、释放

三类分配区不是一直活着的——它们的生命周期和 GC 周期同步：

```
MutatorAllocRegion（应用线程使用）:
  G1CollectedHeap::initialize() 末尾: init_mutator_alloc_region() ← 创建，从 free list 取 Region
  应用运行中:         attempt_allocation()            ← 每次 new Object() 走 bump-pointer
  GC 开始前:          release_mutator_alloc_region()  ← 退役当前 Region，回到 free list
  GC 结束后:          重新 init → 回到循环起点

SurvivorGCAllocRegion（GC 暂停内使用）:
  GC 开始时:           init_gc_alloc_regions()        ← 创建，从 free list 取 Region
  GC 暂停中:           par_allocate_during_gc()       ← GC Worker 拷贝存活对象
  GC 结束时:           release_gc_alloc_regions()     ← 退役，Region 标记为 Survivor

OldGCAllocRegion（GC 暂停内使用）:
  GC 开始时:           init_gc_alloc_regions()        ← 同上
  GC 暂停中:           par_allocate_during_gc()       ← GC Worker 晋升老对象
  GC 结束时:           release_gc_alloc_regions()     ← 退役，Card 对齐填充
                        → 返回值保留到 _retained_old_gc_alloc_region（下一次 GC 复用）
```

**关键**：Mutator 和 GC 的分配区**不会同时活跃**——GC 暂停前先把 Mutator 的释放了，GC 结束后再重新创建 Mutator 的。这样确保一个 Region 不会被两边同时分配。Old 的保留区（`_retained_old`）例外——如果退役的 Old Region 没满且不在 CSet 且非空，下次 GC 直接复用。

### 4.2 `_hrm`——HeapRegionManager（值成员，自动构造）

`_hrm` 不是指针——是值成员（`g1CollectedHeap.hpp:210`）：

```cpp
HeapRegionManager _hrm;  // 不是 HeapRegionManager*！
```

`new G1CollectedHeap` 时**自动执行默认构造**（`heapRegionManager.hpp:131-135`），所有字段都在初始态：

```cpp
HeapRegionManager() :
    _regions(),                              // (1)
    _heap_mapper(NULL),                      // (2)
    _prev_bitmap_mapper(NULL), _next_bitmap_mapper(NULL),
    _bot_mapper(NULL), _cardtable_mapper(NULL), _card_counts_mapper(NULL),
    _num_committed(0),                       // (3)
    _allocated_heapregions_length(0),        // (4)
    _available_map(mtGC),                    // (5)
    _free_list("Free list", new MasterFreeRegionListMtSafeChecker())  // (6)
{ }
```

逐个解释：

**① `_regions`**（`G1HeapRegionTable`, `:39`）——一个 `G1BiasedMappedArray<HeapRegion*>`（偏置数组，ch10/05 §3 同名技巧）。以 Region index 为下标，存 `HeapRegion*` 指针。构造时为空——没有 `new` 任何 Region。

**(2) 6 个 Mapper 指针**——全部 NULL。等 `G1CollectedHeap::initialize()` 中调 `_hrm.initialize(heap_storage, prev_bitmap, ...)` 时传入并绑定（ch10/05 §5）。每个 Mapper 管理一种元数据的虚拟内存（堆、prev/next 位图、BOT、Card Table、Card Counts）。`expand()` 时 6 Mapper 同步 commit（ch10/08）。

**(3) `_num_committed`**——当前已 commit 的 Region 数。构造时为 0，`expand()` 中每 commit 一批 Region 就增加。

**(4) `_allocated_heapregions_length`**——已分配 `HeapRegion` 对象的最大 index+1。例如创建了 Region #5、#10、#15，值是 16（不是 3）。用于数组越界检查。`make_regions_available()` 中更新。

**(5) `_available_map`**——`CHeapBitMap`（位图）。每个 bit 对应一个 Region——bit=1 表示该 Region 已 commit 且可用（可以从中分配空闲 Region）。构造时全 0。`make_regions_available()` 中批量标记为 1。

**(6) `_free_list`**——`FreeRegionList`（按地址排序的空闲 Region 链表）。`G1Allocator` 需要新 Region 时通过 `_hrm.allocate_free_region()` 从这里取。`MtSafeChecker` 是多线程安全检查器——每次 add/remove 时断言正确的锁被持有。构造时为空链表——一个都分配不出。

构造时 6 个 Mapper NULL、`_free_list` 空——`expand()`（ch10/08）之后才有 Region 可用。

## 5. 队列组——GC Worker 的任务队列

### 5.1 `_task_queues`——STW GC 的引用扫描队列

```cpp
// :1475-1485
uint n_queues = ParallelGCThreads;
_task_queues = new RefToScanQueueSet(n_queues);

for (uint i = 0; i < n_queues; i++) {
    RefToScanQueue* q = new RefToScanQueue();
    q->initialize();
    _task_queues->register_queue(i, q);
}
```

**什么时候用？** Young GC 或 Mixed GC 的 STW 暂停中，GC Worker 扫描存活对象的引用字段时。每个 worker 发现新的被引用对象后，把引用地址 push 到自己的队列里——等当前对象扫完，再从队列 pop 下一个继续扫。

**为什么每个 worker 一个队列？** 如果所有 worker 共享一个队列，每次 push/pop 都要 CAS 竞争——GC 暂停里每秒处理几百万次引用，锁竞争会拖垮吞吐。每人一个队列，自己 push/pop 自己——无锁，只在偷活时才跨队列。

**RefToScanQueue 是什么？**

```
RefToScanQueue = OverflowTaskQueue<StarTask, mtGC>

StarTask 存的是一个"指向 oop 的指针"（oop*），不是 oop 本身:

  堆上的引用字段:  [oop*] → 堆上的对象 (oop)
                       ↑
                   StarTask 存这个

  为什么不是直接存 oop？因为压缩指针（narrowOop）和普通 oop 是不同的类型——
  存 oop* 可以统一处理两种引用，读的时候再解引用。
```

**和 ch10/07 的 G1CMTaskQueue 的区别**——两套独立的队列，属于不同的对象：

| | `RefToScanQueue`（本文） | `G1CMTaskQueue`（并发标记） |
|---|---|---|
| 属于谁 | `G1CollectedHeap::_task_queues` | `G1ConcurrentMark::_task_queues` |
| 什么时候创建 | G1CollectedHeap 构造函数 | G1ConcurrentMark 构造函数 |
| 什么时候用 | STW 暂停中（Young/Mixed/Remark GC） | 并发标记中（mark_from_roots） |
| 元素 | `StarTask`——oop 指针 | `G1TaskQueueEntry`——oop/数组分片 |
| 满时行为 | **自动溢出到 Stack**（不丢） | 返回 false，卸载到全局 Mark Stack |

**为什么满时不能丢？** STW 暂停中，如果队列满了就丢弃灰色对象——那个对象就被"漏标"了：GC 认为它是死的→回收→数据丢失。所以 `OverflowTaskQueue` 的 `push()` 永远返回 true：环形数组满了就甩到内部的 `Stack<E,F> _overflow_stack` 里。并发标记可以返回 false——调用者会把一批对象卸载到 `§5` 的全局 Mark Stack，让别的 worker 处理。

两套队列的**内部结构差异**：

```
RefToScanQueue (OverflowTaskQueue):
  ┌─ _elems[N]         (环形数组, 继承自 GenericTaskQueue)
  └─ _overflow_stack    (Stack<E,F>, OverflowTaskQueue 自己加的)
     → push() 满了 → overflow_stack->push(t)    内部自消化, 永远返回 true

G1CMTaskQueue (GenericTaskQueue):
  └─ _elems[N]         (环形数组)
     → push() 满了 → 返回 false → 调用者调 move_entries_to_global_stack()
     → 搬到外部 G1CMMarkStack（chunk 链表, ch10/07 §5）       外部救援
```

**设计理由**：并发标记偶尔满一次正常——搬到全局栈让别的 worker 领走继续，不用每个队列都挂溢出栈占内存。STW 不能用外部救援（没有全局栈可搬）——必须自备溢出栈。

### 5.2 `_dirty_card_queue_set`——G1CollectedHeap 自身的 DCQ

G1 中总共有 **2 个 `DirtyCardQueueSet` 实例** + **每个线程本地一个 `DirtyCardQueue` buffer**。层次关系如下：

```
DirtyCardQueueSet（管理 completed buffers 链表 + free list）
├── G1BarrierSet::_dirty_card_queue_set  (static, 全局)    ← mutator 提交到这里
│     ├── JavaThread #1 → DirtyCardQueue (线程本地 buffer, 挂在此 Set 上)
│     ├── JavaThread #2 → DirtyCardQueue
│     ├── ...
│     └── _shared_dirty_card_queue (非 Java 线程共用)
│
└── G1CollectedHeap::_dirty_card_queue_set  (实例)         ← GC Worker 提交到这里
      ├── GC Worker #1 → DirtyCardQueue (暂停中暂用, 挂在此 Set 上)
      ├── GC Worker #2 → DirtyCardQueue
      └── ...
```

**两条写入路径**：

```
Mutator 写屏障:
  线程本地 DirtyCardQueue.enqueue(card)
    → buffer 满 → handle_zero_index()
    → 提交到 G1BarrierSet::_dirty_card_queue_set 的 completed_buffers 链表
    → Concurrent Refinement 线程消费

GC Worker 写屏障（暂停中）:
  G1ParScanThreadState::_dcq.enqueue(card)
    → buffer 满 → flush()
    → 提交到 G1CollectedHeap::_dirty_card_queue_set 的 completed_buffers 链表
    → 暂停结束后 redirty_logged_cards() 合并到全局 DCQ Set
```

**为什么 GC Worker 不能用全局 DCQ？** 暂停期间 Concurrent Refinement 线程是 STS 阻塞的——全局 DCQ 的消费者不工作。如果 GC Worker 也往全局提交，completed buffers 会积压但不被处理。所以 GC Worker 用 G1CollectedHeap 自己的 DCQ 暂存，等暂停结束再合并过去。

**`false` 参数**——`PtrQueueSet` 构造参数 `notify_when_complete`。全局 DCQ 设 `true`——completed buffers 达到阈值时通知 Concurrent Refinement 线程来消费。G1CollectedHeap 的 DCQ 设 `false`——不需要通知，这里的 buffer 最终会被合并到全局 DCQ，由全局的消费者处理。

---

## 6. GC 基础设施指针组——全是 NULL，等 `initialize()` 填充

以下字段在初始化列表中全部为 NULL，在 `initialize()` 中创建：

```cpp
// :1423,1440-1444
_card_table(NULL),           // → initialize() — G1CardTable::initialize()
_bot(NULL),                  // → initialize() — new G1BlockOffsetTable()
_hot_card_cache(NULL),       // → initialize() — new G1HotCardCache()
_g1_rem_set(NULL),           // → initialize() — new G1RemSet()
_cr(NULL),                   // → initialize() — create_concurrent_refine()
_ref_processor_stw(NULL),    // → initialize() — 创建 STW 引用处理器
_ref_processor_cm(NULL),     // → initialize() — 创建 CM 引用处理器
```

**`_card_table`**——卡表（ch10/05）。一个 `jbyte*` 数组，每 **1 byte** 覆盖 512B 堆区域（不是 1 bit）。写屏障用 `0` 标脏，`-1` 表示干净，`2`/`4` 表示 claimed/deferred 中间态。G1 额外加了 `g1_young_gen=32` 标记 young Region 的 card。依赖堆的 reserved region 地址。

**`_bot`**——Block Offset Table（ch10/06 §4）。给定一个 512B 对齐的 Card 边界地址 → 找到该地址所属对象的起始地址。GC 扫描 dirty card 时，Card 边界可能切在对象中间——BOT 用指数编码快速回退到对象头。依赖 reserved region + 需要对应的 Mapper。

**`_hot_card_cache`**——热卡缓存（ch10/05）。某些 card 被反复标脏→refine→清理→再标脏（比如循环里频繁修改同一字段）。`insert()` 对每张 card 计数——超过 `G1CardLiveThreshold` 就缓存起来，返回 NULL 跳过 refine；不超过就返回卡片让 Concurrent Refinement 处理。GC 暂停时 `drain()` 集中处理缓存的卡。

> **和 `G1FromCardCache`（ch10/06 §3.3）的区别**——两个缓存容易搞混：
> - `_hot_card_cache`：在**脏卡消费**环节——判断"这张 card 是不是反复被 dirty，值不值得立刻 refine"。热点卡延迟到 GC 暂停集中处理，减少无用 refine。
> - `G1FromCardCache`：在 **RSet 更新**环节（`add_reference` 内）——判断"这个线程对这个 Region 最近处理的是不是同一张 card"。是则跳过，不是则查三层 RSet 结构。

**`_g1_rem_set`**——`G1RemSet`（ch10/06 §2.2）。全局协调器——消费 dirty card，扫描里面的引用，把跨 Region 引用关系**写入目标 Region 的 RSet**。它不是 RSet 本身——RSet 是 per-Region 的 `HeapRegionRemSet`，每个 Region 一个。

核心字段（`g1RemSet.hpp`）：

```cpp
class G1RemSet {
    G1RemSetScanState* _scan_state;   // GC 暂停期间的并行扫描协调（三态机 + claim + scan_top）
    G1CardTable*       _ct;           // 卡表引用
    G1HotCardCache*    _hot_card_cache; // 热卡缓存引用
    G1Policy*          _g1p;          // 策略引用
    size_t             _num_conc_refined_cards; // 并发 refine 计数
};
```

**工作方式**：Concurrent Refinement 线程从全局 DCQ 取 dirty card → `refine_card_concurrently()` → 扫描 card 内对象的引用字段 → 发现跨 Region 引用 → `add_reference(from, to_region)` → 更新 to_region 的 RSet（三层 Sparse/Fine/Coarse，ch10/06 §3）。GC 暂停期间的版本是 `refine_card_during_gc()`——不走热卡缓存，通过 `_scan_state` 协调多 worker 并行扫描。

**为什么构造时 NULL**——`G1RemSet` 的构造函数需要已经创建好的 `_card_table` 和 `_hot_card_cache`——这两个在 `initialize()` 中才创建，所以 `_g1_rem_set` 也延迟到 `initialize()`。

**`_cr`**——`G1ConcurrentRefine`（`g1ConcurrentRefine.hpp:64`）。并发 refine 线程的**总控器**，核心组件：

- `_thread_control`（`G1ConcurrentRefineThreadControl`, `:72`）——管理 `G1ConcurrentRefineThread**` 数组。`maybe_activate_next()` 根据当前线程 ID 逐步激活后续线程——脏卡少时只用少量线程，脏卡多时逐步追加。
- `_green_zone / _yellow_zone / _red_zone`——三段水位线，根据全局 DCQ 中 completed buffers 的数量控制激活策略：

```
completed buffers 数量:
  [0, green)         绿色区——什么都不做，允许 buffer 累积（利用缓存效果）
  [green, yellow)    黄色区——逐步激活 refine 线程
  [yellow, red)      红色区——所有线程全速运行
  ≥ red              mutator 自己处理 buffer（背压）
```

每个 refine 线程循环从全局 DCQ 取 completed buffer，调 `refine_card_concurrently()` 扫描脏卡内对象的引用，更新目标 Region 的 RSet。

**为什么需要三段**——完全不开 refine 会导致 GC 暂停时积压太多脏卡；一直全开会抢 mutator CPU。三段让系统自适应。

构造时 NULL——等 `initialize()` 中 `create_concurrent_refine()` 创建并启动 refine 线程（ch10/05）。

**`_ref_processor_stw` / `_ref_processor_cm`**——**两个独立的 `ReferenceProcessor` 实例**。ReferenceProcessor 负责 GC 期间的**引用对象处理**——`SoftReference`、`WeakReference`、`PhantomReference`、`Finalizer`。GC 扫完存活对象后，要把这些特殊的引用找出来：哪些该清除、哪些该保留、哪些需要入队（`ReferenceQueue`）。

**为什么需要两个**——STW 暂停和并发标记的"环境"完全不同：

- **`_ref_processor_stw`**：Young/Mixed/Full GC 暂停中用。暂停内所有线程停了，对象图是静态的——发现是**原子的**（`discovery_is_atomic = true`）。每个被发现的引用，`is_alive` 判断用的是 STW 暂停的存活判定（`_is_alive_closure_stw`）。

- **`_ref_processor_cm`**：并发标记周期中用。标记和 mutator 并发跑——引用可能在标记扫描的同时被修改，发现是**非原子的**（`discovery_is_atomic = false`）。存活判定用 CM 的 bitmap（`_is_alive_closure_cm`——查 `_prev_mark_bitmap`）。

**切换方式**（`g1CollectedHeap.cpp:2915-2922`）——STW 暂停开始时，启用 `_ref_processor_stw`，同时用 `NoRefDiscovery` RAII 临时禁用 `_ref_processor_cm`（暂停期间 CM 不应发现新引用）。暂停结束后，RAII 析构恢复 CM 的发现状态。

| | `_ref_processor_stw` | `_ref_processor_cm` |
|---|---|---|
| 使用时机 | Young/Mixed/Full GC | 并发标记周期 |
| 发现原子性 | `true`（暂停内无并发） | `false`（和 mutator 并发） |
| 线程数 | `ParallelGCThreads` | `MAX2(ParallelGCThreads, ConcGCThreads)` |
| 存活判定 | `_is_alive_closure_stw` | `_is_alive_closure_cm` |

**为什么构造时不创建？** 以上所有组件依赖堆的 reserved region 地址和 Region 大小——`initialize()` 中 `Universe::reserve_heap()` 之后才能拿到。构造时只有策略引擎和线程池是独立于堆地址的。

---

## 7. Region 管理组

### 7.1 `_old_set` / `_humongous_set`——Region 分类集合

```cpp
// :1446-1447
_old_set("Old Set", false /* humongous */, new OldRegionSetMtSafeChecker()),
_humongous_set("Master Humongous Set", true, new HumongousRegionSetMtSafeChecker())
```

`HeapRegionSetBase`（`heapRegionSet.hpp`）是一个**带并发安全检查的 Region 双向链表**。G1 用它分类管理 Region——不是随便一个链表，而是自带检查器：

- `_old_set`：跟踪所有非大对象的 **old Region**（Humongous 以外的 old）。GC 时用来遍历、统计 old 区。
- `_humongous_set`：跟踪所有 **Humongous 对象 Region**（占用多个连续 Region 的大对象）。构造参数 `humongous = true`，`regions_humongous()` 返回 true——仅用于断言校验。

**`MtSafeChecker`**——不是锁，是**断言级的安全检查**。每次向集合中 add/remove Region 时，`check_mt_safety()` 检查"调用者是否持有正确的锁"。比如 `OldRegionSetMtSafeChecker` 会断言当前线程持有了 `FreeList_lock` 或处于 safepoint——防止无锁并发修改导致链表损坏。

构造时两个集合都是空链表——还没有任何 old/humongous Region。等 `expand()` 之后才逐步有 Region 加入。

### 7.2 `_humongous_reclaim_candidates` / `_in_cset_fast_test`——偏置位图

```cpp
// :1448,1457
_humongous_reclaim_candidates(),  // 默认构造
_in_cset_fast_test()              // 默认构造
```

两个都是 `G1BiasedMappedArray`（偏置数组，ch10/05 §3 同名技巧——`biased_base + (addr >> shift)` 一行定址）。构造时默认构造（对象本身是值成员，不占额外堆内存），在 `initialize()` 中调 `.initialize(start, end, granularity)` 绑定到堆地址。

**`_in_cset_fast_test`**（ch10/06 §5）——**O(1) 判断对象在不在 CSet**。每个 Region 占一个格子，存一个小数字：

```
obj_addr >> RegionShift → 格子编号 → biased_base[格子] → value
value = -1: Humongous 在 CSet
         0: 不在 CSet
         1: Young 在 CSet
         2: Old 在 CSet
```

GC 扫描引用时（`A → B`），必须快速判断"B 在不在 CSet"——如果在，B 需要被搬走。不能遍历 CSet 列表逐一比对——太慢。偏置数组让判断变成一条地址计算 + 一次内存读 + 一次 `> 0` 比较。

**`_humongous_reclaim_candidates`**（ch10/06 §6）——**跟踪哪些 Humongous 对象可以急切回收**。也是偏置数组，每个 Region 一个 bool。Young GC 开始前检查 Humongous Region 的 RSet——如果 RSet 为空（没有任何其他 Region 引用它），标记为候选。Young GC 扫描时确认无引用后直接回收，不用等 mixed GC。

### 7.3 `_humongous_object_threshold_in_words`——大对象阈值

```cpp
// :1469-1473
_humongous_object_threshold_in_words = humongous_threshold_for(HeapRegion::GrainWords);
// = HeapRegion::GrainWords / 2           （g1CollectedHeap.hpp:1223）

_filler_array_max_size = _humongous_object_threshold_in_words;
```

超过半个 Region 的对象 → humongous → 专用分配路径（不经过 TLAB/PLAB）。同时限制 TLAB 最大尺寸（`max_tlab_size()`）和 filler 数组上限。

---

## 8. PLAB 统计组

```cpp
// :1452-1453
_survivor_evac_stats("Young", YoungPLABSize, PLABWeight),
_old_evac_stats("Old", OldPLABSize, PLABWeight)
```

**PLAB**（Promotion Local Allocation Buffer, `plab.hpp:36`）——GC 期间每个 GC Worker 的**私有分配缓冲区**。worker 拷贝存活对象时，先从自己的 PLAB 切空间（无锁），PLAB 不够时再走 `par_allocate_during_gc()` 向 GC Alloc Region 申请一块新的 PLAB（多 worker 竞争，需要 CAS）。PLAB 减少了对 GC Alloc Region 的 CAS 竞争次数。

**`PLABStats`**（`plab.hpp:168`）为 Young 和 Old **各自维护独立的统计数据**——Survivor 对象小、存活率低，Old 对象大、存活率高，分开统计才能各自算出合理的 PLAB 大小：

```cpp
class PLABStats {
    size_t _desired_net_plab_sz;  // 自适应调整后的目标 PLAB 大小
    AdaptiveWeightedAverage _filter;  // 指数加权滤波（平滑波动）
};
```

`YoungPLABSize` / `OldPLABSize` 是初始值（JVM 启动参数），`PLABWeight` 是 `_filter` 的加权因子——GC 后根据本次 PLAB 的浪费率调整 `_desired_net_plab_sz`。浪费太多就缩小 PLAB，分配太频繁就扩大 PLAB。

---

## 9. 撤离失败支持组

### 9.1 `_preserved_marks_set`——mark word 恢复

```cpp
// :1445
_preserved_marks_set(true /* in_c_heap */)
```

**背景**：GC evacuation 时，GC Worker 把存活对象从 CSet Region**拷贝**到新的 Survivor/Old Region。拷贝完成后，在原位置留下一个 **forwarding pointer**——HotSpot 偷用对象头部的 `markOop` 字段（8 字节，原本存锁信息/GC 年龄/hash 值）来存新地址：

```
对象头（普通情况）:                 对象头（evacuate 后，原位置）:
┌──────────┬──────────┐           ┌──────────────┬──────────┐
│ markOop  │  klass   │           │ forwarding ptr│  klass   │
│(锁/年龄) │  (类型)  │           │  (新地址)     │          │
└──────────┴──────────┘           └──────────────┴──────────┘
                                     ↑ 偷用 markOop 位置
```

后续 GC Worker 扫描引用指向这个旧地址时 → 读 `markOop` 发现有特殊标记位 → 知道"搬走了" → 把引用更新为新地址。forwarding pointer 通过 CAS 写入——mark word 被覆盖后，原本的锁信息、GC 年龄、hash 值就丢了。

**正常情况**：对象搬走后，forwarding pointer 一直留在原位置，所有后续引用看到它就知道新地址。mark word 不需要恢复——原位置的对象已经死了。

**异常情况**：to-space 满了（没有空闲 Region 接纳拷贝后的对象）→ 对象**搬不走**——但 mark word 已经被覆写成 forwarding pointer 了！对象没搬走但 mark word 坏了——锁信息丢失、hash 值丢失。

**PreservedMarks 的作用**——在覆盖 mark word **之前**，先把原始 mark word 保存到 per-worker 的 `PreservedMarks` 栈中（存 `(对象指针, 原始 mark word)` 对）。如果 evacuation 成功——栈里这条记录作废（对象已死）。如果 evacuation 失败——`restore()` 遍历栈，用原始 mark word 覆盖回 forwarding pointer。对象回到原样，mark word 完好。

```cpp
// 正常: push(obj, old_mark) → CAS mark → copy to new → 对象搬走 → 无需 restore
// 失败: push(obj, old_mark) → CAS mark → to-space 满！→ restore(old_mark) → 恢复原样
```

**`in_c_heap = true`**——栈数组在 C Heap 分配（不是 resource area），生命周期跨 GC 阶段。每个栈的大小由 `PreservedMarksStackSize` 控制。

### 9.2 `_evacuation_failed_info_array`——失败追踪

```cpp
// :1478-1484
_evacuation_failed_info_array = NEW_C_HEAP_ARRAY(EvacuationFailedInfo, n_queues, mtGC);
for (uint i = 0; i < n_queues; i++) {
    ::new (&_evacuation_failed_info_array[i]) EvacuationFailedInfo();
}
```

`EvacuationFailedInfo`（`copyFailedInfo.hpp:91`，继承 `CopyFailedInfo`）记录本次 GC 中每个 worker 的 **evacuation 失败统计**：

```cpp
class CopyFailedInfo {
    size_t _first_size;     // 第一个失败对象的大小
    size_t _smallest_size;  // 失败对象中的最小大小
    size_t _total_size;     // 所有失败对象的总字节数
    uint   _count;          // 失败的次数
};
```

**什么时候填写**：evacuation 过程中对象拷贝失败时（to-space 满了），`preserve_mark_during_evac_failure(worker_id, obj, mark)` → `register_copy_failure(obj->size())` 记录失败对象的大小。

**谁读**：evacuation 结束后，遍历所有 worker 的 info → `has_failed()` → 上报到 `_gc_tracer_stw`（JFR + GC 日志）。纯粹用于**诊断/追踪**——不参与 GC 决策（如是否触发 Full GC），只告诉你"这次 GC 的 evacuation 失败有多严重"。

**为什么 per-worker**——多个 worker 并发 evacuation，各自可能独立失败。per-worker 数组避免统计时的锁竞争。用 placement new 初始化（C Heap 分配的裸内存）。

---

## 10. 监控与追踪组

### 10.1 `_gc_timer_stw` / `_gc_tracer_stw`——GC 计时与事件

```cpp
// :1429-1430
_gc_timer_stw(new (ResourceObj::C_HEAP, mtGC) STWGCTimer()),
_gc_tracer_stw(new (ResourceObj::C_HEAP, mtGC) G1NewTracer())
```

`STWGCTimer`（`gcTimer.hpp:155`）记录每次 STW 暂停的起止时间——G1Policy 依赖它做预测。`G1NewTracer`（`gcTrace.hpp:243`）向 JFR/UL 报告 evacuation 统计、晋升阈值等。两者都在 C Heap 分配。

### 10.2 `_g1mm` / `_eden_pool` / `_survivor_pool` / `_old_pool`——JMX 监控

```cpp
// :1426-1428,1444
_eden_pool(NULL), _survivor_pool(NULL), _old_pool(NULL),   // 初始 NULL
_g1mm(NULL)                                                  // 初始 NULL
```

G1 的堆是 **Region 化**的——没有物理上的 Eden/Survivor/Old 边界。但 `jstat`、JMX 等监控工具期望看到**分代模型**。`G1MonitoringSupport`（`g1MonitoringSupport.hpp:150`）的职责就是**把 Region 集合伪装成分代统计数据**：

```cpp
class G1MonitoringSupport {
    size_t _eden_committed, _eden_used;          // Eden = young_region_num - survivor_region_num
    size_t _survivor_committed, _survivor_used;  // Survivor = survivor_region_num
    size_t _old_committed, _old_used;            // Old = overall - eden - survivor
};
```

三个 `MemoryPool`（`G1EdenPool` / `G1SurvivorPool` / `G1OldGenPool`，`g1MemoryPool.hpp:68-107`）各自持有一个 `G1MonitoringSupport*` 指针，`used_in_bytes()` / `get_memory_usage()` 全都委派给它——它负责计算"free regions 该分配给 eden 还是 old"的逻辑。

构造时全部 NULL——等 `initialize()` 末尾 `new G1MonitoringSupport(this)` 时一并创建并绑定。

### 10.3 `_memory_manager` × 2——GC 事件触发

```cpp
// :1424-1425
_memory_manager("G1 Young Generation", "end of minor GC"),
_full_gc_memory_manager("G1 Old Generation", "end of major GC")
```

两个 `GCMemoryManager`——JMX `MemoryManagerMXBean` 的 HotSpot 实现。GC 结束后通过 RAII 类 `TraceMemoryManagerStats` 析构触发 `MemoryService::gc_end()` → JMX `NotificationEmitter.sendNotification()`，通知所有注册的监听器。

三个 MemoryPool 分别注册到两个 Manager——Pool 是**被观测对象**（存 `used/committed/max` 三个数字），Manager 是**观测者**（GC 结束后触发 JMX 通知）：

```
_memory_manager（young/mixed GC）        _full_gc_memory_manager（Full GC）
├── _eden_pool     ✅ 受影响               ├── _eden_pool     ✅ 受影响
├── _survivor_pool ✅ 受影响               ├── _survivor_pool ✅ 受影响
└── _old_pool      ⚠ 不一定受影响           └── _old_pool      ✅ 受影响
```

Young/Mixed GC 时 old pool 标记为 `not always affected`——因为它可能不变。Full GC 时三个 pool 都受影响。

---

## 11. 其余轻量字段

| 字段 | 初始值 | 作用 |
|------|--------|------|
| `_collector_policy` | `collector_policy`（参数传入） | ch10/04 创建的 Policy |
| `_summary_bytes_used` | 0 | 堆使用量的汇总计数 |
| `_old_marking_cycles_started` | 0 | 已启动的并发标记周期数 |
| `_old_marking_cycles_completed` | 0 | 已完成的并发标记周期数 |
| `_expand_heap_after_alloc_failure` | `true` | GC 期间分配 Region 失败时是否尝试扩堆 |
| `_has_humongous_reclaim_candidates` | `false` | 是否有可急切回收的大对象候选 |
| `_archive_allocator` | `NULL` | CDS 归档分配器，运行时才创建 |
| `_verifier` | `new G1HeapVerifier(this)` | 断言校验（bitmap、卡表、Region 集合等），仅 debug/dev 构建实质性运作 |
| `_is_alive_closure_stw/cm` | `G1IsAliveClosure(this)` | STW/CM 各自的"对象是否存活"判断闭包 |
| `_is_subject_to_discovery_stw/cm` | `G1IsSubjectToDiscoveryClosure(this)` | STW/CM 各自的"对象是否应被发现"判断闭包 |

---

## 12. 完整执行流

```
create_heap()
├── G1Arguments::create_heap()
│     ├── new G1CollectorPolicy()                         ← ch10/02 + ch10/04
│     └── new G1CollectedHeap(policy)                     ← ★ 本文
│           ├── 策略引擎: _g1_policy, _collection_set, _soft_ref_policy
│           ├── 线程池: _workers(ParallelGCThreads, pgc_thread)
│           ├── 分配组: _allocator (G1AllocRegion × 3), _hrm (值成员, 默认构造)
│           ├── 队列组: _task_queues (RefToScanQueue × N), _dirty_card_queue_set
│           ├── GC 指针: _card_table, _bot, _hot_card_cache, _g1_rem_set, _cr (全 NULL)
│           ├── Region 管理: _old_set, _humongous_set, 偏置位图 × 2, humongous 阈值
│           ├── PLAB 统计: _survivor_evac_stats, _old_evac_stats
│           ├── 撤离支持: _preserved_marks_set, _evacuation_failed_info_array
│           └── 监控: _gc_timer_stw, _gc_tracer_stw, _memory_manager × 2
│
└── 返回 G1CollectedHeap* → Universe::initialize_heap()
      → _collected_heap->initialize()                     ← ch10/05 起
```

---

## 13. 结果

构造完成时：

- ✅ 策略引擎就位（G1Policy + CollectionSet）
- ✅ 线程池就位（_workers，8 个 GangWorker 已启动）
- ✅ 分配器就位（_allocator，mutator 分配区未激活）
- ✅ 队列就位（_task_queues，带溢出栈）
- ✅ Region 管理容器就位（_old_set + _humongous_set + _hrm 空壳）
- ❌ 堆地址未知——还没 mmap reserve
- ❌ CardTable / BOT / RemSet / HotCardCache / ConcurrentRefine 全是 NULL
- ❌ HeapRegion 数组空（_hrm._regions 空）
- ❌ JMX 监控未初始化

**构造函数 = 策略引擎 + 线程池 + 分配器 + 队列 + 管理容器。** 堆内存在 `initialize()` 才真正申请。
