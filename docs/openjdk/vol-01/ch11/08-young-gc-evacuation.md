# G1 Young GC：Evacuation 周期

> **本文定位**：ch11 运行时系列第一篇。讲解一次 Young-only pause 从触发到结束的完整流程——每一步在哪个文件、哪个方法里做了什么。
>
> **前置依赖**：ch11/07（Region 角色 / STW / Evacuation / Root / CSet / 分配-GC 链）。概念定义请查 07，本文只讲具体流程。
>
> **阅读提示**：本文按暂停执行顺序组织，每一步给出源码位置。读完能跟踪一次完整 Young GC 暂停的全部阶段。

---

## 1. 入口——谁触发的、从哪进来

### 1.1 触发链路

分配失败的具体调用链（ch11/07 §7 解释了为什么分配会触发 GC——这里是源码路径）：

```
mutator TLAB 满 → 新 TLAB 分配失败 → Eden 无可用 Region
  → G1CollectedHeap::attempt_allocation_slow()    (g1CollectedHeap.cpp:410)
    → attempt_allocation_locked()                  (g1Allocator.inline.hpp:54)
      → do_collection_pause(word_size, gc_count, ..., 
                             GCCause::_g1_inc_collection_pause)  (:459-460)
        → VM_G1CollectForAllocation op            (:2506)
          → VMThread::execute(&op)                 (:2511)
            → SafepointSynchronize::begin()         ← 所有 mutator 线程停下
              → do_collection_pause_at_safepoint()  ← ★ 本文从这里开始
```

### 1.2 执行位置

`G1CollectedHeap::do_collection_pause_at_safepoint()`（g1CollectedHeap.cpp:2793-3123）——约 330 行的方法，编排了下面 7 个阶段。

---

## 2. 阶段全景——六步走完一次 Young GC

```
目标暂停时间: MaxGCPauseMillis（默认 200ms）

┌─ 阶段 1: CSet 选择 ─────────────────────────┐
│  finalize_collection_set()                   │
│  → Eden + Survivor Region 全量纳入 CSet      │
└──────────────────────────────────────────────┘
                     │
┌─ 阶段 2: Pre-Evacuation ─────────────────────┐
│  prepare_for_oops_into_collection_set_do()   │
│  → 合并 dirty card 日志 / 重置 scan state    │
└──────────────────────────────────────────────┘
                     │
┌─ 阶段 3: Evacuation（核心）──────────────────┐
│  G1ParTask 并行执行:                         │
│   3a. Root 扫描 (evacuate_roots)             │
│   3b. RSet 扫描 (oops_into_collection_set_do)│
│   3c. 干活+偷活 (steal_and_trim_queue)       │
└──────────────────────────────────────────────┘
                     │
┌─ 阶段 4: Post-Evacuation ────────────────────┐
│  引用处理 + 弱引用清理 + 字符串去重           │
│  → process_discovered_references()           │
│  → WeakProcessor + StringDedup               │
└──────────────────────────────────────────────┘
                     │
┌─ 阶段 5: Free CSet ──────────────────────────┐
│  G1FreeCollectionSetTask（并行）             │
│  → 成功撤离的 Region → Free                  │
│  → 失败的 Region → Old                       │
└──────────────────────────────────────────────┘
                     │
┌─ 阶段 6: 启动下一个 CSet ────────────────────┐
│  start_new_collection_set()                  │
│  → 上一轮 Survivor → 下一轮 CSet             │
└──────────────────────────────────────────────┘
```

---

## 3. 阶段 1: CSet 选择——把 Eden + Survivor 全加进去

### 3.1 前置：谁决定了有多少 Eden Region

"把 Eden + Survivor 全加进 CSet"的前提是——**堆里当前到底有多少 Eden 和 Survivor Region？** 这个数量不是随机的，由 G1Policy 的 `_young_list_target_length` 持续管控（g1Policy.hpp:82）：

```cpp
uint _young_list_target_length;   // 目标：堆里应该有多少 Young Region (Eden+Survivor)
uint _young_list_max_length;      // 上限：GC locker 下 Eden 可扩展的最大值
```

