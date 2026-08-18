# 04. FutureTask 与定时调度 — 任务状态机、ScheduledThreadPool

> **前置依赖**: [14-threadpool/02 — execute 与 Worker 生命周期](02-execute-worker.md)(任务执行)、[14-threadpool/03 — 关闭与拒绝](03-shutdown-reject.md)(线程池状态)
> → **后续**: [05-executors-selection.md](05-executors-selection.md)
> 关联: [13-atomic/01 — 原子与 CAS](../13-atomic/01-atomicinteger-cas.md)(状态 CAS)

## Future 和定时任务怎么落地

`submit` 返回的 Future 不是额外的魔法: 它通常是一个会被线程池执行的 `FutureTask`。定时任务则是在此基础上再加一层延迟队列。

## 1. "FutureTask 的状态机" — 7 个状态值

### 1.1 状态与迁移

`FutureTask.java:92-99` 定义 `volatile int state` 与七个状态值:

- `NEW(0)`
- `COMPLETING(1)`
- `NORMAL(2)` / `EXCEPTIONAL(3)`
- `CANCELLED(4)`
- `INTERRUPTING(5)` / `INTERRUPTED(6)`

主线只有两类:

- 完成: `NEW → COMPLETING → NORMAL/EXCEPTIONAL`
- 取消: `NEW → CANCELLED` 或 `NEW → INTERRUPTING → INTERRUPTED`

`outcome`(`:104`)保存正常结果或异常对象。

关键设计(斜体):*"状态机保证结果一次性发布"——`COMPLETING` 是写入结果的过渡态,最终状态才对外稳定。面试"FutureTask 状态": 完成线 + 取消线。*

## 2. "get/cancel 的语义" — 等待与取消

### 2.1 get 等待

- `get()`(`FutureTask.java:187`)未完成时进入 `awaitDone`(`:190`附近),通过自旋与 `LockSupport.park` 等待
- `get(timeout, unit)`(`:197`)超时后抛 `TimeoutException`
- 任务异常会以 `ExecutionException` 形式从 `get` 抛出

### 2.2 cancel

`cancel(boolean)`(`:164`)先 CAS 检查 `state == NEW`:

- `cancel(false)` → `CANCELLED`,不主动中断执行线程
- `cancel(true)` → `INTERRUPTING`(`:166`)→ 调用 `runner.interrupt()`(`:173`附近)→ `INTERRUPTED`

已完成的 Future 无法再取消,因为 CAS 不再满足 `state == NEW`。

面试"cancel(true) 一定中断吗": 它会调用 `interrupt`,但任务必须协作响应中断。

关键设计(斜体):*"cancel 只争抢 NEW 状态"——取消不是回滚任务,而是对尚未完成状态做一次性竞争。面试"get vs isDone": 阻塞等待 vs 状态轮询。*

## 3. "ScheduledThreadPoolExecutor" — 延迟调度

### 3.1 DelayedWorkQueue

`ScheduledThreadPoolExecutor`(`ScheduledThreadPoolExecutor.java:134`)继承 `ThreadPoolExecutor`,构造器使用 `DelayedWorkQueue`(`:456`)。

`DelayedWorkQueue`(`:899`)基于堆,按任务到期时间排序。队列头部未到期时,工作线程等待剩余 delay,到期后才能取出。

### 3.2 两种周期

- `scheduleAtFixedRate`(`:616`)——下一次时间按**上一次计划开始时间 + period**计算
- `scheduleWithFixedDelay`(`:664`)——下一次时间按**本次执行完成时间 + delay**计算
- 周期任务的 `period` 字段在 `ScheduledFutureTask`(`:185`,字段声明 `:200`)中保存;执行后通过 `reExecutePeriodic`(`:356`)重新入队

关键设计(斜体):*"固定频率 vs 固定延迟"——FixedRate 对齐计划时间,FixedDelay 对齐完成时间。面试"两个 Fixed 的区别": 前者追赶计划,后者保证前后间隔。*

## 4. "submit 的包装链" — FutureTask 的产生

`AbstractExecutorService.submit` 的链路是:

1. `newTaskFor` 为 Callable 创建 `FutureTask`(`AbstractExecutorService.java:107-108`)
2. `submit(Callable)` 调用 `execute(ftask)`(`:137-140`);`submit(Runnable)` 对应调用点为 `:117`
3. 返回这个同时实现 `RunnableFuture` 的对象

因此线程池执行的是 FutureTask,调用方拿到的是同一个对象的 Future 视图。FutureTask.run 捕获 Callable 异常并进入 `EXCEPTIONAL`,随后 `get` 抛 `ExecutionException`。

面试"submit vs execute 异常": submit 把异常封进 Future,execute 的异常走线程异常处理链。

关键设计(斜体):*"FutureTask = 执行 + 结果"——线程池负责调用 `run`,调用方负责 `get/cancel`;两者通过同一个状态机连接。面试"任务异常谁处理": submit 进 Future,execute 走线程异常链。*

## 核心悬念

机制全通了——**怎么创建与调优**?`Executors` 工厂的参数映射、线程池选型(固定/缓存/定时)、生产参数调优——下一篇: Executors 工厂与选型。