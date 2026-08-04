# G1 Young GC 详解（三）——Post-Evacuation / Free CSet / 完整时间线

> **系列定位**：三篇串讲一次 Normal Young GC。第三篇讲解搬运完成后的收尾——弱引用处理、释放 CSet Region、启动下一轮 CSet。
>
> **前置**：第一篇（08-01）——触发 / GCLocker / CSet / Pre-Evacuation。第二篇（08-02）——Root 扫描 / RSet 扫描 / 工作窃取。

---

## 1. Post-Evacuation——搬运后的收尾

### 1.1 全部搬完了，现在还要做什么

所有活对象已经被搬出 CSet（08-02）。现在 CSet 里的 Region 全是空的（活的对象搬走了，死的本来就不需要搬），可以被整个释放。但在这之前——还有一类引用需要处理——弱引用。

```cpp
// g1CollectedHeap.cpp:2977 (调用站点) → 定义在 4099
post_evacuate_collection_set(&per_thread_states);
```

内部（g1CollectedHeap.cpp:4099-4167，在 GC 收尾期间单线程顺序执行）：

```
1. RSet 扫描收尾——cleanup_after_oops_into_collection_set_do()
2. 引用处理——process_discovered_references()
3. 弱引用清理——WeakProcessor::weak_oops_do()
4. 字符串去重——G1StringDedup::unlink_or_oops_do()
5. 搬不走处理——if (evacuation_failed()) { restore_after_evac_failure() }
6. 释放 GC 分配 Region——_allocator->release_gc_alloc_regions()
7. 合并 per-worker 统计——merge_per_thread_state_info()
8. 恢复热卡缓存——reset_hot_cache() + set_use_cache(true)
9. 清空 nmethod 弱引用——purge_code_root_memory()
10. 把日志中积压的 dirty card 标红——redirty_logged_cards()
11. 更新 JIT 派生指针——DerivedPointerTable::update_pointers()（COMPILER2_OR_JVMCI 才执行）
```

### 1.2 引用处理——Soft / Weak / Final / Phantom

为什么放在所有对象都搬完之后？因为这四种引用类型的判定都需要知道 **"referent 还活着吗"**——而"是否活着"只有在整个对象图遍历完之后才能回答。

`process_discovered_references()`（g1CollectedHeap.cpp:3953-4021）调用 `ReferenceProcessor::process_discovered_references()`（referenceProcessor.cpp:201+），分四轮处理。ReferenceProcessor 用一个 `DiscoveredList*` 主数组（`_discovered_refs`, referenceProcessor.hpp:264），四个指针指向数组内不同偏移：

| 字段 | 指向 | 处理时机 |
|------|------|---------|
| `_discoveredSoftRefs` | 主数组的 Soft 槽位 | 第一轮——根据 timestamp 和堆使用率决定是否回收 |
| `_discoveredWeakRefs` | 主数组的 Weak 槽位 | 第二轮——referent 死 → 入 ReferenceQueue |
| `_discoveredFinalRefs` | 主数组的 Final 槽位 | 第三轮——`finalize()` 没跑完前保持存活 |
| `_discoveredPhantomRefs` | 主数组的 Phantom 槽位 | 第四轮——从不保持存活，死亡则通知 |

**第一轮：Soft 引用重新判定**。Soft 引用的 referent 不一定被回收——根据 `SoftReference` 的 timestamp 和堆使用率决定"这个 soft reference 是不是太旧了，该回收了"。

**第二轮：Soft / Weak / Final 引用处理**。对 referent 调用 `G1STWIsAliveClosure` 检查存活状态——活着就 keep-alive，死了就 enqueue。

**第三轮：Final 引用的 keep-alive**。`finalize()` 还没跑完的对象不能提前回收。

**第四轮：Phantom 引用处理**。从不保持 referent 存活——死了就入队通知。

### 1.3 弱引用清理 + 字符串去重

`WeakProcessor::weak_oops_do()`（weakProcessor.cpp:36）清理 StringTable 和 ResolvedMethodTable 中无活跃引用的条目。

`G1StringDedup::unlink_or_oops_do()`（g1StringDedup.cpp:132）处理字符串去重——清理已死的去重条目。

### 1.4 恢复热卡缓存

GC 期间热卡缓存被关闭了（08-01 §8）。GC 结束后恢复——`_hot_card_cache->set_use_cache(true)` 和 `redirty_logged_cards()` 把 post-evacuation 引用处理中产生的新 dirty card 标记好。

---

## 2. Free CSet——搬完收地

### 2.1 做什么

CSet 里的所有活对象都被搬走了。现在每个 Region 是"**没有活对象但 RSet 还挂在上面**"的空壳——需要清空 RSet、重置元数据、归还 free list。

```cpp
// g1CollectedHeap.cpp:2980 (调用站点) → 定义在 4489
free_collection_set(&_collection_set, evacuation_info, surviving_young_words);
```

