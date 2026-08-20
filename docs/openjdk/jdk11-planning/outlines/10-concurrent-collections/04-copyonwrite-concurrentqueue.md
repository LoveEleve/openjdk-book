# 04. CopyOnWrite 与无锁队列 — 写时复制、CAS 链接

> 🔴 Deep | 域 10 并发集合第 4 篇(巨型域 6 篇之四)| Layer 5
> 读者处境: 面试"读多写少用什么""COW 的原理"——两个"读友好"的并发结构。

### 1. "CopyOnWriteArrayList 原理" — volatile 数组 + 写时复制

场景: `list.add(x)` 时读线程在干什么?——为什么读无锁?

- `CopyOnWriteArrayList.java:105` — `private transient volatile Object[] array` — **volatile 数组引用**
- `CopyOnWriteArrayList.java:428` `add`: `synchronized(lock)` 内 `Arrays.copyOf(es, len+1)`(432-433)+ 写新数组 + `setArray` 发布
- `get`(397): 直接读 array 引用 + 下标——**无锁**(旧数组对旧读者仍有效)
- 关键设计 (斜体): *"写复制、读引用"——写时复制整个数组,读方永远拿到一个完整快照(volatile 发布);面试"COW 读会看到什么"——要么旧数组要么新数组(一致快照)*
- 面试: "COW 缺点"——每次写 O(n) 复制;写多场景灾难
- [关联: 域 11 volatile 语义;域 09 CopyOnWriteArraySet 同构]

### 2. "COW 适用场景" — 读多写少的监听器表

场景: 生产"监听器列表/缓存白名单"——为什么用 COW?

- 适用: **读频率远高于写**+ 元素少(复制成本可接受)
- 经典: 监听器表(NBS 域 34 的 CopyOnWriteArrayList 同源)、配置白名单、缓存路由表
- `CopyOnWriteArraySet`(485): 内部包装 COW 的 Set 语义
- 关键设计 (斜体): *"COW = 用复制换读锁"——写方锁+复制,读方零锁;面试"什么时候用 COW"——读多写少+小集合;写多场景选 ConcurrentHashMap/ConcurrentLinkedQueue*
- 面试: "COW vs ConcurrentHashMap"——COW 适合小集合整表快照,CHM 适合大集合细粒度

### 3. "ConcurrentLinkedQueue" — 无锁队列

场景: 无界并发队列——CAS 怎么串链表?

- `ConcurrentLinkedQueue.java:239` — `volatile Node<E> tail` + head;`Node`(184,含 next)
- `offer`(354): **CAS 尾插**(VarHandle `NEXT.compareAndSet` 链入,ConcurrentLinkedQueue.java:316)——失败重试
- tail 惰性更新(不每次都 CAS tail,减少竞争)
- 关键设计 (斜体): *"无锁队列 = CAS 链入 + 惰性尾指针"——每次操作 O(1) 摊还;面试"无锁队列怎么保证尾插安全"——NEXT.compareAndSet 乐观重试*
- 面试: "ConcurrentLinkedQueue vs LinkedBlockingQueue"——无锁(不阻塞)vs 有锁(可阻塞/有界)
- [关联: 域 13 CAS;域 12 AQS 队列同族]

### 4. "遍历与一致性" — 弱一致语义

场景: 并发队列遍历——会漏元素吗?

- COW 迭代器: 快照(创建时数组)✅;CLQ 迭代器: **弱一致**(可能看到/漏掉并发插入的元素,不抛 CME)
- 语义对比: 无锁结构的遍历都是"尽力而为"
- 关键设计 (斜体): *"弱一致 = 无锁的代价"——遍历不保证快照一致性,但绝不抛 CME(域 08 fail-fast 对照);面试"并发集合遍历安全吗"——不抛异常但可能不最新*
- 面试: "弱一致 vs fail-fast"——并发容器弱一致,普通容器 fail-fast(域 08)

---

### 核心悬念

读友好结构讲完——**生产-消费**呢?`BlockingQueue` 的 put/take 怎么阻塞?ArrayBlockingQueue 的单锁双条件、LinkedBlockingQueue 的双锁、SynchronousQueue 的交接——线程池的"任务队列"就是这个家族。下一篇: 阻塞队列家族。

> → [05-blocking-queues.md](05-blocking-queues.md)
