# 为什么 ConcurrentHashMap 的 `size()` 和 `mappingCount()` 是弱一致的？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`10-concurrent-collections/01-chm-storage-rw`、`02-resize-count`
> 版本边界：下文引用的 `ConcurrentHashMap.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

`ConcurrentHashMap.size()` 返回的是精确值还是近似值？为什么它的 `mappingCount()` 返回值也是弱一致的？如果要求精确计数，应该怎么办？

## 常见答法

> 因为 CHM 的分片计数机制，size() 返回的是近似值，不是精确值。

这个答法方向对，但没答"为什么"——不是说"分片所以近似"就完了，而是**`sumCount()` 在求和时根本不加锁，只是把 `baseCount` 和 `CounterCell` 数组里的值依次读一遍，读的过程中别的线程还在并发改**。所以它不可能是精确快照。

## 追问一：`sumCount()` 为什么不加锁？

> 答：因为加锁会降低写性能。CHM 设计权衡了"写快"和"读精确"——写路径尽量不加锁，读总量时接受弱一致。

`sumCount()`（`ConcurrentHashMap.java:2560-2565`）的实现非常简单：先读 `baseCount`，再遍历 `CounterCell[]` 把所有非空 cell 的 `value` 加起来。全程没有锁，没有 CAS，没有 `synchronized`。

你在遍历 `CounterCell` 的过程中，别线程可能正在往某个 cell 里 CAS 加值，也可能在扩容到更大的 cell 数组。所以 `sumCount()` 返回的数值是"开始读那一瞬间到结束那一刻之间的一个混合值"，不是某个时刻的精确快照。

CHM 在这里的选择是：**让写路径（`addCount`）尽量便宜——低竞争时只 CAS `baseCount`，高竞争时才升级到 `CounterCell`；而读总量（`size()` / `mappingCount()`）直接接受弱一致，不做额外同步。**

## 追问二：那 `mappingCount()` 和 `size()` 有什么区别？

> 答：mappingCount 返回 long，size 返回 int，但两者底层调的都是 sumCount。

JDK 11 的 `size()`（`ConcurrentHashMap.java:909`）和 `mappingCount()`（`:2166`）底层都走 `sumCount()`。`size()` 把结果截断为 `int`，`mappingCount()` 以 `long` 返回。对于大表，`size()` 可能溢出，所以官方推荐用 `mappingCount()`。

但弱一致的本质是一样的——两者都是"遍历当前可见的 `baseCount` 和 `CounterCell` 值，不做任何冻结"，所以都不是精确快照。

## 追问三：那如果业务真需要精确计数怎么办？

> 答：用 `synchronized` 块或 `AtomicLong` 外部计数，或者用 `LongAdder` 自己统计，再接受短时冻结。

CHM 本身不提供精确计数的 API。实际做法通常是：

- 业务上自建一个 `AtomicLong` 增删计数器，和 CHM 操作放在同一个临界区里
- 或者用一个 `LongAdder` 独立记账，在需要精确值的点做汇总
- 或者接受 CHM 的弱一致——在大多数统计场景下，`sumCount()` 的偏差已经足够小

## 源码证据

- `baseCount`（`ConcurrentHashMap.java:790`）：volatile long，低竞争时直接 CAS 更新
- `counterCells`（`:815`）：`CounterCell[]` 数组，高竞争时分散写入
- `sumCount()`（`:2560-2565`）：不加锁遍历 baseCount + CounterCell，任何时刻都可能被并发修改
- `size()`（`:909`）和 `mappingCount()`（`:2166`）：都走 `sumCount()`，同一个弱一致逻辑

## 一句话顿悟

**CHM 的 `size()` 弱一致不是"偶尔不准"，而是"设计上就不加锁"——`sumCount()` 在遍历 `baseCount` 和 `CounterCell` 时不做任何同步，值就是那一刻的混合可见快照。** 面试官真正想听的不是你会背"CHM 的 size 是近似值"，而是你知道 `sumCount()` 不加锁的实现、以及"写快 + 读弱一致"是 CHM 的权衡。