# 12-lock-sync/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Semaphore`、`CountDownLatch`、`CyclicBarrier` 与 AQS 共享模式主线。本文聚焦共享获取/释放、`tryAcquireShared`/`tryReleaseShared`、`setHeadAndPropagate` 的传播语义，以及 CyclicBarrier 的 `ReentrantLock + Condition + Generation` 方案；读写锁放到下一篇。
> 目标：把“共享模式与并发工具族”改写成一篇围绕“独占锁只需交接给一个后继，而共享工具为什么必须把放行资格继续往后传播；以及为什么不是所有‘等一批线程’的问题都应该用 AQS 共享模式” 的机制文章。

## 1. 读者困惑

- 独占锁 release 只唤醒一个后继，为什么 Semaphore 却能一次放行多个线程？
- CountDownLatch 明明也是让很多线程一起等，为什么它和 Semaphore 的 state 语义完全不同？
- AQS 共享模式里的“传播”到底指什么，为什么成功一个线程后还要继续唤醒下一个？
- CyclicBarrier 为什么不用 AQS 共享模式，而是回到 `ReentrantLock + Condition`？
- CountDownLatch 和 CyclicBarrier 都像“等一批人”，到底谁在等谁、谁负责开门、为什么一个一次性一个可复用？

## 2. 一句话顿悟

**AQS 共享模式的关键不是“大家都能拿到锁”这么笼统，而是：只要共享 state 还允许继续通过，成功获取的线程就不能把通道关死，而要把放行机会继续向后传播。Semaphore 把 state 解释成剩余许可，CountDownLatch 把 state 解释成剩余计数；它们都复用共享传播骨架。CyclicBarrier 则不是“资源还有没有余量”的问题，而是“这一轮参与者是否全部到齐”的代际同步问题，所以它转而使用 `ReentrantLock + Condition + Generation`。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `doAcquireShared` / `setHeadAndPropagate`、Semaphore / CountDownLatch 的 state 语义，以及 CyclicBarrier 的 lock + condition + generation 实现。
- 已抓到 CountDownLatch 一次性与 CyclicBarrier 可复用的核心差异。
- 已点出 CyclicBarrier 并非 AQS 共享模式实现，这是重要细节。

### 必须重写

- 旧稿像“工具族名词表”，需要先建立总问题：为什么独占唤醒一个就够，共享模式却要继续传播。
- 共享传播必须讲成主线，不只是贴 `setHeadAndPropagate` 代码块。
- Semaphore 和 CountDownLatch 要放在“同一骨架、不同 state 语义”这条线上对照，不要分成两段平铺。
- CyclicBarrier 需要从失败方案切入：为什么“人数到齐后一起走”不是简单的共享 state 递减问题。
- 结尾选型要强调“资源余量、外部事件、参与者汇合”三类问题本质不同。

## 4. 理解路径

### 第一节：从“为什么共享模式不能像独占锁那样只叫醒一个人”开场

用许可池/门闩场景开场：如果有 3 个许可，release 一个后只唤醒一个线程没问题；但如果当前还剩 2 个许可，难道第二、第三个线程要继续沉睡吗？指出共享模式的总问题：成功者不能独吞‘通道已开’这个事实，它必须把剩余通行资格继续传播给后继。

### 第二节：AQS 共享模式真正多出来的是什么——传播而不是独占交接

证据：
- `AbstractQueuedSynchronizer.java:995-1009`：`doAcquireShared`
- `AbstractQueuedSynchronizer.java:755-775`：`setHeadAndPropagate`
- `AbstractQueuedSynchronizer.java:717+`：`doReleaseShared`（重写时按需补读更精确片段）

主线：
- 独占模式成功后只需把锁交给下一个候选人。
- 共享模式成功后，如果 state 仍允许更多线程通过，就要继续传播释放信号。
- `setHeadAndPropagate` 是共享模式灵魂：更新 head 后，再判断是否继续放行后继。

### 第三节：Semaphore 为什么是“许可池”，不是“多把小锁”

证据：
- `Semaphore.java:162`：类定义
- `Semaphore.java:193`：`tryReleaseShared`
- `Semaphore.java:227`：`NonfairSync`
- `Semaphore.java:234`：`tryAcquireShared`
- `Semaphore.java:242`：`FairSync`
- `Semaphore.java:249`：公平 `tryAcquireShared`
- `Semaphore.java:641-657`：`drainPermits` / `reducePermits`

主线：
- state 表示剩余许可，不是“谁持有锁”的 owner 身份。
- 获取许可 = state 递减；释放许可 = state 递增，并触发共享传播。
- 公平与非公平仍回到“新来线程是否先看前驱”这一入口差异。
- 解释为什么 Semaphore 更像许可池，而不是 N 把独立锁的集合。

### 第四节：CountDownLatch 为什么是“外部事件门闩”，不是许可池

证据：
- `CountDownLatch.java:157`：类定义
- `CountDownLatch.java:173-177`：`tryAcquireShared` / `tryReleaseShared`
- `CountDownLatch.java:231`：`await`
- `CountDownLatch.java:291`：`countDown`

