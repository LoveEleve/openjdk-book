# 11. 分配器就位 + 收尾——Dummy Region、CSet 初始化与监控

> **本文定位**：`G1CollectedHeap::initialize()` 第 1709-1734 行——`initialize()` 全长的最后 26 行。在此之前已经完成了 BarrierSet、HRM、ConcurrentMark、expand 等重资产初始化，这段是"通电自检"式的收尾——Dummy Region 上膛、分配器激活、监控/去重/撤离保险/CSet 存储各就各位。至此堆可接受分配。
>
> **前置依赖**：[ch10/10](10-queue-system-init.md)（队列系统初始化完毕）。

---

## 1. 全景回顾：这 26 行在整个 initialize() 中的位置

`G1CollectedHeap::initialize()`（g1CollectedHeap.cpp:1533-1735）全长约 200 行，按顺序完成：

```
Phase 1: 初始化基础设施 (1533-1629)
  +- enable_vtime, Heap_lock, 对齐校验
  +- ReservedSpace, BarrierSet, CardTable, HotCardCache
  +- G1RegionToSpaceMapper × 6（heap, BOT, cardtable, card_counts, prev_bitmap, next_bitmap）
  +- _hrm.initialize(), _card_table->initialize(), _hot_card_cache->initialize()

Phase 2: 并发标记与 RSet (1630-1668)
  +- RemSet 初始化
  +- FreeRegionList 超长阈值
  +- BlockOffsetTable, _in_cset_fast_test, _humongous_reclaim_candidates
  +- G1ConcurrentMark + 线程

Phase 3: 扩容与策略初始化 (1670-1707)
  +- expand(init_byte_size)  ←-- 真正提交物理内存，包括 region 0
  +- g1_policy()->init()
  +- SATB + DirtyCard 队列系统
  +- concurrent_refinement + young_gen_sampling_thread
  +- DirtyCardQueueSet 二次初始化

Phase 4: 本文覆盖 —— 分配器就位 + 收尾 (1709-1734)
  +- Dummy Region 创建、标记、填满
  +- G1AllocRegion::setup() —— 静态全局变量
  +- init_mutator_alloc_region() —— 分配器激活
  +- G1MonitoringSupport —— 监控
  +- G1StringDedup —— 去重（默认关）
  +- PreservedMarksSet::init —— 撤离失败保险
  +- CSet::initialize —— Region 索引数组
  +- return JNI_OK
```

**关键依赖**：Phase 3 的 `expand()` 必须在 Dummy Region 之前——因为 `get_dummy_region()` 会调用 `new_heap_region(0)`，它通过 `bottom_addr_for_region(0)` 获取 region 0 的 base 地址（`reserved.start() + 0 * GrainWords`），然后构造一个 `HeapRegion` 对象。如果 region 0 尚未 commit，这个地址虽然合法（在 reserved 范围内），但 BOT、card table 等辅助结构的数据尚未就绪。

---

## 2. Dummy Region——消除分配路径上的一枚分支

### 2.1 是"哨兵"，不是"占位符"

```cpp
// g1CollectedHeap.cpp:1711
HeapRegion* dummy_region = _hrm.get_dummy_region();
```

`get_dummy_region()`（heapRegionManager.hpp:148）的实现极其简洁：

```cpp
HeapRegion* get_dummy_region() { return new_heap_region(0); }
```

它调用 `HeapRegionManager::new_heap_region(0)`（heapRegionManager.cpp:68-73）完成两件事：
1. 通过 `g1h->bottom_addr_for_region(0)` 算出 region 0 的起始地址——`_hrm.reserved().start() + 0 * HeapRegion::GrainWords`
2. 以该地址构造 `MemRegion`，然后 `new HeapRegion(0, bot(), mr)` 创建 C++ 对象

注意：这是一个**完整的 `HeapRegion` 对象**，有合法的物理地址映射（Phase 3 的 `expand()` 已经 commit 了至少一个 region）。但它被故意设计成"无法分配任何对象"。

### 2.2 不可分配的物理原理

```cpp
// g1CollectedHeap.cpp:1717-1719
dummy_region->set_eden();
dummy_region->set_top(dummy_region->end());
```

`set_top(end())` 让 top 指针直接贴在 end 上。来看 `allocate_impl` 的分配逻辑（heapRegion.inline.hpp:38-52）：

```cpp
inline HeapWord* G1ContiguousSpace::allocate_impl(size_t min_word_size,
                                                   size_t desired_word_size,
                                                   size_t* actual_size) {
  HeapWord* obj = top();                            // (1) top == end
  size_t available = pointer_delta(end(), obj);     // (2) available == 0
  size_t want_to_allocate = MIN2(available, desired_word_size);  // (3) == 0
  if (want_to_allocate >= min_word_size) {           // (4) 0 >= 1 → false
    ...
    return obj;
  } else {
    return NULL;                                     // (5) 永远到达这里
  }
}
```

当 `top() == end()`，`available` 恒为 0，`MIN2(0, desired)` 恒为 0，由于 `min_word_size ≥ 1`，条件永假，返回 NULL。

等价地，`par_allocate_impl`（line 55-76）也走同样短路：`available = 0 → want_to_allocate = 0 → 0 < min_word_size → return NULL`，CAS 循环体根本不会进入。

### 2.3 为什么标记为 eden

