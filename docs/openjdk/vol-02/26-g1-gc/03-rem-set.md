# 03. Region A 里谁引用了 Region B？— RSet + CardTable 并发细化

> **前置依赖**:[26-g1-gc/02 — 应用还在跑——你怎么知道谁活着？— 并发标记 + SATB](02-concurrent-marking.md):remark 结束后 `_next_marked_bytes` 已就位,但 Mixed GC 还得知道"哪些 Old Region 指向了我要收的 Young/Old Region";[25-gc-framework/05 — 一次赋值在 GC 眼里怎么变成"脏卡片"？— CardTable + DirtyCardQueue](openjdk/vol-02/25-gc-framework/05-cardtable-dirtycardq.md):post-write barrier、DirtyCardQueue 与并发精炼的底层机制已拆,本篇把它们接到 G1 的 RSet 上;[26-g1-gc/01 — 堆被切成 2048 块](01-heapregion.md):Region 结构、`_rem_set` 字段与 Region 粒度管理
> → **后续**:[26-g1-gc/04 — 分配与晋升](04-allocation.md)
> 关联域: 25-01(卡表结构)、25-04(并行消费)、21-shared-runtime(nmethod roots)

并发标记解决了"谁活着"。但 Evacuation Pause 还有另一个问题: **我要收 Region Y,凭什么去扫整个老年代找谁指向它?** G1 的答案是 RSet(remembered set): 每个 Region 自己维护一张"谁引用了我"的反查表。反查表的索引入口是 card table(512B 一卡),来源是 post-write barrier 记下来的脏卡,后台由 concurrent refinement 线程慢慢消化,暂停里再由 Update RS + Scan RS 接力。于是一次 Young GC 扫的不是整个 Old,而只是**那些可能指向 Collection Set 的卡**。

---

## 1. RSet 是什么 — 每个 Region 的"谁引用了我"

### `_rem_set` 字段挂在 HeapRegion 上

26-01 见过 `HeapRegion` 的成员里有一个 `_rem_set`(heapRegion.hpp:198-201)。它不是"我引用了谁",而是**谁引用了我**。`HeapRegionRemSet`(heapRegionRemSet.hpp:170-183):

```cpp
// heapRegionRemSet.hpp:170-183(截取核心,逐字)
class HeapRegionRemSet : public CHeapObj<mtGC> {
  friend class VMStructs;
  friend class HeapRegionRemSetIterator;

private:
  G1BlockOffsetTable* _bot;

  // A set of code blobs (nmethods) whose code contains pointers into
  // the region that owns this RSet.
  G1CodeRootSet _code_roots;

  Mutex _m;

  OtherRegionsTable _other_regions;
```

`_code_roots` 记录代码里的强根(nmethod 等代码根),`_other_regions` 才是普通堆引用的主表。**owner region = 这张 RSet 所属的 Region;表里的每条记录都在回答: 哪个别的 Region 的哪些 card 里,可能有指向 owner 的引用。**

### `OtherRegionsTable`: coarse + fine + sparse 三层混合

`OtherRegionsTable` 的设计注释(heapRegionRemSet.hpp:50-58,74-104):

```cpp
// heapRegionRemSet.hpp:50-58,82-87,103-104(截取核心,逐字)
// The "_coarse_map" is a bitmap with one bit for each region, where set
// bits indicate that the corresponding region may contain some pointer
// into the owning region.

// The "_fine_grain_entries" array is an open hash table of PerRegionTables
// (PRTs), indicating regions for which we're keeping the RS as a set of
// cards.  The strategy is to cap the size of the fine-grain table,
// deleting an entry and setting the corresponding coarse-grained bit when
// we would overflow this cap.

  CHeapBitMap _coarse_map;
  size_t      _n_coarse_entries;
...
  PerRegionTable** _fine_grain_regions;
  size_t           _n_fine_entries;
...
  SparsePRT   _sparse_table;
```

不是大纲里那种"Sparse/Fine/Coarse 三个独立模式三选一"。真实结构是**同一张 RSet 同时持有三种容器**:

