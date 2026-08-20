# 15-async/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ForkJoinPool`。本文聚焦 `WorkQueue`、`base/top/array`、`ctl`、`signalWork`、`scan`、`poll` / `push` / `pop`、commonPool 与工作窃取主线；ForkJoinTask 任务状态机与 API 放到下一篇。
> 目标：把“ForkJoinPool work-stealing”改写成一篇围绕“为什么分治并行池不能让所有线程争抢同一个共享队列，而必须让每个 worker 先管自己的双端队列，再在空闲时去窃取别人底端任务”的机制文章。

## 1. 读者困惑

- 线程池已经有 BlockingQueue 了，为什么 ForkJoinPool 还要自己造 WorkQueue？
- 为什么分治任务特别适合“本地队列 + 工作窃取”，而普通共享队列不够？
- `top` 和 `base` 分别是谁在动，为什么 owner 和窃取者要从不同端取任务？
- 池级 `ctl` 为什么要用 64 位长整型，它到底在同时管什么？
- 没活干的 worker 为什么不是简单地阻塞在队列上，而是要先扫描、再失活、再等待被唤醒？
- commonPool 为什么能被 CompletableFuture Async 和并行流同时拿来当默认执行器？

## 2. 一句话顿悟

**ForkJoinPool 要优化的不是“把任务塞进线程池”这件事，而是“分治任务会不断在 worker 内部裂变出更多子任务”这条特点。若所有子任务都进同一个共享队列，线程会围着一个热点抢活；所以 FJP 给每个 worker 一条本地双端队列：自己从 top 端以 LIFO 方式吃刚生成的子任务，空闲线程再从别人 base 端以 FIFO 方式偷较老任务。这样，本地缓存局部性和全局负载均衡都能兼顾。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 commonPool、WorkQueue 的 base/top/array、ctl 64 位控制字和窃取扫描主线。
- 已指出 owner 从 top 端、本地优先，窃取者从 base 端拿任务，这个抓手是对的。
- 已把 ForkJoinTask 细节留到下一篇，边界划分合理。

### 必须重写

- 旧稿较像结构说明书，需要先建立总问题：为什么分治并行池不能复用普通共享队列线程池模型。
- WorkQueue 需要先讲“谁生成任务、谁消费任务、为什么本地优先”，再谈字段结构。
- `ctl` 要强调它在调 worker 活跃/等待状态，而不是只说“64 位打包”。
- 扫描与失活要讲成“没活时怎么找活、找不到如何休眠、来活后怎么唤醒”的整条链。
- 收束段要把 FJP 与 CompletableFuture / 并行流默认执行器关系讲清楚。

## 4. 理解路径

### 第一节：从“为什么分治任务不能都进一个共享队列”开场

用递归分治场景开场：一个任务拆成两个、四个、八个子任务，如果每次 fork 都把子任务塞进全局共享队列，所有 worker 就会围着同一热点取活。指出失败方案：共享队列模型在任务不断裂变的场景下会把本地局部性和全局并发都拖垮。

### 第二节：WorkQueue 为什么是双端队列，而不是普通 FIFO

证据：
- `ForkJoinPool.java:777`：`WorkQueue`
- `ForkJoinPool.java:780`：`base`
- `ForkJoinPool.java:781`：`top`
- `ForkJoinPool.java:842`：`push`
- `ForkJoinPool.java:922`：`poll`
- `ForkJoinPool.java` 前部类注释 `227-248`：双端操作语义说明

主线：
- owner 自己 push/pop top，偏向 LIFO，优先吃刚拆出的新任务，保持缓存局部性。
- 窃取者从 base 端 poll，拿较老任务，尽量和 owner 分离冲突端点。
- 双端结构不是为了炫技巧，而是把“本地连续执行”和“外来救火窃取”分离到不同端口。

### 第三节：为什么本地优先 + 窃取后备能同时满足局部性和负载均衡

证据：
- `ForkJoinPool.java:943`：`nextLocalTask`
- `ForkJoinPool.java:1016`：`topLevelExec`
- `ForkJoinPool.java:1854`：`nextTaskFor`

主线：
- 本地队列优先意味着一个 worker 会先继续吃自己刚拆出的任务，减少线程间迁移。
- 只有自己没活了，才去别人那里偷，补负载不均。
- 这样形成“先局部深挖，再全局均衡”的执行策略，非常契合分治树形任务。

### 第四节：ctl 为什么要管“活跃/等待工人”而不只是线程数量

证据：
- `ForkJoinPool.java:1312`：`ctl`
- `ForkJoinPool.java:1260-1263`：ctl 子字段注释
- `ForkJoinPool.java:734-739`：phase 与 ctl 相关掩码说明
- `ForkJoinPool.java:402-435`：等待栈与 phase 说明（正文按需引用）