`G1AllocRegion` 在构造时传入 `_bot_updates` 标识：
- `MutatorAllocRegion` → `bot_updates = false`（mutator 在 young 区分配不需要更新 BOT）
- `SurvivorGCAllocRegion` → `bot_updates = false`
- `OldGCAllocRegion` → `bot_updates = true`

分配路径 `allocate_no_bot_updates` 有一道断言（heapRegion.inline.hpp:227）：

```cpp
inline HeapWord* HeapRegion::allocate_no_bot_updates(...) {
  assert(is_young(), "we can only skip BOT updates on young regions");  // ← 不打 young 会 crash
  return allocate_impl(...);
}
```

如果 dummy 是 Free/Old 类型，`setup()` 阶段验证 dummy 不可分配时会执行 `dummy_region->allocate_no_bot_updates(1)` → 触发断言 → JVM 崩溃。所以 dummy 必须打上 eden 标签绕过这个断言。

这里有一个微妙的设计：**断言本身已经在 Debug 模式下验证了 dummy 不可用**——setup 中需要 dummy 支持 `allocate_no_bot_updates` 调用（不能断言失败），但又要保证它返回 NULL。标记为 eden 满足前者，`set_top(end())` 实现后者。

### 2.4 游离于所有 Region 集合之外的哨兵

Dummy Region 还有一个关键特殊性：**它不在 G1 维护的任何一个 Region 集合中**。

G1CollectedHeap 用四种不同的数据结构追踪各类 Region（g1CollectedHeap.hpp:369-370, 173-176）：

| 类型 | 字段 | 数据结构 | 定义位置 |
|------|------|---------|---------|
| Eden | `_eden` | `G1EdenRegions` — 仅一个 `int _length` 计数器，不存指针 | `g1EdenRegions.hpp:34-47` |
| Survivor | `_survivor` | `G1SurvivorRegions` — `GrowableArray<HeapRegion*>* _regions`，存实际指针 | `g1SurvivorRegions.hpp:34-52` |
| Old | `_old_set` | `HeapRegionSet` — 完整的并发安全 Set | `g1CollectedHeap.hpp:173` |
| Humongous | `_humongous_set` | `HeapRegionSet` — 同上 | `g1CollectedHeap.hpp:176` |

查询方法（g1CollectedHeap.hpp:1245-1259）：
```cpp
uint eden_regions_count()    const { return _eden.length();          }
uint survivor_regions_count() const { return _survivor.length();      }
uint old_regions_count()     const { return _old_set.length();       }
uint humongous_regions_count() const { return _humongous_set.length(); }
```

而 dummy region 只是一个独立的 `HeapRegion*` 指针，仅被 `G1AllocRegion::_dummy_region` 静态字段持有。它不出现在以上任何一个集合/计数器中，也**不在 Free List 中**（GC 释放 region 时 `free_region()` 会归还 free list，但 dummy 永不被释放）。

GC 对它是完全透明的——不会被标记、不会被 evacuate、不会被选入 CSet、不会被释放。`retire()` 和 `release()` 的 `_dummy_region` 守卫确保它永不意外流出：

```cpp
// g1AllocRegion.cpp:118-132
size_t G1AllocRegion::retire(bool fill_up) {
  HeapRegion* alloc_region = _alloc_region;
  if (alloc_region != _dummy_region) {    // ← 跳过 dummy
    waste = retire_internal(alloc_region, fill_up);
    reset_alloc_region();
  }
  return waste;
}

// g1AllocRegion.cpp:197-205
HeapRegion* G1AllocRegion::release() {
  HeapRegion* alloc_region = _alloc_region;
  retire(false);
  _alloc_region = NULL;
  return (alloc_region == _dummy_region) ? NULL : alloc_region;
  //                              ↑ 防止外部拿到 dummy 指针误操作
}
```

这两道防护确保 dummy 永远不会被 retire 逻辑回收、不会被 release 返回给调用者去操作。

### 2.5 它消除的是什么

没有 dummy 的方案：`_alloc_region` 可能为 NULL，所有分配路径都要写：

```cpp
if (_alloc_region != NULL) {
    result = _alloc_region->allocate(word_size);
} else {
    // 处理无活跃 region 的情况
}
```

有 dummy 后：`_alloc_region` **永远非 NULL**，分配路径（g1AllocRegion.inline.hpp:78-91）简洁为：

```cpp
inline HeapWord* G1AllocRegion::attempt_allocation(size_t min_word_size, ...) {
  HeapRegion* alloc_region = _alloc_region;          // 可能是 dummy，但绝非 NULL
  HeapWord* result = par_allocate(alloc_region, ...); // 在 dummy 上返回 NULL
  if (result != NULL) { return result; }
  return NULL;  // 触发上层去申请新 region
}
```

这个分支消除不在 Java 分配 hot-path 的热度关键部分——真正的 hot-path 是 TLAB 分配。它的价值在于**简化了设计模型**：`_alloc_region` 的不变性（invariant"永不 NULL"）让 retire、release、re-init 等操作不再需要大量 NULL 守卫，减少了条件分支覆盖测试的难度。

---

## 3. G1AllocRegion::setup——一次性类级别初始化

### 3.1 核心逻辑

`setup()` 做且只做一件事（g1AllocRegion.cpp:51-52）：

```cpp
_g1h = g1h;
_dummy_region = dummy_region;
```

