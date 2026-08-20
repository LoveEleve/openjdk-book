# 域 12: 锁与同步器 — 知识规划

> 源码路径: java.base/share/classes/java/util/concurrent/locks/(AQS 2,334/ReentrantLock 743/ReentrantReadWriteLock 1,502/StampedLock 1,620/LockSupport 431/Condition 490) + {CountDownLatch 316,CyclicBarrier 492,Semaphore 720,Phaser 1,147,Exchanger 648}.java
> 源码量: 12 文件 / ~12,000 行 | 非巨型域(但面试密度极高,拆 5 篇)
> 写作层: Layer 4(前置: 域 11 线程、13 原子类、32 CAS)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| AbstractQueuedSynchronizer.java (2334) | **核心状态**: state(580,volatile)+compareAndSetState(611)+getState(587)——同步状态由子类语义化 | High |
| AQS | **CLH 队列**: Node(394)/waitStatus 常量(CANCELLED 401/SIGNAL 403/CONDITION 405)/head(569)/tail(575)/enq(629,CAS 尾插)/setHead(674) | High |
| AQS | **独占获取**: acquire(1238)→tryAcquire 模板(1117 默认抛异常)→acquireQueued(906,自旋+CAS+park)/acquireInterruptibly(1258) | High |
| AQS | **共享获取**: doAcquireShared(994)/setHeadAndPropagate(755,级联传播) | High |
| AQS | **释放与唤醒**: release→unparkSuccessor;取消: CANCELLED 清理 | High |
| ReentrantLock.java (743) | **可重入**: state 计数重入;NonfairSync(196,nonfairTryAcquire 126 直接 CAS)/FairSync(206,tryAcquire 有前驱检查) | High |
| ReentrantLock.java | lock(266)/tryLock(346)/unlock——Sync 分发 | Medium |
| Condition.java (490) | **条件队列**: await/signal 语义(与 Object.wait/notify 对照) | High |
| LockSupport.java (431) | **park/unpark 封装**: Unsafe 底层(域 32)+ permit 语义 | High |
| Semaphore.java (720) | **信号量**: 共享模式 acquire(317)/NonfairSync 227/FairSync 242;许可计数 | High |
| CountDownLatch.java (316) | **门闩**: Sync(162,state=计数)/await(231)/countDown(291) | High |
| CyclicBarrier.java (492) | **屏障**: 计数+重置(可复用),Generation 世代 | Medium |
| Phaser.java (1147) | **阶段器**: 更灵活的屏障(动态注册) | Low |
| StampedLock.java (1620) | **邮票锁**: 三种模式(写/读/乐观读)、stamp 校验、锁升级 | High |
| Exchanger.java (648) | **交换器**: 双线程数据交换 | Low |

*15 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | AQS 独占模式(state+CLH 队列) | 1 (AQS) | 面试必考(AQS 是并发面试之王) |
| P1 | ReentrantLock 可重入与公平性 | 1 | 面试必考(公平/非公平/重入) |
| P1 | 共享模式与工具族 | 4 (Semaphore/CountDownLatch/CyclicBarrier/Phaser) | 面试高频(各工具语义) |
| P1 | Condition | 1 | 面试常问(与 wait/notify 区别) |
| P2 | StampedLock 乐观读 | 1 | 面试常问(乐观锁场景) |
| P3 | Exchanger | 1 | 面试低频 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | AQS 独占模式(state+CAS+CLH) | 面试必考(手撕 AQS 流程/模板方法) |
| 🔴 Deep | ReentrantLock 公平性 | 面试必考(公平 vs 非公平/为什么默认非公平) |
| 🔴 Deep | 并发工具语义 | 面试高频(Latch/Barrier/Semaphore 区别) |
| 🔴 Deep | Condition | 面试常问(条件队列原理) |
| 🟡 Working | StampedLock | 面试常问(乐观读/适用场景) |
| 🟢 Surface | Phaser/Exchanger | 面试低频 |

## 04 聚类

### 依赖图(域内)
```
AQS(state+CLH) ←── ReentrantLock(独占+重入)/Semaphore(共享)/CountDownLatch(共享)/CyclicBarrier(共享+独占)
AQS ConditionObject ←── Condition(await/signal)
LockSupport(park/unpark) ←── AQS 队列阻塞
StampedLock(自实现,非 AQS) ←── 读写锁变体
```

### 教学顺序与文章拆分(5 篇)

1. **AQS 核心: state 与 CLH 队列** — 模板方法模式、state+CAS、Node 双向队列、acquire/release 骨架
2. **AQS 等待与唤醒** — acquireQueued 自旋+park、setHead、signal 传播、CANCELLED 取消、公平性
3. **ReentrantLock 与 Condition** — 可重入计数、公平/非公平、Condition 队列、与 synchronized 对比
4. **共享模式与并发工具** — doAcquireShared、Semaphore/CountDownLatch/CyclicBarrier/Phaser 语义、Exchanger
5. **StampedLock 与读写锁** — ReentrantReadWriteLock、乐观读 stamp/validate、锁升级、选型

> 前置: 域 11(线程状态)、13(CAS)、32(park/unpark)。跨层: park 的 JVM 实现(内部卷 17-threads);synchronized 对照(内部卷 19-synchronization)
