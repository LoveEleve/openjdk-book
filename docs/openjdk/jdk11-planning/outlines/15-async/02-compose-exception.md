# 02. CF 组合与异常 — BiRelay、exceptionally、allOf/anyOf

> 🔴 Deep | 域 15 异步编程第 2 篇(规划终点 4 篇之二)| Layer 6
> 读者处境: 面试"异步编排"——组合两个 future、异常接管、批量等待。

### 1. "thenCombine 等两个源" — BiCompletion

场景: 两个异步结果合并——依赖怎么组织?

- `CompletableFuture.java:1404` — `BiRelay`(BiCompletion 子类): 持 **两个源**(f/g)+ 目标 + 函数
- 语义: **两个源都完成后**才触发(第二个完成时 tryFire)
- 触发计数: BiCompletion 内部 dep 计数——一个源完成标记,两源齐才执行
- 关键设计 (斜体): *"Bi 依赖 = 双源汇合"——类似屏障(域 12 Barrier 思想);面试"thenCombine 原理"——两个源都完成才执行*
- 面试: "thenCombine vs thenApply"——双源 vs 单源
- [关联: 域 12 CyclicBarrier(汇合思想)]

### 2. "异常接管" — exceptionally/whenComplete

场景: 链上某步失败——怎么恢复?

- `CompletableFuture.java:2311` `exceptionally(fn)` → `uniExceptionallyStage`: **异常时执行 fn 恢复值**(正常时透传)
- `CompletableFuture.java:2255` `whenComplete(fn)`: 无论成败都回调(结果+异常都传)——**旁路观察**
- 异常传播: 链上任一节点异常 → AltResult 向下传播 → 最近 exceptionally 接管或最终 get/join 抛
- 关键设计 (斜体): *"异常 = 数据沿链传播 + 最近接管"——exceptionally 是"恢复分支";whenComplete 是"观察钩子"(不改变结果);面试"异常链怎么处理"——exceptionally/recover 家族*
- 面试: "join vs get 异常差异"——join 抛 CompletionException(包装),get 抛 ExecutionException(域 06)

### 3. "allOf/anyOf" — 批量等待

场景: 等 N 个任务全完成/任一完成

- `CompletableFuture.java:2342` `allOf(CF...)`: **全部完成**才完成(内部 AndRelay 树/链)
- `anyOf(CF...)`: **任一完成**即完成(OrRelay)
- 结果: allOf 返回 Void(各结果自行 get);anyOf 返回先完成者的结果
- 关键设计 (斜体): *"allOf = N 路汇合(DAG),anyOf = 竞速"——批量并发的编排;面试"等所有任务"——allOf 而非循环 join*
- 生产: 并行调用(多个 RPC)聚合(注意: allOf 本身不设超时,需 completeOnTimeout)
- 面试: "allOf 后怎么拿各结果"——join 每个源

### 4. "编排实战" — 超时与组合

场景: 生产异步编排——超时/兜底

- 超时: `orTimeout`/`completeOnTimeout`(JDK9+,默认值兜底)
- 组合链: `supplyAsync → thenApply → exceptionally → thenAccept`(流水线)
- 陷阱: 回调里再阻塞(commonPool 占满,域 16 同问题);异常未接管的静默
- 关键设计 (斜体): *"编排 = 数据流图"——每个 then/exceptionally 是图节点;生产规范: 全链异常接管 + 超时兜底;面试"异步编排最佳实践"——超时+异常+池隔离*
- 生产: 回调内避免阻塞(另起池);链路兜底(默认值/降级)

---

### 核心悬念

异步编排通了——**执行引擎**呢?`ForkJoinPool` 的 WorkQueue 双端队列、ctl 64 位状态、work-stealing 算法——为什么它比 ThreadPoolExecutor 更适合并行分治?——下一篇: ForkJoinPool work-stealing。

> → [03-forkjoinpool.md](03-forkjoinpool.md)
