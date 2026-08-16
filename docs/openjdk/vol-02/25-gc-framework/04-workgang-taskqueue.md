# 04. 4 个 GC worker 怎么平分扫描任务？— WorkGang + TaskQueue

> **前置依赖**:[25-gc-framework/03 — SoftReference 什么时候被清除？— Reference Processing](openjdk/vol-02/25-gc-framework/03-reference-processing.md):RefProcPhase1-4Task 是本节 TaskQueue/WorkGang 的第一批消费者;[25-gc-framework/01 — GC 怎么在每次 oop 访问时悄悄插入 barrier？— BarrierSet + Access API](openjdk/vol-02/25-gc-framework/01-barrier-access.md):gc+phases 的 "Workers: N" 实证同源;[17-threads/01 — JVM 里有多少种线程?— Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):GangWorker 是 NonJavaThread
> → **后续**:[25-gc-framework/05 — 一次赋值在 GC 眼里怎么变成"脏卡片"？— CardTable + DirtyCardQueue](openjdk/vol-02/25-gc-framework/05-cardtable-dirtycardq.md)
> 关联域: 25-03(引用处理并行)、17-threads(worker 线程)、20-vm-operations(VM 线程派发)

## 一台没有锁的"任务天平"

G1 的一次年轻代 GC,扫描任务被 N 个 worker 平分。难的不是"平分",而是**空闲 worker 怎么找活干**:自己的任务做完了,别人的还没做完——去别人那里"偷"。如果偷的过程要全局锁,并行就退化成排队。GC 的答案藏在两个类里: `GenericTaskQueue`(无锁双端队列)与 `WorkGang`(worker 调度骨架)。

## 1. GenericTaskQueue — ABP 无锁工作窃取

队列是**每个 worker 一个**,存的是任务指针(比如待扫描的 oop 或 region 序号)。JDK11 注释自称实现的是 **ABP 算法**(Aurora-Blumofe-Plaxton,taskqueue.hpp:222-229): "an ABP, Aurora-Blumofe-Plaxton, double-ended-queue (deque), intended for use in work stealing. Queue operations are non-blocking"——owner 线程在**一端**(底部)push/pop_local,其他线程在**另一端**(顶部)pop_global 偷。

核心状态是双指针 + 一个防 ABA 的年龄:

```cpp
// taskqueue.hpp:111-153(截取核心,逐字)
  // Internal type for indexing the queue; also used for the tag.
  typedef NOT_LP64(uint16_t) LP64_ONLY(uint32_t) idx_t;
  ...
  class Age {
  public:
    Age(size_t data = 0)         { _data = data; }
    ...
    // Increment top; if it wraps, increment tag also.
    void increment() {
      _fields._top = increment_index(_fields._top);
      if (_fields._top == 0) ++_fields._tag;
    }

    Age cmpxchg(const Age new_age, const Age old_age) volatile;
    ...
  private:
    struct fields {
      idx_t _top;
      idx_t _tag;
    };
    union {
      size_t _data;
      fields _fields;
    };
  };

  // The first free element after the last one pushed (mod N).
  volatile uint _bottom;
  // Add paddings to reduce false-sharing cache contention between _bottom and _age
  DEFINE_PAD_MINUS_SIZE(0, DEFAULT_CACHE_LINE_SIZE, sizeof(uint));
  volatile Age _age;
```

*关键设计: **两个端点,两种并发模型**。`_bottom` 只有 owner 写(volatile,不原子),`_age` 是 thief 与 owner 竞争时的仲裁者——`Age` 在 LP64 下是 64 位打包(`top` 32 位 + `tag` 32 位),`top` 每被偷一个任务递增,`tag` 在 top 回绕时递增(:128-132,队列变空或环形 wrap)——这就是 ABA 防护: 队列空→push→空,top 回到原值但 tag 已变,陈旧的 CAS 必然失败。`_bottom` 与 `_age` 之间还垫了缓存行(注释 "reduce false-sharing cache contention",:151-152),两个热点不共享一个缓存行。*

### 三个操作

**push**(taskqueue.inline.hpp:78-98): 写 `_elems[localBot]` → `release_store(&_bottom, localBot+1)`——owner 独写,无锁。队列满时 OverflowTaskQueue 用独立 overflow stack 兜底(:100-108)。

**pop_local**(taskqueue.inline.hpp:154-194)——owner 取底:

```cpp
// taskqueue.inline.hpp:155-194(截取核心,逐字)
GenericTaskQueue<E, F, N>::pop_local(volatile E& t, uint threshold) {
  uint localBot = _bottom;
  uint dirty_n_elems = dirty_size(localBot, _age.top());
  ...
  if (dirty_n_elems <= threshold) return false;
  localBot = decrement_index(localBot);
  _bottom = localBot;
  // This is necessary to prevent any read below from being reordered
  // before the store just above.
  OrderAccess::fence();
  ...
  (void) const_cast<E&>(t = _elems[localBot]);
  // This is a second read of "age"; the "size()" above is the first.
  idx_t tp = _age.top();    // XXX
  if (size(localBot, tp) > 0) {
    ...
    return true;
  } else {
    // Otherwise, the queue contained exactly one element; we take the slow
    // path.
    ...
    return pop_local_slow(localBot, _age.get());
  }
}
```

*关键设计: 正常路径 owner 自减 `_bottom` 即取走任务,零竞争;只有**最后一个元素**才可能和 thief 撞车——`pop_local_slow`(inline.hpp:122-152)用 `Age(localBot, oldAge.tag()+1)` 与 thief 的 `pop_global` 竞争 CAS,赢家拿走元素,输家把空队列表示修正为规范形态(:149,"Fix this representation of the empty queue to become the canonical one")。*