1. **SparsePRT** — 小量 entry 走稀疏表,按"来源 Region → 少量 card index"存;
2. **fine-grain PRT** — 某些来源 Region 升级成 `PerRegionTable`,按 card 位图或表结构存更细信息;
3. **coarse_map** — 再装不下时,直接退化成"这个来源 Region 整体可能有引用",扫描时只能按整个 Region 粗扫。

所以**粗化(coarsen)**不是"Sparse 升 Fine 再升 Coarse 的单对象状态机",而是: 这张 RSet 里,某个来源 Region 原来有 fine entry;当 fine 表总量逼近上限,就驱逐一个 fine entry,把它对应的来源 Region 位置到 `_coarse_map` 上。源码注释说得很直白(heapRegionRemSet.hpp:54-58): *cap the size of the fine-grain table, deleting an entry and setting the corresponding coarse-grained bit when we would overflow this cap.*

### add_reference: 引用是从来源地址算出来的

`HeapRegionRemSet::add_reference`(heapRegionRemSet.hpp:257-268):

```cpp
// heapRegionRemSet.hpp:257-268(截取核心,逐字)
  // Used in the sequential case.
  void add_reference(OopOrNarrowOopStar from) {
    add_reference(from, 0);
  }

  // Used in the parallel case.
  void add_reference(OopOrNarrowOopStar from, uint tid) {
    RemSetState state = _state;
    if (state == Untracked) {
      return;
    }
    _other_regions.add_reference(from, tid);
  }
```

传入的不是 target oop,而是**来源字段地址 `from`**。`OtherRegionsTable::card_within_region` 会把这个字段地址换算成"来源 Region 内的第几张 card"(heapRegionRemSet.hpp:133-137)。所以 RSet 存的是:

- 来源 Region 是谁;
- 该 Region 里哪几张 card 可能有指向 owner region 的引用。

这样 Young GC 扫 Collection Set 时,就能从 **target region → source cards** 反查回来,只扫这几张 card,不用扫整块老年代。

---

## 2. 稀疏表怎么存 — SparsePRT 不是"128 entries"

大纲把 Sparse/Fine 的阈值和内存模型都写偏了。真实稀疏结构在 `sparsePRT.hpp`。

### 一条 Sparse entry = 一个来源 Region + 若干张 card

`SparsePRTEntry`(sparsePRT.hpp:46-73):

```cpp
// sparsePRT.hpp:46-73(截取核心,逐字)
class SparsePRTEntry: public CHeapObj<mtGC> {
private:
  // The type of a card entry.
  typedef uint16_t card_elem_t;
...
  RegionIdx_t _region_ind;
  int         _next_index;
  int         _next_null;
...
  static size_t size() { return sizeof(SparsePRTEntry) + sizeof(card_elem_t) * (cards_num() - card_array_alignment); }
  // Returns the size of the card array.
  static int cards_num() {
    return align_up((int)G1RSetSparseRegionEntries, (int)card_array_alignment);
  }
```

一条 `SparsePRTEntry` 绑定一个 `_region_ind`(来源 Region 编号),后面拖一段 `_cards[]` 变长数组。`cards_num()` 直接取 `G1RSetSparseRegionEntries`。**所以大纲的"<128 entries"是错的**——实际阈值由 flag `G1RSetSparseRegionEntries` 控制,不是固定 128,而且单位是**每个来源 Region 内能直接塞多少张 card**。更进一步,这个值默认还会按 region 大小做人体工学放大(heapRegionRemSet.cpp:630-641): `G1RSetSparseRegionEntries = G1RSetSparseRegionEntriesBase * (region_size_log_mb + 1)`。

### SparsePRT 是双哈希表,不是单表就地改

`SparsePRT`(sparsePRT.hpp:225-254):

```cpp
// sparsePRT.hpp:225-254(截取核心,逐字)
class SparsePRT {
  friend class SparsePRTCleanupTask;

  //  Iterations are done on the _cur hash table, since they only need to
  //  see entries visible at the start of a collection pause.
  //  All other operations are done using the _next hash table.
  RSHashTable* _cur;
  RSHashTable* _next;
...
  void expand();

  bool _expanded;
...
  static SparsePRT* volatile _head_expanded_list;
```

