# 08-collections/05 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Arrays`、`DualPivotQuicksort`、`TimSort`。本文聚焦排序分流、`binarySearch`、`copyOf`、`parallelSort`；不展开完整排序证明、并发池实现和 `ComparableTimSort` 全部细节。
> 目标：把“Arrays 工具与排序”改写成一篇围绕“为什么同样叫 `Arrays.sort`，基本类型与对象会走两条完全不同的工程路线”的机制文章，并把二分查找前提、数组复制语义和并行排序阈值收进同一张心智图。

## 1. 读者困惑

- 为什么 `Arrays.sort(int[])` 和 `Arrays.sort(Object[])` 不是同一种算法？
- 稳定性到底为什么会让对象排序和基本类型排序分家？
- 双轴快排是不是单纯“两个 pivot 的快排”这么简单，JDK 里还有哪些混合路径？
- TimSort 为什么特别适合对象数组和“部分已有序”的真实数据？
- `binarySearch` 为什么对未排序数组不报错，却可能直接给错答案？
- `copyOf` 是视图还是复制？扩容和截断时到底怎么补位？
- `parallelSort` 为什么不对所有数组都并行，阈值背后在防什么？

## 2. 一句话顿悟

**`Arrays` 的排序不是“一个万能算法打天下”，而是把需求拆成两条路线：基本类型追求速度和缓存友好，稳定性无意义，因此走 Dual-Pivot Quicksort 的混合工程路径；对象排序要兼顾稳定性、最坏复杂度和真实数据常见的局部有序性，因此走 TimSort。`binarySearch`、`copyOf`、`parallelSort` 则分别围绕“前提换速度”“复制换封装”“阈值换吞吐”服务这两条主线。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `sort(int[])` → `DualPivotQuicksort`、`sort(Object[])` → `ComparableTimSort`。
- 已提到 DPQ 的阈值混合路径、TimSort 的 run、自适应性与稳定性。
- 已收录 `binarySearch`、`copyOf`、`parallelSort` 的主要事实。

### 必须重写

- 旧稿过于“面试答案汇总”，需要先把“同样叫 sort，为什么要分流”立成主问题。
- `DualPivotQuicksort` 不能只讲“双轴”，还要把 JDK 11 的 run 检测、插入排序、计数排序路径放到“工程混合算法”视角里。
- TimSort 需要更明确地说明“部分有序”的现实价值，以及为什么这与对象排序的稳定性天然契合。
- `binarySearch` 和 `copyOf` 不应只是工具补丁，要回扣到“排序之后怎么用”和“为什么数组复制常常是封装边界”。
- `parallelSort` 要讲清楚它不是“自动更快”，而是有粒度阈值与 commonPool 代价。

## 4. 理解路径

### 第一节：先建立总问题——同名 API，为什么算法不统一

从两个日常调用开场：
- `Arrays.sort(int[])`
- `Arrays.sort(Object[])`

让读者先直观看到：JDK 并没有为了“统一”而强行复用一种排序，而是按数据语义分流。

### 第二节：基本类型排序为什么走 Dual-Pivot Quicksort

证据：
- `Arrays.java:136-148`：`sort(int[])` 直接委托 `DualPivotQuicksort.sort`
- `DualPivotQuicksort.java:58-85`：阈值常量
- `DualPivotQuicksort.java:102-107`：小数组走 Quicksort/插入路径
- `DualPivotQuicksort.java:117-147`：run 检测与“是否近乎有序”判断
- `DualPivotQuicksort.java:175-215`：归并工作区与合并逻辑

主线：
- 基本类型没有“相等值但对象身份不同”的稳定性诉求。
- 因此可以优先追求比较次数、交换次数、缓存表现和分支效率。
- JDK 11 的 DPQ 不是纯快排，而是插入排序 + 双轴快排 + 计数排序 + 近乎有序时的归并路径。

### 第三节：对象排序为什么改走 TimSort

证据：
- `Arrays.java:1245-1249`：`sort(Object[])`
- `Arrays.java:1271-1282`：稳定、自适应、最坏 O(n log n) 注释
- `TimSort.java:29-36`：稳定、自适应、比较次数与空间特征
- `TimSort.java:64-80`：`MIN_MERGE`
- `TimSort.java:214-220`：小数组 mini-TimSort 起点

主线：
- 对象排序经常需要稳定性：多关键字排序、先后排序、相等键保序。
- 真实业务数据往往不是纯随机，常含已有有序段；TimSort 正好利用 run。
- 稳定与自适应带来额外临时空间，但换来更好的最坏边界和现实数据表现。

### 第四节：为什么两条路线不是“谁更高级”，而是需求不同

对照：
- 基本类型：稳定性无意义，优先速度
- 对象：稳定性有业务意义，且比较器开销更高，更值得利用局部有序性

必须明确：不是 TimSort 全面更强，也不是 DPQ 过时，而是两者优化目标不同。

### 第五节：`binarySearch` 为什么快，但前提很苛刻

证据：
- `Arrays.java:1866-1867`：入口
- `Arrays.java:1874-1879`：必须先排序，否则结果未定义
- `Arrays.java:1909-1925`：`binarySearch0`