**target 怎么算的**（g1Policy.cpp:213-378）：G1Policy 用历史数据预测"到下一次 GC 能分配多少字节"，除以 Region 大小得到需要多少 Regions，然后用二分搜索在 [min, max] 区间内找**能把下次 GC 控制在目标暂停时间内的最大 young gen 大小**：

```
预测器（G1YoungLengthPredictor）对每个候选值回答"will_fit?":
  1. 空间够吗？（young_length < free_regions - reserve）
  2. 暂停会超吗？（base_time + copy_time + other_time ≤ target_pause_time_ms）
  3. 拷贝安全吗？（有足够空间装搬来的活对象？）
```

**上下界**：

| 界 | 如何确定 | 默认值 |
|----|---------|--------|
| 下界 | `G1NewSizePercent` × 堆 Region 数 + 当前 survivor 数 | 5% 堆（最小 1 个 Region） |
| 上界 | `G1MaxNewSizePercent` × 堆 Region 数 | 60% 堆 |
| 还可以被覆盖 | 用户显式设 `-XX:NewSize` / `-XX:MaxNewSize` | — |

每次 GC 结束后，`update_young_list_max_and_target_length()` 重新计算这个 target——下次 Young GC 时 CSet 里的 Eden 数量就是这个 target 驱动的分配结果。

### 3.2 `finalize_collection_set()` 入口

```cpp
// g1CollectedHeap.cpp:2944
g1_policy()->finalize_collection_set(target_pause_time_ms, &_survivor);
```

### 3.3 内部两步

`G1CollectionSet::finalize_young_part()`（g1CollectionSet.cpp:356-398）做五件事：

1. **`finalize_incremental_building()`** — 将增量构建状态从 Active 切 Inactive，锁定构建期累积的各项计数器
2. **算 time budget** — `target_pause_time_ms - base_time_ms`（减掉 expected base overhead）。G1Policy 用历史数据预测基开销——CSet 选择不能超过剩余时间
3. **`init_region_lengths(eden_count, survivor_count)`** — 记录本次 CSet 里各有多少 region
4. **`survivors->convert_to_eden()`** — 上一轮 GC 的 survivor regions 转换身份为 eden
5. **返回剩余时间** — 如果有余额且是 Mixed GC，`finalize_old_part()` 继续往里加 old region。Young-only 时直接忽略这一步

### 3.4 Young-only vs Mixed 的区别

| | Young-only | Mixed |
|---|---|---|
| CSet 内容 | Eden + Survivor（全量） | Eden + Survivor + 精选 Old（candidate list） |
| `finalize_old_part()` | 不执行 | 从 candidate list 选（由 `G1MixedGCCountTarget` 分批 + pause time 约束） |

Young-only 阶段 `in_mixed_phase()` 返回 false，所以根本不会走进 `finalize_old_part()` 的逻辑。

### 3.5 Region 怎么进入 CSet

每个 Eden/Survivor Region 在 GC 之前已经被增量地（incremental）加入 CSet：

```cpp
// g1CollectionSet.cpp:229-278
void G1CollectionSet::add_young_region_common(HeapRegion* hr) {
    hr->set_young_index_in_cset(cur_length);      // 在 CSet 中的序号
    _collection_set_regions[cur_length] = hr->hrm_index();
    _collection_set_cur_length++;                 // 数组长度 +1
    _g1h->register_young_region_with_cset(hr);    // 设 in_cset_fast_test 位图
}
```

`finalize_young_part()` 结束时只是**锁定这些累积值不再变化**，真正的"加入"操作在 GC 之前的增量构建阶段已经完成。

---

## 4. 阶段 2: Pre-Evacuation——GC 前的最后准备

### 4.1 `pre_evacuate_collection_set()`

```cpp
// g1CollectedHeap.cpp:4039-4058
void G1CollectedHeap::pre_evacuate_collection_set() {
    _hot_card_cache->set_use_cache(false);  // 关闭热卡缓存（GC 期间直接处理）
    g1_rem_set()->prepare_for_oops_into_collection_set_do();
    // 如果是 Initial Mark: 清理 ClassLoaderData 的 claimed 标记
}
```

### 4.2 RSet 扫描准备——`prepare_for_oops_into_collection_set_do()`