这才是 pause 与并发更新能并存的关键: **暂停中的迭代看 `_cur`; 并发插入改 `_next`。** Pause 结束后再统一 cleanup/切换,避免边扫边改把迭代器搞乱。26-02 的双 bitmap 是"上轮结果 + 本轮构造"双份并存;这里的 `SparsePRT` 也是类似思路——**一份给 pause 稳定读取,一份给并发写入生长。**

---

## 3. 扫描时怎么用 — Scan RS 不是扫整个 Old

### G1RemSet 的职责写在头文件上

`G1RemSet` 的注释(g1RemSet.hpp:54-69):

```cpp
// g1RemSet.hpp:54-69(截取核心,逐字)
// A G1RemSet in which each heap region has a rem set that records the
// external heap references into it.  Uses a mod ref bs to track updates,
// so that they can be used to update the individual region remsets.
class G1RemSet: public CHeapObj<mtGC> {
private:
  G1RemSetScanState* _scan_state;
...
  // Scan all remembered sets of the collection set for references into the collection
  // set.
  void scan_rem_set(G1ParScanThreadState* pss, uint worker_i);

  // Flush remaining refinement buffers for cross-region references to either evacuate references
  // into the collection set or update the remembered set.
  void update_rem_set(G1ParScanThreadState* pss, uint worker_i);
```

两步很清楚:

1. **Update RS** — 先把还在 dirty-card queue 里的剩余脏卡消费掉: 指向 CSet 的引用直接入 evacuate 队列,其余跨 Region 引用补记到 target region 的 RSet;
2. **Scan RS** — 再遍历 Collection Set 各 Region 的 RSet,按 card 反查来源,把真正指向 CSet 的对象找出来并 evacuate。

### Pause 内实际入口: `oops_into_collection_set_do`

入口很短但顺序极关键:g1RemSet.cpp:506-509 先 `update_rem_set(pss, worker_i)`,再 `scan_rem_set(pss, worker_i)`。顺序不能反。因为如果先扫 RSet、后处理剩余 dirty card queue,你看到的就是一张过期索引。

### `scan_rem_set`: 遍历的是 Collection Set 各 Region 的入边表

`scan_rem_set`(g1RemSet.cpp:425-441):

```cpp
// g1RemSet.cpp:425-441(截取核心,逐字)
void G1RemSet::scan_rem_set(G1ParScanThreadState* pss, uint worker_i) {
  G1ScanObjsDuringScanRSClosure scan_cl(_g1h, pss);
  G1ScanRSForRegionClosure cl(_scan_state, &scan_cl, pss, worker_i);
  _g1h->collection_set_iterate_from(&cl, worker_i);
...
  p->record_thread_work_item(G1GCPhaseTimes::ScanRS, worker_i, cl.cards_scanned(), G1GCPhaseTimes::ScanRSScannedCards);
  p->record_thread_work_item(G1GCPhaseTimes::ScanRS, worker_i, cl.cards_claimed(), G1GCPhaseTimes::ScanRSClaimedCards);
  p->record_thread_work_item(G1GCPhaseTimes::ScanRS, worker_i, cl.cards_skipped(), G1GCPhaseTimes::ScanRSSkippedCards);
```

这里不是"遍历整个老年代找旧卡"。它是 `collection_set_iterate_from(&cl, worker_i)`: **以 CSet 里的每个 Region 为 owner,遍历它自己的 remembered set。** 所以 Scan RS 的工作集天然被限制在"谁指向了我要收的 Region"。

### `scan_rem_set_roots`: card 级 claim + top 截断

真正的 card 扫描在 `G1ScanRSForRegionClosure::scan_rem_set_roots`(g1RemSet.cpp:341-394):

