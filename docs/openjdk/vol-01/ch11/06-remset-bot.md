# G1 跨 Region 引用：RemSet + BOT + CSet 快速测试

> **本文定位**：`G1CollectedHeap::initialize()` 中段（`g1CollectedHeap.cpp:1640-1659`）。跟着执行流走：G1RemSet 创建 → BOT 创建 → CSet 快速测试位图初始化。
>
> **前置依赖**：[ch11/05](05-memory-layout-mapper.md)（CardTable + 写屏障 + 6 Mapper + HRM）。

---

## 1. 执行位置

写屏障和 6 Mapper 创建完后，`initialize()` 创建跨 Region 引用追踪的基础设施（`g1CollectedHeap.cpp:1640-1659`）：

```cpp
HeapWord* start = _hrm.reserved().start();
HeapWord* end = _hrm.reserved().end();
size_t granularity = HeapRegion::GrainBytes;

// 1. RemSet 创建 + initialize（内部初始化 G1FromCardCache）
_g1_rem_set = new G1RemSet(this, _card_table, _hot_card_cache);
_g1_rem_set->initialize(max_capacity(), max_regions());

// 2. BOT 创建
_bot = new G1BlockOffsetTable(reserved_region(), bot_storage);

// 3. CSet 快速测试位图 + Humongous 回收候选位图
_in_cset_fast_test.initialize(start, end, granularity);
_humongous_reclaim_candidates.initialize(start, end, granularity);
```

---

## 2. G1RemSet——dirty card 的消费者（全局协调器）

### 2.1 G1RemSet vs RSet——两个不同的东西

**先区分两个容易混淆的概念**：

- **G1RemSet**——全局协调器（1 个实例，`_g1_rem_set`）。消费 dirty card，扫描里面的引用，把引用关系**写入目标 Region 的 RSet**。它自己不存储引用关系。
- **RSet（HeapRegionRemSet）**——每个 Region 持有的入引用索引（2048 个实例，每个 Region 一个）。记录"哪些其他 Region 的哪些 card 引用了我"。详见 Section 3。

```
G1RemSet（全局，1 个）
  ├── 消费 dirty card → 扫描引用 → 调 to_region.rem_set().add_reference(from)
  │                                      ↓
  │                              写入目标 Region 的 RSet
  │
  └── 协调 GC 期间的并行扫描（_scan_state）

HeapRegionRemSet（per-Region，2048 个）= RSet
  └── OtherRegionsTable 三层存储（Sparse/Fine/Coarse）
      └── 记录"哪些 card 引用了我"
```

**G1 回收 Region X 时**——扫 Region X 的 RSet（HeapRegionRemSet），找到所有指向它的引用，不用全堆扫描。G1RemSet 是"往 RSet 里写数据"的协调器，不是 RSet 本身。

#### RSet 全貌——从外到内的层次

每个 Region 持有一个 RSet，类名是 **`HeapRegionRemSet`**（`heapRegionRemSet.hpp:170`）：

```
每个 HeapRegion 持有 1 个 RSet:
  _rem_set: HeapRegionRemSet                          ← 每个 Region 一个
    │
    ├── _other_regions: OtherRegionsTable              ← 三层存储（Section 3）
    │     ├── _coarse_map: CHeapBitMap                 ← Coarse（1 bit/from-Region）
    │     ├── _fine_grain_regions: PerRegionTable*[]   ← Fine（哈希表，256 桶）
    │     │     └── PerRegionTable._bm: BitMap[8192]   ← 每个 from-Region 的 card 位图
    │     └── _sparse_table: SparsePRT (RSHashTable)   ← Sparse（哈希表）
    │           └── SparsePRTEntry[]                   ← 每个 Entry 存 4 个 card_index
    │
    ├── _state: RemSetState                            ← 状态机
    └── _code_roots: G1CodeRootSet                     ← JIT 代码引用

全局（1 个实例，不属于任何 Region）:
  G1RemSet（Section 2）                                ← 消费 dirty card，写入各 Region 的 RSet
  G1FromCardCache（Section 4）                         ← add_reference 最热路径缓存（全局静态）
```

**定位**——本文 Section 2 讲全局协调器（G1RemSet），Section 3.1-3.2 讲三层存储结构，Section 3.3 讲最热路径缓存（G1FromCardCache），Section 3.4 讲 add_reference 退化路径，Section 3.5 讲 RSet 外层包装（HeapRegionRemSet）。

### 2.2 类结构

```cpp
class G1RemSet : public CHeapObj<mtGC> {
  G1RemSetScanState* _scan_state;      // GC 暂停期间的扫描状态
  G1CollectedHeap*   _g1h;             // 堆引用
  G1CardTable*       _ct;              // 卡表
  G1Policy*          _g1p;             // 策略
  G1HotCardCache*    _hot_card_cache;  // 热卡缓存
  size_t             _num_conc_refined_cards;  // 并发 refined 卡计数（日志用）
};
```

G1RemSet 本身是薄壳——7 个字段，核心逻辑在 `refine_card_concurrently`（G1RemSet 的方法，消费 dirty card）和 `OtherRegionsTable`（HeapRegionRemSet 的内部组件，存储引用，详见 Section 3）。

### 2.3 refine_card_concurrently——7 步消费 dirty card

ConcurrentRefine 线程从 DCQ 取出 dirty card 后，调 `refine_card_concurrently`（`g1RemSet.cpp:539-671`）：

```
步骤 1: 脏检查 —— *card_ptr != dirty？直接返回（已被并发处理）
步骤 2: 定位 Region —— addr_for(card_ptr) → heap_region_containing(addr)
步骤 3: Region 类型过滤 —— 非 old/humongous？返回（young/free 卡丢弃）
步骤 4: HotCardCache 插入 —— insert(card_ptr)
         → 返回 NULL（缓存了）→ 返回
         → 返回原卡（不热）→ 继续
         → 返回旧卡（驱逐）→ 用旧卡继续
步骤 5: trim 到 top —— scan_limit = r->top()，若 <= start 是过期卡 → 返回
步骤 6: 清卡 + fence —— *card_ptr = clean + OrderAccess::fence（保证先清后读 top）
步骤 7: 扫描引用 —— r->oops_on_card_seq_iterate_careful(dirty_region, &cl)
         → closure 内对每个引用调 to->rem_set()->add_reference(from)（详见 Section 3）
         → 更新目标 Region 的 RSet
         → 失败则重新 dirty + 入队
```

**步骤 7 是核心**——扫描 dirty card 里的对象，找到跨 Region 引用，更新目标 Region 的 RSet。

### 2.4 refine_card_during_gc——GC 暂停期间的版本

GC 疏散暂停期间，GC worker 线程调 `refine_card_during_gc`（`g1RemSet.cpp:673`）——和并发版本类似，但：
- 不走 HotCardCache（GC 期间缓存已禁用）
- 走 `_scan_state`（`G1RemSetScanState`）协调多 worker 并行扫描
- 用 `claimed_card` / `deferred_card` 防重复处理（详见 ch11/05 卡值状态）

