# 为什么 `AtomicInteger.incrementAndGet()` 不直接加锁？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`12-juc/02-atomic-cas`
> 版本边界：下文引用的 `AtomicInteger.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

`AtomicInteger.incrementAndGet()` 为什么不直接用 `synchronized` 加锁实现，而要走 CAS / 原子指令这一套？

## 常见答法

> 因为 CAS 是无锁的，比加锁更快。

这个答法方向对，但太粗。**不是所有场景里 CAS 都更快，而是像 `AtomicInteger` 这种"单变量原子更新"，用 JVM 提供的原子读改写原语，通常能避免线程挂起/唤醒和锁竞争的额外成本。** 它优化的不是"绝对更快"，而是"在低到中等竞争下，用更小代价完成一次原子更新"。

## 追问一：`incrementAndGet()` 在 JDK 11 里真的是 Java 层 CAS 自旋吗？

> 答：不是。JDK 11 里它直接委托给 `Unsafe.getAndAddInt`，由 JVM 把它降到更底层的原子更新原语。

`AtomicInteger.incrementAndGet()`（`AtomicInteger.java:215-216`）的实现是：`U.getAndAddInt(this, VALUE, 1) + 1`。也就是说，JDK 11 这条路径在 Java 源码层并没有手写 `for (;;)` CAS 自旋，而是调用 `Unsafe` 的原子加方法，让 JVM 在更底层做这件事。

这正说明它的设计目标：**对于固定模式的"单变量 +1"更新，没必要先上 `synchronized`，也没必要在 Java 层写一圈锁协议。直接走 JVM 原子原语，路径更短。**

## 追问二：那 CAS 自旋体现在哪里？

> 答：体现在 `updateAndGet`、`getAndUpdate` 这类泛化更新 API 里，它们会读旧值、算新值、CAS 失败后重试。

`updateAndGet`（`AtomicInteger.java:275-283`）和 `getAndUpdate`（`:253-261`）就是典型的重试循环：先 `get()` 旧值，算出 `next`，再 `weakCompareAndSetVolatile(prev, next)`；如果失败，说明并发线程先改过了，那就重读再算一轮。

所以真正该记住的不是"AtomicInteger 所有方法都在 Java 层自旋"，而是：**JDK 会针对不同操作形态选最短路径——固定加减走原子加原语，泛化更新走 CAS 重试。**

## 追问三：为什么它不直接用锁？

> 答：因为锁会引入更重的竞争协议，而 `AtomicInteger` 的目标只是维护一个独立整数的原子性。

如果只是维护一个独立计数器，`synchronized` 的成本通常偏大：要进入监视器协议，竞争激烈时还可能挂起和唤醒线程。`AtomicInteger` 的设计就是把问题收缩到最小：**只保证一个 `int` 字段的原子更新，不顺带提供复合操作的一致性，也不保护别的共享状态。**

这也是它和锁的本质分工：

- 锁适合保护一组共享状态和临界区逻辑
- `AtomicInteger` 适合一个独立数值的原子读改写

如果你的场景需要"判断 + 更新 + 影响别的字段"整体原子，最后还是要回到锁或更高层同步器。

## 源码证据

- `incrementAndGet()`（`AtomicInteger.java:215-216`）：直接走 `U.getAndAddInt(...)+1`
- `getAndIncrement()`（`:180-182`）：同样委托给 `U.getAndAddInt(...)`
- `updateAndGet()`（`:275-283`）：`get` + `weakCompareAndSetVolatile` 失败重试
- `getAndUpdate()`（`:253-261`）：同样是 CAS 风格重试循环
- `compareAndSet()`（`:133`）：单独暴露 CAS 语义

## 一句话顿悟

**`AtomicInteger` 不直接加锁，不是因为"锁一定慢"，而是因为它要解决的问题足够小——一个整数的原子读改写，用 JVM 原子原语或 CAS 重试就够了，没必要付出完整锁协议的成本。** 面试官真正想听的不是你会背"CAS 比锁快"，而是你知道 JDK 11 里 `incrementAndGet()` 其实直接走 `getAndAddInt`，而泛化更新 API 才显式体现 CAS 重试模型。