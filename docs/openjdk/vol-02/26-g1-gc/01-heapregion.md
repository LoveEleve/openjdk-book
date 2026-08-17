# 01. 堆被切成 2048 块 — HeapRegion + G1CollectedHeap

> **前置依赖**:[25-gc-framework/02 — new Object() 走到了哪？— CollectedHeap + 分配路径](openjdk/vol-02/25-gc-framework/02-collected-heap.md):CollectedHeap 门面、分配三级路径与 `_g1_humongous_allocation` cause;[25-gc-framework/01 — GC 怎么在每次 oop 访问时悄悄插入 barrier？— BarrierSet + Access API](openjdk/vol-02/25-gc-framework/01-barrier-access.md):G1 的写 barrier 与 card 记账;[09-memory-core/01 — Universe + CollectedHeap — JVM 的"宇宙大爆炸"](openjdk/vol-02/09-memory-core/01-universe-heap.md):保留区与 `Universe::reserve_heap`
> → **后续**:[26-g1-gc/02 — 应用还在跑——你怎么知道谁活着？— 并发标记 + SATB](openjdk/vol-02/26-g1-gc/02-concurrent-mark.md)
> 关联域: 25-gc-framework(堆门面与 barrier、card 表)、09-memory-core(保留区)

## 一张"网格纸"上的堆

经典 GC(CMS/Serial)把堆切成 Young/Old 两大块,分代边界**固定**——Eden 满了整块搬,老年代满了整体压缩。G1 把堆切成 **~2048 个等大的 Region**(1MB~32MB),每个 Region 自己"声明"类型: 这一轮是 Eden、下一轮变 Survivor、再下一轮变 Old——**分代不再是大块,而是 Region 上贴的标签**。本篇回答三个问题: Region 的大小怎么定、Region 是什么结构、谁在管理这一桌子积木(G1CollectedHeap)。悬念埋在最后: 并发标记怎么知道"哪些对象是本次标记前就存在的"——答案就是本篇 §1.3 的 prev/next TAMS。

## 1. "2048 块积木" — HeapRegion 模型

### 1.1 积木的尺寸: 1MB~32MB,默认奔向 2048 块

Region 的大小不是一个常数,而是一个 **flag + 三条规则**。看 `setup_heap_region_size`(heapRegion.cpp:63-82,截取核心):

```cpp
// heapRegion.cpp:63-82(截取核心,逐字)
void HeapRegion::setup_heap_region_size(size_t initial_heap_size, size_t max_heap_size) {
  size_t region_size = G1HeapRegionSize;
  if (FLAG_IS_DEFAULT(G1HeapRegionSize)) {
    size_t average_heap_size = (initial_heap_size + max_heap_size) / 2;
    region_size = MAX2(average_heap_size / HeapRegionBounds::target_number(),
                       HeapRegionBounds::min_size());
  }

  int region_size_log = log2_long((jlong) region_size);
  // Recalculate the region size to make sure it's a power of
  // 2. This means that region_size is the largest power of 2 that's
  // <= what we've calculated so far.
  region_size = ((size_t)1 << region_size_log);

  // Now make sure that we don't go over or under our limits.
  if (region_size < HeapRegionBounds::min_size()) {
    region_size = HeapRegionBounds::min_size();
  } else if (region_size > HeapRegionBounds::max_size()) {
    region_size = HeapRegionBounds::max_size();
  }
```

规则是: **显式给了 `-XX:G1HeapRegionSize` 就用它;没给(默认)就用 `(初始堆+最大堆)/2 / 2048`(先与下限 1MB 取大)**;然后强制取 2 的幂,最后再夹一次上下限。上下限和 2048 从哪来(heapRegionBounds.hpp):

```cpp
// heapRegionBounds.hpp:32-46(截取核心,逐字)
  // Minimum region size; we won't go lower than that.
  // We might want to decrease this in the future, to deal with small
  // heaps a bit more efficiently.
  static const size_t MIN_REGION_SIZE = 1024 * 1024;

  // Maximum region size; we don't go higher than that. There's a good
  // reason for having an upper bound. We don't want regions to get too
  // large, otherwise cleanup's effectiveness would decrease as there
  // will be fewer opportunities to find totally empty regions after
  // marking.
  static const size_t MAX_REGION_SIZE = 32 * 1024 * 1024;

  // The automatic region size calculation will try to have around this
  // many regions in the heap (based on the min heap size).
  static const size_t TARGET_REGION_NUMBER = 2048;
```

