# 04. new Object() 在 G1 里走到哪？— 分配与晋升

> **前置依赖**:[26-g1-gc/03 — Region A 里谁引用了 Region B？— RSet + CardTable 并发细化](03-rem-set.md):Pause 里已经知道该从哪些来源 card 找入边,本篇接着看对象平时怎么落到 Region 上;[25-gc-framework/02 — new Object() 走到了哪？— CollectedHeap + 分配路径](openjdk/vol-02/25-gc-framework/02-collected-heap.md):TLAB/slow path/`MemAllocator` 总入口已拆,本篇只看 G1 这一层;[26-g1-gc/01 — 堆被切成 2048 块](01-heapregion.md):Region 粒度、humongous 阈值和类型标签都依赖它
> → **后续**:[26-g1-gc/05 — Mixed GC + 策略](05-mixed-gc-policy.md)
> 关联域: 25-04(WorkGang/PLAB)、17-threads(TLAB)、09-memory-core(heap 保留/扩容)

标记和 RSet 都准备好了,但 JVM 还有个最现实的问题: **`new Object()` 到底落哪?** 在 G1 里,普通对象优先走 TLAB,TLAB 不够时去当前 mutator allocation region 继续 bump;GC 拷活对象时,每个 worker 先用自己的 PLAB,PLAB 不够再去 survivor/old 的 GC alloc region 领一段;只有超过 humongous 阈值(> region/2)的对象,才会完全绕过这两套快路径,直接抢一串连续 Region。分配路径之所以复杂,是因为 G1 要同时满足三件事: mutator 快、GC 拷贝快、巨型对象别把 pause 拖死。

---

## 1. mutator 分配 — TLAB 上面是 MutatorAllocRegion

### `G1CollectedHeap::mem_allocate`: 先判 humongous,否则走普通路径

`mem_allocate`(g1CollectedHeap.cpp:398-408)非常直接: 先断言当前不在 safepoint/不持堆锁;若 `is_humongous(word_size)` 为真就 `return attempt_allocation_humongous(word_size)`;否则走普通对象分配 `attempt_allocation(word_size, word_size, &dummy)`。G1 的总入口先做一次非常关键的分流:

- **`is_humongous(word_size)` 为真** → 直接走 humongous 路径;
- 否则走普通对象分配(`attempt_allocation`)。

所以大纲里那种"G1Allocator 三层就是全部分配路径"不完整。**humongous 完全绕过 `G1Allocator` 的 mutator fast path。**

### humongous 阈值是严格大于 region/2

`is_humongous` 与阈值公式(g1CollectedHeap.hpp:1211-1224):

