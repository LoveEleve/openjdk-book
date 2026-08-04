# G1 Young GC 详解（二）——Evacuation 核心 / Root 扫描 / RSet 扫描 / 工作窃取

> **系列定位**：三篇串讲一次 Normal Young GC。第二篇讲解 GC 最核心的阶段——搬走 CSet 中所有活对象。12 个 Root 子任务的并行分工、RSet 扫描怎么找到跨 Region 引用、工作窃取怎么保证不遗漏任何引用。
>
> **前置**：第一篇（08-01）——触发 / GCLocker / CSet 选择 / Pre-Evacuation。本章的 §1 Pre-Evacuation 是 08-01 §8 的承接点。
>
> **第三篇**：Post-Evacuation → Free CSet → 完整时间线（08-03）。

---

## 1. Pre-Evacuation——搬运前的最后准备（承接 08-01）

### 1.1 前置背景——card table 和 RSet 数据流

08-01 §8 讲到 `pre_evacuate_collection_set()`。但在看它的源码之前，先理解一个前提——**GC 是怎么知道 "old Region 里有引用指向 CSet Region" 的**。

G1 把堆切分成大小相等的 Region，每个 Region 内部又切成 512 字节的 **card**。堆上有一份全局的 **card table**（`G1CardTable`）——一个 `jbyte*` 字节数组，每个 card 对应一个字节，取值 `clean_card_val` 或 `dirty_card_val`。

数据流的完整路径：

```
mutator 改引用  → write barrier 把对应 card 标记为 dirty
                → 入线程私有的 DirtyCardQueue (thread-local, bump-pointer)
                
DirtyCardQueue  → buffer 满了 → flush → 挂到全局 DirtyCardQueueSet 的 completed list 上
                
refinement 线程 → 从 completed list 取 buffer → 逐个扫 card → 
                 扫描 card 覆盖范围内的引用 → 把 "谁引用了我" 的信息写入
                 目标 Region 的 RSet (Remembered Set)
```

**card table 和 RSet 的分工**：
- card table 记录 **"哪个 card 脏了"**——它是一个粗粒度的索引，告诉你"这块区域最近发生过引用变更"
- RSet 记录 **"谁引用了我"**——每个 Region 自己的 RSet 存储所有指向它的外部引用（来自哪个 Region、哪个 card）。RSet 从 card 扫描结果中构建

为什么需要 RSet？因为 GC 时只回收 *一部分* Region（CSet）。要知道 CSet Region 有没有被其他 Region 引用——不能把全堆扫一遍。RSet 提供了反向索引——只查 CSet 内 Region 的 RSet，就能定位到所有入引用。

**那么 GC 来时还有什么是没干完的？**
- mutator 线程的 thread-local DCQ 里还有 "半满" 的 buffer——safepoint 前最后一刻还在写引用，这些 card 还在本地队列里，对全局不可见
- 全局 completed list 上可能有 refinement 线程来不及处理的 buffer——它们被 safepoint 挂起了

`prepare_for_oops_into_collection_set_do()` 就是解决这两个残留——把半满 buffer flush 进全局列表、重置扫描状态。

### 1.2 源代码

```cpp
// g1RemSet.cpp:511-516
void G1RemSet::prepare_for_oops_into_collection_set_do() {
    DirtyCardQueueSet& dcqs = G1BarrierSet::dirty_card_queue_set();
    dcqs.concatenate_logs();     // 把所有线程的半满 buffer → 全局 completed list
    _scan_state->reset();        // 为每个 Region 重算 _scan_top[]
}
```

`concatenate_logs()` 遍历所有 JavaThread（应用线程），将每个线程的 `DirtyCardQueue` 当前 partial buffer 和共享队列 `_shared_dirty_card_queue` 一起 flush 到全局 `DirtyCardQueueSet` 的 completed buffer list 上。这保证了 **GC Workers 有一份完整的 "所有 dirty card" 的视图**——不会漏掉任何一个 card。

`_scan_state->reset()` 为堆中每个 Region 重算 `_scan_top[i]`。代码逻辑已经在 08-01 §8 讲过——这里强调的是**这个数组在后续 §4 的 RSet 扫描中会被大量使用**——它决定了每个 old/humongous Region 的哪些 card block 需要被扫描。

---

## 2. Evacuation 全景——在主编排中的位置

这篇讲的是 `evacuate_collection_set()`——但在这之前，先看它在上层主编排方法 `do_collection_pause_at_safepoint()`（g1CollectedHeap.cpp:2794-3123）中的完整位置。VMThread 进入 safepoint 后，按顺序执行以下步骤（省略日志/验证代码）：

```
do_collection_pause_at_safepoint(target_pause_time_ms)    ← VMThread 执行
│
├─ GCLocker::check_active_before_gc()                     ← 08-01 §4
│   有 JNI critical section → return false (abort GC)
│
├─ decide_on_conc_mark_initiation()                        ← 08-01 §6
│   IHOP 判定这次是 Normal 还是 InitialMark
│
├─ release_mutator_alloc_region()                          ← 08-01 §3
│   退休当前活跃的 Eden Region → 入 CSet
│
├─ finalize_collection_set()                               ← 08-01 §7
│   ★ 锁定 CSet——Active→Inactive, Survivor→Eden, 算 time budget
│
├─ cleanupHRRS()                                            ← 清除上次 GC 残留的 RSet 临时数据
│   确保本次 RSet 扫描从干净状态开始
│
├─ register_humongous_regions_with_cset()                  ← 巨型对象回收 (ch10/09)
│   把有 pending 回收资格的 Humongous Region 加入 CSet
│
├─ init_gc_alloc_regions()                                 ← 本文 §2.6
│   为 GC Worker 创建搬运用的 Survivor/Old PLAB 分配目标 Region
│
├─ G1ParScanThreadStateSet per_thread_states(...)          ← 本文 §2.6
│   ★ 创建每个 Worker 的 pss——全文操作的核心句柄
│
├─ pre_evacuate_collection_set()                            ← 08-01 §8 + 本文 §1
│   merge dirty cards (concatenate_logs) + reset scan_state
│
├─ ★★★ evacuate_collection_set(&per_thread_states)        ← 本文 §2-§6 ★
│   └─ workers()->run_task(&g1_par_task)                   g1CollectedHeap.cpp:2975→4063
│       └─ G1ParTask::work(worker_id)    // N 个 GC Worker 并行:
│           ├─ 阶段 A: evacuate_roots   ← 本文 §3
│           │   └─ 9 种 GC Root + 3 个处理任务, CAS claim 分工
│           ├─ 阶段 B: oops_into_cset   ← 本文 §4
│           │   └─ update_rem_set (残存 dirty card) + scan_rem_set (RSet)
│           └─ 阶段 C: do_void          ← 本文 §5
│               └─ trim 自家 → steal 别人 → terminate
│
├─ post_evacuate_collection_set()                           ← 08-03 §1
│   引用处理 / 弱引用 / 字符串去重 ...
│
├─ free_collection_set()                                    ← 08-03 §2
│   └─ 串行释放 Region + 并行清 RSet
│
├─ eagerly_reclaim_humongous_regions()                     ← 巨型对象回收 (ch10/09)
│   回收 "全死" 的 Humongous Region
│
├─ start_new_collection_set()                               ← 08-03 §3
│   ★ Survivor → 下一轮 CSet 种子, _inc_build_state = Active
│
├─ (evacuation_failed 处理 / PLAB 调整 / dummy 填充)        ← 08-03 涉及
│
├─ init_mutator_alloc_region()                              ← 08-03 §3
│   从 FreeList 拿新 Eden Region → mutator 从这里继续分配
│
├─ record_collection_pause_end()                            ← G1Policy 预测下一轮
│   ★ 把真实数据喂进 G1Analytics: 暂停时间/card 扫描数 → 更新预测器
│
└─ if (InitialMark) { do_concurrent_mark() }               ← 通知 CM 线程启动
```

### 2.1 先看三阶段骨架

每个 GC Worker 执行的是同一个方法——`G1ParTask::work(worker_id)`（g1CollectedHeap.cpp:3185-3251）。本节后续小节逐一介绍参与方：谁在干活（§2.2）、干的活是什么（§2.3）、怎么协调分工（§2.4）、Worker 带了什么工具（§2.5）、搬运前做了什么准备（§2.6）。现在先看骨架本身：

