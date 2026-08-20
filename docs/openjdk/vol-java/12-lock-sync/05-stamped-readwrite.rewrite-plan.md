# 12-lock-sync/05 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ReentrantReadWriteLock` 与 `StampedLock`。本文聚焦读写分离语义、高低 16 位计数、读锁/写锁互斥规则、StampedLock 的写/读/乐观读三模式、版本戳校验与锁转换；不展开内部完整等待队列细节。
> 目标：把“StampedLock 与读写锁”改写成一篇围绕“读多写少时，为什么不能让两个读者互相等，以及为什么有时连读锁都不值得上，宁愿先乐观读后校验”的机制文章。

## 1. 读者困惑

- 明明两个线程都只是读，为什么普通互斥锁还要让它们排队？
- `ReentrantReadWriteLock` 到底怎样把“多个读者共享、写者独占”编码进同一个 state？
- 为什么写锁可以降级成读锁，读锁却不能安全升级成写锁？
- `StampedLock` 说的“乐观读”为什么敢先不加锁，它靠什么证明自己读到的是一致视图？
- 乐观读既然这么轻，为什么不能拿它替代一切读锁？
- `tryConvertToWriteLock` 这些转换方法解决的是哪类尴尬场景？

## 2. 一句话顿悟

**读写锁的核心不是“多一种锁”，而是把 state 从‘谁独占’扩展成‘当前有多少读者、有没有写者’，让读-读并行、读-写互斥；StampedLock 则更进一步，把“没有写者正在动数据”这个事实抽成版本戳，让读线程先无锁读取、事后再校验期间是否发生写入。前者用读写分离减少不必要互斥，后者在写极少场景里连读锁开销都想省掉。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 ReentrantReadWriteLock 高低 16 位计数、锁降级、StampedLock 三模式、validate 校验与转换方法。
- 已点出 StampedLock 不是 AQS，实现路线不同，这是重要边界。
- 已提到不可重入/无 Condition 等 StampedLock 使用边界。

### 必须重写

- 旧稿更像“工具并列介绍”，需要先建立总问题：为什么读多写少时，读者不该彼此互斥。
- RRWL 与 StampedLock 要放在同一条“读者优化分层”主线上：先做到读-读并行，再进一步尝试无锁乐观读。
- 乐观读必须从失败方案讲起：为什么不能完全不校验就把读到的值当真。
- 锁升级/降级要回扣“如何缩短写锁独占时间”这个真实痛点，而不是单列 API。
- 收尾选型要强调读比例、写频率、重入需求和条件队列支持，而不是只报类名。

## 4. 理解路径

### 第一节：从“两个读者为什么还要互相等”开场

用缓存/配置快照/路由表这类读多写少场景开场：两个线程都只是读，但普通互斥锁仍让后来的读者在门口排队。指出失败方案：把所有访问都当独占会把‘本可并行的读’也锁死。

### 第二节：ReentrantReadWriteLock 为什么把一个 state 拆成高低 16 位

证据：
- `ReentrantReadWriteLock.java:216`：类定义
- `ReentrantReadWriteLock.java:253`：`Sync`
- `ReentrantReadWriteLock.java:269`：`sharedCount`
- `ReentrantReadWriteLock.java:271`：`exclusiveCount`
- `ReentrantReadWriteLock.java:453`：`tryAcquireShared`
- `ReentrantReadWriteLock.java:382`：`tryAcquire`

主线：
- 高 16 位记录读计数，低 16 位记录写计数。
- 这样一个 int 就能同时回答“当前有几个读者”和“有没有写者/写重入层数”。
- RRWL 不是两把互不相关的锁，而是同一状态机的两种视图。

### 第三节：为什么读锁可并行、写锁却必须独占

证据：
- `ReentrantReadWriteLock.java:370`：`tryRelease`
- `ReentrantReadWriteLock.java:415`：`tryReleaseShared`
- `ReentrantReadWriteLock.java:453-494`：`tryAcquireShared`
- `ReentrantReadWriteLock.java:501`：`fullTryAcquireShared`

主线：
- 读线程之间只要没有写者，可以共享通过。
- 写线程必须看到“无读者且无别的写者”才可独占成功。
- 这解释了读-读并行、读-写互斥、写-写互斥三条规则是怎样从一个 state 中长出来的。

### 第四节：为什么写锁能降级，读锁却不该直接升级

证据：
- `ReentrantReadWriteLock.java` 类注释中关于降级语义的说明（重写时按需补更精确注释锚点）
- `ReentrantReadWriteLock.java:564`：`tryWriteLock`
- `ReentrantReadWriteLock.java:586`：`tryReadLock`

主线：
- 写者已独占时，可以先拿读锁再放写锁，实现“写完继续稳定读取”的降级。
- 读者若想直接升级成写者，往往会与其他并发读者形成互等，天然危险。
- 这里要讲的是场景：如何缩短写锁独占时间、避免释放写锁后的可见窗口被别人插入写入。

### 第五节：StampedLock 为什么进一步怀疑“连读锁都不值得上”

证据：
- `StampedLock.java:229`：类定义
- `StampedLock.java:368-376`：状态位常量
- `StampedLock.java:459`：`writeLock`
- `StampedLock.java:532`：`readLock`
- `StampedLock.java:629-631`：`tryOptimisticRead`
- `StampedLock.java:646-648`：`validate`

