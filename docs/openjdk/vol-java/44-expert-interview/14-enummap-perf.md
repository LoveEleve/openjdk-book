# 为什么 EnumMap 和 EnumSet 的性能优于 HashMap 和 HashSet？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`09-map-hash/04-map-family`
> 版本边界：下文引用的 `EnumMap.java`、`RegularEnumSet.java`、`JumboEnumSet.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

为什么 JDK 建议用 EnumMap 和 EnumSet 代替 HashMap 和 HashSet？它们的性能优势到底在哪？

## 常见答法

> 因为它们底层用数组，不用 hash，直接用索引。

这个答法方向对，但"用数组所以快"没有讲透**为什么能用数组**。HashMap 也想用数组，但它没法保证"key 的值域是连续、有限、已知的"。EnumMap/EnumSet 能用数组的本质，是**枚举的值域在编译期就是确定的一个有限序列，`ordinal` 正好是 0..n-1 的连续下标**——这才是它们能直接用索引的关键前提。

## 追问一：EnumMap 底层到底是怎么"用索引"的？

> 答：EnumMap 内部存一个 key 类型引用和一个值数组，用 `ordinal` 做下标。

JDK 11 的 `EnumMap` 持有 `keyType`（`EnumMap.java:86`，`Class<K>` 引用）和 `vals`（`EnumMap.java:98`，`Object[]` 数组）。`put(enumKey, value)` 直接用 `enumKey.ordinal()` 作为 `vals` 的下标，`get(enumKey)` 同样。所以：

- 查找：`vals[ordinal]`，一次数组访问，O(1)
- 不需要算 hashCode、不需要处理 hash 冲突、不需要扩容重哈希

HashMap 的查找要先算 hashCode、扰动、定位桶、遍历冲突链；EnumMap 直接按下标取数，少了好几层。

## 追问二：那 EnumSet 呢？它为什么能更快？

> 答：EnumSet 用位向量表示，把"有没有这个元素"压缩到 bit 上。

JDK 11 的 EnumSet 分两个实现：枚举数少于等于 64 个时用 `RegularEnumSet`，它内部是 `long elements`（`RegularEnumSet.java:42`），每个枚举常量对应一个 bit；超过 64 个时用 `JumboEnumSet`，内部是 `long[] elements`（`JumboEnumSet.java:44`）。

`add` / `contains` 都是位运算：`elements & (1L << ordinal)` 判断在不在，`elements |= (1L << ordinal)` 加进去。一个 `long` 能存 64 个枚举的 "在不在"，集合操作（并、交、补）也直接是位运算。相比 HashSet 要存一堆对象、算哈希、解决冲突，EnumSet 节省的是内存和运算成本的双重。

## 追问三：那是不是用 EnumMap 就一定比 HashMap 好？有没有前提？

> 答：前提是 key 必须是枚举，而且枚举的数量不能太大。

对。EnumMap 依赖两个前提：**key 是枚举**（`ordinal` 才是连续下标），**枚举数量不太大**（数组大小和枚举常量数一致）。如果你拿一个普通类当 key，或枚举常量上千个，EnumMap 就不适用了。

另外 EnumMap/EnumSet 的"快"是在"key 是枚举"这个约束下换来的。如果场景只是 HashMap 少几十个 key，那差距不足以成为主要选型理由；但如果你在高频路径上反复查枚举 key，EnumMap 的 O(1) 索引确实比 HashMap 的哈希链更省。

## 源码证据

- `EnumMap.keyType`（`EnumMap.java:86`，`Class<K>` 引用）、`vals`（`:98`，`Object[]` 数组）：用 `ordinal` 作为值数组下标
- `RegularEnumSet.elements`（`RegularEnumSet.java:42`）：单 `long` 位向量，<=64 个枚举
- `JumboEnumSet.elements`（`JumboEnumSet.java:44`）：`long[]` 位向量，>64 个枚举

## 一句话顿悟

**EnumMap/EnumSet 能"用数组/位向量"根源于枚举的值域是编译期确定的连续序列，`ordinal` 正好是 0..n-1 的下标——这不是"碰巧快"，而是枚举这种类型从设计上就许可索引寻址。** 面试官真正想听的不是你会背"EnumMap 底层是数组"，而是你知道"枚举值域连续有限 → ordinal 可直接当下标 → 数组/位向量寻址"这条从类型特性到实现选择的因果链。