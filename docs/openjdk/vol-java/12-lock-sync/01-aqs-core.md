# 01. AQS 核心 — state、CLH 队列、模板方法

> **前置依赖**: [13-atomic/01 — AtomicInteger 与 CAS 封装](../13-atomic/01-atomicinteger-cas.md)(CAS 与 volatile 语义)、[11-thread-threadlocal/01 — 线程生命周期](../11-thread-threadlocal/01-thread-lifecycle.md)(线程状态与中断)
> → **后续**:[12-lock-sync/02 — AQS 的等待与唤醒](02-await-wakeup.md)
> 关联: 内部卷 19-sync(ObjectMonitor 对照);域 32 Unsafe(park/unpark)

## 并发面试的压轴题

ReentrantLock、Semaphore、CountDownLatch——这些并发工具的底层都是同一个类: `AbstractQueuedSynchronizer`(AQS)。面试官说"讲讲 AQS"时,想听的是三件事: state 怎么管、CLH 队列怎么排、模板方法怎么让子类定制。这一篇把这三件事讲透。

## 1. "AQS 是什么？" — 同步器的通用框架

### 1.1 同步状态 + 等待队列

AQS(`AbstractQueuedSynchronizer.java`)的核心是**两个东西的组合**:

- **同步状态(state)**: 一个 volatile int,含义由子类定义(锁的持有数/许可数/计数)
- **等待队列(CLH 变体)**: 抢锁失败的线程排成双向链表,挂起等待唤醒

这就是"同步器的通用框架": **state 管理"谁有资格" + 队列管理"谁在等"**。ReentrantLock 把 state 解释成"重入计数",Semaphore 解释成"剩余许可",CountDownLatch 解释成"待计数"——**同一个 state,不同语义**。

### 1.2 模板方法模式

AQS 是**模板方法模式**的教科书实现: AQS 提供 acquire/release 的骨架与全部队列管理,子类只实现四个钩子:

```java
// AbstractQueuedSynchronizer.java:1117-1120(截取核心,逐字)
    protected boolean tryAcquire(int arg) {
        throw new UnsupportedOperationException();
    }
```

四个钩子(`tryAcquire`/`tryRelease`/`tryAcquireShared`/`tryReleaseShared`)默认抛 `UnsupportedOperationException`——**子类按需覆写**。ReentrantLock 实现 tryAcquire/tryRelease(独占),Semaphore 实现 tryAcquireShared/tryReleaseShared(共享)。

关键设计(斜体):*"state 是什么含义由子类决定"——锁的持有数/许可数/计数——AQS 只管"状态变化 + 排队阻塞"。面试"为什么说 AQS 是框架": 模板方法 + 队列复用——子类写几行状态逻辑,排队/阻塞/唤醒全免费;再答"和 synchronized 的关系": synchronized 是 JVM 内置(内部卷 19),AQS 是 Java 层框架。*

## 2. "state 怎么管理？" — volatile + CAS

### 2.1 单一事实来源

`state`(`AbstractQueuedSynchronizer.java:580`)与三个操作:

```java
// AbstractQueuedSynchronizer.java:580(截取核心,逐字)
    private volatile int state;
```

```java
// AbstractQueuedSynchronizer.java:587-589(截取核心,逐字)
    protected final int getState() {
        return state;
    }
```

```java
// AbstractQueuedSynchronizer.java:596-599(截取核心,逐字)
    protected final void setState(int newState) {
        state = newState;
    }
```

```java
// AbstractQueuedSynchronizer.java:611-614(截取核心,逐字)
    protected final boolean compareAndSetState(int expect, int update) {
        return STATE.compareAndSet(this, expect, update);
    }
```