**GC Worker 消费脏卡的前置步骤**：
1. **`concatenate_logs`**——GC 暂停开始前（`prepare_for_oops_into_collection_set_do`），把所有线程 thread-local 的 partial buffer 提交到全局 DCQS 的 completed list，确保所有脏卡对 GC 可见（`g1RemSet.cpp:511-513`）
2. **先消费 HCC（ScanHCC）**——`iterate_hcc_closure` 排空 HotCardCache，把缓存的脏卡也处理掉
3. **再消费 DCQS（UpdateRS）**——`iterate_dirty_card_closure` 消费 DCQ 的 completed buffers

先 HCC 后 DCQS 的顺序保证热卡优先处理——HCC 里是计数达到阈值的"热"卡，延迟到 GC 期间集中处理。

### 2.5 G1RemSetScanState——GC 期间的并行扫描协调

`G1RemSetScanState`（定义在 `g1RemSet.cpp:55-280`，不是独立头文件）是 GC 暂停期间的扫描状态，**只创建 1 个实例**（G1RemSet 持有 `_scan_state`），但它内部有 **per-Region 数组**按 Region index 索引：

```cpp
class G1RemSetScanState {
  size_t              _max_regions;          // Region 总数（= 2048）
  G1RemsetIterState*  _iter_states;          // 数组：[region_0, region_1, ...]——每 Region 的扫描状态
  size_t*             _iter_claims;          // 数组：[region_0, region_1, ...]——每 Region 当前扫描进度
  uint*               _dirty_region_buffer;  // GC 期间累积的脏 Region 列表
  IsDirtyRegionState* _in_dirty_region_buffer; // 去重标记
  size_t              _cur_dirty_region;     // 脏 Region 计数
  HeapWord**          _scan_top;             // 数组：[region_0, region_1, ...]——每 Region 的扫描上限（不在 CSet + old/humongous → top()，否则 → bottom()，详见下文）
};
```

**不是每个 Region 一个 ScanState，而是 1 个 ScanState 内部用数组管理 2048 个 Region 的状态。**

**两个核心数组的每个元素存什么**：

**`_iter_states[i]`**（`G1RemsetIterState`，三态机）：
| 值 | 状态 | 含义 | 谁设置 |
|---|---|---|---|
| 0 | Unclaimed | 还没有 worker 认领这个 Region | 初始值（reset 时全设 0） |
| 1 | Claimed | 有 worker 正在扫描这个 Region | worker 用 CAS 从 0→1 抢占 |
| 2 | Complete | 这个 Region 扫描完毕 | worker 用 CAS 从 1→2 标记完成 |

**`_iter_claims[i]`**（`size_t`，扫描进度）：
- 存的是 **card index**——表示"这个 Region 当前扫描到第几张 card"
- 初始值：Region 的第一张 card index
- worker 扫描过程中递增：处理完一批 card 后更新到下一个位置
- 作用：**多 worker 并发抢 card block**——用 `Atomic::add(step, &_iter_claims[i])` 原子递增（源码 `g1RemSet.cpp:238-239`），每个 worker 获得互不重叠的 `[claimed, claimed+step)` 区间。多个 worker 可以并发处理同一个 Region 的不同 card block，通过原子操作保证不重叠

**具体例子**——Region 5 有 400 张 card，两个 worker 并发处理：

```
初始: _iter_states[5]=0(Unclaimed), _iter_claims[5]=0

Worker A: CAS _iter_states[5] 从 0→1 → 成功，成为"认领者"
          add_dirty_region(5)（由认领者做，只做一次）
          Atomic::add(100, &_iter_claims[5]) → 得到 0，抢占 card 0~99
          Atomic::add(100, &_iter_claims[5]) → 得到 100，抢占 card 100~199

Worker B: CAS _iter_states[5] 从 0→1 → 失败（已被 A 认领）
          不需要做 add_dirty_region（已由 A 做）
          Atomic::add(100, &_iter_claims[5]) → 得到 200，抢占 card 200~299
          Atomic::add(100, &_iter_claims[5]) → 得到 300，抢占 card 300~399

两个 worker 并发抢 card block，互不重叠 → 扫描完毕后
第一个完成的 worker: CAS _iter_states[5] 从 Claimed→Complete → 成功 → scan_strong_code_roots
另一个 worker: CAS _iter_states[5] 从 Claimed→Complete → 失败（已被设为 Complete）
```

**`_iter_states` 和 `_iter_claims` 的分工**：
- `_iter_states` CAS 0→1：**认领者**做一次性操作（`add_dirty_region`），其他 worker 跳过一次性操作但继续参与并发扫描
- `_iter_claims` Atomic::add：**所有 worker** 通过原子加法抢 card block，互不重叠地并发扫描同一个 Region

**为什么需要 ScanState**——GC 回收 CSet 时，多个 GC worker 需要并行分工扫描。`_iter_states` 用 CAS 标记"谁第一个认领"（用于一次性操作），`_iter_claims` 用 `Atomic::add` 让多个 worker 并发抢同一个 Region 的不同 card block。需要协调：
1. **谁做一次性操作**——`_iter_states` 三态机：`Unclaimed`(0) → `Claimed`(1) → `Complete`(2)。CAS 0→1 成功的 worker 执行一次性操作（`add_dirty_region`），其他 worker 跳过但不退出——继续参与 card 级并发扫描
2. **抢 card block**——`_iter_claims` 用 `Atomic::add(step, ...)` 原子递增，每个 worker 获得互不重叠的 card block 区间，实现同一个 Region 内多 worker 并发扫描
3. **哪些 Region 有脏卡**——`_dirty_region_buffer` 累积 GC 期间发现的脏 Region，`_in_dirty_region_buffer` 去重
4. **top 快照**——`_scan_top` 在 GC 开始时快照每个 Region 的 top，过滤"top 以下的卡才需要扫描"（避免扫到 GC 期间新分配的对象）

**其余 4 个字段的类型和数组元素内容**：

**`_dirty_region_buffer`**（`uint*`，数组）——每个元素存一个 **Region index**（uint），表示"这个 Region 有脏卡需要处理"。`refine_card_during_gc` 处理 dirty card 时，如果发现某个 Region 有需要处理的脏卡，通过 `add_dirty_region(idx)` 把它的 index 追加到数组中。数组大小 = `_cur_dirty_region`。

**`_in_dirty_region_buffer`**（`IsDirtyRegionState*`，数组）——每个元素和 Region 一一对应（即 `_in_dirty_region_buffer[5]` 对应 Region 5），存去重状态：
- `Clean(0)`——这个 Region 还没有加入 `_dirty_region_buffer`
- `Dirty(1)`——这个 Region 已在 `_dirty_region_buffer` 中，跳过不重复加入

**`_cur_dirty_region`**（`size_t`，标量）——当前 `_dirty_region_buffer` 里的脏 Region 计数。初始为 0，每次 `add_dirty_region` 成功去重后递增。

**`_scan_top`**（`HeapWord**`，指针数组）——每个元素是一个 `HeapWord*` 指针，标记对应 Region 的**扫描上限**。

