# G1 Young GC 详解（一）——触发 / GCLocker / CSet / 准备

> **系列定位**：三篇串讲一次 Normal Young GC（GC 日志中的 `Pause Young (Normal)`）。第一篇讲解 GC 启动前和启动时的准备工作：谁触发的、GCLocker 怎么拦、InitialMark 怎么判、CSet 怎么选、搬运之前要准备什么。
>
> **前置概念**：Eden / Survivor / Old 角色、STW 和 safepoint、CSet 概念（ch11/07）。
>
> **第二篇**：Root 扫描 → RSet 扫描 → 工作窃取 → Post-Evacuation（08-02）。
> **第三篇**：Free CSet → 启动下轮 → 时间线 → 附录（08-03）。

---

## 1. 谁触发的 Young GC

### 1.1 从分配说起

mutator（应用线程）不停地 `new` 对象。每个 Java 线程在 Eden Region 里独占一小块私有的 **TLAB**（Thread-Local Allocation Buffer）。在 TLAB 里分配对象只需一次 **pointer bump**：

```
TLAB 内部：
  _start ─────────────────── _top ────── _end
  已分配的对象                  ↑          上限
                           下一个对象从这里开始

分配算法（threadLocalAllocBuffer.inline.hpp:34-54）:
  if (_top + object_size <= _end)
      return _top += object_size;   // 约 10 条 CPU 指令，无锁
```

### 1.2 TLAB 用完之后

TLAB 不够放下一个对象时，线程不是直接触发 GC——先判断 "值不值得换一个新 TLAB"。

G1 用 `_refill_waste_limit` 做容差（threadLocalAllocBuffer.hpp:57）。这个值初始等于 `TLAB 大小 / TLABRefillWasteFraction`（默认 64）。如果 TLAB 剩余空间大于这个阈值，**不退休 TLAB**——直接在 Eden Region 上用 CAS 做一次分配（绕过 TLAB 的本地 bump，目标仍是 Eden）。只有剩余空间小于等于阈值时才退休当前 TLAB、申请新的。

"退休"TLAB 不是 "归还碎片"——TLAB 本就属于当前的 Eden Region（`MutatorAllocRegion`），退役只做三件事：

- 在 `top` 到 `hard_end` 区间填充一个 **dummy filler object**（GC 遍历 Eden 时不会撞空洞）
- 把已用字节数记入线程的总分配量
- 把 `start/top/end/allocation_end` 全部清零

代码路径：`clear_before_allocation()`（threadLocalAllocBuffer.cpp:43-46）。

### 1.3 Region 也满了——三级挽救

如果当前 Eden Region（MutatorAllocRegion）也被切光了——不止是 TLAB 不够，而是整个 Region 都放不下一个新 TLAB——G1 不会立刻触发 GC，而是尝试三级挽救：

| 级别 | 做什么 | 源码位置 | 条件 |
|------|--------|---------|------|
| **第一级（无锁）** | `attempt_retained_allocation()`——尝试从上一轮保留的 retained region 分配 | g1AllocRegion.inline.hpp:133-144 | `_retained_alloc_region != NULL` |
| **第二级（持 Heap_lock）** | `attempt_allocation_locked()`——持锁重试当前 Region → 退休它 → 从 free list 拿新 Eden Region | g1AllocRegion.inline.hpp:98-118 | `young_count < _young_list_target_length` |
| **第三级（GCLocker 紧急）** | `attempt_allocation_force()`——GCLocker 活跃时绕过 target 上限，用 max 做上限 | g1CollectedHeap.cpp:441-448 | `GCLocker::is_active_and_needs_gc() && can_expand_young_list()` |

第二级里的 `should_allocate_mutator_region()`（g1Policy.cpp:861-865）检查当前 young region 数是否小于 `_young_list_target_length`——也就是 G1Policy 维护的 "堆里该有多少 Young Region" 的目标值（附录 A 详解了这个值怎么算）。如果已经到达目标上限，返回 false，无法再分配新的 Eden Region。

### 1.4 触发 GC——attempt_allocation_slow 的完整循环

"分配失败"之后，最终的控制权交到了 `attempt_allocation_slow()`。以下是完整源码（g1CollectedHeap.cpp:410-516），每个关键段落标注了含义：

