# 03. ConcurrentSkipListMap 跳表 — 多层索引、无锁有序

> **前置依赖**: [10-concurrent-collections/02 — CHM 扩容与计数](02-resize-count.md)(CAS 协作思路)、[09-map-hash/03 — TreeMap](../09-map-hash/03-linkedhashmap-treemap.md)(红黑树对照)
> → **后续**: [04-copyonwrite-concurrentqueue.md](04-copyonwrite-concurrentqueue.md)
> 关联: [13-atomic/01 — 原子与 CAS](../13-atomic/01-atomicinteger-cas.md)(局部 CAS)

## 并发有序 Map 为什么选跳表

哈希并发解决的是"快"，但不解决"有序"。JDK 的答案不是并发红黑树，而是 `ConcurrentSkipListMap`。

## 1. "跳表是什么?" — 多层链表

### 1.1 两层节点

- `Node<K,V>`(`ConcurrentSkipListMap.java:359`)——底层全量有序链表节点
- `Index<K,V>`(`:373`)——上层索引节点,保存 `down/right/node`

结构上是 **底层全量链表 + 上层稀疏索引**。查找时先走高层 `right`,走不动再 `down`,最后落到底层。

### 1.2 为什么不是红黑树

跳表和红黑树查找的平均/期望复杂度都能做到 `O(log n)`,但跳表的并发修改更局部: 只改相邻指针,不需要像红黑树那样做旋转和平衡修复。

面试"跳表 vs 红黑树": 查找同阶,跳表实现更简单、并发更友好。

关键设计(斜体):*"跳表 = 有序链表 + 稀疏索引层"——查找走索引,落到底层命中;并发修改只动局部指针。面试"为什么跳表不用红黑树": 旋转复杂,无锁难做。*

## 2. "无锁怎么维护?" — CAS 链接

### 2.1 查找路径

- `findPredecessor`(`:464`)——从顶层索引一路向右/向下找前驱
- `findNode`(`:503`)——到底层后处理删除/marker 干扰
- `doGet`(`:536`)——只读查找,全程无锁
- `doPut`(`:595`)——插入

### 2.2 CAS 改指针

删除/修链的核心是相邻指针 CAS:

- `NEXT.compareAndSet`(`:421`/`:427`)——底层链表改 `next`
- `RIGHT.compareAndSet`(`:475`)——索引层改 `right`

失败就重试,不拿全局锁。

### 2.3 marker 删除法

源码长注释(`:199-207`)把删除拆成三步:

1. 逻辑删除节点值
2. CAS 把待删节点 `n` 的 `next` 指向一个 **marker** 节点
3. CAS 前驱 `b.next` 越过 `n` 和 marker

这不是 ABA 理论课版本的标记位,而是工程上的**显式 marker 节点**。

面试"无锁跳表怎么删": marker 标记 + 相邻 CAS 重试。

关键设计(斜体):*"跳表的并发 = 局部 CAS"——每层只动相邻指针,失败就重试;marker 节点把删除拆成可恢复的多步。面试"CAS 链入失败怎么办": 重试(乐观并发)。*

## 3. "有序 API" — 并发下的范围操作

### 3.1 有序能力

因为底层始终有序,它天然支持:

- `firstKey` / `lastKey`
- `floorEntry` / `ceilingEntry`
- `subMap` / `headMap` / `tailMap`

`findFirst`(`:829`)与 `findFirstEntry`(`:845`)就是最左侧首元素路径。

### 3.2 一致性边界

这些遍历与范围查询是**弱一致**的: 遍历期间其他线程的插入/删除不保证形成全局一致快照,但不会破坏有序结构。

面试"ConcurrentSkipListMap vs TreeMap": 并发安全 + 弱一致遍历 vs 单线程强结构操作。

关键设计(斜体):*"有序性 + 并发性"是跳表的双卖点——范围查询保留有序 Map 的优势,并发修改仍走局部 CAS。面试"并发有序场景": 用 ConcurrentSkipListMap,不是给 TreeMap 外面硬套锁。*

## 4. "ConcurrentSkipListSet" — 集合包装

### 4.1 本质

`ConcurrentSkipListSet` 只是对 `ConcurrentSkipListMap` 的包装:

- 类在 `ConcurrentSkipListSet.java:95`
- 注释明确"Uses `Boolean.TRUE` as value for each element"(`:102`)
- 默认构造里直接 `new ConcurrentSkipListMap<E,Object>()`(`:113`)

### 4.2 语义

所以它提供的是: **有序 + 并发 + 去重**。这和 `HashSet` 包 `HashMap` 是同构思路,只是底座换成了跳表 map。

面试"并发有序 Set": `ConcurrentSkipListSet`。

关键设计(斜体):*"Set = Map 的视图包装"——和 HashSet/HashMap 同构,只是底层从哈希表换成了并发跳表。面试"并发有序 Set": ConcurrentSkipListSet。*

## 核心悬念

有序并发通了——**读多写少**呢?`CopyOnWriteArrayList` 的"写时复制"怎么让读完全无锁?`ConcurrentLinkedQueue` 的 CAS 链接又是什么样?——下一篇: CopyOnWrite 与无锁队列。

> → [04-copyonwrite-concurrentqueue.md](04-copyonwrite-concurrentqueue.md)