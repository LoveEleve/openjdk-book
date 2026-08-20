# 05. StampedLock 与读写锁 — 读写分离、乐观读

> 🟡 Working | 域 12 锁与同步器第 5 篇 | Layer 4
> 读者处境: 面试"读写锁/乐观锁";生产读多写少——StampedLock 的三模式与适用边界。

### 1. "ReentrantReadWriteLock" — 读写分离

场景: 读多写少——多个读者并行读,写者独占

- `ReentrantReadWriteLock.java:1502` — 内部两个锁: readLock/writeLock(基于 AQS 共享+独占)
- state 拆分: 高 16 位读计数/低 16 位写计数(`SHARED_SHIFT=16` 263/`EXCLUSIVE_MASK` 266/`sharedCount` 269/`exclusiveCount` 271)
- 语义: 读-读并行,读-写互斥,写-写互斥
- 关键设计 (斜体): *"读写分离"用 state 的高低 16 位同时编码两种计数——一个 int 两用;面试"读锁和写锁关系"——写锁可降级为读锁,读锁不可升级为写锁(死锁风险)*
- 面试: "读写锁适合什么"——读多写少的缓存/配置场景

### 2. "StampedLock 的三种模式" — 写/读/乐观读

场景: `StampedLock` 比 ReadWriteLock 多出的"乐观读"是什么?

- `StampedLock.java:1620` — **非 AQS 实现**(自有状态机 + 队列)
- `StampedLock.java:459` `writeLock()` / `532` `readLock()` / `629` `tryOptimisticRead()` — 三模式
- `StampedLock.java:646` `validate(stamp)`: `(stamp & SBITS) == (state & SBITS)` — **校验乐观读期间有没有写发生**
- 用法: 乐观读 → 读数据 → validate(stamp) → 失败则升级为读锁重读
- 关键设计 (斜体): *乐观读 = **不加锁的读**——读时假设没人写,结束后校验版本号;没写=赚到(零锁开销),有写=重读;stamp 是"版本快照";面试"乐观读为什么快"——免锁读路径*
- 面试: "乐观读的适用条件"——写频率低的场景(写频繁则重试浪费);JDK 注释: 读多写少适用

### 3. "锁升级与转换" — tryConvertToWriteLock

场景: 乐观读失败后——怎么平滑升级?

- `StampedLock.java:739` `tryConvertToWriteLock(stamp)` — 乐观读/读锁 → 尝试升级写锁(条件满足时)
- 其他转换: tryConvertToReadLock/tryConvertToOptimisticRead
- 代价: 转换失败返回 0,需手动 acquire
- 关键设计 (斜体): *"转换"是 stamp 状态机的优雅之处——同一个 stamp 在不同条件下变换模式;面试"升级失败怎么办"——释放旧 stamp 重新获取*
- 生产: 计数器/版本号场景常用(JDK 内部如 ConcurrentHashMap?——域 10 有类似版本思想)

### 4. "选型与注意" — 三锁对比

场景: synchronized/Lock/ReadWrite/Stamped 怎么选?

| 锁 | 特性 | 适用 |
|---|---|---|
| synchronized | 简单/内置 | 通用 |
| ReentrantLock | 公平/中断/多条件 | 高级语义 |
| ReentrantReadWriteLock | 读写分离 | 读多写少 |
| StampedLock | +乐观读 | 写极少/读极多 |

- 注意: StampedLock **不可重入**、不支持 Condition、中断需 try/变体——**不是万能**
- [关联: 内部卷 19-synchronization(JVM 锁机制对照);域 10 ConcurrentHashMap(读多写少的无锁替代)]
- 关键设计 (斜体): *锁的选型 = 竞争模式分析: 读写比、写频率、重入需求——面试"读多写少用什么"——先 ReadWriteLock 再谈 StampedLock 乐观读;过度优化是反模式*
- 生产: 先 profile 再换锁;简单优先

---

### 核心悬念

锁的世界收官——但**无锁的集合**呢?`ConcurrentHashMap` 怎么做到"读无锁、写细粒度"?`CopyOnWriteArrayList` 的写时复制?`BlockingQueue` 的阻塞语义?——下一篇(按写作顺序)是域 16 Stream,之后域 21 Selector、域 34/39,再到域 10 并发集合。

> → 下一篇: 域 16 Stream 与函数式(16-stream 系列) | 关联: 域 10 并发集合、域 14 线程池
