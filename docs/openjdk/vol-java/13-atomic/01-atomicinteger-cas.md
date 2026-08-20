# AtomicInteger 与 CAS：为什么 `volatile++` 还是会丢数据

> 本文基于 JDK 11 `AtomicInteger` 与 `jdk.internal.misc.Unsafe` 源码。重点讨论 `volatile value`、`compareAndSet`、`getAndAddInt`、函数式 CAS 重试与原子更新代价边界；LongAdder、字段更新器和引用原子类放到后续篇章。
> **前置依赖**：[线程与共享变量基础](../11-thread-threadlocal/01-thread-lifecycle.md)
> **后续**：[Striped64 与 LongAdder](02-striped64-longadder.md)

## 先看一个几乎所有人都会答，但一追问就容易答虚的并发入门题

很多人第一次学原子类时，都会先背一句口号：`volatile` 保证可见性，`AtomicInteger` 保证原子性。这句话本身不算错，但如果只停在这一级，就很容易留下一个典型误判：既然 `volatile` 都已经让所有线程看到最新值了，那 `volatile int count; count++;` 为什么还会丢数据？

真正的问题不在“有没有看到最新值”，而在“这次更新到底是不是一个不可拆的动作”。`count++` 看起来像一行，实际至少包含三步：

```text
读旧值
  → 计算新值
  → 写回新值
```

只要这三步之间存在空窗期，别的线程就可以插进来。于是两个线程完全可能都读到同一个旧值，各自算完，再把对方覆盖掉。你看到的不是“值没同步过来”，而是“大家都基于同一个旧事实做了更新，然后后写回的人把前一个人冲掉了”。

所以 `AtomicInteger` 真正要解决的，不是“怎么读到一个最新 int”，而是：**怎么把‘读旧值 → 计算新值 → 写回’这三步粘成一次不会被别线程插队的更新协议。** 这篇就围绕这条主线展开。

## 一、AtomicInteger 的地基其实不是 CAS，而是一个 `volatile` 字段

### 先别把它想成某种神秘的特殊整数类型

JDK 11 里的 `AtomicInteger` 结构非常克制，核心部分几乎一眼能看完：

```java
// AtomicInteger.java:57-64
private static final jdk.internal.misc.Unsafe U = jdk.internal.misc.Unsafe.getUnsafe();
private static final long VALUE = U.objectFieldOffset(AtomicInteger.class, "value");

private volatile int value;
```

这几行分别承担三件事：

- `value`：真正承载共享状态的那个整数
- `VALUE`：把字段位置转换成固定偏移量，供底层原子更新入口使用
- `Unsafe U`：给 Java 层一个能触发底层原子语义的通道

也就是说，AtomicInteger 并不靠什么“JVM 内建神奇整数格式”生效。它本质上仍然只是一个普通对象，里面放着一个 `volatile int value`，外加一组围绕这个字段偏移量工作的原子更新入口。

### 为什么这很重要：因为它说明 volatile 并没有被淘汰

很多人一看到原子类，就会下意识把它和 volatile 对立起来，仿佛用了 `AtomicInteger` 就和 volatile 没关系了。恰恰相反。JDK 11 里 `get()` / `set()` 仍然只是非常直接的 volatile 读写：

- `get()` / `set()` 位于 `AtomicInteger.java:81-99`

它们本身没有 CAS，也没有循环。因为对“单次读”或“单次写”来说，`volatile` 本来就够用了。AtomicInteger 真正要补的，不是单步读写，而是复合更新的原子性。

这一层必须立住，因为它把责任边界切得很清楚：**volatile 负责让单步读写可见，CAS 负责把多步更新粘成一个原子点。**

## 二、为什么普通 `if (value == x) value = y;` 不行：`compareAndSet` 才是最小原子更新原语

### 先看最直觉、也最容易被误判成“差不多”的失败方案

如果你已经意识到 `count++` 三步会被插队，自然就会想到另一种看起来更谨慎的写法：

```java
if (value == expected) {
    value = newValue;
}
```

这看起来已经比直接 `++` 更聪明：先看看是不是我预期的旧值，再决定要不要写。问题是，这个判断和后面的写回之间仍然是分开的。只要它们不是一个不可拆的整体，别的线程就能在你判断完、但还没写回的那一瞬间插进来改掉值。