```cpp
// g1CollectedHeap.hpp:1211-1224(截取核心,逐字)
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

两个点必须抓准:

1. **是严格大于(`>`)不是大于等于**;
2. 阈值就是 **region 大小的一半**。

这和 26-02 的实证正好对上: 1MB region 下,512KB 数组加 16B 头后超过 512KB,所以被判成 humongous,进而触发 `Concurrent Start`。

### 普通对象真正落到 `MutatorAllocRegion`

`G1CollectedHeap::attempt_allocation`(g1CollectedHeap.cpp:730-752)先断言“不是 humongous”,再把请求转交给 `_allocator->attempt_allocation(...)`;若失败,就回退到 `attempt_allocation_slow(...)`;成功后再 `dirty_young_block(result, *actual_word_size)` 把新分配的年轻代区间标成 young。真正决定“先吃 retained 还是 active alloc region”的逻辑在 `G1Allocator::attempt_allocation`(g1Allocator.inline.hpp:44-52):

```cpp
// g1Allocator.inline.hpp:44-52(截取核心,逐字)
inline HeapWord* G1Allocator::attempt_allocation(size_t min_word_size,
                                                 size_t desired_word_size,
                                                 size_t* actual_word_size) {
  HeapWord* result = mutator_alloc_region()->attempt_retained_allocation(min_word_size, desired_word_size, actual_word_size);
  if (result != NULL) {
    return result;
  }
  return mutator_alloc_region()->attempt_allocation(min_word_size, desired_word_size, actual_word_size);
}
```

这里暴露出 G1 mutator 路径的两层结构:

1. **先试 retained region** — 上一块快退休但还能塞下 TLAB 的 region,会被 `MutatorAllocRegion` 暂存起来继续吃;
2. **再试当前 active mutator alloc region**。

所以普通对象的真实快路径不是"TLAB 满了直接要新 Eden Region",而是:

- Java 线程先在自己 TLAB 里 bump;
- TLAB refill 时来 G1 要一段新空间;
- G1 先看 retained region,再看当前 mutator alloc region;
- 都不行才进 slow path/新 region/甚至 Young GC。

### `MutatorAllocRegion` 为什么要 retained region

`MutatorAllocRegion` 在 g1AllocRegion.hpp:210-217 明确声明了 `_retained_alloc_region`,注释直接写明它的目的就是 *lower the waste generated during mutation*。真正的保留条件在 `should_retain`(g1AllocRegion.cpp:275-287):

```cpp
// g1AllocRegion.cpp:275-287(截取核心,逐字)
bool MutatorAllocRegion::should_retain(HeapRegion* region) {
  size_t free_bytes = region->free();
  if (free_bytes < MinTLABSize) {
    return false;
  }

  if (_retained_alloc_region != NULL &&
      free_bytes < _retained_alloc_region->free()) {
    return false;
  }

  return true;
}
```

这不是大纲里写的那种"Eden region 满了就 retire,再领一个新的"。G1 多做了一步优化: **如果旧 region 剩的空闲还能装 TLAB,就先别扔,留作 retained region。** 目的只有一个——减少尾部碎片浪费。于是 mutator 阶段可能同时握着:

- 一个当前 active alloc region;
- 一个 retained alloc region。

先吃 retained,再吃 active,最后才去领新 region。并且 mutator alloc region 本身就是 **eden region**: `new_mutator_alloc_region` 用 `new_region(word_size, false /* is_old */, false /* do_expand */)` 领新块,而 `retire_mutator_alloc_region` 里直接 `assert(alloc_region->is_eden())`(g1CollectedHeap.cpp:4850-4880)。

---

## 2. AllocRegion — lock-free first, locked second

### `G1AllocRegion` 是 Region 级分配壳

`G1AllocRegion`(g1AllocRegion.hpp:34-54)的类注释把语义写得很清楚: active region 满了就 retire 并替换;**快路径 allocation 假定 lock-free,真正需要拿锁的是“换 region”这一步。** `_alloc_region` 是 `volatile` 指针,未初始化时为 `NULL`,初始化后会指向 active region 或 dummy region。

### 第一层: 不拿锁直接试当前 region

`G1AllocRegion::attempt_allocation`(g1AllocRegion.inline.hpp:78-90):

```cpp
// g1AllocRegion.inline.hpp:78-90(截取核心,逐字)
inline HeapWord* G1AllocRegion::attempt_allocation(size_t min_word_size,
                                                   size_t desired_word_size,
                                                   size_t* actual_word_size) {
  HeapRegion* alloc_region = _alloc_region;
  assert_alloc_region(alloc_region != NULL, "not initialized properly");

  HeapWord* result = par_allocate(alloc_region, min_word_size, desired_word_size, actual_word_size);
  if (result != NULL) {
    trace("alloc", min_word_size, desired_word_size, *actual_word_size, result);
    return result;
  }
  trace("alloc failed", min_word_size, desired_word_size);
  return NULL;
}
```

这一步只是拿当前 `_alloc_region`,在 region 顶上做并发 bump。真正的并发安全在 `HeapRegion::par_allocate(...)` 里面解决。**如果还能从当前 region 里抠出一段,整个路径不碰堆锁。**

### 第二层: 拿锁重试 + retire + 换新 region

`attempt_allocation_locked`(g1AllocRegion.inline.hpp:98-117):

```cpp
// g1AllocRegion.inline.hpp:98-117(截取核心,逐字)
inline HeapWord* G1AllocRegion::attempt_allocation_locked(size_t min_word_size,
                                                          size_t desired_word_size,
                                                          size_t* actual_word_size) {
  // First we have to redo the allocation, assuming we're holding the
  // appropriate lock, in case another thread changed the region while
  // we were waiting to get the lock.
  HeapWord* result = attempt_allocation(min_word_size, desired_word_size, actual_word_size);
  if (result != NULL) {
    return result;
  }

  retire(true /* fill_up */);
  result = new_alloc_region_and_allocate(desired_word_size, false /* force */);
  if (result != NULL) {
```

锁内有三个动作:

1. **先重试一次** — 防止你等锁这会儿别人已经把 region 换好了;
2. **`retire(true)`** — 把旧 region 填满/封口,保证没人再从它分配;
3. **`new_alloc_region_and_allocate(...)`** — 领新 region,再在新 region 里做第一笔分配。

### 新 region 要先分配成功,再发布为 active

`new_alloc_region_and_allocate`(g1AllocRegion.cpp:134-153):

```cpp
// g1AllocRegion.cpp:134-153(截取核心,逐字)
HeapWord* G1AllocRegion::new_alloc_region_and_allocate(size_t word_size,
                                                       bool force) {
...
  HeapRegion* new_alloc_region = allocate_new_region(word_size, force);
  if (new_alloc_region != NULL) {
    new_alloc_region->reset_pre_dummy_top();
    // Need to do this before the allocation
    _used_bytes_before = new_alloc_region->used();
    HeapWord* result = allocate(new_alloc_region, word_size);
    assert_alloc_region(result != NULL, "the allocation should succeeded");

    OrderAccess::storestore();
    // Note that we first perform the allocation and then we store the
    // region in _alloc_region. This is the reason why an active region
    // can never be empty.
    update_alloc_region(new_alloc_region);
```

这个顺序特别重要:

- 先在新 region 上完成第一笔分配;
- 再 `storestore`;
- 最后把它发布到 `_alloc_region`。

所以**active allocation region 永远不会是 empty region**。别的线程一旦看到 `_alloc_region` 指向某块 region,就一定也能看到它已经有有效的 `top()` 和第一笔对象布局。

---

## 3. slow path — 不够了就尝试锁内分配,再 Young GC

### `attempt_allocation_slow` 是“锁内分配 / 触发 pause / 重试”的循环

`attempt_allocation_slow`(g1CollectedHeap.cpp:410-516):

```cpp
// g1CollectedHeap.cpp:427-455,457-460,500-503(截取核心,逐字)
  for (uint try_count = 1, gclocker_retry_count = 0; /* we'll return */; try_count += 1) {
    bool should_try_gc;
    uint gc_count_before;

    {
      MutexLockerEx x(Heap_lock);
      result = _allocator->attempt_allocation_locked(word_size);
      if (result != NULL) {
        return result;
      }
...
      should_try_gc = !GCLocker::needs_gc();
      // Read the GC count while still holding the Heap_lock.
      gc_count_before = total_collections();
    }

    if (should_try_gc) {
      bool succeeded;
      result = do_collection_pause(word_size, gc_count_before, &succeeded,
                                   GCCause::_g1_inc_collection_pause);
...
    result = _allocator->attempt_allocation(word_size, word_size, &dummy);
    if (result != NULL) {
      return result;
    }
```

普通对象 slow path 不是“直接 Full GC”。它的顺序是:

1. 先在 `Heap_lock` 下做一次 `attempt_allocation_locked`;
2. 还不行,再尝试调度 **一次增量暂停** `do_collection_pause(..., GCCause::_g1_inc_collection_pause)`;
3. pause 后再无锁重试一次 `attempt_allocation(...)`;
4. 还是不行才继续下一轮。

还有一个容易漏掉的分支:g1CollectedHeap.cpp:438-447 里,如果 `GCLocker::is_active_and_needs_gc()` 且 `g1_policy()->can_expand_young_list()` 为真,会先在锁内尝试 `_allocator->attempt_allocation_force(word_size)` 强行领一个新的 mutator alloc region,尽量避免立刻去等 GCLocker 结束。

所以 G1 分配失败的第一反应是 **Young/Mixed pause**,不是 Full GC。只有后面一串策略都失败,才会落到更重的回收路径。

### `allocate_new_tlab` 其实只是普通路径的一个壳

`allocate_new_tlab`(g1CollectedHeap.cpp:389-396)几乎不做额外逻辑: 只断言“TLAB 绝不允许 humongous”,然后直接 `return attempt_allocation(min_size, requested_size, actual_size);`。所以 TLAB refill 在 G1 眼里没有特殊分支——**它只是“带最小值/期望值”的普通 allocation request”**。

---

## 4. GC 分配 — 每个 worker 先吃自己的 PLAB

### `G1PLABAllocator` 不是一个 PLAB,而是 survivor/old 两个

`G1PLABAllocator` 在 g1Allocator.hpp:133-145 里同时维护 `_surviving_alloc_buffer`、`_tenured_alloc_buffer` 和 `_alloc_buffers[InCSetState::Num]`,还单独带着 survivor 对齐参数 `_survivor_alignment_bytes` 与 direct-allocation 统计 `_direct_allocated[]`。所以 GC worker 不是只有一根 PLAB,而是至少两根:

- `Young`/survivor 方向一根;
- `Old`/tenured 方向一根。

这正好对应 evacuation 的两个落点: **幸存下来的年轻对象可能拷去 survivor,也可能直接晋升 old。**

### 快路径: 先在 PLAB 里 bump

`plab_allocate` + `allocate`(g1Allocator.inline.hpp:73-90):

```cpp
// g1Allocator.inline.hpp:73-90(截取核心,逐字)
inline HeapWord* G1PLABAllocator::plab_allocate(InCSetState dest,
                                                size_t word_sz) {
  PLAB* buffer = alloc_buffer(dest);
  if (_survivor_alignment_bytes == 0 || !dest.is_young()) {
    return buffer->allocate(word_sz);
  } else {
    return buffer->allocate_aligned(word_sz, _survivor_alignment_bytes);
  }
}

inline HeapWord* G1PLABAllocator::allocate(InCSetState dest,
                                           size_t word_sz,
                                           bool* refill_failed) {
  HeapWord* const obj = plab_allocate(dest, word_sz);
```

和 TLAB 一样,GC worker 的第一反应也是本地 bump。只有 PLAB 不够时才 refill 或直接分配。

### refill 逻辑: 能新开 PLAB 就开,否则 direct allocate

`allocate_direct_or_new_plab`(g1Allocator.cpp:264-306):

```cpp
// g1Allocator.cpp:264-306(截取核心,逐字)
HeapWord* G1PLABAllocator::allocate_direct_or_new_plab(InCSetState dest,
                                                       size_t word_sz,
                                                       bool* plab_refill_failed) {
  size_t plab_word_size = _g1h->desired_plab_sz(dest);
  size_t required_in_plab = PLAB::size_required_for_allocation(word_sz);
...
  if ((required_in_plab <= plab_word_size) &&
    may_throw_away_buffer(required_in_plab, plab_word_size)) {
...
    HeapWord* buf = _allocator->par_allocate_during_gc(dest,
                                                       required_in_plab,
                                                       plab_word_size,
                                                       &actual_plab_size);
...
    if (buf != NULL) {
      alloc_buf->set_buf(buf, actual_plab_size);

      HeapWord* const obj = alloc_buf->allocate(word_sz);
...
  // Try direct allocation.
  HeapWord* result = _allocator->par_allocate_during_gc(dest, word_sz);
```

逻辑是:

1. 这次对象如果适合塞进 PLAB,并且扔掉旧 PLAB 的剩余空间不算太浪费,就先 retire 旧 PLAB;
2. 向 `G1Allocator::par_allocate_during_gc(...)` 申请一整段新 PLAB;
3. 申请失败,或者对象本来就不适合新建 PLAB,就直接向 GC alloc region 申请这一个对象。

因此大对象晋升时**可能**走这样一条路径: **跳过 PLAB,直接 old allocation region 分配。** 大纲里“所有 GC copy 都先进 PLAB”并不准确。

### `par_allocate_during_gc`: Young/Old 两条支路

`par_allocate_during_gc`(g1Allocator.cpp:174-187,189-232):

```cpp
// g1Allocator.cpp:174-232(截取核心,逐字)
HeapWord* G1Allocator::par_allocate_during_gc(InCSetState dest,
                                              size_t min_word_size,
                                              size_t desired_word_size,
                                              size_t* actual_word_size) {
  switch (dest.value()) {
    case InCSetState::Young:
      return survivor_attempt_allocation(min_word_size, desired_word_size, actual_word_size);
    case InCSetState::Old:
      return old_attempt_allocation(min_word_size, desired_word_size, actual_word_size);
...
HeapWord* G1Allocator::survivor_attempt_allocation(size_t min_word_size,
                                                   size_t desired_word_size,
                                                   size_t* actual_word_size) {
...
    MutexLockerEx x(FreeList_lock, Mutex::_no_safepoint_check_flag);
    result = survivor_gc_alloc_region()->attempt_allocation_locked(min_word_size,
                                                                   desired_word_size,
                                                                   actual_word_size);
...
HeapWord* G1Allocator::old_attempt_allocation(size_t min_word_size,
                                              size_t desired_word_size,
                                              size_t* actual_word_size) {
...
    MutexLockerEx x(FreeList_lock, Mutex::_no_safepoint_check_flag);
    result = old_gc_alloc_region()->attempt_allocation_locked(min_word_size,
                                                               desired_word_size,
                                                               actual_word_size);
```

GC 期间的真正“共享慢点”是 `FreeList_lock`。多个 worker 先无锁试自己挂着的 survivor/old alloc region,不够时才在 `FreeList_lock` 下 retire + 换新 region。和 mutator 路径不同,`new_gc_alloc_region` 调 `new_region(word_size, !is_survivor, true /* do_expand */)` 时允许扩堆(g1CollectedHeap.cpp:4893-4909 起),因为 evacuation 期间不能像 mutator 那样轻易返回失败。**因此 PLAB 解决的是“对象级竞争”; GC alloc region 解决的是“region 级竞争”。**

---

## 5. humongous — 完全绕过 TLAB/PLAB 的连续 Region 分配

### 先算需要几个 Region

`humongous_obj_size_in_regions` + `humongous_obj_allocate`(g1CollectedHeap.cpp:312-345):

```cpp
// g1CollectedHeap.cpp:312-345(截取核心,逐字)
size_t G1CollectedHeap::humongous_obj_size_in_regions(size_t word_size) {
  assert(is_humongous(word_size), "Object of size " SIZE_FORMAT " must be humongous here", word_size);
  return align_up(word_size, HeapRegion::GrainWords) / HeapRegion::GrainWords;
}
...
HeapWord* G1CollectedHeap::humongous_obj_allocate(size_t word_size) {
...
  uint first = G1_NO_HRM_INDEX;
  uint obj_regions = (uint) humongous_obj_size_in_regions(word_size);

  if (obj_regions == 1) {
...
  } else {
    // Policy: Try only empty regions (i.e. already committed first). Maybe we
    // are lucky enough to find some.
    first = _hrm.find_contiguous_only_empty(obj_regions);
```

先 `align_up(word_size, GrainWords) / GrainWords` 算出需要几块连续 Region。然后:

- 只要 1 块时,先走一条更快的单 region 路径;
- 需要多块时,先找**连续 empty region**;
- 不行再找 **empty or unavailable** 区间,必要时扩堆并 commit。

### 真的会去扩堆,不是直接 Full GC

`humongous_obj_allocate` 在 g1CollectedHeap.cpp:345-367 的第二阶段会先 `find_contiguous_empty_or_unavailable(obj_regions)` 找 free+uncommitted 的连续窗口;找到了就 `expand_at(first, obj_regions, workers())` 先扩堆/commit,再 `allocate_free_regions_starting_at(first, obj_regions)`。所以 humongous 分配失败后的顺序也不是"直接 Full GC":

1. 先找已提交的连续空 region;
2. 不够就找 free + uncommitted 的连续窗口;
3. 找到了先 `expand_at(...)` 扩堆/commit,再 `allocate_free_regions_starting_at(...)`;
4. 真连窗口都找不到,这时才进入更重的回收/整理可能性。

### 初始化顺序非常讲究,因为 concurrent refine 可能同时扫这些 region

`humongous_obj_allocate_initialize_regions` 的注释与关键步骤(g1CollectedHeap.cpp:204-210,224-237,255-267,277-290):

```cpp
// g1CollectedHeap.cpp:204-210,224-237,255-267,277-290(截取核心,逐字)
  // We need to initialize the region(s) we just discovered. This is
  // a bit tricky given that it can happen concurrently with
  // refinement threads refining cards on these regions and
  // potentially wanting to refine the BOT as they are scanning
  // those cards (this can happen shortly after a cleanup; see CR
  // 6991377). So we have to set up the region(s) carefully and in
  // a specific order.
...
  // First, we need to zero the header of the space that we will be
  // allocating.
...
  Copy::fill_to_words(new_obj, oopDesc::header_size(), 0);
...
  first_hr->set_starts_humongous(obj_top, word_fill_size);
  _g1_policy->remset_tracker()->update_at_allocate(first_hr);
...
    hr->set_continues_humongous(first_hr);
    _g1_policy->remset_tracker()->update_at_allocate(hr);
...
  OrderAccess::storestore();
...
  for (uint i = first; i < last; ++i) {
    hr = region_at(i);
    hr->set_top(hr->end());
  }
```

这段是本篇最容易被大纲带偏的点。humongous 初始化不是"找到连续 region → 标记 Starts/Continues → 结束"。真实顺序是:

1. 先把新对象头清零,让可能撞上的 refinement 线程看到零 klass 就能安全 bail out;
2. 计算尾部 filler object,补齐最后一块 region 的剩余空间;
3. 先把第一块设成 `StartsHumongous`,后续块设 `ContinuesHumongous`,同时通知 remset tracker;
4. `storestore` 保证前面的 header/BOT/type 更新对别的线程可见;
5. 最后才把各 region 的 `top` 提起来。

**原因不是分配逻辑本身复杂,而是 humongous 初始化和 concurrent refinement 真能并发撞上。** 这是大纲完全没写到的关键约束。

### humongous 分配前会先判断要不要启动并发标记

`attempt_allocation_humongous`(g1CollectedHeap.cpp:857-865):

```cpp
// g1CollectedHeap.cpp:857-865(截取核心,逐字)
  // Humongous objects can exhaust the heap quickly, so we should check if we
  // need to start a marking cycle at each humongous object allocation. We do
  // the check before we do the actual allocation. The reason for doing it
  // before the allocation is that we avoid having to keep track of the newly
  // allocated memory while we do a GC.
  if (g1_policy()->need_to_start_conc_mark("concurrent humongous allocation",
                                           word_size)) {
    collect(GCCause::_g1_humongous_allocation);
  }
```

这就是 26-02 素材里 `Pause Young (Concurrent Start) (G1 Humongous Allocation)` 的根源。humongous 分配是 G1 里一个非常敏感的事件: **它既容易吃掉大量 region,又容易把空洞打得更碎。** 所以 G1 会在分配前先看是否该启动 concurrent mark。

---

## 核心悬念

**G1 的分配并不是一条路,而是三套协作机制:** mutator 平时吃 TLAB + MutatorAllocRegion,GC worker 拷对象时吃 survivor/old PLAB + GC alloc region,巨型对象则完全绕过它们去抢连续 Region。到了这里,G1 已经同时掌握了三件事: **对象活不活**(并发标记)、**谁引用我要收的 Region**(RSet)、**新对象和拷贝对象往哪落**(本篇)。最后剩下的就是策略问题: **哪些 old region 值得进 CSet,一次 mixed GC 要收多少,暂停目标和回收收益怎么折中?** 下一篇看 Mixed GC + policy。

> → [05-mixed-gc-policy.md](05-mixed-gc-policy.md)