```cpp
void work(uint worker_id) {
    G1ParScanThreadState* pss = psss->state_for_worker(worker_id);

    // 阶段 A: Root 扫描——从 GC Roots 找到第一批指向 CSet 的引用 → §3
    _root_processor->evacuate_roots(pss, worker_id);

    // 阶段 B: RSet 扫描——找到来自 old Region 的跨 Region 引用 → §4
    _g1h->g1_rem_set()->oops_into_collection_set_do(pss, worker_id);

    // 阶段 C: 工作窃取——追踪所有"刚搬完的对象"的引用字段 → §5
    G1ParEvacuateFollowersClosure evac(_g1h, pss, _queues, &_terminator);
    evac.do_void();
}
```

三个阶段**每个 Worker 内部串行**（必须先扫完根和 RSet 把第一批对象推进队列、才能开始窃取），但**Worker 之间并行**——没有依赖。分别对应本文 §3、§4、§5。

### 2.2 谁在干活——WorkGang 线程模型

**和 Java ThreadPoolExecutor 的不同**

Java 的 `ThreadPoolExecutor`：提交一个 `Runnable` → 只有一个线程抢到 → 执行 `run()`。HotSpot 的 `WorkGang` 反过来：提交一个 `AbstractGangTask` → **多个线程同时执行同一个 task 对象的 `work(worker_id)`**，靠不同的 `worker_id` 区分各自的工作。

**run_task——提交任务到 WorkGang**

```cpp
// workgroup.cpp:292-300
void WorkGang::run_task(AbstractGangTask* task, uint num_workers, bool add_foreground_work) {
    uint old_num_workers = _active_workers;
    update_active_workers(num_workers);    // ① 暂设本次 GC 用 num_workers 个线程
    _dispatcher->coordinator_execute_on_workers(task, num_workers, add_foreground_work);  // ② 分发任务
    update_active_workers(old_num_workers); // ③ 恢复 GC 前的 active 值
}
```

`_dispatcher` 是 `GangTaskDispatcher`。默认的 `SemaphoreGangTaskDispatcher` 用一对信号量驱动：

```cpp
// workgroup.cpp:150-168
void SemaphoreGangTaskDispatcher::coordinator_execute_on_workers(
        AbstractGangTask* task, uint num_workers, bool add_foreground_work) {
    _task = task;
    _not_finished = num_workers;
    _start_semaphore->signal(num_workers);   // ★ 发 num_workers 个信号,唤醒休眠的 Worker
    _end_semaphore->wait();                  // ★ 阻塞等全部干完
    _task = NULL; _started = 0;
}
```

**GangWorker 线程——休眠→接任务→干活→报完工**

每个 GangWorker 是一个 OS 线程，启动后进入无限循环（workgroup.cpp:309-365）：

```cpp
void AbstractGangWorker::run() {
    initialize();   // 设优先级、设 name
    loop();         // 永不返回
}

void GangWorker::loop() {
    while (true) {
        WorkData data = wait_for_task();   // ① 在 _start_semaphore 上阻塞
        run_task(data);                     // ② data._task->work(data._worker_id)
        signal_task_done();                 // ③ 告诉 coordinator "我做完了"
    }
}

void GangWorker::run_task(WorkData data) {
    GCIdMark gc_id_mark(data._task->gc_id());
    data._task->work(data._worker_id);     // ★ 就是 g1_par_task.work(worker_id)
}
```

`WorkData` 就是两个字段（workgroup.hpp:77-81）：
```cpp
struct WorkData {
    AbstractGangTask* _task;      // 要执行哪个 task
    uint              _worker_id; // 这个线程的编号
};
```

**worker_id 怎么分配的**——不是预分配的。哪个线程先被 OS 调度醒、先抢到 `_started` 的自增，它就拿到 `worker_id=0`：

```cpp
// workgroup.cpp:170-179
WorkData worker_wait_for_task() {
    _start_semaphore->wait();
    uint num_started = Atomic::add(1u, &_started);
    uint worker_id = num_started - 1;       // ★ 先抢到的拿小号, 后抢到的拿大号
    return WorkData(_task, worker_id);
}
```

**一句话总结**：GangWorker 线程是 `while(true) { sleep; data=wait(); data._task->work(data._worker_id); done(); }` 的永动循环——不取队列、不抢任务、同一个 task 对象被 N 个线程同时执行、只靠 `worker_id` 区分。

**G1 里——workers() 就是 _workers 字段**

`G1CollectedHeap::_workers` 是一个 `WorkGang*`，VM 启动时构造，`initialize_workers()` 创建全部 `ParallelGCThreads` 个 GangWorker 线程。`workers()` 是 getter。`workers()->run_task(&g1_par_task)` 就是唤醒 `num_workers` 个 GangWorker，每个抢到一个 `worker_id`，同时执行同一个 `g1_par_task` 的 `work(worker_id)`。

### 2.3 干的活是什么——G1ParTask

上面说的 "task 对象" 在 evacuate 阶段就是 `G1ParTask`（g1CollectedHeap.cpp:3165-3183）：

```cpp
class G1ParTask : public AbstractGangTask {
protected:
    G1CollectedHeap*         _g1h;              // G1 堆
    G1ParScanThreadStateSet* _pss;              // per-worker 状态集（从这拿自己的 pss）
    RefToScanQueueSet*       _queues;           // 全局窃取队列集（steal 时用）
    G1RootProcessor*         _root_processor;   // Root 扫描调度器（所有 Worker 共享）
    ParallelTaskTerminator   _terminator;       // 终止协议（判断全干完了没）
    uint                     _n_workers;        // 本次 GC 用几个 Worker
};
```

所有 Worker 操作的是同一个 `g1_par_task` 对象——`_root_processor`、`_queues`、`_terminator` 在所有 Worker 间共享。

### 2.4 怎么协调分工——G1RootProcessor

`work()` 中阶段 A 的 `_root_processor->evacuate_roots(pss, worker_id)` 调用的就是它。`G1RootProcessor` 是一个 `StackObj`（栈对象，`evacuate_collection_set` 返回时自动析构），所有 Worker 共享同一个实例（g1RootProcessor.hpp:49-74）：

```cpp
class G1RootProcessor : public StackObj {
    G1CollectedHeap* _g1h;
    SubTasksDone _process_strong_tasks;              // ★ 12 任务的 CAS claim 数组
    StrongRootsScope _srs;                           // 并行上下文（Worker 数量）
    OopStorage::ParState<false, false> _par_state_string; // StringTable 并行迭代
    Monitor _lock;                                   // Worker barrier 锁
    volatile jint _n_workers_discovered_strong_classes; // barrier 计数器
};
```

字段解释：

| 字段 | 干什么 |
|------|--------|
| `_process_strong_tasks` | 核心。`SubTasksDone` 对象，内部 `uint* _tasks` 数组，12 个槽各对应一个 Root 类型（0=未抢，1=已抢）。所有 Worker 通过 CAS 抢——不是 12 个 Worker 各分一个，而是所有 Worker 抢这 12 个槽 |
| `_srs` | 只存一个 `n_threads`。线程栈扫描用它判断是否并行 |
| `_par_state_string` | 把 StringTable 的桶均匀分给 Worker |
| `_lock + _n_workers_discovered_strong_classes` | Worker barrier——InitialMark 时才用。Normal Young GC 不参与（`trace_metadata()`=false） |

**`_process_strong_tasks` 怎么工作——CAS claim 源码**

实际场景：N 个 Worker 各自线性走过 12 个 `if (!is_task_claimed(N))` 检查。Worker 0 在 Universe 上 CAS 成功，当场执行 `Universe::oops_do`；Worker 1 看到 Universe 已被抢就跳过，在 JNIHandles 上抢到于是执行 `JNIHandles::oops_do`...双方各抢各的，12 个全部分配完（workgroup.cpp:446-460）：

```cpp
bool SubTasksDone::is_task_claimed(uint t) {
    assert(t < _n_tasks, "bad task id.");
    uint old = _tasks[t];
    if (old == 0) {
        old = Atomic::cmpxchg(1u, &_tasks[t], 0u);
    }
    return old != 0;  // old=0 → CAS成功 → return false → 第一次claim,执行该任务
                      // old=1 → 已claim → return true  → 跳过,试下一个
}
```

**[`_tasks`]** — `SubTasksDone::uint*`, workgroup.cpp:427，每个元素 0=未声明 1=已声明。通过 `Atomic::cmpxchg` 原子 0→1。GC 结束 `all_tasks_completed(n_workers)` 全复位。

