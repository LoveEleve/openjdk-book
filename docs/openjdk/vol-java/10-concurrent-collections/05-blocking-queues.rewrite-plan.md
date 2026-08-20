# 10-concurrent-collections/05 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `BlockingQueue`、`ArrayBlockingQueue`、`LinkedBlockingQueue`、`SynchronousQueue`。本文聚焦阻塞语义契约、`ArrayBlockingQueue` 的单锁双条件、`LinkedBlockingQueue` 的双锁分离与 `AtomicInteger count`、`SynchronousQueue` 的零容量交接；`DelayQueue`、`PriorityBlockingQueue`、`LinkedTransferQueue` 仅按需要立路标，不在本篇展开主线。
> 目标：把“阻塞队列家族”改写成一篇围绕“并发队列解决了能放能取后，为什么还需要‘空了怎么办、满了怎么办’的等待协议，以及不同实现为什么会选单锁、双锁或零容量交接” 的机制文章。

## 1. 读者困惑

- `ConcurrentLinkedQueue` 已经能并发入队出队了，为什么还不够，为什么还需要 `BlockingQueue`？
- `put`/`take` 和 `offer`/`poll`/超时版方法到底差在哪，为什么接口要分四组？
- 为什么 `ArrayBlockingQueue` 用一把锁配两条 `Condition` 就够了？
- 为什么 `LinkedBlockingQueue` 又要拆成 `putLock` 和 `takeLock` 两把锁？
- `LinkedBlockingQueue` 明明有两把锁，元素个数又是怎么一致维护的？
- `SynchronousQueue` 明明没有容量，为什么还能算队列？
- 什么时候该选有界数组队列，什么时候该选链式阻塞队列，什么时候其实需要的是“直接交接”而不是排队？

## 2. 一句话顿悟

**BlockingQueue 的核心不是“换一种存储结构”，而是给并发队列补上一层等待协议：空了时消费者怎么睡，满了时生产者怎么睡，被唤醒后谁继续推进。ArrayBlockingQueue 把这一协议压在一把锁和两条条件队列上； LinkedBlockingQueue 用两把锁把 put/take 尽量分开；SynchronousQueue 则连缓冲区都不要，直接把生产者和消费者配对成交。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `BlockingQueue` 的四组方法语义。
- 已指出 `ArrayBlockingQueue` 是单锁双条件，`LinkedBlockingQueue` 是双锁分离，`SynchronousQueue` 是零容量交接。
- 已把阻塞条件从“空/满”抽象成 `await/signal` 协议，这是正确方向。

### 必须重写

- 旧稿仍偏名词清单，没有先建立“CLQ 解决的是并发推进，但没解决空了/满了时线程该怎么等”的总问题。
- `ArrayBlockingQueue` 和 `LinkedBlockingQueue` 需要放在同一个“为什么一个锁不够/为什么两个锁值得”的对照主线上讲，而不是分散罗列。
- `LinkedBlockingQueue` 的 `AtomicInteger count` 需要回到双锁并存下如何共享容量信息的主问题里。
- `SynchronousQueue` 不能只是“容量为 0”的定义，需要讲成失败方案：为什么有些交接场景压根不希望排队缓存。
- 本篇应减少对 `DelayQueue` 等特殊队列的平铺，把主线收束到“阻塞等待协议 + 三种代表实现”。

## 4. 理解路径

### 第一节：从“能放能取”到“空了怎么办、满了怎么办”开场

承接上一篇 CLQ：无锁队列能让生产者/消费者并发推进，但队列空时消费者只能返回 `null` 或重试，队列满时普通有界结构也只能失败或忙等。用线程池任务提交/日志削峰场景开场：真正的工程问题不是“容器能不能存”，而是“线程应该睡在哪里、什么时候被叫醒”。

### 第二节：阻塞队列契约为什么分成四组方法

证据：
- `BlockingQueue.java:231`：`put`
- `BlockingQueue.java:251`：`offer(e, timeout, unit)`
- `BlockingQueue.java:261`：`take`
- `BlockingQueue.java:275`：`poll(timeout, unit)`

主线：
- 异常版、特殊值版、永久阻塞版、限时阻塞版不是 API 凑数，而是在表达调用者对失败和等待的不同容忍度。
- 本体不是“多几个方法”，而是把“满/空时线程如何处理”明确进契约。

