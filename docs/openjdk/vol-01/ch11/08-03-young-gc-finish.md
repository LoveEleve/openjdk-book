# G1 Young GC 详解（三）——Post-Evacuation / Free CSet / 完整时间线

> **系列定位**：三篇串讲一次 Normal Young GC。第三篇讲解搬运完成后的收尾工作——弱引用处理、释放 CSet Region、启动下一轮 CSet 的种子。附录有完整时间线、young target 算法、TLAB 三级挽救详情。
>
> **前置**：第一篇（08-01）——触发 / CSet / Pre-Evacuation。第二篇（08-02）——Root 扫描 / RSet 扫描 / 工作窃取。

---

## 1. Post-Evacuation——搬运后的收尾

### 1.1 全部搬完了，现在还要做什么

所有活对象已经被搬出 CSet（08-02 的三个阶段）。现在 CSet 里的 Region 全是空的（活的对象搬走了，死的本来就不需要搬），可以被整个释放。但在此之前——还有一个类引用需要处理——弱引用。

```cpp
// g1CollectedHeap.cpp:2977
post_evacuate_collection_set(&per_thread_states);
```

内部（g1CollectedHeap.cpp:4099-4166）分五步：

```
1. RSet 扫描收尾——cleanup_after_oops_into_collection_set_do()
2. 引用处理——process_discovered_references()
3. 弱引用清理——WeakProcessor::weak_oops_do()
4. 字符串去重——G1StringDedup::unlink_or_oops_do()
5. 恢复热卡缓存——reset_hot_cache() + redirty_logged_cards()
```

### 1.2 引用处理——Soft / Weak / Final / Phantom

为什么放在所有对象都搬完之后？因为这四种引用类型的判定都需要知道 **"referent 还活着吗"**——而"是否活着"只有在整个对象图遍历完之后才能回答。

`process_discovered_references()`（g1CollectedHeap.cpp:3953-4021）调用标准的 `ReferenceProcessor::process_discovered_references()`（referenceProcessor.cpp:201-261），分四轮处理：

**第一轮：Soft 引用重新判定**。Soft 引用的 referent 不一定被回收——JVM 根据 `SoftReference` 的 timestamp 和堆使用率决定 "这个 soft reference 是不是太旧了，该回收了"。如果 timestamp 太旧，referent 被回收；否则保留。

**第二轮：Soft / Weak / Final 引用处理**。对应这三种类型的 referent，JVM 调用 `is_alive` 闭包（`G1STWIsAliveClosure`）检查 referent 在 GC 后还活着吗：
- 活着 → `keep_alive` 闭包保持它存活
- 死了 → `enqueue` 闭包把它放入对应的 ReferenceQueue

**第三轮：Final 引用的 keep-alive**。`finalize()` 方法需要被调用的对象不能提前回收——即使它的 referent 在 GC 中死了，`finalize()` 还没跑完之前必须保持存活。这一轮专门保留这些对象。

**第四轮：Phantom 引用处理**。Phantom 引用从不在 GC 中保持 referent 存活——它的语义就是 "referent 已经死了，我只是个通知"。referent 死了 → PhantomReference 入队。

### 1.3 弱引用清理——StringTable / 符号表

`WeakProcessor::weak_oops_do()` 清理 JVM 内部使用弱引用的数据结构：

- **StringTable**——`String.intern()` 产生的字符串。如果 intern 的字符串没有活跃引用指向它，对应的 table 条目清除
- **ResolvedMethodTable**——方法解析缓存。类和方法的引用关系变了，过期的缓存条目清除

### 1.4 恢复热卡缓存 + re-dirty logged cards

GC 期间热卡缓存（HotCardCache）被关闭了（08-01 §5.1）。GC 结束后：
- `_hot_card_cache->reset_hot_cache()`——重置缓存计数
- `redirty_logged_cards()`——把 post-evacuation 引用处理过程中产生的新的 dirty card（来自引用入队等操作）标记为 dirty，确保下一轮 GC 不会漏掉

---

## 2. Free CSet——搬完收地

### 2.1 做什么

CSet 里的所有活对象都被搬走了（08-02）。现在 CSet 里的每个 Region 都是 "**没有活对象但还不能用的空壳**"——RSet 还挂在上面，hot card cache 里还有计数，Region 的元数据还没重置。

`free_collection_set()`（g1CollectedHeap.cpp:2980）创建并行的 `G1FreeCollectionSetTask`：

```cpp
free_collection_set(&_collection_set, evacuation_info, surviving_young_words);
  → G1FreeCollectionSetTask task(...);
  → workers()->run_task(&task);
```

### 2.2 串行部分：释放 Region