调用方逻辑：`if (!is_task_claimed(N))` → false=我是第一个，执行；true=已被人抢了，跳过。

### 2.5 每个 Worker 带什么工具——G1ParScanThreadState 概览

`work()` 第一行 `pss = psss->state_for_worker(worker_id)`——`G1ParScanThreadState`（简写 `pss`）是每个 Worker 的随身工具箱，evacuation 期间所有操作都通过它。下面列出关键时刻用到的字段，完整身份卡片在 §6：

| 字段 | 干什么 |
|------|--------|
| `_refs` | 该 Worker 的任务队列。搬完的对象 push 进去，pop 出来追踪其 oop 字段。空闲 Worker 从这里被别人 steal |
| `_plab_allocator` | 目标空间分配。搬对象时在 Survivor/Old Region 里用 bump-pointer 无锁分配 |
| `_closures` | Root 扫描闭包集。`strong_oops()`/`weak_oops()`/`code_oops()`，传给 `evacuate_roots()` 用来遍历不同 Root |
| `_scanner` | 扫描已搬对象的每个 oop 字段——发现指向 CSet 的引用就 push 进 `_refs`，驱动 §5 的图遍历 |
| `_dcq` | 推迟的 dirty card 队列。GC 期间产生的新 dirty card 暂存这里，收尾阶段批量处理 |
| `_age_table` | 对象年龄表。记录搬了多少字节到各年龄层（0-15），GC 结束时合并到 G1Policy |

### 2.6 搬运前的准备——GC 分配 Region 和 pss 创建

全景图告诉我们——在执行 `evacuate_collection_set()` 之前，有两步关键准备：`init_gc_alloc_regions()` 和 `G1ParScanThreadStateSet(...)`。

**init_gc_alloc_regions——搬运的目标 Region 从哪来**

GC Worker 搬运对象需要目标空间。N 个 Worker 同时搬，每次分配都抢全局锁就是瓶颈。HotSpot 用 **PLAB**（Parallel Local Allocation Buffer）解决——每个 Worker 提前从全局 GC 分配 Region 中切一小段内存到自己的 PLAB 里，在 PLAB 内只需 bump-pointer（`_top += obj_size`），完全无锁。PLAB 用完了再批量申请新段，锁开销被分摊。

`init_gc_alloc_regions()` 创建的就是 PLAB 的 "源头 Region"（g1Allocator.cpp:94-105）：

```cpp
void G1Allocator::init_gc_alloc_regions(EvacuationInfo& evacuation_info) {
    _survivor_is_full = false;
    _old_is_full = false;
    _survivor_gc_alloc_region.init();    // ★ Survivor 源 Region
    _old_gc_alloc_region.init();         // ★ Old 源 Region
    reuse_retained_old_region(...);      // ★ 复用上一轮留下的 Old Region
}
```

| 字段 | 类型 | 作用 |
|------|------|------|
| `_survivor_gc_alloc_region` | `SurvivorGCAllocRegion` | Worker 的 PLAB 从这里拿 Survivor 空间 |
| `_old_gc_alloc_region` | `OldGCAllocRegion` | Worker 的 PLAB 从这里拿 Old 空间 |
| `_retained_old_gc_alloc_region` | `HeapRegion*` | 上一轮留下的未用 Old Region——本轮优先复用 |

**G1ParScanThreadStateSet——创建每个 Worker 的 pss**

构造时分配 `_states[N]` 数组全部置 NULL——延迟创建。`G1ParScanThreadState` 构造成本高（要建 PLABAllocator、G1EvacuationRootClosures），只在 Worker 首次调 `state_for_worker(worker_id)` 时才 new（g1ParScanThreadState.cpp:326-332, 386-397）：

```cpp
G1ParScanThreadStateSet::G1ParScanThreadStateSet(G1CollectedHeap* g1h,
                                                  uint n_workers, size_t young_cset_length) :
    _g1h(g1h),
    _states(NEW_C_HEAP_ARRAY(G1ParScanThreadState*, n_workers, mtGC)),
    _surviving_young_words_total(NEW_C_HEAP_ARRAY(size_t, young_cset_length, mtGC)),
    _n_workers(n_workers), _flushed(false) {
    for (uint i = 0; i < n_workers; ++i) _states[i] = NULL;
    memset(_surviving_young_words_total, 0, young_cset_length * sizeof(size_t));
}

G1ParScanThreadState* G1ParScanThreadStateSet::state_for_worker(uint worker_id) {
    if (_states[worker_id] == NULL) {
        _states[worker_id] = new G1ParScanThreadState(_g1h, worker_id, _young_cset_length);
    }
    return _states[worker_id];
}
```

`G1ParTask::work(worker_id)` 第一步就是 `pss = psss->state_for_worker(worker_id)`——触发延迟创建。

全文都在围绕一个核心句柄——`G1ParScanThreadState`（简写 `pss`）。在 `per_thread_states(...)` 构造时（全景图 L2971），`G1ParScanThreadStateSet` 为每个 Worker 创建一个 `G1ParScanThreadState` 实例。Worker 在 evacuation 期间需要的所有上下文都挂在这个对象上：

| pss 字段 | 干什么 |
|----------|--------|
| `_refs` | 该 Worker 的任务队列。搬完的对象 push 进去，pop 出来追踪其 oop 字段。空 Worker 从这里被别人 steal |
| `_plab_allocator` | 目标空间分配。搬对象时在 Survivor/Old Region 里用 bump-pointer 无锁分配（详见 §3.6） |
| `_closures` | Root 扫描闭包集。`strong_oops()`/`weak_oops()`/`code_oops()` 三种闭包，传给 `evacuate_roots()` 用来遍历不同 Root（详见 §3.4） |
| `_scanner` | 扫描已搬对象的每个 oop 字段——发现指向 CSet 的引用就 push 进 `_refs`，驱动 §5 的图遍历 |
| `_dcq` | 推迟的 dirty card 队列。GC 期间扫描引用字段如果产生了新 dirty card，不直接更新 RSet，暂存到这里，收尾阶段批量处理 |
| `_age_table` | 对象年龄表。记录本 Worker 搬了多少字节到各年龄层（0-15）。GC 结束时合并到 G1Policy，用于计算下一轮的 `_tenuring_threshold` |

`G1ParTask::work(worker_id)` 的第一步就是 `pss = psss->state_for_worker(worker_id)`——触发延迟创建。

---

## 3. 阶段 A: Root 扫描——从根源出发

§2.1 的三阶段代码中，阶段 A 调用 `_root_processor->evacuate_roots(pss, worker_id)`。`G1RootProcessor` 的数据结构已在 §2.1 讲解——它是一个 StackObj，持有 12 子任务的 CAS claim 数组，所有 Worker 共享。下面看 `evacuate_collection_set()` 如何创建它和 `G1ParTask`：

```cpp
// g1CollectedHeap.cpp:4063
void G1CollectedHeap::evacuate_collection_set(G1ParScanThreadStateSet* per_thread_states) {
    const uint n_workers = workers()->active_workers();
    G1RootProcessor root_processor(this, n_workers);              // §2.4 已详解
    G1ParTask g1_par_task(this, per_thread_states, _task_queues,
                          &root_processor, n_workers);            // §2.3 已详解
    workers()->run_task(&g1_par_task);                             // §2.2 已详解
}
```

现在所有前提都已讲过，可以进入 §3 的正题——Root 扫描。

### 3.1 为什么要从 Root 开始

GC 判断对象是否存活的唯一标准：**从 GC Roots 出发，沿引用链能否到达**。

如果某个对象能从任何 Root 走到——它是活的，需要被搬走（留在 CSet 里会被回收）。如果从任何 Root 都走不到——它是死的，不需要管它（CSet Region 被释放时自然消失）。Root 扫描就是找到 **"从外界进入 CSet 的第一扇门"**——所有能被根直接引用到的、且在 CSet 内的对象，必须立刻搬走。

### 3.2 12 个并行子任务

G1RootProcessor 把 Root 扫描及相关处理划分为 12 个并行子任务，通过同一个 `SubTasksDone` 机制调度（g1RootProcessor.hpp:59-74）。其中前 9 个是真正的 **GC Root 类型**，后 3 个是相关的处理任务（和 Root 共享 claim 调度器）：