- **`private volatile int state`**(`:580`): 可见性由 volatile 保证
- **`getState()`**(`:587`)/**`setState()`**(`:596`): volatile 读/写(域 13 第 1 篇的语义)
- **`compareAndSetState`**(`:611`): **CAS 更新**——`STATE.compareAndSet`(VarHandle,域 13 的机制)

### 2.2 锁的本质

以 ReentrantLock 为例: 获取锁 = `tryAcquire` 里 CAS `state 0→1`(`compareAndSetState(0, acquires)`,acquires 通常是 1);重入 = 已持有者 `state+acquires`;释放 = `state-releases`,归零才真正释放。**锁的本质 = 对共享状态的安全修改**: CAS 保证原子,volatile 保证可见,队列保证公平排队。

面试追问 "为什么 state 是 int 不是 boolean": **可重入计数/许可数需要多值**——boolean 表达不了"重入了 3 次"。

关键设计(斜体):*state 是"同步状态的单一事实来源"——volatile 可见 + CAS 原子;锁的获取 = tryAcquire 里 CAS state 0→1 成功。面试"锁的本质是什么": 对共享状态的安全修改——CAS 原子 + volatile 可见 + 队列排队,三者缺一不可。*

## 3. "CLH 队列是什么？" — 双向等待队列

### 3.1 head/tail 与 Node

队列是**CLH 变体**(虚拟头节点的双向链表):

```java
// AbstractQueuedSynchronizer.java:569 + 575(截取核心,逐字;中间注释省略)
    private transient volatile Node head;
...
    private transient volatile Node tail;
```

**Node**(`AbstractQueuedSynchronizer.java:394` 起)的字段: `waitStatus`(状态)、`prev`/`next`(双向链)、`thread`(等待线程)。状态常量(`:401-405`):

| 常量 | 值 | 含义 |
|------|:--:|------|
| `CANCELLED` | 1 | 节点已取消(中断/超时退出) |
| `SIGNAL` | -1 | **后继需要唤醒**("我后面有人") |
| `CONDITION` | -2 | 节点在条件队列(第 2 篇) |

### 3.2 enq:CAS 尾插

并发入队靠 CAS(`AbstractQueuedSynchronizer.java:629-643`):

```java
// AbstractQueuedSynchronizer.java:629-643(截取核心,逐字)
    private Node enq(Node node) {
        for (;;) {
            Node oldTail = tail;
            if (oldTail != null) {
                node.setPrevRelaxed(oldTail);
                if (compareAndSetTail(oldTail, node)) {
                    oldTail.next = node;
                    return oldTail;
                }
            } else {
                initializeSyncQueue();
            }
        }
    }
```

三步: ① `setPrevRelaxed(oldTail)` 指向前尾 ② **`compareAndSetTail(oldTail, node)` CAS 把尾指针换到新节点**——成功才 `oldTail.next = node`(此时队列已一致)③ 失败(别人先入队)重试;tail 为 null(空队列)先 `initializeSyncQueue`。**CAS 尾插保证并发入队不丢节点**。

### 3.3 为什么用队列不用自旋

无限自旋浪费 CPU(空转);排队 + park 挂起(零 CPU 等待)是正确方案。**SIGNAL 状态是唤醒传播的基础**: 节点挂起前把**前驱**的 waitStatus 设成 SIGNAL(`shouldParkAfterFailedAcquire` 的 `pred.compareAndSetWaitStatus(ws, Node.SIGNAL)`,`AbstractQueuedSynchronizer.java:867`)——语义是"你释放时唤醒我",SIGNAL 挂在**前驱**身上(第 2 篇详述)。

关键设计(斜体):*CLH 队列是"FIFO 近似"——head 后第一个是等待最久的;CAS 尾插保证并发入队;SIGNAL 状态表示"我后面有人,你要唤醒他"。面试"为什么用队列不用自旋": 无限自旋浪费 CPU,排队 + park 挂起零开销等待;能画出 head/tail/Node 三字段结构就是细节分。*

跨层标注: [内部卷: 19-sync 01-lock-hierarchy——synchronized 的 ObjectMonitor 用 cxq/EntryList 排队,与 AQS 的 CLH 队列是 JVM 层 vs Java 层两种排队方案]

## 4. "acquire 骨架" — 模板方法流程

### 4.1 acquire:尝试失败才排队

`acquire`(`AbstractQueuedSynchronizer.java:1238-1242`):

```java
// AbstractQueuedSynchronizer.java:1238-1242(截取核心,逐字)
    public final void acquire(int arg) {
        if (!tryAcquire(arg) &&
            acquireQueued(addWaiter(Node.EXCLUSIVE), arg))
            selfInterrupt();
    }
```

一行代码,四步语义:

1. **`tryAcquire(arg)`**(子类钩子): 尝试获取——大多数情况直接成功,路径结束
2. **失败才 `addWaiter(Node.EXCLUSIVE)`**(`:650`): 包成独占模式 Node 入队
3. **`acquireQueued(node, arg)`**(`:906`): 排队等待——自旋检查前驱是否为 head、尝试获取、失败则 park(第 2 篇详述)
4. **`selfInterrupt()`**: 若等待期间被中断,恢复中断标志

**"尝试失败才排队"是乐观路径**: 无竞争时 tryAcquire 一次 CAS 成功,队列零开销。

### 4.2 release:释放并唤醒后继

`release`(`AbstractQueuedSynchronizer.java:1301-1310`):

```java
// AbstractQueuedSynchronizer.java:1301-1310(截取核心,逐字)
    public final boolean release(int arg) {
        if (tryRelease(arg)) {
            Node h = head;
            if (h != null && h.waitStatus != 0)
                unparkSuccessor(h);
            return true;
        }
        return false;
    }
```

`tryRelease`(子类)成功 → `unparkSuccessor(h)`(`:685`)唤醒 head 的后继——队列的**队首前进**。`h.waitStatus != 0`(`:1304`)判断 head 是否需要处理(SIGNAL 表示有后继要唤醒;CANCELLED 时 unparkSuccessor 内部会跳过已取消节点找下一个有效后继)。

关键设计(斜体):*"尝试失败才排队"是乐观路径——大多数情况 tryAcquire 直接成功(无队列开销)。面试画 acquire/release 两幅流程图是基本功: acquire = tryAcquire → addWaiter → acquireQueued;release = tryRelease → unparkSuccessor。再问"tryAcquire 谁实现": ReentrantLock 的 FairSync/NonfairSync 等(域 12 后文)。*

## 核心悬念

入队之后——**线程怎么睡、怎么被叫醒**?`acquireQueued` 的自旋+park、`shouldParkAfterFailedAcquire` 怎么把前驱状态推进到 SIGNAL、等待期间被中断怎么办、取消的节点怎么清理——下一篇: AQS 的等待与唤醒。

> → [12-lock-sync/02 — AQS 的等待与唤醒](02-await-wakeup.md)
