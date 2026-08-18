# 02. AQS 的等待与唤醒 — acquireQueued、park、取消、公平性

> **前置依赖**: [12-lock-sync/01 — AQS 核心](01-aqs-core.md)(state/CLH 队列/acquire 骨架)、[11-thread-threadlocal/01 — 线程生命周期](../11-thread-threadlocal/01-thread-lifecycle.md)(中断与线程状态)
> → **后续**:[12-lock-sync/03 — ReentrantLock 与 Condition](03-reentrantlock-condition.md)
> 关联: 域 32 Unsafe(park/unpark,规划中);域 11 线程(WAITING 状态)

## 线程入队之后,睡与醒的完整机制

第 1 篇讲了 AQS 的骨架: 尝试失败就入队。但入队之后呢——线程怎么挂起、谁唤醒它、中断怎么办、取消的节点怎么清理、公平锁怎么禁止插队?这一篇把 AQS 队列的完整运转拆开: acquireQueued 的自旋+park、SIGNAL 委托、unparkSuccessor 的唤醒传播、以及公平性检查。

## 1. "acquireQueued 在干什么？" — 自旋 + park

### 1.1 循环:前驱是 head 才尝试

`acquireQueued`(`AbstractQueuedSynchronizer.java:906-927`)是排队线程的主循环:

```java
// AbstractQueuedSynchronizer.java:906-927(截取核心,逐字)
    final boolean acquireQueued(final Node node, int arg) {
        boolean interrupted = false;
        try {
            for (;;) {
                final Node p = node.predecessor();
                if (p == head && tryAcquire(arg)) {
                    setHead(node);
                    p.next = null; // help GC
                    return interrupted;
                }
                if (shouldParkAfterFailedAcquire(p, node))
                    interrupted |= parkAndCheckInterrupt();
            }
        } catch (Throwable t) {
            cancelAcquire(node);
            if (interrupted)
                selfInterrupt();
            throw t;
        }
    }
```

循环体的路径:

1. **前驱是 head 才尝试获取**(`:912`): `p == head && tryAcquire(arg)`——**只有排到队首的节点才有资格尝试**。这就是 FIFO 近似的实现: 队列头的人先获取,后面的排队等
2. **获取成功 → `setHead(node)`**(`:913`,自己成为新头,`setHead`@674)并 `p.next = null`——断开旧头的 next 引用,`// help GC`(让被替换的旧头可被回收)
3. **失败 → `shouldParkAfterFailedAcquire(p, node)`**(§2)决定是否 `parkAndCheckInterrupt()`(挂起)
4. **异常兜底**(`:920-925`): `cancelAcquire(node)` 取消入队、恢复中断标志、重抛

### 1.2 "自旋 + 挂起"混合

面试问"acquireQueued 是自旋吗?"——严格说**不是忙等自旋,是"循环 + 挂起"**: 每次循环要么成功返回、要么 `shouldParkAfterFailedAcquire` 返回 true 就 park 挂起(零 CPU);只有"前驱状态推进中"(设 SIGNAL 的那次重试)会无 park 地快速再循环一次,其余时间线程都在 park 里沉睡,被唤醒后回到循环重新检查(乐观重试)。

关键设计(斜体):*"只有前驱是 head 才尝试"保证 FIFO 近似——队列头的人先获取;循环语义: 被唤醒后重新尝试(乐观重试);park 挂起避免自旋浪费。面试"acquireQueued 是自旋吗": 不是忙等——循环+挂起,前驱检查失败就 park,不空转。*

## 2. "shouldParkAfterFailedAcquire 做什么？" — SIGNAL 状态推进

### 2.1 三分支状态机

`shouldParkAfterFailedAcquire`(`AbstractQueuedSynchronizer.java:844-866`,第 1 篇已提)是"能否安全挂起"的判定:

