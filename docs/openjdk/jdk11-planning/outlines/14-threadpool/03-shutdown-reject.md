# 03. 线程池关闭与拒绝策略 — shutdown/Now、awaitTermination、四策略

> 🔴 Deep | 域 14 线程池与任务第 3 篇 | Layer 5
> 读者处境: 生产优雅停机——线程池怎么安全关闭?任务满了怎么拒绝?

### 1. "shutdown vs shutdownNow" — 两种关闭

场景: 停机时队列里的任务怎么办?

- `ThreadPoolExecutor.java:1369` `shutdown()`: `advanceRunState(SHUTDOWN)`(1374)+ `interruptIdleWorkers()`(1375,只中断空闲 worker,783 定义)——**不收新任务,队列任务继续跑完**
- `ThreadPoolExecutor.java:1400` `shutdownNow()`: 状态→STOP——**中断所有 worker + 返回未执行队列**(List<Runnable>)
- 关键设计 (斜体): *"优雅 vs 强制"——shutdown 等队列清空,shutdownNow 立即中断并退回任务;面试"停机想等任务跑完"——shutdown + awaitTermination*
- 面试: "shutdown 后 execute 会怎样"——RejectedExecutionException(状态非 RUNNING)

### 2. "awaitTermination" — 等待终结

场景: 关完线程池怎么知道"真的关了"?

- `awaitTermination(timeout, unit)`: 等待状态到 TERMINATED(termination Condition,473)——超时返回 false
- 典型模式:
  ```java
  pool.shutdown();
  if (!pool.awaitTermination(60, SECONDS)) pool.shutdownNow();
  ```
- 关键设计 (斜体): *"shutdown + awaitTermination + 超时兜底 shutdownNow"是生产优雅停机的标准三连;面试"优雅停机怎么写"——这个模式*
- 生产: 应用停机钩子(域 03 shutdownHook)里执行

### 3. "拒绝策略四选一" — RejectedExecutionHandler

场景: 队列满+线程满——新任务怎么处理?

- `ThreadPoolExecutor.java:554` — `defaultHandler = AbortPolicy`(默认)
- 四策略(2012-2095 区域):
  - **AbortPolicy**(2039): 抛 RejectedExecutionException(默认)
  - **CallerRunsPolicy**(2012): 调用线程直接执行(背压!)
  - **DiscardPolicy**(2063): 静默丢弃
  - **DiscardOldestPolicy**(2084): 丢队头最旧
- 关键设计 (斜体): *"拒绝策略 = 饱和语义"——抛异常(明确)/调用者执行(背压)/丢弃(可容忍);面试"CallerRunsPolicy 为什么好"——满时让提交线程干活,天然限流*
- 生产: 任务重要用 Abort+告警;可丢用 Discard;背压用 CallerRuns

### 4. "关闭的完整语义" — 状态机视角

场景: 从状态机看关闭——各阶段行为

- SHUTDOWN: 收尾队列(getTask 的 take/poll 继续,直到队列空+worker 退出)
- STOP: getTask 立即返回 null(中断后)+shutdownNow 返回队列
- TIDYING→TERMINATED: 最后 worker 退出 → terminated() 钩子 → termination.signalAll
- 关键设计 (斜体): *"关闭是状态机的迁移"——每个状态改变 getTask/execute 的行为分支;面试"TERMINATED 怎么到达"——队列空+worker 数 0*
- 面试: "关闭后线程池还能用吗"——不能(状态不可逆)
- [关联: 域 03 shutdownHook(停机钩子集成)]

---

### 核心悬念

执行与关闭通了——**任务的异步结果**呢?`FutureTask` 的状态机(NEW→NORMAL/CANCELLED...)、get 的阻塞、cancel 的语义;定时调度(ScheduledThreadPool)的 DelayedWorkQueue——下一篇: FutureTask 与定时调度。

> → [04-futuretask-scheduled.md](04-futuretask-scheduled.md)
