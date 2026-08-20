# 14-threadpool/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `FutureTask`、`AbstractExecutorService`、`ScheduledThreadPoolExecutor`。本文聚焦 FutureTask 状态机、`run/get/cancel`、`set/setException/finishCompletion/awaitDone`，以及 ScheduledThreadPoolExecutor 的 `ScheduledFutureTask`、`DelayedWorkQueue`、固定频率与固定延迟语义；Executors 工厂与大范围参数调优放到下一篇。
> 目标：把“FutureTask 与定时调度”改写成一篇围绕“线程池不仅要执行任务，还必须把结果、异常、取消和等待绑成同一个对象；而定时调度则是在此基础上再加一层时间排序”的机制文章。

## 1. 读者困惑

- `execute()` 和 `submit()` 明明都把任务交给线程池，为什么一个只管执行，另一个还能返回结果？
- `FutureTask` 为什么要有那么多状态，普通“完成/未完成”不够吗？
- `cancel(true)` 为什么不等于一定能停掉任务，它真正改变的是什么？
- `get()` 到底在等什么，异常为什么会从 `get()` 里以 `ExecutionException` 的形式冒出来？
- 定时线程池为什么不是“普通线程池 + sleep”，而是要专门用 `DelayedWorkQueue`？
- `scheduleAtFixedRate` 和 `scheduleWithFixedDelay` 为什么看起来只差一句话，运行语义却完全不同？

## 2. 一句话顿悟

**FutureTask 的核心不是“能拿返回值”，而是把任务执行、结果发布、异常封装、取消竞态和等待者唤醒收进同一个状态机对象；`submit()` 只是把这个对象交给线程池执行，再把它作为 Future 还给调用方。ScheduledThreadPoolExecutor 则在这套结果状态机之上，再加一层按触发时间排序的任务队列，让“什么时候该执行”成为和“执行完后结果怎样落地”并列的另一条约束。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 FutureTask 的 7 个状态、`get` / `cancel` 语义、submit 的包装链，以及 ScheduledThreadPoolExecutor 的 DelayedWorkQueue 与 fixedRate/fixedDelay 差异。
- 已抓到 `execute` 与 `submit` 异常可见性差异，这是线程池实践里的重点。
- 已指出 ScheduledThreadPoolExecutor 不是普通线程池直接复用，而是引入专门的延迟队列和任务类型。

### 必须重写

- 旧稿像分段说明书，需要先立总问题：线程池执行任务后，结果、异常、取消和等待为什么必须跟任务本身绑成同一个对象。
- FutureTask 状态机应从“为什么不能只用 done/not-done 两态”切入，而不是直接列状态值。
- cancel 要强调它争抢的是 NEW 状态的控制权，而不是“撤回已经完成的结果”。
- ScheduledThreadPoolExecutor 部分要从“为什么不能普通线程池 + sleep”切入，突出 DelayedWorkQueue 与时间语义。
- fixedRate/fixedDelay 需要讲成“计划时间驱动 vs 完成时间驱动”的调度哲学差异。

## 4. 理解路径

### 第一节：从“线程池把任务跑了，结果和异常谁来兜住”开场

承接上一章：execute 只保证任务被调度执行，但调用方常常还关心结果、异常、取消和等待。提出总问题：执行者线程和调用者线程如何围绕同一个任务对象达成一致。

### 第二节：FutureTask 为什么必须是一个状态机，而不是简单 done 标志

证据：
- `FutureTask.java:66`：类定义
- `FutureTask.java:77-99`：状态常量与状态迁移注释
- `FutureTask.java:104`：`outcome`

主线：
- 任务完成不只有“成功结束”，还有“抛异常结束”“已取消”“正在中断取消”这些不同结局。
- `COMPLETING` / `INTERRUPTING` 这类过渡态是为了把“结果写入中”与“最终稳定态”分开，避免读者看到半状态。
- 所以 FutureTask 不是多余复杂，而是在用状态机把多线程视角对齐。

### 第三节：`run()` / `set()` / `setException()` 为什么共同决定结果发布

