# 06. TransferQueue 与并发集合选型 — 传递语义、全景矩阵

> 🟢 Surface | 域 10 并发集合第 6 篇(巨型域 6 篇之六)| Layer 5
> 读者处境: 面试"并发集合全家怎么选"——transfer 语义与完整选型地图。

### 1. "TransferQueue 是什么？" — 阻塞传递

场景: `transfer(x)` — 与 put 的区别?

- `LinkedTransferQueue.java:662` `xfer` — 核心方法(how 参数: 立即/异步/同步/定时)
- `transfer`: **阻塞直到有接收者取走**(比 put 的"入队即返回"更严格)
- 无锁实现: 双队列(数据节点/请求节点配对,CAS)
- 关键设计 (斜体): *"transfer = 消息确认语义"——发送方确认"被接收"才返回;面试"transfer vs put"——put 入队即回,transfer 等到被消费*
- 面试: "谁用它"——并发流控/可靠传递场景(生产低频,理解即可)

### 2. "并发集合全景" — 选型矩阵

场景: 面试"并发场景用什么集合"——完整决策表

| 场景 | 选择 | 依据 |
|---|---|---|
| 并发 Map | ConcurrentHashMap | 无锁读+桶锁写 |
| 并发有序 | ConcurrentSkipListMap | 跳表无锁有序 |
| 读多写少 List | CopyOnWriteArrayList | 写复制读无锁 |
| 无界并发队列 | ConcurrentLinkedQueue | CAS 无锁 |
| 有界阻塞队列 | ArrayBlockingQueue/LinkedBlockingQueue | 锁+条件 |
| 交接 | SynchronousQueue | 无缓冲配对 |
| 延迟 | DelayQueue | 优先级+到期 |
| 线程池任务队列 | 视线程池类型(域 14) | LinkedBlockingQueue/SynchronousQueue |

- 关键设计 (斜体): *"并发集合选型 = 语义×性能×实现"三轴——需要什么语义(映射/有序/队列),能否接受锁(无锁/细锁/粗锁);面试选型题按"语义→并发→实现"答*
- 面试: "CHM vs COW vs 阻塞队列"——读多写少/Map 语义/生产消费

### 3. "与 HashMap/ArrayList 的对照" — 安全边界

场景: 什么时候用普通集合,什么时候用并发版?

- 单线程/无共享: 普通集合(更快)
- 共享但读多写少: COW/CHM
- 共享高写: CHM(桶锁)/无锁队列
- 需要阻塞流控: BlockingQueue
- 关键设计 (斜体): *"并发集合解决'共享+并发',但共享本身要避免"——无共享无锁(最佳);面试"并发集合 vs 加锁普通集合"——并发集合的细粒度/无锁优势*
- 生产: 优先无共享(线程局部,域 11);必须共享才选并发集合

### 4. "线程池的衔接" — 队列的作用

场景: 线程池怎么用这些队列?——域 14 预告

- ThreadPoolExecutor: workQueue = BlockingQueue(LinkedBlockingQueue/SynchronousQueue/ArrayBlockingQueue)
- 队列类型决定线程池行为: 无界(永不拒绝)/有界(拒绝策略)/交接(来一单干一单)
- 任务调度: 队列 + 线程(域 14 展开)
- 关键设计 (斜体): *"线程池的核心参数就是队列"——capacity/语义直接影响线程池饱和行为;面试"线程池队列怎么选"——先定任务模型再选队列(域 14 详解)*
- [关联: 域 14 线程池(workQueue 选型)]

---

### 核心悬念

并发集合收官——**并发执行的调度者**来了: `ThreadPoolExecutor` 的 Worker 生命周期、核心/最大线程的扩缩、拒绝策略;`ForkJoinPool` 的 work-stealing——下一篇: 域 14 线程池与任务。

> → 下一篇: 域 14 线程池与任务(14-threadpool 系列) | 关联: 域 12/13