**先理解 RSet 扫描的方向**——GC 回收 CSet 时，需要找到"谁引用了 CSet Region"。流程是：
1. 遍历 CSet Region 的 RSet（RSet 存的是"哪些其他 Region 的哪些 card 引用了我"）
2. RSet 返回一堆 card index——这些 card index 指向的是**其他 Region**（old/humongous Region）的 card
3. 去那些 old/humongous Region 里**扫描这些 card**，找到具体的引用关系

`_scan_top` 控制的就是第 3 步——哪些 Region 值得作为"扫描目标"：

- `_scan_top[i] = r->top()` —— Region i 是 **old/humongous 且不在 CSet 中**。它可能引用了 CSet Region（RSet 里可能有指向它的 card），所以需要作为扫描目标去扫它的 card。
- `_scan_top[i] = r->bottom()` —— Region i **在 CSet 中 / young / free**。**CSet Region 之间的引用在 evacuate 时天然就会被处理**（evacuate 会遍历 CSet Region 的所有对象和引用），不需要通过 RSet 来追踪。young Region 会被整体回收；free/archive 没有引用关系。

**`!r->in_collection_set()` 是关键**——同样两块 Region 互相引用，只有**不在 CSet 中的那个**需要通过 RSet 来记录"我引用了 CSet Region"。CSet 内部的引用在 evacuate 过程中自然处理，不需要 RSet。

**例子**——Region 5（old，不在 CSet）引用了 Region 3（old，在 CSet）：
```
RSet[3] 里记录了 "Region 5 的 card 10 引用了我"
GC 扫描 RSet[3]:
  → 得到 card index 10，定位到 Region 5
  → 查 _scan_top[5] = Region 5 的 top() → 有效（因为 Region 5 是 old 且不在 CSet）
  → 去 Region 5 的 card 10 里扫描引用 → 找到具体引用关系 → OK
```
如果 Region 5 **在 CSet 中**（和 Region 3 一样在 CSet）：
```
RSet[3] 里记录了 "Region 5 的 card 10 引用了我"
  → 查 _scan_top[5] = bottom() → top ≤ bottom → 跳过
  → 不扫描！因为 Region 3 和 Region 5 都在 CSet 中，evacuate 时会遍历两者的所有引用——Region 5→Region 3 的引用在 evacuate 中自然会被正确处理，不需要通过 RSet 额外追踪
```

**设置时机**——每次 GC 暂停开始时（`prepare_for_oops_into_collection_set_do` 调用 `reset()`），遍历所有 Region 执行判断（`g1RemSet.cpp:127-141` 的 `G1ResetScanTopClosure`）：

```cpp
class G1ResetScanTopClosure : public HeapRegionClosure {
  HeapWord** _scan_top;
  virtual bool do_heap_region(HeapRegion* r) {
    uint hrm_index = r->hrm_index();
    if (!r->in_collection_set() && r->is_old_or_humongous()) {
      _scan_top[hrm_index] = r->top();    // ← 关键条件：不在 CSet + old/humongous
    } else {
      _scan_top[hrm_index] = r->bottom(); // CSet 中 / young / free → 底
    }
    return false;
  }
};
// _g1h->heap_region_iterate(&cl) → 对每个 Region 回调 do_heap_region
```

**`!r->in_collection_set()` 是关键**——CSet 中的 Region 会被整体疏散，它的 card 不需要作为扫描目标。只有**不在 CSet 中的 old/humongous Region** 才需要扫描它的 card（因为它可能引用了 CSet Region）。

**关键条件**：不是简单的"old/humongous→top, young→bottom"。即使 humongous Region，如果**在 CSet 中**也设 bottom（CSet Region 不需要 RSet 扫描——会被整体处理）。只有**不在 CSet 中 + old/humongous**才真正需要扫描。

**四个字段的协作流程**：
```
refine_card_during_gc 处理 card → 发现 Region X 有脏卡
  → add_dirty_region(X)
    → 查 _in_dirty_region_buffer[X] == Clean(0)？
    → 是 → _dirty_region_buffer[_cur_dirty_region++] = X（存 Region index）
           _in_dirty_region_buffer[X] = Dirty(1)（去重标记）
    → 否（已 Dirty）→ 跳过

GC 扫描阶段:
  遍历 _dirty_region_buffer[0.._cur_dirty_region)
    → 对每个脏 Region X，检查 _scan_top[X]
      → _scan_top[X] > bottom → 有区域需要扫描
      → _scan_top[X] ≤ bottom → young Region，跳过
```

**扫描流程**：
```
GC 开始: ScanState.reset() —— 所有 Region 重置为 Unclaimed
  ↓
每个 GC worker:
  1. claim_iter(region) —— CAS Unclaimed→Claimed，成功则扫描该 Region
  2. 遍历 Region 的 RSet 里记录的 card（引用方的 card，不是 dirty card）
  3. 对每张 card 调 refine_card_during_gc
  4. set_iter_complete(region) —— CAS Claimed→Complete
  5. 继续找下一个 Unclaimed 的 Region
  ↓
GC 结束: 并发清非 survivor 区域的卡表（G1ClearCardTableTask）
```

---

## 3. OtherRegionsTable——RSet 的三层存储

### 3.1 为什么需要三层

一个 Region 可能被很多其他 Region 引用。引用密度不同时，用不同数据结构存储最省内存——按 **每个 from-Region 有多少张 card 引用本 Region** 来决定（默认值，`g1_globals.hpp:162-181`）：

| 条件 | 用什么 | 为什么 |
|---|---|---|
| **≤ 4 个 card**（`G1RSetSparseRegionEntriesBase=4`） | Sparse（稀疏表） | 每个 from-Region 最多存 4 个 card_index，省内存，不需要 1KB 的 BitMap |
| **> 4 个 card，Fine 哈希表未满** | Fine（细粒度 BitMap） | Sparse 存不下，升级到 PerRegionTable（1KB BitMap，正好覆盖一个 4MB Region 的全部 8192 张 card） |
| **Fine 哈希表满（默认 256 个不同的 from-Region，`G1RSetRegionEntriesBase=256`）** | Coarse（粗粒度 1 bit） | Fine 哈希表固定 256 个桶，每个桶对应一个不同的 from-Region。当 256 个不同的 from-Region 都引用了本 Region 时哈希表满——采样 evict 退化到 1 bit |

**Fine 哈希表本质上是二维数组**：
```
_fine_grain_regions[256]           ← 第一维：最多 256 个不同的 from-Region（哈希表桶数）
  └── PerRegionTable
        └── _bm: CHeapBitMap[8192] ← 第二维：每个 from-Region 最多 8192 张 card（BitMap 正好覆盖）
```
第一维上限 = 256（哈希表桶数），第二维上限 = CardsPerRegion（8192）。BitMap 固定 1KB，刚好覆盖一个 Region 的全部 card，不存在"不够用"——只是不同 from-Region 太多（>256）会 evict 退化到 Coarse。

### 3.2 三层结构

每个 Region 的 RSet（`HeapRegionRemSet`）持有一个 `OtherRegionsTable`（`heapRegionRemSet.hpp:74`），内部三层：

#### Sparse（稀疏）——每个 from-Region ≤4 个 card 时用

