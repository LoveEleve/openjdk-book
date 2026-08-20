# 08-collections/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ArrayList`、`Collection`、`List`、`Map`、`Collections`。本文聚焦 `ArrayList` 作为动态数组的机制，不展开 `HashMap`、并发集合和排序实现细节。
> 目标：把“ArrayList 扩容机制”从记忆型面试题，改写成一篇围绕“为什么默认不分配、为什么 1.5x、为什么删除不缩容、为什么 toArray/subList 是相反设计”的机制闭环文章。

## 1. 读者困惑

- `new ArrayList()` 到底有没有立刻分配 10 个槽位？
- `size` 和数组长度为什么不是一个概念？
- 扩容为什么是 1.5 倍，不是 2 倍？
- `remove` 为什么经常慢，为什么“倒着删”有用？
- `trimToSize()` 为什么不是默认行为？
- `toArray()` 为什么要复制，`subList()` 为什么又选择共享视图？
- ArrayList 和 LinkedList 到底该怎么选，为什么现代 Java 几乎总是优先 ArrayList？

## 2. 一句话顿悟

**ArrayList 的本体是“逻辑大小 `size` + 可增长数组 `elementData`”的分离设计：默认构造先不分配，首次写入才扩到默认容量；后续用 1.5x 扩容平衡复制成本与空间浪费；删除只搬移不缩容，从而把动态数组的优势集中在随机访问和尾部追加。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `elementData`/`size`、懒分配、1.5x 扩容、`fastRemove`、`toArray`、`subList`。
- 已点出 `new ArrayList()` 与 `new ArrayList(0)` 区别，以及 `remove` 不缩容的事实。
- 已有 `Arrays.copyOf` / `System.arraycopy` 与前文系统运行时的串联。

### 必须重写

- 旧稿太像“面试答案列表”，需要先建立“动态数组为什么要把容量和逻辑大小分开”的主问题。
- `Collection`/`List` 框架层语义几乎没接上，需要用总览视角交代为什么集合不是直接暴露数组。
- `1.5x` 的取舍应该从“空间浪费 vs 复制次数”的设计张力展开，而不只是公式记忆。
- `remove`、`trimToSize`、`toArray`、`subList` 需要串成“复制 vs 共享、速度 vs 内存”的统一主线。
- 结尾应把读者自然带到 `LinkedList/Vector/Stack`，形成“为什么下一篇必须谈链表”的收束。

## 4. 理解路径

### 第一节：先建立集合框架里 ArrayList 的位置

从 `Collection` / `List` 的抽象出发：Java 集合不是“直接操作数组”，而是先定义元素组织方式与操作契约，再由 ArrayList 选择数组作为底层存储。

证据：
- `Collection.java:34-41`：`Collection` 是层次根接口
- `List.java:31-39`：`List` 是有序、可重复、按索引访问的 sequence

目标：让读者先知道“ArrayList 不是数组语法糖，而是 List 契约的一种实现”。

### 第二节：ArrayList 本体为什么是 `elementData + size`

证据：
- `ArrayList.java:166-168`：默认构造只放共享空数组
- `ArrayList.java:152-160`：指定容量构造
- `ArrayList.java:197-203`：`trimToSize`
- `ArrayList.java:458-460`：`get(int)` 直接按下标访问

主线：
- `size` 是逻辑元素数，不等于底层数组长度。
- 默认构造不预先分配 10，是为了避免大量空列表造成堆浪费。
- `get` 的 O(1) 随机访问，来自数组下标，不来自集合接口本身。

失败方案：把 `new ArrayList()` 理解成“总是马上 new Object[10]”。

### 第三节：首次写入和后续扩容为什么分两套逻辑

证据：
- `ArrayList.java:237-244`：`grow`
- `ArrayList.java:255-269`：`newCapacity`
- `ArrayList.java:260-261`：默认空数组首次扩到 `DEFAULT_CAPACITY`
- `ArrayList.java:497-500`：`add(E)`

先拆两步：
1. 默认构造首次 `add` 不是 1.5x，而是从共享空数组跳到默认容量。
2. 后续才进入 `old + old/2` 的常规增长。

设计张力：
- 2x：扩容次数更少，但空闲浪费更大。
- 1.5x：扩容次数略多，但峰值冗余更小。
- 任意大于 1 的增长因子都能得到均摊 O(1)，但常数不同。

### 第四节：为什么删除只搬移，不自动缩容

证据：
- `ArrayList.java:535-540`：`remove(int)`
- `ArrayList.java:670-674`：`fastRemove`
- `ArrayList.java:197-203`：`trimToSize`

