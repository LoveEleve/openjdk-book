# 03. ForkJoinPool work-stealing — 双端队列、ctl 状态、窃取算法

> **前置依赖**: [14-threadpool/01 — ctl 与 Worker](../14-threadpool/01-ctl-worker.md)(线程池对照)、[15-async/01 — CompletableFuture 基础](01-cf-basics.md)(commonPool 异步回调)
> → **后续**: [04-forkjointask.md](04-forkjointask.md)
> 关联: [16-stream/06 — Spliterator 与并行](../16-stream/06-spliterator-parallel.md)(并行流)

## ForkJoinPool 为什么适合分治

`ForkJoinPool` 不让所有线程争抢一个共享任务队列,而是给每个 Worker 一个本地队列,空闲线程再去**窃取**别人的任务。

## 1. "ForkJoinPool 是什么?" — 并行分治池

### 1.1 commonPool

`commonPool()`(`ForkJoinPool.java:2395`)是全局共享池;`getCommonPoolParallelism()`(`:2563`)返回其目标并行度。`CompletableFuture` 的 Async 方法与并行流都可能使用它。

与 `ThreadPoolExecutor` 的共享队列模型相比,ForkJoinPool 把竞争拆到多个 WorkQueue 上,空闲线程再随机寻找工作。

关键设计(斜体):*"私队列 + 窃取"减少单一共享队列竞争——本线程优先处理自己的任务,空闲时再拿别人的任务。面试"FJP 与 TPE 区别": 私有队列 + work-stealing vs 共享队列。*

## 2. "WorkQueue 结构" — 双端队列

### 2.1 三个字段

`WorkQueue`(`ForkJoinPool.java:777`)的核心字段:

- `base`(`:780`)——窃取端
- `top`(`:781`)——Owner 私有端
- `array`(`:785`)——环形任务数组

Owner 从 `top` push/pop,通常是 LIFO;窃取者从 `base` poll,是 FIFO。这样本地任务偏向最近任务,窃取者拿较早任务,减少两端冲突。

### 2.2 两类入队

- 外部提交进入池的共享提交队列
- Worker 内部 `fork` 的任务进入自己的 WorkQueue

关键设计(斜体):*"双端 = 两种竞争分离"——Owner 取顶端,窃取者取底端。面试"为什么双端": 本地 LIFO 便于缓存,窃取 FIFO 便于搬走较老任务。*

## 3. "ctl 状态" — 64 位打包

`ForkJoinPool.java:1312` 的 `volatile long ctl` 是池级控制字。相关布局:

- `SP_MASK`(`:1284`)——等待栈指针部分
- `TC_SHIFT = 32`(`:1293`)——总线程计数所在高半部
- `ctl` 还编码活跃线程计数、等待栈链接与版本/状态信息

所有这些字段通过对同一个 `long ctl` 做 CAS 更新,形成池状态的原子快照。

关键设计(斜体):*"ctl = 池状态的原子快照"——活跃/总数/等待栈集中在一个 long 中,CAS 一致更新。面试"FJP 为什么用 64 位": 需要同时编码线程计数和等待栈。*

## 4. "窃取算法" — 任务获取与扫描

### 4.1 本地优先

`nextTaskFor(WorkQueue)`(`ForkJoinPool.java:1854`)先调用 `nextLocalTask`(`:943`),取 Owner 自己的 top 端任务;本地没有任务时再调用 `poll`(`:922`),从其他队列的 base 端窃取。

### 4.2 随机扫描与休眠

`pollScan(false)`(`ForkJoinPool.java:1809`)使用随机起点和步长扫描 WorkQueue,找到非空队列后从 base 偷一个任务。扫描不到时,Worker 失活并登记到等待结构;新任务到达后再唤醒可用 Worker。

关键设计(斜体):*"窃取 = 随机扫描 + 底端取 + 失败休眠"——随机性避免所有空闲线程盯同一队列,窃取让空闲计算力重新流动。面试"窃取不到干什么": 失活等待,新任务到达时唤醒。*

## 核心悬念

执行引擎通了——**任务怎么写**?`ForkJoinTask` 的状态机、`fork()/join()`、`RecursiveTask` 分治、`CountedCompleter` 计数完成——下一篇: ForkJoinTask 与分治。