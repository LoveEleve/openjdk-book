# 05. 阻塞队列家族 — BlockingQueue 契约、锁与条件、各实现

> **前置依赖**: [12-lock-sync/03 — ReentrantLock 与 Condition](../12-lock-sync/03-reentrantlock-condition.md)(Condition 机制)、[10-concurrent-collections/04 — CopyOnWrite 与无锁队列](04-copyonwrite-concurrentqueue.md)(CLQ 对照)
> → **后续**: 06-transfer-selection(按写作顺序)
> 关联: [12-lock-sync/03 — ReentrantLock 与 Condition](../12-lock-sync/03-reentrantlock-condition.md)(await/signal)

## 阻塞队列怎么实现流控

并发队列解决的是"能放/能取"，`BlockingQueue` 解决的是"满了怎么办、空了怎么办"。

## 1. "BlockingQueue 的契约" — 四组方法

### 1.1 四种语义

`BlockingQueue` 明确给出四组接口:

- `put(e)`(`BlockingQueue.java:231`)——满则阻塞(可中断)
- `take()`(`:261`)——空则阻塞
- `offer(e, timeout, unit)`(`:251`) / `poll(timeout, unit)`(`:275`)——限时阻塞
- `add/remove` 与 `offer/poll`——异常版/特殊值版

### 1.2 本质

阻塞队列不是"特殊容器",而是**队列 + 条件等待**。核心不是存储结构本身,而是空/满条件下的 `await/signal`。

关键设计(斜体):*"阻塞队列 = 队列 + 条件等待"——put/take 用 await/signal 把"空/满"变成线程流控。面试"四组方法区别": 阻塞 vs 非阻塞 vs 超时。*

## 2. "ArrayBlockingQueue" — 单锁双条件

### 2.1 结构

`ArrayBlockingQueue` 用一个定长数组做环形缓冲:

- `items`(`ArrayBlockingQueue.java:103`)——底层数组
- `lock`(`:120`)——单把 `ReentrantLock`
- `notEmpty`(`:123`) / `notFull`(`:126`)——两条条件队列

### 2.2 put/take

- `put`(`:361`)：先拿 `lock`,满了就 `notFull.await`,成功入队后 `enqueue`(`:176`)并 `signal notEmpty`
- `take`(`:412`)：空了就 `notEmpty.await`,成功出队后 `dequeue`(`:191`)并 `signal notFull`

因为底层是一个共享数组,头尾位置都受同一组边界约束,所以**一把锁就够**。

关键设计(斜体):*"单锁 + 双条件"让 put/take 等待不同信号,但仍共享同一把互斥锁。面试"ABQ 为什么一个锁够": 数组边界共享,天然单锁。*

## 3. "LinkedBlockingQueue" — 双锁分离

### 3.1 两把锁

`LinkedBlockingQueue` 把入队和出队拆开:

- `takeLock`(`LinkedBlockingQueue.java:156`) + `notEmpty`(`:159`)
- `putLock`(`:162`) + `notFull`(`:165`)

### 3.2 为什么吞吐更高

因为 put 主要改尾部, take 主要改头部,所以它们可以分别在不同锁下进行。队列不空不满时,**put 与 take 可以并行**。

这比 `ArrayBlockingQueue` 的单锁模型吞吐更高,但代价是链表节点对象开销更大,实现也更复杂。

关键设计(斜体):*"双锁分离 = put/take 互不阻塞"——头尾分工,不同方向各拿各的锁。面试"LBQ 为什么常比 ABQ 快": 读写并行,但要付出节点与实现复杂度。*

## 4. "SynchronousQueue / DelayQueue" — 特殊语义

### 4.1 SynchronousQueue

`SynchronousQueue` 没有容量,`put` 必须等一个 `take` 来配对。源码里有两套传输器:

- `TransferStack`(`SynchronousQueue.java:215`)——栈式
- `TransferQueue`(`:525`)——队列式

这就是典型的"一手交钱、一手交货"。

### 4.2 DelayQueue

`DelayQueue`(`DelayQueue.java:77`)内部是延迟堆;`take`(`:210`)如果头元素还没到期,就 `available.awaitNanos(delay)`(`:229`)继续等。

所以它的阻塞条件不是"空/满",而是**时间未到**。

关键设计(斜体):*"特殊队列 = 特殊阻塞条件"——SynchronousQueue 按配对阻塞,DelayQueue 按时间阻塞。面试"SynchronousQueue 容量": 0;面试"DelayQueue 怎么知道到期": 看头元素 delay。*

## 核心悬念

队列家族收官——**传递语义**呢?`LinkedTransferQueue.transfer()` 为什么比 BlockingQueue 多一步"必须交到接收者手里"?整个并发集合怎么选型?——下一篇: TransferQueue 与选型收官。

> → [06-transfer-selection.md](06-transfer-selection.md)