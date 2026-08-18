# 03. CAS 原语与线程控制 — compareAndSet、getAndAdd、park/unpark

> **前置依赖**: [32-unsafe/01 — Unsafe 全景](01-unsafe-overview.md)(四大能力域)、[13-atomic/01 — 原子与 CAS](../13-atomic/01-atomicinteger-cas.md)(CAS 语义)
> → **后续**: 按写作顺序回到并发大厦的上层应用
> 关联: [12-lock-sync/01 — AQS 核心](../12-lock-sync/01-aqs-core.md)(park/unpark)

## Unsafe 怎样支撑并发原语

Unsafe 最有穿透力的两组能力是 **CAS** 与 **park/unpark**。前者解决无锁更新,后者解决线程阻塞与唤醒。

## 1. "compareAndSetInt 是什么?" — 原子比较交换

### 1.1 语义

`sun.misc.Unsafe` 的公开入口会委托给内部实现;在公开层可见的是:

- `compareAndSetInt` 委托入口(`Unsafe.java:878`)

语义是:

- 如果当前位置值等于 `expected`,就原子写入新值 `x` 并返回 `true`
- 否则不写入,返回 `false`

这不是“读一下再 if 再赋值”的 Java 组合语句,而是底层原子指令语义暴露出的单步操作。

### 1.2 为什么重要

CAS 不阻塞、不挂起线程;失败由调用方决定是否重试,因此它是乐观并发的基础。

关键设计(斜体):*CAS 的本质是“比较 + 交换”作为一个原子动作完成。面试"CAS 和 synchronized 区别": CAS 先假设少竞争,失败重试;锁则直接进入互斥等待。*

## 2. "getAndAddInt 怎么实现?" — 自旋模板

### 2.1 抽象模板

`getAndAddInt` 的公开入口在 `Unsafe.java:1105-1106`,继续委托给内部 Unsafe。

虽然这里公开层没有直接展开循环源码,但它代表的标准无锁模板就是:

1. 读当前值
2. 计算新值
3. CAS 提交
4. 失败则重读重试

这正是 `AtomicInteger.getAndIncrement()`、ConcurrentHashMap 某些计数路径、以及大量无锁算法的共同骨架。

### 2.2 weak vs strong

弱 CAS 允许“假失败”,但在循环里仍然可用,因为外层本来就会重试。强 CAS 语义更直观,弱 CAS 更利于某些平台映射到底层原语。

关键设计(斜体):*CAS 循环是“无锁算法模板”。面试手写 CAS 时,记住不是一次 compareAndSet 就够了,而是失败要自旋重试。*

## 3. "ABA 问题" — CAS 的经典陷阱

### 3.1 问题本质

CAS 只能判断“当前值是否等于期望值”,不能判断“这个值中途是否被改过”。

于是就有 ABA:

- 线程 1 看到值是 A
- 线程 2 把 A 改成 B,又改回 A
- 线程 1 再做 CAS,会误以为值从没变过

### 3.2 什么时候严重

- 纯计数器场景通常不在乎 ABA
- 链表/栈/队列等引用结构会在乎,因为“值看起来一样”不代表“结构状态没变”

典型解决方法是把“值 + 版本”一起 CAS,例如带戳引用或显式版本号。

关键设计(斜体):*ABA 的本质是“值相等不等于历史未变”。面试"怎么解决 ABA": 版本号/标记位;指针结构比纯数字计数更敏感。*

## 4. "park/unpark" — 阻塞原语

### 4.1 两个入口

Unsafe 暴露的线程控制原语是:

- `unpark(Object thread)`(`Unsafe.java:1050-1051`)
- `park(boolean isAbsolute, long time)`(`:1066-1067`)

它们直接委托内部 Unsafe 完成线程唤醒/阻塞。

### 4.2 许可语义

`park/unpark` 不是监视器的 `wait/notify` 复制品。它的特点是:

- 不要求调用者先持有某把锁
- `unpark` 可以先发生,许可会保留下来供下一次 `park` 消费
- 唤醒目标是具体线程对象,而不是某个对象监视器上的任意等待者

这正是 `LockSupport` 与 AQS 能精细控制等待线程的基础。

关键设计(斜体):*park/unpark 是“一次许可”模型,不是对象监视器模型。面试"LockSupport 和 wait 的区别": 不需要锁、按线程定向唤醒、许可可先发。*

## 5. "内存屏障" — 有序性原语

除了 CAS 和阻塞,Unsafe 还提供有序性原语:

- `loadFence()`(`Unsafe.java:1187-1188`)
- `storeFence()`(`:1204-1205`)
- `fullFence()`(`:1218-1219`)

它们不改值,但影响读写重排边界,是更底层的内存模型工具。上层并发框架很少直接暴露给业务开发者,但在实现同步器/无锁结构时很关键。

关键设计(斜体):*并发正确性不只有“原子更新”,还有“可见性与顺序性”。CAS、park/unpark、fence 一起构成 Unsafe 并发原语的三件套。*

## 本域收官

Unsafe 到这里收官: 堆外内存解释了 DirectBuffer 的生命周期,CAS 与 park/unpark 则解释了原子类、AQS、并发集合和线程池底层为何能工作。它不是建议业务直接使用的 API,但却是理解 JDK 并发内核的必经之路。