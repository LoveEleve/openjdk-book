# 为什么 `wait`/`notify` 必须在 `synchronized` 块里？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`12-lock-sync/03-reentrantlock-condition`、`03-object-system/01-object-contract-references`
> 版本边界：下文引用的 `Object.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

`Object.wait()` 和 `Object.notify()` 为什么必须在 `synchronized` 块里调用？不在的话会怎样？

## 常见答法

> 因为不持有锁就调用会抛 `IllegalMonitorStateException`。必须等锁才能调用。

这个答法只说了"法律条文"，没解释"立法理由"。JDK 的确会抛 `IllegalMonitorStateException`，但这是**结果**，不是**原因**。真正的问题是：**为什么 JDK 要强制你必须在 synchronized 块里才能调用 wait/notify？这个要求防止的是什么？**

## 追问一：`wait()` 会让线程睡着，但它睡着之前必须先释放锁，为什么？

> 答：因为如果它不释放锁，别的线程就进不来 synchronized 块，也就没法 `notify()` 把它叫醒。

对。这是 wait/notify 机制最核心的设计约束。`wait()` 的语义是"**等着某个条件成立再继续**"，而条件是由其他线程在持锁时修改的。如果 `wait()` 不释放锁，其他线程就进不来改条件，也发不了 notify——于是死锁了。

所以 `wait()` 在挂起线程之前，必须先释放当前持有的监视器锁。而且被唤醒后，`wait()` 返回之前必须重新抢回这个锁，保证调用方在 `wait()` 返回后看到的仍然是持锁状态。

## 追问二：那 `notify()` 呢？它为什么也要在锁里？

> 答：notify 本身不修改共享状态，但它必须保证"通知谁"这个决策是基于正确的条件判断。

`notify()` 把等待队列里的一个线程移出等待池，让它重新竞争锁。如果 `notify()` 可以在锁外调用，那它和检查条件、修改条件之间就可能出现竞态窗口——你检查完了条件（"队列不空"），还没来得及发出 notify，其他线程插进来又改了条件。

所以 JDK 要求 `notify()` 也在同步块里调用，不是因为它需要锁来执行 notify 本身，而是因为**通知的发出者必须和条件的修改者处于同一个临界区**，这样才能保证"检查条件 → 修改条件 → 发出通知"是一个不可分割的原子序列。

## 追问三：`Condition.await()` / `signal()` 和 `wait/notify` 有什么区别？

> 答：Condition 是 Lock 层面的等待协议，支持多条条件队列、可中断、可超时，比 wait/notify 更灵活。

`Condition.await()` 也遵循"必须持有锁才能 await"的约束，但它的锁是 `ReentrantLock` 而不是 `synchronized`。`signal()` 也必须在持锁时调用，原因和 `notify()` 一样——防止"条件判断"和"通知发出"之间出现竞态。区别在于：

- `Object.wait/notify` 只有一个等待队列，你用不了多条件
- `Condition` 同一把锁可以分出多条等待队列（`notEmpty`、`notFull`）
- `Condition` 支持 `awaitUninterruptibly`、超时、可中断

## 源码证据

- `Object.notify()` 是 native（`:282`）：抛 `IllegalMonitorStateException` 的入口
- `Object.notifyAll()`（`:307`）：和 `notify` 遵守同一约束，也要在锁内调用
- `Object.wait()`（`:327`）和 `wait(long)`（`:352`）：都是 native，行为由 JVM 实现
- `IllegalMonitorStateException` 的抛出条件：当前线程不持有对象的监视器

## 一句话顿悟

**`wait/notify` 必须在 synchronized 块里，不是因为 JDK 想"多一个检查"，而是因为"检查条件 → 修改条件 → 发出通知"这条链必须是原子的、不可被打断的。** 面试官真正想听的不是你会背 `IllegalMonitorStateException`，而是你知道这个"锁保护的不只是数据，而是条件判断和通知的 atomicity"。