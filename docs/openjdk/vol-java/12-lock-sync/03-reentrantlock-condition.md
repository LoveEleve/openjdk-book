# 03. ReentrantLock 与 Condition — 可重入、公平性、条件队列

> **前置依赖**: [12-lock-sync/01 — AQS 核心](01-aqs-core.md)(state/tryAcquire 模板)、[12-lock-sync/02 — AQS 的等待与唤醒](02-await-wakeup.md)(公平性/hasQueuedPredecessors)
> → **后续**:[12-lock-sync/04 — 共享模式与并发工具族](04-shared-tools.md)
> 关联: 内部卷 19-sync(wait/notify 的 JVM 实现);域 11 线程(中断语义)

## 面试"ReentrantLock 和 synchronized 区别"怎么答

可重入、公平性、Condition——面试必考三件套。这一篇把 ReentrantLock 的完整实现拆开: state 计数怎么实现可重入、公平/非公平的 tryAcquire 差异、Condition 的条件队列与 wait/notify 对照、最后给选型矩阵。

## 1. "可重入怎么实现？" — state 计数

### 1.1 state 即重入计数

`nonfairTryAcquire`(`ReentrantLock.java:126-140`)的核心:

```java
// ReentrantLock.java:126-140(截取核心,逐字)
        final boolean nonfairTryAcquire(int acquires) {
            final Thread current = Thread.currentThread();
            int c = getState();
            if (c == 0) {
                if (compareAndSetState(0, acquires)) {
                    setExclusiveOwnerThread(current);
                    return true;
                }
            }
            else if (current == getExclusiveOwnerThread()) {
                int nextc = c + acquires;
                if (nextc < 0) // overflow
                    throw new Error("Maximum lock count exceeded");
                setState(nextc);
                return true;
            }
            return false;
        }
```

两条路径:

1. **`c == 0`(无人持有)**: `compareAndSetState(0, acquires)` CAS 抢占,成功则 `setExclusiveOwnerThread(current)` 记录持有者
2. **`current == getExclusiveOwnerThread()`(自己持有)**: **`setState(c + acquires)` 计数累加**——这就是可重入: 同一线程 lock 两次,state 变 2,不死锁

`exclusiveOwnerThread`(`AbstractOwnableSynchronizer.java:64`)由 `setExclusiveOwnerThread`(`:73`)/`getExclusiveOwnerThread`(`:83`)维护——**持有者身份追踪**。

### 1.2 释放:归零才真正释放

`tryRelease`(`ReentrantLock.java:146-156`):

```java
// ReentrantLock.java:146-156(截取核心,逐字)
        protected final boolean tryRelease(int releases) {
            int c = getState() - releases;
            if (Thread.currentThread() != getExclusiveOwnerThread())
                throw new IllegalMonitorStateException();
            boolean free = false;
            if (c == 0) {
                free = true;
                setExclusiveOwnerThread(null);
            }
            setState(c);
            return free;
        }
```

每次 unlock `state-1`;**归零(`c == 0`)才真正释放**(清 owner);非持有者调用抛 `IllegalMonitorStateException`。面试题 "lock 两次不 unlock 会怎样": state=2 未归零,其他线程永远拿不到——**重入泄漏**,连接/资源场景的常见 bug。

关键设计(斜体):*"可重入 = 同一线程重复计数"——state 从布尔锁升级为计数锁。面试"为什么 synchronized 可重入": JVM 维护同一原理(内部卷 19);Lock 的重入是显式的 state 语义——计数+持有者追踪,两次 lock 必须两次 unlock。*

## 2. "公平与非公平的实现差异" — tryAcquire 对比

### 2.1 非公平:直接 CAS

`NonfairSync.tryAcquire`(`ReentrantLock.java:198`,类在 `:196`)直接调 nonfairTryAcquire——**新线程与队列头竞争,插队被允许**(能 CAS 到就赢)。

### 2.2 公平:前驱检查

`FairSync.tryAcquire`(`ReentrantLock.java:213`,类在 `:206`)多一个条件(第 2 篇已详述):

```java
// ReentrantLock.java:213-221(截取核心,逐字)
        protected final boolean tryAcquire(int acquires) {
            final Thread current = Thread.currentThread();
            int c = getState();
            if (c == 0) {
                if (!hasQueuedPredecessors() &&
                    compareAndSetState(0, acquires)) {
                    setExclusiveOwnerThread(current);
                    return true;
                }
            }
```

**`!hasQueuedPredecessors()`**——队列里有等待者(且不是自己)就放弃。实现差异就是这一行。

### 2.3 tryLock 的"愿赌服输"

`tryLock()`(`ReentrantLock.java:346-348`)无条件 `sync.nonfairTryAcquire(1)`——**即使公平锁也走非公平路径**("愿赌服输": 既然选择了 try,就接受插队竞争的结果);超时版 `tryLock(timeout)`(`:422-424`)走 `tryAcquireNanos`,内部仍用公平 tryAcquire。

关键设计(斜体):*实现差异一行代码(hasQueuedPredecessors)——面试"公平锁代码差别"答案: 前驱检查。tryLock() 不走公平(获取瞬间的插队是允许的,但超时版公平);生产: 默认非公平,公平锁用于饥饿敏感场景(低频)。*

## 3. "Condition 是什么？" — 条件队列

### 3.1 接口与实现

`Condition`(`Condition.java:180` 接口,490 行)提供 `await()/signal()/signalAll()`,类比 `Object.wait/notify/notifyAll`。实现是 AQS 内部类 **`ConditionObject`**(`AbstractQueuedSynchronizer.java:1868`)——**每条件一条等待队列**(`firstWaiter`/`lastWaiter`,`:1871-1873`;节点状态 `CONDITION=-2`,第 1 篇已见)。

