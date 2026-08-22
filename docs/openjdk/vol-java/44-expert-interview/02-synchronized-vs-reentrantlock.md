# synchronized 和 ReentrantLock 到底该怎么选？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`12-lock-sync/01-aqs-core`、`03-reentrantlock-condition`
> 版本边界：下文引用的 `ReentrantLock.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

`synchronized` 和 `ReentrantLock` 各有什么优劣？实际项目中该选哪个？

## 常见答法

> synchronized 是 JVM 层面的锁，ReentrantLock 是 API 层面的锁；synchronized 用起来简单，ReentrantLock 功能更丰富；性能上 synchronized 已经优化得和 ReentrantLock 差不多了。

这段回答方向对，但它把"功能更丰富"说成了一句模糊的结论，没有讲清楚"更丰富"到底多在哪、以及你什么时候真的需要它。面试官追问下去，很容易卡住。

## 追问一：ReentrantLock 多出来的"功能"具体指什么？

> 答：可中断、可超时、公平锁、多个 Condition 条件队列、tryLock。

这个清单是对的，但要分清楚哪些是"真正有用的"、哪些是"面试里才问的"。

- **可中断**（`lockInterruptibly()`，`ReentrantLock.java:316`）：线程在等锁时可以被中断，`synchronized` 在等锁时不能响应中断。生产场景里，如果你需要让等待的线程在超时或关闭时"醒过来"，这是必须的。
- **可超时**（`tryLock(timeout)`，`ReentrantLock.java:422`）：等锁只等一段时间，等不到就放弃。`synchronized` 没有等锁超时的概念。
- **公平锁**（`FairSync`，`ReentrantLock.java:206`）：`ReentrantLock` 默认是非公平的（`NonfairSync`，`:196`），但可以构造为公平版。`synchronized` 是完全非公平的。但生产里公平锁因为上下文切换成本高，用得很少。
- **多个 Condition**（`newCondition()`，`:481`）：让你在同一把锁上分出多个等待队列，比如"notFull"和"notEmpty"分开等。如果你需要生产者-消费者模式的精准唤醒，`Condition` 比 `wait/notify` 方便得多。
- `tryLock()`（`:346`）：无等待的锁尝试，成功了就拿到了，失败了直接返回 false。`synchronized` 做不到。

所以核心结论是：**ReentrantLock 真正多出来的不是"功能多"三个字，而是"线程在等锁时有了更多选择——可以不等、可以只等一会儿、可以被中断、可以选公平路径、可以按条件分队列等"。**

## 追问二：那 synchronized 还有存在的必要吗？

> 答：有，因为简单、不容易写错、JVM 做了大量优化。

这个答案对，但只说对了一半。`synchronized` 最大的优势不是"简单"，而是**锁的释放是确定性的，不会被遗忘**。`synchronized` 块结束后一定释放锁，即使中间抛异常。`ReentrantLock` 要手动 `unlock`，而且通常要在 `finally` 里释放。一旦某条路径忘了 `unlock`，锁就永远不释放了。

所以选择的第一条分界线是：**你需要的是"锁一定会被释放"的确定性，还是"需要超时/中断/多条件"的灵活性？** 如果不需要后者，那 `synchronized` 永远是更安全的选择。

## 追问三：性能差距到底有多大？

> 答：JDK 11 里 synchronized 已经做了大量优化，和 ReentrantLock 差距很小。

`ReentrantLock` 的 `Sync` 内部类（`ReentrantLock.java:118`）基于 AQS，走的是 Java 层 CAS + 队列 + park/unpark。`synchronized` 走的是 JVM 内部的锁升级路径（偏向锁 → 轻量锁 → 重量锁），在低竞争时偏向锁几乎零开销，高竞争时和 ReentrantLock 的重试 + park 路径成本接近。注意这里有一个版本边界：偏向锁在 JDK 15 起默认关闭，JDK 11 仍默认开启，不要把 JDK 11 的偏向锁行为外推成所有版本都如此。

所以性能差距不是"哪个快"，而是"**在什么竞争程度下哪个成本更低**"。低竞争时 `synchronized` 的偏向锁比 ReentrantLock 的 CAS 更便宜；高竞争时两者都退到操作系统级等待，差距就不大了。

## 源码证据

- `ReentrantLock` 的公平与非公平以 AQS 为骨架：`FairSync`（`:206`）多一次 `hasQueuedPredecessors()` 检查，`NonfairSync`（`:196`）直接 CAS 抢锁
- `lockInterruptibly()`（`:316`）在 AQS 的 `acquireInterruptibly` 路径上，响应中断；`synchronized` 没有这个入口
- `newCondition()`（`:481`）返回 `ConditionObject`，本质上是 AQS 内部的另一条等待队列，和 `Object.wait/notify` 走的是不同协议

## 一句话顿悟

**选 ReentrantLock 不是因为"功能更多"，而是因为你需要"等锁时能有更多选择"；选 synchronized 不是因为"性能更好"，而是因为"锁一定会被释放"这个确定性比任何功能都更基础。** 面试官真正想听的不是你会背"一个是 JVM 锁一个是 API 锁"，而是你能在"确定性 vs 灵活性"这个权衡上给出自己的判断，并且知道 JDK 源码里这两条路径各自走的是什么协议。