# Striped64 与 LongAdder：为什么它不是更强的 AtomicLong，而是把热点拆开

> 本文基于 JDK 11 `Striped64` 与 `LongAdder` 源码。重点讨论 `base` / `cells` / `cellsBusy`、`Cell`、`longAccumulate()`、`sum()` 与 `@Contended`；LongAccumulator、DoubleAdder 与引用原子类放到相关后续篇章。
> **前置依赖**：[AtomicInteger 与 CAS](01-atomicinteger-cas.md)
> **后续**：[引用原子与 FieldUpdater](03-reference-updater.md)

## 上一篇解决了“怎么原子地改一个数”，这一篇解决“大家都来改同一个数时为什么会卡死在一点上”

上一章里，`AtomicInteger` 已经回答了一个关键问题：如何把“读-改-写”粘成一次 CAS 原子更新。

但它也留下了另一个更偏性能的问题：**如果所有线程都围着同一个共享值做 CAS，会发生什么？**

答案是：即使没有锁，没有阻塞，线程仍然会在同一个内存位置上高频碰撞。一个线程刚读到旧值，另一个线程就先一步更新了它，于是第一个线程 CAS 失败，只能重读再试。竞争越激烈，失败重试越多，CPU 时间就越多地烧在“争这个点”上。

`LongAdder` 解决的不是“让单次 CAS 更强”，而是“别让所有线程再盯着同一个点打”。它的核心思路可以先压成一句话：

```text
无竞争时
   → 还是像 AtomicLong 一样更新一个 base

一旦竞争出现
   → 把计数分散到多个 Cell 槽位
   → 让不同线程大概率各写各格
```

所以它不是更严格的原子计数器，而是一个**把写热点拆开、把读取改成聚合求和**的吞吐优化结构。

## 一、Striped64 的本体：不是“一个 long”，而是 `base + cells + cellsBusy`

### 三个字段就是 LongAdder 的全部骨架

JDK 11 的 `Striped64` 直接把核心状态列得非常干净：

```java
// Striped64.java:152-169
/** Number of CPUS, to place bound on table size */
static final int NCPU = Runtime.getRuntime().availableProcessors();

/**
 * Table of cells. When non-null, size is a power of 2.
 */
transient volatile Cell[] cells;

/**
 * Base value, used mainly when there is no contention, but also as
 * a fallback during table initialization races. Updated via CAS.
 */
transient volatile long base;

/**
 * Spinlock (locked via CAS) used when resizing and/or creating Cells.
 */
transient volatile int cellsBusy;
```

如果把这三个字段翻译成更接近业务理解的话：

- `base`：低竞争时的单点值；
- `cells`：高竞争时的分片槽位数组；
- `cellsBusy`：只在初始化/扩容/挂新槽时抢一下的短期自旋锁。

也就是说，LongAdder 并不是一开始就造出很多格子，而是分阶段升级：

```text
起步
   → 只有 base

第一次发生明显竞争
   → 初始化 cells

后续竞争继续加剧
   → 扩大 cells 数组
```

### Doug Lea 的类注释其实已经写明了整套策略

`Striped64` 的类注释非常像设计文档，关键几句值得直接读：

```java
// Striped64.java:52-116
 * This class maintains a lazily-initialized table of atomically
 * updated variables, plus an extra "base" field. The table size
 * is a power of two. Indexing uses masked per-thread hash codes.
 * Nearly all declarations in this class are package-private,
 * accessed directly by subclasses.
 *
 * Table entries are of class Cell; a variant of AtomicLong padded
 * (via @Contended) to reduce cache contention.
 *
 * In part because Cells are relatively large, we avoid creating
 * them until they are needed.  When there is no contention, all
 * updates are made to the base field.  Upon first contention (a
 * failed CAS on base update), the table is initialized to size 2.
 * The table size is doubled upon further contention until
 * reaching the nearest power of two greater than or equal to the
 * number of CPUS. Table slots remain empty (null) until they are
 * needed.
 *
 * A single spinlock ("cellsBusy") is used for initializing and
 * resizing the table, as well as populating slots with new Cells.
```

这几句已经把设计哲学讲透了：

- 默认不浪费空间，只有真的竞争了才分片；
- 分片不是无限长大，而是有 `NCPU` 上限；
- 结构调整不走重量级锁，只在短暂改表结构时用一个 CAS 自旋锁护一下。

