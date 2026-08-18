# 02. Striped64 与 LongAdder — 分片计数、伪共享、弱一致求和

> **前置依赖**: [13-atomic/01 — AtomicInteger 与 CAS 封装](01-atomicinteger-cas.md)(CAS 循环与内存语义)、[11-thread-threadlocal/03 — ThreadLocalRandom](../11-thread-threadlocal/03-exception-random.md)(probe 探针与 GAMMA 种子)
> → **后续**:[13-atomic/03 — 引用原子与 FieldUpdater](03-reference-updater.md)
> 关联: 域 32 Unsafe(CAS 原语);内部卷 05-cpu-primitives(MESI 与缓存一致性)、06-oops(对象布局与字段填充)

## 一个计数器,怎么扛住百万 QPS

上一篇结尾埋了个问题: AtomicLong 高竞争下 CAS 大量失败、自旋烧 CPU。那生产上的计数器(限流、统计、监控)怎么做的?面试官的问题是 "LongAdder 为什么比 AtomicLong 快"——答案是四个字: **分片计数**。这篇拆开 Striped64 与 LongAdder: 一个"数"怎么拆成"一组格子",格子之间怎么避免互相拖累(伪共享),以及为什么 sum 的结果是"弱一致"的。

## 1. "LongAdder 里有什么？" — base + Cell 数组

### 1.1 一个数,拆成一组格子

`LongAdder`(`LongAdder.java:71`)extends `Striped64`,所有机制都在父类。Striped64 的字段只有三个(`Striped64.java:152-169`):