```cpp
class SparsePRT {
  RSHashTable* _cur;   // 当前活跃的哈希表
  RSHashTable* _next;  // 双缓冲——_cur 满时切换到 _next（expand），_cur 清空后变为新的 _next
};

class RSHashTable {
  SparsePRTEntry* _entries;  // entry 数组
  int*            _buckets;  // 哈希桶（存 entry index）
  int             _free_list; // 空闲 entry 链表
  int             _occupied_entries; // 当前已使用的 entry 数
};

class SparsePRTEntry {
  uint   _region_ind;    // from-Region index（哪个 Region 引用了本 Region）
  int    _next_index;    // 哈希冲突链的下一个 entry
  int    _next_null;     // 当前已存几个 card（≤ 4）
  size_t _cards[4];      // 变长数组——存 card_index（G1RSetSparseRegionEntries=4）
};
```

**结构**——RSHashTable 是一个哈希表，可以包含**多个 SparsePRTEntry**（每个 Entry 对应一个不同的 from-Region）。Entry 之间通过 `_next_index` 串成哈希冲突链：

```
_buckets[hash] → Entry(Region1, cards[2,5,8,9]) → Entry(Region5, cards[3]) → ...
                   ↑                                    ↑
            最多 4 个 card_index                    最多 4 个 card_index
```

**特点**——每个 from-Region 最多存 4 个 card_index。超过 4 个 → `add_card` 返回 `overflow` → 升级到 Fine。不同 from-Region 的 Entry 不受限制——除非哈希表满了（RSHashTable 容量有上限），但可以通过 expand 扩容。

#### Fine（细粒度）——中等引用时用

```cpp
class PerRegionTable : public CHeapObj<mtGC> {
  HeapWord*     _region;     // from-Region 起始地址
  CHeapBitMap   _bm;         // card 位图——每个 bit 对应一张 card
  PerRegionTable* _next;     // 哈希冲突链
  PerRegionTable* _prev;     // 双向链表（用于 bulk free）
  // 全局 free list 复用——避免反复 malloc/free
};
```

OtherRegionsTable 持有：
```cpp
PerRegionTable** _fine_grain_regions;  // 哈希表（桶数 = _max_fine_entries，默认 256）
size_t           _n_fine_entries;      // 当前 Fine 条目数
PerRegionTable*  _first_all_fine_prts; // 双向链表头（用于遍历/evict）
PerRegionTable*  _last_all_fine_prts;  // 双向链表尾
```

**特点**——每个 from-Region 一个 PerRegionTable，内部用 BitMap 存"哪些 card 引用了我"。BitMap 大小 = CardsPerRegion（4MB / 512B = 8192 bit = 1KB）。比 Sparse 精确（能记录任意数量的 card），但每个 PRT 占 1KB。

#### Coarse（粗粒度）——大量引用时退化

```cpp
CHeapBitMap _coarse_map;    // 1 bit = 1 个 from-Region
size_t      _n_coarse_entries;
static jint _n_coarsenings; // 全局 coarsen 次数统计
```

**特点**——1 bit 表示"整个 from-Region 都可能引用我"。最省内存（2048 个 Region 只需 256 字节），但精度最差——扫描时要回扫整个 from-Region（8192 张 card）。

#### 三层对比

| | Sparse | Fine | Coarse |
|---|---|---|---|
| 存储 | 4 个 card_index | BitMap（8192 bit） | 1 bit |
| 每 from-Region 内存 | ~40B | ~1KB | 1 bit |
| 精度 | 精确（但最多 4 个 card） | 精确（全部 8192 张 card） | 粗糙（"整个 Region 都引用"） |
| 为什么有扫描成本差异 | 直接遍历 4 个 card_index，O(4) | BitMap 按位扫描 8192 个 bit | 命中后回扫整个 from-Region（8192 张 card） |
| 什么时候用 | 每个 from-Region ≤4 个 card | >4 个 card，不同 from-Region <256 个 | 不同 from-Region 达到 256 个，evict 后 |

**"能记录多少"≠"扫描成本"**——Fine 能记录任意数量的 card（精度高），但查 BitMap 要逐位扫描 8192 个 bit，比 Sparse 直接遍历 4 个 card_index 慢。Coarse 只存 1 bit（精度最低），但命中时要回扫整个 from-Region 的 8192 张 card——最慢。

### 3.3 G1FromCardCache——add_reference 的第一步缓存

### 3.3.1 为什么需要

**G1FromCardCache 在 RSet 更新路径上**——ConcurrentRefine 线程消费 dirty card 后，扫描 card 里的对象引用，发现"Region 0 的 card 5 引用了 Region 3"，就需要把这个引用关系记录到 Region 3 的 RSet（HeapRegionRemSet）里。`add_reference(from, tid)` 就是做这件事的方法——"card 5（from）引用了本 Region，请更新我的 RSet"。

每次 `add_reference` 都要查 RSet 的三层结构（Coarse→Sparse→Fine）来判断"这个引用应该记录在哪一层"，这个过程有开销。

**问题**——同一张 card 可能反复产生引用。比如循环里多次写同一个对象的不同字段，每次都触发 `add_reference(card_5, tid)`。如果不缓存，每次都要查三层结构——即使 card 5 的引用关系已经记录过了（Fine BitMap 里 bit 5 已经置位），每次重复 `add_reference` 还是会走一遍三层查找。

**G1FromCardCache 的解法**——记住"每个线程对每个 Region 最近处理过哪张 card"。同一张 card 再次来时，缓存命中直接返回，不走三层结构。

**和 HotCardCache 的区别**——两个都是缓存，但在不同环节：

| | HotCardCache（ch11/05） | G1FromCardCache（本文） |
|---|---|---|
| 在哪 | ConcurrentRefine 消费 dirty card 时 | add_reference 时 |
| 做什么 | 判断 card 是否"热"——热就跳过 refine | 判断 card 是否"已记录"——命中跳过三层 |
| 阈值 | `G1ConcRSHotCardLimit=4`（被处理 4 次变热） | 无阈值——直接比较 card 是否相同 |
| 缓解什么 | 热卡反复 dirty→refine→clean→dirty 循环 | 同 card 反复 add_reference 重复查三层 |

**两者串联的完整流程**：
```
dirty card → refine_card_concurrently → HotCardCache 判热（不热才继续）
  → 扫描 card 里的引用 → add_reference(to_region)
    → G1FromCardCache 判已记录（不命中才查三层）
      → 三层结构记录引用关系
```

### 3.3.2 结构

```cpp
class G1FromCardCache : public AllStatic {
  static uintptr_t** _cache;    // 二维数组：[region_idx][worker_id] → 最近处理的 card
  static uint _max_regions;     // Region 总数
};
```

**per-thread × per-Region**——每个线程对每个 Region 记住"最近处理过的 card"。

**"每个线程"具体是哪个**——`add_reference(from, tid)` 的 `tid` 是 worker id，包括三种情况：
- **ConcurrentRefine 线程**（并发期间，`refine_card_concurrently` 调用时）—— 后台持续消费 DCQ
- **GC Worker 线程**（GC 疏散暂停期间，`refine_card_during_gc` 调用时）—— 暂停时并行扫描
- **Mutator 线程**（DCQ 背压时，`handle_zero_index → process_or_enqueue_complete_buffer → mut_process_buffer`，completed buffers 超过 `_max_completed_queue + _completed_queue_padding` 时 mutator 被强制参与处理 dirty card，减少积压）—— 详见 ch11/08