所以 LongAdder 不是“为了高并发，预先建一堆格子”，而是**按争用程度渐进式地从单点数升级成分片数列**。

## 二、Cell 为什么像“迷你 AtomicLong”，而且必须单独做缓存隔离

### 每个格子本质上就是一个可以 CAS 的 long 槽位

```java
// Striped64.java:118-149
/**
 * Padded variant of AtomicLong supporting only raw accesses plus CAS.
 */
@jdk.internal.vm.annotation.Contended static final class Cell {
    volatile long value;
    Cell(long x) { value = x; }
    final boolean cas(long cmp, long val) {
        return VALUE.compareAndSet(this, cmp, val);
    }
    final void reset() {
        VALUE.setVolatile(this, 0L);
    }
    final void reset(long identity) {
        VALUE.setVolatile(this, identity);
    }
    final long getAndSet(long val) {
        return (long)VALUE.getAndSet(this, val);
    }
```

这段代码非常值得停一下，因为它几乎就是“把一个 AtomicLong 缩到最小能工作的程度”：

- 一个 `volatile long value`；
- 一个 CAS；
- 几个重置/交换工具方法。

所以 `LongAdder` 所谓的“分片”，本质上就是：**把一个会争抢的共享 long，拆成多个可以各自 CAS 的小槽位。**

### `@Contended` 不是装饰，而是避免伪共享的关键一层

很多人学 LongAdder 时只记住“多个 Cell 分流竞争”，却忽略了类注释对缓存行问题的解释。JDK 11 明说：Cell 之所以要加 `@Contended`，是因为数组里的多个原子槽位物理上很容易相邻，从而共享同一缓存行。

```java
// Striped64.java:59-66
 * Table entries are of class Cell; a variant of AtomicLong padded
 * (via @Contended) to reduce cache contention. Padding is
 * overkill for most Atomics because they are usually irregularly
 * scattered in memory and thus don't interfere much with each
 * other. But Atomic objects residing in arrays will tend to be
 * placed adjacent to each other, and so will most often share
 * cache lines (with a huge negative performance impact) without
 * this precaution.
```

这段话其实在讲一个非常关键的性能坑：**伪共享**。

逻辑上，线程 A 和线程 B 可能在写不同的 Cell；但如果这两个 Cell 恰好落在同一个 CPU 缓存行里，那么一个核心写自己的 Cell 时，仍然会导致整个缓存行对别的核心失效，另一个线程也要被迫重新取这一整行。

所以 LongAdder 不是只靠“分片”就够了，它还要继续解决“多个分片别再因为物理相邻互相拖累”的问题。`@Contended` 就是在对象布局层给每个 Cell 做隔离。

也就是说：

```text
分片
   → 解决逻辑上的同点竞争

@Contended
   → 解决物理上的同缓存行竞争
```

这两层缺一不可。

## 三、`add()` 的真正路径：先赌不竞争，再升级到分片，再走结构调整兜底

### LongAdder.add 并没有一上来就进复杂路径

JDK 11 的 `LongAdder.add` 其实非常短：

```java
// LongAdder.java:80-94
/**
 * Adds the given value.
 */
public void add(long x) {
    Cell[] cs; long b, v; int m; Cell c;
    if ((cs = cells) != null || !casBase(b = base, b + x)) {
        boolean uncontended = true;
        if (cs == null || (m = cs.length - 1) < 0 ||
            (c = cs[getProbe() & m]) == null ||
            !(uncontended = c.cas(v = c.value, v + x)))
            longAccumulate(x, null, uncontended);
    }
}
```

看起来只有一层 if，但它隐含了一整套性能阶梯：

#### 第一级：还没建 `cells`，先尝试直接 CAS `base`

条件 `cells == null` 且 `casBase` 成功时，整个更新就结束了。这条路径本质上和 AtomicLong 的单点 CAS 非常接近，是 LongAdder 在低竞争下保持轻量的关键。

#### 第二级：如果已经有 `cells`，或者 `base` 的 CAS 失败，就走分片槽位

一旦 `cells` 已存在，逻辑会短路进分片路径，用当前线程的 probe 去选格子：

