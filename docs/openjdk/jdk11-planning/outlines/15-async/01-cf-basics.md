# 01. CompletableFuture 基础 — 结果状态、依赖栈、thenApply 链

> 🔴 Deep | 域 15 异步编程第 1 篇(规划终点 4 篇之一)| Layer 6
> 读者处境: 面试"CompletableFuture 原理/回调怎么触发"——结果字段、依赖栈与 then 链。

### 1. "结果怎么存的？" — result + AltResult

场景: `future.complete(v)` 之后——内部状态是什么?

- `CompletableFuture.java:264` — `volatile Object result` — **单字段状态**(null=未完成/结果值/AltResult)
- `CompletableFuture.java:285` `AltResult`: 包装异常(`final Throwable ex` 286,null 表示 NIL 哨兵)
- 发布: `complete(v)` → CAS result → `postComplete`(488)触发依赖
- 关键设计 (斜体): *"一字段两态"——null 未完成,值/AltResult 完成;异常用 AltResult 装箱(避免 result 直接存 Throwable 的歧义);面试"CF 怎么表示异常"——AltResult*
- 面试: "complete 后还能改吗"——不能(一次性);后调 complete 返回 false
- [关联: 域 13 CAS(result 发布)]

### 2. "依赖栈是什么？" — Completion 链

场景: `f.thenApply(...)` 之后——回调存哪?

- `CompletableFuture.java:463` — `Completion extends ForkJoinTask<Void>` — **依赖节点**(回调即任务)
- `pushStack`(279): 依赖**压栈**(后加的在栈顶,LIFO 触发顺序)
- `postComplete`(488): 完成时**遍历栈触发**依赖(每个 Completion 入池执行)
- `cleanStack`(512): 清理失效依赖(栈中已完成的)
- 关键设计 (斜体): *"依赖 = 栈式注册 + 完成时弹栈触发"——后注册先触发(LIFO);面试"thenApply 回调存在哪"——源 future 的 Completion 栈*
- 面试: "依赖线程"——回调由完成方线程触发或提交执行器(第 2 节)

### 3. "thenApply 的实现" — UniApply 节点

场景: `f.thenApply(fn)` — 一步步发生什么?

- `CompletableFuture.java:2098` `thenApply` → `uniApplyStage`(2100 附近)
- `CompletableFuture.java:616` — `UniApply`(UniCompletion 子类): 持 fn + 依赖的 source + 目标 future
- 触发: 源完成 → postComplete → UniApply.tryFire: 源有结果 → `fn.apply` → 目标 result 发布
- 关键设计 (斜体): *"thenApply = 注册 UniApply 节点"——节点持"源+目标+函数";触发链: 源完成 → 节点执行 → 目标完成(链式传播);面试画"依赖链"图*
- 面试: "thenApply vs thenCompose"——apply 返回值,compose 返回新 CF(扁平化,2239)

### 4. "回调在哪个线程跑？" — 执行模型

场景: `thenApply` vs `thenApplyAsync` — 线程差异

- `thenApply`: **同步链**——回调在"源完成线程"直接跑(noAsync 标记)
- `thenApplyAsync`(2103): **提交执行器**——`defaultExecutor()`(2105 调用/2536 定义)= ForkJoinPool.commonPool(域 15 第 3 篇)
- 自定义: thenApplyAsync(fn, executor)
- 关键设计 (斜体): *"同步链 vs 异步回调"——同步快(无提交开销)但阻塞完成线程;异步入池(并行)但有序性由池保证;面试"thenApply 在哪跑"——完成线程(同步链)*
- 面试: "什么时候用 Async"——计算密集/避免阻塞完成方;同步链简单
- [关联: 域 16 并行流同用 commonPool]

---

### 核心悬念

单链通了——**组合与异常**呢?`thenCombine` 的 BiRelay 怎么等两个源?`exceptionally` 怎么接管异常链?`allOf/anyOf` 的批量等待——下一篇: 组合与异常编排。

> → [02-compose-exception.md](02-compose-exception.md)