```
G1RP_PS_Universe_oops_do           ← 1. Universe 基础类型（java.lang.Class 的 mirror 等）
G1RP_PS_JNIHandles_oops_do         ← 2. JNI 全局引用和局部引用
G1RP_PS_ObjectSynchronizer_oops_do ← 3. ObjectMonitor 等待队列中的对象引用
G1RP_PS_Management_oops_do         ← 4. JMX MemoryPool/MemoryManager 持有的引用
G1RP_PS_SystemDictionary_oops_do   ← 5. 所有已加载 Java 类的静态字段
G1RP_PS_ClassLoaderDataGraph_oops_do ← 6. 类加载器层级中的引用
G1RP_PS_jvmti_oops_do             ← 7. JVMTI 探针（agent）持有的引用
G1RP_PS_CodeCache_oops_do         ← 8. JIT 编译后机器码中嵌入的对象引用
G1RP_PS_aot_oops_do               ← 9. AOT 编译缓存
G1RP_PS_filter_satb_buffers       ← 10. SATB 缓冲过滤（用于并发标记，Normal Young GC 跳过）——非 Root
G1RP_PS_refProcessor_oops_do      ← 11. Reference 处理器——非 Root
G1RP_PS_weakProcessor_oops_do     ← 12. 弱引用处理器——非 Root
G1RP_PS_NumElements               ← 13.（计数哨兵）
```

**前 9 种根——它们到底是什么**

写屏障和 RSet（§1）解决了 "堆内跨 Region 引用" 的追踪。但还有一类引用不来自堆——来自 **JVM 本身**。JVM 运行时内部有大量数据结构持有对象引用，这些不在任何 Region 的 RSet 里，但同样指向堆内对象。9 种根覆盖了所有这些"非堆源"的引用：

| Root | 里面有什么 | 为什么是根 |
|------|-----------|-----------|
| **Universe** | `java.lang.Class` 的 mirror 对象（每个 Java 类在堆上有一个 `Class` 对象，`String.class`、`Integer.class` 等基础类的 mirror 被 Universe 直接持有） | 任何代码通过 `getClass()` 拿到的 Class 对象都是活的——如果被 GC 搬了，Java 反射 / Method Area 全乱 |
| **JNIHandles** | JNI 创建的所有全局引用 (`NewGlobalRef`) 和局部引用 | 任何一个 JNI 调用创建的全局引用必须保持 referent 存活——否则 native 代码下次通过 `GetObjectField` 拿到悬空指针 |
| **ObjectSynchronizer** | 所有正在 `wait()` 状态的对象——ObjectMonitor 等待队列中持有 referent | `obj.wait()` 时 obj 被锁住并进入等待队列——如果此时 GC 搬走 obj，`notify()` 醒来拿到的是旧地址 |
| **Management** | `java.lang.management.MemoryPoolMXBean`、`MemoryManagerMXBean` 等 JMX Bean 持有的引用 | JMX 监控接口通过 MXBean 暴露 VM 内部数据——搬走 MXBean 引用的对象会导致 JConsole 读到悬空数据 |
| **SystemDictionary** | 所有已加载 Java 类的**静态字段**值——`static MyObject field = new MyObject()` | Java 类加载时初始化静态字段——这些对象从 ClassLoader 角度看必须一直存活，但 GC 必须知道它们在哪 |
| **ClassLoaderDataGraph** | 类加载器层级关系——BootCLD → AppCLD → CustomCLD，每个 CLD 下有自己的一组 `Klass*` + `ConstantPool*` + `Method*` → 引用的 `java.lang.String` 对象 | CLD 持有类元数据引用的 String 对象——卸载一个 CLD 时对应的 String 也需可达 |
| **JVMTI** | Agent 通过 `SetTag` 标记过的对象——自定 retain 的引用 | JVMTI agent（profiler/debugger）可能通过 tag 保持对象存活——搬走 agent 标记的对象会导致 profiling 数据断裂 |
| **CodeCache** | JIT 编译后生成的 `nmethod` 代码块中嵌入的 `oop` 常量——`ldc <String>` 的字符串、`Class.forName("X")` 的 Class 对象 | 机器码直接从常量池加载对象地址到寄存器——如果对象被搬了，下次执行 `ldc` 会 load 到旧地址（crash） |
| **AOT** | AOT 编译缓存的代码块——和 CodeCache 同样的机制 | 同上——AOT 代码直接引用对象地址 |

所有 9 种根最终**通过同一个闭包接口调 `do_oop(ref)` 来遍历每个引用**——JNIHandles 遍历自己的 handle table 时对每个 handle 调一次 `do_oop`、SystemDictionary 遍历字典时对每个 entry 调一次 `do_oop`。

### 3.3 闭包——Root 扫描怎么连通搬运

CAS claim 解决了"谁来干"的问题。但还没讲"怎么干"——当 Worker i claim 了 `G1RP_PS_JNIHandles_oops_do` 之后，`JNIHandles::oops_do(strong_roots)` 到底怎么把 JNI handle 里的引用变成一次 `copy_to_survivor_space()` 的调用？

答案是一层闭包（closure）结构。

**闭包在 HotSpot GC 中的角色**

闭包是 HotSpot GC 的基础模式。它的概念很简单：

- `OopClosure` 是一个抽象类，暴露一个虚方法 `virtual void do_oop(oop* p)`
- 每种需要遍历引用的场景（JNIHandles、Universe、SystemDictionary）只调用 `do_oop(ref)`——不关心具体的搬运逻辑
- 谁来注入这个 `do_oop` 怎么实现？**闭包的子类**。G1 在创建闭包对象时，把 `pss` 传进去——闭包的 `do_oop` 实现里调的是 `pss->push_on_queue(ref)`

所以 Root 扫描和搬运之间的纽带是：**闭包的 `do_oop(ref)` → `pss->push_on_queue(ref)`**。Root 遍历代码不需要知道 ref 之后会发生什么——闭包负责把引用塞进队列，后续 §5 的 `trim_queue` 从队列里取出引用执行实际搬运。

**G1 在三类闭包之上再包装一层**

Root 扫描不只需要 `OopClosure`（扫 oop 引用），还需要 `CLDClosure`（扫 class loader data）和 `CodeBlobClosure`（扫 CodeCache 的 nmethod）。`G1EvacuationRootClosures` 把三类闭包打包在一起：

```cpp
// g1RootClosures.cpp:31-53
class G1EvacuationClosures : public G1EvacuationRootClosures {
    G1SharedClosures<G1MarkNone> _closures;

public:
    G1EvacuationClosures(G1CollectedHeap* g1h,
                         G1ParScanThreadState* pss,
                         bool in_young_gc) :
        _closures(g1h, pss, in_young_gc, /* must_claim_cld */ false) {}

    OopClosure* strong_oops() { return &_closures._oops; }
    CLDClosure* strong_clds() { return &_closures._clds; }
    CodeBlobClosure* strong_codeblobs() { return &_closures._codeblobs; }

    bool trace_metadata() { return false; }  // Normal Young GC 不追踪元数据
};
```

Normal Young GC 创建的就是 `G1EvacuationClosures`。`G1SharedClosures<G1MarkNone>` 模板实例化出三个闭包对象：`_oops`、`_clds`、`_codeblobs`。每个都在构造时收到 `pss` 指针——所以 `_oops.do_oop(ref)` 内部最终调用 `pss->push_on_queue(ref)`。

**从 pss 构造时创建，贯穿全文**

每个 Worker 的闭包是 `G1ParScanThreadState` 构造时创建的（g1ParScanThreadState.cpp:81）：

```cpp
_closures = G1EvacuationRootClosures::create_root_closures(this, _g1h);
```

`create_root_closures()`（g1RootClosures.cpp:100-112）检查 `collector_state()->in_initial_mark_gc()`：
- Normal Young GC → `new G1EvacuationClosures(...)`  → `trace_metadata()=false`，后面 Weak CLD / SATB 过滤会 skip
- InitialMark GC  → `new G1InitialMarkClosures<...>(...)` → `trace_metadata()=true`，触发 Weak CLD 两轮扫描 + SATB 过滤

这句话也就解释了 §3.5 `evacuate_roots` 代码里 `if (closures->trace_metadata())` 分支的执行条件——Normal Young GC 不走那条.

### 3.4 evacuate_roots 的调用顺序

**`_process_strong_tasks` 字段**负责驱动这 12 个子任务的分工：

**[`_process_strong_tasks`]** — `G1RootProcessor::SubTasksDone`, g1RootProcessor.hpp:51, 12 子任务声明管理器 —— 底层用 `SubTasksDone::_tasks[]` CAS 数组，协调 N 个 Worker 原子地认领 12 个 Root 扫描子任务（`G1RP_PS_*`）。每个 Worker 尝试 claim 未完成的任务，已被 claim 的跳过。`all_tasks_completed(n_workers)` 在结束时全复位，为下次 GC 重用。

