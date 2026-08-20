# 02. Striped64 与 LongAdder — 分片计数、伪共享、弱一致求和

> 🔴 Deep | 域 13 原子类第 2 篇 | Layer 3
> 读者处境: 面试"高并发计数为什么用 LongAdder 不用 AtomicLong"——分片 + 伪共享 + 弱一致,一次讲透。

### 1. "LongAdder 的结构？" — base + Cell 数组

场景: `new LongAdder()` — 内部不是"一个数",而是"一组格子"

- `Striped64.java:164` — `transient volatile long base` — 无竞争时的单点
- `Striped64.java:158` — `transient volatile Cell[] cells` — **分片数组**(竞争加剧时扩容)
- `Striped64.java:124` — `static final class Cell { volatile long value; }` + `@jdk.internal.vm.annotation.Contended` 注解
- `Striped64.java:169` — `cellsBusy`(扩容/初始化自旋锁,casCellsBusy 191)
- 关键设计 (斜体): *"分片"= 多个可累加单元——不同线程写不同 Cell(按 threadLocalRandomProbe 哈希选格,域 11),互不竞争;base 只服务低竞争场景;这就是"无锁 + 无争抢"的计数方案*
- 面试: "LongAdder vs AtomicLong"——读少写多/高竞争用 LongAdder;需要精确读(每次 sum)用 AtomicLong

### 2. "add() 的路径" — 单点优先,失败分片

场景: `adder.add(1)` — 每次走什么路径?

- `LongAdder.java:85` `add(x)`:
  1. `casBase(b, b + x)` 尝试单点更新(base,无竞争时直接成功)
  2. 失败 → 找自己的 Cell:`c = cs[getProbe() & m]` → `c.cas(v, v+x)`
  3. 再失败(cell 空/被抢)→ `longAccumulate`(Striped64:228): **初始化/扩容 cells + 重试**
- 扩容: `cellsBusy` 自旋锁保护——初始化 `new Cell[2]`(Striped64:282-283),后续 `Arrays.copyOf(cs, n << 1)` **双倍扩容**(272-273,`n >= NCPU` 后停扩,266)
- 关键设计 (斜体): *路径设计是"性能阶梯": 单点(最快)→ 分片(次)→ 扩容(最慢,低频)——绝大多数 add 走前两档;面试讲"三级路径"比"分片"有细节*
- `sum()`(`LongAdder.java:119`): **遍历 base+所有 Cell 求和——弱一致**(无锁,读取时可能正在写)

### 3. "伪共享是什么？" — @Contended 的战场

场景: 两个 Cell 相邻,为什么一个线程改 A 会影响改 B 的线程?

- CPU 缓存行(64 字节): 相邻对象同缓存行 → 一个被改,整行失效(其他核重载)——**伪共享**(false sharing)
- 解决: `@Contended` 注解 → JVM **填充 padding**(把对象推到独立缓存行,`-XX:-RestrictContended` 控制)
- 经典场景: 多核高频计数/日志计数器/锁字段
- 关键设计 (斜体): *伪共享是"并发性能隐形杀手"——两个线程看似不共享数据,却因缓存行互相拖慢;@Contended 是 JVM 级解法(内部字段布局);面试画"缓存行"图是加分项*
- [C++: 内部卷 06-oops(对象布局与字段填充);x86: 缓存一致性协议(MESI)]
- 面试: "伪共享怎么检测/避免"——padding/@Contended/数据对齐

### 4. "LongAccumulator 与 Double 版" — 定制累积

场景: 需要 max/min/自定义累积的高并发统计

- `LongAccumulator.java:294` — `LongBinaryOperator` + 初始值——accumulate(x) 用操作符合并(基于 Striped64 同款分片)
- DoubleAdder/DoubleAccumulator(262/303): double 用 long 位模式存储(无浮点原子指令)
- 应用: 统计吞吐/最大延迟/计数的并发场景(监控指标)
- 关键设计 (斜体): *Accumulator 是"可结合运算的分片聚合"——满足结合律的运算(加/乘/max/min)都能分片;面试"为什么必须可结合"——分片后按任意顺序合并结果一致*
- 生产: 指标统计(LongAdder 计数 + LongAccumulator 求最大值)是标准组合

---

### 核心悬念

原子类和分片计数都依赖 CAS——但**引用类型**怎么办?`AtomicReference` 替换对象、`AtomicStampedReference` 解决 ABA、`FieldUpdater` 省内存——下一篇: 引用原子类与 FieldUpdater。

> → [03-reference-updater.md](03-reference-updater.md)