```text
c = cs[getProbe() & m]
```

如果命中自己的 Cell 且 CAS 成功，这条更新就完成。此时各线程大概率只在自己的槽位上竞争，而不是都去碰 `base`。

#### 第三级：只有当格子不存在、格子 CAS 失败、或表还没建好时，才进 `longAccumulate`

也就是说，真正最复杂的那段结构调整逻辑，并不是每次更新都走。它只在分片结构还没稳定好、或者竞争正在升级时兜底。

这就是为什么 LongAdder 的性能模型不能简单理解成“它内部很复杂，所以肯定更慢”。恰恰相反，它把复杂逻辑放在低频路径上，把大多数更新压回到两个高频快路径里：

```text
无竞争
   → CAS base

中等竞争
   → CAS 自己的 Cell

结构不稳定/竞争继续升级
   → longAccumulate 负责建表、挂槽、扩容、重试
```

## 四、`longAccumulate()` 到底在处理什么问题

### 第一步：如果线程 probe 还没初始化，先补上它

```java
// Striped64.java:228-235
final void longAccumulate(long x, LongBinaryOperator fn,
                          boolean wasUncontended) {
    int h;
    if ((h = getProbe()) == 0) {
        ThreadLocalRandom.current(); // force initialization
        h = getProbe();
        wasUncontended = true;
    }
```

这说明线程在第一次真正参与分片竞争前，可能还没有可用的 probe。LongAdder 借用了 `ThreadLocalRandom` 的线程 probe 字段，把它当成每个线程的槽位哈希。

### 第二步：槽位为空时，尝试挂一个新 Cell

```java
// Striped64.java:240-259
if ((c = cs[(n - 1) & h]) == null) {
    if (cellsBusy == 0) {       // Try to attach new Cell
        Cell r = new Cell(x);   // Optimistically create
        if (cellsBusy == 0 && casCellsBusy()) {
            try {               // Recheck under lock
                Cell[] rs; int m, j;
                if ((rs = cells) != null &&
                    (m = rs.length) > 0 &&
                    rs[j = (m - 1) & h] == null) {
                    rs[j] = r;
                    break done;
                }
            } finally {
                cellsBusy = 0;
            }
            continue;
        }
    }
    collide = false;
}
```

这里能看到 `cellsBusy` 的真实角色：它不是日常更新路径上的大锁，而只是“改表结构时，先抢一下门把手”的自旋锁。

### 第三步：如果槽位已存在，就继续尝试 CAS 自己的格子

```java
// Striped64.java:260-279
else if (!wasUncontended)
    wasUncontended = true;
else if (c.cas(v = c.value,
               (fn == null) ? v + x : fn.applyAsLong(v, x)))
    break;
else if (n >= NCPU || cells != cs)
    collide = false;
else if (!collide)
    collide = true;
else if (cellsBusy == 0 && casCellsBusy()) {
    try {
        if (cells == cs)
            cells = Arrays.copyOf(cs, n << 1);
    } finally {
        cellsBusy = 0;
    }
    collide = false;
    continue;
}
h = advanceProbe(h);
```

这段就是 LongAdder 真正的竞争管理核心：

- 槽位 CAS 成功就结束；
- 一次失败还不急着扩容，先记一次 `collide`；
- 连续冲突才考虑扩容；
- 扩不了或不该扩时，换 probe，去尝试别的位置。

这其实很像一个不断调整的分流系统：如果某个格子太挤，先换 lane；如果整体都挤，再扩更多 lane。

### 第四步：如果 `cells` 还没初始化，就先建一个 2 槽表

```java
// Striped64.java:281-292
else if (cellsBusy == 0 && cells == cs && casCellsBusy()) {
    try {                           // Initialize table
        if (cells == cs) {
            Cell[] rs = new Cell[2];
            rs[h & 1] = new Cell(x);
            cells = rs;
            break done;
        }
    } finally {
        cellsBusy = 0;
    }
}
```

这就是 LongAdder 从“单点 base”升级成“分片数组”的起点：第一次明确竞争出现后，表才真正被创建出来，而且初始只有 2 个槽位，不会过度分配。

### 第五步：如果结构调整都抢不到，就退回再碰一次 `base`