```cpp
// g1RootProcessor.cpp:78-136
void G1RootProcessor::evacuate_roots(G1ParScanThreadState* pss, uint worker_i) {
    G1GCPhaseTimes* phase_times = _g1h->g1_policy()->phase_times();

    G1EvacPhaseTimesTracker timer(phase_times, pss, G1GCPhaseTimes::ExtRootScan, worker_i);

    G1EvacuationRootClosures* closures = pss->closures();

    // 1. Java 根：Universe, JNIHandles, ObjectSynchronizer, Management,
    //    SystemDictionary, ClassLoaderDataGraph, JVMTI, AOT
    process_java_roots(closures, phase_times, worker_i);

    // 如果 trace_metadata=true（InitialMark GC），通知已找到所有 strong CLD/nmethod，
    // 其他 Worker 可能还在等待这个信号
    if (closures->trace_metadata()) {
        worker_has_discovered_all_strong_classes();
    }

    // 2. VM 根：CodeCache
    process_vm_roots(closures, phase_times, worker_i);
    // 3. StringTable——intern 的字符串
    process_string_table_roots(closures, phase_times, worker_i);

    // 4. CM ref_processor roots——并发标记中发现的 Reference 对象
    {
        G1GCParPhaseTimesTracker x(phase_times, G1GCPhaseTimes::CMRefRoots, worker_i);
        if (!_process_strong_tasks.is_task_claimed(G1RP_PS_refProcessor_oops_do)) {
            _g1h->ref_processor_cm()->weak_oops_do(closures->strong_oops());
        }
    }

    // 5. Weak CLD 处理——需要所有 Worker 的 strong CLD 遍历完才能开始
    if (closures->trace_metadata()) {
        {
            G1GCParPhaseTimesTracker x(phase_times, G1GCPhaseTimes::WaitForStrongCLD, worker_i);
            wait_until_all_strong_classes_discovered();  // barrier：等所有 Worker 完成 strong CLD
        }
        G1GCParPhaseTimesTracker x(phase_times, G1GCPhaseTimes::WeakCLDRoots, worker_i);
        // strong_clds 的补集——在 strong 阶段漏掉的 weakness 通过弱引用处理
        ClassLoaderDataGraph::roots_cld_do(NULL, closures->second_pass_weak_clds());
    }

    // 6. SATB buffer filtering——并发标记期间需要过滤 thread-local SATB 缓冲中的 CSet 指针
    {
        G1GCParPhaseTimesTracker x(phase_times, G1GCPhaseTimes::SATBFiltering, worker_i);
        if (!_process_strong_tasks.is_task_claimed(G1RP_PS_filter_satb_buffers)
            && _g1h->collector_state()->mark_or_rebuild_in_progress()) {
            G1BarrierSet::satb_mark_queue_set().filter_thread_buffers();
        }
    }

    _process_strong_tasks.all_tasks_completed(n_workers());
}
```

上面 `evacuate_roots` 调了两个关键的内部方法——`process_java_roots` 和 `process_vm_roots`。它们才是 §3.2/§3.3 的 12 个子任务 + CAS claim 机制真正被执行的地方。

**process_java_roots —— ClassLoaderDataGraph + 所有 Java 线程栈**

```cpp
// g1RootProcessor.cpp:219-239
void G1RootProcessor::process_java_roots(G1RootClosures* closures,
                                         G1GCPhaseTimes* phase_times,
                                         uint worker_i) {
  // 1. ClassLoaderDataGraph——每个 CLD 持有一组 Klass/ConstantPool 里的 String 引用
  {
    G1GCParPhaseTimesTracker x(phase_times, G1GCPhaseTimes::CLDGRoots, worker_i);
    if (!_process_strong_tasks.is_task_claimed(G1RP_PS_ClassLoaderDataGraph_oops_do)) {
      ClassLoaderDataGraph::roots_cld_do(closures->strong_clds(), closures->weak_clds());
    }
  }

  // 2. 所有 Java 线程栈——栈帧里的局部变量表、操作数栈
  {
    G1GCParPhaseTimesTracker x(phase_times, G1GCPhaseTimes::ThreadRoots, worker_i);
    Threads::possibly_parallel_oops_do(n_workers() > 1,
                                       closures->strong_oops(),
                                       closures->strong_codeblobs());
  }
}
```

注意——**线程栈不是 12 个子任务之一**。`Threads::possibly_parallel_oops_do` 是 G1RootProcessor 内置的——它不从 `_process_strong_tasks` 抢单，而是所有 Worker 各扫自己分配到的线程。`possibly_parallel_oops_do` 内部按 Worker 编号均匀分配线程——有些线程被这个 Worker 扫，有些被那个扫。

**process_vm_roots —— 9 种根的 CAS claim 循环**

```cpp
// g1RootProcessor.cpp:241-298
void G1RootProcessor::process_vm_roots(G1RootClosures* closures,
                                       G1GCPhaseTimes* phase_times,
                                       uint worker_i) {
  OopClosure* strong_roots = closures->strong_oops();

  // 以下 6 个 block 完全一样的 pattern——只是调的类不同:
  // is_task_claimed(N) → false → 我是第一个 → 执行 oops_do(strong_roots)

  if (!_process_strong_tasks.is_task_claimed(G1RP_PS_Universe_oops_do)) {
      Universe::oops_do(strong_roots);
  }
  if (!_process_strong_tasks.is_task_claimed(G1RP_PS_JNIHandles_oops_do)) {
      JNIHandles::oops_do(strong_roots);
  }
  if (!_process_strong_tasks.is_task_claimed(G1RP_PS_ObjectSynchronizer_oops_do)) {
      ObjectSynchronizer::oops_do(strong_roots);
  }
  if (!_process_strong_tasks.is_task_claimed(G1RP_PS_Management_oops_do)) {
      Management::oops_do(strong_roots);
  }
  if (!_process_strong_tasks.is_task_claimed(G1RP_PS_jvmti_oops_do)) {
      JvmtiExport::oops_do(strong_roots);
  }
  if (!_process_strong_tasks.is_task_claimed(G1RP_PS_SystemDictionary_oops_do)) {
      SystemDictionary::oops_do(strong_roots);
  }
  // (AOT / CodeCache 的 claim 路径在另一处——此处省略以保持清晰)
}
```

**每一行 `Universe::oops_do(strong_roots)` 内部在做什么**——`Universe` 在遍历它持有的引用集合（比如 `java.lang.Class` 的 mirror 对象数组），对每个引用调一次 `strong_roots->do_oop(ref)`。而这个 `strong_roots` 就是 §3.4 讲的 `G1EvacuationClosures::strong_oops()` 返回的 `_closures._oops`——它的 `do_oop` 实现最终调用 `pss->push_on_queue(ref)`——把 ref 推进 Worker 的任务队列。

所以整条链是：`process_vm_roots` 用 `is_task_claimed` 抢到任务 →调用 `Universe::oops_do(strong_roots)` → `strong_roots->do_oop(ref)` → `pss->push_on_queue(ref)` → 引用进入 Worker 的 `_refs` 队列 → 等待 §5 的 `trim_queue` 消费。

### 3.5 找到 CSet 内的对象后——copy_to_survivor_space()

每种 Root 扫描后的引用最终都通过 `G1EvacuationRootClosures::strong_oops()` 的闭包链传递——经过 `G1ParScanThreadState::push_on_queue()` → `deal_with_reference()` → 最终到达 `copy_to_survivor_space()`（g1ParScanThreadState.cpp:214）。但在看搬运细节之前，先理解一个更根本的问题。

#### 3.5.1 搬运的核心难题——多个引用指向同一个对象

搬一个对象很简单：找到目标 Region → 分配空间 → `memcpy` 过去 → 更新指向它的引用。

但现实中，**同一个 CSet 对象可能被多条引用同时指向**。看这个场景：

```
  ref1 ──────┐
              ↓
             [A]  ← 在 CSet 中
              ↑
  ref2 ──────┘

ref1 和 ref2 是两个不同的引用，但都指向同一个 Eden 对象 A。
ref1 可能存放在某个 old Region 的对象的字段里,
ref2 可能存放在某个静态字段里。
```

GC 期间，**两条引用可能被同一个 Worker 先后遇到，也可能被不同的 Worker 同时遇到**。关键问题是：

