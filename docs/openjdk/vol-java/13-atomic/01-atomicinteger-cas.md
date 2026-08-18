# 01. AtomicInteger 与 CAS 封装 — volatile + CAS 循环、内存语义

> **前置依赖**: [11-thread-threadlocal/01 — 线程的生命周期](../11-thread-threadlocal/01-thread-lifecycle.md)(`Thread.threadStatus` 的 volatile 实例)、[03-object-system/01 — 对象生命周期](../03-object-system/01-object-contract-references.md)(对象头与引用状态机)
> → **后续**:[13-atomic/02 — Striped64 与 LongAdder](02-striped64-longadder.md)
> 关联: 域 32 Unsafe(CAS 原语与字段偏移);域 12 锁与同步器(AQS 基于 CAS + volatile 状态);内部卷 05-cpu-primitives(原子指令与内存屏障)

## 一个 volatile 字段,怎么就成了"原子类"

面试从 "AtomicInteger 和 volatile 有什么区别" 开始——你背过答案: volatile 只保证可见性,AtomicInteger 才保证原子性。但下一个问题通常接踵而至:"AtomicInteger 内部到底怎么实现的?"这个问题,答案只有四行代码。这篇从这四行出发,拆开 CAS 封装、CAS 循环、内存语义,最后停在 ABA 问题——那是引用原子的专属陷阱。

## 1. "AtomicInteger 里有什么？" — volatile 字段 + Unsafe 偏移

### 1.1 类初始化的三行

`new AtomicInteger(0)` 之后,这个对象的核心只有字段 + 两个 static final 字段(`AtomicInteger.java:57-64`):

```java
// AtomicInteger.java:57-64(截取核心,逐字)
/*
 * This class intended to be implemented using VarHandles, but there
 * are unresolved cyclic startup dependencies.
 */
private static final jdk.internal.misc.Unsafe U = jdk.internal.misc.Unsafe.getUnsafe();
private static final long VALUE = U.objectFieldOffset(AtomicInteger.class, "value");

private volatile int value;
```

三个部分各司其职:

1. **`private volatile int value`**(`AtomicInteger.java:64`):唯一的实例字段。`volatile` 保证对它的读写都有 volatile 内存语义——读是 volatile 读,写是 volatile 写,任何线程读到的是最新值。这是"可见性"的地基
2. **`U = jdk.internal.misc.Unsafe.getUnsafe()`**(`AtomicInteger.java:61`):拿到 `jdk.internal.misc.Unsafe` 单例。注意 JDK9+ 内部版在 `jdk.internal.misc` 包下,`sun.misc.Unsafe` 是留给外部使用者的公开版(域 32 展开)
3. **`VALUE = U.objectFieldOffset(AtomicInteger.class, "value")`**(`AtomicInteger.java:62`):**字段在对象内存布局里的偏移量**——`objectFieldOffset`(`Unsafe.java:948`,`Unsafe.java:967` 的按名版本)是对 native 的包装,由 JVM 返回该字段相对对象头的字节偏移。有了这个数,Unsafe 就能绕过 `value` 这个 Java 名字,直接对内存地址操作

这三行在**类初始化期**执行一次——`U` 和 `VALUE` 都是 `static final`,偏移量对整个生命周期恒定不变(字段布局不会变)。这就是"结构 = volatile 字段 + 偏移常量 + Unsafe 操作"的完整拼图。

### 1.2 get/set:volatile 读写的直白样子

```java
// AtomicInteger.java:87-89(截取核心,逐字)
public final int get() {
    return value;
}
```

```java
// AtomicInteger.java:97-99(截取核心,逐字)
public final void set(int newValue) {
    value = newValue;
}
```

`get()` 就是一次 volatile 读,`set()` 就是一次 volatile 写——**跟普通字段唯一的差别是 volatile 关键字本身**,连 Unsafe 都没用到。这也回答了开篇问题的一半: 单读单写,`volatile` 已经足够;AtomicInteger 的存在,是因为**读-改-写三步**只有 volatile 不够(见 §1.4)。

### 1.3 lazySet:放行乱序的"最终写入"

```java
// AtomicInteger.java:108-110(截取核心,逐字)
public final void lazySet(int newValue) {
    U.putIntRelease(this, VALUE, newValue);
}
```

`lazySet` 走 Unsafe 的 `putIntRelease`——规范语义上是 release 写: **保证之前的写不被重排到它之后,但不保证自己之后的读看到它**(少了 volatile 写的"之后所有读都看到"那半边)。但看 JDK11 的实现,release 变体只是 volatile 写的别名:

```java
// Unsafe.java:2134-2137(截取核心,逐字)
@HotSpotIntrinsicCandidate
public final void putIntRelease(Object o, long offset, int x) {
    putIntVolatile(o, offset, x);
}
```

`@HotSpotIntrinsicCandidate` 是线索: **Java 层委托 volatile,但 JIT 在其它架构上可以内联成更弱的机器指令**(release 只需要 store-store,不需要 store-load)。所以在 x86 上 `lazySet` 与 `set` 的屏障完全一样;它的语义价值在规范承诺——"最终会写到,但别等"——常用于非关键的收尾标志,比如引用计数减到 0 后把引用置空,读者晚一点看到也无妨。

### 1.4 面试点:volatile 能替代 AtomicInteger 吗?

`i++` 在字节码里是三步: 读 `i` → 加 1 → 写回。volatile 只保证每一步自身的内存语义,不保证"读-改-写"三步作为一个整体不被其他线程插入——两个线程同时读到 0,都加 1 写回,结果是 1 而不是 2。**volatile 解决可见性,CAS 解决原子性**,两个能力组合起来才是原子类。

关键设计(斜体):*原子类 = "volatile 字段 + 偏移常量 + Unsafe 操作"三件套——volatile 管"看得见"(可见性),CAS 管"改得对"(原子性)。面试答"volatile 只保证可见性,AtomicInteger 保证原子性"是入门;能说出"get/set 就是裸 volatile 读写,只有读-改-写才需要 CAS"才是源码级。*

跨层标注: [内部卷: 05-cpu-primitives 01-atomic-and-memory-order——volatile 读写最终落到 `lock` 前缀的内存屏障;对象字段偏移的 JVM 侧计算(域 32 Unsafe 展开)]

## 2. "compareAndSet 怎么保证原子？" — CAS 原生语义

### 2.1 一行委托

```java
// AtomicInteger.java:133-135(截取核心,逐字)
public final boolean compareAndSet(int expectedValue, int newValue) {
    return U.compareAndSetInt(this, VALUE, expectedValue, newValue);
}
```

`compareAndSet` 只是壳,真正干活的是 `U.compareAndSetInt`(`Unsafe.java:1360-1363`):

```java
// Unsafe.java:1360-1363(截取核心,逐字)
@HotSpotIntrinsicCandidate
public final native boolean compareAndSetInt(Object o, long offset,
                                             int expected,
                                             int x);
```

native 方法,带 `@HotSpotIntrinsicCandidate` 注解——**JIT 遇到它会内联替换为 CPU 指令**(intrinsify),x86 上就是一条带 `lock` 前缀的 `CMPXCHG`: 比较内存值与 expected,相等则写入 x 并返回 true,不等则不动、返回 false。**"比较 + 写入"由硬件保证为单指令原子**,没有窗口期(内部卷 05-cpu-primitives 详解 `lock cmpxchg` 的 MESI 代价)。

### 2.2 JDK11 的命名考古:compareAndSwap → compareAndSet

`compareAndSetInt` 的 "Set" 是 JDK9 内部版的新命名——老名字 `compareAndSwapInt` 依然存在,只是退休到了公开版 `sun.misc.Unsafe`(`sun/misc/Unsafe.java:874-879`):

```java
// sun/misc/Unsafe.java:874-879(截取核心,逐字)
@ForceInline
public final boolean compareAndSwapInt(Object o, long offset,
                                       int expected,
                                       int x) {
    return theInternalUnsafe.compareAndSetInt(o, offset, expected, x);
}
```

公开版保留老名做兼容层,内部实现委托给新命名。看到 `compareAndSwapInt`(sun.misc 公开版旧名)和 `compareAndSetInt`(JDK9 内部版新名)都别慌,是同一个东西——这是 JDK9 内存序细化改名运动的产物。

### 2.3 weakCompareAndSet:JDK9 里的"弃用陷阱"

```java
// AtomicInteger.java:153-156(截取核心,逐字)
@Deprecated(since="9")
public final boolean weakCompareAndSet(int expectedValue, int newValue) {
    return U.weakCompareAndSetIntPlain(this, VALUE, expectedValue, newValue);
}
```

大纲时代大家爱讲"weak 变体可以虚假失败、性能换语义"——**JDK11 的真相是**: 它被标记 `@Deprecated(since="9")` 了,原因写在 Javadoc 里:**方法名暗示 volatile 内存效应,实际却是 plain(无内存序)语义**。注意它调的是 `weakCompareAndSetIntPlain`——"Plain"。JSR-133 语义下 CAS 是 volatile 读 + volatile 写;而 plain 变体允许连内存序都省掉。官方建议用语义明确的新方法 `weakCompareAndSetPlain`(`AtomicInteger.java:168-170`)或带内存序的 `weakCompareAndSetVolatile`(`AtomicInteger.java:517-519`)。