```java
// Striped64.java:293-296
else if (casBase(v = base,
                 (fn == null) ? v + x : fn.applyAsLong(v, x)))
    break done;
```

这行代码很容易被忽略，但它很重要：LongAdder 并不是“cells 一旦存在，base 就永远退休”。在结构调整竞争期间，退回 base 依然是一个兜底选项，目的是确保更新能够尽量收敛完成，而不是卡死在“必须先把分片结构调整好”。

## 五、为什么 `cells` 不会无限扩容：它受 CPU 核数上限约束

### 分片不是越多越好，超过并行度就只是在浪费空间

Doug Lea 在类注释里已经讲过：表会在竞争升级时翻倍，直到达到“最近的、不小于 CPU 数的 2 的幂”。

```java
// Striped64.java:68-74
 * In part because Cells are relatively large, we avoid creating
 * them until they are needed.  When there is no contention, all
 * updates are made to the base field.  Upon first contention (a
 * failed CAS on base update), the table is initialized to size 2.
 * The table size is doubled upon further contention until
 * reaching the nearest power of two greater than or equal to the
 * number of CPUS. Table slots remain empty (null) until they are
```

对应字段就是：

```java
// Striped64.java:152-153
/** Number of CPUS, to place bound on table size */
static final int NCPU = Runtime.getRuntime().availableProcessors();
```

这背后的直觉非常清楚：LongAdder 的分片目标不是“理论上给每个线程一个格子”，而是“给系统并行写入留出足够多的独立槽位”。当槽位数已经接近 CPU 并行执行能力时，再继续扩大表，收益会迅速下降，空间成本却继续上涨。

所以 LongAdder 并不是无限扩表换吞吐，而是到一定程度就停，之后主要靠 probe 变化和随机化去避开持续冲突。

## 六、`sum()` 为什么注定是弱一致，而这恰恰是它适合统计场景的原因

### 读取逻辑非常朴素：把 `base + cells` 全部加起来

```java
// LongAdder.java:110-128
/**
 * Returns the current sum.  The returned value is <em>NOT</em> an
 * atomic snapshot; invocation in the absence of concurrent
 * updates returns an accurate result, but concurrent updates that
 * occur while the sum is being calculated might not be
 * incorporated.
 *
 * @return the sum
 */
public long sum() {
    Cell[] cs = cells;
    long sum = base;
    if (cs != null) {
        for (Cell c : cs)
            if (c != null)
                sum += c.value;
    }
    return sum;
}
```

这段代码没有锁、没有冻结写入、没有把所有线程停下来等它算。它只是：

1. 先读 base；
2. 再把每个非空 Cell 的值加进来。

### 所以它不可能是严格快照

只要你在遍历 `cells` 的过程中，别的线程还在更新某个 Cell，那么这次 `sum()` 读到的是“一个正在变化中的拼接结果”。JDK 文档已经直接写明：并发更新时，正在发生的某些更新可能来不及被纳入。

这就是 LongAdder 和 AtomicLong 的本质取舍：

```text
AtomicLong
   → 单点值
   → 每次读都精确
   → 高竞争写会在一个点上拥堵

LongAdder
   → 分片写
   → 写吞吐更高
   → 读时只能做弱一致聚合
```

所以 LongAdder 非常适合：

- 统计请求数；
- 监控指标；
- 频次计数；
- 对读取精确瞬时值没有严格同步要求的聚合场景。

但它不适合那种“读到的值本身要立刻参与同步控制判定”的场景。比如如果你要靠这个值精确控制某个阈值上的竞态切换，单纯的 LongAdder 就未必合适。

## 七、LongAdder 为什么不是“更强原子性”，而是“更高写吞吐”

到这里必须把最容易混淆的一点说死。

LongAdder 并没有让“一个共享数值的原子语义”变得更严格。恰恰相反，它是在放宽读取一致性要求，换取写入时更少的热点争抢。

所以它和 AtomicLong 的关系，不是：

```text
AtomicLong 弱
LongAdder 强
```

而是：

```text
AtomicLong
   → 精确单点语义
   → 适合读值本身就要被严格依赖的场景

LongAdder
   → 分片写、聚合读
   → 适合高竞争统计与指标收集
```

这也是为什么 `LongAdder` 的类注释会明确说：它通常优于 AtomicLong 的场景，是“多个线程更新一个公共和，用于统计，而不是细粒度同步控制”。

