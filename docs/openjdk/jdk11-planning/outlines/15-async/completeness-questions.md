# 域 15: 异步编程 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "CompletableFuture 原理(result/AltResult)" — 01 篇 §1(CompletableFuture.java:264/285)
- [x] "依赖栈/回调触发" — 01 篇 §2(463/279/488)
- [x] "thenApply vs thenCompose" — 01 篇 §3(2098/2239)
- [x] "回调线程(同步链 vs Async)" — 01 篇 §4(2103/2106)
- [x] "thenCombine 双源/exceptionally 异常接管" — 02 篇 §1-2(1404/2311/2255)
- [x] "allOf/anyOf" — 02 篇 §3(2342)
- [x] "ForkJoinPool work-stealing" — 03 篇 §1-2(WorkQueue 777/780-781)
- [x] "ctl 64 位状态" — 03 篇 §3(336/1293/1284)
- [x] "窃取算法(scan/steal)" — 03 篇 §4
- [x] "ForkJoinTask 状态/fork-join" — 04 篇 §1-2(239-243/699/719)
- [x] "分治写法(RecursiveTask)" — 04 篇 §3(80/93)
- [x] "CountedCompleter vs RecursiveTask" — 04 篇 §4(588)

## 身份 2: 生产工程师
- [x] 异步编排(超时/兜底)— 02 篇 §4
- [x] 并行分治(任务粒度)— 04 篇 §3
- [x] commonPool 阻塞陷阱 — 02 篇 §4/03 篇 §1

## 身份 3: 框架工程师
- [x] 异步框架原理(CF)— 01-02 篇
- [x] 并行引擎(FJP)— 03 篇

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 CompletableFuture.java:264/279/285-286/458/463/488/512/616/1404/2001/2046/2098-2108/2239-2249/2255-2265/2311/2342, ForkJoinPool.java:208/336/730-731/777-789/1284/1293-1295/2395/2434/2494/2563, ForkJoinTask.java:206/239-243/267/322/469/699-704/719-745, RecursiveTask.java:18-24/80/93, RecursiveAction.java:193, CountedCompleter.java:50-56/588)/关键设计/跨层([关联])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] 规划终点域: 写作顺序(00-domain-writing-order.md)6 层拓扑完整覆盖 25 域

## 身份 5: 完整性缺口检查
- [x] 基础(01)/组合异常(02)/FJP(03)/任务分治(04)四篇覆盖域全部面试主战场
- [x] CompletionStage 接口并入 01 篇(契约);ForkJoinWorkerThread 并入 03 篇(线程结构)
- [x] 未覆盖确认: CF 的 orTimeout/completeOnTimeout(JDK9+,02 篇 §4 提及)、ForkJoinTask 的 invokeAll 族(写作时按需)
- [x] 二次 review 修正: doJoin 定义行(391,非 721);FJP 任务获取 JDK11 命名为 nextTaskFor(1854)/nextLocalTask(943)/poll(922),旧 scan/steal 概念同源(03 篇已改);defaultExecutor 定义 2536/调用 2105;orTimeout(2627)/completeOnTimeout(2648) 实测
- [ ] 待办: 写作时验证 CF 的 defaultExecutor 具体实现(commonPool)、FJP 的 ctl 完整位布局、doJoin 的等待实现
