# 12-lock-sync/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `AbstractQueuedSynchronizer`。本文聚焦 `acquireQueued`、`shouldParkAfterFailedAcquire`、`parkAndCheckInterrupt`、`cancelAcquire`、`unparkSuccessor` 与公平性检查；Condition 队列留到下一篇。
> 目标：把“AQS 的等待与唤醒”改写成一篇围绕“线程入队后为什么不能立刻睡，为什么必须先把‘前驱负责唤醒我’这条协议建好”的机制文章，并顺带讲清取消节点清理与公平锁的队列约束。

## 1. 读者困惑

- 线程已经排进 AQS 队列后，为什么还不能立刻 `park()` 睡下去？
- `SIGNAL` 到底是谁给谁立的，为什么它要挂在前驱节点上？
- `acquireQueued` 为什么看起来是循环，实际上又不是忙等自旋？
- 被中断或超时取消的节点为什么不会永远堵死队列？
- `unparkSuccessor` 为什么有时不能直接唤醒 `next`，还要从 tail 反向找？
- 公平锁为什么只是在 tryAcquire 里多了一道 `hasQueuedPredecessors()`，就能表现出不一样的插队约束？

## 2. 一句话顿悟

**AQS 的等待与唤醒核心不是“失败就睡、释放就叫”，而是一条先建协议再休眠的链路：排队线程必须先让前驱节点记录 `SIGNAL`，确认“你释放时要叫醒我”，然后才安全 `park`；释放方则只需围绕 head 后继推进唤醒，并顺带跳过取消节点。这让 AQS 把竞争线程从忙等改造成事件驱动的排队睡眠。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `acquireQueued`、`shouldParkAfterFailedAcquire`、`unparkSuccessor`、取消节点清理和公平性入口。
- 已抓到“设 SIGNAL 后再 park”的竞态闭合点，这是本篇核心。
- 已把公平/非公平差异落到 `hasQueuedPredecessors` 和 `tryLock` 插队行为上，方向正确。

### 必须重写

- 旧稿仍像源码流程图，缺少足够强的总问题：为什么线程不能失败就立刻睡。
- `SIGNAL` 要讲成等待协议，不是状态常量说明。
- `acquireQueued` 需要强调“循环 + 挂起”与“忙等自旋”的区别。
- 取消节点清理和 tail 反向找后继要回到“队列链路可能临时不整洁，但必须可恢复”这条主线上。
- 公平性要放在“队列资格判断”语义上，不只做锁种类对照。

## 4. 理解路径

### 第一节：从“失败了为什么不能马上 park”开场

先推演朴素失败方案：线程 tryAcquire 失败后立刻 `park()`。指出竞态窗口：如果它刚准备睡，前驱线程已经释放并检查过自己并未承诺要叫醒任何人，等待线程就可能睡死。用这个失败方案把 `SIGNAL` 的必要性立起来。

### 第二节：`acquireQueued` 为什么是“循环 + 挂起”，不是忙等自旋

证据：
- `AbstractQueuedSynchronizer.java:906-922`：`acquireQueued`
- `AbstractQueuedSynchronizer.java:875`：`selfInterrupt`
- `AbstractQueuedSynchronizer.java:884`：`parkAndCheckInterrupt`

主线：
- 只有前驱是 head 时才会尝试获取。
- 获取失败后并不是空转，而是先看是否满足安全挂起条件，再进入 `park`。
- 被唤醒后回到循环重试，这就是“事件驱动的乐观重试”，不是 CPU 忙等。

### 第三节：`shouldParkAfterFailedAcquire` 为什么是等待协议的真正心脏

证据：
- `AbstractQueuedSynchronizer.java:844-867`：`shouldParkAfterFailedAcquire`
- `AbstractQueuedSynchronizer.java:401-403`：`CANCELLED` / `SIGNAL`
- `AbstractQueuedSynchronizer.java:446`：`waitStatus`

主线：
- `SIGNAL` 不是“我要睡了”的自我标记，而是前驱节点对后继的唤醒承诺。
- 三分支：前驱已 SIGNAL → 可睡；前驱已取消 → 越过取消节点；前驱状态还没准备好 → CAS 设成 SIGNAL，先别睡，下轮再确认。
- 重点讲“为什么必须先设 SIGNAL 再 park”，把竞态闭合讲透。

### 第四节：取消节点为什么不会把队列堵死

证据：
- `AbstractQueuedSynchronizer.java:789-828`：`cancelAcquire`
- `AbstractQueuedSynchronizer.java:798` / `811` / `821-828`：跳过取消节点与必要唤醒
- `AbstractQueuedSynchronizer.java:844-867`：`shouldParkAfterFailedAcquire` 中越过取消前驱

