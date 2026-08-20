# 14-threadpool/05 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Executors`、`ThreadPoolExecutor`、`ScheduledThreadPoolExecutor`。本文聚焦 `newFixedThreadPool`、`newSingleThreadExecutor`、`newCachedThreadPool`、`newScheduledThreadPool`、`newWorkStealingPool` 的参数映射和生产边界；ForkJoinPool 细节留到后续异步/并行专题。
> 目标：把“Executors 工厂与选型”改写成一篇围绕“工厂方法不是偷懒糖，而是把线程数、队列容量、线程上限和拒绝边界打包隐藏起来；生产选型必须先把这些隐藏参数摊开看”的收官文章。

## 1. 读者困惑

- `Executors.newFixedThreadPool()` 看起来很方便，为什么很多生产规范却不推荐直接用？
- `newFixedThreadPool`、`newCachedThreadPool`、`newSingleThreadExecutor`、`newScheduledThreadPool` 到底各自给你拼了什么参数组合？
- 为什么“固定线程池”最危险的地方可能不是线程数，而是它背后默认的无界队列？
- 为什么“缓存线程池”最危险的地方又不是队列，而是几乎无上限的线程增长？
- 线程池参数到底应该怎么选，为什么 `CPU 核数 + 1` 这类公式只能当起点？
- 什么时候应该直接 new `ThreadPoolExecutor`，什么时候工厂方法只是教学和脚手架方便？

## 2. 一句话顿悟

**Executors 工厂方法并不是“更高级的线程池”，而是把一组已经做好的参数套餐直接塞给你：固定池隐藏了无界队列，缓存池隐藏了几乎无上限线程增长，单线程池隐藏了不可轻易重配的串行执行器，定时池隐藏了延迟队列。方便的代价是边界条件被藏起来；生产选型真正需要的不是记住工厂名字，而是先把它们映射到 `core / max / queue / keepAlive / handler` 上，再判断这些默认边界是否真的适合你的任务模型。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 fixed/single/cached/scheduled/work-stealing 工厂的大体映射和生产风险方向。
- 已指出生产常禁 Executors 的两个典型风险：无界队列与近似无界线程数。
- 已把参数调优拉回任务模型和压测验证，这是正确方向。

### 必须重写

- 旧稿更像“工厂速查表”，需要先建立一个更强总问题：方便为什么会换来边界隐藏。
- 各工厂方法应放在“它偷偷替你选了什么队列/上限/回收策略”这条主线上，而不是分散列参数。
- 生产规范部分要讲成失败方案，而不是口号式“别用 Executors”。
- 参数调优需要强调“线程数、队列容量、拒绝策略是一组联动参数”，不是孤立经验值。
- 线程池域收官段要把前 4 篇的机制和这一篇的选型收束起来。

## 4. 理解路径

### 第一节：从“为什么工厂方法越方便，生产越容易踩坑”开场

用最常见误区开场：开发觉得 `Executors.newFixedThreadPool(8)` 很清爽，却看不见它背后到底用了什么队列和饱和边界。指出总问题：线程池真正危险的不是 API 长，而是默认参数把边界藏起来了。

### 第二节：newFixedThreadPool 为什么最容易藏住“无界排队”风险

证据：
- `Executors.java:91`：`newFixedThreadPool(int)`
- `Executors.java:154`：带 ThreadFactory 版本

主线：
- core=max=nThreads，看起来线程数固定。
- 但真正更危险的是默认 `LinkedBlockingQueue` 无界排队，任务会一直堆队列，而不是继续扩线程。
- 因此“固定线程池”真正固定住的可能只是并发执行数，未必固定住系统负担。

### 第三节：newCachedThreadPool 为什么最容易藏住“线程膨胀”风险

证据：
- `Executors.java:217`：`newCachedThreadPool()`
- `Executors.java:233`：带 ThreadFactory 版本

主线：
- core=0、keepAlive=60s、`SynchronousQueue` 直接交接。
- 队列不缓存任务，所以压力会直接转化成不断扩线程。
- 它适合突发短任务，但若任务执行时间长或外部资源慢，线程数会迅速膨胀。

### 第四节：single/scheduled/work-stealing 为什么不是 fixed/cached 的简单别名

证据：
- `Executors.java:174`：`newSingleThreadExecutor`
- `Executors.java:288` / `303`：`newScheduledThreadPool`
- `Executors.java:112` / `128`：`newWorkStealingPool`