```cpp
HeapWord* G1CollectedHeap::attempt_allocation_slow(size_t word_size) {
  ResourceMark rm;

  assert_heap_not_locked_and_not_at_safepoint();
  assert(!is_humongous(word_size), "...");
  // 注释: 我们只在第一级分配 attempt_allocation() 失败后才来这里
  // 循环直到 a) 成功分配 或 b) 成功安排了一次 GC 但仍分配失败（唯一返回 NULL 的情况）
  HeapWord* result = NULL;
  for (uint try_count = 1, gclocker_retry_count = 0; /* we'll return */; try_count += 1) {
    bool should_try_gc;
    uint gc_count_before;

    // ── 第一步: 持锁阶段 ──
    {
      MutexLockerEx x(Heap_lock);
      result = _allocator->attempt_allocation_locked(word_size);
      if (result != NULL) {
        return result;    // 持锁后重试成功 → 不触发 GC
      }

      // 如果 GCLocker 活跃且需要 GC, 尝试扩展 young gen 而非等待
      if (GCLocker::is_active_and_needs_gc() && g1_policy()->can_expand_young_list()) {
        result = _allocator->attempt_allocation_force(word_size);
        if (result != NULL) {
          return result;
        }
      }
      // 只有当 GCLocker 不需要 GC 时才自己发起 GC
      should_try_gc = !GCLocker::needs_gc();
      gc_count_before = total_collections();   // 在持锁状态下读 GC 计数
    } // 释放 Heap_lock

    // ── 第二步: GC 阶段 ──
    if (should_try_gc) {
      bool succeeded;
      result = do_collection_pause(word_size, gc_count_before, &succeeded,
                                   GCCause::_g1_inc_collection_pause);
      if (result != NULL) {
        return result;    // GC 成功回收空间并分配了对象
      }

      if (succeeded) {
        // 成功安排了一次 GC, 但分配失败 → 没有重试的意义了 → 返回 NULL
        return NULL;
      }
      // GC 没能执行 (被别的线程抢先了) → 继续循环
    } else {
      // ── GCLocker block → stall_until_clear ──
      // GCLocker 活跃或其发起的 GC 还没完成 → 等它做完再重试
      if (gclocker_retry_count > GCLockerRetryAllocationCount) {
        return NULL;      // 等太多次了 → 放弃
      }
      GCLocker::stall_until_clear();
      gclocker_retry_count += 1;
    }

    // ── 第三步: 无锁重试 ──
    // 无论走了 GC 还是 GCLocker stall, 出锁后别的线程可能已经做了 GC
    // 先无锁试试——如果别的线程的 GC 释放了空间, 我们直接受益
    size_t dummy = 0;
    result = _allocator->attempt_allocation(word_size, word_size, &dummy);
    if (result != NULL) {
      return result;
    }

    // 如果循环太多轮了 → 警告
    if ((QueuedAllocationWarningCount > 0) &&
        (try_count % QueuedAllocationWarningCount == 0)) {
      log_warning(gc, alloc)("Retried allocation %u times...", try_count);
    }
  }

  ShouldNotReachHere();
  return NULL;
}
```

**for 循环的出口：**

| 路径 | 条件 | 返回值 |
|------|------|--------|
| 持锁分配成功 | `attempt_allocation_locked()` 或 `attempt_allocation_force()` 返回非 NULL | 对象地址 |
| GC 成功 + 分配成功 | `do_collection_pause()` → `succeeded && result != NULL` | 对象地址 |
| GC 成功 + 分配失败 | `do_collection_pause()` → `succeeded && result == NULL` | NULL |
| GCLocker 等太久 | `gclocker_retry_count > GCLockerRetryAllocationCount` | NULL |
| 别线程的 GC 帮忙 | 循环底部的 `attempt_allocation()` 成功 | 对象地址 |
| GC 被抢先 | `do_collection_pause()` → `!succeeded` | 继续循环 |

**N 个线程可以同时走到 slow path**。先到的触发 GC, 后到的在 `Heap_lock` 上排队。GC 完成后 Eden 有空闲 Region, 后到的线程在持锁重试或循环底部的无锁重试中直接分配成功——"GC 不是我触发的, 但我受益了"。
## 2. 阶段 1: GCLocker——为什么要拦着 GC

### 2.1 问题：JNI Critical Section 和 GC 互斥

JNI 提供了 `GetPrimitiveArrayCritical()` 函数——它返回一个 **指向 Java 数组堆内存的原始指针**，让 native 代码直接操作数组内容，不经过 JVM 的任何包装层。

