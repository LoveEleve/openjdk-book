# 05. 阻塞队列家族 — BlockingQueue 契约、锁与条件、各实现

> 🔴 Deep | 域 10 并发集合第 5 篇(巨型域 6 篇之五)| Layer 5
> 读者处境: 面试"阻塞队列原理/线程池队列选型"——put/take 的阻塞语义与三大实现。

### 1. "BlockingQueue 的契约" — 四组方法

场景: 队列满/空时——API 怎么表达?

- `BlockingQueue.java:231` `put(e)` — **满则阻塞**(可中断)
- `BlockingQueue.java:261` `take()` — **空则阻塞**
- `offer(e, timeout)`(251)/`poll(timeout)`(275)— 限时阻塞(超时返回 false/null)
- 四组语义: 抛异常(add/remove)/返回特殊值(offer/poll)/阻塞(put/take)/超时
- 关键设计 (斜体): *"阻塞队列 = 队列 + 条件等待"——put/take 用 Condition await/signal(域 12);面试"四组方法区别"——阻塞 vs 非阻塞 vs 超时*
- 面试: "为什么线程池用它"——任务队列满/空时的天然流控(域 14)

### 2. "ArrayBlockingQueue" — 单锁双条件

场景: 有界数组队列——并发怎么组织?

- `ArrayBlockingQueue.java:103` `final Object[] items`(环形,域 08 思想)+ `120` `final ReentrantLock lock`(**单锁**)
- `ArrayBlockingQueue.java:123/126` — `Condition notEmpty/notFull`(**双条件**)
- `put`(361): lock → 满则 `notFull.await` → `enqueue`(176,`notEmpty.signal`)
- `take`: 空则 `notEmpty.await` → `dequeue`(191,`notFull.signal`)
- 关键设计 (斜体): *"单锁 + 双条件"让 put/take 各自等待各自的信号——无需唤醒全部;面试"ABQ 为什么一个锁够"——读写互斥(数组边界)天然单锁*
- [关联: 域 12 ReentrantLock/Condition(await/signal 机制);域 14 线程池(队列消费方)]
- 面试: "ABQ vs LBQ"——单锁(put/take 互斥)vs 双锁(并行 put/take);公平性可配(fair 参数)

### 3. "LinkedBlockingQueue" — 双锁分离

场景: 链表有界队列——为什么快?

- `LinkedBlockingQueue.java:156-165` — **takeLock(156)+putLock(162)** 分离 + 各自 Condition(159/165)
- 效果: **put 与 take 可并行**(不同锁)——吞吐优于 ABQ
- 容量: 无界(Integer.MAX)或有界构造
- 关键设计 (斜体): *"双锁分离 = put/take 互不阻塞"——经典的头尾锁分离;面试"LBQ 为什么比 ABQ 快"——读写并行;代价: 链表节点对象开销*
- 面试: "双锁安全吗"——头尾不同节点,锁分离无竞态(队列空/满边界用 count 原子协调)

### 4. "SynchronousQueue/DelayQueue" — 特殊语义

场景: 无缓冲交接与延迟任务——两个特殊队列

- `SynchronousQueue.java:871` `put` — **无容量**: put 阻塞直到有 take 配对(TransferStack 215/TransferQueue 525,直接交接)——"一手交钱一手交货"
- `DelayQueue.java:81` — 内部 PriorityQueue(延迟堆)+ `take`(210): 头元素未到期则 `available.awaitNanos(delay)`(219)/到期才出队
- 适用: SynchronousQueue=线程池的"直传"(CachedThreadPool,域 14);DelayQueue=定时任务(ScheduledThreadPool 的延迟队列思想)
- 关键设计 (斜体): *"特殊队列=特殊语义"——交接(无缓冲)/延迟(到期可见);面试"SynchronousQueue 容量"——0(put 与 take 必须配对)*
- 面试: "DelayQueue 怎么知道到期"——getDelay(剩余时间)轮询头元素

---

### 核心悬念

队列家族收官——**传递语义**呢?`LinkedTransferQueue.transfer()` 阻塞到接收者——比 BlockingQueue 多了什么?整个并发集合的选型全景图是什么?——下一篇: TransferQueue 与选型收官。

> → [06-transfer-selection.md](06-transfer-selection.md)
