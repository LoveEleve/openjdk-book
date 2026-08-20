# 08-collections/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ArrayDeque`、`PriorityQueue`、`Queue` / `Deque` 接口语义。本文聚焦环形数组与二叉堆机制，不展开并发队列、`TreeSet` 或完整排序理论。
> 目标：把“ArrayDeque 与 PriorityQueue”改写成一篇围绕“为什么它们分别成为现代 Java 的默认栈/双端队列和默认优先级结构”的机制文章，并顺带把 `Queue` / `Deque` 的双套 API 契约讲清楚。

## 1. 读者困惑

- `ArrayDeque` 明明底层还是数组，为什么 `addFirst` 不需要整体搬移？
- “环形数组”到底是什么意思，为什么 `head` / `tail` 回绕后还能继续工作？
- `head == tail` 到底表示空还是满？JDK 如何区分？
- `ArrayDeque` 为什么通常比 `LinkedList` 更适合做栈和队列？
- `PriorityQueue` 为什么叫“优先队列”，却不能保证整体有序遍历？
- `offer` / `poll` 为何是 O(log n)`，而 `peek` 却是 O(1)`？
- `add/remove/element` 与 `offer/poll/peek` 这两套方法到底什么时候该选哪一套？

## 2. 一句话顿悟

**ArrayDeque 用“环形数组 + 头尾指针”把头尾操作从数组搬移问题改写成指针回绕问题；PriorityQueue 用“数组里的二叉堆”把找极值从线性扫描改写成局部堆序维护问题。它们快，不是因为神秘，而是因为都只维护自己真正关心的那一部分有序性。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `ArrayDeque` 的 `elements/head/tail`、`dec`、`addFirst`、满员判定与扩容。
- 已覆盖 `PriorityQueue` 的数组堆、`offer` 上浮、`poll` 下沉、`heapify` O(n)。
- 已有 `Queue` / `Deque` 两套 API 语义与下一篇 fail-fast 的承接。

### 必须重写

- 旧稿仍偏答案式罗列，需要先建立两个应用问题：为什么 `LinkedList` 的头尾操作今天常被 `ArrayDeque` 取代；为什么 TopK/调度不会用全排序结构起步。
- `ArrayDeque` 需要更明确说明“数组仍然连续，但逻辑顺序已经绕环”，以及为何空槽位总保留在 `tail`。
- 旧稿里还有 JDK8 掩码与 2 的幂的旧心智，需要在 JDK 11 语境下说明现在是条件回绕，不要留下错误印象。
- `PriorityQueue` 需要把“部分有序”讲透：只保证根最小，不保证迭代顺序。
- `Queue` / `Deque` 的双套 API 需要从“失败怎么表达”这个统一问题切入，而不是只背表格。

## 4. 理解路径

### 第一节：先从两个标准问题开场

- 栈/双端队列为什么现代 Java 首选 `ArrayDeque`，而不是 `Stack` / `LinkedList`？
- 持续取最小值或维护 TopK，为什么首选 `PriorityQueue`，而不是每次排序？

让读者先知道两者不是“又两个集合类”，而是两个标准解法。

### 第二节：ArrayDeque 为什么能让数组支持头尾 O(1)

证据：
- `ArrayDeque.java:107-126`：`elements`、`head`、`tail` 字段注释
- `ArrayDeque.java:218-230`：`inc` / `dec`
- `ArrayDeque.java:285-291`：`addFirst`
- `ArrayDeque.java:302-308`：`addLast`
- `ArrayDeque.java:377-395`：`pollFirst` / `pollLast`

主线：
- 普通数组头插痛在整体搬移；环形数组把“逻辑头尾”从物理数组起点解耦。
- `head` 指向当前第一个元素，`tail` 指向下一个尾插位置，逻辑顺序可以跨数组末尾再回到开头。
- `inc` / `dec` 只是把越界修正为回绕。
- `poll` 后置 null，和 ArrayList 一样是为了释放引用。

### 第三节：空和满都可能 `head == tail`，JDK 怎么拆歧义

证据：
- `ArrayDeque.java:107-126` 字段注释里已说明 `tail` 位置总为空
- `ArrayDeque.java:141-160`：`grow` 中的 `tail < head || (tail == head && es[head] != null)`

主线：
- 环形结构下单看头尾指针不够，因为走一圈后它们会重合。
- JDK 的策略是始终保留至少一个空槽位，并用 `es[head] != null` 参与区分“空”与“满”。
- 一旦真满，扩容时还要把已经回绕的前半段挪到新数组尾部，让逻辑顺序在更大数组里重新排开。

### 第四节：ArrayDeque 为什么常胜过 LinkedList

证据：
- `ArrayDeque.java:141-160`：扩容与搬移只在必要时发生
- 对照上一章 `LinkedList` 的 Node 对象与走链成本

主线：
- 两者都能做头尾 O(1) 语义，但 ArrayDeque 的底层是连续数组，没有 Node 包装开销。
- 真正的代价从“每次操作都改指针/分配节点”变成“偶尔扩容复制一次”。
- 这正是现代 JVM 和 CPU 更喜欢的成本结构。

### 第五节：PriorityQueue 的堆结构到底只保证了什么

