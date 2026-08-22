# ThreadLocal 为什么用弱引用做 key？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`11-thread-threadlocal/02-threadlocal`
> 版本边界：下文引用的 `ThreadLocal.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

ThreadLocal 的 Entry 为什么用弱引用做 key？用强引用可以吗？这跟内存泄漏到底什么关系？

## 常见答法

> 因为用弱引用做 key，ThreadLocal 对象可以及时被回收，防止内存泄漏。

这个答法只答对了一半，而且把"为什么用弱引用"和"为什么还泄漏"这两个正相反的问题混在了一起。**弱引用做的 key 恰恰是"ThreadLocal 对象能被回收"的原因，但 ThreadLocal 真正泄漏的不是 key，而是 value。** 把这个关系理不清，面试官一追问就露馅。

## 追问一：用弱引用做 key，那 key 什么时候会被回收？

> 答：当外部不再强引用这个 ThreadLocal 对象时，GC 可以回收它，因为 Entry 只持有它的弱引用。

对。`Entry extends WeakReference<ThreadLocal<?>>`（`ThreadLocal.java:329`），key 是弱引用。当外部强引用断开后，ThreadLocal 对象可以被 GC 收掉，Entry 里的 key 就变 null。

但这里有个关键点：**如果 key 是强引用，会怎样？** 假设 `ThreadLocal` 通常是个静态字段或实例字段，被外部长期引用，那强引用反而不影响它本身的生命周期。真正要问的是：当外部不再引用这个 ThreadLocal 时，Entry 里的 key 能不能被释放。

## 追问二：那为什么用强引用不行？

> 答：因为 Entry 是挂在线程的 ThreadLocalMap 里的，如果 key 用强引用，即使外部不用这个 ThreadLocal 了，线程还在，Entry 还强引用着 key，key 永远不会被 GC。

对。`ThreadLocalMap` 是每个线程对象持有的成员，`Entry[]` 会一直活在活线程身上。如果 Entry 的 key 用强引用，那么：

- 外部不再引用 ThreadLocal
- 但线程活着的 → 线程的 ThreadLocalMap 活着 → Entry 活着 → Entry 强引用 key

结果就是：**即使业务已经不用这个 ThreadLocal 了，key 也永远不会被回收。** 而弱引用的价值正在这里：key 的存活不由 ThreadLocalMap 决定，由外部是否还持有它决定——外部不持有，key 就能被 GC 掉，Entry 变成"key 为 null 的脏槽"。

## 追问三：那既然 key 是弱引用，为什么还说 ThreadLocal 会内存泄漏？

> 答：因为 key 弱了，value 不弱。Entry 有一个强引用 value 字段（`ThreadLocal.java:332`），key 被回收后，value 还活着。

这是最"反直觉"的一层。`Entry` 的结构是：`key` 是弱引用，`value` 是普通强引用（`ThreadLocal.java:332` 的 `Object value`）。所以：

- 外部不再引用 ThreadLocal → key 被 GC → Entry 变成脏槽
- 但 value 被 Entry 强引用着 → value 不会因为 key 消失而消失
- 线程活着 → ThreadLocalMap 活着 → Entry 活着 → value 活着

所以真正驻留的是 value。`ThreadLocal` 用弱引用做 key，只是解决了"key 不会被 ThreadLocalMap 拖住"这个问题，并没有解决"value 会被 Entry 拖住"这个问题。后者要靠 `remove()`（`ThreadLocal.java:239`）或 map 的清理逻辑来回收。

## 追问四：那为什么要用弱引用，而不干脆不缓存 value？

> 答：不缓存 value 就无法实现"每线程一份"的语义；弱引用只是让 key 的生命周期回归到外部控制。

对。ThreadLocal 的核心是所有线程各持一份 value，而这份 value 必须挂在某个地方——就是线程的 ThreadLocalMap。你不用它，就得自己在线程局部做一个映射表。弱引用 + ThreadLocalMap 的组合，让"每线程一份 value"成为可能，同时还让"key 的生命周期"尽量公平（由外部决定，不由线程决定）。

## 源码证据

- `Entry extends WeakReference<ThreadLocal<?>>`（`ThreadLocal.java:329`）：key 是弱引用
- `Object value` 强引用字段（`:332`）：value 是强引用，key 回收后仍驻留
- `threadLocalHashCode`（`:87`）：每个 ThreadLocal 的稳定哈希，用于索引 Entry
- `remove()`（`:239`）：主动清除当前线程的 key，是防泄漏的正解

## 一句话顿悟

**"用弱引用做 key"解决的只是"key 不被线程拖住"——它让 ThreadLocal 对象能被外部收回，因此比强引用更公平；但真正的泄漏点在 value，它被 Entry 强引用、会跟着活线程驻留。** 面试官真正想听的不是你会背"弱引用防泄漏"，而是你能把"key 弱了 / value 强着"这一正一反说清，并知道真正的正解是 `remove()`。