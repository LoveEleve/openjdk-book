# 05. Arrays 工具与排序 — DPQ vs TimSort、binarySearch、copyOf

> **前置依赖**: [08-collections/01 — ArrayList](01-arraylist.md)(数组操作基础)、[03-object-system/02 — System.arraycopy](../03-object-system/02-system-runtime.md)(copyOf 的底层)
> → **后续**:[08-collections/06 — Collections 工具与包装器](06-collections.md)
> 关联: 域 15 异步编程(ForkJoinPool)、域 09(TreeSet 的有序语义)

## 两种 sort,两条路

`Arrays.sort` 是面试"排序选型"的入口——答案的核心是**分对象和基本类型两条路**: 基本类型用双轴快排(快但不稳定,基本类型无所谓),对象用 TimSort(稳定且自适应,最坏 O(n log n))。这篇把两条路、binarySearch 的前置条件、copyOf 的语义、以及 parallelSort 的并行阈值讲清楚。

## 1. "sort(int[]) 用什么算法" — 双轴快排

### 1.1 入口

`Arrays.sort(int[])`(`Arrays.java:146-148`):

```java
// Arrays.java:146-148(截取核心,逐字)
public static void sort(int[] a) {
    DualPivotQuicksort.sort(a, 0, a.length - 1, null, 0, 0);
}
```

直接委托 `DualPivotQuicksort`(`java/util/DualPivotQuicksort.java`,3181 行)——**双轴快排**,JDK7 起替换单轴快排。

### 1.2 混合策略:不只是快排

`DualPivotQuicksort` 内部是**多算法混合**(阈值常量在 `DualPivotQuicksort.java:61-85`):

- **小数组(<47)**:插入排序(`INSERTION_SORT_THRESHOLD = 47`@73)——常数因子最小
- **中等(47-286)**:双轴快排(`QUICKSORT_THRESHOLD = 286`@67)——两个 pivot 分三段,减少递归深度与交换
- **byte/short/char**:桶排序路径(`COUNTING_SORT_THRESHOLD_FOR_BYTE = 29`@79、`_FOR_SHORT_OR_CHAR = 3200`@85)——值域小,计数排序比比较排序快
- **大数组(≥286)**:**先检测"几乎有序"**——扫描 run 序列(`MAX_RUN_COUNT = 67`@61),run 数量达到 67(数据混乱)才走双轴快排;run 少(数据几乎有序)直接**归并排序**(`DualPivotQuicksort.java:190-215` 的合并逻辑)——与 TimSort 的 run 思想异曲同工

### 1.3 稳定性:基本类型无所谓

快排是交换排序,**不稳定**(相等元素相对顺序可能变)。但基本类型"值相等不可区分"——稳定性无意义,所以用更快的快排。

关键设计(斜体):*双轴快排把数组分 3 段(两个 pivot),比单轴减少递归深度与交换;小数组切插入排序是"快排+插入"混合的经典工程实践(常数因子优化)。面试"快排为什么不是稳定排序": 交换破坏相对顺序;基本类型无需稳定,所以用快排(快);对象需要稳定,所以用 TimSort(下节)。*

## 2. "sort(Object[]) 为什么用 TimSort" — 稳定性与适应性

### 2.1 入口与老归并开关

`Arrays.sort(Object[])`(`Arrays.java:1245-1249`):

```java
// Arrays.java:1245-1249(截取核心,逐字)
public static void sort(Object[] a) {
    if (LegacyMergeSort.userRequested)
        legacyMergeSort(a);
    else
        ComparableTimSort.sort(a, 0, a.length, null, 0, 0);
}
```

- `LegacyMergeSort.userRequested`:老归并排序的**兼容开关**(系统属性触发)
- 默认:`ComparableTimSort`(`java/util/ComparableTimSort.java`,907 行)——**TimSort**,JDK7 起替换归并

### 2.2 TimSort 的聪明:利用已有有序性