```cpp
// g1RemSet.cpp:341-394(截取核心,逐字)
void G1ScanRSForRegionClosure::scan_rem_set_roots(HeapRegion* r) {
  uint const region_idx = r->hrm_index();
...
  size_t const block_size = G1RSetScanBlockSize;

  HeapRegionRemSetIterator iter(r->rem_set());
  size_t card_index;

  size_t claimed_card_block = _scan_state->iter_claimed_next(region_idx, block_size);
  for (size_t current_card = 0; iter.has_next(card_index); current_card++) {
    if (current_card >= claimed_card_block + block_size) {
      claimed_card_block = _scan_state->iter_claimed_next(region_idx, block_size);
    }
    if (current_card < claimed_card_block) {
      _cards_skipped++;
      continue;
    }
...
    HeapWord* const top = _scan_state->scan_top(region_idx_for_card);
    if (card_start >= top) {
      continue;
    }
...
    claim_card(card_index, region_idx_for_card);

    MemRegion const mr(card_start, MIN2(card_start + BOTConstants::N_words, top));

    scan_card(mr, region_idx_for_card);
  }
}
```

三件事很关键:

1. **按 block claim** — 用 `iter_claimed_next(region_idx, block_size)` 给多个 GC worker 分块,不是一张卡一把锁;
2. **按 `scan_top` 截断** — region 的扫描上界在 pause 开始时快照到 `_scan_top`(g1RemSet.cpp:125-149,195-199),避免扫到这次 GC 过程中不该看的新分配部分;
3. **每张 card 最多 claim 一次** — `claim_card` 里会把 card 标成 claimed,同时把对应来源 Region 加进 dirty-region buffer,后面统一清卡表。

这就是 G1 Pause 能把 Scan RS 压到 card 粒度的核心。

---

## 4. 脏卡怎么变成 RSet — post barrier → DirtyCardQueue → 并发精炼

### post barrier 只做两件事: 标脏 + 入队

26-02 说 SATB pre-barrier 记录旧值;RSet 这条链看的是第二道 post-barrier。`write_ref_field_post` + slow path(g1BarrierSet.inline.hpp:48-55, g1BarrierSet.cpp:99-113):

```cpp
// g1BarrierSet.inline.hpp:48-55(截取核心,逐字)
template <DecoratorSet decorators, typename T>
inline void G1BarrierSet::write_ref_field_post(T* field, oop new_val) {
  volatile jbyte* byte = _card_table->byte_for(field);
  if (*byte != G1CardTable::g1_young_card_val()) {
    // Take a slow path for cards in old
    write_ref_field_post_slow(byte);
  }
}
```

```cpp
// g1BarrierSet.cpp:99-113(截取核心,逐字)
void G1BarrierSet::write_ref_field_post_slow(volatile jbyte* byte) {
  // In the slow path, we know a card is not young
  assert(*byte != G1CardTable::g1_young_card_val(), "slow path invoked without filtering");
  OrderAccess::storeload();
  if (*byte != G1CardTable::dirty_card_val()) {
    *byte = G1CardTable::dirty_card_val();
    Thread* thr = Thread::current();
    if (thr->is_Java_thread()) {
      G1ThreadLocalData::dirty_card_queue(thr).enqueue(byte);
    } else {
      MutexLockerEx x(Shared_DirtyCardQ_lock,
                      Mutex::_no_safepoint_check_flag);
      _dirty_card_queue_set.shared_dirty_card_queue()->enqueue(byte);
    }
  }
}
```

它并不直接更新 RSet。它只做:

1. 把 `field` 所在 card 标成 dirty;
2. 把这张 card 的字节地址 `byte` 扔进 `DirtyCardQueue`。

真正的 RSet 更新在后面的 refinement/Update RS。

### refine thread 是"吃 completed buffer 的后台工人"

`G1ConcurrentRefineThread::run_service`(g1ConcurrentRefineThread.cpp:92-128):

```cpp
// g1ConcurrentRefineThread.cpp:92-128(截取核心,逐字)
void G1ConcurrentRefineThread::run_service() {
  _vtime_start = os::elapsedVTime();

  while (!should_terminate()) {
    // Wait for work
    wait_for_completed_buffers();
    if (should_terminate()) {
      break;
    }
...
    {
      SuspendibleThreadSetJoiner sts_join;

      while (!should_terminate()) {
        if (sts_join.should_yield()) {
          sts_join.yield();
          continue;             // Re-check for termination after yield delay.
        }

        if (!_cr->do_refinement_step(_worker_id)) {
          break;
        }
        ++buffers_processed;
      }
    }

    deactivate();
```

