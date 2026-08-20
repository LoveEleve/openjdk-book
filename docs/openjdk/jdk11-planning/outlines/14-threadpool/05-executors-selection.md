# 05. Executors 工厂与选型 — 工厂映射、参数调优、生产规范

> 🟡 Working | 域 14 线程池与任务第 5 篇 | Layer 5
> 读者处境: 面试"线程池怎么创建/参数怎么定"——工厂的参数映射与生产调优。

### 1. "Executors 工厂" — 参数映射

场景: `newFixedThreadPool(10)` 背后是什么参数?

- `Executors.java:91` `newFixedThreadPool(n)`: `new ThreadPoolExecutor(n, n, 0, ms, new LinkedBlockingQueue())` — **core=最大=n,无界队列**(任务永不拒,线程固定)
- `Executors.java:217` `newCachedThreadPool()`: `new ThreadPoolExecutor(0, MAX_VALUE, 60s, new SynchronousQueue())` — **core=0,线程即建即收,交接队列**
- `newSingleThreadExecutor`(174): 固定 1 线程 + 无界队列
- 关键设计 (斜体): *"工厂 = 参数套餐"——固定池(常驻+无界队)/缓存池(即用即收+交接);面试"newFixedThreadPool 队列多大"——无界(LinkedBlockingQueue 默认)*
- 面试: "无界队列的坑"——任务无限堆积(OOM 风险);生产禁用无界

### 2. "阿里巴巴规范为什么禁 Executors" — 默认参数风险

场景: 面试/规范"为什么不用 Executors 创建线程池"

- newFixedThreadPool: **无界队列** → 任务堆积 OOM
- newCachedThreadPool: **线程数无上限** → 线程爆炸 OOM
- 规范: 手动 new ThreadPoolExecutor(显式参数)
- 关键设计 (斜体): *"默认参数的边界缺失"——工厂方便但把"队列容量/线程上限"交给默认(危险);面试"Executors 的问题"——无界队列/无界线程*
- 生产: 自定义线程池命名线程工厂(排查友好)+ 有界队列 + 拒绝策略

### 3. "参数调优" — 怎么定 core/最大/队列

场景: 生产线程池参数——依据什么算?

- **CPU 密集**: core = CPU 核数(+1);**IO 密集**: core = 核数×(1+等待/计算)(经验公式)
- 队列: 有界(容量按任务量与峰值评估)
- 最大: 峰值并发需求
- keepAlive: 回收闲置非核心线程
- 关键设计 (斜体): *"参数 = 任务模型的数学"——计算/IO 比例决定线程数,任务积压决定队列;面试"线程池参数怎么配"——按任务类型(CPU/IO)+容量评估;无标准答案,讲思路*
- 生产: 压测验证 + 监控(活跃线程/队列深度)
- [关联: 域 34 JMX(ThreadPoolExecutor 的平台 MBean 监控)]

### 4. "选型全景" — 线程池家族

场景: 单线程/固定/缓存/定时/工作窃取——怎么选?

- newSingleThread: 顺序执行(日志/串行任务)
- newFixedThreadPool: 稳定常驻(通用)
- newCachedThreadPool: 突发短任务(注意线程爆炸)
- newScheduledThreadPool: 定时/周期
- newWorkStealingPool: ForkJoin(域 15)——大任务并行分解
- 关键设计 (斜体): *"选型 = 任务特征"——数量(常驻 vs 突发)/时长(短 vs 长)/依赖(定时/并行分解);面试"什么时候用哪个池"——按特征答*
- 生产: 通用场景自定义固定池(显式参数);并行计算用 ForkJoin(域 15)

---

### 核心悬念

线程池收官——**并行计算的分治之王**来了: `ForkJoinPool` 的 work-stealing、`CompletableFuture` 的异步编排——下一篇(域 15,Layer 6 收官): 异步编程。

> → 下一篇: 域 15 异步编程(15-async 系列) | 关联: 域 13/14
