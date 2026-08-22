# `sleep`、`yield`、`join`、`wait` 到底有什么区别？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`11-thread-threadlocal/01-thread-lifecycle`
> 版本边界：下文引用的 `Thread.java`、`Object.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

`sleep`、`yield`、`join`、`wait` 都有"让线程暂停"的效果，它们到底有什么区别？什么时候该用哪个？

## 常见答法

> sleep 是睡觉，yield 是让出 CPU，join 是等线程结束，wait 是等待。这四个都会让线程暂停。

这个答法把四个 API 归成"暂停"一类，但**它们暂停的方式、锁的行为、唤醒条件、适用场景完全不同**。真正看懂它们的分界，要看每个 API 和"锁"以及"谁把它唤醒"的关系。

## 追问一：sleep 和 wait 有什么区别？

> 答：sleep 不释放锁，wait 释放锁；sleep 到时自动醒，wait 要等 notify。

对。`Thread.sleep(long)`（`Thread.java:295`）是 native，它在指定时间等待，然后自动恢复。关键点是：**sleep 不释放当前线程持有的任何监视器锁**。你拿着 synchronized 锁 sleep，别的线程一样进不来。

`Object.wait(long)`（`Object.java:352`）则不同：它在挂起前释放当前持有的监视器，让别的线程能进来改条件、发 notify，然后被唤醒后重新抢回锁。

## 追问二：yield 是干嘛的？它和 sleep(0) 有区别吗？

> 答：yield 是提示调度器"当前线程愿意让出 CPU"，但不保证一定要让；sleep(0) 是至少等 0 毫秒。两者都是给调度器的提示，不是强制定位。

`Thread.yield()`（`Thread.java:276`）是 native，语义是"提示当前线程愿意让出 CPU 给同优先级线程"。但调度器可以选择忽略这个提示，所以 yield 不是一个可靠的控制手段。生产代码里几乎不该依赖 yield 做同步。

`sleep(0)` 和 yield 的区别在于：sleep(0) 会让当前线程至少经过一次 0 毫秒的等待，期间调度器有机会介入；yield 是纯提示，不承诺任何延迟。两者都非常微弱，不能用来做确定性控制。

## 追问三：join 和 wait 是什么关系？join 的实现是不是用了 wait？

> 答：join 的底层实现就是 wait。`join` 会持续检查目标线程 `isAlive()`，还没死就 `wait(0)`。

`Thread.join(long)`（`Thread.java:1289`）是 `synchronized` 方法，它内部用 `while (isAlive()) wait(0)` 循环等待目标线程结束。这正是之前文章讲过的"线程死亡事件驱动"——join 不是轮询，而是把等待线程挂到目标线程对象的监视器上，目标线程结束时 JVM 会 notify，等待线程被唤醒后重新检查 `isAlive()`。

所以 join 和 wait 的本质关系是：**join 就是用 wait/notify 在目标线程对象上实现的一次"等它结束"的封装。**

## 源码证据

- `Thread.sleep(long)`（`Thread.java:295`）：native，等时间，不释放锁
- `Thread.yield()`（`:276`）：native，提示让出 CPU，不保证
- `Thread.join(long)`（`:1289`）：`synchronized` 方法，内部 `while (isAlive()) wait(0)`
- `Object.wait(long)`（`Object.java:352`）：native，释放监视器，等 notify

## 一句话顿悟

**四个 API 的分界线不在"暂停"而在"锁和唤醒"：sleep 不释放锁、到时自醒；wait 释放锁、等 notify；join 是 wait 在目标线程对象上的一次封装；yield 只是给调度器的微弱提示。** 面试官真正想听的不是你会背"sleep 睡觉 wait 等待"，而是你知道哪几个释放锁、哪几个依赖谁唤醒、以及 join 底层其实用的是 wait。