### 3.3.3 工作流程

```
add_reference(from_card, to_region, tid):
  1. 查 G1FromCardCache::contains_or_replace(tid, to_region, from_card)
     → 缓存里有同一张 card？→ 命中，跳过（已记录过）
     → 没有？→ 写入缓存，继续查三层结构
```

**具体例子**——假设 Region 0 的 card 5 反复产生引用到 Region 3：

```
第 1 次: Region 0 的 card 5 引用 Region 3
  → contains_or_replace(tid=0, region=3, card=5)
  → 缓存里 region 3 的值是 InvalidCard(0) → 不命中
  → 写入缓存：_cache[3][0] = 5
  → 继续查三层结构 → 记录到 OtherRegionsTable

第 2 次: Region 0 的 card 5 又引用 Region 3（同一张 card 里另一个对象）
  → contains_or_replace(tid=0, region=3, card=5)
  → 缓存里 region 3 的值是 5 == card 5 → 命中！
  → 直接返回，不走三层结构

第 3 次: Region 0 的 card 6 引用 Region 3（不同的 card）
  → contains_or_replace(tid=0, region=3, card=6)
  → 缓存里 region 3 的值是 5 != card 6 → 不命中
  → 替换缓存：_cache[3][0] = 6
  → 继续查三层结构 → 记录到 OtherRegionsTable
```

**效果**——同一张 card 反复产生引用（比如循环里同一对象多次写同一字段），FromCardCache 命中后直接跳过，不走三层结构。只有**不同的 card** 才需要查三层。注意：缓存只记住"最近一张 card"，不是所有 card 的集合——如果 card 5 和 card 6 交替产生引用，每次都会 miss + 替换。

**鸡肋吗？——命中率依赖"同 card 多引用"场景**。考虑 512B 的 card 能装十几个对象：如果这些对象都引用了同一个目标 Region（比如同一数组的多个元素指向同一个类），第一个对象的 `add_reference` 走三层记录，后续同 card 内的对象全部命中缓存跳过。但如果线程处理的 card 各不相同——每次缓存都被替换，确实没用。per-thread 设计牺牲了全局命中率（不同线程不共享缓存），换取了无锁访问。

### 3.3.4 为什么是 per-thread

多个 refine 线程可能同时处理同一张 card（不同对象）。如果共享缓存需要加锁——但 `add_reference` 是热路径。per-thread 缓存每个线程有自己的视图，无锁访问。代价是同一张 card 可能被多个线程各记录一次（冗余但不影响正确性——BitMap 置位是幂等的）。

**为什么二维数组就够了**——三类线程都在写 `_cache[region_idx][worker_id]`，如果两个线程恰好用同一个 worker_id，就会写到同一个槽位。用两种机制防止冲突：

**Mutator 和 CR 之间——编号分段，给不同编号**：
- Mutator 背压：`_free_ids->claim_par_id()` 返回 0, 1, 2...（范围 `[0, num_par_ids)`，`dirtyCardQueue.cpp:213`）
- ConcurrentRefine：**故意加了一个偏移量** `worker_id_offset() = num_par_ids()`（`g1ConcurrentRefine.cpp:419-421,444`），实际编号 = 原生编号 + 偏移量。比如 CR 的"worker 0"实际写到槽位 100——和 Mutator 的"worker 0"（槽位 0）不冲突

**GC 和它们之间——时间互斥，不让同时跑**：
- GC Worker 使用的编号范围 `[0, ParallelGCThreads)` 和 Mutator 重叠——但 GC 只在 safepoint 运行，此时所有 mutator 和 CR 线程已暂停。GC 结束后恢复。不会同时写同一个槽位

---

### 3.4 add_reference 退化路径

`add_reference(from, tid)`（`heapRegionRemSet.cpp:346-428`）——记录"from 地址引用了本 Region"：

```
步骤 1: 查 G1FromCardCache（per-thread 缓存）→ 命中返回（最热路径，无锁）
步骤 2: 查 _coarse_map → 命中返回（整个 from-Region 已记录）
步骤 3: 查 _fine_grain_regions 哈希表 → 找到 PerRegionTable？
         → 找到：prt->add_reference(from) → 在 PRT 的 card BitMap 置位 → 返回
步骤 4: PRT 没找到 → 尝试 _sparse_table.add_card() → 成功返回
步骤 5: Sparse 满了 → 分配新 PerRegionTable
         → Fine 哈希表满（256 个不同的 from-Region）？→ 采样 evict
         → 把 Sparse entry 的 card 迁移到新 PRT → 删 Sparse entry
步骤 6: prt->add_reference(from) → 在 PRT 的 card BitMap 置位
```

**退化方向**：

- **Sparse → Fine（单个 from-Region 升级）**——当某个 from-Region（比如 B Region）对 A Region 的引用超过 4 个 card 时，**B 这一个 from-Region** 从 SparsePRTEntry 升级为 PerRegionTable（Fine）。其他 from-Region 不受影响，仍然用 Sparse。升级原因：card 太多（>4），SparsePRTEntry 的 `_cards[4]` 放不下。

- **Fine → Coarse（单个 from-Region 被采样 evict）**——Fine 哈希表只有 256 个桶（`_max_fine_entries=256`），当超过 256 个不同的 from-Region 引用了 A Region 时，哈希表满了。通过采样（`_fine_eviction_stride` 步长采样若干 PRT，挑 occupied 最大的）选出一个 PerRegionTable，把**这一个 from-Region** 退化到 Coarse（1 bit）。退化原因：**不是 card 太多**（Fine BitMap 8192 bit 够覆盖整个 Region），而是**引用方太多**（超过 256 个不同的 from-Region）。其他 from-Region 仍然是 Fine。

**两个维度的上限**：

| | 上限 | 超了会怎样 | 原因 |
|---|---|---|---|
| **单个 from-Region 的 card 数量** | Sparse: 4 个 | Sparse → Fine（升级） | card 太多 |
| **不同 from-Region 的个数** | Fine: 256 个 | Fine → Coarse（退化） | 引用方太多 |

### 3.5 HeapRegionRemSet——RSet 本身

`HeapRegionRemSet` **就是每个 Region 的 RSet**。跨 Region 引用数据的实际存储委托给内部组件 `OtherRegionsTable`（三层结构），HeapRegionRemSet 自身只加控制：状态机控制是否接受新引用、锁保护并发、BOT 辅助定位、code roots 记录 JIT 引用。

```cpp
class HeapRegionRemSet {
  G1BlockOffsetTable* _bot;           // 指向全局 BOT（G1CollectedHeap._bot），用于定位对象起始
  G1CodeRootSet       _code_roots;    // 存指向本 Region 的 nmethod（JIT 代码引用）
  Mutex               _m;             // 保护并发修改
  OtherRegionsTable   _other_regions; // ← 委托的跨区域引用表
  RemSetState         _state;         // Untracked/Updating/Complete
};
```