而 `Unsafe` 层的 weak 变体(`Unsafe.java:1385-1410`)全部直接委托 `compareAndSetInt`:

```java
// Unsafe.java:1405-1410(截取核心,逐字)
@HotSpotIntrinsicCandidate
public final boolean weakCompareAndSetInt(Object o, long offset,
                                          int expected,
                                          int x) {
    return compareAndSetInt(o, offset, expected, x);
}
```

Javadoc 说 weak 变体"可能"虚假失败(Possibly atomically sets)——**规范允许,但 x86 的 `lock cmpxchg` 实现不会**。所以在 JDK11 里,weak 和 strong 在 x86 上是同一指令;weak 的"弱"只在规范层面(允许假失败、允许弱内存序)。性能差异的讨论要谨慎: 真正的语义差异在 plain/opaque/acquire/release 的内存序档位,不在 weak/strong。

### 2.4 JDK9+ 的内存序变体矩阵

JDK9 起 AtomicInteger 补齐了一整套显式内存序操作(`AtomicInteger.java:389` 注释 "// jdk9"):

| 操作 | 内存语义 | 源码 |
|------|---------|------|
| `getPlain` / `setPlain` | plain(无内存序,相当于普通字段) | `AtomicInteger.java:398` / `:410` |
| `getOpaque` / `setOpaque` | opaque(一致有序但不保证全序) | `AtomicInteger.java:421` / `:432` |
| `getAcquire` / `setRelease` | acquire / release(读写配对) | `AtomicInteger.java:443` / `:454` |
| `get` / `set` | volatile | `AtomicInteger.java:87` / `:97` |
| `compareAndExchange` | 返回 witness 值的 CAS(成功失败都返回实际值) | `AtomicInteger.java:470` |
| `weakCompareAndSetVolatile` | 允许假失败的 volatile CAS | `AtomicInteger.java:517` |

这套档位参照 C11 的 `memory_order` 语义设计,Java 侧由 `VarHandle` 定义、AtomicInteger 逐个暴露。**普通业务用 get/set/compareAndSet 就够,其余是高性能/底层库的精细控制**——不需要记全,知道"存在 + 去哪找"即可。

与 §1.3 的 `putIntRelease` 一样,JDK11 里这些变体在 Java 层**全部委托 volatile 版本**——`getIntAcquire`(`Unsafe.java:2071-2073`)、`getIntOpaque`(`Unsafe.java:2191-2193`)都是 `return getIntVolatile(o, offset);` 一行。内存序的差异靠 `@HotSpotIntrinsicCandidate` 在 JIT 层按档位生成不同机器指令(或屏障)来兑现,这也是 plain/opaque 变体存在的意义: 给 JIT 更多松弛空间。

关键设计(斜体):*CAS 在工程上有三种用途: ① 无锁更新——成功即完事(计数器);② CAS 循环——失败重试直到成功(§3 的核心);③ 一次性状态切换——compareAndSet 当"抢占标志"用(AQS 的 state 就是这么抢的,域 12)。面试"compareAndSet vs weakCompareAndSet": 强版本语义完整、绝不假失败;weak 允许假失败、适合循环(反正失败就重试);JDK11 里还要补一刀——原版 weakCompareAndSet 已弃用,因为名字骗人,实际是 plain 语义。*

跨层标注: [内部卷: 05-cpu-primitives 01——`lock cmpxchg` 为什么贵: 不是指令本身,是它让其他 CPU 的 cache line 全部失效;CAS 的 Acquire/Release 变体在 JVM 侧如何落屏障]

## 3. "getAndIncrement 怎么实现？" — CAS 循环

### 3.1 又是委托:Unsafe 的 do-while

`count.getAndIncrement()` 也没有"原子自增指令",它是一次 CAS 循环(`AtomicInteger.java:180-182` → `Unsafe.java:2333-2340`):

```java
// AtomicInteger.java:180-182(截取核心,逐字)
public final int getAndIncrement() {
    return U.getAndAddInt(this, VALUE, 1);
}
```

```java
// Unsafe.java:2333-2340(截取核心,逐字)
@HotSpotIntrinsicCandidate
public final int getAndAddInt(Object o, long offset, int delta) {
    int v;
    do {
        v = getIntVolatile(o, offset);
    } while (!weakCompareAndSetInt(o, offset, v, v + delta));
    return v;
}
```

三步循环:

1. **读旧值**: `v = getIntVolatile(o, offset)`——volatile 读当前值
2. **CAS 尝试**: `weakCompareAndSetInt(o, offset, v, v + delta)`——期望值 = 刚读到的 `v`,新值 = `v + delta`
3. **失败重试**: 返回 false 说明读与写之间别人改过了,`do-while` 循环回第一步重读

这是"乐观并发"的标准形态:**假设冲突少,先干再验证,冲突了重来**——没有锁、没有上下文切换、没有阻塞。`getAndSetInt`(`Unsafe.java:2569-2575`)、`getAndUpdate` 全是一个模板。

### 3.2 兄弟方法的算术细节

`incrementAndGet` 不是另一个循环,而是**在 getAndAdd 的返回值上 +1**(`AtomicInteger.java:215-217`):

```java
// AtomicInteger.java:215-217(截取核心,逐字)
public final int incrementAndGet() {
    return U.getAndAddInt(this, VALUE, 1) + 1;
}
```

`getAndAddInt` 返回旧值,加 1 就是新值——**同一个原子操作,两个 API 只是返回值的算术差**。`addAndGet`、`decrementAndGet` 同理。

### 3.3 函数式版本:getAndUpdate 的 CAS 循环

`getAndUpdate`(JDK8+,`AtomicInteger.java:253-262`)把"固定 +delta"换成任意函数:

```java
// AtomicInteger.java:253-262(截取核心,逐字)
public final int getAndUpdate(IntUnaryOperator updateFunction) {
    int prev = get(), next = 0;
    for (boolean haveNext = false;;) {
        if (!haveNext)
            next = updateFunction.applyAsInt(prev);
        if (weakCompareAndSetVolatile(prev, next))
            return prev;
        haveNext = (prev == (prev = get()));
    }
}
```

多了一个优化: **`haveNext` 缓存**——CAS 失败后重新读 `prev`(`prev = get()`),如果新 `prev` 和旧的一样,说明"值没变过、只是我 CAS 时机不对"(或者恰好绕回了原值),`next` 不用重算;只有真的变了才重新执行 `updateFunction`。这是函数式 CAS 循环的标准写法,值得背下来: 函数要**无副作用**——CAS 可能重试多次,函数会被重复执行。

关键设计(斜体):*CAS 循环 = 无锁算法的通用模板——AtomicLong、ConcurrentHashMap 的计数、AQS 的 state 更新全是同一模式。代价: 高竞争下所有线程抢同一个 value,CAS 大量失败重试——**自旋烧 CPU 但无上下文切换**,与 synchronized(切换上下文但沉睡)是两个极端。面试手写 `while (!cas(...)) {}` 是基本功;再问一句"高并发下 AtomicLong 为什么慢",答出"单点争抢,预判 LongAdder 分片"就到下一篇了。*

## 4. "ABA 问题" — 引用原子的专属陷阱

### 4.1 CAS 只验证"值",不验证"没变过"

面试连环问的第三关: "CAS 有什么问题?"——**ABA**。设线程 A 读到值 A,准备 CAS;期间线程 B 把值改成 B,又改回 A;A 的 CAS 用期望值 A 去比,命中,成功。**值确实等于 A,但状态已经沧海桑田**——CAS 只验证"现在等于期望",不验证"中间没被碰过"。

### 4.2 什么时候致命,什么时候无碍

| 场景 | ABA 影响 |
|------|---------|
| 计数器(count.getAndIncrement()) | **无碍**: 值相同 = 结果相同,中间过程不关心 |
| 引用替换(对象被换走又换回) | **致命**: 期间别人对旧对象做的操作全部被"掩盖" |
| 无锁链表/栈(pop 时 CAS 头部指针) | **致命**: 节点被复用的经典事故——A 读到头节点 n,pop 出去;n 被 B 放回链表;A 的 CAS 以为"头没变"成功,实际操作的是已被复用的旧节点 |

解决: 给"值"配一个"版本号"——`AtomicStampedReference` 把"引用 + 版本戳"打包成一个原子对,CAS 时两者一起比;`AtomicMarkableReference` 用布尔标记(比如"已删除")。版本戳递增一次,ABA 就变成"A-1 → B-2 → A-3",期望的 A-1 对不上 A-3。这两个类的完整解剖在域 13 后文(引用原子与 FieldUpdater)。

关键设计(斜体):*ABA 的严重性取决于语义——计数器无碍,链式结构致命。判断口诀: CAS 成功后是否"使用/复用"了旧值指向的东西?用,就必须版本化。面试答"AtomicInteger 不需要担心 ABA"是对的——int 值相同就是相同;答出"引用场景用 AtomicStampedReference"是完整答案。*