证据：
- `FutureTask.java:228-232`：`set`
- `FutureTask.java:246-250`：`setException`
- `FutureTask.java:254-281`：`run`
- `FutureTask.java:361`：`finishCompletion`

主线：
- `run` 执行 callable / runnable，成功就走 `set`，异常就走 `setException`。
- 两条路径都通过 `NEW → COMPLETING → NORMAL/EXCEPTIONAL` 发布最终结果或异常对象。
- `finishCompletion` 负责把等待者从 park 中唤醒，并调用 done 钩子。

### 第四节：`get()` 到底在等什么，异常为什么从 Future 里再抛一次

证据：
- `FutureTask.java:187-203`：`get()` / `get(timeout)`
- `FutureTask.java:393-443`：`awaitDone`
- `FutureTask.java:118-121` / `498-506`：结果/异常/取消分支

主线：
- get 等的不是线程对象，而是 FutureTask 状态离开中间态并稳定到最终结局。
- `awaitDone` 用 park 等待状态变化，完成后再按 NORMAL / EXCEPTIONAL / CANCELLED 选择返回结果或抛异常。
- 这解释了为什么 submit 的异常常常在 `get()` 时才被调用方观察到。

### 第五节：`cancel()` 为什么只争抢 NEW 状态，而不是回滚历史

证据：
- `FutureTask.java:164-179`：`cancel`
- `FutureTask.java:157` / `161`：`isCancelled` / `isDone`
- `FutureTask.java:331-335`：处理中断中间态的等待

主线：
- cancel 不是“如果不喜欢结果就撤销它”，而是在任务尚未最终完成时，抢一次控制权。
- `cancel(false)` 直接转 `CANCELLED`；`cancel(true)` 走 `INTERRUPTING → INTERRUPTED`，并尽力 interrupt runner。
- 任务已进入最终完成态后，cancel 就不能逆转历史了。

### 第六节：submit 为什么会返回 FutureTask——执行者和调用方其实围着同一个对象协作

证据：
- `AbstractExecutorService.java:92`：`newTaskFor(Runnable, T)`
- `AbstractExecutorService.java:107`：`newTaskFor(Callable)`
- `AbstractExecutorService.java:115-139`：`submit(...)`

主线：
- submit 先把任务包装成 RunnableFuture（默认就是 FutureTask）。
- 然后把这个同一个对象交给 execute 去运行，再把它作为 Future 返回给调用方。
- 线程池执行的是它的 Runnable 面，调用方拿到的是它的 Future 面，本体其实是同一个状态机对象。

### 第七节：为什么定时调度不能只靠普通线程池 + sleep

证据：
- `ScheduledThreadPoolExecutor.java:134`：类定义
- `ScheduledThreadPoolExecutor.java:141-146`：自定义任务类型与队列注释
- `ScheduledThreadPoolExecutor.java:456`：构造器使用 `DelayedWorkQueue`
- `ScheduledThreadPoolExecutor.java:899`：`DelayedWorkQueue`

主线：
- 朴素失败方案：线程池里拿到任务后 sleep 到时间再执行。问题是线程会被提前占住，队列中也无法按最近到期时间重新排序。
- ScheduledThreadPoolExecutor 的真正思路是把“未来执行时间”放进任务本身，并用延迟堆队列只让最先到期的任务出队。
- 这样线程资源只在真正该执行时被占用。

### 第八节：fixedRate 与 fixedDelay 为什么是两种不同的时间哲学

证据：
- `ScheduledThreadPoolExecutor.java:185-236`：`ScheduledFutureTask`
- `ScheduledThreadPoolExecutor.java:307`：周期任务 `reExecutePeriodic`
- `ScheduledThreadPoolExecutor.java:616-625`：`scheduleAtFixedRate`
- `ScheduledThreadPoolExecutor.java:664-673`：`scheduleWithFixedDelay`
- `ScheduledThreadPoolExecutor.java:356`：`reExecutePeriodic`

主线：
- fixedRate 以“计划时刻”为锚点，允许下一轮追赶计划节拍。
- fixedDelay 以“本轮结束时刻”为锚点，保证两轮之间有固定间隔。
- 这不是 API 细节，而是对“时间稳定”与“完成后休息”两种调度目标的不同承诺。