- 第一条引用遇到 A 时：A 还没搬 → 搬走它 → A → A'
- 第二条引用遇到 A 时：A 已经搬走了 → 不能再次复制（A' 只需要一份），但**必须知道 A 搬到哪里去了，才能更新自己的引用指向 A'**

HotSpot 的解决方案是 **forwarding pointer**（转发指针）——搬完 A 之后，在 A 的**旧地址**的 mark word 里写入新地址 A'，作为下次遇到 A 时的"路标"。

```
搬之前:
  A 的 mark_word: [hash|age|lock_bits=01]   ← 正常 Java 对象头
  ref1 → A, ref2 → A

搬之后:
  A 的 mark_word: [____________|11]   ← lock_bits=11, 其余 62 位 = A' 的地址
  A' 在新位置 (Survivor 或 Old Region)
  ref1 → A', ref2 → A → 读 mark_word → 路径修正 → A'
```

后续任何引用再遇到 A 时——检查 mark word 低 2 位：如果是 `11`，说明 A 已经被搬过了，剩余 62 位就是 forwarding pointer，直接读取新地址、更新引用——不再重复搬运。

#### 3.5.2 forwarding pointer 怎么编码的

forwarding pointer 存储在 Java 对象头的 **mark word**（`markOop`）中。mark word 的低 3 位原本用于锁状态编码（01=无锁、00=轻量锁、10=重量锁、11=GC 标记）。GC 期间重用了 `11` 这个编码：

```cpp
// markOop.hpp:325, 356
markOop set_marked() {
    return markOop((value() & ~lock_mask_in_place) | marked_value);
    // ~lock_mask_in_place → 清除最低 2 位（lock_mask_in_place=3=0b11）
    // | marked_value      → 设最低 2 位为 marked_value=3=0b11
    // 结果：低 2 位 = 11，高位保持原 new_addr 的地址位
}

inline static markOop encode_pointer_as_mark(void* p) {
    return markOop(p)->set_marked();
    // 把 A' 的地址当作普通指针，低 2 位恰好为 00（对象对齐保证）
    // 然后调用 set_marked() 把低 2 位改为 11
    // 后续 decode_pointer() = value & ~lock_mask_in_place → 恢复 A'
}
```

**为什么是安全的**——所有 Java 对象在堆上都是 8 字节对齐的（64 位 JVM），地址的最低 3 位天然为 0。所以把低 2 位覆盖为 `11` 不会丢失高位地址信息——复原时只要 `& ~0b11` 就恢复原地址。

#### 3.5.3 搬运全过程

理解了 forwarding pointer 之后，完整的搬运流程（`copy_to_survivor_space()` 核心逻辑）如下：

```
读到引用 ref → ref 指向对象 A

  1. A 不在 CSet?
     → 不管——A 不需要搬

  2. A 在 CSet 中?  检查 A.mark_word:
     → 低 2 位 = 11 (marked_value = 3)?
        YES → A 已经被搬过了 → 读 forwarding pointer → 解码得 A' → 更新 ref
        NO  → A 还没搬 →
              a. 在 Survivor 或 Old Region 中分配目标空间
              b. memcpy A → 新地址 A'
              c. 在 A.mark_word 中写入 forwarding pointer: encode_pointer_as_mark(A')
              d. 把 A 的旧地址压入 Worker 的本地任务队列 (RefToScanQueue)
                 —— 后续 §5 会追踪 A 的引用字段
              e. 更新 ref → A'
```

步骤 (a) 的**目标空间分配**用的是 PLAB（Parallel Local Allocation Buffer）。为什么需要 PLAB？N 个 GC Worker 在并发搬运数以万计的对象——如果每个对象的分配都去抢全局堆锁，那就成了单线程瓶颈。PLAB 和 TLAB 是同一种思想——每个 Worker 提前在自己的 `pss->_plab_allocator` 中申请一小段 Survivor/Old Region 的内存块，在自己的 PLAB 里用 **bump-pointer**（只需 `_top += obj_size`）分配，**完全无锁**。PLAB 用完了再批量向全局堆申请新块——锁的开销被分摊到 N 次 bump-pointer 分配上（08-03 将展开 PLAB 的完整细节：如何申请新块、如何回收、waste 统计等）。

**[`RefToScanQueue`]** — typedef `OverflowTaskQueue<StarTask, mtGC>`, g1CollectedHeap.hpp:98, 带溢出栈的工作窃取任务队列 —— 元素 `StarTask` 可以是 `oop*`（64 位）或 `narrowOop*`（32 位压缩指针），由 `UseCompressedOops` 决定。队列满时新任务溢出到 overflow stack，防止深层对象图遍历时阻塞 push。Worker push 刚搬完的对象引用（本步骤 d），pop 来追踪其引用字段（§5.2 `trim_queue()`），空 Worker 从别人的 steal（§5.3）。

#### 3.5.4 真实源码——do_oop_evac

上面的伪代码流程对应了 `do_oop_evac()` 的实际实现——从 §3.6 开头提到的调用链 `push_on_queue → deal_with_reference → do_oop_evac → copy_to_survivor_space` 来看，`do_oop_evac` 是搬运决策的真正入口：

```cpp
// g1ParScanThreadState.inline.hpp:33-59
template <class T> void G1ParScanThreadState::do_oop_evac(T* p) {
  // 1. 加载 p 指向的对象
  oop obj = RawAccess<IS_NOT_NULL>::oop_load(p);

  // 2. 判断 obj 的状态——在 CSet 里吗?
  const InCSetState in_cset_state = _g1h->in_cset_state(obj);
  if (in_cset_state.is_in_cset()) {
    // 3. 读 obj 的 mark word——已经被打上 forwarding pointer 了吗?
    markOop m = obj->mark_raw();
    if (m->is_marked()) {
      // 3a. YES —— 取 forwarding pointer, 更新引用
      obj = (oop) m->decode_pointer();
    } else {
      // 3b. NO  —— 搬! 在 Survivor/Old 中分配、memcpy、写 forward pointer
      obj = copy_to_survivor_space(in_cset_state, obj, m);
    }
    // 4. 更新 p 指向新地址 (obj 可能被搬到了新位置)
    RawAccess<IS_NOT_NULL>::oop_store(p, obj);

  } else if (in_cset_state.is_humongous()) {
    _g1h->set_humongous_is_live(obj);
  }

  // 5. 写屏障——如果新位置需要标记 card, 入 _dcq
  write_ref_field_post(p, obj);
}
```

**和 §3.6.3 伪代码的对应**：
- 伪代码步骤 1（不在 CSet?）→ `if (!is_in_cset())`——走 `else if (humongous)` 或直接跳过
- 伪代码步骤 2（mark word 低 2 位=11?）→ `m->is_marked()`——检查 forwarding pointer
- YES 分支 → `m->decode_pointer()`——读新地址、更新 `p` 指向它
- NO 分支 → `copy_to_survivor_space(...)`——执行步骤 a-e 的全部逻辑（分配/拷贝/写 forward pointer/入队）

**完整调用链回顾**——现在从根扫描到搬运完毕整条链串联起来了：

```
Root (Universe / JNIHandles / ...)
  └─ oops_do(strong_roots)
      └─ strong_roots->do_oop(ref)              // §3.4 闭包模式
          └─ pss->push_on_queue(ref)            // §3.4 闭包的 do_oop 直接入队
              └─ _refs->push(ref)                // 入 Worker 队列

... 所有 Root 扫完后, trim_queue 开始消费队列 (§5):

  └─ trim_queue → pop → dispatch_reference
      └─ deal_with_reference → do_oop_evac(p)   // §3.6.4 搬或跟 forward pointer
          └─ copy_to_survivor_space(state, obj, m)  // §3.6.3 真正搬
          └─ _refs->push(new_ref)               // 搬完后新引用的目标可能也在 CSet → 再入队
```

这就是 §2 说的 "Worker 内部串行, A→B→C" 的原因——A 和 B 阶段通过闭包一直往 `_refs` 里塞引用，C 阶段才从 `_refs` 消费。生产和消费分离——A/B 是生产者、C 是消费者。

---

## 4. 阶段 B: RSet 扫描——找到来自 old Region 的引用

### 4.1 为什么 Root 扫描不够

Root 扫描（§3）覆盖了从 JVM 根出发的所有引用链。但还有一个巨大的盲区——**CSet Region 可能被不在 CSet 中的 old/humongous Region 引用**。

