# 04. 4 个 GC worker 怎么平分扫描任务？— WorkGang + TaskQueue

> 🔴 Deep | 5 KP 中的并行基础设施
> 读者处境: G1 并行标记阶段——4 个 GC worker 平分整个 heap 的 oop 扫描。怎么分配任务不用锁？worker 1 做完了任务、worker 2 还在忙——worker 1 可以去 worker 2 那里"偷"任务。

### 1. "Arora 无锁工作窃取队列"

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