- **`_state` 状态机**——控制 `add_reference` 是否生效。Region 从出生到死亡经过三个状态，但不是所有 Region 类型都走同样的路径：

```
新 old Region 分配
  → Untracked ────────────→ Updating ──────────→ Complete
       ↑ 不维护 RSet       (rebuild 前)           ↑ RSet 完整
       │                   add_reference 生效       │ add_reference 继续
       │                                           │
       └──────────── GC 回收后重置 ────────────────┘

young / humongous Region：始终 Complete（分配时就设置，不经过 Untracked/Updating）
```

| 状态 | 含义 | add_reference 行为 | 什么时候进入 |
|---|---|---|---|
| `Untracked` | 不维护 RSet | 直接 `return`（`heapRegionRemSet.hpp:265-266`） | 新分配的 old Region（`g1RemSetTrackingPolicy.cpp:53`）+ 被 GC 回收后重置 |
| `Updating` | 正在收集 RSet，但还不完整 | 正常记录 | rebuild 前，对选中的 old Region 调用 `update_before_rebuild()`（`:132`） |
| `Complete` | RSet 完整可用 | 正常记录 | young/humongous 始终 Complete（`:44,47`）；old Region rebuild 后 `update_after_rebuild()`（`:146`） |

**每种 Region 类型的状态**（`g1RemSetTrackingPolicy.cpp:41-57`）：

| Region 类型 | 分配时的状态 | 为什么 |
|---|---|---|
| **young** | Complete（始终） | Young GC 全量 evacuate，outgoing 引用自然处理，但 **incoming RSet 需要维护**——GC 要知道"谁引用了 young Region" |
| **humongous** | Complete（始终） | 急切回收需要 RSet 判断"是否有引用" |
| **新分配的 old** | **Untracked** | 刚分配的 old Region 还没对象引用它，先省掉 add_reference 开销 |
| **标记后被选中的 old** | Untracked → Updating → Complete | rebuild 一次性补上之前漏掉的引用（详见下文 RSet 重建） |

**具体例子**——一个 old Region 的完整生命周期：

```
Region 5 分配为 old（刚 commit）:
  _state = Untracked → 任何 add_reference 直接返回
  （标记还没开始，先不维护 RSet）

并发标记完成，Region 5 存活数据少、值得回收:
  update_before_rebuild() → _state = Updating
  开始接受 add_reference，增量记录新引用

RSet 重建（扫描 Region 5 所有存活对象 → 更新被引用方的 RSet）:
  update_after_rebuild() → _state = Complete
  RSet 完整可用，之后日常 add_reference 增量维护

Next GC 回收 Region 5:
  set_state_empty() → _state = Untracked
  重新从 Untracked 开始
```

**为什么需要这套设计**——新分配的 old Region 默认 Untracked，**省掉 add_reference 的开销**（因为还没对象引用它）。等标记结束，知道哪些 old Region 值得回收后，再通过 rebuild **一次性补上**之前漏掉的引用。用"先省后补"换 CPU 时间。

#### 3.5a RSet 重建——批量补上漏掉的引用

**什么时候**——并发标记的 remark 之后、cleanup 之前，作为一个并发阶段运行

**为什么需要**——新分配的 old Region 标记期间是 Untracked（不维护 RSet），重建时一次性弥补

**重建什么、往哪写**——扫描**被选中的 old/humongous Region** 里所有存活对象的引用字段，更新**被引用方目标 Region 的 RSet**（`g1OopClosures.inline.hpp:293-295`）：

```cpp
HeapRegion* to = _g1h->heap_region_containing(obj);  // 被引用的目标 Region
HeapRegionRemSet* rem_set = to->rem_set();            // 目标 Region 的 RSet
rem_set->add_reference(p, _worker_id);                // 更新目标 Region 的 RSet
```

**和 add_reference 的关系**——add_reference 是**增量**维护（dirty card 触发，来一个加一个），rebuild 是**批量**补全（扫描所有存活对象，一次性补上 Untracked 期间漏掉的）。rebuild 完成后回到 add_reference 增量维护。

**young/humongous 不需要 rebuild**（`needs_scan_for_rebuild` 返回 false，`:32-38`）——young Region outgoing 引用在 Young GC evacuate 时自然处理，humongous 始终 Complete。

- **`_code_roots`**（G1CodeRootSet）——RSet 不只存堆里对象的引用，还存 **JIT 编译代码（nmethod）里的引用**。C2 编译时可能把对象地址嵌入机器码常量区——这些引用不在堆里，GC 扫不到。`_code_roots` 记录"哪些 nmethod 引用了本 Region 的对象"。底层用 chunked list（分块链表，每个 chunk 存多个 nmethod*），避免单链表过长。GC 时 `strong_code_roots_do()` 遍历扫描。

---

## 4. G1BlockOffsetTable——从地址找到对象起始

### 4.1 为什么需要 BOT

GC 扫描 dirty card 时，card 的起始地址**可能切到某个对象的中间**——对象从上个 card 跨过来了。如果直接从 card 起始扫描，读到的不是合法对象头。

**例子**——对象 A 从偏移 400B 开始，大小 200B（结束于 600B）。Card 0 覆盖 0~512B，Card 1 覆盖 512~1024B。Card 1 的起始地址 512B 落在对象 A 的内部（肚子），不是对象头。GC 需要找到"512B 属于哪个对象"——即向前找到对象 A 的起始地址 400B。BOT 就是做这件事的。

### 4.2 类结构

```cpp
class G1BlockOffsetTable {
  volatile u_char* _offset_array;  // 每 512B 堆对应 1 字节 entry
  MemRegion _reserved;             // 覆盖区域
};
```

每 512B 堆空间（= 1 card = `N_words=64` words）对应 1 字节 entry。entry 存的是"回退多少能找到对象起始"。

### 4.3 指数编码——1 字节覆盖整个 Region

BOT 每个 entry 只有 1 字节（256 个值），但要能表示"回退多远"——最近的可能只有几个 word（8 字节），最远的可能要回退整个 Region（32MB）。怎么用 1 字节同时覆盖近和远？

**编码结构**——把 256 个值分成两段：

```
entry 值:  0 ────────────────── 63 │ 64 ─────────────────────── 255
含义:      线性偏移（word）         指数偏移（card）
          回退 0~63 个 word         回退 16^(entry-64) 个 card
          覆盖 0~512B（1 card 内）   覆盖 1 card ~ 16^191 card
```

| entry 值 | 编码方式 | 回退多少 | 回退距离 |
|---|---|---|---|
| 0~63 | 线性：`q -= entry`（word） | entry 个 word | 0~504B（1 card 内） |
| 64 | 指数：`16^(64-64) = 16^0` | 1 个 card | 512B |
| 65 | 指数：`16^(65-64) = 16^1` | 16 个 card | 8KB |
| 66 | 指数：`16^(66-64) = 16^2` | 256 个 card | 128KB |
| 67 | 指数：`16^(67-64) = 16^3` | 4096 个 card | 2MB |
| 68 | 指数：`16^4` | 65536 个 card | 32MB |