在此之前是一组 Debug 断言，验证 dummy 确实已满且四种分配方式都返回 NULL。赋值完成后，两个静态字段被所有 `G1AllocRegion` 子类实例共享。

### 3.2 为何是静态的

类层次结构：

```
G1AllocRegion (静态: _g1h, _dummy_region)
  +- MutatorAllocRegion     — mutator 分配
  +- G1GCAllocRegion        — GC 分配
       +- SurvivorGCAllocRegion
       +- OldGCAllocRegion
```

同一进程中只有一个 G1CollectedHeap、一个 dummy region。所有分配器实例共享它们即可，`_g1h` 和 `_dummy_region` 类的所有实例共用。如果设计成实例字段，每个实例都得保存同样的指针，浪费内存且需要各自初始化。

### 3.3 对比例子：G1MonitoringSupport 不是静态的

对比本节另一个初始化——`_g1mm = new G1MonitoringSupport(this)` 是实例字段。因为 `G1MonitoringSupport` 保存着 `_eden_committed`、`_survivor_used` 等可变状态，每个堆实例一份（虽然通常只有单例，但设计上允许堆实例独立）。

而 `_dummy_region` 一旦设好就只读不可变，静态化没有并发风险，还能减少指针占用。

---

## 4. init_mutator_alloc_region——分配器从 NULL 到 Dummy

### 4.1 调用链路

```cpp
// g1Allocator.cpp:45-48
void G1Allocator::init_mutator_alloc_region() {
  assert(_mutator_alloc_region.get() == NULL, "pre-condition");
  _mutator_alloc_region.init();
}

// g1AllocRegion.cpp:162-169
void G1AllocRegion::init() {
  trace("initializing");
  _alloc_region = _dummy_region;
  _count = 0;
  trace("initialized");
}
```

`init()` 的核心：`_alloc_region` 从 NULL → `_dummy_region`。配合 `allocate_new_region_and_allocate` 的逻辑：

```cpp
HeapWord* G1AllocRegion::new_alloc_region_and_allocate(size_t word_size, bool force) {
  assert_alloc_region(_alloc_region == _dummy_region, "pre-condition");
  // 尝试从 FreeList 拿真实 region →
  // 设置 _alloc_region = 真实 region →
  // 在真实 region 上分配
  ...
}
```

分配失败路径完整闭环：
1. `attempt_allocation()` → dummy 上失败 → NULL
2. 上层（mutator）调用 `attempt_allocation_locked()`
3. `attempt_allocation_locked()` → retire（dummy 不需要真 retire，但走流程）→ `new_alloc_region_and_allocate()` → 从 free list 拿真 region → 新 region 上分配成功
4. `_alloc_region` 更新为真实 region

### 4.2 setup() vs init() 对比

| | setup() | init() |
|---|---|---|---|
| **层级** | 类静态 | 实例 |
| **调用次数** | 全局一次 | 每次 GC release 后重新 init |
| **效果** | 设置 `_dummy_region`、`_g1h` | 设置 `_alloc_region = _dummy_region` |
| **前置条件** | dummy 未设、不可分配 | `_alloc_region` 为 NULL |
| **调用时机** | 堆初始化时，JVM 启动阶段 | GC 暂停后重新激活分配器 |

---

## 5. G1MonitoringSupport——为 jstat/JMX 虚构分代假象

### 5.1 为什么需要"虚构"

G1 没有物理上的分代连续空间——eden、survivor、old 是 Region 的逻辑分组，Region 在地址空间中是乱序的。但 jstat、`MemoryMXBean`、JFR 等工具要求看到"young gen / old gen / eden / survivor"的容量和使用量。

`G1MonitoringSupport` 做的就是：**从 Region 计数推算分代容量**。

### 5.2 recalculate_sizes() 的精确算法

```cpp
// g1MonitoringSupport.cpp:182-240
void G1MonitoringSupport::recalculate_sizes() {
  uint young_list_length = _g1h->young_regions_count();
  uint survivor_list_length = _g1h->survivor_regions_count();
  uint eden_list_length = young_list_length - survivor_list_length;

  uint young_list_max_length = _g1h->g1_policy()->young_list_max_length();
  uint eden_list_max_length = young_list_max_length - survivor_list_length;

  // === Used 计算：直接基于 region 数量 ===
  _overall_used = _g1h->used_unlocked();
  _eden_used = (size_t) eden_list_length * HeapRegion::GrainBytes;
  _survivor_used = (size_t) survivor_list_length * HeapRegion::GrainBytes;
  _young_region_num = young_list_length;
  _old_used = subtract_up_to_zero(_overall_used, _eden_used + _survivor_used);

  // === Committed 计算：用"减法"分配剩余水位 ===
  _survivor_committed = _survivor_used;
  _old_committed = HeapRegion::align_up_to_region_byte_size(_old_used);

  _overall_committed = _g1h->capacity();
  size_t committed = _overall_committed;
  committed -= _survivor_committed + _old_committed;

  _eden_committed = (size_t) eden_list_max_length * HeapRegion::GrainBytes;
  _eden_committed = MIN2(_eden_committed, committed);
  committed -= _eden_committed;

  _old_committed += committed;
  _young_gen_committed = _eden_committed + _survivor_committed;

  _eden_used = MIN2(_eden_used, _eden_committed);
}
```

分段讲解：

**Step 1 — 采集 Region 计数（line 317-322）**