```java
// Striped64.java:152-169(截取核心,逐字)
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

- **`base`**(`Striped64.java:164`):无竞争时的单点——所有线程不打架时,累加只碰这一个数,和 AtomicLong 一样快
- **`cells`**(`Striped64.java:158`):**分片数组**——竞争出现后,把计数器拆成 2、4、8……个格子,不同线程写不同格子
- **`cellsBusy`**(`Striped64.java:169`):扩容/初始化的**自旋锁**(0=空闲,1=被占),用 `casCellsBusy`(`Striped64.java:191`)抢
- **`NCPU`**(`Striped64.java:153`):CPU 核数,表长的上限——格子数超过核数没有意义,后面 §2.4 细讲

三个字段全是 `transient volatile`——序列化交给 LongAdder 的 `SerializationProxy`(`LongAdder.java:215`),volatile 保证跨线程可见。

### 1.2 Cell:加了 @Contended 的"迷你 AtomicLong"

格子本身是内嵌类 `Cell`(`Striped64.java:124-129`):

```java
// Striped64.java:124-129(截取核心,逐字)
@jdk.internal.vm.annotation.Contended static final class Cell {
    volatile long value;
    Cell(long x) { value = x; }
    final boolean cas(long cmp, long val) {
        return VALUE.compareAndSet(this, cmp, val);
    }
```

`Cell` 就是"只有 value 字段 + CAS"的迷你 AtomicLong——但多了类级别的 `@jdk.internal.vm.annotation.Contended` 注解。**这是全篇最重要的一行注解**,§3 专门讲。注意 `VALUE` 是 `VarHandle`(`Striped64.java:141-149` 的 `findVarHandle(Cell.class, "value", long.class)`),不是 Unsafe 偏移——Striped64 族能安全初始化 VarHandle(静态块在 386-407),没有 AtomicInteger 那种启动期循环依赖,所以用 JDK9+ 推荐的 VarHandle 门面。

### 1.3 类注释:Doug Lea 的设计文档

`Striped64.java:52-116` 的类注释值得读原文——它是 Doug Lea 写的行为规格。核心约定三条:

1. **表长恒为 2 的幂**,下标用 per-thread 哈希掩码(`(n - 1) & h`)(`Striped64.java:55-56`)
2. **无竞争时全走 base**;第一次争用(base 的 CAS 失败)才把表初始化为 size 2(`Striped64.java:69-71`)
3. **之后每次进一步争用,表翻倍**,直到达到 >= CPU 数的最近 2 的幂(`Striped64.java:72-74`)——这就是 `NCPU` 的来历

还解释了为什么 Cell 需要 @Contended 而普通原子类不需要(`Striped64.java:59-66`): 普通 Atomic 对象在堆里散布、互不相邻;但 **Cell 们住在数组里、必然相邻,共享缓存行**——不加 padding 会有巨大的性能损失。这个机制 §3 展开。

关键设计(斜体):*"分片"= 把单个计数器拆成多个可累加单元——不同线程按哈希落到不同 Cell,互不争抢;base 只服务低竞争场景。这是"无锁 + 无争抢"的计数方案: 锁和 CAS 解决"同一变量上的竞争",分片从根上让竞争不发生。面试"LongAdder vs AtomicLong": 读少写多、高竞争用 LongAdder(吞吐显著更高,代价是空间,`LongAdder.java:48-54` 的 Javadoc 原话);需要每次精确读(如并发控制信号量)用 AtomicLong。*

## 2. "add() 每次走什么路径？" — 性能阶梯

### 2.1 三级路径:单点 → 分片 → 兜底

`LongAdder.add`(`LongAdder.java:85-94`)整个方法只有 10 行,但暗含三级路径:

```java
// LongAdder.java:85-94(截取核心,逐字)
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

注意第一行的**短路求值**: `(cs = cells) != null || !casBase(...)`——**cells 一旦非空,casBase 根本不会执行**,直接进 if 体走分片。所以三级路径的触发条件是"表是否已存在",不是"base 是否失败":

- **第一级(单点,只在表未建时)**: `cells == null` 时试 `casBase(b = base, b + x)`——从未竞争过的 adder,一次 CAS 搞定,和 AtomicLong 一样快
- **第二级(分片,表已建时的常态)**: cells 非空 → 短路跳过 base,按当前线程的 probe 哈希选格 `cs[getProbe() & m]`,CAS 自己的 Cell。**不同线程 probe 不同,大概率落到不同格子,从此互不干扰**——这是竞争发生后的每一条 add 都走的路径
- **第三级(兜底)**: 格子还没建(`cs == null` 或 `c == null`)/CAS 又失败 → 进 `longAccumulate`(`Striped64.java:228`): 初始化/扩容/挂新 Cell/重试

`increment()`(`LongAdder.java:99`)就是 `add(1L)`,`decrement()` 就是 `add(-1L)`——没有第二个实现。

### 2.2 probe:选格子的哈希从哪来

`getProbe()`(`Striped64.java:199-201`)是选格的依据:

```java
// Striped64.java:199-201(截取核心,逐字)
static final int getProbe() {
    return (int) THREAD_PROBE.get(Thread.currentThread());
}
```

`THREAD_PROBE` 是 VarHandle,直接读 `Thread.threadLocalRandomProbe` 字段(`Thread.java:2075`)——**每个线程一个 int 探针哈希**,从 ThreadLocalRandom 借来的(注释明说 "Duplicated from ThreadLocalRandom because of packaging restrictions",`Striped64.java:196-197`)。probe 初始为 0(域 11 第 3 篇讲过 ThreadLocalRandom 的探针机制),第一次进 `longAccumulate` 时强制初始化(`Striped64.java:231-235`):

```java
// Striped64.java:228-235(截取核心,逐字)
final void longAccumulate(long x, LongBinaryOperator fn,
                          boolean wasUncontended) {
    int h;
    if ((h = getProbe()) == 0) {
        ThreadLocalRandom.current(); // force initialization
        h = getProbe();
        wasUncontended = true;
    }
```

### 2.3 longAccumulate:初始化、挂格、重试、扩容

`longAccumulate`(`Striped64.java:228-298`)是长循环,按条件分四类动作:

**① 初始化表**(`Striped64.java:281-292`):cells 还是 null 时,抢到 cellsBusy 锁后建 `new Cell[2]`,把当前线程的 `x` 放进 `h & 1` 格,`break done` 结束:

```java
// Striped64.java:281-292(截取核心,逐字)
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

**② 挂新 Cell**(`Striped64.java:240-259`):表已存在但当前线程的格子是空,且 cellsBusy 空闲 → 造一个新 Cell 塞进去。乐观创建 + 锁下复查:

```java
// Striped64.java:240-259(截取核心,逐字)
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
            continue;           // Slot is now non-empty
        }
    }
    collide = false;
}
```

**③ 重试 CAS 自己的格**(`Striped64.java:262-264`):格子非空 → `c.cas(v = c.value, v + x)`,成功即完成——add 第二级失败后在这里再试一次:

```java
// Striped64.java:262-264(截取核心,逐字)
else if (c.cas(v = c.value,
               (fn == null) ? v + x : fn.applyAsLong(v, x)))
    break;