例如：一个 old Region 里的对象持有一个数组引用，这个数组在某个 eden Region 中。**old Region 不是 GC Root——Root 扫描根本不会进入 old Region 内部遍历它的字段。** 如果不通过 RSet 来补充——这个 eden Region 里的数组会被误判为 "没有引用指向它"——被错误回收。

### 4.2 RSet 怎么解决

每个 Region 的 RSet 记录了 "谁引用了我的哪个 card"（ch10/06）。扫描 CSet Region 的 RSet = **反向查找所有入引用**。

```cpp
// g1RemSet.cpp:506-508
void G1RemSet::oops_into_collection_set_do(G1ParScanThreadState* pss, uint worker_i) {
    update_rem_set(pss, worker_i);    // 先处理残存的 dirty card
    scan_rem_set(pss, worker_i);      // 再扫描 RSet
}
```

**`update_rem_set()`**——refinement 线程在 GC 之间一直在处理 dirty card、更新 RSet。但 GC 开始时 refinement 线程停了——可能还有一批 dirty card 已经在队列里但还没处理完。`update_rem_set()` 把所有积压的 dirty card 处理掉，确保 RSet 是最新的。

**`scan_rem_set()`**——遍历 CSet 中每个 Region 的 RSet。Worker 通过 `_iter_claims`（原子操作抢 card block）做并行分工。每个 card 被扫描时——这个 card 在 old Region 中的位置被用来查找这个 card 覆盖范围内是否有指向 CSet Region 的引用。如果找到了——交给 `G1ParScanThreadState::copy_to_survivor_space()`（与 §3.6 相同的搬运逻辑）。

**`_scan_top[i]` 的作用**——§1 里的 `_scan_state->reset()` 为每个 old/humongous Region 设了扫描上限。card 扫描从 card 0 开始，到 `_scan_top[i]` 对应的 card 停止——超过这个上限的空间还没分配对象，不用扫。

### 4.3 RSet 扫描和 Root 扫描共享同一个搬运逻辑

虽然 Root 扫描和 RSet 扫描的**数据来源不同**（Root 来自 JVM 内部结构，RSet 来自 card table 扫描），但它们的**落脚点完全相同**——找到指向 CSet 内对象的引用 → 调用 `G1ParScanThreadState::copy_to_survivor_space()` → 搬。

---

## 5. 阶段 C: 工作窃取——追踪到底

### 5.1 问题的来源

阶段 A 和 B 找到了 "被根或 old Region 直接引用到的 CSet 对象" 并搬走了它们。但这个被搬走对象的**引用字段**还指向别的对象——那些对象可能也在 CSet 中，也需要被搬。

例子：

```
Root → A（在 CSet, 被搬了）
       A.field1 → B（在 CSet, 还没搬, 因为没有任何 Root 直接引用 B）
       A.field2 → C（不在 CSet, 已经安全）
```

A 被搬走后，Worker 把 A 压入了自己的本地队列——表示 "A 的引用字段还需要被追踪"。阶段 C 就是不断消费这个队列——直到所有链条穷尽。

### 5.2 工作窃取队列——push/pop/steal 的约定

在进入代码之前，先理解 `RefToScanQueue`（即 `OverflowTaskQueue<StarTask>`）的访问约定。这是一个**双端队列**（deque），不同角色从不同端访问：

```
            steal (顶端)                      push/pop (底端)
       ←───────────────┐                ┌─────────────────
   [oldest] [ ... ] [ ... ] [newest]    [overflow stack]
       ← 别人偷走的最旧元素       Worker 自己 push/pop 最新元素
```

- **本地 Worker push/pop** ——从队列**底端**（deque bottom）。push 把新引用放到底端，pop 从底端取——所以本地操作是 **LIFO**（后进先出），即偷走最旧的大块任务给窃取者，自己继续处理最新产生的引用（缓存更友好）
- **空闲 Worker steal** ——从队列**顶端**（deque top）。偷走的是**最旧**的引用——这些是"积压最久"的任务，通常是较大块的作业
- **overflow stack** ——主队列有容量上限（`_stack_trim_upper_threshold`）。如果主队列满了，新 push 的任务会**溢出到 overflow stack**。trim 时先从 overflow stack 取，再从主队列取——保证"不丢任务、不阻塞 push"

为什么 trim 到**阈值**（`_stack_trim_lower_threshold`）而不是全部排空？如果每个 Worker 都把自己的队列排得一干二净——空闲 Worker 就没东西可偷了，只能等终止。留下一些任务在队列里充当 **"鱼饵"**，空闲 Worker 通过 steal 抓到任务后重新忙起来——避免"一个 Worker 干完了闲着，其他 Worker 还有很多活却偷不到"的死局。

理解了队列机制后，看实际代码：

```cpp
// g1CollectedHeap.cpp:3157-3163
void G1ParEvacuateFollowersClosure::do_void() {
    G1ParScanThreadState* const pss = par_scan_state();

    pss->trim_queue();                   // 第一步：排空自己的队列
    do {
        pss->steal_and_trim_queue(queues());  // 从别人的队列偷活、继续排空
    } while (!offer_termination());           // 直到全局无活可干
}
```

`trim_queue()`（g1ParScanThreadState.inline.hpp:159-191）的内部逻辑：
1. 先从队列的 overflow stack 里取——这些是 "任务队列满时溢出的"
2. 再从主队列里取
3. 拿出来的是一个引用 → `copy_to_survivor_space()` 按 §3.5 的 forwarding pointer 逻辑处理 → 搬 → 被搬对象的引用字段可能产生新的引用 → push 回队列
4. 继续，直到队列低于下限阈值（`_stack_trim_lower_threshold`）

### 5.3 工作窃取——从别人那偷

`steal_and_trim_queue()`（g1ParScanThreadState.inline.hpp:146-157）：
```cpp
void G1ParScanThreadState::steal_and_trim_queue(RefToScanQueueSet *task_queues) {
    StarTask stolen_task;
    while (task_queues->steal(_worker_id, &_hash_seed, stolen_task)) {
        dispatch_reference(stolen_task);    // 处理偷到的作业
        trim_queue();                        // 可能产生了新的引用——排空
    }
}
```

`steal_best_of_2()`（taskqueue.inline.hpp:235-255）——每次随机选两个 Worker 的队列，"偷其中更好的那个"（队列更长、更有料）。

### 5.4 终止协议——什么时候全体收工

`offer_termination()` 使用 `ParallelTaskTerminator`：

1. 一个 Worker 自己的队列空了 + 偷了所有其他队列也是空 → 调 `offer_termination()` 进入 "等待退休" 状态
2. 其他 Worker 还在干活 → 退休状态自动解除 → 继续偷活
3. 所有 Worker 都进入退休状态 → 全局终止

这是经典的 "松耦合终止"——不是 "指挥说停大家一起停"，而是"每个 Worker 自己决定没活儿了才退休，退休了还能反悔"。

### 5.5 为什么需要工作窃取——引用图遍历的必然

Root 扫描和 RSet 扫描只覆盖了 **Level 1 的引用**（从根或 old Region 直接引用到的 CSet 对象）。但对象图是一个多层有向图——A 引用 B → B 引用 C → C 引用 D——Level 1 搬了不等于 Level 2/3/N 都搬了。

工作窃取保证了这个图遍历不会在任何一层中断——只要有 Worker 的队列里还有引用，就一定被处理；只要别的 Worker 有活儿，空了的 Worker 就去偷。逐层扩散，直到整棵引用树遍历完。注意：`OverflowTaskQueue` 的本地 push/pop 是 LIFO（DFS-like），但 steal 从队尾取最旧元素（FIFO-like），实际遍历顺序是混合的——既不是严格 BFS 也不是严格 DFS，但保证不遗漏任何节点。

---

## 6. G1ParScanThreadState——每个 Worker 的工具箱

每个 GC Worker 持有自己的 `G1ParScanThreadState`（g1ParScanThreadState.hpp:45）——承载了该 Worker 在 evacuation 期间的所有上下文：