```
young_list_length      = _eden.length() + _survivor.length()     ← 当前 young 区 Region 总数
survivor_list_length   = _survivor.length()                      ← 当前 survivor Region 数
eden_list_length       = young - survivor                        ← 相减得出 eden 数

young_list_max_length  = g1_policy()->young_list_max_length()    ← young 区允许的最大 Region 数（含 GC Locker 扩展量）
eden_list_max_length   = young_list_max - survivor               ← 最大情况下 eden 可占的 Region 数
```

这里要注意 `young_list_max_length` 和 `young_list_length` 的区别：前者是策略允许的上限（预留了 GC Locker 激活时 young 区临时扩张的空间），后者是当前实际值。这个差异在 Step 3 中会体现。

**Step 2 — 计算 Used（line 324-329）**

Used 的含义是"已分配出去、正在使用的字节数"，直接基于 Region 数量 × Region 大小：

```
_eden_used    = eden_list_length × GrainBytes
_survivor_used = survivor_list_length × GrainBytes
```

`_overall_used` 来自 `_g1h->used_unlocked()`，是 G1CollectedHeap 实时维护的总已用量。`_old_used` 不是直接统计 old Region 数算出来的，而是从总用量中减去 young 用量得出——`subtract_up_to_zero` 兜底防止并发不一致导致的负值。

为什么 old 用量要用减法？因为 G1 不逐个记录 old Region 的占用字节数，只有总已用量（`_summary_bytes_used`）和 young Region 数量。old 用量只是一个"剩余值"。

**Step 3 — 计算 Committed（line 331-347）**

Committed 的含义是"JVM 已向 OS 申请、物理上已提交的内存容量"。这部分的计算是整个函数最绕的地方，核心思路是**总量锁定、依次分配**：

```
_overall_committed = _g1h->capacity();      // (1) 总量：当前已提交的总物理内存
committed = _overall_committed;              // (2) 本地变量开始"切蛋糕"
```

首先扣除 survivor 和 old 的 committed：

```
_survivor_committed = _survivor_used;        // survivor: 用多少算多少
_old_committed      = align_up(_old_used);   // old: 向上对齐到 region 边界
committed          -= survivor + old;         // (3) 剩下的 committed 预算
```

然后分配 eden 的 committed：

```
_eden_committed = eden_list_max_length × GrainBytes;   // (4) 按最大可能 young 区来预算
_eden_committed = MIN(_eden_committed, committed);     // (5) 但不能超过剩余预算
committed      -= _eden_committed;                     // (6) 扣掉 eden 已用的部分
```

(4) 使用的是 `max_length` 而不是 `length`。这意味着即使当前只有 2 个 eden Region，只要策略允许扩张到 10 个，eden_committed 就按 10 个 Region 来算。目的：避免 GC Locker 激活导致 young 区临时扩张时，jstat 的 committed 值突然跳变。

(5) `MIN2` 是安全兜底——如果物理总容量小于 max_length 的预算（比如堆很小），eden 不能超过实际可用内存。

最后，**所有剩余的 committed 预算全给 old**：

```
_old_committed += committed;                 // (7) 剩下的全归 old
```

(6) 之后 `committed` 还剩多少？`overall - survivor_committed - old_committed(原始) - eden_committed`。把这部分加回 `_old_committed`，最终得到：

```
_old_committed最终 = align_up(old_used) + (overall - survivor - align_up(old_used) - eden_committed)
                   = overall - survivor - eden_committed
```

这意味着 old 和 eden 在 physical committed 层面上**共享同一个空闲池**——哪个不够就从剩下的拿，这正是 G1 不维护物理分代边界的体现。

**Step 4 — 安全兜底（line 349-350）**

```
_eden_used = MIN2(_eden_used, _eden_committed);
```

因为 `_eden_used` 和 `_eden_committed` 的计算路径不同（前者用 `length`，后者用 `max_length`），如果 `_eden_used` 意外大于 `_eden_committed`（比如刚发生 GC，eden Region 数减少但 committed 还没来得及回收），将 used 硬 cap 到 committed，避免 jstat 显示 used > committed 的不合理状态。

### 5.3 jstat 视角：这些计算值最终映射到哪里

#### jstat -gc 输出

执行 `jstat -gc <pid>` 看到的每一列，背后都对应 G1MonitoringSupport 的一个字段：

```
 S0C    S1C    S0U    S1U      EC       EU        OC         OU       MC     MU    CCSC   CCSU   YGC    YGCT   FGC    FGCT   CGC    CGCT
 0.0   2048.0  0.0   1024.0  10240.0  5120.0   30720.0   15360.0    ...    ...    ...    ...    3      0.245  0      0.000  0      0.000
```

| jstat 列 | 含义 | G1MonitoringSupport 字段 | 取值说明 |
|----------|------|-------------------------|---------|
| S0C | survivor 0 容量 | `_from_counters` | G1 不用 s0，硬编码为 `pad_capacity(0)` |
| S1C | survivor 1 容量 | `survivor_space_committed()` → `_survivor_committed` | 当前 survivor Region 总容量 |
| S0U | survivor 0 已用 | `from_counters()->used()` | 固定 0 |
| S1U | survivor 1 已用 | `survivor_space_used()` → `_survivor_used` | `survivor_list_length × GrainBytes` |
| EC | eden 容量 | `eden_space_committed()` → `_eden_committed` | `min(eden_list_max_length × GrainBytes, 剩余预算)` |
| EU | eden 已用 | `eden_space_used()` → `_eden_used` | `eden_list_length × GrainBytes` |
| OC | old 容量 | `old_space_committed()` → `_old_committed` | 从总 committed 减去 young 后剩余 |
| OU | old 已用 | `old_space_used()` → `_old_used` | `overall_used - eden_used - survivor_used` |

