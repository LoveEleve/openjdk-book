# 02. execute 流程与 Worker 生命周期 — 四步执行、任务取送

> **前置依赖**: [14-threadpool/01 — ctl 与 Worker](01-ctl-worker.md)(状态与 Worker)、[10-concurrent-collections/05 — 阻塞队列](../10-concurrent-collections/05-blocking-queues.md)(workQueue)
> → **后续**: [03-shutdown-reject.md](03-shutdown-reject.md)

## execute 怎么决定下一步

`ThreadPoolExecutor.execute` 不是简单的"扔给线程": 它按核心线程、队列、最大线程、拒绝处理器的顺序做资源决策。

## 1. "execute 的四步" — 任务路由

### 1.1 路由顺序

`execute`(`ThreadPoolExecutor.java:1318`)的核心判断:

1. `workerCountOf(c) < corePoolSize` → `addWorker(command, true)`(`:1343`)——先加核心线程
2. 线程池仍运行且 `workQueue.offer(command)`(`:1347`)成功——入队,然后双检查状态
3. 队列放不下 → `addWorker(command, false)`(`:1354`)——加非核心线程
4. 达到上限或状态不允许 → `reject(command)`(`:1355`)——拒绝

这就是**核心线程 → 队列 → 非核心线程 → 拒绝**的资源阶梯。

面试"为什么先加线程不入队": 核心线程是线程池的常驻基线,先把核心执行能力建立起来。

关键设计(斜体):*"先核心→再队列→再非核心→拒绝"是线程池的资源阶梯。面试手写 execute 流程时,关键是记住队列发生在 core 与 maximum 之间。*

## 2. "addWorker" — 线程的诞生

### 2.1 CAS + 主锁

`addWorker(firstTask, core)`(`ThreadPoolExecutor.java:885`)分成两种保护:

- **计数**: retry 循环里 CAS 更新 `ctl` 的 workerCount,同时校验 RUNNING/SHUTDOWN 状态
- **集合**: `mainLock.lock()`(`:916`附近)后把 Worker 放入 `workers`(`:468`)
- **启动**: 完成集合登记后 `t.start()`(`:928`附近)

失败时回滚 workerCount,避免"计数增加但线程没建成"。

### 2.2 null firstTask

`addWorker(null, false)`(`:1005`)是补位路径: 队列里还有任务,但需要再创建一个非核心 Worker 来继续消费。

关键设计(斜体):*"CAS + 锁的组合"——计数用 CAS 快路径,`workers` 集合用主锁做结构性变更。面试"addWorker 为什么复杂": 并发下要同时维护状态、计数和 Worker 集合。*

## 3. "getTask" — 任务的取与等

### 3.1 阻塞还是限时

`getTask`(`ThreadPoolExecutor.java:1026`)计算:

`timed = allowCoreThreadTimeOut || wc > corePoolSize`(`:1042`)。

- `timed == true`: `workQueue.poll(keepAliveTime, NANOSECONDS)`(`:1053`)——超时返回 null,Worker 退出
- `timed == false`: `workQueue.take()`(`:1054`)——无限等待任务

### 3.2 回收语义

默认 `allowCoreThreadTimeOut=false`: 核心 Worker 通常通过 `take()` 常驻;超核心 Worker 通过 `poll` 等待 `keepAliveTime`,超时后退出。

关键设计(斜体):*"核心线程 take 常驻,超核心线程 poll 超时回收"——keepAliveTime 只约束超核心线程,除非显式允许核心线程超时。面试"线程什么时候回收": getTask 超时返回 null。*

## 4. "runWorker" — 任务执行循环

### 4.1 主循环

`runWorker`(`ThreadPoolExecutor.java:1107`)的核心结构是:

```java
// ThreadPoolExecutor.java:1114-1140(截取,逐字)
            while (task != null || (task = getTask()) != null) {
                w.lock();
                // If pool is stopping, ensure thread is interrupted;
                // if not, ensure thread is not interrupted.  This
                // requires a recheck in second case to deal with
                // shutdownNow race while clearing interrupt
                if ((runStateAtLeast(ctl.get(), STOP) ||
                     (Thread.interrupted() &&
                      runStateAtLeast(ctl.get(), STOP))) &&
                    !wt.isInterrupted())
                    wt.interrupt();
                try {
                    beforeExecute(wt, task);
                    try {
                        task.run();
                        afterExecute(task, null);
                    } catch (Throwable ex) {
                        afterExecute(task, ex);
                        throw ex;
                    }
                } finally {
                    task = null;
                    w.completedTasks++;
                    w.unlock();
                }
            }
            completedAbruptly = false;
```

每轮是: 取任务 → `beforeExecute` → `task.run` → `afterExecute` → 计数;循环结束后进入 `processWorkerExit`。

### 4.2 异常语义

异常不是简单"被 afterExecute 吃掉": `afterExecute` 会收到异常,随后异常继续抛出,Worker 进入退出处理。也就是说,**任务抛出未捕获异常时当前 Worker 会结束**,线程池再按策略补 Worker。

面试"任务异常线程会死吗": 未捕获异常会让当前 Worker 退出;`execute` 提交的任务异常通常由线程的异常处理器观察到,`submit` 包装成 Future 的异常结果。

关键设计(斜体):*"Worker 主循环 = 取任务 + 执行 + 钩子"——`beforeExecute/afterExecute` 是生命周期钩子,异常决定当前 Worker 是否退出。面试"任务异常线程会死吗": 未捕获异常会结束当前 Worker,不是线程池整体崩溃。*

## 核心悬念

线程池要关了——**优雅关闭**怎么保证队列任务跑完?`shutdown` 与 `shutdownNow` 的差别、`awaitTermination`、拒绝策略的四个选择——下一篇: 关闭与拒绝策略。