这个方法创建并行 `G1FreeCollectionSetTask`（g1CollectedHeap.cpp:4233-4469）。该类包含 `_serial_work_claim`（volatile jint）和 `_parallel_work_claim`（volatile size_t）两个 CAS 抢单字段，以及 `_work_items`（WorkItem*）预分配的工作项数组。

### 2.2 串行部分：释放 Region

只有一个 Worker 执行——第一个用 `Atomic::add` 抢到 `_serial_work_claim` 的。遍历 CSet 每个 Region：

```
if (!r->evacuation_failed()) → free_region() → 归还
if (r->evacuation_failed())  → r->set_old()  → old_set_add(r)
```

`free_region()`（g1CollectedHeap.cpp:4177-4201）做了什么：

```cpp
// g1CollectedHeap.cpp:4177-4201
void G1CollectedHeap::free_region(HeapRegion* hr,
                                  FreeRegionList* free_list,
                                  bool skip_remset,
                                  bool skip_hot_card_cache,
                                  bool locked) {
    assert(!hr->is_free(), "the region should not be free");
    assert(!hr->is_empty(), "the region should not be empty");
    assert(_hrm.is_available(hr->hrm_index()), "region should be committed");
    assert(free_list != NULL, "pre-condition");

    // 仅在 VerifyBitmaps 开启时清空并发标记位图
    if (G1VerifyBitmaps) {
        MemRegion mr(hr->bottom(), hr->end());
        concurrent_mark()->clear_range_in_prev_bitmap(mr);
    }

    // 清空热卡计数（young Region 的 card 本就不会被 refinement 处理）
    if (!skip_hot_card_cache && !hr->is_young()) {
        _hot_card_cache->reset_card_counts(hr);
    }

    hr->hr_clear(skip_remset, true /* clear_space */, locked); // ★ 核心清理
    _g1_policy->remset_tracker()->update_at_free(hr);           // 更新追踪器
    free_list->add_ordered(hr);                                  // 插入 free list
}
```

`hr_clear()`（heapRegion.cpp:112-135）：

```cpp
void HeapRegion::hr_clear(bool keep_remset, bool clear_space, bool locked) {
    set_young_index_in_cset(-1);      // 不再属于任何 CSet
    uninstall_surv_rate_group();      // 退出存活率追踪
    set_free();                        // Tag = FreeTag (0)
    reset_pre_dummy_top();             // 重置 next TAMS——dummy 填充的起点

    if (!keep_remset) {
        if (locked) {
            rem_set()->clear_locked(); // 持锁时清空 RSet——Region 要重用了
        } else {
            rem_set()->clear();        // 无锁时直接清空
        }
    }

    zero_marked_bytes();              // 清空并发标记字节数
    init_top_at_mark_start();         // 重置 TAMS
    if (clear_space) clear(SpaceDecorator::Mangle);  // 清零堆空间
}
```

### 2.3 并行部分：清空 RSet

所有 Worker 按 32 个 Region 为一批（`chunk_size() = 32`），用 `_parallel_work_claim` 抢任务。每批内的工作——`r->rem_set()->clear_locked()` + 清空 hot card cache 计数。

### 2.4 合并到全局 FreeList

`prepend_to_freelist()`（g1CollectedHeap.cpp:4221-4227）在 `FreeList_lock` 保护下，把局部 free list 合并到 `HeapRegionManager::_free_list`。`add_ordered(hr)` 保证 `_free_list` 按 `hrm_index` 升序排列——Old Region 分配从头取（低地址），Young Region 分配从尾取（高地址）。

### 2.5 evacuation_failed——搬不走的情况

如果 Survivor/Old Region 空间不足，对象搬不走——该 Region 不能释放（里面还有活对象），标记为 Old 留在堆里。反复出现会最终触发 Full GC。

---

## 3. 启动下一个 CSet——为本轮收尾

```cpp
// g1CollectedHeap.cpp:2989
start_new_collection_set();
```

内部（g1CollectedHeap.cpp:2784-2791）：

```cpp
void G1CollectedHeap::start_new_collection_set() {
    collection_set()->start_incremental_building();    // _inc_build_state = Active
    clear_cset_fast_test();                            // 清空 in_cset_fast_test 位图
    g1_policy()->transfer_survivors_to_cset(survivor()); // ★ 本轮 Survivor → 下一轮 CSet
}
```

`transfer_survivors_to_cset()`（g1Policy.cpp:1148-1176）遍历本轮 GC 存活下来的 Survivor Region，对每个调用 `add_survivor_regions(curr)`——它们被加入下一轮 GC 的增量 CSet 数组。

**为什么现在就加入**——下一轮 GC 必须扫描这些 Survivor Region（里面的对象可能晋升、可能被搬、可能死了）。提前加入 CSet 后，mutator 运行期间 Refinement 线程就可以在增量构建过程中累积这些 Region 的 RSet 统计。

等到下次 GC 开始时，`finalize_young_part()` 调 `survivors->convert_to_eden()`（g1SurvivorRegions.cpp:42-50）——把 Tag 从 `SurvTag(3)` 改为 `EdenTag(2)`。

```cpp
// g1CollectedHeap.cpp:3020
_allocator->init_mutator_alloc_region();
```

