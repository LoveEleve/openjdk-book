# 04. CopyOnWrite 与无锁队列 — 写时复制、CAS 链接

> **前置依赖**: [10-concurrent-collections/03 — ConcurrentSkipListMap](03-skiplist.md)(并发有序结构)、[13-atomic/01 — 原子与 CAS](../13-atomic/01-atomicinteger-cas.md)(CAS 基础)
> → **后续**: [05-blocking-queues.md](05-blocking-queues.md)
> 关联: [11-thread-threadlocal/01 — 线程生命周期](../11-thread-threadlocal/01-thread-lifecycle.md)(并发读写场景)

## 两种读友好结构

这一篇看两个方向: `CopyOnWriteArrayList` 用**复制快照**换读锁,`ConcurrentLinkedQueue` 用 **CAS 链接**换阻塞锁。

## 1. "CopyOnWriteArrayList 原理" — volatile 数组 + 写时复制

### 1.1 写路径

`CopyOnWriteArrayList` 的数组引用是 `private transient volatile Object[] array`(`CopyOnWriteArrayList.java:105`)。

`add`(`:428`)的核心步骤:

1. `synchronized (lock)` 获取写锁
2. `Arrays.copyOf(es, len + 1)`复制整个数组
3. 新数组尾部写入元素
4. `setArray(es)`发布新数组

### 1.2 读路径

`get(int)`(`:397`)直接读取当前 array 引用并按下标访问,不获取写锁。旧数组不会被原地修改,所以已经拿到旧数组的读者仍能完成自己的读取。

关键设计(斜体):*"写复制、读引用"——写方复制整个数组再发布;单次 `get` 读取一个已发布数组,迭代器则固定一个完整数组快照。面试"COW 读会看到什么": 要么旧数组,要么新数组,不会看到半写状态。*

### 1.3 代价

每次写都要复制 `O(n)` 数组;写多、集合大时复制成本和 GC 压力都会很高。

面试"COW 缺点": 写操作 O(n),不适合写多场景。

## 2. "COW 适用场景" — 读多写少的监听器表

### 2.1 适用条件

- 读频率远高于写
- 元素数量较少,复制成本可接受
- 读者需要稳定快照,写者可以串行化

经典场景: 监听器列表、配置白名单、缓存路由表。通知系统中的监听器表也采用同类 COW 结构。

### 2.2 CopyOnWriteArraySet

`CopyOnWriteArraySet`(`CopyOnWriteArraySet.java:104`)内部持有 `CopyOnWriteArrayList`(`:108`),用列表承载存储、用 Set 语义去重。它是 COW 的有序集合视图。

关键设计(斜体):*"COW = 用复制换读锁"——写方锁 + 复制,读方零锁。面试"什么时候用 COW": 读多写少 + 小集合;写多场景选 ConcurrentHashMap/ConcurrentLinkedQueue。*

## 3. "ConcurrentLinkedQueue" — 无锁队列

### 3.1 节点与指针

`ConcurrentLinkedQueue`(`ConcurrentLinkedQueue.java:109`)有 volatile `head`(`:225`)与 `tail`(`:239`)。

其 `Node`(`:184`)包含 volatile `item`/`next`(`:185-186`);`casItem`(`:205`)负责 CAS 清空出队节点的值。

### 3.2 offer 的 CAS 尾插

`offer`(`:354`)先创建新节点,再循环寻找尾部:

- `NEXT.compareAndSet(p, null, newNode)`(`:354`方法体中的链入点)成功时,新元素成为队列元素
- CAS 失败就重新读取 next 重试
- `TAIL.weakCompareAndSet`更新 tail 是优化,不要求每次都成功

源码明确把成功 CAS 标为 offer 的 **线性化点**: 元素从这一刻起对队列可见。

关键设计(斜体):*"无锁队列 = CAS 链入 + 惰性尾指针"——真正决定入队的是 next 的 CAS,tail 更新只是加速后续查找。面试"无锁队列怎么保证尾插安全": NEXT.compareAndSet 乐观重试。*

## 4. "遍历与一致性" — 弱一致语义

### 4.1 两种迭代器

- COW 迭代器基于创建时的数组快照
- CLQ 迭代器是**弱一致**: 并发插入/删除期间可能看到或看不到相应元素,但不抛 `ConcurrentModificationException`

### 4.2 语义对比

无锁结构的遍历不保证全局快照一致,但避免了 fail-fast 迭代器的并发修改异常。

面试"弱一致 vs fail-fast": 并发容器弱一致,普通容器 fail-fast;面试"并发集合遍历安全吗": 不抛异常,但不保证看到最新状态。

关键设计(斜体):*"弱一致 = 无锁的代价"——遍历不保证快照一致性,但不抛 CME。面试"COW vs CLQ 遍历": COW 是创建时快照,CLQ 是弱一致实时视图。*

## 核心悬念

读友好结构讲完——**生产-消费**呢?`BlockingQueue` 的 put/take 怎么阻塞?ArrayBlockingQueue 的单锁双条件、LinkedBlockingQueue 的双锁、SynchronousQueue 的交接——线程池的任务队列就是这个家族。下一篇: 阻塞队列家族。

> → [05-blocking-queues.md](05-blocking-queues.md)