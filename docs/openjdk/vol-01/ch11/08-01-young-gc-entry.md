# G1 Young GC 详解（一）——从分配触发到 Pre-Evacuation

> **系列定位**：三篇串讲一次 Normal Young GC。第一篇覆盖 GC 前半段：谁触发的、GCLocker 怎么拦、InitialMark 怎么判、CSet 怎么选、搬运前要准备什么。
>
> **前置概念**：Eden / Survivor / Old 角色、STW 和 safepoint、CSet 概念（ch11/07）。
>
> **第二篇**（08-02）：Root 扫描 → RSet 扫描 → 工作窃取。**第三篇**（08-03）：Post-Evacuation → Free CSet → 时间线。

---

## 目录

1. [全景——`new Object()` 到 GC 触发的完整路径](#1-全景new-object-到-gc-触发的完整路径)
2. [TLAB 分配——线程本地的快速通道](#2-tlab-分配线程本地的快速通道)
3. [Region 分配——G1 特有的三级挽救](#3-region-分配g1-特有的三级挽救)
4. [GCLocker——JNI critical section 如何阻止 GC](#4-gclockerjni-critical-section-如何阻止-gc)
5. [attempt_allocation_slow——触发 GC 的决策循环](#5-attempt_allocation_slow触发-gc-的决策循环)
6. [InitialMark 决策——这次要不要顺便启动并发标记](#6-initialmark-决策这次要不要顺便启动并发标记)
7. [CSet 选择——确认本次回收哪些 Region](#7-cset-选择确认本次回收哪些-region)
8. [Pre-Evacuation——搬运前的最后准备](#8-pre-evacuation搬运前的最后准备)
9. [附录 A: `_young_list_target_length` 算法](#附录-a-_young_list_target_length-算法)
10. [附录 B: 字段速查](#附录-b-字段速查)

---

## 1. 全景——`new Object()` 到 GC 触发的完整路径

Java 代码里写 `new Object()`。这条分配调用经历了三层决策，每层失败后才进入下一层：

```
new 字节码
  └→ MemAllocator::mem_allocate()                    [memAllocator.cpp:362]
      ├─ allocate_inside_tlab()          (§2)  TLAB 快慢路径
      │   ├─ tlab.allocate()             pointer bump (≈10 CPU inst)
      │   └─ allocate_inside_tlab_slow() _refill_waste_limit 容差 → retire or skip
      │
      └─ allocate_outside_tlab()         (§3)  Region 级分配
          └─ G1CollectedHeap::mem_allocate()          [g1CollectedHeap.cpp:398]
              └─ attempt_allocation()
                  ├─ retained region (第一级)
                  ├─ active region CAS
                  └─ attempt_allocation_slow()  (§4-5) 触发 GC
                      ├─ 持锁重试 (第二级)
                      ├─ GCLocker 紧急扩展 (第三级)
                      ├─ do_collection_pause()     → Young GC
                      └─ GCLocker::stall_until_clear()
```

- **第 1 层**（TLAB）：JVM 通用分配优化，每个线程独立。快路径 pointer bump 约 10 条指令。慢路径有 waste limit 容差判断。
- **第 2 层**（Region）：G1 特有。不再走 TLAB，直接用 CAS 操作 Eden Region 的 `_top` 指针。有 retained region + 持锁重试 + GCLocker 紧急扩展三级挽救。
- **第 3 层**（GC 触发）：三级全失败 → 触发 Young GC。有一个 for 循环保证重试能力——GC 可能被 GCLocker 拒绝、也可能被别的线程抢先。

一旦进入 GC，控制权到达 `do_collection_pause_at_safepoint()`（g1CollectedHeap.cpp:2793-3123）——约 330 行的主编排方法。它按顺序调用下面全部阶段，本文的 §4-§8 和后续 08-02、08-03 逐一展开：

```
do_collection_pause_at_safepoint(target_pause_time_ms)     // target = MaxGCPauseMillis (默认 200ms)
│
├─ [§4]  GCLocker 检查                                      // 有 JNI critical section 就 abort
├─ [§6]  decide_on_conc_mark_initiation                     // 判断要不要 InitialMark
├─ [§7]  finalize_collection_set                            // 锁定增量构建的 CSet
│        └─ finalize_young_part() → finalize_old_part()
├─ [§8]  pre_evacuate_collection_set                        // merge dirty cards + reset scan_state
├─        evacuate_collection_set (08-02)                   // ★ 并行核心：Root 扫描 → RSet 扫描 → 搬活
│        └─ G1ParTask: evacuate_roots → oops_into_cset_do → steal_and_trim
├─        post_evacuate_collection_set (08-03 §1)           // 引用处理 + 弱引用 + 字符串去重
├─        free_collection_set (08-03 §2)                    // 空 Region → FreeList
│        └─ G1FreeCollectionSetTask (串行释放 + 并行清 RSet)
└─        start_new_collection_set (08-03 §3)               // Survivor → 下一轮 CSet 种子
```

---

## 2. TLAB 分配——线程本地的快速通

### 2.1 TLAB 是什么

每个 Java 线程在 Eden Region 里独占一小块私有的 **TLAB**（Thread-Local Allocation Buffer）。在 TLAB 里分配对象只需一次 **pointer bump**：

```
TLAB 内部：
  _start ─────────────────── _top ────── _end
  已分配的对象                  ↑          上限
                           下一个对象从这里开始

分配算法（threadLocalAllocBuffer.inline.hpp:34-54）:
  if (_top + object_size <= _end)
      return _top += object_size;   // 约 10 条 CPU 指令，无锁
```

TLAB 不是 G1 特有的——它是 JVM 通用的分配优化，所有 HotSpot GC 都支持。

### 2.2 `_refill_waste_limit`——TLAB 退休的容差

TLAB 不够放下一个对象时，线程不是直接退休它——先判断 "值不值得换一个新 TLAB"。决策用一个字段完成：

| 属性 | 值 |
|------|----|
| 所在类 | `ThreadLocalAllocBuffer` |
| 类型 | `size_t` |
| 源码位置 | threadLocalAllocBuffer.hpp:57 |
| 作用域 | 每个 Java 线程**各自持有**——线程 A 的 TLAB 里有自己的 waste limit，和线程 B 互不影响 |
| 初始化 | 每次申请到新 TLAB 时重置——`threadLocalAllocBuffer.cpp:190`：`set_refill_waste_limit(initial_refill_waste_limit())` |
| 初始值 | `TLAB 大小 / TLABRefillWasteFraction`（默认 64）。比如 1MB 的 TLAB，初始 waste limit = 16KB |

```cpp
// threadLocalAllocBuffer.hpp:57
size_t _refill_waste_limit;   // TLAB 剩余超过此值则不退休
```

**决策逻辑**（memAllocator.cpp:314-316）：

```
if (TLAB剩余 > _refill_waste_limit)  →  不退休，直接在 Eden Region 上用 CAS 分配一次
if (TLAB剩余 ≤ _refill_waste_limit)  →  退休 TLAB，申请新的
```

**为什么不是每次都退休**——差得少时跳过 TLAB 单次 CAS 分配，省掉 TLAB 重建的开销。差得多时才退休，换个新的继续用。

**动态调整**——每次 "不退休、走 CAS" 时，waste limit 在 `record_slow_allocation()` 中自增 `TLABWasteIncrement`（默认 4）。线程如果频繁 "差一点点"，waste limit 逐渐变大，TLAB 更早被退休，减少慢速路径次数：

```cpp
// threadLocalAllocBuffer.inline.hpp:82-97
void ThreadLocalAllocBuffer::record_slow_allocation(size_t obj_size) {
    set_refill_waste_limit(refill_waste_limit() + refill_waste_limit_increment());
    _slow_allocations++;
}
```

### 2.3 TLAB 退休——做什么

`clear_before_allocation()`（threadLocalAllocBuffer.cpp:43-46）：

- 在 `top` 到 `hard_end` 区间填充一个 **dummy filler object**（GC 遍历 Eden 时不会撞空洞）
- 把已用字节数记入线程的总分配量
- 把 `start/top/end/allocation_end` 全部清零

**注意**：TLAB 本就属于当前的 Eden Region（`MutatorAllocRegion`），退休不是 "归还碎片"——TLAB 从未离开过 Eden。

---

## 3. Region 分配——G1 特有的三级挽救

### 3.1 从 TLAB 到 Region

第 1 层（TLAB）失败后，`mem_allocate()` 调用 `allocate_outside_tlab()`，走到 G1 的堆分配入口：

```cpp
// memAllocator.cpp:270-282
HeapWord* MemAllocator::allocate_outside_tlab(Allocation& allocation) const {
    allocation._allocated_outside_tlab = true;
    HeapWord* mem = _heap->mem_allocate(_word_size, ...);
    // _heap 是多态的——在 G1 下就是 G1CollectedHeap
}
```

```cpp
// g1CollectedHeap.cpp:398-408
HeapWord* G1CollectedHeap::mem_allocate(size_t word_size, bool* ...) {
    if (is_humongous(word_size)) return attempt_allocation_humongous(word_size);
    return attempt_allocation(word_size, word_size, &dummy);  // 普通对象走这里
}
```

`attempt_allocation()`（g1CollectedHeap.cpp:730-753）分两步：

- **快路径（无锁）**：先试 retained region（`attempt_retained_allocation()`），再试 active region 上的 CAS bump-pointer
- 两步都失败 → `attempt_allocation_slow()`——三级挽救开始

### 3.2 第一级：`_retained_alloc_region`——上一轮留下的 "备胎"

| 属性 | 值 |
|------|----|
| 所在类 | `MutatorAllocRegion` |
| 类型 | `HeapRegion* volatile`（指针 + volatile——别的线程可能在读） |
| 源码位置 | g1AllocRegion.hpp:213 |
| 初始化 | 构造函数置 NULL；Region 退休时如果 `should_retain()` 返回 true，设为当前退休的 Region |
| 作用 | 当一个 Eden Region 退休时，如果它还有剩余空间 ≥ MinTLABSize，保留为 retained region。下次分配优先从这里分配——命中率高，避免了持锁开销 |

```cpp
// g1AllocRegion.inline.hpp:133-144
if (_retained_alloc_region != NULL) {
    result = par_allocate(_retained_alloc_region, ...);   // 无锁 CAS 分配
    if (result != NULL) return result;
}
```

**关键**：retained region **不在 `_free_list` 里**——它被 `MutatorAllocRegion` 单独持有。只有 GC 清空后的 Region 才会进入 `_free_list`。

### 3.3 第二级：持锁重试 + `_young_list_target_length` 的约束

拿不到 retained region → 持 **`Heap_lock`**。

`Heap_lock` 是 JVM 全局的 `Monitor*` 单例（mutexLocker.hpp:55——`extern Monitor* Heap_lock`），所有 HotSpot GC 实现共享同一把锁。在 `mutex_init()` 中初始化为 `PaddedMonitor`，优先级 `nonleaf+1`（高优先级内部锁），safepoint check 策略为 `_safepoint_check_sometimes`。

`attempt_allocation_locked()`（g1AllocRegion.inline.hpp:98-118）三步全在 `Heap_lock` 持锁下：

```cpp
inline HeapWord* G1AllocRegion::attempt_allocation_locked(...) {
    // 步骤 1: 持锁后重试当前 Region——等锁期间别的线程可能做完了 GC
    HeapWord* result = attempt_allocation(min_word_size, desired_word_size, actual_word_size);
    if (result != NULL) return result;

    // 步骤 2: 还是失败 → 退休当前 Region
    retire(true /* fill_up */);

    // 步骤 3: 从 free list 拿新 Eden Region
    result = new_alloc_region_and_allocate(desired_word_size, false);
    if (result != NULL) {
        *actual_word_size = desired_word_size;
        return result;
    }

    return NULL;
}
```

步骤 3 里检查 `should_allocate_mutator_region()`，用到了 `G1Policy` 的两个字段：

| | `_young_list_target_length` | `_young_list_max_length` |
|---|---|---|
| 所在类 | `G1Policy` | `G1Policy` |
| 类型 | `uint` | `uint` |
| 源码位置 | g1Policy.hpp:82 | g1Policy.hpp:87 |
| 含义 | Young Region 的**目标**总数 | Young Region 的**最大**总数 |
| 何时用 | `should_allocate_mutator_region()` | `can_expand_young_list()` (GCLocker 紧急时) |

`young_regions_count()` 是 `G1CollectedHeap` 上的方法（g1CollectedHeap.hpp:1253），返回 `_eden.length() + _survivor.length()`：

```cpp
uint young_regions_count() const { return _eden.length() + _survivor.length(); }
```

```cpp
// g1Policy.cpp:861-865
bool should_allocate_mutator_region() const {
    return young_regions_count() < _young_list_target_length;
}
```

当 `young_regions_count() >= target` 时——不能再分配新的 Eden Region，进入第三级。

### 3.4 第三级：GCLocker 紧急扩展——用 `_young_list_max_length` 做缓冲

GCLocker 活跃 + 需要 GC 时（见 §4），`attempt_allocation_force()` 用 `_young_list_max_length` 做上限——允许在 target 之上再临时扩展一些 Eden Region，避免一次多余的 safepoint 往返：

```cpp
// g1Policy.cpp:867-871
bool can_expand_young_list() const {
    return young_regions_count() < _young_list_max_length;
}
```

`_young_list_max_length = target × (1 + GCLockerEdenExpansionPercent/100)`，默认 target × 1.05。

---

## 4. GCLocker——JNI critical section 如何阻止 GC

### 4.1 什么是 JNI critical section

当 Java 把数组传给 native 方法时，正常 JNI 会拷贝一份副本。但 `GetPrimitiveArrayCritical()` 不拷贝——直接返回指向 Java 堆内存的原始指针。从 `Get` 到 `Release` 的区间叫 "JNI critical section"。

```java
// Java 侧
byte[] buffer = new byte[1024 * 1024];
nativeProcess(buffer);

// C/C++ 侧（JNI）
void nativeProcess(JNIEnv* env, jbyteArray arr) {
    jbyte* raw = (*env)->GetPrimitiveArrayCritical(env, arr, NULL);
    for (int i = 0; i < len; i++) raw[i] = ...;   // 直接操作堆内存
    (*env)->ReleasePrimitiveArrayCritical(env, arr, raw, 0);
}
```

**问题**——raw 指针指向堆里的对象。GC 会搬走活对象。如果 native 代码正通过 raw 指针写数据时 GC 搬走了数组——野指针，进程 crash。

### 4.2 没有 GC 时——只是个计数器

JNI critical section 没有锁。它只是一个全局计数器 `_jni_lock_count`：

```cpp
// gcLocker.hpp:45
static volatile jint _jni_lock_count;   // 当前在 critical section 中的线程数
```

**"线程在 critical section 里" 是怎么记录的**——每线程独立追踪，不是只看全局计数器：

- **全局**：`GCLocker::_jni_lock_count`——多少个线程当前在 critical section 里
- **每线程**：`JavaThread::_jni_active_critical`（thread.hpp:1152）——**这个**线程的嵌套深度。`in_critical()` = `_jni_active_critical > 0`，`in_last_critical()` = `_jni_active_critical == 1`

两个计数器通过 `lock_critical()` / `unlock_critical()` 同步：进入时两者各 +1，退出时各 -1。safepoint 时 `verify_critical_count()` 遍历所有线程检查 per-thread 的和是否等于全局计数器。

任意多个线程可以同时进入 critical section（各自握着不同数组的指针），互不干扰。`lock_critical()` 在正常情况下只做 `_jni_lock_count++`，约几条 CPU 指令，无锁。

**`!thread->in_critical()` 在防什么**——同一个线程可能**嵌套**进入 critical section。"嵌套"的意思是：线程已经握着 A 数组的 raw 指针了，又在同一段 native 代码里调了 `GetPrimitiveArrayCritical` 去拿 B 数组的指针。如果这时候再执行一次 `_jni_lock_count++`，线程退出时也只做一次 `_jni_lock_count--`——全局计数器就对不上了。所以 `!thread->in_critical()` 检查"我已经在里面了吗？"——是的话直接 `enter_critical()` 只递增 per-thread 的 `_jni_active_critical` 嵌套深度，不碰全局计数器。

```cpp
// gcLocker.inline.hpp:31-42
void GCLocker::lock_critical(JavaThread* thread) {
  if (!thread->in_critical()) {   // 第一次进入（不是嵌套）→ 需要调全局计数器
    if (needs_gc()) {
      jni_lock(thread);           // GC 在排队 → 拿锁等
      return;
    }
    increment_debug_jni_lock_count();   // 全局计数器 +1
  }
  thread->enter_critical();       // 每次都要——递增 per-thread 嵌套深度（_jni_active_critical++）
}
}
```

**快路径**：`!thread->in_critical()` 且 `!needs_gc()` → `increment_debug_jni_lock_count()` → `thread->enter_critical()`。无锁，约几条指令。

**慢路径**：`!thread->in_critical()` 且 `needs_gc()` → `jni_lock(thread)` → 在 `JNICritical_lock` 上等 GC 完成 → 内部调 `enter_critical()`。`return` 跳过末尾的 `enter_critical()`（已经做过了）。

如果线程**已经在** critical section 里（嵌套调用），直接走末尾的 `enter_critical()` 增加嵌套计数。

### 4.3 GC 来了——三个步骤

**步骤 1：VMThread 发现被拦，设标志，abort GC**

分配失败 → GC 触发 → VMThread 发起 safepoint → 在 `do_collection_pause_at_safepoint()` 中检查：

```cpp
// g1CollectedHeap.cpp:2798
if (GCLocker::check_active_before_gc()) {
    return false;  // 有 critical section → abort 本次 GC
}
```

`check_active_before_gc()` 做的事（gcLocker.cpp:94-101）——如果 `_jni_lock_count > 0` 且 `_needs_gc` 还没设：

```cpp
_needs_gc = true;   // "我需要 GC，但有人在 critical section 里拦着"
```

然后 VMThread abort GC，解除 safepoint，mutator 恢复运行。

**为什么 VMThread 不"等"而是 abort**——此时线程 A 在 `_thread_in_native` 状态执行 native 代码——它不参与 safepoint。VMThread 在 safepoint 里等线程 A 调用 `ReleasePrimitiveArrayCritical` 是没有意义的——线程 A 根本不会响应 safepoint 请求（它没在跑 Java 代码，不会走到 safepoint 检查点）。所以 JVM 的设计是：**不等，直接放弃这次 safepoint**，让线程 A 恢复 native 代码执行，等它主动释放。这就是 `return false`——整次 GC 被 abort。

**步骤 2：走 slow path 的 mutator 等**

在 `attempt_allocation_slow()` 里，`should_try_gc = !GCLocker::needs_gc()`。`_needs_gc` 为 true → `should_try_gc = false` → 不触发 GC → 调 `GCLocker::stall_until_clear()` 在 `JNICritical_lock` 上休眠，等 `_needs_gc` 被清零。

**步骤 3：最后一个退出的人触发 GC**

`_needs_gc = true` 期间，如果有新来的线程想进 critical section，`jni_lock()` 也会在 `JNICritical_lock` 上等——因为 `_needs_gc || _doing_gc` 条件为 true：

```cpp
// gcLocker.cpp:123-137
void GCLocker::jni_lock(JavaThread* thread) {
  MutexLocker mu(JNICritical_lock);
  while (is_active_and_needs_gc() || _doing_gc) {
    JNICritical_lock->wait();           // 释放锁 + 休眠
  }
  thread->enter_critical();             // GC 完成后进入 critical section
  _jni_lock_count++;                    // 递增全局计数
  increment_debug_jni_lock_count();
}
```

已经在 critical section 里的线程不受影响——它们继续跑 native 代码。当线程 A（最后一个退出 critical section 的）调 `ReleasePrimitiveArrayCritical()` → `unlock_critical()`：

```cpp
// gcLocker.inline.hpp:44-55
void GCLocker::unlock_critical(JavaThread* thread) {
    if (thread->in_last_critical()) {   // 我是最后一个？
        if (needs_gc()) {
            jni_unlock(thread);         // 触发 GC
            return;
        }
    }
    thread->exit_critical();
}
```

`jni_unlock()`（gcLocker.cpp:139-163）：

```cpp
void GCLocker::jni_unlock(JavaThread* thread) {
  MutexLocker mu(JNICritical_lock);
  _jni_lock_count--;                           // 递减全局计数
  decrement_debug_jni_lock_count();
  thread->exit_critical();                     // 退出 critical section
  if (needs_gc() && !is_active_internal()) {   // 确认最后一个
    _total_collections = Universe::heap()->total_collections();  // 快照——防止下次 safepoint 时重复 GC
    _doing_gc = true;                          // 设标志——新来的人别进来
    {
      MutexUnlocker munlock(JNICritical_lock); // 暂时放锁——collect 内部会到 safepoint
      Universe::heap()->collect(GCCause::_gc_locker);  // ★ 触发 GC
    }
    _doing_gc = false;
    _needs_gc = false;                         // 清标志
    JNICritical_lock->notify_all();           // 叫醒所有等的人
  }
}
```

`collect()` 内部创建 `VM_G1CollectForAllocation` 提交给 VMThread——应用线程阻塞等待 VMThread 在 safepoint 中执行 GC。GC 完成后 `_needs_gc = false`、`notify_all()`——所有等在 `JNICritical_lock` 上的线程被唤醒，分配重试。

### 4.4 三个标志的职责总结

| 标志 | 类型 | 设 true 的人 | 什么时候 | 设 false 的人 | 什么时候 |
|------|------|-----------|---------|------------|---------|
| `_jni_lock_count` | `static volatile jint` | 应用线程→`lock_critical()` | 进入 critical section 时 +1 | 应用线程→`jni_unlock()` | 退出时 -1 |
| `_needs_gc` | `static volatile bool` | **VMThread**→`check_active_before_gc()` | safepoint 发现 GCLocker 拦着 GC | **应用线程**→`jni_unlock()` | GC 完成后 |
| `_doing_gc` | `static volatile bool` | **应用线程**→`jni_unlock()` | 调 `collect()` 之前 | **应用线程**→`jni_unlock()` | `collect()` 返回后 |

理解了 GCLocker 之后，回到分配故障的主线——下面 §5 把这些机制全部串进 `attempt_allocation_slow` 的 for 循环里。

## 5. attempt_allocation_slow——触发 GC 的决策循环

回到 §3 的三级挽救——第三级（GCLocker 紧急扩展）也失败了。现在控制权到达 `attempt_allocation_slow()`（g1CollectedHeap.cpp:410-516），也就是 §1 全景图里分配链最底层的那个方法。§4 的 GCLocker 机制在这里被实际调用——`should_try_gc`、`stall_until_clear`、`check_active_before_gc` 全在这一处交汇。

### 5.1 为什么是 for 循环

这个方法的核心结构是一个 `for` 循环，不是单次尝试。原因——GC 可能被 GCLocker 拒绝（§4.3 步骤 1），也可能被别的线程抢先（多个线程同时走到 slow path）——必须能回到循环头重试。

下面逐段拆开——每段先看代码、再看解释、再看它在整体里扮演什么角色。看完四段后 §5.6 汇总全貌。

### 5.2 循环头——持锁阶段

```cpp
// g1CollectedHeap.cpp:427-439
for (uint try_count = 1, gclocker_retry_count = 0; /* we'll return */; try_count += 1) {
    bool should_try_gc;
    uint gc_count_before;

    {
        MutexLockerEx x(Heap_lock);                                // 持锁
        result = _allocator->attempt_allocation_locked(word_size);
        if (result != NULL) return result;                         // ①持锁重试成功

        if (GCLocker::is_active_and_needs_gc()
            && g1_policy()->can_expand_young_list()) {
            result = _allocator->attempt_allocation_force(word_size);
            if (result != NULL) return result;                     // ②GCLocker紧急扩展成功
        }

        should_try_gc = !GCLocker::needs_gc();                    // ③决定: 自己做GC还是等?
        gc_count_before = total_collections();                     // ④快照GC计数
    } // 释放 Heap_lock
```

**① 持锁重试**：等 `Heap_lock` 期间，别的线程可能刚做完 GC、释放了 Eden Region。拿到锁后立刻再试一次当前 Region——如果成功，这个线程一次 GC 都没做就分配到了。这就是 §5.6 要讲的"GC 不是我触发的，但我受益了"。

**② GCLocker 紧急扩展**：如果 GCLocker 活跃（§4.3），在持锁状态下用 `_young_list_max_length` 做上限，绕过 `_young_list_target_length` 再分配一个新的 Eden Region。如果成功——省了一次 GC。

**③ `should_try_gc`**：决定接下来走哪条岔路。`GCLocker::needs_gc()` 为 false → 可以自己做 GC（走 §5.3）；为 true → 有 JNI critical section 拦着，走 §5.4 的 stall。

**④ `gc_count_before`**：快照当前的 `total_collections()`。后面 `do_collection_pause()` 会对比这个值——如果没变，说明 GC 被 GCLocker 拦了或被别的线程抢先了。

### 5.3 GC 阶段——自己做 GC

```cpp
    // g1CollectedHeap.cpp:441-448
    if (should_try_gc) {
        result = do_collection_pause(word_size, gc_count_before, &succeeded,
                                     GCCause::_g1_inc_collection_pause);
        if (result != NULL) return result;    // GC 成功回收空间 + 分配成功
        if (succeeded) return NULL;            // GC 成功但分配失败（堆真的满了）
        // !succeeded → GC 被抢先 → 不 return，落到 §5.5 无锁重试
    }
```

`do_collection_pause()`（g1CollectedHeap.cpp:2501-2521）创建 `VM_G1CollectForAllocation` 提交给 VMThread，**阻塞等待** GC 完成。返回时有三种可能：

| succeeded | result | 含义 | 做什么 |
|-----------|--------|------|--------|
| true | 非NULL | GC 成功执行，方法内部分配了对象 | `return result`——搞定 |
| true | NULL | GC 成功执行，但分配失败（堆满了） | `return NULL`——放弃，调用者收到 NULL |
| false | NULL | GC 没执行——被 GCLocker 拦了或被别的线程抢先 | 不 return，落到 §5.5 |

### 5.4 GCLocker stall——等 JNI critical section 释放

```cpp
    // g1CollectedHeap.cpp:448-454
    } else {  // should_try_gc == false
        if (gclocker_retry_count > GCLockerRetryAllocationCount) {
            return NULL;                      // 等太多次了 → 放弃
        }
        GCLocker::stall_until_clear();        // 在 JNICritical_lock 上休眠
        gclocker_retry_count += 1;
    }
```

`should_try_gc == false` 意味着 `GCLocker::needs_gc()` 为 true——有线程正握着 `GetPrimitiveArrayCritical` 的原始指针（§4.3）。与其触发一次注定被 abort 的 safepoint 往返，不如在 `JNICritical_lock` 上**休眠等待**。当那个握着指针的线程退出 critical section 并触发 GC 后（§4.3 步骤 3），`notify_all()` 唤醒这个线程。

**终止条件**：`gclocker_retry_count` 超过 `GCLockerRetryAllocationCount` 时放弃——防止 JNI critical section 永远不释放。

### 5.5 无锁重试——别人的 GC 可能帮了我们

```cpp
    // g1CollectedHeap.cpp:499-503
    size_t dummy = 0;
    result = _allocator->attempt_allocation(word_size, word_size, &dummy);
    if (result != NULL) return result;
}
```

无论走了 §5.3（自己做 GC）还是 §5.4（在 GCLocker stall 上等），出锁后别的线程可能已经做完了 GC、释放了 Eden Region。这一步不持锁、轻量快速——成功直接返回，失败回到循环头（下次迭代在 §5.2 重新持锁重试）。

### 5.6 全貌——四个阶段在一次循环中的位置

```cpp
// g1CollectedHeap.cpp:427-503
for (uint try_count = 1, gclocker_retry_count = 0; /* we'll return */; try_count += 1) {
    bool should_try_gc;
    uint gc_count_before;

    {                                         // ── §5.2 持锁阶段 ──
        MutexLockerEx x(Heap_lock);
        result = _allocator->attempt_allocation_locked(word_size);
        if (result != NULL) return result;

        if (GCLocker::is_active_and_needs_gc() && ...) {
            result = _allocator->attempt_allocation_force(word_size);
            if (result != NULL) return result;
        }

        should_try_gc = !GCLocker::needs_gc();
        gc_count_before = total_collections();
    }

    if (should_try_gc) {                      // ── §5.3 GC 阶段 ──
        result = do_collection_pause(...);
        if (result != NULL) return result;
        if (succeeded) return NULL;
    } else {                                  // ── §5.4 GCLocker stall ──
        if (gclocker_retry_count > GCLockerRetryAllocationCount) return NULL;
        GCLocker::stall_until_clear();
        gclocker_retry_count += 1;
    }

    result = _allocator->attempt_allocation(word_size, ..., &dummy);
    if (result != NULL) return result;        // ── §5.5 无锁重试 ──
}
```

**关键——触发 GC ≠ 自己需要 GC**。N 个线程同时走到 slow path，线程 A 在 §5.3 做了 GC，线程 B/C/D 在 `Heap_lock` 上排队等。A 的 GC 完成后 Eden 有空闲 Region，B/C/D 拿到锁后在 §5.2 的持锁重试中直接分配成功——它们一次 GC 都没做但都受益了。



## 6. InitialMark 决策——这次要不要顺便启动并发标记

每次 Young GC 之前，G1Policy 判断："老年代是不是快满了，需要启动并发标记了？"

```cpp
// g1CollectedHeap.cpp:2826
if (!_cm_thread->should_terminate()) {
    g1_policy()->decide_on_conc_mark_initiation();
}
```

`decide_on_conc_mark_initiation()`（g1Policy.cpp:936-985）：

```cpp
if (initiate_conc_mark_if_possible()     // 上次 GC 结束时设的 flag
    && in_young_only_phase()              // 还在 young-only 阶段
    && !about_to_start_mixed_phase()) {   // 还没开始 Mixed
    initiate_conc_mark();  // _in_initial_mark_gc = true → 本次变成 InitialMarkGC
}
```

`initiate_conc_mark_if_possible` 是上一次 GC 结束时 `maybe_start_marking()` 设的。它最终调用 `need_to_start_conc_mark()`（g1Policy.cpp:531-551）：

```cpp
bool need_to_start_conc_mark() {
    size_t threshold = _ihop_control->get_conc_mark_start_threshold();  // IHOP!
    size_t cur_used = _g1h->non_young_capacity_bytes();  // old + humongous

    return cur_used > threshold;
}
```

IHOP 阈值 = `internal_threshold - (marking_time × promotion_rate + max_young_size)`。本质含义：**"如果现在启动并发标记，标记完成时老年代还能装下标记期间晋升来的对象吗？"** 装不下就启动。

Normal Young GC 时 `initiate_conc_mark_if_possible()` 为 false——走纯 young 回收路径。如果为 true，变 InitialMarkGC——日志显示 `Pause Young (Concurrent Start)`（ch11/13 展开）。

---

## 7. CSet 选择——确认本次回收哪些 Region

### 7.1 什么是 CSet

CSet（Collection Set）= 本次 GC 要回收的 Region 集合。Normal Young GC 的 CSet = **所有 Eden + Survivor Region**，全量加入，无需选择。

### 7.2 Region 什么时候进 CSet——增量构建

CSet 是**增量地**构建的——mutator 运行期间一小口一小口往里加：

- **已填满退休的 Eden**：mutator 把 Eden Region 分三亚后退了它 → `retire_mutator_alloc_region()` → `add_eden_region()`（g1CollectedHeap.cpp:4874）。这个调用发生在 mutator 时间里（safepoint 之间）。
- **当前活跃的 Eden**：GC 开始时 `release_mutator_alloc_region()`（g1CollectedHeap.cpp:2926）也退休它 → 同路径入 CSet。
- **上一轮 Survivor**：上轮 GC 结束时 `transfer_survivors_to_cset()`（g1Policy.cpp:1148-1176）把它们全部加入下一轮 CSet。

`add_young_region_common()`（g1CollectionSet.cpp:229-278）是底层方法——把 `hrm_index` 写入 `_collection_set_regions` 数组：

| 字段 | 所在类 | 类型 | 源码位置 | 用途 |
|------|--------|------|---------|------|
| `_collection_set_regions` | `G1CollectionSet` | `uint*` | g1CollectionSet.hpp:55 | CSet 的 C 数组存储——存 hrm_index 而非 HeapRegion* |
| `_collection_set_cur_length` | `G1CollectionSet` | `volatile size_t` | g1CollectionSet.hpp:56 | 当前有效条目数——volatile 支持并发读 |
| `_inc_build_state` | `G1CollectionSet` | `CSetBuildType` (Active/Inactive) | g1CollectionSet.hpp:76 | 增量构建开关 |
| `_inc_recorded_rs_lengths` | `G1CollectionSet` | `size_t` | g1CollectionSet.hpp:88 | 累加 RSet 长度——用于暂停预测 |
| `_inc_predicted_elapsed_time_ms` | `G1CollectionSet` | `double` | g1CollectionSet.hpp:101 | 累加预测耗时 |

### 7.3 GC 开始时锁定——finalize_collection_set

```cpp
// g1CollectedHeap.cpp:2944
g1_policy()->finalize_collection_set(target_pause_time_ms, &_survivor);
```

`finalize_young_part()`（g1CollectionSet.cpp:356-398）：
1. `finalize_incremental_building()`——Active → Inactive，停止接受新 Region
2. `init_region_lengths(eden_count, survivor_count)`——记下数量
3. `survivors->convert_to_eden()`（g1SurvivorRegions.cpp:42-50）——SurvTag(3) → EdenTag(2)
4. 算 time budget——`target_pause_time_ms - base_time_ms`
5. Young-only 时 `finalize_old_part()` 不执行

### 7.4 `_young_list_target_length` 如何影响 CSet 大小

CSet 的大小是 GC 之间的 mutator 分配活动决定的——分配了多少 Eden Region，就有多少 Eden 进入 CSet。G1Policy 通过 `_young_list_target_length` 持续控制 "堆里该有多少 Young Region"。附录 A 详解了这个值的计算——分初始值（无历史数据，用硬编码默认值）和运行时（每次 GC 后把真实数据喂进 analytics 序列）。

---

## 8. Pre-Evacuation——搬运前的最后准备

### 8.1 做什么

```cpp
// g1CollectedHeap.cpp:2972
pre_evacuate_collection_set();
```

内部（g1CollectedHeap.cpp:4039-4058）：
- 关闭热卡缓存——GC 期间 hot card cache 不能有 stale 数据
- 调用 `prepare_for_oops_into_collection_set_do()`（g1RemSet.cpp:511-516）

### 8.2 合并 dirty card logs

```cpp
void G1RemSet::prepare_for_oops_into_collection_set_do() {
    DirtyCardQueueSet& dcqs = G1BarrierSet::dirty_card_queue_set();
    dcqs.concatenate_logs();    // ★ 合并所有线程的半满 dirty card buffer
    _scan_state->reset();
}
```

`concatenate_logs()`——mutator 在 GC 前最后一刻产生的 dirty card 还写在 thread-local buffer 里，没提交到全局队列。必须赶在 GC 扫描前合并进来，否则漏掉引用。

### 8.3 重置 scan_state

`_scan_state->reset()` 为堆中每个 Region 重算 `_scan_top[i]`（ch11/06 §2.3）：
- 不在 CSet 中的 old/humongous Region → `_scan_top[i] = top()`（需要扫描它的 card）
- CSet 内 / young / free Region → `_scan_top[i] = bottom()`（在 evacuation 时自然处理）

如果本次是 InitialMark GC，还需清理 ClassLoaderData claimed 标记——Normal Young GC 跳过。

---

## 附录 A: `_young_list_target_length` 算法

G1Policy 通过 `_young_list_target_length` 控制堆里该有多少 Young Region。**初始值和运行时值的计算方式截然不同。**

### A.1 初始值——无历史数据

VM 启动时 `G1Policy::init()`（g1Policy.cpp:92）调用计算。所有 analytics 序列为空——G1Analytics 用硬编码默认值（g1Analytics.cpp:41-66）：

| 预测项 | 默认值 |
|--------|--------|
| 拷贝成本 | 0.000009~0.00006 ms/byte |
| 固定开销 | 5.0 ms |
| 存活率 | 0.4 / age |
| RSet 扫描成本 | 0.0015~0.01 ms/card |

`G1YoungLengthPredictor::will_fit(young_length)`（g1Policy.cpp:121-158）检查三项：空间足够 + 暂停不超 MaxGCPauseMillis + 拷贝安全余量（safety_factor = 2.2）。二分搜索在 `[G1NewSizePercent%堆, G1MaxNewSizePercent%堆]` 范围内找最大值。

### A.2 运行时——数据驱动

`record_collection_pause_end()`（g1Policy.cpp:710）把真实数据喂进 analytics：分配速率、RS 长度、拷贝时间、pending cards。EWMA 预测越来越准。

`G1YoungRemSetSamplingThread` 每 300ms 采样 RS 实际大小——超标时用 ×1.1 容错重新算，可能触发提前 GC。

---

## 附录 B: 字段速查

| 字段 | 所在类 | 类型 | 源码位置 | 用途 |
|------|--------|------|---------|------|
| `_refill_waste_limit` | `ThreadLocalAllocBuffer` | `size_t` | threadLocalAllocBuffer.hpp:57 | TLAB 剩余超过此值不做退休 |
| `_retained_alloc_region` | `MutatorAllocRegion` | `HeapRegion* volatile` | g1AllocRegion.hpp:213 | 退休时保留的 Region——下次优先分配 |
| `_young_list_target_length` | `G1Policy` | `uint` | g1Policy.hpp:82 | Young Region 的目标总数 |
| `_young_list_max_length` | `G1Policy` | `uint` | g1Policy.hpp:87 | GCLocker 活跃时的 Eden 最大 Region 数 |
| `_jni_lock_count` | `GCLocker` | `static volatile jint` | gcLocker.hpp:45 | JNI critical section 线程计数 |
| `_needs_gc` | `GCLocker` | `static volatile bool` | gcLocker.hpp:46 | 堆需要 GC 但被 critical section 拦住的标志 |
| `_doing_gc` | `GCLocker` | `static volatile bool` | gcLocker.hpp:48 | 有线程正在通过 VMThread 触发 GC 的标志 |
| `_collection_set_regions` | `G1CollectionSet` | `uint*` | g1CollectionSet.hpp:55 | CSet 的 C 数组——存 hrm_index |
| `_collection_set_cur_length` | `G1CollectionSet` | `volatile size_t` | g1CollectionSet.hpp:56 | CSet 有效条目数 |
| `_inc_build_state` | `G1CollectionSet` | `CSetBuildType` | g1CollectionSet.hpp:76 | Active/Inactive 增量构建开关 |
| `_inc_recorded_rs_lengths` | `G1CollectionSet` | `size_t` | g1CollectionSet.hpp:88 | 累加 RSet 长度 |
| `_inc_predicted_elapsed_time_ms` | `G1CollectionSet` | `double` | g1CollectionSet.hpp:101 | 累加预测耗时 |
| `Heap_lock` | (全局 `Monitor*`) | `Monitor*` | mutexLocker.hpp:55 | 所有 GC 共享的全局互斥体 |