主线：
- state 表示“还差多少次 countDown 才开门”。
- await 线程自己不消耗 state，它只是等 state 归零；countDown 的线程才推进 state 递减。
- 一旦归零，所有等待者都通过；之后新来的 await 也直接通过，所以它天然是一次性门闩。
- 和 Semaphore 对照：一个是剩余许可会被获取线程消费，一个是剩余计数只由外部事件线程归零。

### 第五节：为什么 CyclicBarrier 不用 AQS 共享模式——它要解决的是“同一批参与者是否到齐”

证据：
- `CyclicBarrier.java:139`：类定义
- `CyclicBarrier.java:159`：`trip` Condition
- `CyclicBarrier.java:178`：`nextGeneration`
- `CyclicBarrier.java:190`：`breakBarrier`
- `CyclicBarrier.java:199`：`dowait`

主线：
- 朴素失败方案：把 barrier 当成倒计数门闩，等计数归零后所有人一起过；问题在于 barrier 需要“这一轮人到齐后重置，下一轮继续”，还要区分 broken / next generation。
- 它不是“资源还有没有余量”的共享 state 问题，而是“这一代参与者是不是全到齐”的阶段同步问题。
- 因此它选择 `ReentrantLock + Condition + Generation`，用一把锁和一条条件队列保护轮次切换，用 `nextGeneration()` 重置下一轮。

### 第六节：CountDownLatch vs CyclicBarrier 真正差在哪

证据：
- `CyclicBarrier.java:178-193`：`nextGeneration` / `breakBarrier`
- `CountDownLatch.java:173-177`：计数归零语义

主线：
- Latch 是“外部事件把门打开”，等待者和触发者可以不是同一批线程。
- Barrier 是“参与者互相等”，最后一个到的人负责触发换代和唤醒全体。
- Latch 一次性，Barrier 可复用，根源就在于 Barrier 有显式 generation 概念。

## 5. 失败方案清单

1. 把共享模式仍按独占锁思维实现，只唤醒一个后继就结束。
2. 把 Semaphore 理解成“多个线程都能拿同一把锁”，忽略它本质是许可池。
3. 用 CountDownLatch 解决需要多轮复用的阶段同步问题。
4. 把 CyclicBarrier 当成“可重置版 CountDownLatch”，忽略参与者互等和 generation 语义。
5. 以为共享传播是优化细节，不影响正确性。
6. 把公平/非公平共享获取理解成和独占锁完全不同的新概念。
7. 用共享 state 方案硬套 Barrier，而不处理 broken / generation 切换。

## 6. 误解清单

1. AQS 共享模式就是“唤醒所有人”。
2. `setHeadAndPropagate` 只是独占版 `setHead` 的命名变化。
3. Semaphore acquire 成功后 state 仍然不变，只是记录了一个持有者。
4. CountDownLatch 的 `await` 自己也在递减计数。
5. CyclicBarrier 只是内部多了一个回调函数。
6. Latch 和 Barrier 都是在等一批线程，所以可以互换。
7. 共享工具的实现细节和锁队列机制基本无关。

## 7. 证据清单

- `AbstractQueuedSynchronizer.java:755-775`：`setHeadAndPropagate`
- `AbstractQueuedSynchronizer.java:995-1009`：`doAcquireShared`
- `Semaphore.java:162`：类定义
- `Semaphore.java:193`：`tryReleaseShared`
- `Semaphore.java:227`：`NonfairSync`
- `Semaphore.java:234`：`tryAcquireShared`
- `Semaphore.java:242`：`FairSync`
- `Semaphore.java:249`：公平 `tryAcquireShared`
- `Semaphore.java:641-657`：`drainPermits` / `reducePermits`
- `CountDownLatch.java:157`：类定义
- `CountDownLatch.java:173-177`：共享获取/释放钩子
- `CountDownLatch.java:231`：`await`
- `CountDownLatch.java:291`：`countDown`
- `CyclicBarrier.java:139`：类定义
- `CyclicBarrier.java:159`：`trip`
- `CyclicBarrier.java:178`：`nextGeneration`
- `CyclicBarrier.java:190`：`breakBarrier`
- `CyclicBarrier.java:199`：`dowait`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦共享模式工具和 Barrier 对照，不展开 `Phaser`、`Exchanger` 等其他同步器。
- Semaphore / CountDownLatch 的共享模式依赖 AQS 队列传播，但不逐行展开所有中断/超时分支。
- CyclicBarrier 的核心是 lock + condition + generation；不把它误写成 AQS 共享模式实现。
- 选型结论强调语义差异，不把任何一种工具写成所有场景下的万能解。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么共享模式不能只唤醒一个 → `setHeadAndPropagate` 如何继续传播 → Semaphore 为什么把 state 当许可池 → CountDownLatch 为什么是外部事件门闩 → CyclicBarrier 为什么用 generation 而不是 AQS 共享 state → Latch 和 Barrier 的本质差异”。
- 必须把共享传播讲成本文主线。
- 必须把 Semaphore 和 CountDownLatch 放在“同骨架不同 state 语义”上对照。
- 必须把 CyclicBarrier 讲成‘阶段同步 + 可复用 generation’，而不是附带对比项。
- 结尾要自然引到 `05-stamped-readwrite.md`。
