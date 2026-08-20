# 14-threadpool/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ThreadPoolExecutor`。本文聚焦 `shutdown`、`shutdownNow`、`interruptIdleWorkers`、`interruptWorkers`、`drainQueue`、`awaitTermination`、`tryTerminate`、`reject` 与四个内置 `RejectedExecutionHandler`；FutureTask 和定时调度放后续篇章。
> 目标：把“线程池关闭与拒绝策略”改写成一篇围绕“线程池不只是要会干活，还必须在满载和退场时明确表达系统如何降级、谁继续做、谁被拒绝、谁负责善后”的机制文章。

## 1. 读者困惑

- `shutdown()` 和 `shutdownNow()` 看起来都像关闭线程池，为什么语义差这么大？
- 为什么 `shutdown()` 只中断空闲 worker，不中断正在执行任务的线程？
- `shutdownNow()` 返回的 `List<Runnable>` 到底是什么，为什么不是所有没完成的任务？
- `awaitTermination()` 到底在等什么，为什么生产代码常写成“shutdown → await → 超时再 shutdownNow”？
- 线程池什么时候才真正进入 `TERMINATED`，为什么中间还要经过 `tryTerminate()`？
- 拒绝策略不是“抛个异常”这么简单吗，为什么 `CallerRunsPolicy` 会改变系统背压语义？

## 2. 一句话顿悟

**线程池的关闭和拒绝不是善后细节，而是状态机最敏感的两条退场路径：`shutdown` 代表‘不再接新活，但把队列旧账清完’，`shutdownNow` 代表‘尽快打断并退回还没开工的活’；而拒绝策略则定义了当 core、queue、max 都顶满后，系统是抛错、让调用者背压执行、静默丢弃，还是丢掉最旧任务让新任务挤进来。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 shutdown / shutdownNow 差异、awaitTermination 模式、tryTerminate 终态切换与四种拒绝策略。
- 已抓到 `CallerRunsPolicy` 的背压意义和 shutdownNow 返回未执行队列任务的关键点。
- 已把 `tryTerminate` 作为真正到达 `TERMINATED` 的核心入口，这是重要抓手。

### 必须重写

- 旧稿较像说明书，需要先立住总问题：线程池不仅要运行，还要定义如何优雅退场和满载退化。
- shutdown / shutdownNow 应从“任务还没跑完时系统到底承诺什么”切入，而不只是列调用动作。
- awaitTermination 要回到 tryTerminate 的状态机逻辑里，讲清在等谁归零。
- 拒绝策略要讲成饱和语义选择，而不是四个类名罗列。
- 需要强调：队列任务、正在运行任务、尚未开始任务在关闭语义里是三种不同命运。

## 4. 理解路径

### 第一节：从“线程池怎么关才不丢活”开场

用发布停机/服务下线场景开场：任务已经进池，有些在跑、有些在队列里、有些还在不断提交。提出核心问题：关闭线程池不是“全停”，而是必须先决定当前对这些不同阶段任务的承诺。

### 第二节：shutdown 为什么代表“停接新活，但清完旧账”

证据：
- `ThreadPoolExecutor.java:1369-1380`：`shutdown`
- `ThreadPoolExecutor.java:809-810`：`interruptIdleWorkers()`
- `ThreadPoolExecutor.java:346-367`：状态迁移注释（回扣上一章）

主线：
- 状态推进到 `SHUTDOWN` 后，不再接收新任务。
- 队列里已接住的任务仍被视为要履行的旧账，所以继续处理。
- 只中断空闲 worker，是为了把卡在 take/poll 上的工人叫醒重新检查状态，而不是粗暴打断正在执行的业务任务。

### 第三节：shutdownNow 为什么更像“尽快清场”而不是“立即消灭一切”

证据：
- `ThreadPoolExecutor.java:1400-1412`：`shutdownNow`
- `ThreadPoolExecutor.java:758`：`interruptWorkers`
- `ThreadPoolExecutor.java:842`：`drainQueue`

主线：
- 状态直接推进到 `STOP`。
- 尽力中断所有 worker，但中断是协作式请求，不等于线程瞬间消失。
- `drainQueue()` 只退回还没开始执行、仍躺在队列里的任务；已经跑起来的任务不在返回列表里。
- 这要和 shutdown 做清晰对照：一个保旧账，一个尽快止损。

### 第四节：awaitTermination 为什么不是“等个时间”，而是在等状态机真正到终态

证据：
- `ThreadPoolExecutor.java:473`：`termination` Condition
- `ThreadPoolExecutor.java:1445`：`awaitTermination`
- `ThreadPoolExecutor.java:701-721`：`tryTerminate`

主线：
- awaitTermination 等的不是“sleep 一会儿”，而是 `TERMINATED` 真的到来。
- 终态到来条件不是单一标志位，而是 runState、queue、workerCount 一起满足，最终由 `tryTerminate()` 推到 `TIDYING → TERMINATED`。
- 这解释了为什么生产代码常写“先 shutdown，再限时 await，不行再 shutdownNow”：先给旧账一个收尾窗口，再切强制清场语义。

### 第五节：tryTerminate 为什么才是线程池真正收口的地方