主线：
- 被中断、异常或超时放弃的线程会把节点标成 CANCELLED。
- 取消节点不会再参与获取，但必须从链路上逐步跳过，否则会挡住正常后继。
- AQS 不是立即全局整理，而是在等待和取消路径上顺手修补队列。

### 第五节：`unparkSuccessor` 为什么有时要从 tail 反向找

证据：
- `AbstractQueuedSynchronizer.java:685-705`：`unparkSuccessor`
- `AbstractQueuedSynchronizer.java:691-693`：清负状态
- `AbstractQueuedSynchronizer.java:702-705`：从 tail 反向找有效后继

主线：
- 释放者正常优先唤醒 `node.next`。
- 但并发入队与取消可能让 `next` 暂时为空或指向取消节点，因此不能盲信它。
- 从 tail 反向找是保底策略，确保最终能找到最近的有效后继。
- 这说明 AQS 队列不是永远整洁的双向链，而是一条允许暂时凌乱、但必须可恢复推进的等待链。

### 第六节：公平锁为什么只是多一道“前面有人吗”的检查

证据：
- `AbstractQueuedSynchronizer.java:1554-1557`：`hasQueuedPredecessors` 核心逻辑
- `ReentrantLock.java` 中 FairSync / NonfairSync 行号留给后续篇章按需回钩，本篇先立概念路标

主线：
- 非公平获取允许新线程在队列外先尝试抢 state。
- 公平获取在 tryAcquire 前先问：队列前面是不是已经有人等着？如果是，就别插队。
- 公平性本质是“资格约束”，不是完全不同的等待机制。

## 5. 失败方案清单

1. 线程获取失败后立刻 `park()`，不先建立唤醒承诺。
2. 把 `acquireQueued` 当成 while 忙等自旋实现。
3. 不清理 CANCELLED 节点，期待它们自动不影响队列。
4. 释放时无条件只唤醒 `next`，忽略断链和取消节点。
5. 以为公平锁需要一套完全不同的排队结构。
6. 认为 SIGNAL 是后继节点的“我已睡着”标志，而不是前驱的唤醒承诺。
7. 认为一旦线程进队，就一定严格按绝对 FIFO 立即轮到它。

## 6. 误解清单

1. `park()` 本身就足够安全，不需要额外状态协调。
2. `shouldParkAfterFailedAcquire` 只是优化分支，不影响正确性。
3. CANCELLED 节点会被 GC 自动处理，不需要队列逻辑关心。
4. `unparkSuccessor` 唤醒的是 head 自己。
5. 公平锁就绝不会有任何形式的插队。
6. `selfInterrupt` 说明 AQS 会吞掉中断语义。
7. 线程被唤醒就一定能立刻成功获取同步状态。

## 7. 证据清单

- `AbstractQueuedSynchronizer.java:401-403`：`CANCELLED` / `SIGNAL`
- `AbstractQueuedSynchronizer.java:446`：`waitStatus`
- `AbstractQueuedSynchronizer.java:685-705`：`unparkSuccessor`
- `AbstractQueuedSynchronizer.java:789-828`：`cancelAcquire`
- `AbstractQueuedSynchronizer.java:844-867`：`shouldParkAfterFailedAcquire`
- `AbstractQueuedSynchronizer.java:875`：`selfInterrupt`
- `AbstractQueuedSynchronizer.java:884`：`parkAndCheckInterrupt`
- `AbstractQueuedSynchronizer.java:906-922`：`acquireQueued`
- `AbstractQueuedSynchronizer.java:1554-1557`：`hasQueuedPredecessors`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦独占获取等待主线；共享模式传播与 Condition 队列放到后续专题。
- park/unpark 的 JVM/Unsafe 封装细节只点到为止，不展开到 HotSpot 内部实现。
- 公平锁部分强调资格检查语义，不在本篇展开 ReentrantLock 全部分支。
- 不把 AQS 队列写成“永远整洁”的教科书链表，它允许临时断链并依赖恢复逻辑前进。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么失败后不能立刻 park → acquireQueued 如何在循环中挂起重试 → SIGNAL 为什么是前驱给出的唤醒承诺 → CANCELLED 节点如何被跳过 → release 为什么要从 tail 反向找有效后继 → 公平锁怎样把队列前驱检查纳入资格判断”。
- 必须把 SIGNAL 讲成竞态闭合协议。
- 必须讲清 AQS 的等待不是忙等，而是循环 + park 的事件驱动等待。
- 必须解释取消节点清理和反向找后继的必要性。
- 结尾要自然引到 `03-reentrantlock-condition.md`。
