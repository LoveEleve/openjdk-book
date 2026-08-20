# 01. TPE 核心 — ctl 状态机与 Worker 结构

> 🔴 Deep | 域 14 线程池与任务第 1 篇 | Layer 5
> 读者处境: 面试"线程池原理"必考——ctl 一字段两用、7 状态、Worker 为什么继承 AQS。

### 1. "ctl 是什么？" — 一字段两用

场景: 线程池的"状态+线程数"怎么原子管理?

- `ThreadPoolExecutor.java:380` — `private final AtomicInteger ctl = ctlOf(RUNNING, 0)` — **一个 int 打包两个值**
- 布局: 高 3 位 = runState(5 状态),低 29 位 = workerCount(线程数)
- 工具: `runStateOf/workerCountOf/ctlOf`(392-394)
- 关键设计 (斜体): *"一字段两用"让"状态与线程数"的更新原子一致(CAS 一次)——避免"改了状态没改计数"的中间态;面试"ctl 为什么一个 int"——原子性 + 减少竞争*
- 面试: "线程数上限"——29 位(5 亿+);状态 5 种(高位 3 位)

### 2. "生命周期 7 态" — 状态迁移

场景: 线程池从创建到销毁——经历什么状态?

- 状态(`ThreadPoolExecutor.java:385-387` + 注释 347-367): RUNNING → SHUTDOWN → STOP → TIDYING → TERMINATED
- 语义: RUNNING(收新任务)/SHUTDOWN(不收新,处理队列)/STOP(中断+清队列)/TIDYING(收尾)/TERMINATED(终结)
- 迁移: shutdown()→SHUTDOWN;shutdownNow()→STOP;空+停→TIDYING→TERMINATED(termination.signal)
- 关键设计 (斜体): *"状态即策略"——每个状态决定"收不收任务/处不处理队列/中不中断";面试"shutdown vs shutdownNow 状态"——SHUTDOWN vs STOP*
- 面试: "TIDYING 谁触发"——最后一个 worker 退出后(terminated 钩子)

### 3. "Worker 为什么继承 AQS？" — 任务互斥

场景: Worker 是什么?为什么不用普通 Runnable?

- `ThreadPoolExecutor.java:596-598` — `private final class Worker extends AbstractQueuedSynchronizer implements Runnable`(多行声明);`final Thread thread`(607)+ `Runnable firstTask`(609)+ `volatile long completedTasks`(611)+ 构造(620)
- **Worker extends AbstractQueuedSynchronizer**: 用 AQS 的独占锁实现**任务执行互斥**(一个 worker 同时只跑一个任务)
- 用途: shutdownNow 中断时"正在跑的任务"与"排队中的"区分(锁判断)
- 关键设计 (斜体): *"Worker=线程+首任务+互斥锁"——AQS 复用: 不需要完整锁能力,只需"是否空闲"判断;面试"Worker 为什么 AQS"——shutdownNow 时区分运行中/空闲*
- 面试: "Worker 与线程关系"——一个 Worker 持一个线程(线程生命周期由 worker 管理)
- [关联: 域 12 AQS(Worker 的锁语义)]

### 4. "核心参数" — 五参数语义

场景: 线程池参数怎么理解?

- `corePoolSize`(541): 常驻线程数
- `maximumPoolSize`(549): 上限
- `workQueue`(447): 任务队列(域 10)
- `keepAliveTime`(524): 空闲回收时间(超核心线程)
- `threadFactory`/`handler`(516): 线程工厂/拒绝处理器
- 关键设计 (斜体): *"参数组合决定行为"——core 决定常驻,队列决定缓冲,最大决定峰值;面试"线程池什么时候加线程"——execute 流程(第 2 篇)*
- 面试: "core=0 会怎样"——线程用完即回收(像 CachedThreadPool)

---

### 核心悬念

参数知道了——**execute 怎么用**?先加线程还是先入队?`addWorker` 的双重检查、队列满的处理、拒绝的时机——下一篇: execute 流程与 Worker 生命周期。

> → [02-execute-worker.md](02-execute-worker.md)
