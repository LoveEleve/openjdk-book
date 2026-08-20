# 04. FutureTask 与定时调度 — 任务状态机、ScheduledThreadPool

> 🔴 Deep | 域 14 线程池与任务第 4 篇 | Layer 5
> 读者处境: 面试"Future/cancel 语义"——FutureTask 的状态机与定时调度的延迟队列。

### 1. "FutureTask 的状态机" — 7 态

场景: submit 返回的 Future——内部经历什么状态?

- `FutureTask.java:92-99` — `state`: NEW(0)/COMPLETING(1)/NORMAL(2)/EXCEPTIONAL(3)/CANCELLED(4)/INTERRUPTING(5)/INTERRUPTED(6)
- 迁移: NEW → COMPLETING → NORMAL(正常)/EXCEPTIONAL(异常);NEW → CANCELLED(取消);NEW → INTERRUPTING → INTERRUPTED(中断取消)
- `outcome`(104): 结果或异常(受 state 保护)
- 关键设计 (斜体): *"状态机保证结果一次性发布"——COMPLETING 是过渡态(写结果窗口);面试"FutureTask 状态"——7 态两条主线(完成/取消)*
- 面试: "get 返回什么"——结果或抛 ExecutionException(包装任务异常,域 06)

### 2. "get/cancel 的语义" — 等待与取消

场景: `future.get()` 阻塞多久?cancel 能不能中断?

- `get()`(187): 未完成则 `awaitDone`(190 附近,自旋+park)——**阻塞等待**(可中断)
- `get(timeout)`(197 附近): 超时抛 TimeoutException
- `cancel(true)`(164): CAS NEW→INTERRUPTING → `t.interrupt()`(173 附近)→ INTERRUPTED;**cancel(false)**: NEW→CANCELLED(不中断)
- 关键设计 (斜体): *"cancel 只对未开始/进行中生效"——已完成的 Future 无法取消(CAS NEW 失败);面试"cancel(true) 一定中断吗"——调用 interrupt 但任务需响应(域 11 协作式中断)*
- 面试: "get vs isDone"——阻塞 vs 轮询;生产: get(timeout) 防无限等
- [关联: 域 11 中断语义;域 13 CAS]

### 3. "ScheduledThreadPoolExecutor" — 延迟调度

场景: 定时任务——队列与线程怎么配合?

- `ScheduledThreadPoolExecutor` — extends ThreadPoolExecutor + **DelayedWorkQueue**(456,域 10 DelayQueue 思想)
- `schedule`(延迟一次)/`scheduleAtFixedRate`(616,固定频率: 下次=开始时间+周期)/`scheduleWithFixedDelay`(下次=完成时间+延迟)
- 周期任务: `period` 字段(200)+ 重排(reExecutePeriodic)
- 关键设计 (斜体): *"固定频率 vs 固定延迟"的差别——Rate 按开始时间排(可能叠加),WithDelay 按结束时间排(不叠加);面试"两个 Fixed 的区别"——重叠 vs 顺序*
- 面试: "DelayedWorkQueue 怎么取到期任务"——getDelay(剩余时间)头元素判断(域 10)
- [关联: 域 10 DelayQueue;域 15 ForkJoin(定时池的并发改进)]

### 4. "submit 的包装链" — FutureTask 的产生

场景: `pool.submit(callable)` — 返回的 Future 哪来的?

- `AbstractExecutorService.submit` → `new FutureTask(callable)` → `execute(task)` → 返回 FutureTask
- `RunnableFuture` 接口: FutureTask 既 Runnable 又 Future——**被线程池执行的同时暴露结果**
- execute 的异常 → FutureTask.run 捕获 → EXCEPTIONAL 状态 → get 抛 ExecutionException
- 关键设计 (斜体): *"FutureTask 是任务的'执行+结果'合体"——线程池跑它,调用方拿结果;面试"submit vs execute 异常"——execute 异常走 uncaughtException(域 11),submit 异常进 Future(域 06 衔接)*
- 面试: "任务异常谁处理"——submit 的任务异常被 FutureTask 捕获,execute 的走线程异常链(域 11)

---

### 核心悬念

机制全通了——**怎么创建与调优**?`Executors` 工厂的参数映射、线程池选型(固定/缓存/定时)、生产参数调优——下一篇: Executors 工厂与选型。

> → [05-executors-selection.md](05-executors-selection.md)