所以 4GB 堆(`-Xms4g -Xmx4g`,平均 4GB)→ `4GB/2048 = 2MB`——"2048 块积木"成立;**堆越大,每块积木越大,块数仍维持在 2048 上下**。结果写进全局 `GrainBytes`(:97-101),并顺带算出 `CardsPerRegion = GrainBytes >> card_shift`(:104-105)——每 Region 的卡数,是 RSet 的 per-region card bitmap 尺寸(heapRegionRemSet.cpp:72)与清卡任务按 Region 分块的单位(g1RemSet.cpp:264-266)。*关键设计: 块数固定而非块大小固定,是 G1 的"标尺"逻辑——所有 per-region 结构(bitmap/RSet/BOT)都以 Region 为单位分摊成本: Region 太大,单块粒度粗,清理收益变小;太小,per-region 元数据膨胀。32MB 上限的注释说得直白: 太大则"cleanup's effectiveness would decrease"。*

*Region 有独立的 bottom/end/top 三个指针(类似 TLAB 的 bump-pointer 但粒度大得多): `_bottom/_end` 定义在父类 `Space`(space.hpp:66-67),`_top` 是 G1ContiguousSpace 自己的 `volatile` 字段(heapRegion.hpp:99)——分配就是 `_top` 往前推。一个对象如果 > Region 一半(§2.4),就"横躺"在整数个连续 Region 上,这就是 Humongous(巨型)对象——它不随 Region 走正常晋升,而是 Starts+Continues 连片摆放。*

### 1.2 RegionType — 标签不是"6 种",是位掩码

大纲说"RegionType 6 种",源码里其实是 **8 种**(多出 OpenArchive/ClosedArchive,JDK9+ CDS 归档用),且编码不是顺序编号 0~5,而是**位掩码**——把"掩码位"叠加起来(heapRegionType.hpp:47-62,逐字):

```cpp
// heapRegionType.hpp:47-62(逐字)
  // 00000 0 [ 0] Free
  //
  // 00001 0 [ 2] Young Mask
  // 00001 0 [ 2] Eden
  // 00001 1 [ 3] Survivor
  //
  // 00010 0 [ 4] Humongous Mask
  // 00100 0 [ 8] Pinned Mask
  // 00110 0 [12] Starts Humongous
  // 00110 1 [13] Continues Humongous
  //
  // 01000 0 [16] Old Mask
  //
  // 10000 0 [32] Archive Mask
  // 11100 0 [56] Open Archive
  // 11100 1 [57] Closed Archive
```

*关键设计: 类型是"掩码的组合"而不是独立编号——`StartsHumongous = HumongousMask | PinnedMask`(12),`OpenArchive = ArchiveMask | PinnedMask | OldMask`(56)。这让组合型谓词用**位与**一条指令完成(而不是逐一比较枚举值,heapRegionType.hpp:64-91 的 enum 与 :123-143 的谓词): `is_young() = (get() & YoungMask) != 0`( :125)天然覆盖 Eden+Survivor;`is_humongous()` 同理掩码判断。*
```cpp
// heapRegionType.hpp:123-143(截取核心,逐字)
  bool is_free() const { return get() == FreeTag; }

  bool is_young()    const { return (get() & YoungMask) != 0; }
  bool is_eden()     const { return get() == EdenTag;  }
  bool is_survivor() const { return get() == SurvTag;  }

  bool is_humongous()           const { return (get() & HumongousMask) != 0;   }
  bool is_starts_humongous()    const { return get() == StartsHumongousTag;    }
  bool is_continues_humongous() const { return get() == ContinuesHumongousTag; }

  bool is_archive()        const { return (get() & ArchiveMask) != 0; }
```

类型在 GC 间**动态重贴**: `set_eden()/set_survivor()/set_old()/relabel_as_old()`( :149-176)——Eden 在 GC 后清空变 Free,Survivor 晋升后 `relabel_as_old` 贴 Old 标签。**Region 的内存是固定的,标签是流动的**——这就是"分代在大块之间搬移"的 G1 答案。*Archive 类型(56/57)是 CDS 归档堆的只读区域,普通运行看不到,但谓词里处处要防它——注意 OpenArchive=56 含 `OldMask` 位,`is_old()` 对它也返回 true(注释 :137 "is_old regions may or may not also be pinned"),所以凡是需要排除归档区的路径都得先查 `is_archive()`。*

### 1.3 HeapRegion 结构 — 字段不在同一层