**这条指针指向堆里的对象。GC 是标记-复制——它会搬走活对象。** 如果 `GetPrimitiveArrayCritical` 的持有者还在通过这条原始指针读写数组时，GC 把数组搬到了另一个地址——指针立刻变成野指针，进程 crash。

### 2.2 GCLocker 的解决方案——两个关键状态

GCLocker（gcLocker.hpp:38-154）维护两个 volatile 变量：

```cpp
static volatile jint  _jni_lock_count;  // 当前活跃的 JNI critical section 数
static volatile bool  _needs_gc;        // "堆满了，需要 GC——但有 critical section 拦着"
static volatile bool  _doing_gc;        // unlock_critical 正在替大家做 GC
```

`lock_critical()`——进入 critical section（gcLocker.inline.hpp:31-42）：
```cpp
void GCLocker::lock_critical(JavaThread* thread) {
    if (!thread->in_critical()) {
        if (needs_gc()) {
            jni_lock(thread);   // slow path：_needs_gc 为 true → 在 JNICritical_lock 上等
            return;
        }
        increment_debug_jni_lock_count();
    }
    thread->enter_critical();   // fast path：直接进入
}
```

`unlock_critical()`——退出 critical section（gcLocker.inline.hpp:44-55）：
```cpp
void GCLocker::unlock_critical(JavaThread* thread) {
    if (thread->in_last_critical()) {
        if (needs_gc()) {
            jni_unlock(thread);  // slow path：最后一个退出的线程负责执行 GC
            return;
        }
        decrement_debug_jni_lock_count();
    }
    thread->exit_critical();
}
```

### 2.3 GC 侧的检查——abort, retry, expand

在 safepoint 中，GC 调用 `GCLocker::check_active_before_gc()`（g1CollectedHeap.cpp:2798-2800）：

```cpp
if (GCLocker::check_active_before_gc()) {
    return false;  // 有 critical section → 放弃本次 GC
}
```

返回 false 后——**本次 GC 整个 abort**。VMThread 解除 safepoint，所有 mutator 恢复运行。刚才分配失败的那位线程会重新触发 GC。一直循环，直到所有 JNI critical section 被释放（`unlock_critical()` → `jni_unlock()` 帮大家做了 GC → `_needs_gc = false` → 下次 GC 正常进入）。

**为什么不在 safepoint 里等**——因为 `ReleasePrimitiveArrayCritical`（触发 `unlock_critical`）是 mutator 线程的 native 代码部分——必须让 mutator 恢复运行才能执行。VMThread 干等 = 死锁。所以策略是 abort + retry。

### 2.4 GCLocker 紧急扩展

在触发 GC 之前（§1.4 的 slow path 里），G1 还有一条 "GCLocker 紧急扩展" 路径：

```cpp
// g1CollectedHeap.cpp:441-448
if (GCLocker::is_active_and_needs_gc() && g1_policy()->can_expand_young_list()) {
    result = _allocator->attempt_allocation_force(word_size);
    if (result != NULL) return result;  // 扩展成功 → 不用触发 GC
}
```

`can_expand_young_list()`（g1Policy.cpp:867-871）用 `_young_list_max_length`（而非 `_young_list_target_length`）做上限——允许临时突破 target 来避免 GCLocker abort 的 safepoint 往返。`GCLockerEdenExpansionPercent` 默认 5%，即 `_young_list_max_length = target * 1.05`，给的就是这个 buffer。

如果紧急扩展也不够，`GCLocker::stall_until_clear()` 在 `JNICritical_lock` 上等待所有 critical section 释放。

---

## 3. 阶段 2: 这次 Young GC 要不要兼做 InitialMark

每次 Young GC 之前，G1Policy 判断一个关键问题——"老年代是不是快满了，需要启动并发标记了？"

```cpp
// g1CollectedHeap.cpp:2826
if (!_cm_thread->should_terminate()) {
    g1_policy()->decide_on_conc_mark_initiation();
}
```

`decide_on_conc_mark_initiation()`（g1Policy.cpp:936-985）的决策逻辑：

```cpp
if (collector_state()->initiate_conc_mark_if_possible()    // 上次 GC 结束时设的 flag
    && collector_state()->in_young_only_phase()              // 还在 young-only 阶段
    && !about_to_start_mixed_phase())                        // 还没开始 Mixed
{
    initiate_conc_mark();  // _in_initial_mark_gc = true → 本次变成 InitialMarkGC
}
```

