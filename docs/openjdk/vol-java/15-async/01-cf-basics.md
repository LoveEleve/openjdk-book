# 01. CompletableFuture 基础 — 结果状态、依赖栈、thenApply 链

> **前置依赖**: [13-atomic/01 — 原子与 CAS](../13-atomic/01-atomicinteger-cas.md)(结果发布)、[14-threadpool/04 — FutureTask 与定时调度](../14-threadpool/04-futuretask-scheduled.md)(Future 对照)
> → **后续**: 按写作顺序进入组合与异常编排
> 关联: [16-stream/06 — Spliterator 与并行](../16-stream/06-spliterator-parallel.md)(commonPool 场景)

## CompletableFuture 怎么把异步串起来

`CompletableFuture` 不只是一个 Future: 它把**结果状态、依赖节点、回调执行**放在同一个对象模型里。

## 1. "结果怎么存的?" — result + AltResult

### 1.1 一个字段表示完成状态

`CompletableFuture.java:264`:

```java
// CompletableFuture.java:264(逐字)
    volatile Object result;       // Either the result or boxed AltResult
```

`result` 的三种含义:

- `null`——尚未完成
- 普通值——正常完成
- `AltResult`——完成但结果是 null 或异常

`AltResult`(`:285`)只有一个异常字段 `final Throwable ex`(`:286`);`ex == null` 时它是 **NIL 哨兵**,表示正常完成但结果值为 null。

`completeValue`(`:304`)与 `completeThrowable`(`:318`)通过 CAS 发布结果,完成后调用 `postComplete` 触发依赖。

完成是一次性的: 后续 `complete` 不能覆盖已经发布的 result。

关键设计(斜体):*"一字段两态"——null 表示未完成,值/AltResult 表示已完成;异常用 AltResult 装箱,避免 result 直接存 Throwable 的歧义。面试"CompletableFuture 怎么表示异常": AltResult。*

## 2. "依赖栈是什么?" — Completion 链

### 2.1 注册依赖

调用 `thenApply` 等方法时,回调不会直接执行,而是先成为一个 `Completion` 节点:

- `Completion`(`CompletableFuture.java:463`)继承 `ForkJoinTask<Void>`
- `pushStack`(`:279`)把依赖压入源 Future 的栈
- `cleanStack`(`:512`)清理已经失效的依赖

### 2.2 完成时触发

源 Future 完成后,`postComplete`(`:488`)遍历依赖栈,让每个 Completion 继续推进目标 Future。

栈是后进先出,所以多个依赖注册在同一个源上时,后压入的节点可能先被处理。但这不等于业务回调拥有稳定的全局执行顺序: 异步节点还会提交给 Executor。

关键设计(斜体):*"依赖 = 栈式注册 + 完成时触发"——Completion 挂在源 Future 上,源完成后开始传播。面试"thenApply 回调存在哪": 源 Future 的 Completion 栈。*

## 3. "thenApply 的实现" — UniApply 节点

### 3.1 注册与触发

`thenApply`(`CompletableFuture.java:2098`)调用 `uniApplyStage(null, fn)`(`:2100`)。

`UniApply`(`:616`)保存源依赖、目标 Future 和函数。源完成后,它的 `tryFire`:

1. 读取源结果
2. 调用 `fn.apply`
3. 把返回值发布到目标 Future
4. 继续触发目标 Future 的下游依赖

`thenCompose` 则不是简单保存一个普通返回值,而是把返回的 CompletionStage 扁平化连接到后续链。

关键设计(斜体):*"thenApply = 注册 UniApply 节点"——节点持有源、目标和函数;触发链是源完成 → 节点执行 → 目标完成 → 下游传播。面试画依赖链时,把每个 then 节点画成 Completion。*

## 4. "回调在哪个线程跑?" — 执行模型

### 4.1 同步与异步

- `thenApply`(`:2098`)传入 `null` executor——同步链,由完成源的线程直接推进
- `thenApplyAsync`(`:2103`)传入 `defaultExecutor()`——提交到默认执行器
- `thenApplyAsync(fn, executor)`(`:2108`)——提交到指定执行器

`defaultExecutor()`默认使用 `ForkJoinPool.commonPool`;如果 commonPool 并行度不足,实现退回 `ThreadPerTaskExecutor`(每个异步任务新建线程)。

同步链没有额外提交开销,但回调可能占用完成线程;异步链隔离执行线程,但有任务提交与调度开销。

面试"thenApply 在哪跑": 通常是完成源的线程;面试"什么时候用 Async": 需要隔离阻塞/计算回调时。

关键设计(斜体):*"同步链 vs 异步回调"——同步快但可能阻塞完成方,异步入池但有调度成本。面试"thenApply 与 thenApplyAsync": 关键差异是 executor 参数。*

## 核心悬念

单链通了——**组合与异常**呢?`thenCombine` 怎么等两个源?`exceptionally` 怎么接管异常链?`allOf/anyOf` 怎么做批量等待?——下一篇: 组合与异常编排。