大纲给了一张"平铺"的字段表(`_bottom/_end/_top/_type/_block_offset/_rem_set` 全塞在 HeapRegion 里)——**源码里字段是分层继承的**。先看类骨架(heapRegion.hpp:97-102, :191, 逐字):

```cpp
// heapRegion.hpp:97-102,191(截取核心,逐字)
class G1ContiguousSpace: public CompactibleSpace {
  friend class VMStructs;
  HeapWord* volatile _top;
 protected:
  G1BlockOffsetTablePart _bot_part;
  Mutex _par_alloc_lock;
  ...
class HeapRegion: public G1ContiguousSpace {
```

继承链是 `HeapRegion → G1ContiguousSpace → CompactibleSpace → Space`(大纲的"G1ContiguousSpace 继承 ContiguousSpace"是另一条线——space.hpp:501 的 ContiguousSpace 是 CMS/Serial 的空间,不在 G1 链上):
- **`_bottom/_end` 在 Space**(space.hpp:66-67)——Region 的地址范围;
- **`_top` 在 G1ContiguousSpace**(heapRegion.hpp:99)——分配指针;
- **`_bot_part` 在 G1ContiguousSpace**( :101)——BOT(Block Offset Table)的 per-region 部分,类型是 `G1BlockOffsetTablePart`,不是独立的表。BOT 的实体是**全堆共享一张** `G1BlockOffsetTable`,`_offset_array` 是 u_char 数组(每 512 字节一个 entry,blockOffsetTable.hpp:50-55 `LogN=9`),每个 Region 的 `_bot_part` 只记自己的 `_next_offset_threshold/_next_offset_index`(g1BlockOffsetTable.hpp:114-115)——"任意地址 → 该对象起点"的 O(1) 反查(GC 扫描 card 后靠它定位根对象)。大纲的"sparse(128-byte) + per-card 两层表"是旧版(8u 时代)的 BOT 设计,**jdk11u 已合并成单层 u_char 数组**。

真正属于 `HeapRegion` 的字段在 :196-264(截取核心):

```cpp
// heapRegion.hpp:196-264(截取核心,逐字)
 private:
  // The remembered set for this region.
  // (Might want to make this "inline" later, to avoid some alloc failure
  // issues.)
  HeapRegionRemSet* _rem_set;
  ...
 protected:
  // The index of this region in the heap region sequence.
  uint  _hrm_index;

  HeapRegionType _type;

  // For a humongous region, region in which it starts.
  HeapRegion* _humongous_start_region;

  // True iff an attempt to evacuate an object in the region failed.
  bool _evacuation_failed;

  // Fields used by the HeapRegionSetBase class and subclasses.
  HeapRegion* _next;
  HeapRegion* _prev;
  ...
  // We use concurrent marking to determine the amount of live data
  // in each heap region.
  size_t _prev_marked_bytes;    // Bytes known to be live via last completed marking.
  size_t _next_marked_bytes;    // Bytes known to be live via in-progress marking.
  ...
  // The start of the unmarked area. The unmarked area extends from this
  // word until the top and/or end of the region, and is the part
  // of the region for which no marking was done, i.e. objects may
  // have been allocated in this part since the last mark phase.
  // "prev" is the top at the start of the last completed marking.
  // "next" is the top at the start of the in-progress marking (if any.)
  HeapWord* _prev_top_at_mark_start;
  HeapWord* _next_top_at_mark_start;
```

*关键设计: `_hrm_index`(Region 在堆里的序号,§2.2 的索引表)、`_type`(§1.2 的标签)、`_humongous_start_region`(Continues 区指回 Starts 区)、`_prev/_next_marked_bytes`(两次标记测出的存活字节数——G1 的 GC 效率与收集集选择就靠它)、`_next/_prev`(挂在 FreeRegionList 双向链表上的指针)。最妙的是 **TAMS(Top At Mark Start)双指针**: 并发标记开始那一刻记 `_next_top_at_mark_start = top()`——标记只覆盖"标记开始前就存在的对象",标记期间新分配的对象在 TAMS 之上、**本轮的标记位图根本不碰它们**,由下一轮标记接管;标记结束后 `note_end_of_marking` 把 next 拷贝进 prev、next 重置回 bottom(heapRegion.inline.hpp:248-253)。于是"活着多少"永远有一份上一轮已完成的测量(prev)可用,不必等本轮结束。这就是并发标记与分配并行不冲突的基石。*

## 2. "G1 的堆引擎" — G1CollectedHeap