### 3.1 IHOP——谁设了这个 flag

`initiate_conc_mark_if_possible` 是上一次 GC 结束时 `maybe_start_marking()` 设的。`maybe_start_marking()` 最终调 `need_to_start_conc_mark()`（g1Policy.cpp:531-551）：

```cpp
bool need_to_start_conc_mark() {
    size_t threshold = _ihop_control->get_conc_mark_start_threshold();
    size_t cur_used = _g1h->non_young_capacity_bytes();  // old + humongous 占用量

    return cur_used > threshold;
}
```

**IHOP 阈值——自适应模式下的含义**：

```
threshold = internal_threshold - (marking_time × promotion_rate + max_young_size)

其中：
  internal_threshold = heap_capacity * (1 - G1ReservePercent) * InitiatingHeapOccupancyPercent
  marking_time       = 历史并发标记耗时（EWMA 预测）
  promotion_rate     = 历史晋升速率（MB/s）
  max_young_size     = max young gen size
```

本质含义：**"如果现在启动并发标记，标记完成时老年代还能装下标记期间晋升来的对象 + 一个完整的 young gen 吗？"** 如果 IHOP 说 "装不下了"——那就是现在，立刻，下一次 Young GC 捎带上 InitialMark。

### 3.2 Normal Young GC 的情况

对于 Normal Young GC：
- `initiate_conc_mark_if_possible()` 为 **false**（上次 GC 没设这个 flag）
- 走纯 young-only 回收路径
- `should_start_conc_mark` 保持 false

如果上一次 GC 设了这个 flag，本次就会变成 **InitialMarkGC**——GC 日志显示 `Pause Young (Concurrent Start)`。除了 Young GC 的全部回收逻辑外，还多把 survivor Region 标记为并发标记的 root（ch11/13 展开）。

---

## 4. 阶段 3: CSet 选择——把哪些 Region 放进去

### 4.1 什么是 CSet

CSet（Collection Set）= 本次 GC 要回收的 Region 集合。ch11/06 讲了 `in_cset_fast_test`（O(1) 判断某个地址在不在 CSet）——那是使用者。本章讲的是构建者——这些 Region 是怎么被选进 CSet 的。

Normal Young GC 的 CSet = **所有 Eden Region + 所有 Survivor Region**。全量加入，不需要选择——凡是 Eden 或 Survivor 的 Region，一律收。

### 4.2 Region 什么时候进 CSet

**关键认识：CSet 是增量构建的。** 不是在 GC 开始那一刻一次性堆进去——而是 mutator 运行期间一小口一小口往里加：

**已填满退休的 Eden Region**——mutator 把一个 Eden Region 分三亚后退了它。退休操作 `retire_mutator_alloc_region()`（g1CollectedHeap.cpp:4869-4881）在最后一行调用：

```cpp
collection_set()->add_eden_region(alloc_region);   // line 4874
```

这个 Region 就被加入增量 CSet 数组。**这个调用发生在 mutator 时间里（safepoint 之间），不是 GC 时间内。**

**当前活跃的 Eden Region**（mutator 正用的、还没填满的那个）——GC 开始后 `release_mutator_alloc_region()`（g1CollectedHeap.cpp:2926）把它也退休了，走同一条路径（`retire_mutator_alloc_region()` → `add_eden_region()`）进入 CSet。所以**所有 Eden Region 最终都在 CSet 里**——只是退休时机不同。

**上一轮 Survivor Region**——上轮 GC 结束时 `transfer_survivors_to_cset()`（g1Policy.cpp:1148-1176）把它们全部加入下一轮的增量 CSet。

```cpp
void G1Policy::transfer_survivors_to_cset(const G1SurvivorRegions* survivors) {
    for (each survivor region) {
        _collection_set->add_survivor_regions(curr);  // 加入下一轮 CSet
    }
}
```

`add_eden_region()` 和 `add_survivor_regions()` 都委托给同一个底层方法 `add_young_region_common()`（g1CollectionSet.cpp:229-278）：

