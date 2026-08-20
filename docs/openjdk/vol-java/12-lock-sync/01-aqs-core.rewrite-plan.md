# 12-lock-sync/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `AbstractQueuedSynchronizer`。本文聚焦 `state`、`head/tail`、`Node`、`getState/setState/compareAndSetState`、`enq/addWaiter`、`acquire/release` 与模板方法钩子；`acquireQueued` 的 park/unpark、自旋与中断细节放到下一篇。
> 目标：把“AQS 核心”改写成一篇围绕“为什么同步器既不能只靠一个 CAS 状态位，也不能只靠一条等待队列，而必须把状态、排队和子类钩子拼成一套通用框架”的机制文章。

## 1. 读者困惑

- `ReentrantLock`、`Semaphore`、`CountDownLatch` 这么不像，为什么底层都能站在 AQS 上？
- 为什么同步器不能只靠一个 `volatile state` + CAS 就完事？
- 为什么抢失败的线程不能一直自旋，非得排队？
- AQS 里的 `state` 到底表示什么，为什么一个 `int` 能承载不同语义？
- `head` / `tail` / `Node` 这条队列到底在管什么，它和 state 的分工怎么配合？
- AQS 为什么被说成模板方法框架，子类到底只负责哪一小块？

## 2. 一句话顿悟

**AQS 的核心不是某个神奇字段或某条神奇队列，而是一套分工：`state` 负责表示“当前还有没有资格拿到同步器”，CLH 变体队列负责管理“拿不到资格的线程按什么顺序等”，模板方法钩子则允许子类给 `state` 赋予各自语义。没有 state，队列不知道什么时候能放人过去；没有队列，CAS 失败的线程只能白白空转；没有钩子，这套框架又无法复用于不同同步器。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `state`、`head/tail`、`Node`、`acquire/release`、`tryAcquire/tryRelease` 钩子和 CLH 变体队列。
- 已指出 `state` 是“单一事实来源”，以及“尝试失败才排队”的乐观路径。
- 已把 park/unpark 等待细节留给下一篇，这个边界方向是对的。

### 必须重写

- 旧稿像面试提纲，缺少总问题：为什么光有 CAS 不够、光有队列也不够。
- `state` 需要讲成“资格事实”，而不是只列 `volatile + CAS` 三个 API。
- 队列部分应先建立“为什么不能一直自旋”的失败方案，再让 CLH 变体出场。
- 模板方法钩子要强调“语义由子类提供、排队骨架由 AQS 统一”，而不是单独罗列四个方法名。
- `acquire/release` 应讲成整条同步器流水线的收束图，而不是代码片段背诵。

## 4. 理解路径

### 第一节：从“为什么不能只靠一个 CAS state”开场

用最常见误区开场：很多人觉得锁的本质就是 `compareAndSetState(0, 1)`；那失败的线程怎么办？继续 while 自旋会怎样？指出失败方案：高竞争下线程会一直烧 CPU，既没拿到资格，也没人维护等待顺序。

### 第二节：AQS 其实在解决两个不同问题——资格判断与失败收容

证据：
- `AbstractQueuedSynchronizer.java:569`：`head`
- `AbstractQueuedSynchronizer.java:575`：`tail`
- `AbstractQueuedSynchronizer.java:580`：`state`

主线：
- `state` 回答“现在谁有资格”。
- 队列回答“没资格的人去哪等”。
- 这两者缺一不可，合起来才是同步器骨架。

### 第三节：为什么 `state` 只是一块原材料，语义必须由子类定义

证据：
- `AbstractQueuedSynchronizer.java:587`：`getState`
- `AbstractQueuedSynchronizer.java:596`：`setState`
- `AbstractQueuedSynchronizer.java:611`：`compareAndSetState`
- `AbstractQueuedSynchronizer.java:1117`：`tryAcquire`
- `AbstractQueuedSynchronizer.java:1143`：`tryRelease`

主线：
- `state` 只是一个 `volatile int`，AQS 本身不解释它是锁计数、许可数还是倒计时。
- `tryAcquire/tryRelease` 等钩子才赋予它具体业务语义。
- 所以 AQS 是“状态机外壳 + 子类定义状态解释”，不是一个写死了锁语义的类。

### 第四节：为什么失败线程要进 CLH 变体队列，而不是一直自旋

证据：
- `AbstractQueuedSynchronizer.java:629`：`enq`
- `AbstractQueuedSynchronizer.java:650`：`addWaiter`
- `AbstractQueuedSynchronizer.java:685`：`unparkSuccessor`
- `Node` 的精确字段和状态常量需要在重写时补读更靠前区域锚点

主线：
- 竞争失败后，线程需要一个被唤醒前的停泊位置。
- AQS 选 CLH 变体双向队列，让线程以 Node 形式排队等待，后续由前驱/头节点推进唤醒顺序。
- `enq` 的 CAS 尾插说明并发入队怎样保持队列完整。
- 重点不是细抠每个 waitStatus，而是让读者先知道“队列负责失败线程的秩序”。