```java
// LongAdder.java:40-54
 * One or more variables that together maintain an initially zero
 * {@code long} sum.  When updates (method {@link #add}) are contended
 * across threads, the set of variables may grow dynamically to reduce
 * contention. Method {@link #sum} (or, equivalently, {@link
 * #longValue}) returns the current total combined across the
 * variables maintaining the sum.
 *
 * <p>This class is usually preferable to {@link AtomicLong} when
 * multiple threads update a common sum that is used for purposes such
 * as collecting statistics, not for fine-grained synchronization
 * control.  Under low update contention, the two classes have similar
 * characteristics. But under high contention, expected throughput of
 * this class is significantly higher, at the expense of higher space
 * consumption.
```

这段话基本就是整篇文章的官方总结。

## 五个最容易混掉的边界：LongAdder 不是更强 AtomicLong，分片不是预分满表，Cell 不是普通数组槽，sum 不是原子快照，`@Contended` 也不是装饰注解

第一，`LongAdder` 不是更强的 `AtomicLong`。它优化的是高竞争写吞吐，而不是单值读取语义；如果你真正依赖的是“每次读到的都是一个严格单点值”，LongAdder 反而不是默认答案。

第二，分片不是预分满表。`cells` 不会一上来就铺满 CPU 数量的格子，而是从 `base` 起步，在竞争真的出现后才懒初始化、再按碰撞程度逐步扩容。

第三，`Cell` 不是普通数组槽。它不是随便塞在数组里的 long，而是带独立 CAS 能力、并经过布局隔离的小型原子槽位；LongAdder 的分流既依赖逻辑分片，也依赖物理隔离。

第四，`sum()` 不是原子快照。它做的是把当下可见的 `base + cells` 聚合起来，遍历过程中别的线程仍可继续更新；所以结果适合统计和监控，不适合拿来做严格同步判定。

第五，`@Contended` 也不是装饰注解。它在这里承担的是避免多个 Cell 因物理相邻而共享缓存行、重新互相拖累的职责；没有这层隔离，逻辑上的分片仍可能在硬件层重新碰撞。

把这五条边界记稳，LongAdder 就不会再被误解成“AtomicLong 的性能增强版”这么简单。它真正想讲的是两层拆热点：先在逻辑上把单点写分散到多个 Cell，再在物理上尽量让这些 Cell 别落进同一缓存行；而读路径则明确接受聚合弱一致，换取写路径的高吞吐。

## 收网：LongAdder 不是把 CAS 做得更厉害，而是把所有线程别再挤在一个点上

现在回到这篇文章的起点：为什么 AtomicLong 在高并发下会失速？

因为所有线程都在争同一个共享值，即使没有锁，也会因为 CAS 失败重试在同一个点上高频碰撞。

LongAdder 的解决方法不是“让那个点更快”，而是：

- 无竞争时先维持单点 base，别白白分配结构；
- 一旦竞争出现，就把写入分散到多个 Cell；
- 再用 `@Contended` 防止多个 Cell 因为缓存行相邻重新互相拖累；
- 读取时放弃强一致快照，只做 `base + cells` 的聚合求和。

把整篇压成一张图，就是：

```text
低竞争
   → CAS base

出现竞争
   → 初始化 cells[2]
   → 线程按 probe 命中各自 Cell
   → 冲突继续时扩容 cells
   → Cell 用 @Contended 避免伪共享

读取
   → sum() 聚合 base + 所有 Cell
   → 结果弱一致
```

实际使用时，先记住四条：

1. **LongAdder 解决的是高竞争写吞吐，不是更强的单值精确语义。**
2. **它的核心不是“有很多格子”本身，而是“让不同线程尽量别写同一个格子”。**
3. **`@Contended` 的必要性来自多个 Cell 会物理相邻，进而产生伪共享。**
4. **`sum()` 不是原子快照，所以适合统计，不适合把读取值当成严格同步条件。**

下一篇进入另一条原子更新路线：当你要更新的不是一个数，而是一个对象引用，或者一个普通对象里的某个字段，该怎么把 CAS 套上去——引用原子类与 FieldUpdater。

> → 下一篇：[引用原子与 FieldUpdater](03-reference-updater.md)