```cpp
void G1CollectionSet::add_young_region_common(HeapRegion* hr) {
    assert(_inc_build_state == Active, "Precondition");

    hr->set_young_index_in_cset((int)_collection_set_cur_length);  // CSet 中的序号
    _collection_set_regions[_collection_set_cur_length] = hr->hrm_index(); // 存 Region 索引
    _collection_set_cur_length++;               // 长度 +1

    _g1h->register_young_region_with_cset(hr);  // 设置 in_cset_fast_test 位图

    // 为 G1Policy 的暂停预测缓存 RSet 长度和预测时间
    _inc_recorded_rs_lengths += rs_length;
    _inc_predicted_elapsed_time_ms += predict_region_elapsed_time_ms(hr);
    _inc_bytes_used_before += hr->used();
}
```

**CSet 的存储结构**——`_collection_set_regions` 是一个普通的 `uint*` C 数组（g1CollectionSet.hpp:55），存的不是 `HeapRegion*` 指针，而是 `hrm_index()`（Region 在 `HeapRegionManager` 数组中的索引）。遍历时通过 `_g1h->region_at(index)` 反查 `HeapRegion*`。**不是链表，是简单的位置写入数组。**

### 4.3 GC 开始时的锁定——finalize_collection_set

GC 进入 safepoint 后，`finalize_collection_set()`（g1CollectedHeap.cpp:2944）完成最后的锁定动作：

```cpp
// g1Policy.cpp:1143-1146
void G1Policy::finalize_collection_set(target_pause_time_ms, &_survivor) {
    double time_remaining = _collection_set->finalize_young_part(target_pause_time_ms, survivor);
    _collection_set->finalize_old_part(time_remaining);
}
```

`finalize_young_part()`（g1CollectionSet.cpp:356-398）做五件事：

1. **`finalize_incremental_building()`**——把增量构建状态从 `Active` 切 `Inactive`："从现在开始不接受新的 Region 进入 CSet"
2. **`init_region_lengths(eden_count, survivor_count)`**——记录本轮 CSet 里的 Eden 和 Survivor 各有多少
3. **`survivors->convert_to_eden()`**（g1SurvivorRegions.cpp:42-50）——遍历上一轮留下的 Survivor Region，调用 `set_eden_pre_gc()` 把 Tag 从 `SurvTag(3)` 改为 `EdenTag(2)`——这些 Survivor 在本轮 GC 中作为 Eden 被回收
4. **算 time budget**——`target_pause_time_ms - base_time_ms`，CSet 的预测工作量不能超过剩余时间
5. **返回剩余时间**——Young-only GC 时 `finalize_old_part()` 不做任何事（`in_mixed_phase()` 返回 false）

### 4.4 为什么 CSet 大小的控制不发生在 finalize 阶段

`finalize_young_part()` 只是 "锁定量，不锁大小"。CSet 的大小是 GC 之间的 mutator 分配活动决定的——分配了多少 Eden Region，就有多少 Eden 进入 CSet。G1Policy 通过 `_young_list_target_length` 持续控制 "堆里该有多少 Young Region"，从而控制下一轮的 CSet 大小。附录 A 详解了这个值的计算。

---

## 5. 阶段 4: Pre-Evacuation——搬运前的最后准备

### 5.1 做什么

```cpp
// g1CollectedHeap.cpp:2972
pre_evacuate_collection_set();
```

内部（g1CollectedHeap.cpp:4039-4058）：
- 关闭热卡缓存——GC 期间 hot card cache 不能有 stale 数据
- 调用 `g1_rem_set()->prepare_for_oops_into_collection_set_do()`

### 5.2 merge dirty card logs

`prepare_for_oops_into_collection_set_do()`（g1RemSet.cpp:511-516）第一件事：

```cpp
void G1RemSet::prepare_for_oops_into_collection_set_do() {
    DirtyCardQueueSet& dcqs = G1BarrierSet::dirty_card_queue_set();
    dcqs.concatenate_logs();    // ★ 关键——合并所有线程的 partial dirty card buffer
    _scan_state->reset();
}
```

**`concatenate_logs()` 为什么重要**：mutator 线程在 GC 触发前最后一刻还在分配对象和写引用。这些写入会产生 dirty card，但写在 thread-local buffer 里——如果 buffer 还没满，就不会提交到全局队列。GC 必须主动把所有这些 "半满的 buffer" 拼到全局 completed buffer list 中。

如果不做这一步——最后一批 dirty card 对 GC Worker 来说**不可见**——这些 card 上的跨 Region 引用会被漏掉——**活对象被误判为死对象**——严重错误。

### 5.3 重置 scan_state

