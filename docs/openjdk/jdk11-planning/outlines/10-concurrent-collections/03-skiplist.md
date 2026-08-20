# 03. ConcurrentSkipListMap 跳表 — 多层索引、无锁有序

> 🟡 Working | 域 10 并发集合第 3 篇(巨型域 6 篇之三)| Layer 5
> 读者处境: 面试"并发有序 Map 用什么"——跳表结构与无锁设计,与红黑树对照。

### 1. "跳表是什么？" — 多层链表

场景: 有序 Map 的并发版为什么用跳表不用红黑树?

- `ConcurrentSkipListMap.java:359` `Node<K,V>`(基础层)+ `373` `Index<K,V>`(**多层索引**: 每层是链表的"跳跃指针")
- 结构: 底层全量有序链表 + 上层稀疏索引(每层减半)——**查找 O(logn)**
- 关键设计 (斜体): *"跳表 = 有序链表 + 随机化索引层"——插入时随机决定层数;与红黑树对比: 结构简单(节点少指针)、**无锁好做**(局部 CAS);面试"为什么跳表不用红黑树"——并发锁难、旋转复杂*
- 面试: "跳表 vs 红黑树"——查找同 O(logn);跳表实现简单+并发友好(Redis ZSET 同选跳表)
- [关联: 域 09 TreeMap 红黑树对照]

### 2. "无锁怎么维护？" — CAS 链接

场景: 并发插入——多层索引怎么改?

- `doPut`(`ConcurrentSkipListMap.java:595`): 逐层查找定位 → **VarHandle NEXT.compareAndSet 原子链入**(421/427,JDK9+ 用 VarHandle 替代 Unsafe 偏移)
- `doGet`(536): 从顶层索引向下查 → 底层链表顺序走——**只读无锁**
- 标记删除: 节点 "marker" 标记(删除中)——防 ABA 的工程处理
- 关键设计 (斜体): *"跳表的并发 = 局部 CAS"——每层只动相邻指针(域 13 CAS);对比红黑树旋转(全局性修改);面试"无锁跳表怎么删"——marker 标记法*
- 面试: "CAS 链入失败?"——重试(乐观);删除与插入竞争由 marker 协调

### 3. "有序 API" — 并发下的范围操作

场景: 并发场景要 floor/ceiling/范围遍历——跳表提供什么?

- 有序 API: firstKey/lastKey/floorEntry/ceilingEntry/subMap(与域 09 TreeMap 同接口族)
- `findFirst`(829)/`findFirstEntry`(845)
- 遍历一致性: 弱一致(遍历期间修改可见性不保证)
- 关键设计 (斜体): *"有序性 + 并发性"是跳表的双卖点——范围查询 O(logn+范围大小);面试"并发有序场景"——ConcurrentSkipListMap(有锁 TreeMap 的替代)*
- 面试: "ConcurrentSkipListMap vs TreeMap"——并发安全 vs 单线程;遍历弱一致

### 4. "ConcurrentSkipListSet" — 集合包装

场景: 并发有序 Set——实现是什么?

- `ConcurrentSkipListSet.java:524` — **包装 ConcurrentSkipListMap**(值用 Boolean.TRUE 占位)
- 语义: 有序 + 并发 + 去重
- 关键设计 (斜体): *"Set = Map 的视图包装"——与域 09 HashSet 包 HashMap 同构;面试"并发有序 Set"——SkipListSet(唯一自带有序的并发 Set)*
- 生产: 排行榜/有序去重并发场景

---

### 核心悬念

有序并发通了——**读多写少**呢?`CopyOnWriteArrayList` 的"写时复制"怎么让读完全无锁?`ConcurrentLinkedQueue` 的 CAS 链接又是什么样?——下一篇: CopyOnWrite 与无锁队列。

> → [04-copyonwrite-concurrentqueue.md](04-copyonwrite-concurrentqueue.md)