### 2.1 类骨架: 一个容器 + 一堆子管理器

`G1CollectedHeap` 是 `CollectedHeap`(25-02 篇)的 G1 实现(类定义 g1CollectedHeap.hpp:130 起,关键成员 :209-213,截取核心):

```cpp
// g1CollectedHeap.hpp:209-213(截取核心,逐字)
  // The sequence of all heap regions in the heap.
  HeapRegionManager _hrm;

  // Manages all allocations with regions except humongous object allocations.
  G1Allocator* _allocator;
```

它不是庞然大物,而是**一个 `_hrm`(HeapRegionManager)加一群子管理器**: `_allocator`(普通分配)、`_g1_rem_set`(RSet)、`_cm`(并发标记)、`_g1_policy`(暂停目标自适应)、`_collection_set`(本次要收集的 Region 集)、`_g1mm`(JMX)。*大纲的"collect(GCCause) → G1EvacuationPause"流程是旧版 API 名;jdk11u 的入口是 `collect(GCCause)`(g1CollectedHeap.cpp:2005)按 cause 分流到 `VM_G1CollectForAllocation`(young GC)或 `VM_G1CollectFull`(Full GC),真正的暂停体是 `do_collection_pause_at_safepoint`( :2794)。*

### 2.2 initialize — 保留地址 + 六张"对账单"

`initialize`(g1CollectedHeap.cpp:1533-1727)分三步:

1. **保留整块地址空间**( :1547-1572): `Universe::reserve_heap(max_byte_size, heap_alignment)` 按**最大堆** mmap 保留(不 commit,纯虚拟),然后 `g1_rs = heap_rs.first_part(max_byte_size)` 切出 G1 用的部分(:1587);
2. **建六个 G1RegionToSpaceMapper**( :1588-1624): 堆本体 + BOT + CardTable + CardCounts + 两个并发标记 bitmap(堆本体直接 `G1RegionToSpaceMapper::create_mapper` :1588-1595,其余五个辅助区经 `create_aux_memory_mapper` :1605-1624,内部同样落到 create_mapper)——每个 mapper 都是"把虚拟地址空间切成 Region 粒度、按需 commit 小块"的按揭中介(§2.3);
3. **初始化 `_hrm` 并 commit 初始堆**( :1626, :1670-1674):

```cpp
// g1CollectedHeap.cpp:1589-1595,1626,1670-1674(截取核心,逐字)
  G1RegionToSpaceMapper* heap_storage =
    G1RegionToSpaceMapper::create_mapper(g1_rs,
                                         g1_rs.size(),
                                         page_size,
                                         HeapRegion::GrainBytes,
                                         1,
                                         mtJavaHeap);
  ...
  _hrm.initialize(heap_storage, prev_bitmap_storage, next_bitmap_storage, bot_storage, cardtable_storage, card_counts_storage);
  ...
  // Now expand into the initial heap size.
  if (!expand(init_byte_size, _workers)) {
    vm_shutdown_during_initialization("Failed to allocate initial heap.");
    return JNI_ENOMEM;
  }
```

*关键设计: 大纲说"初始化阶段创建所有 HeapRegion 对象(~2048 个)并构造成 hashtable"——**错**。HeapRegion 对象是**按需创建**的: `_hrm` 持有一张 `G1HeapRegionTable`(它是 `G1BiasedMappedArray<HeapRegion*>`,g1BiasedArray.hpp:99——不是 hashtable,而是把**地址右移 Region 大小**当下标、base 指针直接寻址的数组,`get_by_address` 即 `biased_base()[addr >> shift_by]` :125-127,O(1) 无哈希);region 首次 commit 时才 `new_heap_region(index)` 创建对象,uncommit 时**对象保留复用**(heapRegionManager.hpp:56-59 注释:"When we uncommit the address space of a region we retain the HeapRegion to be able to re-use it")。初始只 commit 初始堆大小对应的 Region(比如 4GB 堆配置下 Region 2MB、`-Xms2g` 就 commit 1024 个),剩下的留着——RSS 只随用随涨。*

### 2.3 commit/uncommit — 按 Region 粒度按揭

`_hrm` 的 commit/uncommit 最终落到 G1RegionToSpaceMapper。两个实现按"Region 大小 vs 页大小"选择(g1RegionToSpaceMapper.cpp:173-185): Region ≥ 页(`G1RegionsLargerThanCommitSizeMapper`——2MB Region 对 4KB 页的典型情况)直接把每个 Region 对应页 commit:

```cpp
// g1RegionToSpaceMapper.cpp:70-84(截取核心,逐字)
  virtual void commit_regions(uint start_idx, size_t num_regions, WorkGang* pretouch_gang) {
    size_t const start_page = (size_t)start_idx * _pages_per_region;
    bool zero_filled = _storage.commit(start_page, num_regions * _pages_per_region);
    if (AlwaysPreTouch) {
      _storage.pretouch(start_page, num_regions * _pages_per_region, pretouch_gang);
    }
    _commit_map.set_range(start_idx, start_idx + num_regions);
    fire_on_commit(start_idx, num_regions, zero_filled);
  }

  virtual void uncommit_regions(uint start_idx, size_t num_regions) {
    _storage.uncommit((size_t)start_idx * _pages_per_region, num_regions * _pages_per_region);
    _commit_map.clear_range(start_idx, start_idx + num_regions);
  }
```

Region < 页时(1MB Region + 2MB 大页)走 refcount 版本(:89-165),同一页被多个 Region 共享时引用计数、最后一个才真正 uncommit。**真正的 OS 调用在 Linux 上是两个 mmap**(大纲说的 MADV_DONTNEED 不存在):

```cpp
// os_linux.cpp:3209-3218,3641-3645(截取核心,逐字)
int os::Linux::commit_memory_impl(char* addr, size_t size, bool exec) {
  int prot = exec ? PROT_READ|PROT_WRITE|PROT_EXEC : PROT_READ|PROT_WRITE;
  uintptr_t res = (uintptr_t) ::mmap(addr, size, prot,
                                     MAP_PRIVATE|MAP_FIXED|MAP_ANONYMOUS, -1, 0);
  ...
bool os::pd_uncommit_memory(char* addr, size_t size) {
  uintptr_t res = (uintptr_t) ::mmap(addr, size, PROT_NONE,
                                     MAP_PRIVATE|MAP_FIXED|MAP_NORESERVE|MAP_ANONYMOUS, -1, 0);
  return res  != (uintptr_t) MAP_FAILED;
}
```

*commit = 用 `PROT_READ|WRITE` 重新 mmap 覆盖(还给物理页),uncommit = 用 `PROT_NONE` 再 mmap 一次(把页变成不可访问,OS 后台回收物理页)——**同一个虚拟地址上反复覆盖映射**,所以能随意增删 Region 而不搬动地址。未 commit 的部分是 PROT_NONE——访问即段错误,GC 不会碰。*

### 2.4 分配: humongous 的"横躺"判定

25-02 篇讲过分配入口 `mem_allocate`。G1 的关键判定是 **humongous 阈值 = Region 的一半**:

```cpp
// g1CollectedHeap.hpp:1212-1224(截取核心,逐字)
  static bool is_humongous(size_t word_size) {
    // Note this has to be strictly greater-than as the TLABs
    // are capped at the humongous threshold and we want to
    // ensure that we don't try to allocate a TLAB as
    // humongous and that we don't allocate a humongous
    // object in a TLAB.
    return word_size > _humongous_object_threshold_in_words;
  }

  // Returns the humongous threshold for a specific region size
  static size_t humongous_threshold_for(size_t region_size) {
    return (region_size / 2);
  }
```

对象 **> Region/2**(严格大于——TLAB 也封顶在阈值之下,正好一半的对象仍走普通分配)才走 `attempt_allocation_humongous`(g1CollectedHeap.cpp:320-387)——需要几个 Region 由 `humongous_obj_size_in_regions = align_up(word_size, GrainWords) / GrainWords`(实现 g1CollectedHeap.cpp:311-314)算,然后**找一段连续的 Free Region**(`find_contiguous_only_empty`,不行就 `find_contiguous_empty_or_unavailable` 并 expand_at 新 commit),第一个标 `StartsHumongous`、后面的标 `ContinuesHumongous`(:375 的 `humongous_obj_allocate_initialize_regions`)。*humongous 对象在 evacuation 时不搬——它太大,搬不动;回收靠"Eager Reclaim"(整段没人引用就整段释放)或 Full GC 压缩。这也是为什么对象在 Region 里"横躺"而不切割: 对象不可跨 Region 分片。*

**[实证](materials/commands/25-gc-heap-alloc-demo.txt)**: 4MB 数组在 2MB Region 的堆上正好 2 个 Region——`GC(0) Pause Young (Concurrent Start) (G1 Humongous Allocation)`;分配到 OOM 时 `Pause Full (G1 Humongous Allocation)`——cause 与流程一一对应(25-02 篇已证)。