主线：
- 二分查找的速度来自“信任数组已按顺序分布”。
- JDK 不替你验证这个前提，因为那会把 O(log n)` 的接口污染成 O(n)` 甚至更慢。
- 返回负插入点不是怪设计，而是把“没找到”和“该插哪儿”编码在一个整数里。

### 第六节：`copyOf` 为什么是复制，不是视图

证据：
- `Arrays.java:3688-3724`：对象数组 `copyOf`
- `Arrays.java:3727-3748`：基本类型补零示例

主线：
- `copyOf` 的意义不是省事新建数组，而是把“截断/扩容/防御性复制”统一成一个 API。
- 超出的部分对象数组补 `null`，基本类型补零值。
- 底层最终回到 `System.arraycopy`。

### 第七节：`parallelSort` 为什么不是对所有数组都开多线程

证据：
- `Arrays.java:76-82`：`MIN_ARRAY_SORT_GRAN`
- `Arrays.java:675-685`：`parallelSort(int[])`
- `Arrays.java:693-702`：并行 sort-merge、commonPool 与工作区说明

主线：
- 并行不是白拿收益，拆任务、分配工作区、合并都要成本。
- 所以 JDK 11 先看数组长度阈值，再看 commonPool 并行度；不合适就退回串行 sort。
- 并行排序更像是大数据量吞吐优化，不是默认总开关。

### 第八节：收束到 Arrays 的总体心智

把 `sort`、`binarySearch`、`copyOf`、`parallelSort` 串成一条：
- 排序先按数据类型分流
- 查找依赖排序前提
- 复制承担边界隔离与扩缩容
- 并行在足够大时才值得

自然引到 `Collections` 工具与包装器。

## 5. 失败方案清单

1. 把对象排序和基本类型排序当成完全同一条算法路径。
2. 在对象多关键字排序场景里忽略稳定性。
3. 误以为 Dual-Pivot Quicksort 就是单纯双轴分区，没有阈值混合策略。
4. 在未排序数组上直接调用 `binarySearch`。
5. 把 `copyOf` 当成共享视图，修改返回数组后期待原数组同步变化。
6. 在小数组上盲目使用 `parallelSort`，以为并行一定更快。
7. 忽略 `parallelSort` 会占用 `ForkJoinPool.commonPool()` 的资源。

## 6. 误解清单

1. TimSort 比 Dual-Pivot Quicksort 高级，所以所有类型都应该用 TimSort。
2. 基本类型排序不稳定是 JDK 的缺陷，而不是刻意取舍。
3. `binarySearch` 会先检查数组是否有序。
4. `copyOf` 只是更方便的 `new`，与封装边界无关。
5. `parallelSort` 是“多核版 sort”，总是更快。
6. `copyOfRange` 的区间两端都包含。
7. `PriorityQueue`/`TreeSet` 那类结构和 `Arrays.sort` 的排序需求是一回事。

## 7. 证据清单

- `Arrays.java:76-82`：`MIN_ARRAY_SORT_GRAN`
- `Arrays.java:136-148`：`sort(int[])`
- `Arrays.java:1245-1249`：`sort(Object[])`
- `Arrays.java:1271-1282`：对象排序稳定/自适应注释
- `Arrays.java:1866-1867`：`binarySearch(int[], int)`
- `Arrays.java:1874-1879`：已排序前提
- `Arrays.java:1909-1925`：`binarySearch0`
- `Arrays.java:3688-3724`：对象数组 `copyOf`
- `Arrays.java:3727-3748`：基本类型 `copyOf`
- `Arrays.java:675-685`：`parallelSort(int[])`
- `Arrays.java:693-702`：并行 sort-merge 注释
- `DualPivotQuicksort.java:58-85`：阈值常量
- `DualPivotQuicksort.java:102-107`：小数组路径
- `DualPivotQuicksort.java:117-147`：run 检测
- `DualPivotQuicksort.java:175-215`：归并工作区与合并
- `TimSort.java:29-36`：稳定/自适应
- `TimSort.java:64-80`：`MIN_MERGE`
- `TimSort.java:214-220`：小数组 mini-TimSort 起点

## 8. 版本与边界

- 基于 JDK 11。
- 对象排序入口是 `ComparableTimSort` / `TimSort` 体系；本文用 `Arrays` 的公开入口与 `TimSort` 的核心注释建立机制，不展开全部 companion class。
- 不展开完整复杂度证明与 TimSort 不变量证明，只保留足以支撑选型与机制理解的部分。
- 不在本文展开 `ForkJoinPool` 细节，留给异步编程相关域。

## 9. 删除代码测试与最终验收标准

- 删除源码块后，读者仍能复述“`Arrays.sort` 按数据类型分流 → 基本类型走 DPQ 混合路径 → 对象走稳定自适应 TimSort → `binarySearch` 依赖已排序契约 → `copyOf` 是复制边界 → `parallelSort` 受阈值和 commonPool 约束”。
- 必须明确对象与基本类型分流的根本原因是稳定性与数据语义，不是历史偶然。
- 必须把 DPQ 写成混合工程算法，而不是纯双轴快排定义句。
- 必须说明 `binarySearch` 的未排序未定义是性能契约的一部分。
- 结尾要自然引到 `06-collections.md`。
