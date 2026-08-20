# 13-atomic/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `AtomicInteger` 与 `jdk.internal.misc.Unsafe`。本文聚焦 `volatile value`、`compareAndSet`、`getAndAddInt`、`getAndIncrement`/`incrementAndGet`、`weakCompareAndSet` 与单点 CAS 竞争边界；LongAdder、字段更新器与引用原子类留到后续篇章。
> 目标：把“AtomicInteger 与 CAS”改写成一篇围绕“为什么 `volatile++` 还是会丢数据，以及原子类为什么本质上是在把‘读改写’封装成 CAS 重试协议”的机制文章。

## 1. 读者困惑

- `volatile` 都已经保证可见性了，为什么 `volatile int count; count++;` 还是不安全？
- `AtomicInteger` 到底比 `volatile int` 多了什么，为什么它不是“更强的 int”这么简单？
- `compareAndSet` 的真正价值是什么，为什么普通 `if (value == x) value = y;` 不行？
- `getAndIncrement()` 为什么对调用者像一个操作，对实现里却可能是一整段重试循环？
- 为什么高竞争场景下 AtomicInteger 也会吃力，它到底卡在哪？
- `weakCompareAndSet`、`getAndAddInt`、`Unsafe` 这些底层入口各自承担什么角色？

## 2. 一句话顿悟

**AtomicInteger 真正要解决的，不是“怎么读到最新值”，而是“怎么把读旧值、计算新值、写回新值这三步粘成一次不会被别线程插队的更新”。`volatile` 只保证单步读写的可见性，CAS 才提供比较与写入的原子条件替换；而 `getAndIncrement()` 等原子更新，本质上都是“volatile 读 + CAS 失败重试”的乐观并发协议。**

## 3. 旧稿优点与问题

### 保留

- 已把 `volatile++` 丢数据问题、`compareAndSet`、`Unsafe.getAndAddInt` 重试模板、低竞争/高竞争代价讲清。
- 已说明 AtomicInteger 不是替代 volatile，而是在 volatile 之上补原子更新协议。
- 已自然把 LongAdder 留作下一篇承接，这个钩子方向是对的。

### 必须重写

- 旧稿虽然已经较完整，但还可以更明确地把“volatile 够单步，不够复合更新”作为总问题收束全篇。
- `AtomicInteger` 的结构部分需要更强地回到“一个字段 + 一个偏移量 + 一组原子入口”这张总图上。
- 需要补更清楚的失败方案：为什么不能靠 `synchronized` 以外的普通 if 判等替代 CAS。
- 收网应更明确地点出“单点 CAS 热点”是下一篇 LongAdder 的真正动机，而不是只说竞争会高。

## 4. 理解路径

### 第一节：从 `volatile++` 为什么仍然丢数据开场

用两个线程都读到 0、各自写回 1 的经典场景开场。重点不是重复“volatile 不保证原子性”，而是把 `count++` 拆成读旧值、算新值、写回三步，让读者看到问题发生在“复合更新被插队”。

### 第二节：AtomicInteger 的本体其实很克制——一个 volatile 字段，加偏移量和原子入口

证据：
- `AtomicInteger.java:57-64`：`Unsafe U`、`VALUE`、`volatile value`
- `AtomicInteger.java:81-99`：`get()` / `set()`

主线：
- `value` 仍然只是一个 `volatile int`。
- AtomicInteger 的特殊之处，不在数据格式，而在于它为这个字段配了一组受控原子更新入口。
- `get`/`set` 本质仍是 volatile 读写，说明 volatile 不是被淘汰，而是成为原子类地基。

### 第三节：为什么普通 if 判等不行，CAS 才是最小原子更新原语

证据：
- `AtomicInteger.java:123-135`：`compareAndSet`
- `Unsafe.java:1360-1363`：`compareAndSetInt`

主线：
- 朴素失败方案：先读，再 if 判断，再赋值；问题在于判断和写入之间可以被别线程插队。
- `compareAndSet` 把“比较当前值”和“条件写回新值”绑定成一个不可拆的原子点。
- CAS 失败不是异常，而是竞争信号，提示调用者重新看当前事实再决策。

### 第四节：`getAndIncrement` 为什么是一段乐观重试协议，不是神秘魔法

证据：
- `AtomicInteger.java:166-190`：`getAndIncrement` / `getAndAdd`
- `Unsafe.java:2333-2339`：`getAndAddInt`