### 3.2 await:释放锁 + 挂起

`await()`(`AbstractQueuedSynchronizer.java:2074-2094`)五步:

```java
// AbstractQueuedSynchronizer.java:2074-2094(截取核心,逐字)
        public final void await() throws InterruptedException {
            if (Thread.interrupted())
                throw new InterruptedException();
            Node node = addConditionWaiter();
            int savedState = fullyRelease(node);
            int interruptMode = 0;
            while (!isOnSyncQueue(node)) {
                LockSupport.park(this);
                if ((interruptMode = checkInterruptWhileWaiting(node)) != 0)
                    break;
            }
            if (acquireQueued(node, savedState) && interruptMode != THROW_IE)
                interruptMode = REINTERRUPT;
            if (node.nextWaiter != null) // clean up if cancelled
                unlinkCancelledWaiters();
            if (interruptMode != 0)
                reportInterruptAfterWait(interruptMode);
        }
```

1. **中断检查**: 已中断直接抛 InterruptedException
2. **`addConditionWaiter()`**(`:1886`): **先校验持锁**(`:1887-1888` 的 `isHeldExclusively`,非持有者抛 `IllegalMonitorStateException`——与 wait 必须持锁的前提相同),再入条件队列
3. **`fullyRelease(node)`**(`:1762`): **保存当前 state(重入计数)并全部释放**——与 wait 相同: 必须释放锁才能让其他线程进
4. **`while (!isOnSyncQueue(node)) LockSupport.park(this)`**: 在条件队列上挂起,直到被 signal 转移回主队列
5. **`acquireQueued(node, savedState)`**: 被唤醒后**重新获取锁(恢复重入计数)**——savedState 就是原计数

### 3.3 signal:转移节点

`signal()`(`AbstractQueuedSynchronizer.java:1979-1986`): 持锁校验(`isHeldExclusively`,非持有者抛 `IllegalMonitorStateException`)→ `doSignal(first)`(`:1912`)→ `transferForSignal`(`:1713`):

```java
// AbstractQueuedSynchronizer.java:1713-1732(截取核心,逐字)
    final boolean transferForSignal(Node node) {
        /*
         * If cannot change waitStatus, the node has been cancelled.
         */
        if (!node.compareAndSetWaitStatus(Node.CONDITION, 0))
            return false;

        /*
         * Splice onto queue and try to set waitStatus of predecessor to
         * indicate that thread is (probably) waiting. If cancelled or
         * attempt to set waitStatus fails, wake up to resync (in which
         * case the waitStatus can be transiently and harmlessly wrong).
         */
        Node p = enq(node);
        int ws = p.waitStatus;
        if (ws > 0 || !p.compareAndSetWaitStatus(ws, Node.SIGNAL))
            LockSupport.unpark(node.thread);
        return true;
    }
```

**`CONDITION → 0 → enq 主队列 → 设 SIGNAL`**: 把节点从条件队列**转移**到 AQS 主队列(不是直接唤醒)——被转移的线程在 await 的 while 循环里发现 `isOnSyncQueue` 为 true,退出等待,进入 `acquireQueued` 排队获取锁。特殊分支(`:1727-1728`): 前驱已取消或 CAS 设 SIGNAL 失败时,`LockSupport.unpark(node.thread)` **直接唤醒**——让线程自己重新同步(此时 waitStatus 的短暂不一致无害)。

### 3.4 为什么用 Condition:定向唤醒

**一个锁可以有多个条件队列**(`lock.newCondition()` 多次)——生产者消费者经典用法: "队列不满"和"队列不空"两个条件分开等。用 synchronized 只有一个 wait set,只能 notifyAll 全唤醒(惊群);Condition 是**定向唤醒**。

关键设计(斜体):*Condition 的价值: 多条条件队列(如"队列不满"和"队列不空"分开等)——用 synchronized 只能 notifyAll 全唤醒。面试"await 和 wait 区别": Lock 体系 vs 内置监视器;await 可超时/可中断;能说出 await 的五步(入队→全量释放→挂起→转移→重获取)就是源码级。*

跨层标注: [内部卷: 19-sync 03-enter-exit-wait——Object.wait/notify 的 JVM 实现(ObjectMonitor 的 wait set)与 ConditionObject 的条件队列是"监视器条件等待 vs Java 层条件队列"两种方案;synchronized 单 wait set vs Lock 多条件]

## 4. "synchronized vs Lock" — 选型矩阵

| 维度 | synchronized | ReentrantLock |
|------|-------------|---------------|
| 实现 | JVM 内置(内部卷 19) | Java AQS(本域) |
| 公平性 | 非公平 | 可选公平 |
| 中断 | 不可中断 | `lockInterruptibly` |
| 超时 | 无 | `tryLock(timeout)` |
| 条件 | 一个 wait set | 多 Condition |
| 性能 | 现代 JVM 已优化 | 相当 |

关键设计(斜体):*现代 JVM 的 synchronized 已高度优化(偏向锁/轻量锁/膨胀三级,内部卷 19)——业界共识是 JDK6+ 与 Lock 性能相当;选型看**能力**不看性能: 需要超时/中断/多条件用 Lock,否则 synchronized(简洁)。面试别再说"Lock 快";能说"性能相当(业界共识),选型看能力"才是现在的正确答案。*

## 核心悬念

独占锁讲完——**共享模式**呢?Semaphore 的"多个许可"、CountDownLatch 的"计数归零"——`doAcquireShared` 的级联传播(`setHeadAndPropagate`)怎么让多个线程同时唤醒?——下一篇: 共享模式与并发工具族。

> → [12-lock-sync/04 — 共享模式与并发工具族](04-shared-tools.md)