### 2.5 GC 入口: pause 与 Full 两条路

`do_collection_pause_at_safepoint`(g1CollectedHeap.cpp:2794-3123)是 young/mixed GC 的本体,大纲的 "G1EvacuationPause" 类名不存在,实际流程(截取核心):

```cpp
// g1CollectedHeap.cpp:2794-2800,2944-2980(截取核心,逐字)
G1CollectedHeap::do_collection_pause_at_safepoint(double target_pause_time_ms) {
  assert_at_safepoint_on_vm_thread();
  guarantee(!is_gc_active(), "collection is not reentrant");

  if (GCLocker::check_active_before_gc()) {
    return false;
  }
  ...
        g1_policy()->finalize_collection_set(target_pause_time_ms, &_survivor);
        ...
        // Initialize the GC alloc regions.
        _allocator->init_gc_alloc_regions(evacuation_info);

        G1ParScanThreadStateSet per_thread_states(this, workers()->active_workers(), collection_set()->young_region_length());
        pre_evacuate_collection_set();

        // Actually do the work...
        evacuate_collection_set(&per_thread_states);

        post_evacuate_collection_set(evacuation_info, &per_thread_states);

        const size_t* surviving_young_words = per_thread_states.surviving_young_words();
        free_collection_set(&_collection_set, evacuation_info, surviving_young_words);
```

骨架是: **① `finalize_collection_set` 按暂停目标选 Region 组队(候选按 `gc_efficiency` 排序——`reclaimable_bytes()/预测耗时` 的比值,由 §1.3 的 `_prev_marked_bytes` 存活测度推导,排序比较在 collectionSetChooser.cpp:52-53)→ ② `pre_evacuate_collection_set` → ③ `evacuate_collection_set`(GC worker 把存活对象拷到 GC alloc region,标记对象的新家)→ ④ `free_collection_set`(清空 Eden 整组 Region 还回 free list,变 Free 标签)→ ⑤ 收尾时按需 `expand`(:3022-3034)**。*Eden 一次性全清空、Survivor 存活者 `relabel_as_old` 贴 Old——这就是"Region 类型动态流转"的执行现场。shrink 不走 pause——只在 Full GC 之后由 `resize_if_necessary_after_full_collection`( :1155-1231)按 `MaxHeapFreeRatio` 判定容量超额时调用(`shrink` 在 :1229)。*

Full GC 走 `do_full_collection`( :1124)→ `G1FullCollector`(g1FullCollector.cpp:167-179,逐字):

```cpp
// g1FullCollector.cpp:167-179(逐字)
void G1FullCollector::collect() {
  phase1_mark_live_objects();
  verify_after_marking();

  // Don't add any more derived pointers during later phases
  deactivate_derived_pointers();

  phase2_prepare_compaction();

  phase3_adjust_pointers();

  phase4_do_compaction();
}
```

经典的四阶段(标记→算目标→改指针→搬移),与 Serial/CMS 的 full GC 同构——只有 Full GC 才把 humongous 横躺对象真正搬动。*大纲说"full_collection → G1FullCollector(serial parallel compaction)"方向正确: phase2-4 是并行压缩,compaction 后 `_hrm.shrink` 可把堆顶空闲 Region uncommit 还给 OS。*

## 核心悬念

G1 的堆地图画完了: **Region 尺寸**(`(Xms+Xmx)/2/2048` 取 2 的幂夹在 1MB~32MB)、**类型标签**(8 种、位掩码编码、GC 间动态重贴)、**HeapRegion 分层结构**(bottom/end 在 Space、top/bot_part 在 G1ContiguousSpace、TAMS 双指针在 HeapRegion)、**引擎**(G1CollectedHeap = 一个 `_hrm` + 子管理器;initialize 保留整块地址、六张 mapper 按需 commit;Linux 用 mmap 覆盖实现 commit/uncommit;分配先判 humongous 阈值 Region/2;pause 走 finalize CSet → evacuate → free,full 走四阶段压缩)。但留下一根引线: TAMS 说"并发标记只标记标记开始前就存在的对象"——**标记线程怎么跟分配线程抢进度、怎么知道"上一轮标记了多少"、bitmap 和 TAMS 怎么配合**,下一篇: 并发标记。

> → [26-g1-gc/02 — 应用还在跑——你怎么知道谁活着？— 并发标记 + SATB](openjdk/vol-02/26-g1-gc/02-concurrent-mark.md)