**s0 固定为 0** 的原因是：G1 的复制算法只需要一个 to-space（s1），不需要传统 GC 的 from/to 角色交替。s0 只是为了迎合 jstat 期望 young gen 有 3 个 space 的格式而保留的占位符。

#### 构造时做了什么

G1MonitoringSupport 的构造函数（g1MonitoringSupport.cpp:78-180）做了三件事：

1. 调用 `recalculate_sizes()` 初始化所有字段
2. 创建 3 个 `CollectorCounters`（incremental / full / concurrent 三类 GC 次数和耗时计数器）
3. 创建 2 个 `GenerationCounters` + 4 个 `HSpaceCounters`，即上表映射到的 jstat 列

所有这些计数器受 `UsePerfData` 开关控制（见 [ch03/06 perfMemory_init](../ch03/06-main-thread-create.md#perfmemory_init--jstat-的共享内存文件)），默认打开。



---

## 6. G1StringDedup::initialize——默认不启动的去重引擎

```cpp
// g1StringDedup.cpp:39-42
void G1StringDedup::initialize() {
  StringDedup::initialize_impl<G1StringDedupQueue, G1StringDedupStat>();
}
```

`initialize_impl` 模板（stringDedup.inline.hpp:31-39）的核心就一个 `if`：

```cpp
template <typename Q, typename S>
void StringDedup::initialize_impl() {
  if (UseStringDeduplication) {        // 默认 false（globals.hpp:2586）
    _enabled = true;
    StringDedupQueue::create<Q>();     // 候选队列
    StringDedupTable::create();        // 去重哈希表
    StringDedupThreadImpl<S>::create();// 后台去重线程
  }
}
```

`UseStringDeduplication` 默认 `false`，所以 `initialize()` 实际是空操作——不创建任何组件，`_enabled` 保持 false。所有其他 `StringDedup` 方法（`gc_prologue`、`deduplicate` 等）都以 `assert(is_enabled())` 开头，未被激活时根本不会被调用。

### 6.1 去重机制（启用后）

字符串去重（JEP 192）的目标：<strong>让内容相同的 String 共享同一个 char[] 数组</strong>，减少堆内存占用。整体分两个阶段：

```
阶段 1（GC 暂停中）: 发现候选
  GC 标记/撤离对象时，对每个 String 对象检查：
    +- 是 String 实例？
    +- 年龄 ≥ StringDeduplicationAgeThreshold（默认 3，globals.hpp:2589）？
    +- 满足则把 String 加入 StringDedupQueue 候选队列
  （G1 的判据实现见 g1StringDedup.cpp:44-56）

阶段 2（GC 暂停后并发）: 执行去重
  StringDedupThread 后台线程从队列取候选：
    +- 用 String 的 char[] 内容做 key，查 StringDedupTable
    +- 命中：让该 String 指向已存在的 char[]，释放原数组 → 原数组可被 GC 回收
    +- 未命中：把当前 char[] 插入哈希表，供未来共享
```

三个组件的职责：

| 组件 | 职责 |
|---|---|
| `StringDedupQueue` | GC 暂停期间收集候选 String 的队列（每线程一个分片） |
| `StringDedupTable` | 全局哈希表，跟踪所有唯一 char[]，去重查找/插入 |
| `StringDedupThread` | 并发线程，消费队列执行去重（GC 暂停结束后启动） |

一个边界情况：**interned String**（`String.intern()` 的结果）在插入 StringTable 之前会被显式去重一次，之后如果又达到年龄阈值，还会再进一次候选队列——第二次去重注定失败（内容已在表中），但无法快速过滤，只能由它去。源码注释说明这种重复开销可接受，因为 interned 字符串数量通常远小于普通字符串。

---

## 7. PreservedMarksSet::init——撤离失败的"后悔药"

### 7.1 问题场景

G1 的撤离（evacuation）设计是"先标记、后搬运"：GC 找到存活对象后，将其从 from-space 复制到 to-space。但存在一个竞态——to-space 可能刚好不够了，某些对象**搬不走**，这就是**撤离失败（evacuation failure）**。

搬走和搬不走时，mark word 的命运截然不同：

```
正常撤离（成功）:
  from-space 对象               to-space 对象
  +------------------+         +------------------+
  | mark word: 原始值 |         | mark word: 原始值 |  ← 新对象保留原始内容
  |                  |  复制   |                  |
  |                  | ------→ |                  |
  |                  |         |                  |
  +------------------+         +------------------+
  +------------------+
  | forwarding ptr   |  ← 原对象的 mark word 被覆写为指向 to-space 的地址
  | → to-space       |      GC 遍历时通过它找到新位置
  +------------------+

撤离失败（空间不足）:
  from-space 对象
  +------------------+
  | forwarding ptr   |  ← mark word 一样被覆写
  | → 自己（self）    |     但这次没有新对象来保留原始值
  +------------------+
  原始 mark word --→ 丢了
```

mark word 在 HotSpot 中是一个字（64 位平台上 8 字节），承担多重职责：

| 模式 | 内容 |
|------|------|
| 无锁 | 偏向锁位 + 线程 ID + epoch + 分代年龄（4 bit）+ hash code（25 bit）+ unused |
| 轻量锁 | 指向栈上 `Lock Record` 的指针 |
| 重量锁 | 指向 `ObjectMonitor` 的指针 |
| GC 转发 | forwarding pointer（指向新地址或自指） |

覆写后原始信息全部丢失——偏向锁状态、GC 年龄、已计算的 identity hash code 全没了。后续如果其他线程用这个对象做锁操作或读 hashCode，行为就出错了。

`PreservedMarksSet` 就是为这个场景设计的"后悔药"：在覆写 mark word 之前，把原始值 push 到栈里保存，GC 结束后再逐条恢复。

### 7.2 初始化——分配栈数组

调用时 `num = ParallelGCThreads`。这是 JVM 的一个可调参数（`-XX:ParallelGCThreads=N`，默认根据 CPU 核数自动计算），控制的是**STW 暂停中执行撤离工作的并行 GC 线程**（对应 `G1CollectedHeap::_workers` WorkGang），**不是**并发标记线程（`ConcGCThreads`）。

```cpp
// preservedMarks.cpp:78-92
void PreservedMarksSet::init(uint num) {
  if (_in_c_heap) {
    _stacks = NEW_C_HEAP_ARRAY(Padded<PreservedMarks>, num, mtGC);
  } else {
    _stacks = NEW_RESOURCE_ARRAY(Padded<PreservedMarks>, num);
  }
  for (uint i = 0; i < num; i += 1) {
    ::new (_stacks + i) PreservedMarks();
  }
  _num = num;
}
```

这段代码做了三件事：

**第一件事——分配原始内存**。`NEW_C_HEAP_ARRAY(Padded<PreservedMarks>, num, mtGC)` 在 C 堆上分配一段连续内存，大小为 `num × sizeof(Padded<PreservedMarks>)`。`_in_c_heap = true`（G1 构造函数传的），走 C 堆路径。`else` 分支走 ResourceArea 分配，供 Serial/CMS 等使用。分配的结果是一个裸指针 `Padded<PreservedMarks>*`——内存块已就绪，但每个槽位上的 `PreservedMarks` 对象尚未构造。

**第二件事——placement new 构造每个元素**。`::new (_stacks + i) PreservedMarks()` 在已分配内存的偏移 `i` 处调用 `PreservedMarks` 的构造函数。如果不做这一步，直接访问 `_stacks[i]` 会读到未初始化的栈对象（其中的 `Stack` 内部的 top/segment 指针全野），push 操作会直接 crash。

**第三件事——记录元素数量并验证**。`_num = num` 记录数组长度；`assert_empty()` 遍历所有栈确认它们初始确实是空的。

初始化后，每个 GC worker 通过 `_stacks[worker_id]` 访问自己的栈。互不干扰。

注意这里的数据结构层级：

```
PreservedMarksSet
  +-- _stacks: Padded<PreservedMarks>[]   ← 一个数组，长度 = ParallelGCThreads
        +-- _stacks[0]: PreservedMarks     ← Worker 0 的
        |     +-- _stack: Stack<OopAndMarkOop>  ← 唯一的一个栈
        +-- _stacks[1]: PreservedMarks     ← Worker 1 的
        |     +-- _stack: Stack<OopAndMarkOop>
        +-- ...
```

`_stacks` 数组名虽然带复数，但每个元素存的是一个 `PreservedMarks` 对象，对象内部只有一个 **Stack**。`_stacks[worker_id]._stack` 才是那个真正的栈容器。

#### Stack 的内部结构

`Stack<OopAndMarkOop>` 是**分段链表栈**（segment-linked stack，stack.hpp:58-165）。它的元素类型 `E = OopAndMarkOop`（preservedMarks.hpp:38-48），是 `(对象指针, 原始 mark word)` 对：

```cpp
class OopAndMarkOop {
  oop     _o;  // 8 字节，指向撤离失败的 Java 对象
  markOop _m;  // 8 字节，该对象原始的 mark word
};
```

每个元素 16 字节——`push` 时保存一对，`pop` 时取出恢复。

Stack 不预先分配一整块连续内存，而是按需分配固定大小的段（segment），段与段之间通过链表指针连接：

```
     +--------------+     +--------------+     +--------------+
     |  elements[0]  |     |  elements[0]  |     |  elements[0]  |
     |  elements[1]  |     |  elements[1]  |     |  elements[1]  |
     |  ...          |     |  ...          |     |  ...          |
     |  elements[N]  |     |  elements[N]  |     |  elements[N]  |
     +--------------+     +--------------+     +--------------+
     |  link -------+----→|  link -------+----→|  link = NULL  |
     +--------------+     +--------------+     +--------------+
       ↑ _cur_seg           (middle segment)      (bottom segment)
       当前段（top）
```

关键字段（stack.hpp:79-85, 162-164）：

| 字段 | 类型 | 含义 |
|------|------|------|
| `_cur_seg` | `E*` | 指向当前段（栈顶）的指针。空栈时为 NULL |
| `_cur_seg_size` | `size_t` | 当前段中已用的元素数 |
| `_full_seg_size` | `size_t` | 已填满的段中元素总数 |
| `_seg_size` | `size_t` | 每个段能容纳的元素数（常量） |
| `_cache` | `E*` | 缓存段链表头。`pop_segment` 释放的段优先入缓存 |
| `_max_cache_size` | `size_t` | 最多缓存几个段 |

**段（segment）的布局**：一个段是一块连续内存（stack.inline.hpp:103-113）：

```
+----------------------+
| elements[0]          |
| elements[1]          |
| ...                  |
| elements[_seg_size-1]|  ← _seg_size 个元素
+----------------------+
| link (E*)            |  ← 指向前一段的指针（链表）
+----------------------+
```

段的大小计算：`segment_bytes() = align_up(_seg_size × sizeof(E), sizeof(E*)) + sizeof(E*)`。对于 `OopAndMarkOop`（16 字节）：

```
_default_segment_size = (4096 - 2 × 8) / 16 = 255   // 一个段约 4K
segment_bytes         = align_up(255 × 16, 8) + 8 = 4088  // 不超过 4K
```

**push 流程**（stack.inline.hpp:61-69）：

```
push(item):
  if (_cur_seg_size == _seg_size):      // 当前段满了
    push_segment()                       //   分配新段，设 _cur_seg = 新段
  _cur_seg[_cur_seg_size] = item        // 写入元素
  _cur_seg_size++
```

`push_segment()` 优先从 `_cache` 取缓存的段（stack.inline.hpp:152-170），缓存无可用时才 `NEW_C_HEAP_ARRAY` 分配。因为 `max_cache_size = 0`，取缓存分支永远不命中，每次都新分配。

**pop 流程**（stack.inline.hpp:71-81）：

```
pop():
  _cur_seg_size--                       // 弹出
  if (_cur_seg_size == 0):              // 当前段空了
    pop_segment()                        //   缓存/释放当前段，_cur_seg = link 指向前一段
```

`pop_segment()` 先尝试将段加入 `_cache`（stack.inline.hpp:173-189），`_cache_size` 达到 `_max_cache_size`（= 0）后直接 `free`。

**初始状态**：构造函数调 `reset(true)`（stack.inline.hpp:205-214）：

```cpp
_cur_seg      = NULL;
_cur_seg_size = _seg_size;    // 让第一次 push 触发 push_segment 分配新段
_full_seg_size = 0;
_cache        = NULL;
_cache_size   = 0;
```

所以空的 `Stack` 不占用任何段内存——第一个 `push` 才分配第一个 4K 段。

### 7.3 Padded——为什么需要垫到 64 字节

**问题：相邻元素的缓存行冲突**

`Stack<OopAndMarkOop, mtGC>` 有两个虚函数（`virtual alloc` / `free`，stack.hpp:150-151）用于段内存分配，因此对象自身带有 vptr。`PreservedMarks` 仅包裹一个 `Stack _stack` 成员，不考虑编译器实现差异的话 sizeof 量级在数十字节。

如果不加 padding，数组中相邻元素会挤在同一或相邻的缓存行上。Worker 0 和 Worker 1 各自 push 时都要写自己的栈——两个物理核心各持该缓存行的副本，其中一个写会 invalidate 另一个的副本（MESI 协议），导致 cache line 在核心间反复 bouncing。这就是 false sharing。

**Padded 的解法：大幅拉开间距**

```cpp
template <class T, size_t alignment = DEFAULT_CACHE_LINE_SIZE>
class Padded : public T {
 private:
  char _pad_buf_[PADDING_SIZE(T, alignment)];
};
```

`Padded` 使用 `PADDING_SIZE` 宏（padded.hpp:35-36），它的公式并非简单的"补齐到缓存行"，而是**额外多给一个 alignment**：

```
PADDING_SIZE(T, alignment) = alignment + align_up(sizeof(T), alignment)
```

这样 `sizeof(Padded<T>) = sizeof(T) + alignment + align_up(sizeof(T), alignment)`，确保无论数组基地址是否对齐到缓存行，相邻元素之间都隔着至少一个完整的缓存行间距。

对比：还有一个更保守的 `PaddedEnd`（padded.hpp:77-81），它用 `PADDED_END_SIZE`（`align_up(sizeof(T), alignment) - sizeof(T)`）只补齐到缓存行边界——但这要求基地址本身已对齐。`PreservedMarksSet` 选用 `Padded` 而非 `PaddedEnd`，因为它的分配来自 `NEW_C_HEAP_ARRAY`（通过 `os::malloc`，仅保证 16 字节对齐），基地址不一定在 64 字节边界上，因此采用更激进的间距策略。

**`max_cache_size = 0` 的设计意图**

```cpp
inline PreservedMarks::PreservedMarks()
    : _stack(OopAndMarkOopStack::default_segment_size(),
             0 /* max_cache_size */) { }
```

`Stack` 在元素超出初始 segment 时会分配新的 segment。参数 `max_cache_size` 控制 `pop` 后空闲 segment 的缓存上限。设为 0 表示"释放后立刻归还，不缓存任何空闲 segment"。这是因为 `PreservedMarks` 只在 GC 暂停期间存活——GC 结束后恢复所有 mark，整个栈被丢弃，缓存空闲 segment 没有意义，反而浪费内存。

### 7.4 运行时流程

```
撤离失败时（G1 evacuation handling）:
  preserve_mark_during_evac_failure(obj, mark) 
    → worker_id = 当前线程的 GC worker ID
    → _stacks[worker_id].push(OopAndMarkOop(obj, mark))
    → obj->forward_to(obj)  // 设 self-forwarding-pointer

GC 结束后:
  ParRestoreTask::work(worker_id)
    → 遍历所有 worker 的 stacks
    → 对每个 OopAndMarkOop: obj->set_mark_raw(original_mark)
    → stack 自动析构释放
```

---

## 8. G1CollectionSet::initialize——CSet 索引数组

```cpp
// g1CollectionSet.cpp:94-98
void G1CollectionSet::initialize(uint max_region_length) {
  _collection_set_max_length = max_region_length;
  _collection_set_regions = NEW_C_HEAP_ARRAY(uint, max_region_length, mtGC);
}
```

分配一个 `uint[max_regions()]` 的 C 堆数组，用于存储**本次 GC 要收集的 Region 的编号**（`hrm_index`）。`max_regions()` 是堆的最大 Region 数（`max_capacity() / HeapRegion::GrainBytes`）。

运行时写入（g1CollectionSet.cpp:114）：
```cpp
_collection_set_regions[_collection_set_cur_length++] = hr->hrm_index();
```
每次向 CSet 加入一个 Region（eden/survivor/old），就把它的 `hrm_index` 写入数组。

运行时读取（g1CollectionSet.cpp:188）：
```cpp
HeapRegion* r = _g1h->region_at(_collection_set_regions[cur_pos]);
```
GC 暂停中，各 worker 线程并行遍历这个数组，用 `region_at(index)` 拿到 `HeapRegion*` 后执行 evacuation。

`G1CollectionSet` 在 `G1CollectedHeap` 构造函数（line 1432）中作为内嵌成员（非指针）构造：

```cpp
_collection_set(this, _g1_policy),
```

此时 `_collection_set_regions = NULL`、`_collection_set_cur_length = 0`、`_collection_set_max_length = 0`。`initialize()` 把数组真正分配出来。

注意：**这个数组在初始化阶段"一次性"分配最大容量**，运行时不再扩容。`_collection_set_cur_length` 跟踪实际已加入 CSet 的 Region 数量，`_collection_set_regions[0..cur_length-1]` 是有效的 Region 索引。

GC 暂停时的 CSet 构建流程：
1. `finalize_young_part()`：根据预测停顿时间模型，选择 eden + survivor Region
2. `finalize_old_part()`：从 `CollectionSetChooser` 中选取 old Region
3. 选中的 Region 的 `hrm_index` 依次填入 `_collection_set_regions[]`

---

## 9. 完成——return JNI_OK

第 1734 行的 `return JNI_OK` 标志着 `G1CollectedHeap::initialize()` 的全部工作完成。此时堆可以接受 mutator 分配请求。

但从"可以接受分配"到"第一次 GC 发生"之间，还有 `G1CollectedHeap::post_initialize()`（line 1775）需要执行——它激活了 `G1ConcurrentMark` 的并发线程、注册 MemoryPool MXBean 等。不过那已经是运行时的准备，而非堆本身的初始化。

---

## 本章总结

| 行号 | 代码 | 做了什么 | 为什么重要 |
|------|------|---------|-----------|
| 1711 | `get_dummy_region()` | 在 region 0 构造一个满 HeapRegion | 为分配器提供不可为 NULL 的初始状态 |
| 1717-1719 | `set_eden(); set_top(end())` | 标记为 young，填满 | 绕过了 BOT 断言，使所有分配都失败 |
| 1720 | `G1AllocRegion::setup()` | 设静态 `_g1h`、`_dummy_region` | 所有分配器实例共享 |
| 1722 | `init_mutator_alloc_region()` | `_alloc_region` 从 NULL → dummy | 分配器就绪，可接收分配请求 |
| 1726 | `new G1MonitoringSupport(this)` | 创建 jstat/JMX 计数器 | 让 jstat 能看见 G1 的分代信息 |
| 1728 | `G1StringDedup::initialize()` | 空方法（默认关） | 预留去重能力，系统按需启用 |
| 1730 | `_preserved_marks_set.init(ParallelGCThreads)` | 分配 Padded 栈数组 | 撤离失败的"后悔药" |
| 1732 | `_collection_set.initialize(max_regions())` | 分配 CSet uint 数组 | GC 时存放待收集 Region 索引 |
| 1734 | `return JNI_OK` | 初始化完成 | 堆可接受分配 |

**设计模式提炼**：

1. **Null Object Pattern**：Dummy Region 就是 `G1AllocRegion` 的 Null Object——消除了 `_alloc_region == NULL` 的判断，简化了所有分配路径
2. **静态共享只读数据**：`_dummy_region` 和 `_g1h` 设为静态，省去每个分配器实例的冗余存储
3. **从物理推断逻辑**：`G1MonitoringSupport::recalculate_sizes()` 从 Region 数量推算分代容量，是对不连续 Region 的"分代假象"封装
4. **Cache Line 感知**：`Padded<PreservedMarks>` 避免多 worker 并行 push mark 时的 false sharing

> **下一篇**：[12b 补章](12b-compressed-oops-and-tlab.md)——`initialize_heap()` 剩余阶段 (3)(4)(5)（TLAB 上限、压缩指针、TLAB 启动），随后是 [ch10 总结](12-summary.md)。
