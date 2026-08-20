# 域 08: 集合框架 — 知识规划

> 源码路径: java.base/share/classes/java/util/{Collection,List,Set,Queue,Iterator,ListIterator,Iterable,Abstract*,ArrayList,LinkedList,Vector,Stack,ArrayDeque,PriorityQueue,Arrays,Collections,RandomAccess,Deque,SortedSet,NavigableSet}.java + DualPivotQuicksort.java + ComparableTimSort.java
> 源码量: ~28 文件 / ~32,000 行 | 🔴 巨型域(>30K)
> 写作层: Layer 2(前置: 域 01/02/06)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| ArrayList.java (1760) | **动态数组**: elementData(136,Object[])、size(143)、DEFAULT_CAPACITY=10(116)、grow 扩容(497 add→ensureCapacityInternal→newCapacity 258,1.5x)、MAX_ARRAY_SIZE=Integer.MAX_VALUE-8(228)、fastRemove(669) | High |
| AbstractList.java (942) | **modCount**: `protected transient int modCount`(628)——结构性修改计数器,fail-fast 的基石 | High |
| ArrayList.java | **Itr 迭代器**: expectedModCount(557)+checkForComodification(603)——fail-fast 检测 | High |
| LinkedList.java (1266) | **双向链表**: Node<E>(87 附近,item/prev/next)、first(92)/last(97)、linkLast(144)/unlink 系列(175/194) | High |
| Vector.java (1516) | **同步动态数组**: 方法级 synchronized、capacityIncrement 增长策略、与 ArrayList 对比 | Medium |
| Stack.java (141) | **栈**: extends Vector、push/pop/peek(同步继承) | Low |
| ArrayDeque.java (1233) | **环形数组双端队列**: elements(111)/head(119)/tail(126)、addFirst(285)/pollFirst(377)、grow(141: 容量<64 时 +2 近似翻倍,否则 +50% jump 策略) | High |
| PriorityQueue.java (986) | **二叉堆**: queue(101,Object[])、offer(338)→siftUp(650)、poll→siftDown(691)、heapify(740) | High |
| Queue/Deque 接口 | 队列语义: offer/poll/peek(不抛异常)vs add/remove/element(抛异常);双端操作 | Medium |
| Arrays.java (8906) | **数组工具**: sort(146,基本类型 DualPivotQuicksort)/对象排序 ComparableTimSort、binarySearch、copyOf、asList、parallelSort(465)、toString | High |
| DualPivotQuicksort.java (3181) | **双轴快排**: 插入排序/双轴快排分段,阈值与切换 | Medium |
| ComparableTimSort.java (907) | **TimSort**: 归并排序变体,run 检测+二分插入,稳定 | Medium |
| Collections.java (5670) | **工具+包装器**: 三包装器(UnmodifiableCollection 1023/SynchronizedCollection 2000/CheckedCollection 3040)、reverse(378)/shuffle(425)、emptyList(4448)/singletonList(4822)、addAll(5503) | High |
| Set/Collection 接口 | 集合语义: 去重/元素相等契约(equals 语义) | Medium |

*14 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | ArrayList 扩容与动态数组 | 2 (ArrayList/AbstractList) | 面试必考(扩容 1.5x/默认 10/MAX_ARRAY_SIZE) |
| P1 | LinkedList 链表结构 | 1 (LinkedList) | 面试必考(结构/增删/与 ArrayList 对比) |
| P1 | fail-fast 与 modCount | 3 (ArrayList/AbstractList/AbstractCollection) | 面试常问(ConcurrentModificationException 原理) |
| P1 | PriorityQueue 二叉堆 | 1 (PriorityQueue) | 面试常问(堆原理/offer-poll 复杂度) |
| P2 | ArrayDeque 环形数组 | 1 | 面试偶尔(环形结构) |
| P2 | Arrays 排序算法 | 3 (Arrays/DPQ/TimSort) | 面试常问(排序稳定性/算法选择) |
| P2 | Collections 包装器 | 1 | 面试偶尔(三包装器/为什么不用 synchronized 容器) |
| P3 | Vector/Stack/接口族 | 5 | 面试低频(历史类) |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | ArrayList 扩容机制 | 面试必考(grow 1.5x 推导、DEFAULT_CAPACITY、扩容均摊) |
| 🔴 Deep | LinkedList 结构与对比 | 面试必考(节点/性能对比/ArrayList vs LinkedList 选型) |
| 🔴 Deep | fail-fast 迭代器 | 面试高频(CME 原理/modCount);生产(遍历时修改) |
| 🔴 Deep | PriorityQueue 堆 | 面试常问(小顶堆/offer-poll O(logn)/TopK) |
| 🟡 Working | ArrayDeque | 面试偶尔;生产(栈/队列替代 Stack) |
| 🟡 Working | Arrays 排序选择 | 面试常问(为什么对象用 TimSort、基本类型 DPQ、稳定性) |
| 🟢 Surface | Collections 包装器细节 | 使用层;checked 包装器面试偶尔 |

## 04 聚类

### 依赖图(域内)
```
Collection ←── List/Set/Queue ←── Abstract* 骨架类
List ←── ArrayList(数组)/LinkedList(链表)/Vector(同步)
AbstractList(modCount) ←── ArrayList(Itr fail-fast)
Deque ←── ArrayDeque(环形数组)
Queue ←── PriorityQueue(二叉堆)
Arrays(算法) ←── DualPivotQuicksort / ComparableTimSort
Collections(包装器) ←── 各集合的视图
```

### 教学顺序与文章拆分(6 篇,巨型域分段)

1. **ArrayList 与动态数组** — elementData/扩容 1.5x/默认容量/与域 01 StringBuilder 扩容对照
2. **LinkedList/Vector/Stack** — 双向链表结构/linkLast-unlink/同步 Vector/历史类定位
3. **ArrayDeque 与 PriorityQueue** — 环形数组双端队列、二叉堆 siftUp/siftDown/heapify、Queue 语义
4. **迭代器与 fail-fast** — modCount/expectedModCount/Itr/增强 for 底层/ListIterator
5. **Arrays 工具与排序** — DPQ vs TimSort 选择、binarySearch、copyOf/asList、parallelSort
6. **Collections 工具与包装器** — 三包装器/reverse-shuffle/empty-singleton

> 前置: 域 01(String hashCode/equals 支撑集合语义)、02。跨层: 无 native(纯 Java);性能话题衔接域 10 并发集合(ConcurrentModification vs 并发容器)