`FreeCollectionSetTask` 的串行部分（只有一个 Worker 执行——第一个用 `Atomic::add` 抢到 `_serial_work_claim` 的）：

遍历 CSet 每个 Region，对每个 Region 判断：

```
if (!r->evacuation_failed()) {
    // 搬成功了 → Region 没活对象了 → 释放
    free_region(r, &local_free_list);
} else {
    // 搬失败了 → Region 里还有活对象搬不走 → 标记为 Old，留在堆里
    r->set_old();
    g1h->old_set_add(r);
}
```

**`free_region()` 做了什么**（g1CollectedHeap.cpp:4177-4201）：

```cpp
void G1CollectedHeap::free_region(HeapRegion* hr, ...) {
    // 1. 清空并发标记位图（如果启用验证）
    concurrent_mark()->clear_range_in_prev_bitmap(hr);

    // 2. 清空 hot card cache 计数
    _hot_card_cache->reset_card_counts(hr);

    // 3. hr_clear()——核心清理
    hr->hr_clear(skip_remset, true, locked);

    // 4. 更新 RSet 追踪器
    _g1_policy->remset_tracker()->update_at_free(hr);

    // 5. 插入局部 free list（按 hrm_index 升序）
    local_free_list->add_ordered(hr);
}
```

`hr_clear()`（heapRegion.cpp:112-135）的重置步骤：
```cpp
void HeapRegion::hr_clear(bool keep_remset, bool clear_space, bool locked) {
    set_young_index_in_cset(-1);     // 不再属于任何 CSet
    uninstall_surv_rate_group();     // 退出存活率追踪
    set_free();                       // Tag = FreeTag (0)

    if (!keep_remset) {
        rem_set()->clear_locked();   // 清空 RSet——Region 要重用了
    }

    zero_marked_bytes();             // 清空并发标记字节数
    init_top_at_mark_start();        // 重置 TAMS
    if (clear_space) clear(SpaceDecorator::Mangle);  // 清零/混淆堆空间
}
```

### 2.3 并行部分：清空 RSet 和 hot card cache

所有 Worker 并行执行——按 32 个 Region 为一批，用 `Atomic::add` 抢任务：

```cpp
static uint chunk_size() { return 32; }

// Worker 循环
while (true) {
    size_t end = Atomic::add(chunk_size(), &_parallel_work_claim);
    size_t cur = end - chunk_size();
    if (cur >= _num_work_items) break;

    for (; cur < min(end, _num_work_items); cur++) {
        do_parallel_work_for_region(region_idx, is_young, evacuation_failed);
    }
}
```

每个 Region 的并行工作——清空 RSet（`r->rem_set()->clear_locked()`）和 hot card cache 计数。RSet 清空是最重的活——有些 Region 的 RSet 可能记录了成百上千个 card 的入引用，需要用锁保护逐条清除。

旧版的工作串行由同个 Worker 分片遍历数组完成（遍历 CSet 数组、分配 32 个 Region 为一组的工人任务）。

### 2.4 回收——合并到全局 FreeList

`prepend_to_freelist()`（g1CollectedHeap.cpp:4221-4227）在 `FreeList_lock` 保护下，把每个 Worker 的局部 free list 合并到 `HeapRegionManager::_free_list` 全局空闲链表上。

**全局空闲链表的排序**——`add_ordered(hr)` 保证 `_free_list` 按 `hrm_index` 升序排列。Old Region 分配从头取（低地址），Young Region 分配从尾取（高地址）——自然产生地址分离的趋势。

### 2.5 evacuation_failed——搬不走的情况

如果 Survivor/Old Region 空间不足，对象搬不走——这叫 evacuation failure：

```
正常路径： 旧对象 → 找空间 → memcpy → 新位置 → 旧 mark word = forwarding pointer
失败路径： 旧对象 → 找不到空间 → 保留在原 CSet Region → 标记 _evacuation_failed = true
```

失败的 Region 不能释放（里面还有活对象）。`free_collection_set()` 的串行部分检测到 `r->evacuation_failed()` → 调用 `r->set_old()` → 把这个 Region 保留在堆里。

反复出现 evacuation failure 会增加 Full GC 的风险——因为 Old Region 没法有效回收（没有并发标记的 liveness 数据），最终只能 Full GC 兜底。

---

## 3. Start New CSet——启动下一轮

### 3.1 把 Survivor 作为下一轮 CSet 的种子

```cpp
// g1CollectedHeap.cpp:2989
start_new_collection_set();
```

内部（g1CollectedHeap.cpp:2784-2791）：

```cpp
void G1CollectedHeap::start_new_collection_set() {
    collection_set()->start_incremental_building();    // _inc_build_state = Active
    clear_cset_fast_test();                            // 清空 in_cset_fast_test 位图
    g1_policy()->transfer_survivors_to_cset(survivor()); // Survivor → 下一轮 CSet
}
```

