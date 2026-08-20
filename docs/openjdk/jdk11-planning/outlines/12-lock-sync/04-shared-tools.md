# 04. 共享模式与并发工具族 — Semaphore/CountDownLatch/CyclicBarrier

> 🔴 Deep | 域 12 锁与同步器第 4 篇 | Layer 4
> 读者处境: 面试"Semaphore/CountDownLatch/CyclicBarrier 区别"必考——共享模式与三个工具的语义与实现。

### 1. "共享模式是什么？" — doAcquireShared 级联

场景: 独占锁唤醒一个——共享锁怎么唤醒多个?

- `AbstractQueuedSynchronizer.java:994` `doAcquireShared`: 获取共享许可成功 → `setHeadAndPropagate`(755)
- `755` setHeadAndPropagate: 设 head 后**继续唤醒后继**(propagate > 0 或 head 状态 SIGNAL 时 `doReleaseShared` 717)
- **级联传播**: 释放一个许可 → 可能唤醒多个排队者(剩余许可 > 1)
- 关键设计 (斜体): *独占/共享的核心差异: 独占"唤醒一个",共享"传播唤醒"——setHeadAndPropagate 是共享模式的灵魂;面试"共享锁怎么唤醒多个"——级联信号*
- 面试: "为什么共享模式需要传播?"——释放 3 个许可,队头 3 个都能获取

### 2. "Semaphore" — 许可池

场景: 限流 N 个并发——Semaphore 的实现

- `Semaphore.java:227/242` — NonfairSync/FairSync(同 ReentrantLock 结构)
- `Semaphore.java:317` `acquire()` → `sync.acquireSharedInterruptibly(1)` — 共享获取
- 许可 = state;`release()` = releaseShared(1)
- 关键设计 (斜体): *Semaphore = "AQS 共享模式的 state 语义化"(state=剩余许可);公平版本同前驱检查;面试"Semaphore vs 锁"——锁排他,信号量共享(多个可同时持有)*
- 面试: "acquire 会阻塞吗?"——许可不足时入共享队列 park(域 12 第 2 篇)

### 3. "CountDownLatch" — 门闩

场景: 主线程等 N 个任务完成——CountDownLatch 的实现

- `CountDownLatch.java:162` — Sync extends AQS(state = 计数)
- `CountDownLatch.java:291` `countDown()` → `releaseShared(1)`(state-1)
- `CountDownLatch.java:231` `await()` → `acquireSharedInterruptibly`(state 到 0 才成功)
- 语义: **一次性**(计数归零不可重置)
- 关键设计 (斜体): *CountDownLatch = "倒计数共享锁"——state 到 0 时所有等待者级联唤醒;面试"与 CyclicBarrier 区别"——Latch 一次性、Barrier 可复用且阻塞的是"参与者自己"*
- 面试: "await 多个线程?"——都等 state=0,级联唤醒全部(共享模式)

### 4. "CyclicBarrier" — 可复用屏障

场景: 并发分阶段任务(每阶段所有线程齐了才继续)——Barrier 的实现

- `CyclicBarrier.java:492` — 计数 + **Generation 世代**(165: 每次"冲破屏障"换一代,可复用)
- `dowait`(内部): 参与者 `await()` 计数减一,非最后一个 → park;最后一个 → `breakBarrier`/`nextGeneration` 唤醒全部
- 与 Latch 区别: 参与者**互相等待**(每个 await 的都是"到了的人"),到齐后同时放行,且可重置
- 关键设计 (斜体): *"Barrier = 汇合点"——分治任务每轮并行计算后汇合;Generation 区分轮次(中断/超时破坏屏障需 reset);面试"Latch vs Barrier"——等待外部事件 vs 参与者互相等*
- [关联: 域 13 原子类(共享 CAS 前置)、域 11 线程(park/状态);Phaser 动态注册(面试低频)]
- 生产: 并行计算的分阶段同步;Phaser 是更灵活的版本(动态注册,面试低频)

---

### 核心悬念

工具族收官——但**读写分离**呢?`ReentrantReadWriteLock` 怎么让"多个读者并行、写者独占"?`StampedLock` 的乐观读是什么——不用锁的读?——下一篇: StampedLock 与读写锁。

> → [05-stamped-readwrite.md](05-stamped-readwrite.md)