TimSort 的核心思想: 真实数据常含**已有序片段(run)**——算法先**检测 run**,短的 run 用二分插入排序补长,然后按策略**归并**。数据越有序,run 越长,排序越快(自适应);最坏情况仍是归并的 O(n log n)。

对比:

| | 快排 | 归并 | TimSort |
|---|---|---|---|
| 稳定性 | 不稳 | 稳定 | 稳定 |
| 最坏 | O(n²) | O(n log n) | O(n log n) |
| 已有有序数据 | 不利用 | 不利用 | **利用(run)** |

关键设计(斜体):*TimSort 的聪明: 真实数据常含有序段——直接利用(run)比无脑分治快;稳定性的代价是额外内存(合并暂存)。面试"对象排序选型": 稳定 + 最坏 O(nlogn) = TimSort。稳定性影响: 两次排序的顺序保持(先按日期再按优先级,优先级相同时日期仍有序)。*

## 3. "binarySearch 与 copyOf" — 二分查找与数组拷贝

### 3.1 binarySearch:前提是已排序

`Arrays.binarySearch(int[], int)`(`Arrays.java:1866-1867`):

```java
// Arrays.java:1866-1867(截取核心,逐字)
public static int binarySearch(int[] a, int key) {
    return binarySearch0(a, 0, a.length, key);
}
```

二分 O(log n)——但**前提: 数组已排序**。未排序时结果未定义(不检测、不抛异常,直接给错答案)——接口契约的"快但危险"。

### 3.2 copyOf:扩容/截断

`copyOf(T[], int)`(`Arrays.java:3688`):新数组,多余位置填 null(基本类型填 0);`copyOfRange`(`Arrays.java:3949`):**含 from 不含 to**。底层全是 `System.arraycopy`(域 03 的 native stub)。

关键设计(斜体):*copyOf 是"不可变视图"的替代品——返回全新数组防止篡改;binarySearch 的"未排序未定义"是接口契约(不检测,快但危险)。面试: 先 sort 再 binarySearch 是黄金搭档;"二分 vs indexOf": 有序用二分 O(logn),无序线性 O(n)。*

## 4. "parallelSort 怎么并行" — ForkJoin 拆分

### 4.1 阈值决定是否并行

`Arrays.parallelSort(int[])`(`Arrays.java:675-688`):

```java
// Arrays.java:675-688(截取核心,逐字)
public static void parallelSort(int[] a) {
    int n = a.length, p, g;
    if (n <= MIN_ARRAY_SORT_GRAN ||
        (p = ForkJoinPool.getCommonPoolParallelism()) == 1)
        DualPivotQuicksort.sort(a, 0, n - 1, null, 0, 0);
    else
        new ArraysParallelSortHelpers.FJInt.Sorter
            (null, a, new int[n], 0, n, 0,
             ((g = n / (p << 2)) <= MIN_ARRAY_SORT_GRAN) ?
             MIN_ARRAY_SORT_GRAN : g).invoke();
}
```

**并行不是默认**——两个条件直接退回串行: ① 数组长度 ≤ `MIN_ARRAY_SORT_GRAN`(拆分粒度阈值);② ForkJoin 公共池并行度 = 1。并行时用 `ForkJoinPool.commonPool` 拆分排序(FJInt.Sorter)。

关键设计(斜体):*parallelSort 的阈值思想: 并行有拆分的固定开销,小数组并行反而慢——JDK 用数组长度阈值决定是否并行。面试点: "并行不总是更快"。生产: 海量数据排序优先 parallelSort,但注意 commonPool 与业务线程池的资源竞争(域 15)。*

## 核心悬念

数组工具有了,但**集合的算法工具**——`Collections` 5670 行——三大包装器(unmodifiable/synchronized/checked)为什么是"防御编程"标配?reverse/shuffle 怎么做到通用(不依赖具体实现)?排序/查找在集合层的分派又是怎样的?——下一篇: Collections 工具与包装器。

> → [08-collections/06 — Collections 工具与包装器](06-collections.md)
