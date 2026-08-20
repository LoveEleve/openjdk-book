# 12-lock-sync/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ReentrantLock` 与 `AbstractQueuedSynchronizer.ConditionObject`。本文聚焦 `nonfairTryAcquire`、`tryRelease`、`FairSync/NonfairSync`、`newCondition`、`ConditionObject.await/signal/signalAll`、`fullyRelease` 与条件队列转移；共享模式工具留到下一篇。
> 目标：把“ReentrantLock 与 Condition”改写成一篇围绕“可重入锁为什么需要把 state 解释成重入计数，以及为什么一个锁只配一个 wait set 不够，必须再分出多条条件队列”的机制文章。

## 1. 读者困惑

- `ReentrantLock` 的“可重入”到底怎么落到 `state` 上，为什么同一线程再 `lock()` 不会死锁？
- `unlock()` 一次为什么有时并不会真的放锁？
- 公平锁和非公平锁源码上到底差哪一行，为什么 tryLock 又像在“作弊”？
- 有了 AQS 主队列，为什么还需要 `ConditionObject` 条件队列？
- `await()` 为什么一定要先释放锁，醒来后为什么还得重新抢锁？
- `signal()` 为什么不是直接唤醒线程，而是先把节点转移回同步队列？
- `Condition` 相比 `Object.wait/notify` 真正多出来的能力是什么？

## 2. 一句话顿悟

**ReentrantLock 把 AQS 的 `state` 解释成“当前线程持有锁的重入计数”，所以同一线程再次获取时只是把计数加一、而不是把自己挡在门外；Condition 则在 AQS 同步队列之外再开一条“等某个业务条件成立”的专用等待链，让线程先完整释放锁、到条件队列里睡下，再在 `signal` 时被转回同步队列重新竞争锁。没有这两层语义，AQS 只能做‘拿锁失败去排队’，还做不到‘拿着锁等条件’。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `nonfairTryAcquire` / `tryRelease` 的重入计数逻辑、公平/非公平差异，以及 `ConditionObject.await/signal` 主流程。
- 已指出 `await` 会完整释放锁并在唤醒后恢复重入计数，这是本篇核心。
- 已把 `Condition` 相对 `wait/notify` 的“多条件队列”优势抓出来。

### 必须重写

- 旧稿偏“面试三件套”，需要先建立一个总问题：AQS 主队列已经能排失败线程了，为什么还需要条件队列。
- 可重入逻辑要先从“自己再 lock 为什么没把自己锁死”这个故障视角切入，而不是直接列分支。
- `await/signal` 必须讲成一条完整迁移链：条件队列睡下 → signal 转移回同步队列 → 重新获取锁，而不是只背五步。
- 公平与非公平应回扣“资格入口差异”，和上一篇公平性自然接上。
- `synchronized` vs `ReentrantLock` 对照应弱化性能口号，突出能力边界和条件队列设计。

## 4. 理解路径

### 第一节：从“自己再 lock 为什么没有把自己锁死”开场

用递归调用/嵌套方法场景开场：同一线程持锁后再次进入同一把锁，如果还是按“别人持有我就失败”的语义处理，它会把自己挡死。引出可重入锁必须同时记录“有没有锁住”和“是谁锁住、锁了几层”。

### 第二节：ReentrantLock 为什么把 state 解释成重入计数

证据：
- `ReentrantLock.java:126-140`：`nonfairTryAcquire`
- `ReentrantLock.java:146-156`：`tryRelease`
- `ReentrantLock.java:175` / `514-515`：`getHoldCount`

主线：
- `state == 0` 时，CAS 抢占并记录 owner。
- owner 再次获取时，不是失败，而是 `state + acquires`。
- 释放时逐次减计数，只有减到 0 才真正清 owner 并放锁。
- 可重入本质是“状态从二值升级为持有计数 + owner 身份追踪”。

### 第三节：公平与非公平真正只差在“排队者是否有优先权”

证据：
- `ReentrantLock.java:196-199`：`NonfairSync.tryAcquire`
- `ReentrantLock.java:206-213`：`FairSync.tryAcquire`
- `ReentrantLock.java:346-347`：`tryLock()`
- `AbstractQueuedSynchronizer.java:1554-1557`：`hasQueuedPredecessors`

主线：
- 非公平模式允许新来线程先试 CAS 抢锁。
- 公平模式多一道 `hasQueuedPredecessors()` 检查，让已排队者优先。
- `tryLock()` 无超时版直接走非公平获取，说明“公平”本来就是工程近似而非绝对教条。

### 第四节：为什么 AQS 主队列还不够——“拿不到锁”不等于“条件没满足”

证据：
- `AbstractQueuedSynchronizer.java:1868`：`ConditionObject`
- `AbstractQueuedSynchronizer.java:1871-1873`：`firstWaiter` / `lastWaiter`
- `AbstractQueuedSynchronizer.java:1979`：`signal`
- `AbstractQueuedSynchronizer.java:2074`：`await`

主线：
- AQS 主队列解决的是“获取同步状态失败后去哪等”。
- 但拿着锁执行时，线程还可能因为业务条件不满足而主动等待，例如“队列为空先等 notEmpty”。
- 这种等待不是‘抢锁失败’，而是‘先释放锁，等条件，再回来重新抢锁’，因此必须单独用条件队列表示。

### 第五节：`await()` 为什么一定要先 fullyRelease，再进条件等待

证据：
- `AbstractQueuedSynchronizer.java:1886`：`addConditionWaiter`
- `AbstractQueuedSynchronizer.java:1762`：`fullyRelease`
- `AbstractQueuedSynchronizer.java:2074-2085`：`await`

