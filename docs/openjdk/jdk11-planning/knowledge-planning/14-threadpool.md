# 域 14: 线程池与任务 — 知识规划

> 源码路径: java.base/share/classes/java/util/concurrent/{ThreadPoolExecutor(2,474),ScheduledThreadPoolExecutor(1,393),Executors,ExecutorService,Executor,FutureTask(1,105),Future,Callable,Runnable,CompletionService,ExecutorCompletionService,AbstractExecutorService}.java
> 源码量: ~15 文件 / ~9,000 行 | 非巨型域(但面试密度极高,拆 5 篇)
> 写作层: Layer 5(前置: 域 10 阻塞队列、11 线程、12 锁)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| ThreadPoolExecutor.java | **ctl 打包**: ctl AtomicInteger(380)=runState(高位)+workerCount(低位)、RUNNING/SHUTDOWN/STOP 等(385-387)、runStateOf/workerCountOf/ctlOf(392-394)——一字段两用 | High |
| TPE | **核心参数**: corePoolSize(541)/maximumPoolSize(549)/workQueue(447,BlockingQueue)/keepAliveTime(524)/threadFactory/handler(516)/mainLock+workers(462-468)+termination Condition(473) | High |
| TPE | **Worker**: extends AQS(独占锁实现任务互斥)、run(627 附近)、addWorker(885,ctl CAS 校验+启动) | High |
| TPE | **execute 四步**(1318): ①wc<core→addWorker(true) ②offer 队列+recheck ③addWorker(false) ④reject | High |
| TPE | **getTask**(1026): timed(allowCoreThreadTimeOut||wc>core)→poll(timeout)超时退/null;否则 take 阻塞 | High |
| TPE | **runWorker**(1107): while(getTask) task.run + before/afterExecute + processWorkerExit | High |
| TPE | **关闭**: shutdown(1369,不中断)/shutdownNow(1400,中断+返回队列)/awaitTermination;四拒绝策略(defaultHandler 554 AbortPolicy/CallerRuns/Discard/DiscardOldest) | High |
| ScheduledThreadPoolExecutor.java | **延迟调度**: DelayedWorkQueue(456,域 10 DelayQueue 思想)、schedule/scheduleAtFixedRate/scheduleWithFixedDelay | High |
| FutureTask.java | **任务状态机**: state(92,7 态 NEW→NORMAL/EXCEPTIONAL/CANCELLED/INTERRUPTED)、outcome(104)、cancel(164)/get(187)/runAndReset(295) | High |
| Executors.java | **工厂**: newFixedThreadPool(91)/newCachedThreadPool(217)/newSingleThreadExecutor(174)/newScheduledThreadPool——参数映射 | Medium |
| CompletionService/ExecutorCompletionService | **完成优先队列**: 完成的任务先取(阻塞队列包装) | Low |

*11 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | ctl 状态机与 Worker | 2 (TPE) | 面试必考(线程池状态/worker 结构) |
| P1 | execute 流程与参数 | 2 (TPE) | 面试必考(执行四步/核心参数) |
| P1 | 关闭与拒绝策略 | 1 (TPE) | 面试高频(优雅关闭/四策略) |
| P1 | FutureTask 状态机 | 1 | 面试高频(cancel/get 语义) |
| P2 | 定时调度 | 1 (STPE) | 面试偶尔 |
| P2 | 工厂与选型 | 1 (Executors) | 面试常问(选型/参数调优) |
| P3 | CompletionService | 1 | 面试低频 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | ctl 与 Worker 结构 | 面试必考(一字段两用/Worker=AQS) |
| 🔴 Deep | execute 流程 | 面试必考(四步判断/队列/拒绝) |
| 🔴 Deep | 关闭与拒绝 | 面试高频(shutdown vs shutdownNow/策略) |
| 🔴 Deep | FutureTask | 面试高频(状态机/取消语义) |
| 🟡 Working | 定时调度 | 面试偶尔 |
| 🟡 Working | 参数调优 | 面试常问(核心/最大/队列怎么配) |

## 04 聚类

### 依赖图(域内)
```
ThreadPoolExecutor ←── ctl(CAS,域 13)/Worker(AQS,域 12)/workQueue(域 10)
execute → addWorker → Worker.run → getTask(队列阻塞,域 10)
FutureTask ←── submit 包装(状态机)
ScheduledThreadPoolExecutor ←── DelayedWorkQueue(域 10 DelayQueue)
Executors(工厂) ←── 参数映射
```

### 教学顺序与文章拆分(5 篇)

1. **TPE 核心: ctl 状态机与 Worker** — 一字段两用、7 状态、Worker 结构(继承 AQS)
2. **execute 流程与参数** — 四步执行、addWorker、核心/最大/队列参数语义、线程扩缩
3. **getTask/runWorker 与线程生命周期** — 阻塞取任务、keepAlive 超时回收、before/afterExecute、worker 退出
4. **关闭与拒绝策略** — shutdown/shutdownNow/awaitTermination、四策略、优雅关闭实践
5. **FutureTask/定时调度/选型** — 状态机、ScheduledThreadPool、Executors 工厂、参数调优与选型

> 前置: 域 10(队列)、11(线程)、12(AQS)。跨层: 线程创建(native,域 03/11);无内部卷强关联