证据：
- `PriorityQueue.java:94-101`：堆定义与最小值在 `queue[0]`
- `PriorityQueue.java:101-112`：`queue` / `comparator`
- `PriorityQueue.java:338-347`：`offer`
- `PriorityQueue.java:350-352`：`peek`
- `PriorityQueue.java:586-604`：`poll`
- `PriorityQueue.java:650-668`：`siftUpComparable`
- `PriorityQueue.java:698-715`：`siftDownComparable`
- `PriorityQueue.java:740-750`：`heapify`

主线：
- 它不是“有序数组”，而是“数组表示的完全二叉树”。
- 只要求每个父节点不大于子节点，所以根一定最小；除此之外，兄弟之间、不同子树之间不保证全序。
- 这解释了为什么 `peek` 只看 `queue[0]` 就行，而遍历整个堆却看不到全局升序。

### 第六节：为什么 `offer/poll` 是 O(log n)`，`heapify` 却是 O(n)`

主线：
- `offer` 把新元素放尾部，再沿父链上浮。
- `poll` 把尾元素提到根，再沿较小子节点方向下沉。
- 路径长度只与树高相关，因此是 O(log n)。
- 从一个已有集合构造堆时，`heapify` 从最后一个非叶节点开始整体下沉，总代价是 O(n)，不是把每个元素逐个 `offer` 的 O(n log n)。

### 第七节：Queue / Deque 两套 API 的真正设计意图

从统一问题切入：失败时，到底是抛异常，还是返回一个特殊值交给调用方判断？

- `add/remove/element`：失败视为异常情况
- `offer/poll/peek`：失败交给返回值表达

再接到 `Deque`：把这套语义复制到头尾两端。

### 第八节：收束到选型与下一篇

- 栈 / 双端队列：ArrayDeque
- 极值优先 / TopK / 调度：PriorityQueue
- 需要阻塞或容量控制：并发队列家族，后续再讲

自然引到迭代器和 fail-fast。

## 5. 失败方案清单

1. 认为数组做队头插入一定要整体搬移，因此忽略环形数组。
2. 以为 `head == tail` 只可能表示空。
3. 把 `ArrayDeque` 的物理数组顺序误当成逻辑队列顺序。
4. 看到 `PriorityQueue` 名字就以为遍历结果天然有序。
5. 用 `PriorityQueue` 做“有序集合”替代 `TreeSet`。
6. 逐个 `offer` 大集合却不知道批量建堆可 O(n)` 完成。
7. 在“容量可能打满”的语义里随手用 `add`，却没有处理失败方式。

## 6. 误解清单

1. ArrayDeque 的“环形”意味着底层不是数组；其实仍然是普通数组。
2. JDK 11 的 ArrayDeque 仍然必须维持 2 的幂长度并靠位与回绕。
3. ArrayDeque 头尾 O(1) 意味着绝对不复制；扩容时仍可能整体搬移。
4. PriorityQueue 内部是全序数组。
5. `peek()` 既然 O(1)，那遍历也应该接近有序。
6. `offer` 和 `add` 只是命名不同，没有语义差别。
7. `poll` 返回 `null` 只是“更懒”，不是刻意的契约设计。

## 7. 证据清单

- `ArrayDeque.java:107-126`：`elements` / `head` / `tail`
- `ArrayDeque.java:141-160`：`grow` 与满员判定、回绕搬移
- `ArrayDeque.java:218-230`：`inc` / `dec`
- `ArrayDeque.java:285-291`：`addFirst`
- `ArrayDeque.java:302-308`：`addLast`
- `ArrayDeque.java:377-395`：`pollFirst` / `pollLast`
- `PriorityQueue.java:94-101`：堆语义与根最小
- `PriorityQueue.java:101-112`：`queue` / `comparator`
- `PriorityQueue.java:296-306`：增长策略
- `PriorityQueue.java:338-347`：`offer`
- `PriorityQueue.java:350-352`：`peek`
- `PriorityQueue.java:586-604`：`poll`
- `PriorityQueue.java:650-668`：`siftUpComparable`
- `PriorityQueue.java:698-715`：`siftDownComparable`
- `PriorityQueue.java:740-750`：`heapify`

## 8. 版本与边界

- 基于 JDK 11；ArrayDeque 的回绕实现按 JDK 11 当前源码解释，不再沿用 JDK 8 的旧掩码心智。
- 不展开 `PriorityBlockingQueue`、`BlockingQueue` 或调度线程池内部实现。
- 不展开 `TreeSet` / 红黑树，只在对比处点到“全序 vs 极值优先”的结构差异。
- 不在本文展开 fail-fast 迭代器与遍历行为，留到下一篇。

## 9. 删除代码测试与最终验收标准

- 删除源码块后，读者仍能复述“ArrayDeque 用环形数组把头尾操作变成回绕问题 → 满员靠空槽位/判据拆歧义 → 扩容时重排回绕段 → PriorityQueue 只维护堆顶极值 → offer/poll 沿树高调整 → heapify 从底向上 O(n) → Queue/Deque 用两套 API 表达失败语义”。
- 必须明确 `ArrayDeque` 的逻辑顺序和物理数组顺序可以不同。
- 必须明确 `PriorityQueue` 是部分有序，不是全序。
- 必须解释 `offer/poll/peek` 与 `add/remove/element` 的契约差别，而不只是列方法名。
- 结尾要自然引到 `04-iterator-failfast.md`。