`_scan_state->reset()` 为堆中**每一个 Region** 重算 `_scan_top[i]`（ch11/06 §2.3 详细讲了这个数组）。逻辑（g1RemSet.cpp:127-141）：

```cpp
for each Region r:
    if (!r->in_collection_set() && r->is_old_or_humongous())
        _scan_top[hrm_index] = r->top();       // 需要扫描这个 Region 的 card
    else
        _scan_top[hrm_index] = r->bottom();    // 不需要——CSet 内的在 evacuation 时自然处理
```

**为什么需要区分**——RSet 扫描时（第二篇 08-02 展开），Worker 需要知道 "哪些 Region 的哪些 card 可能引用了 CSet"。`_scan_top[i]` 给出了精确的上限：
- 如果 Region i 不在 CSet 且是 old/humongous——card 0 到 `_scan_top[i]` 需要被检查
- 如果 Region i 在 CSet 中——它的对象会被整体疏散，跨 Region 引用在 evacuation 时自然覆盖，不需要通过 RSet 额外追踪

### 5.4 如果是 InitialMark GC——额外步骤

如果本次是 InitialMark GC（§3 判断为 true），还有一个额外的操作——清理所有 `ClassLoaderData` 的 claimed 标记，为标记阶段的 class unloading 做准备。Normal Young GC 跳过这步。

---

## 附录 A: `_young_list_target_length` 怎么算

G1Policy 通过 `_young_list_target_length` 控制堆里该有多少 Young Region（Eden+Survivor）。这不是一个静态值——它在初始化和每次 GC 后都被重新计算。**初始值和运行时值的计算方式截然不同。**

### A.1 初始值——没有历史数据时的第一次

VM 启动时 `G1Policy::init()`（g1Policy.cpp:79-96）调用 `update_young_list_max_and_target_length()`。此时 **所有 analytics 序列都是空的**——没有任何 GC 历史数据。

没有数据怎么办？G1Analytics 用**硬编码默认值**（g1Analytics.cpp:41-66）：

| 预测项 | 默认值 | 用于 |
|--------|--------|------|
| 拷贝成本 | 0.000009 ~ 0.00006 ms/byte | 预测搬活对象的耗时 |
| 卡片扫描成本 | 0.0015 ~ 0.01 ms/card | 预测 RSet 扫描耗时 |
| 常数开销 | 5.0 ms | 每次 GC 的固定底线耗时 |
| 存活率 | 0.4 / age | 每个年龄层约 40% 对象存活 |
| RSet 长度 | 0 | 无历史——假设没有 RSet 要扫描 |
| 分配速率 | 0 | 空序列——前三次 GC 不用分配速率做约束 |

这些默认值代入 `G1YoungLengthPredictor::will_fit(young_length)`（g1Policy.cpp:121-158）。这个预测器对每个候选值检查三项：

```
检查 1: 空间够不够？
  young_length < free_regions - reserve_regions (默认 10%)

检查 2: 暂停会超吗？
  copy_time_ms = accum_surv_rate × RegionSize × cost_per_byte_ms
  other_time_ms = young_length × cost_per_region_ms
  pause_time_ms = base_time_ms + copy_time_ms + other_time_ms
  if (pause_time_ms > MaxGCPauseMillis)  → 太大，不行

检查 3: 拷贝安全吗？
  safety_factor = (100 / G1ConfidencePercent) × (100 + TargetPLABWastePct) / 100
                = (100 / 50) × (100 + 10) / 100 = 2.2
  expected_bytes_to_copy = safety_factor × bytes_to_copy
  if (expected_bytes_to_copy > remaining_free_space)  → 危险，不行
```

`calculate_young_list_target_length()`（g1Policy.cpp:278-378）对 `[min, max]` 区间做**二分搜索**——找能通过三项检查的最大值。

上下界来自 `G1YoungGenSizer`（g1YoungGenSizer.cpp:30-79）：
- 下界：`max(1, heap_regions × G1NewSizePercent/100)` —— 默认 5%
- 上界：`max(1, heap_regions × G1MaxNewSizePercent/100)` —— 默认 60%
- 可以被 `-XX:NewSize` / `-XX:MaxNewSize` 显式覆盖

**第一次 GC 不保证满足暂停目标**——初始值用默认数据估算，真实行为（分配速率、存活率、拷贝成本）可能与默认值差甚远。这是有意为之——用第一轮的真实数据喂给 analytics，后续的预测才会越来越准。