**pop_global**(taskqueue.inline.hpp:204-233)——thief 偷顶: `load_acquire(_bottom)`(:213)→ 队列空返回 → 读 `_elems[oldAge.top()]`(:224)→ `newAge.increment()`(top+1)→ **`_age.cmpxchg(newAge, oldAge)`**(:227)——CAS 成功才真正"偷到"。一次只偷一个。多个 thief 抢同一元素,只有一个 CAS 成功。**偷哪个队列**由 `GenericTaskQueueSet::steal_best_of_2`(:235-241)决定: 随机挑两个受害者队列各试一次——比全局轮询少冲突。

## 2. WorkGang — worker 的调度骨架

`AbstractWorkGang`(workgroup.hpp:109-201)持有 worker 数组与两个计数: `_total_workers`(可用上限)与 `_active_workers`(本次任务实际用多少;**UseDynamicNumberOfGCThreads=true 时初始只有 1,按任务量动态上调**,:137/:163-171)。`GangWorker` 是实际线程(workgroup.cpp:309-322): `run()` = `initialize()`(设 **NearMaxPriority**)+ `loop()`——每个 worker 是常驻线程,循环等任务。

派发机制(JDK11 默认)是 `SemaphoreGangTaskDispatcher`(workgroup.cpp:124-192,注释 :120-123 "Semaphores don't require the worker threads to re-claim the lock when they wake up...lowering the latency"):

```cpp
// workgroup.cpp:150-191(截取核心,逐字)
  void coordinator_execute_on_workers(AbstractGangTask* task, uint num_workers, bool add_foreground_work) {
    // No workers are allowed to read the state variables until they have been signaled.
    _task         = task;
    _not_finished = num_workers;

    // Dispatch 'num_workers' number of tasks.
    _start_semaphore->signal(num_workers);

    run_foreground_task_if_needed(task, num_workers, add_foreground_work);

    // Wait for the last worker to signal the coordinator.
    _end_semaphore->wait();
    ...
  }

  WorkData worker_wait_for_task() {
    // Wait for the coordinator to dispatch a task.
    _start_semaphore->wait();

    uint num_started = Atomic::add(1u, &_started);

    // Subtract one to get a zero-indexed worker id.
    uint worker_id = num_started - 1;

    return WorkData(_task, worker_id);
  }

  void worker_done_with_task() {
    // Mark that the worker is done with the task.
    // The worker is not allowed to read the state variables after this line.
    uint not_finished = Atomic::sub(1u, &_not_finished);

    // The last worker signals to the coordinator that all work is completed.
    if (not_finished == 0) {
      _end_semaphore->signal();
    }
  }
```

*关键设计: **同步派发,两个信号量**。coordinator(`run_task` :288-302)信号 `num_workers` 次启动信号 → worker 被唤醒后原子计数拿自己的 `worker_id`(:174-177,`task->work(worker_id)` 就是每个 worker 的分片编号)→ 干完 `worker_done_with_task` 原子递减 `_not_finished` → **最后一个人发结束信号** → coordinator 的 `_end_semaphore->wait()` 返回。于是 `run_task` 是同步的: 返回 = 所有 worker 完成。另有 Monitor 版 `MutexGangTaskDispatcher`(:194+,为不需要信号量的平台/场景备选)。*

**[实证](materials/commands/25-gc-workgang-demo.txt)**: `ParallelGCThreads=23` 是**上限**不是实际并发——`UseDynamicNumberOfGCThreads=true` 时小 GC 只用 2 个 worker(gc+phases 的 `Workers: 2`,素材 B);线程转储里 `GC Thread#0`/`G1 Conc#0` 懒创建(素材 C);`gc+task`/`gc+workgang` 标签可用。

## 3. 谁在消费 — 引用处理与扫描任务

25-03 的引用处理就是第一波消费者: `RefProcPhase1Task/2Task/3Task/4Task`(referenceProcessor.cpp:529-630)通过 `AbstractRefProcTaskExecutor::execute(task, nqueues)` 派发——**discovered 列表按 `_max_num_queues` 分槽,每个 worker 处理自己的槽**(25-03 篇的四列表分槽),`maybe_balance_queues`(:816)在槽间搬引用保持负载均衡。G1 的年轻代扫描(`G1ParScanThreadState`)、并发标记的根扫描也挂在 WorkGang 上——"Workers: N" 的 gc+phases 阶段树(G1UpdateRS/G1ScanRS 等)全部是 `AbstractGangTask` 派发的产物。

## 核心悬念

并行骨架到齐: **ABP 无锁队列**(`_bottom` owner 独写、`_age` CAS 仲裁、tag 防 ABA、偷顶不偷底)、**WorkGang 同步派发**(信号量启动/结束,worker 拿 id 分片)、**动态 worker 数**(上限 ParallelGCThreads,实际按任务量)。任务分发解决了"谁扫哪片"——但扫描过程中**对象图的变化**怎么被记录?一次 `obj.field = val` 在 GC 眼里变成什么?上一篇讲过 barrier 写卡标记,现在轮到卡片本身: 512 字节的卡怎么被标记、怎么被批量收集成 DirtyCardQueue、GC 又怎么消费。

> → [25-gc-framework/05 — 一次赋值在 GC 眼里怎么变成"脏卡片"？— CardTable + DirtyCardQueue](openjdk/vol-02/25-gc-framework/05-cardtable-dirtycardq.md)
