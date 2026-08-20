# 01. AQS 核心 — state、CLH 队列、模板方法

> 🔴 Deep | 域 12 锁与同步器第 1 篇 | Layer 4
> 读者处境: 面试"讲讲 AQS"是并发面试的压轴题——state 语义、CLH 队列、模板方法一次讲透。

### 1. "AQS 是什么？" — 同步器的通用框架

场景: ReentrantLock/Semaphore/CountDownLatch 全都基于 AQS——它提供了什么?

- `AbstractQueuedSynchronizer.java` — **同步状态 + 等待队列**的通用实现
- 核心思想: **模板方法模式**——AQS 提供 acquire/release 骨架与队列管理,子类只实现 `tryAcquire/tryRelease/tryAcquireShared/tryReleaseShared`(如 `AbstractQueuedSynchronizer.java:1117` tryAcquire 默认抛 UnsupportedOperationException)
- 使用方: ReentrantLock(独占)/Semaphore(共享)/CountDownLatch(共享)——都是"state 语义化 + AQS 队列"
- 关键设计 (斜体): *"state 是什么含义由子类决定"——锁的持有数/许可数/计数——AQS 只管"状态变化 + 排队阻塞";面试"为什么说 AQS 是框架"——模板方法 + 队列复用*
- 面试: "AQS 和 synchronized 什么关系?"——synchronized 是 JVM 内置(内部卷 19),AQS 是 Java 层框架

### 2. "state 怎么管理？" — volatile + CAS

场景: `compareAndSetState` 保证什么?

- `AbstractQueuedSynchronizer.java:580` — `private volatile int state` — 同步状态
- `611` — `compareAndSetState(expect, update)` — **CAS 更新**(域 13)
- `587` — `getState()` / 子类 `setState`(release 用)
- 关键设计 (斜体): *state 是"同步状态的单一事实来源"——volatile 可见 + CAS 原子;锁的获取 = tryAcquire 里 CAS state 0→1 成功;面试"锁的本质是什么"——对共享状态的安全修改*
- 面试: "为什么 state 是 int 不是 boolean?"——可重入计数/许可数需要多值

### 3. "CLH 队列是什么？" — 双向等待队列

场景: 抢锁失败——线程去哪等?

- `AbstractQueuedSynchronizer.java:569/575` — `head/tail` — **CLH 变体双向队列**(Node 394)
- `AbstractQueuedSynchronizer.java:629` `enq(Node)` — **CAS 尾插**(并发入队安全)
- Node 状态: `waitStatus`(CANCELLED=1/SIGNAL=-1/CONDITION=-2,401-405)+ prev/next(459/474)+ thread(480)
- 队列语义: 每个失败线程一个 Node,排队等待前驱唤醒
- 关键设计 (斜体): *CLH 队列是"FIFO 近似"——head 后第一个是等待最久的;CAS 尾插保证并发入队;SIGNAL 状态表示"我后面有人,你要唤醒他"——这是唤醒传播的基础(第 2 篇)*
- 面试: "为什么用队列不用自旋?"——无限自旋浪费 CPU;排队 + park 挂起(第 2 篇)
- [C++: 内部卷 19-synchronization(ObjectMonitor 的 cxq/EntryList 队列对照)]

### 4. "acquire 骨架" — 模板方法流程

场景: `lock.lock()` 在 AQS 里怎么走的?

- `AbstractQueuedSynchronizer.java:1238` `acquire(int)`:
  ```java
  if (!tryAcquire(arg))                 // ① 尝试获取(子类)
      acquireQueued(addWaiter(Node.EXCLUSIVE), arg);  // ② 失败入队
  ```
- `1301` `release(int)`: `tryRelease`(子类)→ `unparkSuccessor`(685)唤醒后继
- 关键设计 (斜体): *"尝试失败才排队"是乐观路径——大多数情况 tryAcquire 直接成功(无队列开销);面试画 acquire/release 两幅流程图是基本功*
- 面试: "tryAcquire 谁实现?"——ReentrantLock 的 FairSync/NonfairSync 等(第 3 篇)

---

### 核心悬念

入队之后——**线程怎么睡、怎么被叫醒**?`acquireQueued` 的自旋+park、`shouldParkAfterFailedAcquire` 的状态推进、被中断怎么办、取消的节点怎么清理——下一篇: AQS 的等待与唤醒。

> → [02-await-wakeup.md](02-await-wakeup.md)
