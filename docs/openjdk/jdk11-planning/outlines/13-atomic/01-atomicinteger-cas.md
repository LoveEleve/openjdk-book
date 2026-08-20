# 01. AtomicInteger 与 CAS 封装 — volatile + CAS 循环、内存语义

> 🔴 Deep | 域 13 原子类第 1 篇 | Layer 3
> 读者处境: 面试"AtomicInteger 怎么实现""和 volatile 有什么区别"——从字段到 CAS 循环的完整实现,以及内存语义。

### 1. "AtomicInteger 里有什么？" — volatile + Unsafe 偏移

场景: `new AtomicInteger(0)` — 这个对象怎么做到原子读写的?

- `AtomicInteger.java:64` — `private volatile int value` — **volatile 字段**(可见性保证)
- `AtomicInteger.java:62` — `VALUE = U.objectFieldOffset(AtomicInteger.class, "value")` — **字段偏移**(Unsafe,域 32)
- `get()`(87,volatile 读)/`set()`(97,volatile 写)/`lazySet`(108,最终写入)
- 关键设计 (斜体): *结构 = "volatile 字段 + 偏移常量 + Unsafe 操作"——volatile 保证可见性,CAS 保证原子性;这两个能力**组合**才是原子类的本质*
- 面试: "volatile 能替代 AtomicInteger 吗?"——不能:i++ 不是原子的(读-改-写三步);volatile 只解决可见性
- [关联: 域 11 volatile 语义;域 32 Unsafe 字段访问]

### 2. "compareAndSet 怎么保证原子？" — CAS 原生语义

场景: `compareAndSet(expected, newValue)` — 为什么"比较+设置"是原子的?

- `AtomicInteger.java:133` `compareAndSet` → `U.compareAndSetInt`(域 32:1361,native LOCK CMPXCHG)
- 语义: 当前值 == expected → 写 newValue 返回 true;否则不改返回 false——**单指令原子**
- `weakCompareAndSet`(154): JDK9+ 弱化版本(可虚假失败,无 strong 的内存序保证)——性能换语义
- `AtomicInteger.java:410/432` setPlain/setOpaque 等内存序变体(JDK9+ VarHandle 风格)
- 关键设计 (斜体): *CAS 三用途: ① 无锁更新(成功即完)② CAS 循环(失败重试,见 §3)③ 状态切换(compareAndSet 作"一次性"标志);weak 变体适合循环场景(失败就重试,不损失)*
- [x86: LOCK CMPXCHG;内部卷 05-cpu-primitives(内存序)]
- 面试: "compareAndSet vs weakCompareAndSet"——strong 有完整 happens-before;weak 可假失败(循环内用)

### 3. "getAndIncrement 怎么实现？" — CAS 循环

场景: `count.getAndIncrement()` — 没有"原子自增指令"怎么实现?

- `AtomicInteger.java:180` — `return U.getAndAddInt(this, VALUE, 1)` — 委托 Unsafe(域 32:2334)
- Unsafe 实现: `do { v = getIntVolatile(o, offset); } while (!weakCompareAndSetInt(o, offset, v, v+delta));`
- **循环重试**: 读旧值 → CAS → 失败(别人改了)重读——乐观并发
- `getAndUpdate`(253)/`updateAndGet`(275): 函数式版本(自定义运算的 CAS 循环)
- 关键设计 (斜体): *CAS 循环是"无锁"的通用模式——代价: 高竞争下自旋浪费 CPU(可加退避);面试手写 `while(!cas) {}` 是基本功;与 synchronized 对比: 无上下文切换但忙等*
- 面试: "高并发下 AtomicLong 为什么慢?"——所有线程抢同一个 value,CAS 大量失败重试(预判: LongAdder 方案,第 2 篇)

### 4. "ABA 问题" — 引用原子的坑(预告)

场景: 面试"CAS 的 ABA"——AtomicInteger 有没有 ABA?

- ABA 定义: 值 A→B→A,CAS 误判"没被改过"(域 32 §3 已述)
- **基本类型计数无 ABA 之忧**(值相同即结果相同);引用类型有问题(对象被替换又换回)
- 解: `AtomicStampedReference`(版本戳,第 3 篇)
- 关键设计 (斜体): *ABA 的严重性取决于语义: 计数器无碍,链式结构致命;面试答"AtomicInteger 不需要担心,引用场景用 StampedReference"*
- [关联: 域 32 §3 ABA;域 12 AQS(用 CAS 的无锁队列需注意)]

---

### 核心悬念

单点 CAS 在高并发下争抢——**LongAdder 怎么解决**?它把"一个计数器"拆成"多个 Cell",每个线程打自己的格——伪共享又是什么?`@Contended` 注解怎么防缓存行抖动?——下一篇: Striped64 与 LongAdder。

> → [02-striped64-longadder.md](02-striped64-longadder.md)