```cpp
// g1ParScanThreadState.hpp:45-77
class G1ParScanThreadState : public CHeapObj<mtGC> {
    G1CollectedHeap* _g1h;                       // G1 堆实例
    RefToScanQueue*  _refs;                       // Worker 任务队列
    DirtyCardQueue   _dcq;                        // 脏卡队列
    G1CardTable*     _ct;                         // Card table 指针
    G1EvacuationRootClosures* _closures;          // Root 扫描闭包集
    G1PLABAllocator*  _plab_allocator;            // PLAB 分配器
    AgeTable          _age_table;                  // 年龄统计表
    InCSetState       _dest[InCSetState::Num];    // 对象去向映射（Young→Old, Old→Old）
    uint              _tenuring_threshold;         // 晋升年龄阈值
    G1ScanEvacuatedObjClosure  _scanner;           // 扫描已被搬对象引用字段的闭包
    int  _hash_seed;                               // steal 用随机种子
    uint _worker_id;                               // Worker 编号
    uint const _stack_trim_upper_threshold;         // 队列 drain 上限（=2*GCDrainStackTargetSize+1）
    uint const _stack_trim_lower_threshold;         // 队列 drain 下限（=GCDrainStackTargetSize）
    Tickspan _trim_ticks;                          // trim 耗时记录
    size_t* _surviving_young_words_base;            // 存活字数数组基址（含 PADDING）
    size_t* _surviving_young_words;                 // 存活字数指针（偏移 PADDING_ELEM_NUM 后）
    bool _old_gen_is_full;                          // Old Gen 是否已满——影响晋升策略
};
```

**核心字段解释**（按在源代码中的声明顺序）：

**[`_refs`]** — `G1ParScanThreadState::RefToScanQueue*`, g1ParScanThreadState.hpp:47, per-worker 任务队列 —— 该 Worker 的本地工作窃取队列。Worker 把刚搬完的对象引用 push 进去（§3.6 步骤 d），pop 出来追踪其引用字段（§5.2 `trim_queue()`），空 Worker 从别的 Worker 偷活（§5.3 `steal_and_trim_queue()`）。是整个 evacuation 引用图遍历的"活水源头"——有活儿就干、没活儿就偷。

**[`_plab_allocator`]** — `G1ParScanThreadState::G1PLABAllocator*`, g1ParScanThreadState.hpp:52, per-worker PLAB 分配器 —— 在 Survivor/Old Region 中为搬来的对象无锁分配空间。`G1PLABAllocator` 内部为每个目标代（Survivor 和 Old）维护独立的 `PLAB` 缓冲区，Worker 从自己的 PLAB bump-pointer 分配，用完再向全局堆申请新 Region 块，避免多 Worker 竞争全局堆锁。下一篇 08-03 展开 PLAB 细节。

**[`_age_table`]** — `G1ParScanThreadState::AgeTable`, g1ParScanThreadState.hpp:54, per-worker 年龄追踪表 —— 记录本 Worker 搬了多少字节到 Survivor 的各年龄层（0-15）。每搬一个对象调用 `AgeTable::add(obj, age, obj_size)`——在该 age 的 size 计数器上 +obj_size。GC 结束时所有 Worker 的 `_age_table` 合并到全局 `_surviving_young_words`（在 `G1Policy`），用于计算下一个 `_tenuring_threshold`。

**[`_tenuring_threshold`]** — `G1ParScanThreadState::uint`, g1ParScanThreadState.hpp:57, 晋升阈值 —— `age >= 此值` 的对象直接晋升到 Old（不复制到 Survivor）。值由 `G1Policy::compute_survivor_next_tenuring_threshold()` 基于 survivor space 占比在每次 GC 结束时重新计算（08-03 详述），Worker 初始化时从 `G1Policy` 读入当前值，在 `next_state()` 的对象去向决策中使用。

**[`_closures`]** — `G1ParScanThreadState::G1EvacuationRootClosures*`, g1ParScanThreadState.hpp:50, Root 扫描闭包集 —— `G1EvacuationRootClosures` 打包了三类闭包：`strong_oops()`（处理强引用 Root，最终调 `G1ParScanThreadState::copy_to_survivor_space()` 执行搬运）、`weak_oops()`（处理弱引用 Root）、`code_oops()`（处理 CodeCache）。传递给 `G1RootProcessor::evacuate_roots()`（§3.4），每种 Root 类型（`G1RP_PS_*`）用对应的闭包。Worker 初始化时从全局 `closures()` 拿到一份。

**[`_dcq`]** — `G1ParScanThreadState::DirtyCardQueue`, g1ParScanThreadState.hpp:55, 脏卡队列 —— Worker 扫描引用字段时如果更新了 card table（产生 dirty card），不直接更新 RSet，而是放入此队列。等 GC 收尾阶段（Post-Evacuation）通过 `flush_dirty_card_queues()` 批量处理，避免 RSet 更新与并行扫描冲突。

**[`_dest`]** — `G1ParScanThreadState::InCSetState[_dest[Num]]`, g1ParScanThreadState.hpp:55, 对象去向映射表 —— 一个三元素数组，定义每个 CSet 状态的对象搬到哪里。Worker 初始化时写入（g1ParScanThreadState.cpp:75-79）：`_dest[NotInCSet]=NotInCSet`（不在 CSet 就不搬）、`_dest[Young]=Old`（Young 对象 age>=threshold 时进 Old）、`_dest[Old]=Old`（Old 对象永远留在 Old）。由 `next_state()` 在决定对象去向时读取。

**[`_scanner`]** — `G1ParScanThreadState::G1ScanEvacuatedObjClosure`, g1ParScanThreadState.hpp:58, 扫描已搬完对象引用字段的闭包 —— 当一个对象被搬走后，它的引用字段可能指向其他在 CSet 中的对象。`_scanner`（类型 `G1ScanEvacuatedObjClosure`）遍历被搬对象的每个 oop 字段，把指向 CSet 的引用 push 进 `_refs` 队列，驱动 §5 的工作窃取引用图遍历。

**[`_surviving_young_words`]** — `G1ParScanThreadState::size_t*`, g1ParScanThreadState.hpp:72, 每 Region 存活字数统计 —— 一个动态分配的数组（长度 = 1 + young_cset_length），按 region index 记录搬完的对象总字数。GC 结束时所有 Worker 的数组合并到全局 `_surviving_young_words`（在 `G1Policy`），用于计算下一次 GC 的 `_tenuring_threshold` 和 Young 代大小。


---

## 附录: 本文涉及的字段速查

| 字段 | 所在类 | 类型 | 源码位置 | 用途 |
|------|--------|------|---------|------|
| `_refs` | `G1ParScanThreadState` | `RefToScanQueue*` | g1ParScanThreadState.hpp:47 | Worker 的本地任务队列——push/pop/steal 的载体 |
| `_dcq` | `G1ParScanThreadState` | `DirtyCardQueue` | g1ParScanThreadState.hpp:48 | 脏卡队列——推迟 RSet 更新，收尾阶段批量处理 |
| `_closures` | `G1ParScanThreadState` | `G1EvacuationRootClosures*` | g1ParScanThreadState.hpp:50 | Root 遍历所需的所有闭包集合 |
| `_plab_allocator` | `G1ParScanThreadState` | `G1PLABAllocator*` | g1ParScanThreadState.hpp:52 | PLAB 分配器——在 Survivor/Old Region 中为搬来的对象分配空间 |
| `_age_table` | `G1ParScanThreadState` | `AgeTable` | g1ParScanThreadState.hpp:54 | 本地对象年龄表——驱动晋升阈值计算 |
| `_dest` | `G1ParScanThreadState` | `InCSetState[Num]` | g1ParScanThreadState.hpp:55 | 对象去向映射表——Young→Old, Old→Old, NotInCSet→NotInCSet |
| `_tenuring_threshold` | `G1ParScanThreadState` | `uint` | g1ParScanThreadState.hpp:57 | 当前晋升阈值——age >= 此值的对象晋升到 Old |
| `_scanner` | `G1ParScanThreadState` | `G1ScanEvacuatedObjClosure` | g1ParScanThreadState.hpp:58 | 扫描已搬完对象的引用字段闭包——驱动工作窃取图遍历 |
| `_surviving_young_words` | `G1ParScanThreadState` | `size_t*` | g1ParScanThreadState.hpp:72 | 每 Region 存活字数统计——GC 结束合并到 G1Policy |
| `_process_strong_tasks` | `G1RootProcessor` | `SubTasksDone` | g1RootProcessor.hpp:51 | 12 个强根扫描子任务的任务声明管理器 |
| `_tasks` | `SubTasksDone` | `uint*` | workgroup.cpp:427 | 任务声明数组——每个元素 0=未声明，通过 CAS 抢 |
| `RefToScanQueue` | (typedef) | `OverflowTaskQueue<StarTask, mtGC>` | g1CollectedHeap.hpp:98 | 带溢出栈的工作窃取队列——StarTask 可以是 oop* 或 narrowOop* |