**为什么分两段**——如果全部线性（1 值=1 word），256 个值最多覆盖 256×8B=2KB——连半个 Region 都不到的。如果全部指数，近处跳太远。分段让近处精密（word 级），远处大步（card 级），1 字节覆盖 32MB。

**entry 的计算公式**（`g1BlockOffsetTable.inline.hpp:67-73`）：`entry = pointer_delta(threshold, blk_start)` = `(slot起点 - 对象头) / 8`，以 word 计。

**两个具体例子**：

```
例1: 对象头刚好在 slot 起点
  slot 起点 = 1024B，对象头 = 1024B
  entry = (1024 - 1024) / 8 = 0
  查: q = 1024, q -= 0 → 对象头就在这

例2: 对象头在 slot 起点之前 24 字节
  slot 起点 = 1024B，对象头 = 1000B
  entry = (1024 - 1000) / 8 = 3 words
  查: q = 1024, q -= 3×8 = 1000 → 对象头
```

**例3：对象跨 slot，对象头在 slot 0 内部**——对象从 slot 0 内部（200B）跨到 slot 1（512~1024B），slot 0 和 slot 1 的 entry 各不同：

```
slot 0 (含对象头): BOT[0] = 0  ← 初始化为 0（zero_bottom_entry_raw），永不修改
                    含义：搜索起点——查 slot 0 时跳到 region bottom，阶段 2 逐对象前进到 200B

slot 1 (跨边界):   BOT[1] = 39  ← alloc_block_work 设的
                    entry = pointer_delta(512, 200) = (512-200)/8 = 39 words
                    查 slot 1: q=512, q-=39×8=200 → 对象头
```

含对象头的 slot entry 永远是初始值 0（保守搜索起点），跨 slot 边界的中间 slot entry 存精确回退距离。

**大对象的 BOT 布局**——对象头的 card 存线性 entry（<64），中间 card 存指数 entry（≥64），指向头卡方向：

```
对象头卡      近处中间卡        远处中间卡
entry=3      entry=64         entry=66
(线性:3w)    (退1card→头卡)   (退256card→近处→头卡)
```

查远处卡时，沿指数链逐段回退（`block_at_or_preceding` 的 while 循环），每退一段重读 entry，直到进入线性段精确定位。

### 4.4 两阶段定位

`block_start_const(addr)`（`g1BlockOffsetTable.inline.hpp:113-155`）——给定地址找对象起始：

```
阶段 1: BOT 粗定位（block_at_or_preceding）
  index = addr >> 9                     // 算 card index
  offset = _offset_array[index]         // 读 BOT entry
  while (offset >= 64) {                // 指数编码 → 大步跳
    n_cards_back = 16^(offset - 64)     // 算回退几个 card
    q -= n_cards_back * 512B            // 往前跳
    offset = _offset_array[new_index]   // 重读
  }
  q -= offset * 8B                      // 线性偏移到对象头

阶段 2: 对象链细定位（forward_to_block_containing_addr_const）
  while (q <= addr) {                   // 从 q 开始逐对象前进
    q = current
    n = q + block_size(q)               // 下一个对象
    if (n > addr) return q              // q 包含 addr → 返回
  }
```

**阶段 1** 用 BOT 快速跳到大致区域，**阶段 2** 逐对象前进精确定位。

**具体数值例子**——Region 0 里有 3 个对象，找地址 1300B 属于哪个对象：

```
对象布局:
  对象 A: 偏移 0B,    大小 512B  (0~512)
  对象 B: 偏移 512B,  大小 1024B (512~1536)
  对象 C: 偏移 1536B, 大小 512B  (1536~2048)

Card 布局（每 512B 一张 card）:
  Card 0: 0~512     → 对象 A 起始
  Card 1: 512~1024  → 对象 B 起始
  Card 2: 1024~1536 → 对象 B 继续（B 起始在 512，距 card 2 起始 512B=1 card）
  Card 3: 1536~2048 → 对象 C 起始

目标: 找地址 1300B 属于哪个对象 → 在 card 2 范围内
```

**阶段 1: BOT 粗定位**
```
index = 1300 / 512 = 2                    → 读 BOT[2]
BOT[2] = 64                               → 指数编码（>= 64）
entry_to_cards_back(64) = 16^(64-64) = 1  → 回退 1 个 card
q = card_2_start - 1*512 = 1024 - 512 = 512  → 粗定位到偏移 512B
```

**阶段 2: 对象链细定位**
```
q = 512（对象 B 起始）
block_size(512) = 1024B                   → 下一个对象在 512 + 1024 = 1536
1536 > 1300                                → 地址 1300 在对象 B 范围内
return 512                                 → 对象 B 起始地址
```

**为什么需要两阶段**——阶段 1 用 BOT 1 字节快速跳到"大致区域"（可能跳过头或不够），阶段 2 逐对象前进精确定位。如果只有阶段 2（从堆底逐对象前进），4MB Region 里可能要遍历上千个对象——太慢。BOT 让阶段 1 一次跳到附近，阶段 2 只需遍历几个对象。

### 4.5 G1BlockOffsetTablePart——per-Region 视图

全局 BOT 是一个覆盖整个堆的大数组，**每个 HeapRegion 持有一个 `G1BlockOffsetTablePart`**（`heapRegion.hpp:101`：`_bot_part`）。2048 个 Part 都指向同一个全局 BOT 数组——每个 Part 只读写自己 Region 对应的那一段。

```
G1BlockOffsetTablePart:
  _bot                    → 指向全局 BOT 数组（G1BlockOffsetTable*）
  _space                  → 指向当前 Region 的空间（知道 bottom/top）
  _next_offset_threshold  → 下次填表的那条线（地址）
  _next_offset_index      → 那条线对应的 BOT 数组下标
```

Part 不存"各格的数值"——数值直接存在全局 BOT 数组里。Part 只管一件事：**"下条线在哪"**。

**工作方式**——当 Region 内分配对象，对象尾部跨过了 `_next_offset_threshold`，`alloc_block_work` 被触发：更新当前行的 BOT entry（存回退距离），然后 threshold 推到下一个 slot 的起点、index 加 1。

**初始化**——Region 初始化时，`_next_offset_threshold` 指向第二个 slot 的起点（`initialize_threshold_raw`），第一行 BOT[0] 设为 0（`zero_bottom_entry_raw`）。所以第一个 slot 的 entry 永远是 0（搜索起点），从第二个 slot 开始才被 `alloc_block_work` 更新。

**具体流程**——以 Region 刚构建、分配第一个对象（从 200B 到 800B）为例：

```
初始:    BOT[0]=0     BOT[1]未知   BOT[2]未知 ...
          ↑线0=0B     ↑线1=512B（_next_offset_threshold 指向这里，_next_offset_index=1）

对象 200B→800B 跨过线1(512B) → 触发 alloc_block_work:
  BOT[1] = (512-200)/8 = 39 words
  线推到 slot 2 起点(1024B)，_next_offset_index=2

之后:    BOT[0]=0     BOT[1]=39    BOT[2]未知 ...
                      ↑旧线1       ↑新线2=1024B
```

---

## 5. in_cset_fast_test——O(1) 判断对象在不在 CSet