```

**④ 扩容**(`Striped64.java:269-278`):重试 CAS 也失败且 collide 标志为 true(上一次冲突的记忆)→ 抢 cellsBusy 锁,`Arrays.copyOf(cs, n << 1)` 双倍扩容:

```java
// Striped64.java:269-278(截取核心,逐字)
else if (cellsBusy == 0 && casCellsBusy()) {
    try {
        if (cells == cs)        // Expand table unless stale
            cells = Arrays.copyOf(cs, n << 1);
    } finally {
        cellsBusy = 0;
    }
    collide = false;
    continue;                   // Retry with expanded table
}
```

### 2.4 NCPU 上限与双哈希

- **停扩条件**(`Striped64.java:265`): `else if (n >= NCPU || cells != cs) collide = false;`——**表长达到 >= NCPU 的最小 2 的幂后不再扩容**(类注释原话: "doubled upon further contention until reaching the nearest power of two greater than or equal to the number of CPUS",`Striped64.java:72-74`;格子数 ≥ 核数后,再多格子也不会更并行,反而白占内存);`cells != cs` 检测表被别的线程换过(过期快照)
- **双哈希**(`Striped64.java:279` 调 `advanceProbe`):CAS 失败后 `h = advanceProbe(h)`(`Striped64.java:208-214`)用 **Marsaglia XorShift**(`probe ^= probe << 13; >>> 17; << 5`)换一个新哈希,下轮循环换一格——注释称之为 "double hashing"(`Striped64.java:94-95`)
- **base 兜底**(`Striped64.java:293-296`):cells 还没建成、而 cellsBusy 被别的线程占着(正在初始化)时,回退 `casBase` 一把——保证方法总会收敛,不会无限循环

### 2.5 sum():弱一致求和

`sum()`(`LongAdder.java:119-128`)只有 10 行:

```java
// LongAdder.java:119-128(截取核心,逐字)
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

把 base 和所有非空 Cell 全加起来。**不是原子快照**——遍历过程中别的线程可能正在更新某个 Cell(先读后写的间隙),sum 可能漏掉正在进行的写入,所以 Javadoc 明说: 无并发更新时准确,有并发更新时"might not be incorporated"(`LongAdder.java:111-115`)。这就是**弱一致**: 每次 sum 可能缺最近几次写入,但误差有限、收敛快。

关键设计(斜体):*路径设计是"性能阶梯": 表未建时走单点 base(最快);表一旦建成,所有 add 直接走分片(次快);longAccumulate 只在格子为空或冲突的瞬间兜底(最慢、低频)——绝大多数 add 走前两档。面试讲"LongAdder 快在表建成后短路跳过 base + 分片"比只讲"分片"有细节;再补一句"sum 弱一致,不能当精确同步用"就是完整答案。*

## 3. "伪共享是什么？" — @Contended 的战场

### 3.1 两个不相干的数据,为什么互相拖慢

CPU 读内存的最小单位不是字节,是**缓存行(cache line)**——现代 x86 典型 64 字节。核心 A 改了地址 0x1000 上的数据,整个 0x1000-0x103F 缓存行被标记为 Modified,**其他核心持有同一缓存行的副本全部失效**;核心 B 要读 0x1020(恰好同行的另一个变量),触发 cache miss,从内存重载(100-200ns 级)。