主循环很朴素: 睡眠等 buffer → 醒来一批批 refine → 队列回落到阈值以下就 deactivate。它加入 STS,说明**并发精炼是可让步的后台工作**,不会长时间卡住应用。

### 真正一步: 取一个 completed buffer,逐卡 refine

`do_refinement_step`(g1ConcurrentRefine.cpp:429-446)做的事非常集中: 先看当前 completed buffer 数量,必要时 `maybe_activate_more_threads(worker_id, curr_buffer_num)`,然后直接调 `dcqs.refine_completed_buffer_concurrently(worker_id + worker_id_offset(), deactivation_threshold(worker_id))`。`refine_completed_buffer_concurrently` 在 25-05 已看过,就是从 completed list 取一个 buffer,把里面每张 card 交给 `G1RefineCardConcurrentlyClosure`。因此**refine thread 的工作单位不是单张 card,而是一整块 completed buffer。**

### `refine_card_concurrently`: 过滤、清卡、扫描 card、更新 target RSet

核心逻辑在 `G1RemSet::refine_card_concurrently`(g1RemSet.cpp:539-671)。

```cpp
// g1RemSet.cpp:539-547,574-576,621-650(截取核心,逐字)
void G1RemSet::refine_card_concurrently(jbyte* card_ptr,
                                        uint worker_i) {
  assert(!_g1h->is_gc_active(), "Only call concurrently");
...
  // If the card is no longer dirty, nothing to do.
  if (*card_ptr != G1CardTable::dirty_card_val()) {
    return;
  }
...
  if (!r->is_old_or_humongous()) {
    return;
  }
...
  HeapWord* scan_limit = r->top();

  if (scan_limit <= start) {
    // If the trimmed region is empty, the card must be stale.
    return;
  }
...
  G1ConcurrentRefineOopClosure conc_refine_cl(_g1h, worker_i);

  bool card_processed =
    r->oops_on_card_seq_iterate_careful<false>(dirty_region, &conc_refine_cl);
```

这一步不是"看到 card 就直接 whole-region 扫"。它按顺序做:

1. **脏位检查** — card 已不脏就跳过;
2. **Region 类型过滤** — 只处理 old/humongous,young/free/stale 情况直接返回;
3. **按 `top()` 截断** — card 末尾可能已经越过已分配区,要 trim 到 `scan_limit`;
4. **清卡后加 fence** — 先把 card 设 clean,再 `OrderAccess::fence()` 保证随后读取对象布局/顶端时不乱序;
5. **逐对象遍历 card 内引用** — `oops_on_card_seq_iterate_careful<false>` 会按 BOT 找到对象边界,对 card 覆盖的对象区间做精确迭代;
6. **由 closure 更新 target region 的 RSet** — card 里每个 field 若指向别的 Region,并且目标 region 的 remset 处于 tracked 状态,就会在那个 target region 的 `HeapRegionRemSet` 里登记"来源 Region 的这张 card 可能指向我"。并发精炼这条方向写在 `G1ConcurrentRefineOopClosure::do_oop_work` 里(g1OopClosures.inline.hpp:131-156): 先算 `HeapRegionRemSet* to_rem_set = _g1h->heap_region_containing(obj)->rem_set()`,检查 `to_rem_set->is_tracked()`,再 `to_rem_set->add_reference(p, _worker_i)`。

所以 RSet 的更新方向是: **从来源 card 扫到目标 oop → 去目标 Region 的 RSet 里 add_reference(来源字段地址)**。不是把卡挂到来源 Region 自己身上。

### Hot Card Cache: 拦住高频重复写

`G1HotCardCache` 的类注释在 g1HotCardCache.hpp:40-54 已经把目的写透了: 它是 *An evicting cache of cards that have been logged by the G1 post write barrier*。它不是 RSet 的一层存储,只是**重复脏卡的减震器**。某张 card 刚被脏化、还没来得及精炼时,mutator 可能又在同一张 card 上连续写几十次。Hot Card Cache 会把它短暂缓存起来,等变"热"后统一处理,减少 barrier 和 refinement 的重复工作。26-02 里 SATB 的目标是"别漏旧值";这里 Hot Card Cache 的目标是"别被同一张热卡刷爆"。