### 第三节：ArrayBlockingQueue 为什么一把锁就够

证据：
- `ArrayBlockingQueue.java:103`：`items`
- `ArrayBlockingQueue.java:120`：`lock`
- `ArrayBlockingQueue.java:123`：`notEmpty`
- `ArrayBlockingQueue.java:126`：`notFull`
- `ArrayBlockingQueue.java:176`：`enqueue`
- `ArrayBlockingQueue.java:191`：`dequeue`
- `ArrayBlockingQueue.java:361`：`put`
- `ArrayBlockingQueue.java:412`：`take`

主线：
- 底层是定长环形数组，头尾和容量边界共享同一块状态。
- 因此 put/take 虽然等待条件不同，但真正修改的是同一套数组位置和计数边界，一把互斥锁能最直接地保护它们。
- 两条 `Condition` 的意义是把“谁该因空而等、谁该因满而等”分开，而不是额外提供第二把锁。

### 第四节：为什么 LinkedBlockingQueue 愿意多付一把锁的复杂度

证据：
- `LinkedBlockingQueue.java:141`：`count`
- `LinkedBlockingQueue.java:156`：`takeLock`
- `LinkedBlockingQueue.java:159`：`notEmpty`
- `LinkedBlockingQueue.java:162`：`putLock`
- `LinkedBlockingQueue.java:165`：`notFull`
- `LinkedBlockingQueue.java:199`：`enqueue`
- `LinkedBlockingQueue.java:210`：`dequeue`
- `LinkedBlockingQueue.java:324`：`put`
- `LinkedBlockingQueue.java:425`：`take`
- `LinkedBlockingQueue.java:171` / `184`：`signalNotEmpty` / `signalNotFull`

主线：
- 链式队列的头部和尾部修改天然更容易分离：put 主要碰尾，take 主要碰头。
- 因此把 put/take 拆进两把锁，能让队列在不空不满时实现更高并行度。
- 但双锁带来新问题：容量信息要跨两把锁共享，所以引入 `AtomicInteger count` 作为总数协调器。

### 第五节：`count` 为什么是 LBQ 的关键中介，而不是普通 size 字段

证据：
- `LinkedBlockingQueue.java:141`：`count`
- `LinkedBlockingQueue.java:324-351`：`put` 中更新 count 与 `signalNotEmpty`
- `LinkedBlockingQueue.java:425-443`：`take` 中更新 count 与 `signalNotFull`

主线：
- 双锁模型下，put 线程和 take 线程分别持不同锁运行，不能只靠某一把锁内的普通字段判断全局空满状态。
- `count` 负责在两条并发路径之间传递“当前总量”这一共享事实。
- 它解释了为什么 LBQ 可以头尾并行，又不会把容量控制搞丢。

### 第六节：SynchronousQueue 为什么连容量都不要——有些场景需要的是交接，不是缓存

证据：
- `SynchronousQueue.java:90`：类定义
- `SynchronousQueue.java:174`：`Transferer`
- `SynchronousQueue.java:188`：`transfer`
- `SynchronousQueue.java:215`：`TransferStack`
- `SynchronousQueue.java:525`：`TransferQueue`

主线：
- 朴素失败方案：所有生产消费都先进队列缓存；问题是有些场景根本不想积压元素，而是要“生产者交出一个元素时，必须已经有消费者接手”。
- `SynchronousQueue` 的核心不是容量 0 这个定义本身，而是没有存储缓冲，只有线程间直接配对交接。
- `TransferStack` 与 `TransferQueue` 说明它本质上是在实现不同公平策略下的线程配对协议，而不是普通容器存储逻辑。

### 第七节：如何把三种实现放回同一张选型图

主线：
- ABQ：固定容量、单锁、数组局部性好、实现直接。
- LBQ：链式、双锁、put/take 更易并行，但节点对象与协调复杂度更高。
- SQ：零容量，不做缓存，只做交接。
- 重点不是背类名，而是根据“是否需要容量缓冲”“是否追求头尾并行”“是否希望直接交接”做选择。

## 5. 失败方案清单