```cpp
// g1RemSet.cpp:511-516
void G1RemSet::prepare_for_oops_into_collection_set_do() {
    DirtyCardQueueSet& dcqs = G1BarrierSet::dirty_card_queue_set();
    dcqs.concatenate_logs();   // 把所有线程的 partial dirty card buffers
                               // 拼接到全局 completed buffer list
    _scan_state->reset();      // 重置 _scan_top 数组（ch11/06 §2.3）
}
```

`concatenate_logs()` 确保 GC 开始前所有线程的 dirty card 都对 GC worker 可见。`_scan_state->reset()` 为每个 Region 重新计算 `_scan_top[i]`——不在 CSet 中的 old/humongous Region 设 `top()`（需要扫描它的 card），CSet 内的 young Region 设 `bottom()`（不需要——CSet 内部的引用在 evacuation 时自然处理）。

---

## 5. 阶段 3: Evacuation——核心搬运

### 5.1 G1ParTask——并行工作入口

```cpp
// g1CollectedHeap.cpp:4063-4097
void G1CollectedHeap::evacuate_collection_set(G1ParScanThreadStateSet* psss) {
    G1RootProcessor root_processor(this, n_workers);
    G1ParTask g1_par_task(this, psss, _task_queues, &root_processor, n_workers);
    workers()->run_task(&g1_par_task);  // ★ 所有 GC Worker 并行执行
}
```

每个 Worker 执行 `G1ParTask::work(worker_id)`（g1CollectedHeap.cpp:3185-3202），其中三个阶段严格串行：

```cpp
void work(uint worker_id) {
    G1ParScanThreadState* pss = psss->state_for_worker(worker_id);

    // ===== 阶段 3a: Root 扫描 =====
    _root_processor->evacuate_roots(pss, worker_id);

    // ===== 阶段 3b: RSet 扫描 =====
    _g1h->g1_rem_set()->oops_into_collection_set_do(pss, worker_id);

    // ===== 阶段 3c: 工作窃取 + 排空 =====
    G1ParEvacuateFollowersClosure evac(_g1h, pss, _queues, &_terminator);
    evac.do_void();
}
```

### 5.2 阶段 3a: Root 扫描（`evacuate_roots`）

ch11/07 §5 讲了 13 类 Root 的分类和并行机制，这里聚焦它们在 Young GC 中的执行顺序：

```cpp
// g1RootProcessor.cpp:78-136
void G1RootProcessor::evacuate_roots(G1ParScanThreadState* pss, uint worker_i) {
    // 1. Java 根: Universe/JNIHandle/ObjectSynchronizer/Management/
    //    SystemDictionary/ClassLoaderDataGraph/JVMTI/AOT
    process_java_roots(closures, phase_times, worker_i);

    // 2. VM 根: CodeCache
    process_vm_roots(closures, phase_times, worker_i);

    // 3. StringTable 根
    process_string_table_roots(closures, phase_times, worker_i);

    // 4. CM ref_processor roots（如果有）
    // 5. Weak CLD 第二遍（如果 trace_metadata）
    // 6. SATB buffer filtering（如果 mark_or_rebuild_in_progress）

    _process_strong_tasks.all_tasks_completed(n_workers());
}
```

**并行机制**：13 个子任务（G1RP_PS_*）不是每个 Worker 各做一份——所有 Worker 通过 `SubTasksDone::try_claim_task()` 抢任务，抢到就执行，抢完就换下一个。

每个 Root 扫描子任务的本质是：遍历 Root 数据结构 → 找到指向 CSet Region 的引用 → 调用 `G1ParCopyClosure::do_oop()` → **触发 evacuation**。

`G1ParCopyClosure` 对每个引用做的事：
```
读引用 ref → 指向 CSet 内的对象 A
  → A 不在 CSet? → 跳过
  → A 在 CSet 中:
      → A 的 mark_word = forwarding pointer? → 已经被别人搬了 → 更新 ref → 结束
      → A 还没搬 → COPY A 到 Survivor/Old → 写 forwarding pointer → 把 A 放进工作队列 → 结束
```

### 5.3 阶段 3b: RSet 扫描（`oops_into_collection_set_do`）