所以真正的问题不是“有没有比较”，而是“**比较和条件写入是不是一个原子单元**”。这正是 `compareAndSet` 出场的地方。

### `compareAndSet` 为什么是 AtomicInteger 的最小核心

JDK 11 的公开方法体很短：

- `compareAndSet` 位于 `AtomicInteger.java:123-135`

它看起来只是委托：如果当前值仍然等于 `expectedValue`，就把它改成 `newValue`；否则什么都不改，返回失败。这种失败特别关键：CAS 失败不是异常，不代表状态坏了，而是在告诉你——**你刚才基于的旧事实已经被别人抢先改过了，请重新看最新事实再决定。**

真正的原子性则由底层入口兑现：

- `Unsafe.compareAndSetInt` 位于 `Unsafe.java:1360-1363`

这里最该记住的一句话是：CAS 的价值不在“比较两个 int”，而在“**比较与写回之间没有暴露给其他线程的空窗**”。这就是为什么它比普通 if 判断多出来的那一步，恰恰是整个并发正确性的核心。

## 三、`getAndIncrement()` 对外像一个操作，对内其实是一段乐观重试协议

### 先拆掉“它一定是一条神奇 CPU 自增指令”的想象

对调用者来说，`getAndIncrement()` 看上去就像一个单操作：调一下，旧值拿到，计数也安全加一了。可如果你从实现角度看，它最值得学的地方恰恰不是“它成功了”，而是“它是怎样在竞争失败时自己兜底重试的”。

公开方法体仍然非常短：

- `getAndIncrement` / `getAndAdd` 位于 `AtomicInteger.java:166-190`
- `incrementAndGet` / `addAndGet` 位于 `AtomicInteger.java:207-239`

真正把原子更新完全展开的是 `Unsafe.getAndAddInt`：

- `Unsafe.getAndAddInt` 位于 `Unsafe.java:2333-2339`

这段实现是理解原子类最重要的证据之一。它的主线就是：

1. 先做一次 volatile 读，拿到当前值 `v`
2. 尝试 CAS，把它从 `v` 改成 `v + delta`
3. 如果失败，说明别人先改过了，于是回到第一步重读再试

这就是经典的乐观并发协议：**先假设竞争不重，我有希望一次成功；如果事实证明这次假设错了，那就根据最新状态再来一轮。**

### 为什么这段循环说明 AtomicInteger 不是“不会失败”，而是“失败了会自己重试”

这一点特别重要，因为它直接决定了你对 AtomicInteger 的性能预期。很多人误以为原子类既然“无锁”，那就像不需要付任何竞争代价的魔法一样。实际上它只是没有把线程挂起阻塞，而是把失败后的代价换成了一次又一次的 CAS 重试。

所以更准确的描述应该是：

```text
低竞争
  → 多数时候一次 CAS 成功
  → 更新很快

高竞争
  → 大家都围着同一个 value 重试
  → 不阻塞线程，但会持续烧 CPU
```

也就是说，AtomicInteger 的强项是：避免重量级阻塞，让低竞争更新非常便宜；它的边界是：**所有线程都在盯着同一个状态点时，失败重试会把热点彻底暴露出来。**

### `getAndIncrement()` 和 `incrementAndGet()` 为什么不值得被神化成两套机制

这两个 API 表面上一个返回旧值，一个返回新值，很容易让人误以为底层机制不同。其实不是。它们共享的都是同一条 `getAndAddInt` 主线，差别只在于最后返回的是更新前还是更新后。

这件事看似小，但很能提醒读者：AtomicInteger 的核心不在五花八门的 API 名字，而在那条“读 volatile → CAS → 失败重试”的更新骨架。你一旦把骨架看懂，其他很多变体方法都只是返回值和增量形式的排列组合。

## 四、为什么 AtomicInteger 还不够：单点 CAS 热点会把下一篇 LongAdder 引进来

### 先看它已经解决了什么，再看它为什么还会吃力

AtomicInteger 已经把最致命的问题解决了：复合更新不再会像 `volatile++` 那样丢数据。它用 CAS 把“比较旧值”和“写回新值”粘成了原子点，又用失败重试把竞争时的恢复逻辑包掉了。