### 5.1 为什么需要

GC 扫描引用时（如 `A → B`），必须快速判断"B 在不在 CSet"——如果在，B 需要被搬走。这个判断在 GC 热路径上，每次引用遍历都要做，不能遍历 CSet 列表逐一比对——太慢。

**方案：不存列表，存地图**。一个偏置数组，每个 Region 占一个格子。格子里存一个小数字（-1/0/1/2），直接告诉 GC"这个 Region 在不在 CSet"。

### 5.2 数据结构和查询

`_in_cset_fast_test`（`G1InCSetStateFastTestBiasedMappedArray`）继承 `G1BiasedMappedArray<InCSetState>`（偏置数组技巧，详见 ch11/05）。给定对象地址，`地址 >> RegionShift` 直接定位到对应的格子，O(1)：

```
obj_addr >> RegionShift  →  格子编号  →  biased_base[格子编号]  →  InCSetState
```

和 cardtable 的 `_byte_map_base` 同一技巧，区别是粒度：cardtable 是 512B（`>> 9`），这里是 Region 大小（`>> RegionShift`）。

### 5.3 InCSetState 枚举

每个格子存 1 字节（`int8_t`），四种值：

```cpp
struct InCSetState {
  static const in_cset_state_t Humongous  = -1;  // 大对象 Region 在 CSet
  static const in_cset_state_t NotInCSet  =  0;  // 不在 CSet
  static const in_cset_state_t Young      =  1;  // young Region 在 CSet
  static const in_cset_state_t Old        =  2;  // old Region 在 CSet
};
```

**设计巧妙**——正值表示在 CSet，`is_in_cset() = (_value > 0)` 一条比较覆盖 Young+Old。负值（Humongous）走独立路径。

### 5.4 生命周期

```
GC 开始时（start_new_collection_set）:
  register_young_region_with_cset(r)   → 设对应格子 = 1
  register_old_region_with_cset(r)     → 设对应格子 = 2
  register_humongous_region_with_cset  → 设对应格子 = -1

GC 扫描时:
  is_in_cset(obj) = obj_addr >> RegionShift → 读格子 → value > 0    // 一条比较

GC 结束时:
  clear_cset_fast_test() → 全部重置为 NotInCSet (0)
```

---

## 6. humongous_reclaim_candidates——大对象急切回收

### 6.1 为什么需要

Humongous 对象（超过 Region 一半，即 8GB 堆 / 4MB Region → 超过 2MB 的对象）占整个连续 Region。如果 Humongous 对象已死，young GC 时可以急切回收——不用等 mixed GC。但要判断"是否真的没有引用"。

**为什么 Humongous 特殊**——普通 old Region 要等 mixed GC 才回收（需要并发标记确认存活率）。但 Humongous 对象只有"有人引用"和"没人引用"两种状态（没有部分存活），如果没引用就可以在 young GC 时直接回收，不用等 mixed GC。

### 6.2 结构

```cpp
HumongousReclaimCandidates _humongous_reclaim_candidates;  // G1BiasedMappedArray<bool>——偏置数组
bool _has_humongous_reclaim_candidates;                    // 是否有候选（无则跳过整个检查流程）
```

### 6.3 完整工作流程

**阶段 1: young GC 开始前——标记候选**
```
对每个 Humongous Region:
  → 检查 RSet 是否有入引用
  → RSet 为空（没有任何其他 Region 引用它）？
     → set_humongous_reclaim_candidate(idx, true)  → 标记为回收候选
     → register_humongous_region_with_cset(idx)    → _in_cset_fast_test = Humongous(-1)
  → RSet 非空？
     → 不标记（有引用，不能回收）
```

**为什么检查 RSet 而不是扫描全堆**——RSet 记录了"谁引用了我"。如果 RSet 为空，说明没有跨 Region 引用指向这个 Humongous 对象。但 RSet 可能不完整（并发 refine 有延迟），所以需要阶段 2 确认。

**阶段 2: young GC 扫描时——确认无引用**
```
GC worker 遍历引用:
  → 发现引用指向 Humongous 对象？
  → set_humongous_is_live(obj)
    → 从候选集移除：_humongous_reclaim_candidates[idx] = false
    → 标记为存活（不回收）

_has_humongous_reclaim_candidates 在此过程中更新:
  → 所有候选都被移除？→ _has_humongous_reclaim_candidates = false
  → 后续 Region 跳过检查（性能优化）
```

**阶段 3: young GC 回收时——回收确认的候选**
```
候选集里剩下的 Humongous Region:
  → _humongous_reclaim_candidates[idx] == true（阶段 2 没被移除）
  → 确认无引用 → 急切回收
  → 释放 Region → 加入 free_list
```

### 6.4 具体例子

```
Region 10~12: Humongous 对象 H1（3 个连续 Region，12MB）
Region 15~15: Humongous 对象 H2（1 个 Region，4MB）

young GC 开始前:
  H1 的 RSet 为空 → 标记候选: candidates[10]=candidates[11]=candidates[12]=true
  H2 的 RSet 非空（Region 3 引用 H2）→ 不标记

young GC 扫描时:
  遍历 Region 3 的引用 → 发现指向 H2 → H2 确认存活
  没有任何引用指向 H1 → H1 保持候选状态

young GC 回收时:
  H1: candidates[10~12]=true → 急切回收 Region 10~12
  H2: 不是候选 → 保留，等后续 mixed GC
```

---

## 7. 概念链

```
dirty card 消费链:
  写后屏障标 dirty → DCQ → ConcurrentRefine 线程 → refine_card_concurrently
    → HotCardCache 判热 → 扫描 card 里的引用（用 BOT 定位对象边界）
    → add_reference 到目标 Region 的 RSet

RSet 三层存储（OtherRegionsTable）:
  FromCardCache 命中跳过 → Coarse 命中跳过 → Sparse 尝试 → Fine 查找
  → Sparse 满 升级 Fine → Fine 满 evict 退化 Coarse

BOT 两阶段定位:
  阶段 1: 指数编码 BOT 粗定位（大步跳）
  阶段 2: 逐对象前进细定位

CSet 快速测试:
  InCSetState(-1/0/1/2) + 偏置数组 → O(1) 判断对象在不在 CSet

Humongous 急切回收:
  无 RSet 引用 → 标记候选 → young GC 时确认无引用 → 急切回收
```

---

## 8. 程序员影响

- **`-XX:G1RSetRegionEntries`**——Fine 表桶数（默认 256），控制 RSet 内存开销。大堆可调大减少 evict
- **`-XX:G1RSetSparseRegionEntries`**——Sparse 表每 Region 的 card 数（默认 4），影响稀疏引用的覆盖
- **RSet 内存开销**——每个 Region 一份 RSet，通常占堆 1%~5%。`-XX:+UnlockDiagnosticVMOptions -XX:+PrintRSetSummary` 可查看
- **BOT 透明**——BOT 是 GC 内部基础设施，程序员不直接操作，但理解它有助于理解"GC 怎么扫描堆"
- **Humongous 对象**——超过 Region 一半（2MB）的对象是 Humongous，避免频繁分配大数组产生碎片