```cpp
// g1RemSet.cpp:506-508
void G1RemSet::oops_into_collection_set_do(G1ParScanThreadState* pss, uint worker_i) {
    update_rem_set(pss, worker_i);    // 先更新 RSet——处理 dirty card
    scan_rem_set(pss, worker_i);      // 再扫描 RSet——找到跨 Region 引用
}
```

**`update_rem_set()`** — 处理 Refinement 线程还没来得及处理的 dirty card，把 card 上的引用记录更新到目标 Region 的 RSet 中。

**`scan_rem_set()`** — 遍历 CSet Region 的 RSet，找到"哪些不在 CSet 中的 Region 引用了 CSet Region"。每个 Worker 通过 `_iter_claims` 用原子操作抢 card block 来并行扫描（ch11/06 §2.3 详细讲过）。

RSet 扫描也是通过 `G1ParCopyClosure` 处理引用——和 Root 扫描一样的逻辑：读到引用 → 发现对象在 CSet → 搬。

### 5.4 阶段 3c: 干活+偷活（`G1ParEvacuateFollowersClosure`）

Root 扫描和 RSet 扫描会往每个 Worker 的工作队列（`RefToScanQueue`）里推任务——每个被搬走对象的引用字段需要被"追踪到底"。所有 Worker 通过工作窃取持续干活直到全局队列全空：

```cpp
// g1CollectedHeap.cpp:3157-3163
void G1ParEvacuateFollowersClosure::do_void() {
    pss->trim_queue();                  // 先排空自己的队列
    do {
        pss->steal_and_trim_queue(queues());  // 从其他 Worker 偷活
    } while (!offer_termination());          // 直到所有活儿都干完
}
```

**工作窃取**（taskqueue.inline.hpp:257-267）：

```cpp
bool GenericTaskQueueSet::steal(uint queue_num, int* seed, E& t) {
    for (uint i = 0; i < 2 * _n; i++) {
        if (steal_best_of_2(queue_num, seed, t))  // 随机选两个队列，偷更好的那个
            return true;
    }
    return false;
}
```

每个窃取到的引用同样走 `G1ParCopyClosure` → 产生新的引用 → 继续推队列 → 继续偷——BFS 扩散直到整棵引用树被遍历完。

### 5.5 `G1ParScanThreadState`——每个 Worker 手里的"工具箱"

每个 GC Worker 持有自己的 `G1ParScanThreadState` 实例（g1ParScanThreadState.hpp:45），包含：

| 字段 | 作用 |
|------|------|
| `_refs` | 该 Worker 的任务队列（push/pop/steal 的载体） |
| `_plab_allocator` | PLAB 空间分配器（在 Survivor/Old 中分配目标空间） |
| `_age_table` | 对象年龄表（累积统计，驱动晋升阈值） |
| `_closures` | 闭包集——对不同 Root 类型的引用分别用哪个闭包 |
| `_worker_id` | 当前 Worker 编号 |

---

## 6. 阶段 4: Post-Evacuation——引用处理 + 收尾

### 6.1 `post_evacuate_collection_set()`

```cpp
// g1CollectedHeap.cpp:4099-4166
void G1CollectedHeap::post_evacuate_collection_set(...) {
    // 1. RSet 扫描收尾
    g1_rem_set()->cleanup_after_oops_into_collection_set_do();

    // 2. 引用处理（Soft/Weak/Final/Phantom）
    process_discovered_references(per_thread_states);

    // 3. 弱引用清理（StringTable/ResolvedMethodTable）
    WeakProcessor::weak_oops_do(...);

    // 4. 字符串去重
    G1StringDedup::unlink_or_oops_do(...);

    // 5. 恢复热卡缓存
    _hot_card_cache->reset_hot_cache();

    // 6. Re-dirty logged cards
    redirty_logged_cards();
}
```

### 6.2 引用处理——四阶段

`ReferenceProcessor::process_discovered_references()`（referenceProcessor.cpp:201-261）按优先级分四轮：

```
Phase 1: Soft 引用重新判定（根据 timestamp 决定是否回收）
Phase 2: Soft/Weak/Final 引用处理（referent 死了 → 入队；活着 → keep-alive）
Phase 3: Final 引用的 keep-alive（确保 finalize() 过程的对象不提前回收）
Phase 4: Phantom 引用批量排队
```