---

## 5. Pause 内接力 — Update RS 先清尾,Scan RS 再反查

### Update RS 先把队列尾巴处理干净

在真正进 `update_rem_set` 之前,`prepare_for_oops_into_collection_set_do`(g1RemSet.cpp:511-516)会先 `dcqs.concatenate_logs()` 把各 Java 线程手里还没满的 partial dirty-card log 也拼进全局 completed list,再 `_scan_state->reset()` 建好这次 pause 的扫描快照。于是 Update RS 处理的不只是之前已经 completed 的 buffer,也包括 pause 开始瞬间各线程手头那点尾巴。

`update_rem_set`(g1RemSet.cpp:477-499):

```cpp
// g1RemSet.cpp:477-499(截取核心,逐字)
void G1RemSet::update_rem_set(G1ParScanThreadState* pss, uint worker_i) {
  G1GCPhaseTimes* p = _g1p->phase_times();
...
  {
    G1EvacPhaseTimesTracker x(p, pss, G1GCPhaseTimes::UpdateRS, worker_i);

    G1ScanObjsDuringUpdateRSClosure update_rs_cl(_g1h, pss, worker_i);
    G1RefineCardClosure refine_card_cl(_g1h, &update_rs_cl);
    _g1h->iterate_dirty_card_closure(&refine_card_cl, worker_i);

    p->record_thread_work_item(G1GCPhaseTimes::UpdateRS, worker_i, refine_card_cl.cards_scanned(), G1GCPhaseTimes::UpdateRSScannedCards);
    p->record_thread_work_item(G1GCPhaseTimes::UpdateRS, worker_i, refine_card_cl.cards_skipped(), G1GCPhaseTimes::UpdateRSSkippedCards);
  }
}
```

这里吃的是**暂停开始时 dirty-card queue 里还没被并发精炼线程吃完的 completed buffers**。Update RS 不只是补 RSet: `G1ScanObjsDuringUpdateRSClosure::do_oop_work`(g1OopClosures.inline.hpp:169-181)里,若目标 `state.is_in_cset()` 就 `prefetch_and_push(p, obj)` 直接把引用送进 evacuate 队列;只有目标不在 CSet 且跨 Region 时,才 `to->rem_set()->add_reference(p, _worker_i)` 补记回 RSet。

### 然后 Scan RS 才能只扫必要的 card

接着 `scan_rem_set` 读取 CSet 各 Region 的 RSet,把来源 card 逐张拿出来扫描。这样 Pause 的对象图追踪路径变成:

1. post barrier 把 card 扔进 dirty queue;
2. 并发 refine 尽可能提前把 card 变成 RSet entry;
3. 暂停开始先 Update RS 清尾;
4. 再 Scan RS 通过 RSet 反查来源 card;
5. 在 card 里找到真正指向 CSet 的 oop,交给 `G1ParScanThreadState` 做复制/转发。

Pause 收尾时 `cleanup_after_oops_into_collection_set_do`(g1RemSet.cpp:518-524)会按 `_scan_state` 里记下的 dirty regions 并行清卡表,把这轮临时 claim/dirty 状态抹平。

没有 RSet,第 4 步只能退化成"扫所有 old/humongous region"。G1 的 pause time 就会从"和跨 Region 引用数成正比"退化成"和老年代大小成正比"。

---

## 核心悬念

**并发标记回答了"哪些对象活着";RSet 回答了"哪些来源 card 可能指向我要收的 Region"。** 现在 G1 已经知道: 某个 Region 值不值得收(`_next_marked_bytes`),以及收它时该从哪里找入边(RSet)。剩下的问题就变成最现实的一步: **对象平时怎么分配到 Region,什么时候走 TLAB,什么时候直接 humongous,晋升失败又怎么兜底?** 下一篇看分配与晋升。

> → [04-allocation.md](04-allocation.md)