主线：
- `await` 前必须已经持有独占锁，否则连“我是在这把锁的条件上等待”都不成立。
- 线程要睡到条件队列里，就必须先把锁完整释放，否则别的线程永远进不来修改条件。
- `fullyRelease` 不是只放一次，而是保存并清空当前重入计数；唤醒后再靠 `acquireQueued(node, savedState)` 把重入层数恢复回来。
- 这解释了为什么 `Condition.await()` 和普通 `park()` 完全不是一个级别的等待。

### 第六节：`signal()` 为什么不是直接唤醒，而是先转回同步队列

证据：
- `AbstractQueuedSynchronizer.java:1912`：`doSignal`
- `AbstractQueuedSynchronizer.java:1713-1728`：`transferForSignal`
- `AbstractQueuedSynchronizer.java:1979-1984`：`signal`

主线：
- 条件满足时，signal 并不会让线程立刻继续执行，因为它还没重新拿回锁。
- 正确顺序是：把节点从条件队列转到 AQS 同步队列，重新纳入正常抢锁流程，然后在 await 那边继续 `acquireQueued`。
- 这也是为什么 `signal` 只是“给你回到抢锁赛道的资格”，不是“立刻恢复执行”的保证。

### 第七节：Condition 相比 wait/notify 真正多出来的是什么

证据：
- `ReentrantLock.java:481-482`：`newCondition`
- `AbstractQueuedSynchronizer.java:1994-1997`：`signalAll`

主线：
- 每个锁可以派生多条条件队列，例如 notEmpty / notFull 分开等。
- `Object.wait/notify` 只有一条监视器 wait set，容易惊群；Condition 允许定向唤醒特定条件上的等待者。
- 选型点不在“谁快”，而在“是否需要多条件、可中断等待、超时与显示锁能力”。

## 5. 失败方案清单

1. 把可重入锁仍按“别人持有就一律失败”的二值锁语义实现，导致同线程递归自锁死。
2. 持锁线程在业务条件不满足时直接 park，不释放锁也不进入条件队列。
3. `await()` 只释放一层锁，而不是 fullyRelease 全部重入层数。
4. `signal()` 直接 unpark 条件线程，却不给它回到同步队列重新争锁的机会。
5. 把公平锁和非公平锁当作完全不同等待机制。
6. 用单一 wait set 承担多个业务条件，导致 notifyAll 惊群。
7. 认为 `tryLock()` 在公平锁下也必须绝对遵守排队顺序。

## 6. 误解清单

1. 可重入只是“同一线程再次加锁会被特殊放行”，不需要计数。
2. `unlock()` 一次就一定彻底释放了锁。
3. `Condition.await()` 跟 `Thread.sleep()` 一样只是单纯暂停线程。
4. `signal()` 一调用，被唤醒线程就已经拿到锁继续执行。
5. Condition 队列和 AQS 主队列只是名字不同，本质同一条队列。
6. 公平锁意味着任何路径都绝不允许插队。
7. `synchronized` 和 `ReentrantLock` 的选型核心仍然是“谁更快”。

## 7. 证据清单

- `ReentrantLock.java:126-140`：`nonfairTryAcquire`
- `ReentrantLock.java:146-156`：`tryRelease`
- `ReentrantLock.java:165`：`newCondition`（Sync 内部）
- `ReentrantLock.java:175`：`getHoldCount`
- `ReentrantLock.java:196-199`：`NonfairSync.tryAcquire`
- `ReentrantLock.java:206-213`：`FairSync.tryAcquire`
- `ReentrantLock.java:346-347`：`tryLock()`
- `ReentrantLock.java:481-482`：对外 `newCondition`
- `ReentrantLock.java:514-515`：对外 `getHoldCount`
- `AbstractQueuedSynchronizer.java:1222`：`isHeldExclusively`
- `AbstractQueuedSynchronizer.java:1713-1728`：`transferForSignal`
- `AbstractQueuedSynchronizer.java:1762`：`fullyRelease`
- `AbstractQueuedSynchronizer.java:1868`：`ConditionObject`
- `AbstractQueuedSynchronizer.java:1871-1873`：`firstWaiter` / `lastWaiter`
- `AbstractQueuedSynchronizer.java:1886`：`addConditionWaiter`
- `AbstractQueuedSynchronizer.java:1912`：`doSignal`
- `AbstractQueuedSynchronizer.java:1979-1984`：`signal`
- `AbstractQueuedSynchronizer.java:1994-1997`：`signalAll`
- `AbstractQueuedSynchronizer.java:2074-2085`：`await`
- `AbstractQueuedSynchronizer.java:1554-1557`：`hasQueuedPredecessors`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇只解释独占锁和 ConditionObject 主线，不展开共享模式工具类内部实现。
- `synchronized` 的 JVM 级 wait set 实现只做对照，不展开 HotSpot ObjectMonitor 全部细节。
- 公平锁部分强调源码语义，不把“公平”外推成绝对时间公平。
- Condition 的超时、中断细分分支不逐行穷尽，重点放在状态转移骨架。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“state 为什么能表达可重入计数 → unlock 为什么归零才真释放 → 公平/非公平差异落在哪一行 → AQS 主队列为什么还不够 → await 如何 fullyRelease 并在 signal 后重返同步队列 → Condition 相比 wait/notify 为什么能做多条件定向唤醒”。
- 必须把可重入、条件队列和公平性放在同一条‘资格 + 条件等待’主线上讲。
- 必须讲清 `await` 的 fullyRelease / re-acquire 闭环。
- 必须讲清 `signal` 只是转移回同步队列，不等于立刻继续执行。
- 结尾要自然引到 `04-shared-tools.md`。