主线：
- single 不只是 core=max=1，还通过包装限制重配，强调串行执行语义稳定性。
- scheduled 不是普通池 + delay，而是专门走 `ScheduledThreadPoolExecutor` 与延迟队列。
- work-stealing 根本不是 ThreadPoolExecutor 家族，而是 ForkJoinPool 路线，适合可分解并行任务。

### 第五节：为什么生产常直接 new ThreadPoolExecutor

主线：
- 不是“工厂一定不能用”，而是生产通常需要把队列容量、最大线程数、拒绝策略、线程命名显式摊开。
- 当隐藏边界不可接受时，显式构造比工厂糖更重要。
- 这要讲成能力和边界透明度问题，而不是代码风格偏好。

### 第六节：参数调优为什么不能靠单条经验公式

主线：
- CPU 密集、IO 密集、突发型、定时型任务，对线程数和队列需求完全不同。
- `core / max / queue / keepAlive / handler` 是联动参数，不存在脱离任务模型的通用最优值。
- 常见公式只能当初始猜测，真正收口要靠压测看活跃线程数、队列深度、任务等待时间、拒绝数量、CPU 和 GC。

### 第七节：域 14 收官——从机制到选型

主线：
- 第 1 篇讲联合状态机与 Worker。
- 第 2 篇讲 execute 决策链与 worker 生命周期。
- 第 3 篇讲退场与拒绝语义。
- 第 4 篇讲结果状态机与时间排序。
- 第 5 篇把前四篇收成“按任务模型和边界选线程池”。

## 5. 失败方案清单

1. 因为工厂方法简短，就默认它的隐藏参数也一定安全。
2. 用 `newFixedThreadPool` 却忽略无界队列可能持续积压任务。
3. 用 `newCachedThreadPool` 处理慢任务或高峰任务，却不关注线程数膨胀。
4. 在需要容量、拒绝策略和线程命名透明可控的场景仍完全依赖工厂默认值。
5. 把参数调优简化成“CPU 核数 + 1”这类万能公式。
6. 看到 `newWorkStealingPool` 也叫线程池，就把它当作 TPE 的又一个参数套餐。
7. 只看线程数，不看队列深度、等待时间和拒绝次数就宣布调优完成。

## 6. 误解清单

1. Executors 工厂只是语法糖，除了写法简短没有任何边界差异。
2. fixed thread pool 只要线程数固定，系统负载就自然有上限。
3. cached thread pool 因为会回收空闲线程，所以长期一定安全。
4. single thread executor 只是 fixed(1) 的另一种写法，没有语义差异。
5. scheduled thread pool 本质上和普通线程池一样，只是多了 sleep。
6. 参数调优主要调 core/max，队列和拒绝策略只是补充。
7. 只要压测吞吐够高，线程池参数就一定合理。

## 7. 证据清单

- `Executors.java:91`：`newFixedThreadPool(int)`
- `Executors.java:154`：`newFixedThreadPool(int, ThreadFactory)`
- `Executors.java:174`：`newSingleThreadExecutor()`
- `Executors.java:193`：带 ThreadFactory 的 single
- `Executors.java:217`：`newCachedThreadPool()`
- `Executors.java:233`：带 ThreadFactory 的 cached
- `Executors.java:288` / `303`：`newScheduledThreadPool`
- `Executors.java:112` / `128`：`newWorkStealingPool`
- `ThreadPoolExecutor.java` / `ScheduledThreadPoolExecutor.java`：作为参数套餐落点的实际构造目标（正文中按需回钩）

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 Executors 工厂与 TPE/ScheduledTPE 的参数映射，不展开 ForkJoinPool 工作窃取细节。
- 不把“别用 Executors”绝对化，强调的是默认边界透明度问题，不是 API 本身有错。
- 调优建议保持工程边界，只给任务模型与验证方法，不给伪精确万能公式。
- 域 14 收官后自然转向域 15 异步编排与 ForkJoin/CompletableFuture 生态。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“工厂方法藏了哪些参数边界 → fixed 为什么真正危险在无界队列 → cached 为什么真正危险在线程膨胀 → single/scheduled/work-stealing 为什么各自代表不同任务语义 → 生产上为什么常显式 new ThreadPoolExecutor → 参数调优为什么必须结合任务模型和压测数据”。
- 必须把‘方便’与‘边界透明度’的取舍讲透。
- 必须让收束段把域 14 五篇逻辑连起来。
- 必须强调参数联动，而不是孤立经验值。
- 结尾要自然衔接域 15 异步编排或 ForkJoin/CompletableFuture 路线。