`transfer_survivors_to_cset()`（g1Policy.cpp:1148-1176）遍历本轮 GC 存活对象所在的 Survivor Region，对每个调用 `add_survivor_regions(curr)`——这些 Region 被加入下一轮 GC 的增量 CSet 数组。

**为什么现在就加入**——下一轮 Young GC 时这些 Survivor Region 里的对象可能晋升（age ≥ tenuring_threshold → 搬到 Old）、也可能被搬到一个新的 Survivor Region、也可能已经死了。无论如何——下一轮 GC 必须扫描它们。提前加入 CSet 的原因是：在 mutator 运行期间，这些 Survivor Region 的 RSet 可能被 Refinement 线程更新——先把它们放到 CSet 里，G1 就能在增量构建期间累积 RSet 长度和预测时间的统计数据。

### 3.2 convert_to_eden——下次 GC 开始时重标标签

等到下一次 Young GC 开始时，`finalize_young_part()` 调 `survivors->convert_to_eden()`（g1SurvivorRegions.cpp:42-50）：

```cpp
void G1SurvivorRegions::convert_to_eden() {
    for (each region) {
        hr->set_eden_pre_gc();   // Tag: SurvTag(3) → EdenTag(2)
    }
    clear();                     // 清空 Survivor 列表
}
```

这次 GC 把 Survivor 转成 Eden 后——它们就像普通的 Eden Region 一样参与本次 GC 的全量回收。G1 的注释说得很清楚：

> "The young list is laid with the survivor regions from the previous pause are appended to the RHS of the young list, i.e. [Newly Young Regions ++ Survivors from last pause]."

### 3.3 启动 mutator 的新分配区

```cpp
// g1CollectedHeap.cpp:3020
_allocator->init_mutator_alloc_region();
```

从 FreeList 中拿一个新的 Eden Region，挂到 `MutatorAllocRegion` 上——GC 结束后 mutator 恢复运行，从这个新区开始分配对象。

### 3.4 如果需要 Concurrent Mark

如果在阶段 2（08-01 §3）的 InitialMark 判断中 `should_start_conc_mark == true`：

```cpp
// g1CollectedHeap.cpp:3119
do_concurrent_mark();    // 通知 CM 线程启动并发标记周期
```

Normal Young GC 时这个值是 false——跳过。

---

## 4. 完整时间线

```
T0: safepoint begin → 所有线程停下
T1: GCLocker check → pass                                  g1CollectedHeap.cpp:2798
T2: decide_on_conc_mark_initiation → Normal                 g1CollectedHeap.cpp:2826
T3: release active Eden region (retire → add to CSet)      g1CollectedHeap.cpp:2926
T4: finalize_collection_set (lock CSet)                     g1CollectedHeap.cpp:2944
    ├─ finalize_young_part: lock incremental build
    ├─ survivors->convert_to_eden()
    └─ finalize_old_part: skip (young-only)
T5: pre_evacuate (merge dirty cards, reset scan_state)     g1CollectedHeap.cpp:2972
T6: evacuate_collection_set (并行)                          g1CollectedHeap.cpp:2975
    ├─ Worker 0: evacuate_roots(0) → RS scan → steal & trim
    ├─ Worker 1: evacuate_roots(1) → RS scan → steal & trim
    └─ ... 所有 Worker 并行，直到队列全空
T7: post_evacuate (引用处理/弱引用/去重)                    g1CollectedHeap.cpp:2977
T8: free_collection_set (释放空 Region)                     g1CollectedHeap.cpp:2980
T9: adjust PLAB sizes + record stats
T10: start_new_collection_set (Survivor → 新 CSet)          g1CollectedHeap.cpp:2989
T11: init_mutator_alloc_region                               g1CollectedHeap.cpp:3020
T12: safepoint end → mutator 恢复运行
```

**GC 日志的时间**：`8.234ms` —— 这是 T3→T11 的总时间（不含 T0→T2 的 safepoint 到达时间）。

**GC 日志的格式**：
```
Pause Young (Normal) (G1 Evacuation Pause) 128M→64M(1024M) 8.234ms
```
- `(Normal)` = YoungOnlyGC（不是 Concurrent Start/Mixed/Prepare Mixed）
- `(G1 Evacuation Pause)` = GCCause，来自 `gc_cause()` 参数
- `128M→64M(1024M)` = GC 前堆使用 128MB → GC 后 64MB（总容量 1024MB）
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
| Free CSet | 释放空 Region / evac_failed → Old | g1CollectedHeap.cpp:2980 |
| New CSet | Survivor → 下一轮 CSet 种子 | g1CollectedHeap.cpp:2784 |
