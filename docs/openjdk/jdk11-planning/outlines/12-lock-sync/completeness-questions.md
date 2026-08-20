# 域 12: 锁与同步器 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "讲讲 AQS(模板方法/state/CLH)" — 01 篇 §1-4(AbstractQueuedSynchronizer.java:580/611/629/1238)
- [x] "acquireQueued 流程/park 时机" — 02 篇 §1(906)
- [x] "SIGNAL 状态/唤醒传播" — 02 篇 §2-3(844/685/1301)
- [x] "公平 vs 非公平(hasQueuedPredecessors)" — 02 篇 §4/03 篇 §2(ReentrantLock.java:198/206/213)
- [x] "可重入怎么实现(state 计数)" — 03 篇 §1(126)
- [x] "Condition vs wait/notify" — 03 篇 §3(Condition.java:490)
- [x] "synchronized vs Lock 选型" — 03 篇 §4
- [x] "共享模式级联唤醒" — 04 篇 §1(994/755/717)
- [x] "Semaphore/Latch/Barrier 区别" — 04 篇 §2-4(Semaphore.java:317, CountDownLatch.java:291/231, CyclicBarrier.java:165)
- [x] "读写锁/StampedLock 乐观读" — 05 篇 §1-2(StampedLock.java:629/646)
- [x] "锁升级(转换)" — 05 篇 §3(739)

## 身份 2: 生产工程师
- [x] 限流(Semaphore)— 04 篇 §2
- [x] 并行任务汇合(Barrier)— 04 篇 §4
- [x] 读多写少优化(乐观读)— 05 篇 §2
- [x] 锁泄漏(lock 未 unlock)— 03 篇 §1

## 身份 3: 框架工程师
- [x] 连接池/线程池的 AQS 依赖 — 01-04 篇
- [x] 缓存读写锁 — 05 篇

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 AbstractQueuedSynchronizer.java:394/401-405/569/575/580/587/611/629/674/685/717/755/844/906/994/1117/1238/1258/1301, ReentrantLock.java:111/126/196/198/206/213/266/346, Condition.java:490, LockSupport.java:158-195, Semaphore.java:227/242/317, CountDownLatch.java:162/231/291, CyclicBarrier.java:141-165/492, StampedLock.java:459/532/629/646/739, Phaser.java:1147)/关键设计/跨层([内部卷 19]/[关联])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] 5 篇拆分为面试密度驱动(非巨型域但内容密度极高)

## 身份 5: 完整性缺口检查
- [x] AQS 核心(01)/等待唤醒(02)/ReentrantLock(03)/共享工具(04)/读写锁(05)五篇覆盖域全部面试主战场
- [x] Phaser/Exchanger(🟢)并入 04 篇提及;AbstractQueuedLongSynchronizer 不展开(同构)
- [x] 未覆盖确认: AQS 的中断/超时获取细节(acquireInterruptibly 1258)写作时并入 02 篇;LockSupport 的 blocker 机制并入 02 篇
- [x] 二次 review 修正: RRW 计数拆分锚定(SHARED_SHIFT=16:263/EXCLUSIVE_MASK:266/sharedCount:269/exclusiveCount:271)
- [x] 验证通过: tryAcquire 默认抛 UnsupportedOperationException(1117)、shouldPark 三段逻辑(844-860)、nonfairTryAcquire owner 分支(126-150)、tryRelease(146)、ConditionObject(1868)、StampedLock implements Serializable 非 AQS(229)、CyclicBarrier dowait(199)
- [ ] 待办: 写作时验证 ReentrantReadWriteLock 的 exclusiveCount/sharedCount 行号、doReleaseShared 完整逻辑(717)