### 第五节：模板方法为什么让 AQS 成为通用同步器框架

证据：
- `AbstractQueuedSynchronizer.java:1117`：`tryAcquire`
- `AbstractQueuedSynchronizer.java:1143`：`tryRelease`
- `AbstractQueuedSynchronizer.java` 共享模式钩子行号可在后续篇章按需补充

主线：
- AQS 统一了：排队、挂起、唤醒、前驱检查、队首推进。
- 子类只决定：此刻 state 表示什么、怎样算获取成功、怎样算释放完成。
- 这解释了为什么 ReentrantLock、Semaphore、CountDownLatch 能共享同一骨架却拥有不同语义。

### 第六节：`acquire/release` 为什么是整套骨架的总收口

证据：
- `AbstractQueuedSynchronizer.java:1238-1240`：`acquire`
- `AbstractQueuedSynchronizer.java:1301-1305`：`release`
- `AbstractQueuedSynchronizer.java:906`：`acquireQueued`

主线：
- `acquire` 先 tryAcquire，失败才 addWaiter + acquireQueued，体现乐观获取优先。
- `release` 先 tryRelease，成功后再看是否需要唤醒后继。
- 这两段代码把“状态判断 + 队列管理 + 子类钩子”收成了最小闭环。
- 下一篇只继续拆 acquireQueued 里面的 park/unpark 和取消清理。

## 5. 失败方案清单

1. 只用一个 `volatile state` + CAS，实现同步器时让失败线程 while 自旋到底。
2. 只有队列，没有清晰的 state 事实来源，导致唤醒后也不知道谁该成功通过。
3. 把 AQS 理解成一把写死语义的锁，而不是可复用框架。
4. 让每个同步器子类自己重复实现排队、挂起和唤醒协议。
5. 以为 state 用 `boolean` 就够，忽略重入计数、许可数、倒计时等多值语义。
6. 认为 acquire 总是先进队列，再去尝试获取。
7. 把 CLH 队列当成公平性口号，而不是失败线程的收容结构。

## 6. 误解清单

1. AQS 就是 ReentrantLock 的内部类名，和别的同步器没关系。
2. `state` 已经是 volatile 了，所以不需要 CAS。
3. CAS 失败后一直自旋一定比排队更高效。
4. 模板方法只是设计模式噱头，对并发性能没影响。
5. `head` / `tail` 队列只是为了调试观察，不参与真实获取流程。
6. `release` 只是改 state，不负责后继推进。
7. AQS 的共享模式和独占模式在骨架层面完全无关。

## 7. 证据清单

- `AbstractQueuedSynchronizer.java:569`：`head`
- `AbstractQueuedSynchronizer.java:575`：`tail`
- `AbstractQueuedSynchronizer.java:580`：`state`
- `AbstractQueuedSynchronizer.java:587`：`getState`
- `AbstractQueuedSynchronizer.java:596`：`setState`
- `AbstractQueuedSynchronizer.java:611`：`compareAndSetState`
- `AbstractQueuedSynchronizer.java:629`：`enq`
- `AbstractQueuedSynchronizer.java:650`：`addWaiter`
- `AbstractQueuedSynchronizer.java:685`：`unparkSuccessor`
- `AbstractQueuedSynchronizer.java:906`：`acquireQueued`
- `AbstractQueuedSynchronizer.java:1117`：`tryAcquire`
- `AbstractQueuedSynchronizer.java:1143`：`tryRelease`
- `AbstractQueuedSynchronizer.java:1238-1240`：`acquire`
- `AbstractQueuedSynchronizer.java:1301-1305`：`release`
- `Node` 的字段/状态常量：重写时补精确锚点

## 8. 版本与边界

- 基于 JDK 11。
- 本篇重点解释独占主线的公共骨架，共享模式和条件队列只立路标，不展开完整细节。
- `park/unpark`、中断响应、取消节点清理和 `waitStatus` 细节放到下一篇。
- 不把 AQS 和 `synchronized` 混为一谈：前者是 Java 层框架，后者是 JVM 内置监视器机制。
- 不把队列直接写成“严格公平”，它首先是失败线程的有序收容结构。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么只靠 CAS state 不够 → state 与队列分别解决什么问题 → 子类如何赋予 state 语义 → 失败线程为何要进 CLH 变体队列 → acquire/release 如何把钩子与队列骨架串成闭环”。
- 必须把 `state`、队列、模板钩子讲成同一套分工。
- 必须讲清 acquire 的乐观路径：先尝试，失败才排队。
- 必须把 AQS 定位为通用同步器框架，而不是单一锁实现。
- 结尾要自然引到 `02-await-wakeup.md`。