```java
// AbstractQueuedSynchronizer.java:844-866(截取核心,逐字)
    private static boolean shouldParkAfterFailedAcquire(Node pred, Node node) {
        int ws = pred.waitStatus;
        if (ws == Node.SIGNAL)
            /*
             * This node has already set status asking a release
             * to signal it, so it can safely park.
             */
            return true;
        if (ws > 0) {
            /*
             * Predecessor was cancelled. Skip over predecessors and
             * indicate retry.
             */
            do {
                node.prev = pred = pred.prev;
            } while (pred.waitStatus > 0);
            pred.next = node;
        } else {
            /*
             * waitStatus must be 0 or PROPAGATE.  Indicate that we
             * need a signal, but don't park yet.  Caller will need to
             * retry to make sure it cannot acquire before parking.
             */
            pred.compareAndSetWaitStatus(ws, Node.SIGNAL);
        }
        return false;
    }
```

三个分支:

1. **`pred.waitStatus == SIGNAL`** → **可以安全挂起**(返回 true)——前驱已被承诺"释放时唤醒我"
2. **`pred.waitStatus > 0`(CANCELLED)** → **跳过已取消的前驱**: `node.prev` 向前越过所有 CANCELLED 节点(顺带清理),返回 false 再循环
3. **否则(0 或 PROPAGATE)** → **CAS 把前驱设为 SIGNAL**(`:861` 的 `pred.compareAndSetWaitStatus(ws, Node.SIGNAL)`),返回 false 再循环一次

### 2.2 为什么要"设 SIGNAL 后再 park"

**竞态闭合**: 如果直接 park,可能"刚 park 完,前驱就释放了"——释放者检查前驱状态时看到 0(不是 SIGNAL),认为"没人等我",不唤醒——线程永久睡死。所以必须先 CAS 设 SIGNAL 再 park,第二次循环确认前驱状态稳定才挂起。SIGNAL 是"唤醒委托": **我 park 前通知前驱: 你释放时要唤醒我**。

关键设计(斜体):*SIGNAL 机制解决"释放时唤醒谁"的问题——每个节点对前驱承诺"唤醒我",释放者只唤醒 head 的后继;竞态窗口由"设 SIGNAL 后再 park"闭合(第二次循环检查)。面试"CANCELLED 节点怎么来的": 中断/超时放弃的线程;清理在 shouldPark/acquireQueued 中顺带完成。*

## 3. "unparkSuccessor 唤醒谁？" — 释放传播

### 3.1 从 tail 向前找

`unparkSuccessor`(`AbstractQueuedSynchronizer.java:685-712`)在 release 时唤醒后继:

```java
// AbstractQueuedSynchronizer.java:685-712(截取核心,逐字)
    private void unparkSuccessor(Node node) {
        /*
         * If status is negative (i.e., possibly needing signal) try
         * to clear in anticipation of signalling.  It is OK if this
         * fails or if status is changed by waiting thread.
         */
        int ws = node.waitStatus;
        if (ws < 0)
            node.compareAndSetWaitStatus(ws, 0);

        /*
         * Thread to unpark is held in successor, which is normally
         * just the next node.  But if cancelled or apparently null,
         * traverse backwards from tail to find the actual
         * non-cancelled successor.
         */
        Node s = node.next;
        if (s == null || s.waitStatus > 0) {
            s = null;
            for (Node p = tail; p != node && p != null; p = p.prev)
                if (p.waitStatus <= 0)
                    s = p;
        }
        if (s != null)
            LockSupport.unpark(s.thread);
    }
```

两步:

1. **清 SIGNAL**(`ws < 0` 时 CAS 置 0)——唤醒前清除委托标记
2. **找真正的后继**: 先看 `node.next`——**若为 null 或已取消(CANCELLED),从 tail 向前遍历**找最近的未取消节点(`waitStatus <= 0`),然后 `LockSupport.unpark(s.thread)` 唤醒

### 3.2 为什么"从 tail 向前找"