但这并不意味着它在所有场景下都足够好。因为它的所有线程，最终仍然在争夺同一个 `value` 字段。你可以把它理解成：原先的问题是“多步更新会互相覆盖”；现在的问题变成了“**大家都必须围绕同一个热点位置争抢更新资格**”。

低竞争时这很好，高竞争时就会出现前面说的失败重试风暴。线程没被阻塞，但也没做成多少有用工作，大量 CPU 都花在“我试一下、失败了、再试一下”的循环里。

### 这不是 AtomicInteger 错了，而是单点状态的天然边界

这一步很重要。下一篇 LongAdder 的出场，不是因为 AtomicInteger 设计有 bug，而是因为单点原子状态本来就有天然上限。只要所有线程都必须围绕一个共享整数达成一致，高竞争下总会出现某种形式的热点。

LongAdder 做的事不是“重新发明原子性”，而是把这个热点拆散，让线程不必总是围着同一个点转。也就是说，它解决的是**竞争分布**问题，而不是前面这篇解决的**复合更新原子性**问题。

这一层的收束特别关键，因为它让读者明白后续篇章不是在推翻这一篇，而是在顺着这一篇的边界继续往前走。

## 五个最容易混掉的边界：volatile 不是原子更新，CAS 不是无失败写入，原子类不是无竞争魔法，API 多样不是机制多样，AtomicInteger 也不是高并发计数终点

第一，`volatile` 不是原子更新。它能保证单次读写的可见性，但不能把“读旧值、算新值、写回新值”这三步自动粘成一个不可插队的整体。

第二，CAS 不是无失败写入。`compareAndSet` 的价值恰恰在于它允许失败，并用失败告诉调用方“你基于的旧事实已经过期”；没有这个失败信号，就没有基于最新状态重试的机会。

第三，原子类不是无竞争魔法。`AtomicInteger` 避开的是重量级阻塞，不是竞争本身；当很多线程同时围着同一个 `value` 重试时，热点和 CPU 消耗并不会凭空消失。

第四，API 多样不是机制多样。`getAndIncrement()`、`incrementAndGet()`、`addAndGet()` 这些方法在返回值形式上不同，但底层共享的都是“volatile 读 + CAS + 失败重试”这条更新骨架。

第五，`AtomicInteger` 也不是高并发计数终点。它解决的是复合更新原子性，不是单点热点分散；一旦所有线程都长期争抢同一个整数位置，下一层问题就变成如何拆散竞争分布，而不是再强调一次 CAS 正确性。

把这五条边界记稳，AtomicInteger 就不会再被理解成“用了原子类一切并发写都自动高效”的万能答案。它真正想讲的是：先用 CAS 守住复合更新正确性，再根据竞争强度决定单点状态是否还扛得住；这也正是下一篇 LongAdder 出场的逻辑起点。

## 收网：AtomicInteger 真正提供的是“把复合更新封装成 CAS 重试”的能力

现在回到开头那道几乎人人都见过的题，答案应该已经不再是简单一句“volatile 不保证原子性”。更完整的说法是：`volatile++` 之所以还会丢数据，不是因为线程看不到彼此写入，而是因为“读旧值 → 算新值 → 写回”这三步之间仍然允许别人插队。

AtomicInteger 提供的也不是什么更神秘的整数类型。它仍然以一个 `volatile int value` 为地基，只是在这个字段之上加了一套由 `Unsafe` 驱动的原子更新协议：`compareAndSet` 负责提供最小原子替换能力，`getAndIncrement()` 这类方法则把“volatile 读 + CAS 重试”封装成看起来像单步的复合更新。

把整篇压成一张总图，就是：

```text
volatile
  → 解决单步读写可见性
  → 解决不了读改写三步粘合

CAS
  → 让“比较旧值 + 条件写回”成为原子点
  → 失败时返回竞争信号

AtomicInteger
  → 一个 volatile value
  → 一组 Unsafe 原子更新入口
  → 高层 API 把 CAS 失败重试封装起来
```

如果说这一篇解决的是“为什么复合更新不能只靠 volatile”，那下一篇要继续解决的就是：当所有线程都盯着同一个 AtomicInteger 热点打转时，怎样把这个单点热点拆散，让高并发累加不再把 CPU 浪费在同一个值上反复争抢。那就是 `docs/openjdk/vol-java/13-atomic/02-striped64-longadder.md` 要展开的主线。