主线：
- FJP 的难点不是 worker 总数，而是谁正忙、谁已失活、谁在等待被重新叫醒。
- `ctl` 把这些池级控制事实压成一个 64 位原子快照，避免多变量协调中间态。
- 这里要讲成“池级调度控制字”，而不是位运算知识点。

### 第五节：没活时 worker 为什么先扫描，再失活，再等 signalWork

证据：
- `ForkJoinPool.java:468-486`：scan 注释
- `ForkJoinPool.java:527` / `571`：`tryCompensate`、资源与补偿语义（按需点到）
- `ForkJoinPool.java:852`：`signalWork`
- `ForkJoinPool.java` 中 `scan` / `pollScan` 相关代码区域（正文按锚点和注释主线展开）

主线：
- worker 先随机/轮转扫描别人队列寻找可偷任务。
- 找不到才进入失活/等待结构，而不是立刻长期阻塞在固定队列上。
- 新任务到达时由 `signalWork` 负责把等待 worker 叫醒，重新参与扫描。
- 这条链要讲成“分治池的空闲恢复机制”。

### 第六节：commonPool 为什么会成为 CompletableFuture Async 和并行流的默认后端

证据：
- `ForkJoinPool.java:2395`：`commonPool()`
- `ForkJoinPool.java:2563`：`getCommonPoolParallelism()`
- 结合上一篇 CF 的 Async 默认执行器语义回钩

主线：
- commonPool 是全局共享分治执行池。
- CompletableFuture Async、并行流默认复用它，是因为它在细粒度异步任务和可拆分任务上比普通共享队列池更能控制竞争。
- 这也引出下一篇：执行引擎讲完，真正承载任务裂变语义的是 ForkJoinTask 本身。

## 5. 失败方案清单

1. 把 fork 出来的子任务全部扔进一个共享阻塞队列，期待分治吞吐自然变高。
2. 让 owner 和窃取者都从同一端拿任务，制造高冲突热点。
3. 把窃取理解成“总是比本地执行更快”。
4. 以为 ctl 只是线程数打包字段，而不看它对活跃/等待 worker 的控制作用。
5. worker 一没活就长期沉睡，不先扫描别人队列寻找工作。
6. 把 commonPool 当成“任何异步任务都免费适合”的万能执行器。

## 6. 误解清单

1. ForkJoinPool 只是换了个名字的 ThreadPoolExecutor。
2. WorkQueue 是普通 FIFO 队列，多一个 base/top 只是实现细节。
3. 工作窃取意味着线程总是在偷别人的任务，而不是优先干自己的活。
4. 本地 LIFO 和窃取 FIFO 只是性能微调，不影响设计主线。
5. ctl 64 位只是为了能存更大线程数。
6. 没活时 worker 会像普通线程池那样简单阻塞在共享队列上。
7. CompletableFuture Async 默认用 commonPool 只是随便选了一个池。

## 7. 证据清单

- `ForkJoinPool.java:178`：类定义
- `ForkJoinPool.java:227-248`：双端队列与 owner/stealer 说明
- `ForkJoinPool.java:402-435`：等待栈与 phase 注释
- `ForkJoinPool.java:468-486`：scan 注释
- `ForkJoinPool.java:734-739`：phase/ctl 掩码说明
- `ForkJoinPool.java:777`：`WorkQueue`
- `ForkJoinPool.java:780`：`base`
- `ForkJoinPool.java:781`：`top`
- `ForkJoinPool.java:842`：`push`
- `ForkJoinPool.java:922`：`poll`
- `ForkJoinPool.java:943`：`nextLocalTask`
- `ForkJoinPool.java:1016`：`topLevelExec`
- `ForkJoinPool.java:1312`：`ctl`
- `ForkJoinPool.java:1854`：`nextTaskFor`
- `ForkJoinPool.java:2395`：`commonPool()`
- `ForkJoinPool.java:2563`：`getCommonPoolParallelism()`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦池与队列层设计，不展开 ForkJoinTask 状态机、join 语义和任务 API，那些放到下一篇。
- 不把 ctl 位域讲成完整编码教程，重点放在其承担的池级控制职责。
- commonPool 只解释默认后端角色，不延伸到所有安全使用边界。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么分治池不能用单一共享队列 → WorkQueue 为什么是 owner LIFO / stealer FIFO 的双端队列 → 本地优先和工作窃取怎样兼顾局部性与均衡 → ctl 如何协调活跃/等待 worker → 没活时 worker 如何扫描、失活、再被 signalWork 唤醒 → commonPool 为什么会成为默认异步后端”。
- 必须把双端队列与工作窃取讲成本文主线。
- 必须把 ctl 讲成调度控制字，而不是线程计数器。
- 必须自然引到 `04-forkjointask.md`。