主线：
- 公开 API 看起来只有一行委托，底层却是“读 volatile → CAS 尝试 → 失败重来”的循环。
- 成功快，是因为大多数时候竞争不激烈；高竞争慢，是因为所有线程围着同一个点反复重试。
- 这里要把“AtomicInteger 并不是不会失败，而是替你把失败重试封装掉了”讲透。

### 第五节：返回旧值和返回新值为什么不值得神化成两套机制

证据：
- `AtomicInteger.java:207-239`：`incrementAndGet` / `addAndGet`

主线：
- `getAndIncrement` 与 `incrementAndGet` 的差别只在返回旧值还是新值。
- 底层都是同一套 getAndAddInt 协议，不是两种不同原子性机制。
- 这能帮读者避免把 API 表面差异误会成底层实现差异。

### 第六节：为什么这还不够——单点 CAS 热点会把下一篇 LongAdder 引进来

主线：
- AtomicInteger 解决了复合更新原子性，却把所有线程都压回同一个 value 字段上竞争。
- 低竞争时一次 CAS 成功非常好；高竞争时失败重试会把 CPU 花在抢同一个点上。
- 这不是 AtomicInteger 设计错误，而是单点原子更新的天然边界。
- LongAdder 的动机因此被立住：不是为了替代原子性，而是为了拆散这个单点热点。

## 5. 失败方案清单

1. 以为 `volatile++` 因为可见性已经足够，所以天然线程安全。
2. 用普通 if 判等 + 赋值替代 CAS，忽略比较与写回之间的竞态窗口。
3. 把 AtomicInteger 理解成一种 JVM 特殊整数类型，而不是对象封装协议。
4. 以为 `getAndIncrement()` 一定对应单条 CPU 自增指令，不会失败重试。
5. 在高竞争计数场景继续把所有线程压到一个 AtomicInteger 上，忽略单点热点。
6. 把 CAS 失败当成程序异常，而不是正常竞争结果。
7. 把 `incrementAndGet` 和 `getAndIncrement` 误解成不同的并发机制。

## 6. 误解清单

1. volatile 和原子类是互斥概念，用了 AtomicInteger 就和 volatile 无关。
2. CAS 只是“更快的 if”，不影响正确性边界。
3. `compareAndSet` 失败说明数据坏了。
4. AtomicInteger 既然无锁，就没有任何高竞争代价。
5. `weakCompareAndSet`、`compareAndSet`、`getAndAddInt` 只是不同命名风格。
6. 原子类的价值就是替代 synchronized，别的什么都不重要。
7. LongAdder 只是 AtomicInteger 的“更快版”，无需理解热点来源。

## 7. 证据清单

- `AtomicInteger.java:57-64`：`Unsafe U` / `VALUE` / `volatile value`
- `AtomicInteger.java:81-99`：`get()` / `set()`
- `AtomicInteger.java:123-135`：`compareAndSet`
- `AtomicInteger.java:166-190`：`getAndIncrement` / `getAndAdd`
- `AtomicInteger.java:207-239`：`incrementAndGet` / `addAndGet`
- `Unsafe.java:1360-1363`：`compareAndSetInt`
- `Unsafe.java:2333-2339`：`getAndAddInt`

## 8. 版本与边界

- 基于 JDK 11。
- 本文重点解释整数原子更新协议，不展开 VarHandle 全景与字段更新器机制。
- 不把 `AtomicInteger` 写成所有计数场景的最佳答案，它有单点热点边界。
- 不把底层 intrinsic/Unsafe 细节扩展成完整 CPU 指令教程，只解释到 Java / JVM 边界够用为止。
- 后续 LongAdder、FieldUpdater、引用原子类视为同域延伸，不在本文混讲。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 `volatile++` 还是会丢数据 → AtomicInteger 为什么仍以 volatile 字段为地基 → compareAndSet 如何把比较和写回粘成一次 → getAndIncrement 为什么是读 + CAS 重试 → 高竞争下为什么会出现单点热点”。
- 必须把 volatile 的边界和 CAS 的职责分开讲清。
- 必须把 `getAndAddInt` 重试模板讲成本文核心证据之一。
- 必须自然引到下一篇 LongAdder 的分片动机。
- 结尾要自然衔接 `02-striped64-longadder.md`。