主线：
- 删除的代价来自元素搬移，不是“删除语句本身”。
- 尾删近似 O(1)，头删/中删要移动后缀，最坏 O(n)。
- 自动缩容会导致增删抖动，所以默认不做；真正需要缩容时显式调用 `trimToSize()`。

失败方案：把动态数组设计成“每删一个元素就缩一次容量”。

### 第五节：为什么 `toArray` 复制，`subList` 却共享

证据：
- `ArrayList.java:400-402`：`toArray()`
- `ArrayList.java:430-436`：`toArray(T[])`
- `Collection.java:111-128`：view collections 概念

主线：
- `toArray()` 的目的是隔离内部存储，防止外部改数组破坏列表不变量。
- `subList()` 的目的是在不复制大段元素的前提下，给出一个窗口视图；共享带来效率，也带来结构修改联动和 fail-fast 风险。
- 这两者正好代表集合 API 中“防御性复制”和“背靠视图”的两种相反策略。

### 第六节：ArrayList 为什么常常比 LinkedList 更合适

利用 `List.java:50-56`、`64-67` 与 `Collections.java:192-197` / `216-219` 的语义：
- `List` 的按索引访问对某些实现可能线性退化。
- `Collections.binarySearch` 对非 `RandomAccess` 且大列表会退回 iterator 路径。

目标：把读者带到下一篇问题：链表不是“增删天然更快”，因为定位成本和缓存局部性会吞掉理论优势。

## 5. 失败方案清单

1. 把 `new ArrayList()` 当成“立刻分配 10 个格子”。
2. 把 `size` 当成当前数组长度。
3. 把首次扩容和常规 1.5x 扩容混为一谈。
4. 每次删除后自动缩容，导致频繁复制抖动。
5. 认为 `remove` 慢是因为“GC”，而不是因为大段元素搬移。
6. 误把 `toArray()` 返回值当作内部数组引用。
7. 误把 `subList()` 当成独立副本，而不是共享视图。
8. 简化成“LinkedList 增删快，所以更适合大部分业务”。

## 6. 误解清单

1. `DEFAULT_CAPACITY = 10` 等于默认构造时已经分配长度 10 的数组。
2. ArrayList 的扩容策略从第一次添加开始就总是 1.5x。
3. `remove` 后列表会自动把底层数组缩小。
4. `trimToSize()` 只是逻辑上的 size 变更；它会真实复制数组。
5. `toArray()` 返回的是内部数组，因此改数组会影响列表。
6. `subList()` 总是安全独立；实际上它背靠原列表。
7. LinkedList 中间插入一定更快；忽略了先定位节点的 O(n)。

## 7. 证据清单

- `Collection.java:34-41`：根接口定位
- `Collection.java:111-128`：view collections 概念
- `List.java:31-39`：有序、可重复
- `List.java:50-56`：索引访问可能与实现相关
- `List.java:64-67`：搜索可能线性
- `Collections.java:192-197`：`binarySearch` 对 `RandomAccess` 的性能语义
- `ArrayList.java:152-160`：指定容量构造
- `ArrayList.java:166-168`：默认构造懒分配
- `ArrayList.java:197-203`：`trimToSize`
- `ArrayList.java:237-244`：`grow`
- `ArrayList.java:255-269`：`newCapacity`
- `ArrayList.java:400-402`：`toArray()`
- `ArrayList.java:430-436`：`toArray(T[])`
- `ArrayList.java:458-460`：`get(int)`
- `ArrayList.java:497-500`：`add(E)`
- `ArrayList.java:535-540`：`remove(int)`
- `ArrayList.java:670-674`：`fastRemove`

## 8. 版本与边界

- 基于 JDK 11；`subList` 的内部细节不展开完整内部类代码，只讲共享视图与结构修改联动语义。
- 不在本文展开 `modCount` / fail-fast 的完整机制，留到 `04-iterator-failfast.md`。
- 不展开 `Arrays.sort` / TimSort、`HashMap`、并发集合，这些留给后续篇章。
- `RandomAccess` 在本文只用于解释 ArrayList 与 LinkedList 的算法偏好，不做接口史考证。

## 9. 删除代码测试与最终验收标准

- 删除源码块后，读者仍能复述“List 契约 → `elementData + size` → 懒分配 → 首次默认扩到 10 → 后续 1.5x → 删除搬移不缩容 → `toArray` 复制 / `subList` 共享 → 为什么 ArrayList 常优于 LinkedList”。
- 必须把首次扩容与常规 1.5x 分开说明。
- 必须解释 `trimToSize()` 为什么不是默认策略。
- 必须说明 `toArray()` 与 `subList()` 是两种相反的 API 设计哲学。
- 结尾要自然引向 `02-linkedlist-vector.md`。
