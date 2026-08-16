# 04. 4 个 GC worker 怎么平分扫描任务？— WorkGang + TaskQueue

> 🔴 Deep | 5 KP 中的并行基础设施
> 读者处境: G1 并行标记阶段——4 个 GC worker 平分整个 heap 的 oop 扫描。怎么分配任务不用锁？worker 1 做完了任务、worker 2 还在忙——worker 1 可以去 worker 2 那里"偷"任务。

### 1. "Arora 无锁工作窃取队列"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/04 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"Arora 算法" 名**: JDK11 注释自称 **ABP(Aurora-Blumofe-Plaxton)**(taskqueue.hpp:222-229 "implements an ABP, Aurora-Blumofe-Plaxton, double-ended-queue (deque), intended for use in work stealing. Queue operations are non-blocking")——ABP 与 Arora 同源(第一作者),正文用源码注释名
> - **"volatile uint _age" 错**: `_age` 是 **volatile Age 类**(taskqueue.hpp:116-147: union{size_t _data; fields{idx_t _top; idx_t _tag}};LP64 idx_t=uint32 :112 → 64 位=top32+tag32;increment() top 自增 wrap 时 tag 增 :128-132;cmpxchg :134);`_bottom` volatile uint(:150)+**缓存行 padding**(:151-152 "reduce false-sharing cache contention");**`_elems` 不是成员数组而是指针**(initialize 时 ArrayAllocator 分配,inline.hpp:50-53)
> - **"pop_local 不检查 stealing" 半对**: 正常路径 owner 自减 _bottom 无锁(pop_local inline.hpp:154-194,fence :168,二次读 age :179);**只有最后一个元素才与 thief 竞争**(pop_local_slow :122-152: Age(localBot, tag+1) CAS 竞争 :132-138,输家 _age.set 修正空队列表示 :149)
> - **pop_global = steal**(:204-233): load_acquire _bottom(:213)→读 _elems[top](:224)→newAge.increment()→**CAS _age**(:227),一次偷一个;**steal_best_of_2**(GenericTaskQueueSet :235-241)随机两受害者队列
> - **push**(inline.hpp:78-98): _elems[bot]=t+release_store _bottom;OverflowTaskQueue 满→overflow_stack 兜底(:100-108)
> - 大纲 x86 注释重复(两条相同)——正文不采用

场景: GenericTaskQueue 存 GC task(oop 指针组)→每个 worker 从自己的 queue 取任务(pop_local)→如果自己的 queue 空了→从其他 worker queue steal(pop_global)。

**GenericTaskQueue 双指针** (`taskqueue.hpp:60-200):
```cpp
template<class E, MEMFLAGS F, unsigned int N>
class GenericTaskQueue {
protected:
  volatile uint _bottom; // 本地 pop 使用(worker 只改自己的 _bottom)
  volatile uint _age;    // top + tag——steal 通过 CAS 修改 _age
  E     _elems[N];       // 固定大小环形 arrays
public:
  bool pop_local(E& t);    // 从 self queue 取任务
  bool pop_global(E& t);   // steal from other queue(CAS _age)
  bool push(E t);          // 添加自己的任务
};
```
- 源码: `taskqueue.hpp:60-200` GenericTaskQueue + `taskqueue.inline.hpp:40-200` 操作实现
- 关键设计: Arora 算法的本质——(1) pop_local 不检查 stealing——worker 只改 _bottom。(2) pop_global(steal) 通过 CAS _age 获取——age 包含 [top + tag](top=队列头索引, tag=防止ABA的generation)。只窃取一个 element——避免饿死被偷者
- [C++: `_age` 是 64-bit packed = tag(32 bit) | top(32 bit)。steal 用 `Atomic::cmpxchg(new_age, &_age, cur_age)` 的 64-bit CAS——AB 问题被 tag 解决——top 相同时 tag 不同→CAS 失败。`_bottom` 只被 owner 写——不需原子操作(volatile read)
- [C++: `_age` 是 64-bit packed = tag(32 bit) | top(32 bit)。steal 用 `Atomic::cmpxchg(new_age, &_age, cur_age)` 的 64-bit CAS——AB 问题被 tag 解决——top 相同时 tag 不同→CAS 失败]

### 2. "WorkGang 分发——均匀调度"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/04 已按真实源码成文):
> - **"run_task 信号量/同步" ✓ 对**: 真实=SemaphoreGangTaskDispatcher(workgroup.cpp:124-192,注释 "Semaphores don't require the worker threads to re-claim the lock when they wake up...lowering the latency"): coordinator_execute_on_workers(:150-168 _task/_not_finished→_start_semaphore->signal(num_workers) :156→run_foreground_task_if_needed→_end_semaphore->wait() :161);worker_wait_for_task(:170-180 wait→Atomic::add _started→worker_id);worker_done_with_task(:182-191 Atomic::sub→最后一人 signal);**run_task 同步返回=全部完成**(workgroup.cpp:288-302)
> - **"GangWorker::run 伪代码 while(!_should_terminate)" 简化**: 真实 loop(wait_for_task→run_task(task->work(worker_id))→signal_task_done,workgroup.cpp:347-360+);initialize 设 **NearMaxPriority**(:314-322);常驻线程非每次新建
> - **动态 worker 数(大纲漏,重要)**: AbstractWorkGang(workgroup.hpp:109-201): _total_workers 上限/_active_workers 实际(UseDynamicNumberOfGCThreads 初始 1 :137,update_active_workers 按任务量上调 :163-171);GangWorker 懒创建(add_workers "Add GC workers as needed" :174)
> - 备选 MutexGangTaskDispatcher(:194+,Monitor 版)
> - **悬念指向** ✓(05-cardtable;05 标题="一次赋值在 GC 眼里怎么变成"脏卡片"？— CardTable + DirtyCardQueue")
> - **实证**: ParallelGCThreads=23 是上限(UseDynamicNumberOfGCThreads=true 时小 GC 仅 Workers: 2,gc+phases);线程转储 GC Thread#N/G1 Conc#N 懒创建;gc+task/gc+workgang 标签可用;素材 25-gc-workgang-demo.txt

场景: WorkGang 是 N 个 GangWorker 的集合。run_task(task)→每个 worker 调用 task.work(i)→worker 并行执行直到 task.is_done()。

**WorkGang dispatch** (`workgroup.hpp:40-120 + workgroup.cpp:80-200`):
```cpp
class WorkGang {
  GangWorker** _gang_workers; // N 个 worker
  void run_task(AbstractGangTask* task);
};
class GangWorker : public WorkerThread {
  void run() {
    while(!_should_terminate) { // loop for next task
      AbstractGangTask* task = wait_for_task();
      task->work(_id);   // 调用 GC task 的实际逻辑
    }
  }
};
```
- 源码: `workgroup.hpp:40-120` WorkGang + `workgroup.cpp:80-200` run_task
- 关键设计: run_task 是同步的——dispatching thread 等待所有 worker 完成才返回。每个 worker 通过信号量(semaphore)协调——task.is_done 检查所有 worker 已到达 work done point

---

### 核心悬念

**"GenericTaskQueue 用 Arora 算法——pop_local 无竞争(修改 _bottom)、pop_global 用 CAS _age(64-bit packed tag+top)窃取一个任务。WorkGang 分发 task→N workers 并行直到全部 done。"** — 但 `obj.field = val` 在 GC 眼里怎么变成 "脏卡片"？下一篇: CardTable。

> → [05-cardtable-dirtycardq.md](05-cardtable-dirtycardq.md)