问题来了: 两个 Cell 在数组里**必然相邻**,格子很小(对象头 + 一个 long 字段),**多个 Cell 挤在同一缓存行**。线程 A 反复更新自己的 Cell → 缓存行失效 → 线程 B 更新它的 Cell 时被迫重载缓存行。**A 和 B 明明写的是不同变量,却互相让对方的缓存行失效**——这就是"伪"共享: 看起来没共享,实际共享了缓存行。

跨层标注: [内部卷: 05-cpu-primitives 01——MESI 协议与 `lock` 前缀的真正代价: 每次原子操作打断其他 CPU 的 cache;伪共享是这个代价在"相邻对象"上的放大版]

### 3.2 @Contended:让 JVM 把格子隔开

`Cell` 类上的 `@jdk.internal.vm.annotation.Contended`(`Striped64.java:124`)告诉 JVM:**给这个类的对象加 padding 填充**,把它推到独立的缓存行——两个 Cell 不再共享同一行,更新互不干扰。

类注释说得明白(`Striped64.java:59-66`): 普通原子对象在堆里散布、一般不会干扰彼此,所以 padding 对它们"overkill";但**数组里的原子对象必然相邻、最常共享缓存行**,必须加这个保险。

几个使用要点:

- **JDK 内部专用**: `@Contended` 在 `jdk.internal.vm.annotation` 包,是 JDK 内部机制;第三方代码使用受 JVM 的 `RestrictContended` 开关限制
- **类级 vs 字段级**: Cell 是类级注解——整个类的字段一起隔离;字段级可以给同一对象内不同字段各自隔离
- **代价是空间**: 每个 Cell 被填充/对齐到独立缓存行,空间开销显著放大(填充宽度由 JVM 控制,一般不小于一个 64 字节缓存行)——这就是 LongAdder Javadoc 说的 "at the expense of higher space consumption"(`LongAdder.java:53-54`)

### 3.3 伪共享的检测与一般解法

面试"伪共享怎么检测/避免":

- **检测**: 性能剖析里的高 cache miss 率、单核局部性分析;经典实验是"两个线程各写一个字段,加 padding 前后吞吐对比"
- **避免**: ① 填充 padding(手动塞 64 字节的冗余字段,或 @Contended)② 数据对齐(按缓存行大小对齐结构)③ 改变访问模式(每个线程写自己的独立对象)
- **生产案例**: 日志计数器、锁的状态字段、高并发计数器数组——都是伪共享高发区

关键设计(斜体):*伪共享是"并发性能隐形杀手"——两个线程看似零共享,却因缓存行互相拖慢几个数量级。@Contended 是 JVM 级解法: 在对象布局阶段做 padding(内部卷 06-oops 的对象布局)。面试画"缓存行 + 两个 Cell"图是加分项;能说出"数组里的对象比散布的对象更需要 padding"说明读懂了 Doug Lea 的注释。*

跨层标注: [内部卷: 06-oops 01——对象头与字段对齐: 对象按 8 字节对齐、字段布局由 JVM 决定,`@Contended` 正是在布局期做 padding 隔离]

## 4. "LongAccumulator 与 Double 版" — 定制累积

### 4.1 LongAccumulator:可定制运算的分片

LongAdder 只能加法;LongAccumulator(`LongAccumulator.java:82`)把运算抽象成 `LongBinaryOperator` + identity 值:

```java
// LongAccumulator.java:94-98(截取核心,逐字)
public LongAccumulator(LongBinaryOperator accumulatorFunction,
                       long identity) {
    this.function = accumulatorFunction;
    base = this.identity = identity;
}
```

构造时**把 base 也设成 identity**(比如求最大值就用 `Long.MIN_VALUE`)。`accumulate`(`LongAccumulator.java:105-119`)与 add 同构,但多一个优化——**先算结果,结果与当前值相同就跳过 CAS**:

```java
// LongAccumulator.java:105-119(截取核心,逐字)
public void accumulate(long x) {
    Cell[] cs; long b, v, r; int m; Cell c;
    if ((cs = cells) != null
        || ((r = function.applyAsLong(b = base, x)) != b
            && !casBase(b, r))) {
        boolean uncontended = true;
        if (cs == null
            || (m = cs.length - 1) < 0
            || (c = cs[getProbe() & m]) == null
            || !(uncontended =
                 (r = function.applyAsLong(v = c.value, x)) == v
                 || c.cas(v, r)))
            longAccumulate(x, function, uncontended);
    }
}
```

`(r = fn(b, x)) != b && !casBase(b, r)`——**函数结果等于当前值就不写**(求 max 遇到更小值时典型): 少一次无谓的 CAS,在高竞争下省掉大量 cache 失效。`get()`(`LongAccumulator.java:130-139`)同样弱一致,只是把 `+` 换成 `function.applyAsLong`。

关键设计(斜体):*分片能成立的数学前提是运算**可结合且可交换**(associative and commutative)——分片后各 Cell 独立累积、最后任意顺序合并,只有满足这两个性质的运算(加法/乘法/max/min)结果才一致;减法、字符串拼接这类不可结合/交换的运算,分片结果会乱。Javadoc 要求原文就是 "associative and commutative"(`LongAccumulator.java:62-63`)。面试"为什么 Accumulator 必须可结合": 分片后合并顺序不受控,只有可结合且可交换的运算才能保证结果一致。*

### 4.2 DoubleAdder:没有 double 的 CAS

DoubleAdder(`DoubleAdder.java:64`)的注释解释了为什么它用 long 位模式存 double(`DoubleAdder.java:67-76`):

```java
// DoubleAdder.java:67-76(截取核心,逐字)
/*
 * Note that we must use "long" for underlying representations,
 * because there is no compareAndSet for double, due to the fact
 * that the bitwise equals used in any CAS implementation is not
 * the same as double-precision equals.  However, we use CAS only
 * to detect and alleviate contention, for which bitwise equals
 * works best anyway. In principle, the long/double conversions
 * used here should be essentially free on most platforms since
 * they just re-interpret bits.
 */
```

**CAS 用位相等(bitwise equals)判断,而 double 的位相等 ≠ 数值相等**(IEEE-754 里同一个值有多种位表示: 正负零、NaN 的多种 payload)。所以 CAS 根本不能直接作用于 double——底层必须用 long 位模式。好在 `Double.doubleToRawLongBits`/`longBitsToDouble` 只是重解释位,几乎零成本(`DoubleAdder.java:73-75`)。`add`(`DoubleAdder.java:89-103`)就是先转 long 再走 Striped64 的机制,`sum`(`DoubleAdder.java:117-126`)逐个 `Double.longBitsToDouble` 还原。DoubleAccumulator(`DoubleAccumulator.java:107` 的 `accumulate`)同理,加上可定制函数。

### 4.3 生产组合:指标统计的标准答案

监控指标的标准组合: **LongAdder 计数**(请求数、错误数)+ **LongAccumulator 求最大值/延迟峰值**(`Long::max`,identity 用 `Long.MIN_VALUE`)——Javadoc 的原话是维护 running maximum(`LongAccumulator.java:66-67`)。读的时候弱一致没问题: 监控本来就不需要精确到纳秒,要的是低开销、不阻塞。

跨层标注: [域 02: 03-ieee754——double 的位表示与 NaN/正负零多种位模式,这是"没有 double CAS"的根源]

## 核心悬念

分片计数解决了"数值计数器"的竞争——但**引用类型**呢?`AtomicReference` 怎么原子替换对象?`AtomicStampedReference` 怎么给引用加版本戳根治 ABA?`FieldUpdater` 怎么在不建对象的情况下原子更新字段、省掉一整块内存?下一篇: 引用原子与 FieldUpdater。

> → [13-atomic/03 — 引用原子与 FieldUpdater](03-reference-updater.md)
