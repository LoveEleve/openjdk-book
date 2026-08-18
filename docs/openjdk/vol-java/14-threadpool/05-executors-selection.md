# 05. Executors 工厂与选型 — 工厂映射、参数调优、生产规范

> **前置依赖**: [14-threadpool/01 — ctl 与 Worker](01-ctl-worker.md)(线程池参数)、[14-threadpool/04 — FutureTask 与定时调度](04-futuretask-scheduled.md)(定时池)
> → **后续**: 域 15 异步编程(按写作顺序)
> 关联: 域 34 JMX(生产监控思路)

## Executors 工厂到底封装了什么

`Executors` 是参数套餐工厂。它方便,但也把队列容量、线程上限和拒绝边界藏在了工厂内部。

## 1. "Executors 工厂" — 参数映射

### 1.1 固定线程池

`newFixedThreadPool(nThreads)`(`Executors.java:91`)直接构造:

- `corePoolSize = nThreads`
- `maximumPoolSize = nThreads`
- `keepAliveTime = 0`
- `LinkedBlockingQueue` 无界队列

所以线程数固定,任务会持续进入队列,而不是继续创建超过 `nThreads` 的线程。

### 1.2 缓存线程池

`newCachedThreadPool()`(`:217`)构造:

- `corePoolSize = 0`
- `maximumPoolSize = Integer.MAX_VALUE`
- 空闲线程 60 秒回收
- `SynchronousQueue` 直接交接

它适合突发短任务,但线程上限几乎没有,高峰期必须谨慎。

### 1.3 单线程工厂

`newSingleThreadExecutor()`(`:174`)本质上是 `core=1/maximum=1 + LinkedBlockingQueue`。与直接 new 一个单线程 `ThreadPoolExecutor` 相比,它还通过委托包装限制了重新配置能力。

关键设计(斜体):*"工厂 = 参数套餐"——固定池是常驻线程 + 无界队列,缓存池是按需建线程 + 直接交接。面试"newFixedThreadPool 队列多大": 默认 `LinkedBlockingQueue` 无界。*

## 2. "为什么生产常禁 Executors" — 默认边界风险

### 2.1 两种典型风险

- `newFixedThreadPool`: 无界队列会让任务持续堆积,内存压力不可控
- `newCachedThreadPool`: `maximumPoolSize = Integer.MAX_VALUE`,高峰期可能创建过多线程

这不是说工厂一定不能用,而是生产服务通常需要显式给出:

- 有界队列容量
- 最大线程数
- 拒绝策略
- 命名 `ThreadFactory`

### 2.2 手动构造

生产常见做法是直接构造 `ThreadPoolExecutor`,让容量、线程上限和饱和行为都显式可见。

关键设计(斜体):*"默认参数的边界缺失"——工厂隐藏了队列容量或线程上限,方便和可控之间需要取舍。面试"Executors 的问题": 无界队列/近似无界线程。*

## 3. "参数调优" — 怎么定 core/最大/队列

### 3.1 任务模型

- **CPU 密集**: 常以 CPU 核数附近作为起点
- **IO 密集**: 等待时间较长时,可比 CPU 核数配置更多线程
- **队列**: 有界,按任务大小、峰值流量和可接受延迟评估
- **maximum**: 峰值并发需求与资源上限共同决定
- **keepAlive**: 回收闲置的非核心线程

`CPU 核数 + 1`、`核数 × (1 + 等待/计算)`只能作为经验起点,不是通用定律。

### 3.2 验证方式

参数没有脱离业务的标准答案: 用压测观察活跃线程数、队列深度、任务等待时间、拒绝数量和 GC/CPU,再调整。

关键设计(斜体):*"参数 = 任务模型的数学"——计算/IO 比例影响线程数,任务积压决定队列压力。面试"线程池参数怎么配": 按任务类型 + 容量评估,用压测验证。*

## 4. "选型全景" — 线程池家族

| 任务特征 | 工厂/实现 | 适用方向 |
|---|---|---|
| 顺序执行 | `newSingleThreadExecutor`(`:174`) | 日志、串行任务 |
| 稳定常驻 | `newFixedThreadPool`(`:91`) | 通用固定并发 |
| 突发短任务 | `newCachedThreadPool`(`:217`) | 注意线程峰值 |
| 定时/周期 | `newScheduledThreadPool`(`Executors.java:288`) | 延迟与周期任务 |
| 可分解并行 | `newWorkStealingPool`(`:112`) | ForkJoin 工作窃取 |

`newWorkStealingPool(int)`直接构造 `ForkJoinPool`(`:113-116`),不是 `ThreadPoolExecutor`。

关键设计(斜体):*"选型 = 任务特征"——按常驻/突发、短/长、普通/定时、整体任务/可分解任务选择。面试"什么时候用哪个池": 先看任务特征,再看容量和拒绝边界。*

跨层标注: [第 1 篇——ctl 与参数;第 2 篇——execute 路由;第 3 篇——关闭与拒绝;第 4 篇——FutureTask/定时调度;域 34 JMX——生产监控思路]

## 核心悬念

线程池收官——**并行计算的分治之王**来了: `ForkJoinPool` 的 work-stealing、`CompletableFuture` 的异步编排——下一篇(按写作顺序): 域 15 异步编程。