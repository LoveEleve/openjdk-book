# 05. Arrays 工具与排序 — DPQ vs TimSort、binarySearch、copyOf

> 🟡 Working | 域 08 集合框架第 5 篇(巨型域 6 篇之五)| Layer 2
> 读者处境: 面试"Arrays.sort 用什么算法/稳定吗"——对象与基本类型两条路;生产大数据排序选型。

### 1. "sort(int[]) 用什么算法？" — 双轴快排

场景: `Arrays.sort(new int[1000000])` — 内部走什么?时间复杂度/稳定性?

- `Arrays.java:146` `sort(int[])` → `DualPivotQuicksort.sort`(`Arrays.java:147`)— **双轴快排**(JDK7+,替换单轴快排)
- `DualPivotQuicksort.java`(3181 行): 小数组(<47)插入排序,大数组双轴分区(3 段),含 COUNTING_SORT 桶排序路径(对 byte/short/char)
- 基本类型排序**不稳定**(快排交换),但基本类型"值相等不可区分",稳定性无意义
- 关键设计 (斜体): *双轴快排把数组分 3 段(两个 pivot),比单轴减少递归深度与交换;小数组切插入排序是"快排+插入"混合的经典工程实践(常数因子优化)*
- 面试: "快排为什么不是稳定排序"——交换破坏相对顺序;基本类型无需稳定,所以用快排(快);对象需要稳定,所以用 TimSort(下节)

### 2. "sort(Object[]) 为什么用 TimSort？" — 稳定性与适应性

场景: 对象排序要求稳定(先按 A 再按 B 的分组有序)——JDK 的选择

- `Arrays.java:1245` `sort(Object[])` → `ComparableTimSort.sort`(`Arrays.java:1249`)— **TimSort**(JDK7+,替换归并)
- `ComparableTimSort.java`(907 行): 检测"已有序片段"(run)→ 二分插入排序 + 归并(run 合并)——**利用数据已有有序性**(自适应)
- 与归并排序: 稳定、O(nlogn);与快排: 最坏也 O(nlogn)(归并保证)
- `LegacyMergeSort.userRequested`(`Arrays.java:1246`)— 老归并开关(兼容属性)
- 关键设计 (斜体): *TimSort 的聪明: 真实数据常含有序段——直接利用(run)比无脑分治快;稳定性的代价是额外内存(合并暂存);面试"对象排序选型"答案: 稳定+最坏 O(nlogn)=TimSort*
- 面试: "排序稳定性影响什么?"——两次排序的顺序保持(先按日期再按优先级,优先级相同时日期仍有序)
- [关联: 域 09 TreeMap/TreeSet 的有序语义]

### 3. "binarySearch 与 copyOf" — 二分查找与数组拷贝

场景: `Arrays.binarySearch` 的前提是什么?copyOf 扩容/截断语义

- `Arrays.java:1866` `binarySearch(int[], int)` — 二分 O(logn);**前提: 数组已排序**(未排序结果未定义)
- `Arrays.java:3688` `copyOf(T[], int)` — 扩容/截断(新数组,多余填 null);`3949` `copyOfRange`(含 from 不含 to)
- 底层: 全部走 `System.arraycopy`(域 03 的 native)
- 关键设计 (斜体): *copyOf 是"不可变视图"的替代品——返回全新数组防止篡改;binarySearch 的"未排序未定义"是接口契约(不检测,快但危险);面试: 先 sort 再 binarySearch 是黄金搭档*
- 面试: "二分查找 vs indexOf"——有序用二分 O(logn),无序线性 O(n)

### 4. "parallelSort 怎么并行？" — ForkJoin 拆分

场景: 大数组排序如何利用多核?

- `Arrays.java:675` `parallelSort(int[])` — 多线程分治: 数组拆段各自排序 + 合并
- 底层: ForkJoinPool.commonPool(域 15 展开)——小于阈值(数组短)退化为串行 sort
- 关键设计 (斜体): *parallelSort 的阈值思想: 并行有拆分的固定开销,小数组并行反而慢——JDK 用数组长度阈值(FORK_JOIN 阈值)决定是否并行;面试点: "并行不总是更快"*
- [JLS §17: 并行排序的线程语义——parallelSort 依赖 ForkJoin 公共池,多线程并发修改数组属未定义行为]
- 生产: 海量数据排序优先 parallelSort(但注意 commonPool 与业务线程池资源竞争,域 15)
- [关联: 域 15 异步编程(ForkJoinPool 机制)]

---

### 核心悬念

数组工具有了,但**集合的算法工具**——`Collections` 5670 行——三大包装器(unmodifiable/synchronized/checked)为什么是"防御编程"标配?reverse/shuffle 怎么做到通用(不依赖具体实现)?

> → [06-collections.md](06-collections.md)