## 5. 失败方案清单

1. 以为执行任务和持有结果天然是两件无关的事，不需要统一状态对象。
2. 用 done/not-done 两态描述 Future，忽略异常、取消和中断中的过渡状态。
3. 把 `cancel(true)` 当成“立即杀掉任务”的强制命令。
4. 任务异常后只看线程池日志，不通过 `get()` 检查 submit 返回的 Future。
5. 用普通线程池 + sleep 模拟定时任务，导致线程提前被占住、调度顺序失真。
6. 把 fixedRate 与 fixedDelay 只记成“两个定时 API”，不区分它们对时间基准的不同承诺。
7. 以为 periodic task 每次执行完后是重新 new 一个全新任务对象。

## 6. 误解清单

1. FutureTask 只是 Future 的一个默认实现，状态机细节不重要。
2. submit 相比 execute 只是多了返回值，没有改变异常处理路径。
3. get 阻塞等待的是执行线程对象结束，而不是任务状态稳定。
4. cancel 成功说明任务一定从未开始执行。
5. ScheduledThreadPoolExecutor 只是普通线程池加一个 delay 参数。
6. fixedRate 一定比 fixedDelay 更“准时”。
7. 定时线程池和 FutureTask 的实现没有关系。

## 7. 证据清单

- `FutureTask.java:66`：类定义
- `FutureTask.java:77-99`：状态与迁移注释
- `FutureTask.java:104`：`outcome`
- `FutureTask.java:164-179`：`cancel`
- `FutureTask.java:187-203`：`get()` / `get(timeout)`
- `FutureTask.java:228-232`：`set`
- `FutureTask.java:246-250`：`setException`
- `FutureTask.java:254-281`：`run`
- `FutureTask.java:361`：`finishCompletion`
- `FutureTask.java:393-443`：`awaitDone`
- `AbstractExecutorService.java:92-107`：`newTaskFor`
- `AbstractExecutorService.java:115-139`：`submit`
- `ScheduledThreadPoolExecutor.java:134`：类定义
- `ScheduledThreadPoolExecutor.java:141-146`：自定义 task/queue 注释
- `ScheduledThreadPoolExecutor.java:185-236`：`ScheduledFutureTask`
- `ScheduledThreadPoolExecutor.java:307`：周期任务重入队
- `ScheduledThreadPoolExecutor.java:356`：`reExecutePeriodic`
- `ScheduledThreadPoolExecutor.java:456`：构造器里的 `DelayedWorkQueue`
- `ScheduledThreadPoolExecutor.java:553-576`：普通 schedule
- `ScheduledThreadPoolExecutor.java:616-625`：`scheduleAtFixedRate`
- `ScheduledThreadPoolExecutor.java:664-673`：`scheduleWithFixedDelay`
- `ScheduledThreadPoolExecutor.java:899`：`DelayedWorkQueue`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 ThreadPoolExecutor 体系里的 FutureTask 与定时调度，不展开 CompletableFuture / ForkJoinTask。
- 不把 cancel 写成强制杀任务语义；中断依旧是协作式。
- 不把 DelayedWorkQueue 深挖成完整堆实现教程，重点放在为什么要有按时间排序的工作队列。
- 周期任务的异常后续处理只点到为止，详细调度边界留给后文选型或应用专题。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么任务执行与结果必须绑成同一状态机对象 → FutureTask 的完成线与取消线 → get 为什么要等状态稳定并把异常重新封装抛出 → submit 为什么返回的其实就是被 execute 执行的同一个 FutureTask → ScheduledThreadPoolExecutor 为什么需要 DelayedWorkQueue → fixedRate 和 fixedDelay 各自对齐哪条时间线”。
- 必须把 FutureTask 状态机讲成本文主线。
- 必须讲清 cancel 只争抢 NEW 状态的控制权。
- 必须把 fixedRate / fixedDelay 讲成时间语义差异，而不只是 API 名字差异。
- 结尾要自然引到 `05-executors-selection.md`。
