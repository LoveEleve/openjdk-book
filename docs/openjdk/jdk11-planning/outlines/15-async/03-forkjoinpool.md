# 03. ForkJoinPool work-stealing — 双端队列、ctl 状态、窃取算法

> 🔴 Deep | 域 15 异步编程第 3 篇(规划终点 4 篇之三)| Layer 6
> 读者处境: 面试"ForkJoinPool 原理/并行流引擎"——工作窃取与 commonPool。

### 1. "ForkJoinPool 是什么？" — 并行分治池

场景: 并行流(域 16)/CF 异步回调跑在哪?

- `ForkJoinPool.java` — **工作窃取池**: 每线程一个双端队列,空闲线程**窃取**别人的任务
- `commonPool()`(2395)— **全局共享池**(CF 异步/并行流用);`getCommonPoolParallelism`(2563)
- 与 ThreadPoolExecutor 对比: TPE 共享队列+竞争;FJP 每线程私队列+窃取(域 14)
- 关键设计 (斜体): *"私队列 + 窃取"消除队列竞争——本线程 LIFO(缓存友好)取自己任务,空闲时 FIFO 偷别人;面试"FJP 与 TPE 区别"——窃取 vs 共享队列*
- 面试: "谁用 commonPool"——parallelStream/CF Async 默认(域 14/16 关联)
- [关联: 域 14 线程池对比;域 16 并行流]

### 2. "WorkQueue 结构" — 双端队列

场景: 每个 worker 的队列长什么样?

- `ForkJoinPool.java:777` — `static final class WorkQueue`: `base`(780,底/窃取端)+ `top`(781,顶/私有端)+ `array`(ForkJoinTask[],787 附近)
- 双端语义: **owner 从 top push/pop(LIFO)**,**窃取者从 base poll(FIFO)**
- 注册: 提交的任务进共享队列(submit,2494)或 worker 私有队列(fork)
- 关键设计 (斜体): *"双端 = 双向竞争分离"——owner 用顶(最近任务),窃取者用底(最旧任务)——窃取粒度大减少冲突;面试"为什么双端"——本线程 LIFO+窃取 FIFO*
- 面试: "work-stealing 为什么高效"——忙碌线程不空闲 + 窃取粒度权衡
- [关联: 域 08 Deque(双端队列概念)]

### 3. "ctl 状态" — 64 位打包

场景: 池的状态怎么原子管理?

- `ForkJoinPool.java:336` 注释 — `ctl` **64 位**: worker 总数/活跃数/等待栈/版本等(**多字段打包**,域 14 ctl 的扩展版)
- 关键位: `TC_SHIFT = 32`(1293,总 worker 计数)/`SP_MASK`(1284,等待栈指针)
- 原子更新: CAS 整个 ctl
- 关键设计 (斜体): *"ctl = 池状态的原子快照"——活跃/总数/栈在一个 long 里,CAS 一致更新;面试"FJP 状态管理"——64 位 ctl*
- 面试: "为什么 64 位"——字段多(域 14 的 int 装不下)
- [关联: 域 14 ctl 一字段两用(同思想升级版)]

### 4. "窃取算法" — 任务获取与扫描

场景: 线程空闲时——怎么找活干?

- 任务获取(JDK11 命名): `nextTaskFor(WorkQueue)`(ForkJoinPool.java:1854)— 本地取 `nextLocalTask`(943,top 端 LIFO)/窃取 `poll`(922,base 端 FIFO);旧版 scan/steal 概念同源
- 扫描: 随机扫描其他 workQueues(188 注释"randomized scans")→ 找到非空队列 → **从 base 偷一个任务**(poll)
- 失败重试/休眠: 扫描不到 → 失活(ctl 栈登记,388 注释)→ 阻塞;新任务提交时唤醒
- 关键设计 (斜体): *"窃取 = 随机扫描 + 底端取 + 失败休眠"——随机性避免线程都抢同一队列;面试"work-stealing 流程"——扫描/窃取/休眠三态*
- 面试: "窃取不到的线程干嘛"——失活阻塞(ctl 栈),新任务唤醒
- [关联: 域 11 park/unpark(休眠唤醒)]

---

### 核心悬念

引擎通了——**任务怎么写**?`ForkJoinTask` 的状态机、`fork()/join()` 的语义、`RecursiveTask` 的分治示例、`CountedCompleter` 的计数完成——下一篇: ForkJoinTask 与分治(最终篇)。

> → [04-forkjointask.md](04-forkjointask.md)
