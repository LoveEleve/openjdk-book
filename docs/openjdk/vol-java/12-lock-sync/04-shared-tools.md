# 04. 共享模式与并发工具族 — Semaphore/CountDownLatch/CyclicBarrier

> **前置依赖**: [12-lock-sync/01 — AQS 核心](01-aqs-core.md)(独占模式/模板方法)、[12-lock-sync/02 — AQS 的等待与唤醒](02-await-wakeup.md)(队列/park)、[12-lock-sync/03 — ReentrantLock 与 Condition](03-reentrantlock-condition.md)(Condition 条件队列)
> → **后续**:[12-lock-sync/05 — StampedLock 与读写锁](05-stamped-readwrite.md)
> 关联: 域 13 原子类(CAS 前置);域 11 线程(park/状态)

## 独占锁唤醒一个,共享锁怎么唤醒多个

ReentrantLock 是独占模式——一个线程持有,唤醒时只叫醒一个。但 Semaphore 释放 3 个许可,要唤醒 3 个排队者;CountDownLatch 计数归零,要唤醒所有等待者——这就是**共享模式**。这一篇拆: 共享模式的级联唤醒、三个工具的实现差异、以及 CyclicBarrier 为什么不用 AQS 共享模式。

## 1. "共享模式是什么？" — doAcquireShared 级联

### 1.1 获取成功:setHeadAndPropagate

`doAcquireShared`(`AbstractQueuedSynchronizer.java:994-1013`)与独占版的差异只有一处(`:1000-1004`):

```java
// AbstractQueuedSynchronizer.java:998-1013(截取核心,逐字)
                if (p == head) {
                    int r = tryAcquireShared(arg);
                    if (r >= 0) {
                        setHeadAndPropagate(node, r);
                        p.next = null; // help GC
                        return;
                    }
                }
                if (shouldParkAfterFailedAcquire(p, node))
                    interrupted |= parkAndCheckInterrupt();
```

- **`tryAcquireShared` 返回剩余许可数**(`r >= 0` 表示成功,负值表示失败)
- 成功时调用的是 **`setHeadAndPropagate(node, r)`**(`:755`),不是独占版的 setHead——**多了"传播"**

### 1.2 setHeadAndPropagate:级联唤醒

`setHeadAndPropagate`(`AbstractQueuedSynchronizer.java:755-773`)的核心:

```java
// AbstractQueuedSynchronizer.java:755-773(截取核心,逐字)
    private void setHeadAndPropagate(Node node, int propagate) {
        Node h = head; // Record old head for check below
        setHead(node);
        /*
         * Try to signal next queued node if:
         *   Propagation was indicated by caller,
         *     or was recorded (as h.waitStatus either before
         *     or after setHead) by a previous operation
         *     (note: this uses sign-check of waitStatus because
         *      PROPAGATE status may transition to SIGNAL.)
         * and
         *   The next node is waiting in shared mode,
         *     or we don't know, because it appears null
         */
        if (propagate > 0 || h == null || h.waitStatus < 0 ||
            (h = head) == null || h.waitStatus < 0) {
            Node s = node.next;
            if (s == null || s.isShared())
                doReleaseShared();
        }
    }
```

设 head 后,**满足任一传播条件就调 `doReleaseShared`**(`:717`)继续唤醒下一个共享节点: ①还有剩余许可(propagate > 0)②head 状态为负(SIGNAL/PROPAGATE,表示有后继要唤醒)③head 为空(极端竞态,保守处理)——**被唤醒的节点获取成功后又唤醒下一个**,链条式传播。释放 3 个许可,队头 3 个都能依次获取。

跨层标注: [域 13: 01-atomicinteger——Semaphore/CountDownLatch 的 state 递减全部走 CAS(compareAndSetState),与 AtomicInteger 同一机制;域 11 线程——共享队列的 park 挂起与独占模式相同(WAITING 状态)]

关键设计(斜体):*独占/共享的核心差异: 独占"唤醒一个",共享"传播唤醒"——setHeadAndPropagate 是共享模式的灵魂。面试"共享锁怎么唤醒多个": 级联信号——每个成功者检查剩余许可,还有就继续唤醒下一个。*

## 2. "Semaphore" — 许可池

### 2.1 state = 许可数

`Semaphore`(`Semaphore.java`,720 行)把 AQS 的 state 解释成**剩余许可数**(注释原话 "Uses AQS state to represent permits",`:168-169`)。构造时 `setState(permits)`(`:176`),公平/非公平结构同 ReentrantLock(`NonfairSync@227`/`FairSync@242`)。

- **`acquire()`**(`:317-318`): `sync.acquireSharedInterruptibly(1)`——**共享获取一个许可**
- **`release()`**(`:431-432`): `sync.releaseShared(1)`——归还一个许可

