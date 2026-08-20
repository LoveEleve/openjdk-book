# 03. ReentrantLock 与 Condition — 可重入、公平性、条件队列

> 🔴 Deep | 域 12 锁与同步器第 3 篇 | Layer 4
> 读者处境: 面试"ReentrantLock 和 synchronized 区别"必考——可重入计数、公平性、Condition 三件套。

### 1. "可重入怎么实现？" — state 计数

场景: 同一线程 lock 两次——为什么不死锁?

- `ReentrantLock.java:126` `nonfairTryAcquire`: `c = getState(); if (c == 0) CAS 0→1; else if (current == owner) setState(c+1)` — **state 即重入计数**
- 释放: `tryRelease`(136 附近): 每次 unlock state-1,到 0 才真正释放(owner=null)
- owner 追踪: `setExclusiveOwnerThread`(AbstractOwnableSynchronizer)
- 关键设计 (斜体): *"可重入 = 同一线程重复计数"——state 从布尔锁升级为计数锁;面试"为什么 synchronized 可重入"——JVM 维护同一原理(内部卷 19);Lock 的重入是显式的 state 语义*
- 面试: "lock 两次不 unlock 会怎样?"——state=2 未归零,其他线程永远拿不到(泄漏)

### 2. "公平与非公平的实现差异" — tryAcquire 对比

场景: 默认非公平——两段 tryAcquire 差在哪?

- 非公平 `ReentrantLock.java:198` NonfairSync.tryAcquire: **直接 `compareAndSetState(0, 1)`**——插队机会
- 公平 `206` FairSync.tryAcquire(213): **`!hasQueuedPredecessors() && CAS`**——有等待者必须排队
- `346` tryLock: 非公平路径(即使公平锁——"愿赌服输"语义)
- 关键设计 (斜体): *实现差异一行代码(hasQueuedPredecessors)——面试"公平锁代码差别"答案: 前驱检查;tryLock 不走公平(获取瞬间的插队是允许的)*
- 生产: 默认非公平;公平锁用于"饥饿敏感"场景(低频)

### 3. "Condition 是什么？" — 条件队列

场景: 生产者-消费者——`await/signal` 与 `wait/notify` 的关系

- `Condition.java:490` — 接口: `await()/signal()/signalAll()`(类比 wait/notify/notifyAll)
- 实现: AQS 内部 `ConditionObject` — **每条件一条等待队列**(Node 的 CONDITION 状态,域 12 第 1 篇 405)
- 语义: `await` **释放锁**并挂起(与 wait 相同前提);`signal` 移到 AQS 主队列(转移节点)
- 优势: **一个锁多个条件队列**(Lock.newCondition 多次)——synchronized 只有一个 wait set
- 关键设计 (斜体): *Condition 的价值: 多条条件队列(如"队列不满"和"队列不空"分开等)——用 synchronized 只能 notifyAll 全唤醒;面试"为什么用 Condition"——定向唤醒*
- 面试: "await 和 wait 区别"——Lock 体系 vs 内置监视器;await 可超时/可中断
- [关联: 内部卷 19-synchronization(wait/notify 的 JVM 实现对照)]

### 4. "synchronized vs Lock" — 选型矩阵

场景: 面试"什么时候用 Lock"——完整对比

| 维度 | synchronized | ReentrantLock |
|---|---|---|
| 实现 | JVM 内置(内部卷 19) | Java AQS(本域) |
| 公平性 | 非公平 | 可选公平 |
| 中断 | 不可中断 | lockInterruptibly |
| 超时 | 无 | tryLock(timeout) |
| 条件 | 一个 wait set | 多 Condition |
| 性能 | 现代 JVM 已优化 | 相当 |

- 关键设计 (斜体): *"JDK6+ synchronized 性能与 Lock 相当"(偏向锁/轻量锁,内部卷 19)——选型看**能力**不看性能: 需要超时/中断/多条件用 Lock,否则 synchronized(简洁);面试别再说"Lock 快"*
- 生产: 新代码优先 synchronized(简单);需要高级语义用 Lock
- [内部卷: 19-synchronization(偏向锁/轻量锁/锁膨胀——性能论据)]

---

### 核心悬念

独占锁讲完——**共享模式**呢?Semaphore 的"多个许可"、CountDownLatch 的"计数归零"——`doAcquireShared` 的级联传播(setHeadAndPropagate)怎么让多个线程同时唤醒?——下一篇: 共享模式与并发工具族。

> → [04-shared-tools.md](04-shared-tools.md)