证据：
- `ThreadPoolExecutor.java:701-721`：`tryTerminate`
- `ThreadPoolExecutor.java:709`：`interruptIdleWorkers(ONLY_ONE)`
- `ThreadPoolExecutor.java:720`：`ctl.set(ctlOf(TERMINATED, 0))`

主线：
- 线程池不是一调用 shutdown 就终止，而是反复在关键点尝试“现在是否已经满足终态条件”。
- `SHUTDOWN` 下还得看队列是否清空；`STOP` 下还得看 workerCount 是否归零。
- 只有最后一个工人退出、旧账清理完毕，线程池才能进入真正终态并 signalAll 唤醒 awaitTermination 的等待者。

### 第六节：拒绝策略为什么本质上是在定义系统满载时怎么退化

证据：
- `ThreadPoolExecutor.java:824-825`：`reject`
- `ThreadPoolExecutor.java:554-555`：默认 `AbortPolicy`
- `ThreadPoolExecutor.java:2012`：`CallerRunsPolicy`
- `ThreadPoolExecutor.java:2039`：`AbortPolicy`
- `ThreadPoolExecutor.java:2063`：`DiscardPolicy`
- `ThreadPoolExecutor.java:2084`：`DiscardOldestPolicy`

主线：
- Abort：最快暴露错误，调用方必须处理。
- CallerRuns：调用者线程自己执行，天然形成背压减速。
- Discard：静默丢弃，适合可丢任务但风险极高。
- DiscardOldest：牺牲队列里最老任务，把最新任务塞进来。
- 核心不在背名字，而在理解系统满载时，你到底更愿意暴露错误、拖慢提交方，还是丢任务。

### 第七节：把关闭语义和拒绝语义放回同一张图

主线：
- 关闭语义回答“已有任务怎么办”。
- 拒绝语义回答“新任务再来怎么办”。
- 两者共同构成线程池的退场和满载边界，决定系统在极限状态下如何失效。

## 5. 失败方案清单

1. 以为 shutdown 等于立刻停掉所有任务。
2. 用 shutdownNow 却期待正在运行的任务必然马上终止。
3. 把 shutdownNow 返回列表当成“所有没完成的任务”集合。
4. 不做 awaitTermination，就假定线程池一定能在退出前自己收干净。
5. 线程池满载时仍然默认只看吞吐，不先定义拒绝/背压语义。
6. 盲用 DiscardPolicy，却没有上层补偿或监控。
7. 以为 CallerRunsPolicy 只是“换个线程跑”，没看到它在给提交方施加背压。

## 6. 误解清单

1. shutdown 和 shutdownNow 只是“温和/强硬”程度不同，其他都一样。
2. interruptIdleWorkers 说明线程池想把所有 worker 都打断。
3. awaitTermination 超时返回 false 说明线程池状态异常。
4. tryTerminate 只是一个内部优化，终态与否主要靠 shutdown() 调用时刻决定。
5. AbortPolicy 只是默认值，业务上随便换一种都差不多。
6. CallerRunsPolicy 一定更安全，因为它不会丢任务。
7. 线程池拒绝只发生在队列满时，与 runState 无关。

## 7. 证据清单

- `ThreadPoolExecutor.java:346-367`：状态迁移注释
- `ThreadPoolExecutor.java:473`：`termination` Condition
- `ThreadPoolExecutor.java:554-555`：默认 `AbortPolicy`
- `ThreadPoolExecutor.java:701-721`：`tryTerminate`
- `ThreadPoolExecutor.java:758`：`interruptWorkers`
- `ThreadPoolExecutor.java:783`：`interruptIdleWorkers(boolean)`
- `ThreadPoolExecutor.java:809-810`：`interruptIdleWorkers()`
- `ThreadPoolExecutor.java:824-825`：`reject`
- `ThreadPoolExecutor.java:842`：`drainQueue`
- `ThreadPoolExecutor.java:1369-1380`：`shutdown`
- `ThreadPoolExecutor.java:1400-1412`：`shutdownNow`
- `ThreadPoolExecutor.java:1445`：`awaitTermination`
- `ThreadPoolExecutor.java:2012`：`CallerRunsPolicy`
- `ThreadPoolExecutor.java:2039`：`AbortPolicy`
- `ThreadPoolExecutor.java:2063`：`DiscardPolicy`
- `ThreadPoolExecutor.java:2084`：`DiscardOldestPolicy`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 ThreadPoolExecutor 本体的关闭与拒绝语义，不展开 FutureTask、定时任务与工作窃取线程池。
- 中断语义依旧是协作式；正文不能把 shutdownNow 写成“保证立即停机”。
- 不把拒绝策略写成性能选项，而是系统降级语义选项。
- awaitTermination 的正确使用要和状态机一起理解，不单独抽成工具方法背诵。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“shutdown 如何保旧账、shutdownNow 如何尽快止损、awaitTermination 为什么是在等 tryTerminate 推到终态、为什么已运行任务/队列任务/新提交任务在关闭语义里命运不同、拒绝策略如何定义系统满载时的退化方式”。
- 必须把关闭与拒绝放在同一条‘退场语义’主线上讲。
- 必须讲清 shutdownNow 返回列表的边界。
- 必须把 CallerRunsPolicy 的背压含义讲明白。
- 结尾要自然引到 `04-futuretask-scheduled.md`。
