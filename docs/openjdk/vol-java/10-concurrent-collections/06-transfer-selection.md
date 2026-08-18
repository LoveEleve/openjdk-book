# 06. TransferQueue 与并发集合选型 — 传递语义、全景矩阵

> **前置依赖**: [10-concurrent-collections/05 — 阻塞队列](05-blocking-queues.md)(BlockingQueue 契约)、[10-concurrent-collections/01 — CHM 存储与读写](01-chm-storage-rw.md)(Map 并发)
> → **后续**: 域 14 线程池与任务(按写作顺序)
> 关联: [12-lock-sync/03 — ReentrantLock 与 Condition](../12-lock-sync/03-reentrantlock-condition.md)(阻塞条件)

## 传递和选型

域 10 收官看两件事: `TransferQueue` 比普通阻塞队列多了什么,以及并发集合到底怎么选。

## 1. "TransferQueue 是什么?" — 阻塞传递

### 1.1 transfer 与 put

`LinkedTransferQueue` 的核心方法是 `xfer`(`LinkedTransferQueue.java:662`),第二个参数 `haveData` 区分数据节点与请求节点,`how` 区分立即/异步/同步/定时。

`transfer(E)`(`:1335`)要求**必须等接收者取走**才返回;普通 `put` 只要成功进入队列即可返回。

这是一种更严格的交接语义: 发送方不是确认"已入队",而是确认"已被接收"。

### 1.2 无锁配对

`LinkedTransferQueue` 用数据节点与请求节点配对,通过 CAS 尝试把相邻操作匹配;匹配不到时再按 `how` 决定入队等待、立即返回或定时等待。

关键设计(斜体):*"transfer = 消息确认语义"——发送方确认"被接收"才返回。面试"transfer vs put": put 入队即回,transfer 等到被消费。*

## 2. "并发集合全景" — 选型矩阵

| 场景 | 选择 | 依据 |
|---|---|---|
| 并发 Map | `ConcurrentHashMap` | acquire 读 + 桶级写 |
| 并发有序 | `ConcurrentSkipListMap` | 跳表 + 局部 CAS |
| 读多写少 List | `CopyOnWriteArrayList` | 写复制、读快照 |
| 无界并发队列 | `ConcurrentLinkedQueue` | CAS 无锁链入 |
| 有界阻塞队列 | `ArrayBlockingQueue` / `LinkedBlockingQueue` | 锁 + 条件 |
| 交接 | `SynchronousQueue` | 无缓冲配对 |
| 延迟 | `DelayQueue` | 优先队列 + 到期 |
| 线程池任务队列 | 依据线程池目标选择 `BlockingQueue` | 容量与阻塞语义决定饱和行为 |

关键设计(斜体):*"并发集合选型 = 语义 × 性能 × 实现"三轴——先确定需要映射/有序/队列哪种语义,再评估锁与容量,最后看实现代价。面试选型题按"语义 → 并发 → 实现"回答。*

面试"CHM vs COW vs 阻塞队列": CHM 解决 Map 语义,COW 解决读多写少快照,阻塞队列解决生产消费流控。

## 3. "与 HashMap/ArrayList 的对照" — 安全边界

### 3.1 什么时候用普通集合

- 单线程或无共享: 普通集合通常更简单、更快
- 共享但读多写少: `CopyOnWriteArrayList`
- 共享高写: `ConcurrentHashMap` 或无锁队列
- 需要阻塞流控: `BlockingQueue`

并发集合解决的是"共享状态下的并发访问",不是让共享状态本身变得免费。能用线程局部数据解决的问题,优先避免共享。

关键设计(斜体):*"并发集合解决共享 + 并发,但共享本身要避免"——无共享无锁通常最简单。面试"并发集合 vs 加锁普通集合": 并发集合用细粒度/无锁路径换吞吐。*

## 4. "线程池的衔接" — 队列的作用

### 4.1 workQueue

`ThreadPoolExecutor` 持有 `BlockingQueue<Runnable> workQueue`(`ThreadPoolExecutor.java:447`)。因此线程池的任务队列可以是:

- `LinkedBlockingQueue`——通常偏向排队,容量配置决定是否持续积压
- `SynchronousQueue`——任务不落地,必须直接交给工作线程
- `ArrayBlockingQueue`——固定容量,边界明确

### 4.2 选型后果

队列类型会直接影响线程池饱和行为: 无界/大容量倾向于排队,有界队列触发拒绝策略,直接交接则更早推动线程扩展或拒绝。

面试"线程池队列怎么选": 先定任务模型、容量和拒绝策略,再选队列。

关键设计(斜体):*"线程池的核心参数就是队列"——capacity 与语义直接影响线程池饱和行为。面试"线程池队列怎么选": 先定任务模型,再定容量与拒绝策略。*

跨层标注: [第 1 篇——ConcurrentHashMap;第 3 篇——ConcurrentSkipListMap;第 4 篇——COW/CLQ;第 5 篇——BlockingQueue]

## 核心悬念

并发集合收官——**并发执行的调度者**来了: `ThreadPoolExecutor` 的 Worker 生命周期、核心/最大线程的扩缩、拒绝策略;`ForkJoinPool` 的 work-stealing——下一篇(按写作顺序): 域 14 线程池与任务。