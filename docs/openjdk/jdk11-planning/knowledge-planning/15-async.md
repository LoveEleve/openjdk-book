# 域 15: 异步编程 — 知识规划

> 源码路径: java.base/share/classes/java/util/concurrent/{CompletableFuture(2,899),CompletionStage(865),ForkJoinPool(3,232),ForkJoinTask(1,547),RecursiveTask(98),RecursiveAction(193),CountedCompleter(781),ForkJoinWorkerThread(243)}.java
> 源码量: 8 文件 / ~10,000 行 | 非巨型域(面试密度极高,拆 4 篇)
> 写作层: Layer 6(前置: 域 12/13/14;25 域规划终点)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| CompletableFuture.java (2899) | **结果与异常**: result(264,volatile Object)/AltResult(285,装箱异常,ex 286)/NESTED 标记(458)——单字段状态 | High |
| CF | **依赖栈**: Completion extends ForkJoinTask(463)/pushStack(279)/postComplete(488,完成时触发依赖)/cleanStack(512,清理失效依赖) | High |
| CF | **单依赖**: UniApply(616,thenApply 的依赖节点)/UniCompletion——thenApply(2098)/thenCompose(2239,扁平化) | High |
| CF | **组合依赖**: BiRelay(1404,thenCombine)/BiCompletion——whenComplete(2255)/exceptionally(2311) | High |
| CF | **结果获取**: get(2001)/join(2046,不抛受检)/complete(结果发布) | High |
| CompletionStage.java (865) | **阶段接口**: then* 家族的契约定义 | Medium |
| ForkJoinPool.java (3232) | **工作窃取池**: WorkQueue 双端队列(208 注释)/ctl 64 位状态(336 注释,worker 计数+栈)/SMASK(730)/MAX_CAP(731) | High |
| FJP | **调度**: scan/steal(窃取)/runWorker/workQueue 注册/submit(2494)/execute(2434)/commonPool(2395)/getCommonPoolParallelism(2563) | High |
| ForkJoinTask.java (1547) | **任务基类**: 状态机(记录在 status 字段)/fork(159 附近)/join(719)/externalAwaitDone(322)/recordExceptionalCompletion(469)/exec 抽象 | High |
| RecursiveTask.java (98) | **返回值分治**: compute(80)抽象/exec(93)——分治任务写法 | Medium |
| CountedCompleter.java (781) | **计数完成**: pending count(50-56 注释)/tryComplete(完成计数归零时触发 onCompletion)——复杂 DAG 用 | Medium |

*11 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | CF 依赖机制(Completion 栈) | 3 (CF/CompletionStage) | 面试高频(回调如何触发) |
| P1 | CF 编排(then/exceptionally/allOf) | 1 (CF) | 面试高频(异步编排) |
| P1 | ForkJoin work-stealing | 2 (FJP) | 面试常问(窃取算法) |
| P1 | ForkJoinTask 分治 | 4 (FJT/RecursiveTask/Action/CC) | 面试常问(分治写法) |
| P2 | commonPool 语义 | 1 | 生产(并行流关联,域 16) |
| P3 | CountedCompleter 细节 | 1 | 面试低频 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | CF 依赖链与回调触发 | 面试高频(thenApply 原理/回调线程) |
| 🔴 Deep | CF 异常与编排 | 面试高频(exceptionally 链/超时) |
| 🔴 Deep | ForkJoin work-stealing | 面试常问(双端队列/窃取) |
| 🔴 Deep | 分治任务写法 | 面试常问(ForkJoin 示例) |
| 🟡 Working | commonPool | 生产(并行流,域 16) |
| 🟢 Surface | CountedCompleter | 面试低频 |

## 04 聚类

### 依赖图(域内)
```
CompletionStage(接口) ←── CompletableFuture(实现)
CF 依赖: Completion(ForkJoinTask) ←── UniCompletion/BiCompletion ←── UniApply/BiRelay
ForkJoinPool ←── WorkQueue(双端)/ctl(状态)
ForkJoinTask ←── RecursiveTask/RecursiveAction/CountedCompleter
CF 的异步回调 ←── ForkJoinPool.commonPool(执行)
```

### 教学顺序与文章拆分(4 篇)

1. **CompletableFuture 基础** — result/AltResult 状态、Completion 依赖栈、thenApply/thenCompose、join/get、回调执行线程
2. **CF 组合与异常** — thenCombine/BiRelay、whenComplete/exceptionally、allOf/anyOf、超时(completeOnTimeout 等)、异步编排实践
3. **ForkJoinPool work-stealing** — WorkQueue 双端队列、ctl 状态机、scan/steal、commonPool、与 ThreadPoolExecutor 对比
4. **ForkJoinTask 与分治** — 任务状态机、fork/join、RecursiveTask 示例、CountedCompleter、生产分治实践

> 前置: 域 12/13/14。跨层: 无 native;并行流(FJP)衔接域 16