---

## 7. 阶段 5: Free CSet——把空 Region 还给系统

### 7.1 `free_collection_set()`

```cpp
// g1CollectedHeap.cpp:2980
free_collection_set(&_collection_set, evacuation_info, surviving_young_words);
```

这个调用创建 `G1FreeCollectionSetTask`——一个并行的 WorkGang 任务：

**串行部分**（一个 Worker 执行，持 `OldSets_lock`）：
- 遍历 CSet 每个 Region
- 如果 `!r->evacuation_failed()` → `free_region()` → 归还 `_local_free_list` → Region 变 Free
- 如果 `r->evacuation_failed()` → `r->set_old()` → 加入 old set（搬不走就留在那里当 Old）

**并行部分**（所有 Worker 并行）：
- `r->rem_set()->clear_locked()` —— 清空 RSet（Region 要重用了，旧 RSet 不能留）
- 清空 hot card cache 计数

**最后**：`prepend_to_freelist(&_local_free_list)` → 在 `FreeList_lock` 保护下把局部 free list 合并到全局 `_hrm._free_list`。

### 7.2 什么情况会 evacuation_failed

如果 Survivor/Old Region 空间不足以接收搬来的对象——promotion 失败。失败的 Region 不能被释放（里面还有活对象），只能标记为 Old 留在堆里。反复出现 evac failure 最终会触发 Full GC 降级。

---

## 8. 阶段 6: 启动下一个 CSet

### 8.1 `start_new_collection_set()`

```cpp
// g1CollectedHeap.cpp:2784-2791
void G1CollectedHeap::start_new_collection_set() {
    collection_set()->start_incremental_building();   // _inc_build_state = Active
    clear_cset_fast_test();                           // 清空 in_cset_fast_test 位图
    g1_policy()->transfer_survivors_to_cset(survivor()); // 上一轮的 survivor → 下一轮 CSet
}
```

**关键**：上一轮 Young GC 存活下来的对象在 Survivor Region 中。这些 Survivor Region **在 GC 结束后就被增量加入下一个 CSet**——因为下一次 Young GC 时它们就是"本次 CSet 中的 survivor 部分"。

---

## 9. 一条完整的时间线

```
T4: SafepointSynchronize::begin() → 所有 mutator 线程停下
T5: finalize_collection_set() → CSet = {Eden_1, Eden_2, ..., Survivor_1}
T6: pre_evacuate() → concatenate dirty card logs / reset scan_state
T7: evacuate_collection_set():
    ┌─ Worker 0: evacuate_roots(0) → Universe + CodeCache → 发现引用 → 搬第一批对象
    │            oops_into_cset_do(0) → 扫描 RSet → 搬更多对象
    │            steal_and_trim() → 从 Worker 1 偷活儿 → 继续搬 → 空
    ├─ Worker 1: evacuate_roots(1) → JNIHandle + SystemDictionary → 搬
    │            ...
    └─ (所有 Worker 并行推进，直到队列全空)
T8: post_evacuate() → 处理 Soft/Weak/Final/Phantom 引用 → 清 StringTable
T9: free_collection_set() → Eden_1/Eden_2/... 归还 FreeList
T10: start_new_collection_set() → Survivor → 新 CSet
T11: SafepointSynchronize::end() → mutator 恢复运行
```

GC 日志显示的时间是 T5 到 T11 的总和（不含 TTSP）。

---

## 10. 总结——读 GC 日志时的对应关系

| GC 日志行 | 对应本文哪个阶段 |
|-----------|---------------|
| `Pause Young (Normal) (G1 Evacuation Pause)` | §1.2 入口 |
| `128M->64M(1024M)` | §7 Free CSet 后的堆使用量变化 |
| `8.234ms` | 不含 TTSP 的纯 GC 工作时间（T5→T11） |
| `User=0.12s Sys=0.01s` | CPU 时间（user + system） |

下一篇：**ch11/09 Young GC 内部机制**——PLAB / Preserved Marks / Dirty Card 在 GC 期间的处理 / Humongous Eager Reclaim。
