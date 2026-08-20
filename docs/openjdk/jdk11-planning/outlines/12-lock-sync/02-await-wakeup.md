# 02. AQS 的等待与唤醒 — acquireQueued、park、取消、公平性

> 🔴 Deep | 域 12 锁与同步器第 2 篇 | Layer 4
> 读者处境: 面试"公平锁为什么有前驱检查""线程怎么挂起唤醒"——AQS 队列的完整运转。

### 1. "acquireQueued 在干什么？" — 自旋 + park

场景: 线程入队后——循环里发生了什么?

- `AbstractQueuedSynchronizer.java:906` `acquireQueued(Node, int)`:
  ```java
  for (;;) {
      if (p == head && tryAcquire(arg))   // 前驱是头 → 尝试获取
          setHead(node);                   // 成功: 自己当头
      if (shouldParkAfterFailedAcquire(p, node))
          interrupted |= parkAndCheckInterrupt();  // 失败: park 挂起
  }
  ```
- 关键设计 (斜体): *"只有前驱是 head 才尝试"保证 FIFO 近似——队列头的人先获取;循环语义: 被唤醒后重新尝试(乐观重试);park 挂起避免自旋浪费(域 32 park 原语)*
- 面试: "acquireQueued 是自旋吗?"——是"自旋+挂起"混合: 前驱检查失败就 park,不空转
- [关联: 域 32 park/unpark;域 11 线程状态(WAITING)]

### 2. "shouldParkAfterFailedAcquire 做什么？" — SIGNAL 状态推进

场景: 为什么 park 前要把前驱设为 SIGNAL?

- `AbstractQueuedSynchronizer.java:844` `shouldParkAfterFailedAcquire(pred, node)`:
  - pred.waitStatus == SIGNAL → 可以安全 park(返回 true)
  - pred.waitStatus > 0(CANCELLED)→ 跳过已取消前驱(向前清理)
  - 否则 → CAS 设 pred 为 SIGNAL,再循环一次
- 语义: **"我 park 前通知前驱: 你释放时要唤醒我"**——SIGNAL 是唤醒委托
- 关键设计 (斜体): *SIGNAL 机制解决"释放时唤醒谁"的问题——每个节点对前驱承诺"唤醒我",释放者只唤醒 head 的后继;竞态窗口由"设 SIGNAL 后再 park"闭合(第二次循环检查)*
- 面试: "CANCELLED 节点怎么来的?"——中断/超时放弃的线程;清理在 shouldPark/acquireQueued 中顺带完成

### 3. "unparkSuccessor 唤醒谁？" — 释放传播

场景: `release` 后——哪个线程被唤醒?

- `AbstractQueuedSynchronizer.java:685` `unparkSuccessor(node)`:
  - 清除 head 的 SIGNAL 状态
  - 从 tail 向前找**最近的未取消后继**(向前遍历: 向后可能被取消断开)
  - `LockSupport.unpark(s)` 唤醒
- `1301` `release`: tryRelease 成功后调它
- 关键设计 (斜体): *"从 tail 向前找"的原因: 入队/取消会临时断链(prev 不可靠),反向遍历保底;唤醒传播链: 释放者→后继→后继的 release 再唤醒下一个——锁的交接就是这样链条式*
- 面试: "为什么唤醒 head 后的第一个而不是 head?"——head 是已获取者的占位

### 4. "公平性" — hasQueuedPredecessors

场景: 非公平锁插队——公平锁怎么禁止?

- 非公平(ReentrantLock NonfairSync:198): `tryAcquire` 直接 CAS——**可能插队**(新线程与队列头竞争)
- 公平(FairSync:213): `if (!hasQueuedPredecessors() && compareAndSetState(...))` — **队列非空则必须排队**
- `hasQueuedPredecessors`: 检查 head.next 是否存在等待者
- 关键设计 (斜体): *公平性代价: 必须等队列清空(吞吐下降);非公平收益: 减少唤醒切换(刚释放的线程可能立刻重获);JDK 默认非公平是"吞吐 vs 公平"的权衡;面试"为什么默认非公平"——吞吐优先 + 插队概率实际低*
- 面试: "公平锁一定公平吗?"——tryAcquire 排队,但 tryLock/中断路径仍可能插队(工程近似)

---

### 核心悬念

AQS 骨架通了——**可重入怎么实现**?`ReentrantLock` 的 state 计数、公平/非公平 tryAcquire 差异、`Condition` 的条件队列(await 让出锁)——下一篇: ReentrantLock 与 Condition。

> → [03-reentrantlock-condition.md](03-reentrantlock-condition.md)