注释说得明白("traverse backwards from tail to find the actual non-cancelled successor"): **入队/取消会临时断链**——enq 的 CAS 尾插中,`prev` 先设、`next` 后连;取消节点也可能使 next 指向异常。向后遍历不可靠,反向遍历保底。

唤醒传播链: 释放者 → unparkSuccessor(head) → 队首线程醒 → tryAcquire 成功 → 新 release → 唤醒下一个——**锁的交接是链条式的**。

跨层标注: [域 32 Unsafe(规划中)——parkAndCheckInterrupt 的 LockSupport.park 是 Unsafe.park 的封装(许可语义);域 11 线程——park 挂起的线程处于 WAITING 状态(jstack 可见)]

关键设计(斜体):*"从 tail 向前找"的原因: 入队/取消会临时断链(prev 不可靠),反向遍历保底;唤醒传播链: 释放者→后继→后继的 release 再唤醒下一个——锁的交接就是这样链条式。面试"为什么唤醒 head 后的第一个而不是 head": head 是已获取者的占位(虚拟头)。*

## 4. "公平性" — hasQueuedPredecessors

### 4.1 非公平:直接 CAS,可以插队

`NonfairSync.tryAcquire`(`ReentrantLock.java:198`,类在 `:196`)走 `nonfairTryAcquire`(`:126`): 先直接 CAS——**新线程可以与队列头竞争**,插队是允许的(能抢到就抢)。

### 4.2 公平:队列非空必须排队

`FairSync.tryAcquire`(`ReentrantLock.java:213`,类在 `:206`)多一个检查(`:217`):

```java
// ReentrantLock.java:215-224(截取核心,逐字)
            int c = getState();
            if (c == 0) {
                if (!hasQueuedPredecessors() &&
                    compareAndSetState(0, acquires)) {
                    setExclusiveOwnerThread(current);
                    return true;
                }
            }
```

**`!hasQueuedPredecessors()`**——队列里有等待者就放弃这次获取,老老实实排队。`hasQueuedPredecessors`(`AbstractQueuedSynchronizer.java:1551-1569`): 检查 head.next 是否有非取消等待者(与 unparkSuccessor 同理,tail 向前遍历处理并发取消),且不是当前线程自己。

### 4.3 公平 vs 非公平

- **公平代价**: 必须等队列清空——吞吐下降(排队线程可能正好不是刚释放锁的线程)
- **非公平收益**: 减少唤醒切换——刚释放的线程可能立刻重获锁(缓存还热),吞吐更高
- **JDK 默认非公平**: "吞吐 vs 公平"的权衡——插队概率实际低,但避免了大量唤醒开销

面试追问 "公平锁一定公平吗?": **工程近似**——`tryLock()`(无超时版)无条件调 `sync.nonfairTryAcquire(1)`(`ReentrantLock.java:346-348`),**即使 FairSync 也直接 CAS 抢锁,绕过队列**(著名的 barging 行为,JDK 文档明说);超时版 `tryLock(timeout)` 走 `tryAcquireNanos`(`:424`)内部仍用公平 tryAcquire,是公平的。

关键设计(斜体):*公平性代价: 必须等队列清空(吞吐下降);非公平收益: 减少唤醒切换(刚释放的线程可能立刻重获);JDK 默认非公平是"吞吐 vs 公平"的权衡。面试"为什么默认非公平": 吞吐优先 + 插队概率实际低;再答"公平锁是工程近似(tryLock() 无超时版直接 nonfairTryAcquire,绕过队列)"就是细节分。*

## 核心悬念

AQS 队列运转通了——**可重入怎么实现**?`ReentrantLock` 的 state 计数、公平/非公平 tryAcquire 的完整差异、`Condition` 的条件队列(await 让出锁、signal 唤醒)——下一篇: ReentrantLock 与 Condition。

> → [12-lock-sync/03 — ReentrantLock 与 Condition](03-reentrantlock-condition.md)