从 FreeList 拿一个新的 Eden Region 挂到 `MutatorAllocRegion` 上——GC 结束后 mutator 从这里开始分配。

如果 InitialMark 判定为 true（08-01 §6），`do_concurrent_mark()`（g1CollectedHeap.cpp:2523）通知 CM 线程启动并发标记周期。

---

## 4. 完整时间线

> **注意**：以下行号均为 `do_collection_pause_at_safepoint()` 内部的**调用站点**（g1CollectedHeap.cpp:2794-3123），而非各函数的定义位置。定义位置详见后续各节。

```
T0: safepoint begin → 所有线程停下
T1: GCLocker check → pass                                  do_collection_pause_at_safepoint L2798 →
T2: decide_on_conc_mark_initiation → Normal                 do_collection_pause_at_safepoint L2826 →
T3: release active Eden region                              do_collection_pause_at_safepoint L2926 →
T4: finalize_collection_set (lock CSet)                     do_collection_pause_at_safepoint L2944 →
T5: pre_evacuate (merge dirty cards, reset scan_state)     do_collection_pause_at_safepoint L2972 →
T6: evacuate_collection_set（并行）                          do_collection_pause_at_safepoint L2975 →
    Worker 0: evacuate_roots(0) → RS scan → steal & trim
    Worker 1: evacuate_roots(1) → ...
    ... 所有 Worker 并行，直到队列全空
T7: post_evacuate (引用处理/弱引用/去重)                     do_collection_pause_at_safepoint L2977 →
T8: free_collection_set (释放空 Region)                     do_collection_pause_at_safepoint L2980 →
T9: start_new_collection_set (Survivor → 新 CSet)           do_collection_pause_at_safepoint L2989 →
T10: init_mutator_alloc_region                               do_collection_pause_at_safepoint L3020 →
T11: safepoint end → mutator 恢复运行
```

**GC 日志的时间**（如 `8.234ms`）——T3→T11 的总时间（不含 safepoint 到达时间 T0→T2）。

**GC 日志的格式**：
```
Pause Young (Normal) (G1 Evacuation Pause) 128M→64M(1024M) 8.234ms
```
- `(Normal)` = YoungOnlyGC
- `(G1 Evacuation Pause)` = GCCause 字符串
- `128M→64M(1024M)` = GC 前后堆使用量（总容量）
- `8.234ms` = 纯 GC 工作时间

---

## 5. 总结

| 阶段 | 做什么 | 关键源码 |
|------|--------|---------|
| GCLocker | 检查 JNI critical section | g1CollectedHeap.cpp:2798 |
| InitialMark? | IHOP 判定是否启动 CM | g1Policy.cpp:936 |
| CSet | 锁定增量构建的 CSet | g1CollectionSet.cpp:356 |
| Pre-Evac | merge dirty cards + reset scan_state | g1RemSet.cpp:511 |
| Root Scan | 12 子任务 CAS claim 分工 | g1RootProcessor.cpp:78 |
| RSet Scan | update_rem_set + scan_rem_set | g1RemSet.cpp:506 |
| Work Stealing | trim + steal + terminate | g1CollectedHeap.cpp:3157 |
| Post-Evac | 引用处理 / 弱引用 / 去重 | g1CollectedHeap.cpp:4099 |
| Free CSet | 释放空 Region / evac_failed → Old | g1CollectedHeap.cpp:4489 |
| New CSet | Survivor → 下一轮 CSet 种子 | g1CollectedHeap.cpp:2784 |

---

## 附录: 字段速查

| 字段 | 所在类 | 类型 | 源码位置 | 用途 |
|------|--------|------|---------|------|
| `_discovered_refs` | `ReferenceProcessor` | `DiscoveredList*` | referenceProcessor.hpp:264 | 四种引用合在一起的主数组 |
| `_discoveredSoftRefs` | `ReferenceProcessor` | `DiscoveredList*` | referenceProcessor.hpp:267 | 指向主数组的 Soft 引用槽位 |
| `_discoveredWeakRefs` | `ReferenceProcessor` | `DiscoveredList*` | referenceProcessor.hpp:268 | 指向主数组的 Weak 引用槽位 |
| `_discoveredFinalRefs` | `ReferenceProcessor` | `DiscoveredList*` | referenceProcessor.hpp:269 | 指向主数组的 Final 引用槽位 |
| `_discoveredPhantomRefs` | `ReferenceProcessor` | `DiscoveredList*` | referenceProcessor.hpp:270 | 指向主数组的 Phantom 引用槽位 |
| `_serial_work_claim` | `G1FreeCollectionSetTask` | `volatile jint` | g1CollectedHeap.cpp:4342 | 串行工作声明——CAS 抢单 |
| `_parallel_work_claim` | `G1FreeCollectionSetTask` | `volatile size_t` | g1CollectedHeap.cpp:4356 | 并行工作声明——32 Region/批抢单 |
| `_work_items` | `G1FreeCollectionSetTask` | `WorkItem*` | g1CollectedHeap.cpp:4358 | 预分配的工作项数组 |