非公平 tryAcquireShared(`:234` 调 `nonfairTryAcquireShared`@183): 循环里 `available - acquires`,`remaining < 0` 失败否则 CAS——**先到先得,可插队**。公平版(`:249-259`): 先 `hasQueuedPredecessors()` 检查,有等待者直接返回 -1。

### 2.2 面试点:Semaphore vs 锁

**锁排他(一个持有),信号量共享(多个可同时持有)**——state=5 时 5 个线程可同时 acquire 成功。许可不足时,`acquireSharedInterruptibly` 走 doAcquireShared 入共享队列 park(域 12 第 2 篇的机制)。

关键设计(斜体):*Semaphore = "AQS 共享模式的 state 语义化"(state=剩余许可);公平版本同前驱检查。面试"Semaphore vs 锁": 锁排他,信号量共享(多个可同时持有);"acquire 会阻塞吗": 许可不足时入共享队列 park。*

## 3. "CountDownLatch" — 门闩

### 3.1 state = 计数,归零放行

`CountDownLatch`(`CountDownLatch.java`,316 行)的 Sync(`:162`)把 state 解释成**待完成计数**:

```java
// CountDownLatch.java:173-186(截取核心,逐字)
        protected int tryAcquireShared(int acquires) {
            return (getState() == 0) ? 1 : -1;
        }

        protected boolean tryReleaseShared(int releases) {
            // Decrement count; signal when transition to zero
            for (;;) {
                int c = getState();
                if (c == 0)
                    return false;
                int nextc = c - 1;
                if (compareAndSetState(c, nextc))
                    return nextc == 0;
            }
        }
```

- **`tryAcquireShared`**: state **非零一律失败**(返回 -1),只有归零才返回 1——**门闩语义**
- **`tryReleaseShared`**: CAS 递减,**归零那一刻返回 true**(触发 doReleaseShared 级联唤醒)
- **`await()`**(`:231-232`): `acquireSharedInterruptibly(1)`——等 state=0
- **`countDown()`**(`:291-292`): `releaseShared(1)`——计数减一

### 3.2 一次性

**计数归零后不可重置**——await 全部通过,新来的 await 也立即通过(state 恒为 0)。这就是"一次性门闩"。

关键设计(斜体):*CountDownLatch = "倒计数共享锁"——state 到 0 时所有等待者级联唤醒(共享模式)。面试"await 多个线程": 都等 state=0,级联唤醒全部;"与 CyclicBarrier 区别": Latch 一次性、Barrier 可复用且阻塞的是参与者自己。*

## 4. "CyclicBarrier" — 可复用屏障

### 4.1 实现:独占锁 + 条件变量(不是 AQS 共享模式!)

`CyclicBarrier`(`CyclicBarrier.java`,492 行)**没有用 AQS 的共享模式**——它内部是 ReentrantLock + Condition(`:157-159`):

```java
// CyclicBarrier.java:155-159(截取核心,逐字)
    /** The lock for guarding barrier entry */
    private final ReentrantLock lock = new ReentrantLock();
    /** Condition to wait on until tripped */
    private final Condition trip = lock.newCondition();
```

`dowait`(`:199`)的流程: 持锁 → 检查 broken/中断 → `--count` → **最后一个参与者(count 归零)**: 执行 barrierCommand(可选)后 `nextGeneration`(`:178`,trip.signalAll 唤醒全部 + **generation 换新代**)→ **其余参与者**递减后 `trip.await()` 挂起,被 signalAll 唤醒后**检查代次是否变化**(generation 换新则放行,否则继续等)。

### 4.2 Generation:轮次区分

`Generation`(`:151`)标记"当前轮次";**每次冲破屏障换一代**(`nextGeneration`,`:178`)——这就是可复用的机制: 下一轮是新 Generation,计数器复位。中断/超时/异常时 `breakBarrier`(`:190`)把当前代标记为 broken,其余等待者抛 `BrokenBarrierException`。

### 4.3 Latch vs Barrier

| | CountDownLatch | CyclicBarrier |
|--|---------------|---------------|
| 等待对象 | 外部事件(计数归零) | **参与者互相等** |
| 谁阻塞 | 调 await 的人 | 每个 await 的参与者 |
| 可复用 | 否(一次性) | 是(Generation 换代) |
| 实现 | AQS 共享模式 | ReentrantLock + Condition |

关键设计(斜体):*"Barrier = 汇合点"——分治任务每轮并行计算后汇合;Generation 区分轮次(中断/超时破坏屏障需 reset)。面试"Latch vs Barrier": 等待外部事件 vs 参与者互相等;能说出"CyclicBarrier 是 ReentrantLock+Condition 实现,不是 AQS 共享"就是冷门细节分。*

## 核心悬念

工具族收官——但**读写分离**呢?`ReentrantReadWriteLock` 怎么让"多个读者并行、写者独占"?`StampedLock` 的乐观读是什么——不用锁的读?——下一篇: StampedLock 与读写锁。

> → [12-lock-sync/05 — StampedLock 与读写锁](05-stamped-readwrite.md)
