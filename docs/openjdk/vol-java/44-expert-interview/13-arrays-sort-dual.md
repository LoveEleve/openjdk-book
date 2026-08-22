# 为什么 `Arrays.sort` 对基本类型用 Dual-Pivot QuickSort、对对象用 TimSort？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`08-collections/05-arrays-sort`
> 版本边界：下文引用的 `Arrays.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

`Arrays.sort(int[])` 和 `Arrays.sort(Object[])` 为什么走的排序算法不同？一个是 Dual-Pivot QuickSort，一个是 TimSort，为什么不能统一成一种？

## 常见答法

> 基本类型用快排，对象用归并排序，因为归并排序稳定，快排不稳定。

这个答法方向对，但只说对了一半。真正的关键是：**基本类型排序不需要稳定，而对象排序通常需要稳定**——这才是两条算法路径分叉的根本原因。稳定是标准快排给不了的特性，所以要为对象专门走稳定的归并类算法。

## 追问一：为什么基本类型不需要稳定？

> 答：基本类型之间没有"相等但可区分"的对象。两个 int 值相等，它们在结果里谁在前谁在后没有区别。

对。`sort([5, 2, 2])` 里两个 2 顺序如何，结果完全一样——因为它们是相同的值，无法区分。所以对基本类型做排序，稳定性没有任何意义。

但对象不同。`sort` 一个 `Employee[]`，如果按 `age` 排序，两个 age 相同的员工谁是"先来的"，结果里应该保持原来的相对顺序。如果排序不稳定，两个相等年龄的员工的先后可能被交换，这在多级排序（先按 age 再按 name）里会导致错误结果。

## 追问二：那为什么不给基本类型也用 TimSort？

> 答：TimSort 是稳定但更重的算法，需要额外的临时空间；快排是原地且更快的。

TimSort 需要额外空间来合并子序列（通常 O(n/2)），而且它更擅长处理"基本有序"的真实数据。对随机分布的基本类型数组，Dual-Pivot QuickSort 在纯排序速度上通常更快，而且基本不需要额外空间。

基本类型排序没有稳定性的约束，所以可以放心选"快且省空间"的快排。对象排序有稳定性的需求，必须为它付出 TimSort 的额外空间和复杂度。JDK 11 里就是按这个逻辑分叉的。

## 追问三：那 JDK 11 里 `Arrays.sort(Object[])` 是不是永远走 TimSort？

> 答：默认走 TimSort，但还留了一个可选的 legacy merge sort 开关。

JDK 11 的 `Arrays.sort(Object[])` 默认走 `TimSort.sort`（`Arrays.java:1249`），但如果显式设置了 `java.util.Arrays.useLegacyMergeSort=true`（`Arrays.java:1196-1200`），会退回老的 `LegacyMergeSort` 路径。这个开关是历史兼容用的，默认不开启。

而基本类型路径（`int[]`、`long[]`、`double[]` 等）统一走 `DualPivotQuicksort.sort`（`Arrays.java:147`、`:172`、`:187` 等），没有可选算法。这就是"基本类型一套、对象一套"的源码体现。

## 源码证据

- 基本类型排序：`DualPivotQuicksort.sort(...)`（`Arrays.java:147`、`:172`、`:187` 等），int/long/double 等几十个类型重载都走它
- 对象自然排序：`TimSort.sort`（`:1008`、`:1067`），Comparable 对象的默认路径
- 比较器排序：`TimSort.sort`（`:1116`、`:1177`），带 Comparator 时也用 TimSort
- `LegacyMergeSort.userRequested`（`:1196-1200`）：可选的老归并开关，默认关闭

## 一句话顿悟

**基本类型排序不需要稳定，所以选"Dual-Pivot QuickSort"这类快且省空间的原地算法；对象排序需要稳定，所以必须走 TimSort/LegacyMergeSort 这类归并算法——稳定性决定了算法选型。** 面试官真正想听的不是你会背"快排和归并谁稳定"，而是你知道"基本类型没法区分相等元素所以稳定无意义，对象能区分所以稳定必须保证"。"