### A.2 运行时——数据驱动的动态调整

每次 GC 结束后 `record_collection_pause_end()`（g1Policy.cpp:556-737）把本轮的真实数据喂进 analytics 的滑动窗口序列：

```
report_alloc_rate_ms()    —— eden_region_count / app_time_ms
report_rs_lengths()       —— _max_rs_lengths
report_cost_per_byte_ms() —— copy_time / bytes_copied
report_pending_cards()    —— _pending_cards  (仅 young GC 更新)
report_rs_length_diff()   —— RS 变化差异
```

序列越长，EWMA（指数加权移动平均）预测越准。第三条 GC 开始用分配速率做下界约束（`num_alloc_rate_ms() > 3`）。

**mutator 阶段的修正**——`G1YoungRemSetSamplingThread` 每 300ms（G1ConcRefinementServiceIntervalMillis）唤醒一次，采样所有 young Region 的 RSet 实际长度。如果当前 RS 长度超过了 GC 结束时的预测值：

```cpp
// g1Policy.cpp:392-402
void G1Policy::revise_young_list_target_length_if_necessary(size_t rs_lengths) {
    if (rs_lengths > _rs_lengths_prediction) {
        size_t new_prediction = rs_lengths * 1100 / 1000;   // ×1.1 容错
        update_rs_lengths_prediction(new_prediction);
        update_young_list_max_and_target_length(new_prediction);  // 重新算 target
    }
}
```

**这可能导致一次提前 GC**——如果重新算的 target 比当前 young count 小，下一次分配就会更快触发 GC。但这是值得的——RS 比预期大意味着下次 GC 扫描会超时，提前 GC 缩小 young gen 比超时好。

---

## 附录 B: TLAB 和 Region 分配——完整路径

### B.1 TLAB 的 pointer bump

`_top + size ≤ _end` → `_top += size`。约 10 条 CPU 指令，无锁，每个线程独立。

### B.2 TLAB 空间不够时的容差

`_refill_waste_limit = TLAB大小 / 64`。每次走 CAS 路径（跳过 TLAB 直接在 Region 上分配）时 waste limit 再递增 4（`TLABWasteIncrement`），逐步宽松——长时间不用退休同一块 TLAB，减少 overhead。

### B.3 TLAB 退休的全部步骤

`clear_before_allocation()`（threadLocalAllocBuffer.cpp:43-46）：
1. `make_parsable(true)` —— 在 `top`→`hard_end` 填 dummy filler object（`CollectedHeap::fill_with_object`）
2. `incr_allocated_bytes(used_bytes())` —— 记入线程的总分配量
3. 清零 `start/top/end/allocation_end` 指针

### B.4 Region 的三级挽救——详情

| 级别 | 方法 | 持锁？ | 失败后果 |
|------|------|--------|---------|
| 第一级 | `G1Allocator::attempt_allocation()` → `attempt_retained_allocation()` | 无锁 | 返回 NULL，进入第二级 |
| 第二级 | `attempt_allocation_locked()`（g1AllocRegion.inline.hpp:98-118） | Heap_lock | retry → retire current → `new_mutator_alloc_region()` → NULL 进入第三级或 GC |
| 第三级 | `attempt_allocation_force()` | Heap_lock（同第二级的上下文） | 绕过 target 用 max 上限；失败 → GC |

### B.5 Region 退休 vs TLAB 退休

| 维度 | TLAB 退休 | Region 退休 |
|------|----------|-----------|
| 触发 | `_refill_waste_limit` 判断 | Region 无法分配（`par_allocate` 返回 NULL） |
| 退休动作 | fill dummy filler + 清零指针 | `fill_up_remaining_space()` 填 dummy + `retire_mutator_alloc_region()` 入 CSet |
| 保留机制 | 无——TLAB 退休就不存在了 | `MutatorAllocRegion::should_retain()`——如果剩余空间 ≥ MinTLABSize，保留为 retained region |
| waste 阈值 | `_refill_waste_limit`（TLAB 大小 / 64，动态调整） | 无——Region 退休时不看 waste，看"还能不能装一个完整 TLAB" |

---

## 附录 C: 本文涉及的字段速查

