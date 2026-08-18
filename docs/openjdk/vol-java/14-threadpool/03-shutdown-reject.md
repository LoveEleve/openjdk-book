# 03. 线程池关闭与拒绝策略 — shutdown/Now、awaitTermination、四策略

> **前置依赖**: [14-threadpool/01 — ctl 与 Worker](01-ctl-worker.md)(状态机)、[14-threadpool/02 — execute 与 Worker 生命周期](02-execute-worker.md)(任务提交流程)
> → **后续**: [04-futuretask-scheduled.md](04-futuretask-scheduled.md)

## 线程池怎么关、满了怎么办

线程池的难点不是创建,而是**关闭语义**和**饱和语义**。这一篇把优雅停机与拒绝策略讲清。

## 1. "shutdown vs shutdownNow" — 两种关闭

### 1.1 shutdown

`shutdown()`(`ThreadPoolExecutor.java:1369`)做的是:

- `advanceRunState(SHUTDOWN)`(`:1374`)
- `interruptIdleWorkers()`(`:1375`;定义 `:809`)
- 不再接收新任务,但队列里的任务继续处理

它中断的是**空闲 Worker**,不是正在执行任务的 Worker。

### 1.2 shutdownNow

`shutdownNow()`(`:1400`)更强硬:

- 状态推进到 `STOP`
- **尽力**中断所有 Worker(通过 `Thread.interrupt`;任务若不响应中断,不保证立即终止)
- `drainQueue()`(`:842`)把还没执行的任务取出来作为 `List<Runnable>` 返回

面试"停机想等任务跑完": `shutdown()` + `awaitTermination()`;面试"shutdownNow 返回什么": 尚未执行的队列任务。

关键设计(斜体):*"优雅 vs 强制"——shutdown 让队列任务收尾,shutdownNow 立即中断并退回未执行任务。面试"两者区别": SHUTDOWN 继续处理队列,STOP 尽快终止。*

## 2. "awaitTermination" — 等待终结

### 2.1 等待条件

`termination` 是 `mainLock` 上的 Condition(`ThreadPoolExecutor.java:473`)。

`awaitTermination(timeout, unit)`(`:1445`)等待状态进入 `TERMINATED`;到时返回 `true`,超时返回 `false`。

### 2.2 典型模式

```java
// 用法示意(API 形式,非源码片段)
pool.shutdown();
if (!pool.awaitTermination(60, SECONDS)) {
    pool.shutdownNow();
}
```

这是生产优雅停机的标准三连: **先优雅关闭,超时再强退**。

关键设计(斜体):*"shutdown + awaitTermination + 超时兜底 shutdownNow"是生产优雅停机的标准模式。面试"优雅停机怎么写": 先等队列收尾,超时再强退。*

## 3. "拒绝策略四选一" — RejectedExecutionHandler

### 3.1 默认策略

默认拒绝处理器是 `defaultHandler = new AbortPolicy()`(`ThreadPoolExecutor.java:554-555`)。

### 3.2 四种策略

- `CallerRunsPolicy`(`:2012`)——调用者线程自己执行,形成背压
- `AbortPolicy`(`:2039`)——抛 `RejectedExecutionException`
- `DiscardPolicy`(`:2063`)——静默丢弃
- `DiscardOldestPolicy`(`:2084`)——丢弃队头最旧任务后重试提交

`reject(command)`(`:824`)最终统一委托给 `handler.rejectedExecution(command, this)`(`:825`)。

面试"CallerRunsPolicy 为什么有用": 队列/线程满时让提交方自己干活,天然减速限流。

关键设计(斜体):*"拒绝策略 = 饱和语义"——抛异常/背压/丢弃,本质上是在定义系统满载时怎么退化。面试"默认拒绝策略": AbortPolicy。*

## 4. "关闭的完整语义" — 状态机视角

### 4.1 tryTerminate

真正推动 `TIDYING → TERMINATED` 的核心是 `tryTerminate()`(`ThreadPoolExecutor.java:701`)。

它会在以下时机反复尝试终结:

- `SHUTDOWN` 状态下队列清空且 worker 数减到 0
- `STOP` 状态下 worker 数减到 0(待执行任务已由 `shutdownNow` drain)
- shutdown/shutdownNow 过程中的关键节点

当满足条件时:

- CAS 把状态设成 `TIDYING`
- 调用 `terminated()` 钩子
- 置 `TERMINATED`
- `termination.signalAll()`(`:721`)唤醒 `awaitTermination` 的等待线程

### 4.2 关闭后还能不能用

不能。线程池状态单向推进: `RUNNING → SHUTDOWN/STOP → TIDYING → TERMINATED`,不可逆。

面试"关闭后 execute 会怎样": 不再是 RUNNING,最终走 `reject` 分支。

关键设计(斜体):*"关闭是状态机迁移"——每次状态变化都会改变 execute/getTask/中断逻辑的分支。面试"TERMINATED 怎么到达": 队列空 + workerCount 为 0 + tryTerminate 成功。*

## 核心悬念

执行与关闭通了——**异步结果**呢?`FutureTask` 的状态机、`get()` 的阻塞、`cancel()` 的语义;定时调度的 `ScheduledThreadPoolExecutor` 又怎么把 DelayQueue 用起来?——下一篇: FutureTask 与定时调度。