## 5. 同族兄弟:Long/Boolean/Reference 的三个差异

AtomicInteger 不是孤例,同一目录(18 个文件)里按"值类型"复制了整套 API。三个值得记住的差异:

### 5.1 AtomicLong:64 位 CAS 的平台检查

`AtomicLong` 多一处静态初始化(`AtomicLong.java:63-69`):

```java
// AtomicLong.java:63-69(截取核心,逐字)
static final boolean VM_SUPPORTS_LONG_CAS = VMSupportsCS8();

/**
 * Returns whether underlying JVM supports lockless CompareAndSet
 * for longs. Called only once and cached in VM_SUPPORTS_LONG_CAS.
 */
private static native boolean VMSupportsCS8();
```

`VMSupportsCS8`(Compare-and-Swap 8 bytes)是 native——**检查当前 JVM/平台是否支持无锁的 64 位 CAS**。Javadoc 的说明值得原文记下: 不支持时,intrinsic 的 `compareAndSetLong` 仍然能工作,但**某些构造要在 Java 层处理,以避免锁到用户可见的锁**——即 JVM 可能退化为带锁实现,而这个标志让底层库提前知道、选择不同的算法路径。`AtomicInteger` 不需要——int 的 CAS 处处原生。

### 5.2 AtomicBoolean:用 int 装 bool

```java
// AtomicBoolean.java:53-63(截取核心,逐字)
private static final VarHandle VALUE;
static {
    try {
        MethodHandles.Lookup l = MethodHandles.lookup();
        VALUE = l.findVarHandle(AtomicBoolean.class, "value", int.class);
    } catch (ReflectiveOperationException e) {
        throw new ExceptionInInitializerError(e);
    }
}

private volatile int value;
```

boolean 没有 CAS 指令,AtomicBoolean 用 **int 0/1 表示真假**——`compareAndSet`(`AtomicBoolean.java:100-104`)把参数转成 int 再比较:

```java
// AtomicBoolean.java:100-104(截取核心,逐字)
public final boolean compareAndSet(boolean expectedValue, boolean newValue) {
    return VALUE.compareAndSet(this,
                               (expectedValue ? 1 : 0),
                               (newValue ? 1 : 0));
}
```

### 5.3 AtomicReference:为什么它是 VarHandle,Integer 却是 Unsafe

注意上面代码块里的 `VALUE`——是 **`VarHandle`**(`MethodHandles.lookup().findVarHandle`,`AtomicBoolean.java:53-57`),不是 Unsafe 偏移!`AtomicReference`(`AtomicReference.java:53-63`)、`AtomicBoolean`、数组版 `AtomicIntegerArray`(`AtomicIntegerArray.java:52-53` 的 `arrayElementVarHandle`)在 JDK9+ 全改用 VarHandle——**除了 AtomicInteger 和 AtomicLong**。原因就是 §1.1 那段注释: "unresolved cyclic startup dependencies"(`AtomicInteger.java:57-60`)——**启动期循环依赖**: `MethodHandles.lookup().findVarHandle` 的初始化链在启动早期尚未就绪,而 AtomicInteger/Long 太核心、被太早使用,只能退回最底层的 Unsafe。VarHandle 与 Unsafe 是同一套内存操作的两个门面,面试能说出这个"为什么 Integer 特殊"的细节,比背十遍 API 有用。

关键设计(斜体):*同族三姊妹的底座演进史: 老式 Unsafe 偏移(AtomicInteger/Long,启动依赖所迫)→ 新式 VarHandle(AtomicReference/Boolean/数组版,JDK9 推荐门面)。面试"AtomicInteger 为什么不用 VarHandle": 答出启动循环依赖 + 注释原文,是冷门但真实的加分点。*

跨层标注: [内部卷: 05-cpu-primitives 01——`lock cmpxchg` 的原子性由缓存一致性协议保证;C++ 侧 `Atomic::cmpxchg` 是 JVM 所有并发的统一入口(域 12 AQS 展开)]

## 核心悬念

单点 CAS 的瓶颈在 §3 已埋下: **所有线程抢同一个 value,高并发下 CAS 大量失败自旋**——LongAdder 为什么比 AtomicLong 快?它把"一个计数器"拆成"多个 Cell",每个线程打自己的格,最后求和——那"伪共享"又是什么?`@Contended` 注解怎么防止缓存行抖动?下一篇拆开 Striped64 与 LongAdder。

> → [13-atomic/02 — Striped64 与 LongAdder](02-striped64-longadder.md)