| 字段 | 所在类 | 类型 | 源码位置 | 用途 |
|------|--------|------|---------|------|
|  |  |  | threadLocalAllocBuffer.hpp:57 | TLAB 剩余超过此值则不做退休——直接在 Region 上 CAS 分配 |
|  |  |  | threadLocalAllocBuffer.hpp:67 | TLAB slow-path refill 的浪费累计计数 |
|  |  |  | g1AllocRegion.hpp:213 | 退休时保留的 Region——下次优先从它分配，提高命中率 |
|  |  |  | g1AllocRegion.hpp:208 | 当前 mutator 阶段产生的总浪费字节数 |
|  |  |  | g1Policy.hpp:82 | Young Region (Eden+Survivor) 的目标总数——由暂停预测模型计算 |
|  |  |  | g1Policy.hpp:87 | GCLocker 活跃时可扩展的 Eden 最大 Region 数 |
|  |  |  | gcLocker.hpp:45 | 当前处在 JNI critical section 中的线程计数 |
|  |  |  | gcLocker.hpp:46 | 堆空间不足需要 GC，但有 critical section 拦着的标志 |
|  |  |  | gcLocker.hpp:48 | unlock_critical 正在为所有线程执行 GC 的标志 |
|  |  |  | g1CollectionSet.hpp:55 | CSet 的实际存储——不是链表，是普通 C 数组，存 region 索引（hrm_index） |
|  |  |  | g1CollectionSet.hpp:56 | 当前 CSet 的有效条目数——volatile，支持并发读 |
|  |  |  | g1CollectionSet.hpp:76 | 枚举：Active（增量构建中）或 Inactive（已锁定） |
|  |  |  | g1CollectionSet.hpp:88 | 增量构建期间累加的 RSet 总长度——用于暂停预测 |
|  |  |  | g1CollectionSet.hpp:101 | 增量构建期间累加的预测耗时（毫秒） |


---

## 附录 C: 本文涉及的字段速查

| 字段 | 所在类 | 类型 | 源码位置 | 用途 |
|------|--------|------|---------|------|
| `_refill_waste_limit` | `ThreadLocalAllocBuffer` | `size_t` | threadLocalAllocBuffer.hpp:57 | TLAB 剩余超过此值不退休——直接在 Region 上 CAS 分配 |
| `_slow_refill_waste` | `ThreadLocalAllocBuffer` | `unsigned` | threadLocalAllocBuffer.hpp:67 | TLAB slow-path refill 的浪费累计计数 |
| `_retained_alloc_region` | `MutatorAllocRegion` | `HeapRegion* volatile` | g1AllocRegion.hpp:213 | 退休时保留的 Region——下次优先从它分配 |
| `_wasted_bytes` | `MutatorAllocRegion` | `size_t` | g1AllocRegion.hpp:208 | 当前 mutator 阶段产生的总浪费字节数 |
| `_young_list_target_length` | `G1Policy` | `uint` | g1Policy.hpp:82 | Young Region (Eden+Survivor) 的目标总数 |
| `_young_list_max_length` | `G1Policy` | `uint` | g1Policy.hpp:87 | GCLocker 活跃时 Eden 的最大 Region 数 |
| `_jni_lock_count` | `GCLocker` | `static volatile jint` | gcLocker.hpp:45 | 当前在 JNI critical section 中的线程计数 |
| `_needs_gc` | `GCLocker` | `static volatile bool` | gcLocker.hpp:46 | 堆需要 GC 但被 critical section 拦住的标志 |
| `_doing_gc` | `GCLocker` | `static volatile bool` | gcLocker.hpp:48 | unlock_critical 正在替大家执行 GC 的标志 |
| `_collection_set_regions` | `G1CollectionSet` | `uint*` | g1CollectionSet.hpp:55 | CSet 实际存储——C 数组，存 region 索引 |
| `_collection_set_cur_length` | `G1CollectionSet` | `volatile size_t` | g1CollectionSet.hpp:56 | 当前 CSet 有效条目数，volatile 支持并发读 |
| `_inc_build_state` | `G1CollectionSet` | `CSetBuildType` | g1CollectionSet.hpp:76 | 枚举 Active/Inactive——控制增量构建开关 |
| `_inc_recorded_rs_lengths` | `G1CollectionSet` | `size_t` | g1CollectionSet.hpp:88 | 增量构建期间累加的 RSet 总长度 |
| `_inc_predicted_elapsed_time_ms` | `G1CollectionSet` | `double` | g1CollectionSet.hpp:101 | 增量构建期间累加的预测耗时（毫秒） |