主线：
- RRWL 已经解决“读者别互相等”，但每次读仍要碰锁状态。
- 在写极少、读极多场景，JDK 进一步尝试：先读，再校验期间有没有写者改过版本。
- 这就是乐观读：不是不管并发，而是把同步成本延后到“读完再验一下”。

### 第六节：为什么乐观读必须 validate，不能读完直接信

证据：
- `StampedLock.java:629-631`：无写者时返回版本戳
- `StampedLock.java:646-648`：`validate`
- `StampedLock.java:291` 附近注释：校验所需内存序（重写时按需补具体表达）

主线：
- 朴素失败方案：只要 tryOptimisticRead 成功就直接读完当真，不再校验。
- 问题在于写者可能在你读字段过程中插进来，导致读到“前半段旧值 + 后半段新值”的混合视图。
- validate 比较版本戳是否仍一致，用来证明“读期间没有写发生”。不一致时必须退回 readLock 重读。

### 第七节：转换方法为什么重要——它在帮你缩短独占窗口

证据：
- `StampedLock.java:739`：`tryConvertToWriteLock`
- `StampedLock.java:776`：`tryConvertToReadLock`
- `StampedLock.java:817`：`tryConvertToOptimisticRead`

主线：
- 典型场景：先乐观读判断，大概率只读；少数情况下需要转写更新。
- 转换失败返回 0，调用方必须按老老实实释放再重拿的路径兜底。
- 重点不是 API 名称，而是“先用便宜模式观察，必要时再升级/降级”，用转换尽量减少状态切换成本。

### 第八节：选型收束

主线：
- `synchronized` / `ReentrantLock`：互斥优先，逻辑简单或需要中断/多条件。
- `ReentrantReadWriteLock`：读多写少、需要重入和清晰语义。
- `StampedLock`：写很少、读极多、愿意承担 validate/重读逻辑，且能接受不可重入、无 Condition 边界。
- 重点不是“谁先进”，而是“业务是否愿意为读路径优化支付语义约束和代码复杂度”。

## 5. 失败方案清单

1. 在读多写少场景继续用普通互斥锁，让读者彼此排队。
2. 把 RRWL 理解成“两把完全独立的锁”，忽略它们共享同一个状态机。
3. 让读锁直接升级成写锁，期待它像降级一样天然安全。
4. 使用乐观读后不做 `validate()` 就直接信任读结果。
5. 在写频繁场景滥用 StampedLock 乐观读，结果不断重试重读。
6. 在需要重入或 Condition 的场景硬上 StampedLock。
7. 把转换方法失败当成异常，而不是正常竞争结果。

## 6. 误解清单

1. 读写锁只是把一把锁拆成两个对象，内部毫无关联。
2. 只要是读锁，任何时候都可以安全升级成写锁。
3. 乐观读就是“完全不加锁，所以一定不安全”。
4. validate 只是在做性能优化，不影响正确性。
5. StampedLock 因为更“高级”，所以一定优于 RRWL。
6. RRWL 的公平性问题和普通独占锁没有关系。
7. 写锁降级和读锁升级只是方向相反、难度相同。

## 7. 证据清单

- `ReentrantReadWriteLock.java:216`：类定义
- `ReentrantReadWriteLock.java:253`：`Sync`
- `ReentrantReadWriteLock.java:269`：`sharedCount`
- `ReentrantReadWriteLock.java:271`：`exclusiveCount`
- `ReentrantReadWriteLock.java:370`：`tryRelease`
- `ReentrantReadWriteLock.java:382`：`tryAcquire`
- `ReentrantReadWriteLock.java:415`：`tryReleaseShared`
- `ReentrantReadWriteLock.java:453-494`：`tryAcquireShared`
- `ReentrantReadWriteLock.java:501`：`fullTryAcquireShared`
- `ReentrantReadWriteLock.java:564`：`tryWriteLock`
- `ReentrantReadWriteLock.java:586`：`tryReadLock`
- `StampedLock.java:229`：类定义
- `StampedLock.java:368-376`：状态位常量
- `StampedLock.java:459`：`writeLock`
- `StampedLock.java:532`：`readLock`
- `StampedLock.java:629-631`：`tryOptimisticRead`
- `StampedLock.java:646-648`：`validate`
- `StampedLock.java:739`：`tryConvertToWriteLock`
- `StampedLock.java:776`：`tryConvertToReadLock`
- `StampedLock.java:817`：`tryConvertToOptimisticRead`

## 8. 版本与边界

- 基于 JDK 11。
- RRWL 部分聚焦 state 语义与读写规则，不展开全部缓存字段与 HoldCounter 优化细节。
- StampedLock 部分聚焦三模式与版本校验，不打穿其内部等待队列实现。
- 不把乐观读写成“免费午餐”；它依赖写少场景和失败后回退重读。
- 不把 StampedLock 外推成所有读多写少场景的默认答案，它有不可重入、无 Condition 等边界。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么两个读者不该互相等 → RRWL 如何用一个 state 同时编码读写计数 → 写锁为何能降级、读锁为何难升级 → StampedLock 为什么敢先乐观读 → validate 为什么是正确性证明而非装饰 → 转换方法怎样缩短独占窗口”。
- 必须把 RRWL 和 StampedLock 放在同一条‘读路径优化分层’主线上讲。
- 必须讲清乐观读失败后的回退逻辑。
- 必须讲清读写锁与乐观读的适用边界。
- 结尾要自然收束域 12 并衔接后续域。