1. 用普通并发队列配合 while 重试，期待它自然具备阻塞等待语义。
2. 给所有阻塞队列场景统一套一种实现，不区分有界缓冲、链式吞吐和直接交接。
3. 以为 `ArrayBlockingQueue` 的 `notEmpty` / `notFull` 就等于两把独立锁。
4. 以为 `LinkedBlockingQueue` 既然有两把锁，就不再需要共享计数协调。
5. 把 `SynchronousQueue` 当成“容量特别小的普通队列”。
6. 在需要严格背压交接的场景仍然引入缓冲队列，导致任务积压失控。
7. 把 `put`/`take` 与超时版 API 当成只是调用风格差异，不当成控制语义差异。

## 6. 误解清单

1. `BlockingQueue` 只是“线程安全队列”的另一个名字。
2. `put` 比 `offer` 只是更慢，本质没有区别。
3. `ArrayBlockingQueue` 用一把锁说明并发性一定比 LBQ 差。
4. `LinkedBlockingQueue` 双锁意味着 put/take 永远完全并行。
5. `count` 只是拿来做 `size()` 的统计字段。
6. `SynchronousQueue` 因为容量为 0，所以几乎没用。
7. 阻塞队列的遍历和容量控制是一回事。

## 7. 证据清单

- `BlockingQueue.java:231`：`put`
- `BlockingQueue.java:251`：`offer(e, timeout, unit)`
- `BlockingQueue.java:261`：`take`
- `BlockingQueue.java:275`：`poll(timeout, unit)`
- `ArrayBlockingQueue.java:103`：`items`
- `ArrayBlockingQueue.java:120`：`lock`
- `ArrayBlockingQueue.java:123`：`notEmpty`
- `ArrayBlockingQueue.java:126`：`notFull`
- `ArrayBlockingQueue.java:176`：`enqueue`
- `ArrayBlockingQueue.java:191`：`dequeue`
- `ArrayBlockingQueue.java:361`：`put`
- `ArrayBlockingQueue.java:412`：`take`
- `LinkedBlockingQueue.java:141`：`count`
- `LinkedBlockingQueue.java:156`：`takeLock`
- `LinkedBlockingQueue.java:159`：`notEmpty`
- `LinkedBlockingQueue.java:162`：`putLock`
- `LinkedBlockingQueue.java:165`：`notFull`
- `LinkedBlockingQueue.java:171`：`signalNotEmpty`
- `LinkedBlockingQueue.java:184`：`signalNotFull`
- `LinkedBlockingQueue.java:199`：`enqueue`
- `LinkedBlockingQueue.java:210`：`dequeue`
- `LinkedBlockingQueue.java:324`：`put`
- `LinkedBlockingQueue.java:425`：`take`
- `SynchronousQueue.java:90`：类定义
- `SynchronousQueue.java:174`：`Transferer`
- `SynchronousQueue.java:188`：`transfer`
- `SynchronousQueue.java:215`：`TransferStack`
- `SynchronousQueue.java:525`：`TransferQueue`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇主线不展开 `DelayQueue`、`PriorityBlockingQueue`、`LinkedTransferQueue` 的内部实现，只在需要时作为选型路标点到为止。
- 讨论重点是阻塞等待协议与代表实现，不延伸到线程池完整调度策略。
- 不把 `SynchronousQueue` 简化成“没有容量所以没存储价值”，它的价值在于交接语义。
- 不把 LBQ 的 `count` 写成强一致全局锁替代物，它服务的是双锁下的容量协调。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么并发队列还不够 → 阻塞队列契约如何表达等待语义 → ABQ 为什么一把锁就够 → LBQ 为什么用两把锁再加一个 `count` 协调 → SQ 为什么直接取消缓冲改做线程交接 → 三者如何按容量/并行度/交接语义选型”。
- 必须把 ABQ/LBQ/SQ 放在同一条‘等待协议 + 存储结构 + 并发代价’主线上讲。
- 必须解释 `count` 在 LBQ 中的存在理由。
- 必须把 `SynchronousQueue` 讲成交接协议，而不是定义题。
- 结尾要自然引到 `06-transfer-selection.md`：当队列不仅要阻塞，还要表达“必须交到接收者手里”的传递语义时，会进入 TransferQueue 选型收束。
