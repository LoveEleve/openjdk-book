# 02. CompletableFuture 组合与异常 — BiRelay、exceptionally、allOf/anyOf

> **前置依赖**: [15-async/01 — CompletableFuture 基础](01-cf-basics.md)(结果与 Completion)、[14-threadpool/04 — FutureTask](../14-threadpool/04-futuretask-scheduled.md)(Future 异常对照)
> → **后续**: [03-forkjoinpool.md](03-forkjoinpool.md)
> 关联: [12-lock-sync/03 — ReentrantLock 与 Condition](../12-lock-sync/03-reentrantlock-condition.md)(汇合等待思想)

## 异步结果怎么组合

单链只是开始。真实编排通常需要等待两个结果、接管异常、等待一批任务或给整条链加超时。

## 1. "thenCombine 等两个源" — BiCompletion

### 1.1 双源汇合

`thenCombine`(`CompletableFuture.java:2139`)调用 `biApplyStage`(`:1244`),创建 `BiApply`(`:1190`)组合节点。它持有两个源 Future、目标 Future 和 `BiFunction`。

只有两个源都完成后,组合函数才会执行,结果再发布到目标。`BiRelay`(`:1404`)是 `allOf` 使用的无函数汇合节点,不要和 `thenCombine` 的 `BiApply` 混淆。

面试"thenCombine vs thenApply": thenApply 是单源链,thenCombine 是双源汇合。

### 1.2 触发方式

两个源的 Completion 都可能推动同一个 `BiRelay`;第一个完成时条件未满足,第二个完成时才真正执行组合。它更像一个异步屏障,但不阻塞线程等待。

关键设计(斜体):*"Bi 依赖 = 双源汇合"——两个源都完成才执行组合函数。面试"thenCombine 原理": 两个源完成后才触发。*

## 2. "异常接管" — exceptionally/whenComplete

### 2.1 两种处理角色

- `exceptionally(fn)`(`CompletableFuture.java:2311`)——异常时执行恢复函数,把异常转换成正常备用值;正常完成时透传原结果
- `whenComplete(fn)`(`:2255`)——无论正常/异常都回调,适合作为观察钩子

`whenComplete` 不负责把异常变成正常值: 观察回调正常完成时,原结果状态继续向下传播;如果观察回调自身抛异常,返回的阶段也可能以该异常完成。要恢复需要 `exceptionally`/`handle`。

### 2.2 异常传播

链上某节点异常后,下游普通阶段通常跳过函数并继续携带异常;最近的 `exceptionally` 可以接管并发布备用值,否则最终 `get`/`join` 抛出包装异常。

面试"join vs get 异常差异": join 抛 `CompletionException`,get 抛 `ExecutionException`。

关键设计(斜体):*"异常 = 数据沿链传播 + 最近接管"——exceptionally 是恢复分支,whenComplete 是观察钩子。面试"异常链怎么处理": 恢复用 exceptionally/handle,记录用 whenComplete。*

## 3. "allOf/anyOf" — 批量等待

### 3.1 allOf

`allOf(CompletableFuture<?>... cfs)`(`CompletableFuture.java:2342`)返回 `CompletableFuture<Void>`: **所有输入都完成**后完成;各输入结果仍需自行 `join/get`。

内部使用 `AndTree`/`BiRelay` 组织多路完成依赖。

### 3.2 anyOf

`anyOf(CompletableFuture<?>... cfs)`(`:2361`)返回 `CompletableFuture<Object>`: **任一输入完成**就完成,结果是先完成者的结果或异常。

关键设计(斜体):*"allOf = N 路汇合,anyOf = 竞速"——一个等待全部,一个等待第一个。面试"等所有任务": allOf 后再分别 join,而不是串行阻塞等待。*

## 4. "编排实战" — 超时与组合

### 4.1 超时与兜底

- `orTimeout`(`:2627`)——超时后让 Future 以超时异常完成
- `completeOnTimeout`(`:2648`)——超时后用默认值完成

`allOf` 本身不提供超时参数,可以给组合 Future 额外设置超时或在各子任务层配置超时。

### 4.2 生产链路

典型链: `supplyAsync → thenApply → exceptionally → thenAccept`。

生产规范:

- 回调内避免再次阻塞,否则可能占满 commonPool
- 异常要有接管或观测出口
- 外部调用设置超时与降级值
- 阻塞任务使用隔离 Executor,不要混入计算池

关键设计(斜体):*"编排 = 数据流图"——每个 then/exceptionally 都是图节点。生产规范: 全链异常接管 + 超时兜底 + 池隔离。面试"异步编排最佳实践": 超时 + 异常 + 执行器隔离。*

## 核心悬念

异步编排通了——**执行引擎**呢?`ForkJoinPool` 的 WorkQueue 双端队列、ctl 状态、work-stealing 算法——为什么它适合并行分治?——下一篇: ForkJoinPool work-stealing。