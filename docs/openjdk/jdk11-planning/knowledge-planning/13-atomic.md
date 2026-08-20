# 域 13: 原子类 — 知识规划

> 源码路径: java.base/share/classes/java/util/concurrent/atomic/(18 文件:Atomic*/LongAdder/LongAccumulator/DoubleAdder/DoubleAccumulator/Striped64)
> 源码量: 18 文件 / ~7,300 行 | 非巨型域
> 写作层: Layer 3(前置: 域 11 线程、32 Unsafe 的 CAS 原语)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| AtomicInteger.java (551) | **CAS 封装**: value volatile(64)、VALUE 偏移(62,U.objectFieldOffset)、get(87)/set(97)、compareAndSet(133)、weakCompareAndSet(154,JDK9+ weak/plain 变体 168/410/432)、getAndSet(119) | High |
| AtomicInteger.java | **运算族**: getAndIncrement(180,U.getAndAddInt)/incrementAndGet(215)/getAndUpdate(253)/updateAndGet(275,函数式 CAS 循环)——全部基于 CAS 循环 | High |
| AtomicLong/AtomicBoolean/AtomicReference (564/359/440) | **同类封装**: 值类型差异;AtomicReference 引用 CAS | Medium |
| AtomicIntegerArray/LongArray/ReferenceArray (566/565/527) | **数组原子**: JDK9+ 用 **VarHandle**(MethodHandles.arrayElementVarHandle,AtomicIntegerArray.java:55)元素级 CAS(旧版 Unsafe 偏移) | Medium |
| Striped64.java (409) | **分片计数器**: Cell(124,@Contended 伪共享隔离)/cells(158)/base(164)/cellsBusy(169,扩容锁)/casBase(180)/casCellsBusy(191)、longAccumulate(扩容+初始化) | High |
| LongAdder.java (264) | **高并发计数**: add(85: 先 casBase 单点,失败→cells 分片 CAS)、sum(119: 弱一致求和)、increment(99) | High |
| LongAccumulator.java (294) | **可定制累积**: 二元操作符(LongBinaryOperator)+ 初始值 | Medium |
| DoubleAdder/DoubleAccumulator (262/303) | double 版本(内部用 long 位模式) | Low |
| AtomicStampedReference.java (209) | **ABA 解**: Pair(55,reference+stamp 原子对)、compareAndSet(期望引用+期望戳) | High |
| AtomicMarkableReference.java (209) | **标记引用**: Pair(reference+mark bool) | Medium |
| AtomicIntegerFieldUpdater.java (545) | **字段原子更新**: 反射偏移、compareAndSet(115)、避开包装对象(减少内存) | High |
| AtomicLongFieldUpdater/ReferenceFieldUpdater | 同类 | Medium |

*12 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | CAS 封装与运算族 | 4 (AtomicInteger/Long/Boolean/Reference) | 面试必考(实现=volatile+CAS 循环) |
| P1 | Striped64/LongAdder | 2 | 面试高频(高并发计数/伪共享) |
| P1 | StampedReference(ABA) | 1 | 面试常问(ABA 解决) |
| P2 | FieldUpdater | 3 | 面试偶尔(内存优化) |
| P2 | 数组原子 | 3 | 面试偶尔 |
| P3 | Accumulator/Double 版 | 4 | 使用层 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | AtomicInteger 实现(volatile+CAS 循环) | 面试必考(手写 CAS 循环/与 volatile 区别) |
| 🔴 Deep | LongAdder 分片与伪共享 | 面试高频(为什么比 AtomicLong 快/伪共享) |
| 🔴 Deep | ABA 与 StampedReference | 面试常问(ABA 场景与解决) |
| 🟡 Working | FieldUpdater | 面试偶尔(性能优化) |
| 🟢 Surface | 数组/Accumulator/Double 版 | 使用层 |

## 04 聚类

### 依赖图(域内)
```
Unsafe(CAS/volatile 原语,域 32) ←── Atomic* ←── 全部基于 CAS 循环
Striped64 ←── LongAdder/Accumulator(分片)
AtomicStampedReference ←── ABA 问题
FieldUpdater ←── 反射+Unsafe 偏移
Atomic* ←── 域 12 AQS/域 10 CHM(使用方)
```

### 教学顺序与文章拆分(3 篇)

1. **AtomicInteger 与 CAS 封装** — volatile value+VALUE 偏移、compareAndSet/weak 变体、getAndIncrement 实现、内存语义(域 11 volatile 衔接)
2. **Striped64 与 LongAdder** — Cell 分片、@Contended 伪共享、base+cells 双路径、sum 弱一致、与 AtomicLong 对比
3. **引用原子与 FieldUpdater** — AtomicReference/Stamped/Markable(ABA)、FieldUpdater 内存优化、选型

> 前置: 域 11(volatile/线程)、32(CAS)。跨层: CAS 硬件指令(内部卷 05-cpu-primitives);@Contended 的 JVM 处理(内部卷 06-oops 对象布局)
