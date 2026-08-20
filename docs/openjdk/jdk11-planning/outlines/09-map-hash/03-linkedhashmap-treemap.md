# 03. LinkedHashMap 与 TreeMap — 插入/访问序、LRU、红黑树

> 🔴 Deep | 域 09 Map 与哈希第 3 篇 | Layer 3
> 读者处境: 面试"实现 LRU 缓存"经典题;TreeMap 的有序性怎么保证——顺序 Map 双雄一次讲清。

### 1. "LinkedHashMap 怎么保持顺序？" — 双向链

场景: `new LinkedHashMap<>()` 遍历顺序 = 插入顺序——内部结构多出什么?

- `LinkedHashMap.java:204/209` — `transient head/tail` — **全局双向链表**(贯穿所有 Entry)
- `LinkedHashMap.java:217` — `final boolean accessOrder` — false=插入序,true=**访问序**
- 每个 Entry 多 before/after 指针(插入链表);链表操作钩子: `afterNodeAccess`(310 附近,访问后移到尾部)/`afterNodeInsertion`(299,插入后检查淘汰)
- 关键设计 (斜体): *LinkedHashMap = HashMap + 双向链——"额外一条链记录顺序",哈希语义不变;accessOrder=true 时每次 get 把节点移到尾部——**LRU 的天然结构***
- 面试: "LinkedHashMap 默认有序?"——插入序;要访问序必须 `new LinkedHashMap<>(..., true)`

### 2. "LRU 缓存怎么实现？" — removeEldestEntry 钩子

场景: 面试"手写 LRU 缓存"——LinkedHashMap 的答案

- `LinkedHashMap.java:299` `afterNodeInsertion`: `removeEldestEntry(first)` 返回 true → **移除头部(最久未访问)**
- `removeEldestEntry` 默认 false(不淘汰);子类覆写:`size() > capacity` 时返回 true
- 组合: `accessOrder=true`(访问序)+ 覆写 removeEldestEntry = **完整 LRU**(get 即刷新,满即淘汰)
- 关键设计 (斜体): *"LRU 三行代码"的底层: afterNodeInsertion 在每次 put 后检查一次头部——头 = 最久未访问(访问序下);面试写:
  ```java
  class LRU<K,V> extends LinkedHashMap<K,V> {
      protected boolean removeEldestEntry(Map.Entry e) { return size() > CAP; }
  }
  ```
  构造传 accessOrder=true*
- 生产: 缓存容量预估(CAP)、并发用 Collections.synchronizedMap 包装或 ConcurrentHashMap(域 10)

### 3. "TreeMap 是什么结构？" — 红黑树

场景: `TreeMap` 按键有序——底层树结构保证什么复杂度?

- `TreeMap.java:123` — `private transient Entry<K,V> root` — **红黑树根**
- `TreeMap.java:121` — `private final Comparator` — 自然序或比较器
- `TreeMap.java:533` `put` → 二叉搜索插入 → `fixAfterInsertion`(`2254`,红黑树修复: 变色+旋转)
- `TreeMap.java:2218/2237` — `rotateLeft/rotateRight` — 旋转操作
- `getEntry`(340)/`getEntryUsingComparator`(367)
- 关键设计 (斜体): *红黑树保证: 插入/删除/查找 O(logn) 最坏——"自平衡二叉搜索树";对比 HashMap(平均 O(1) 最坏 O(n)): **有序性 vs 常数时间**的取舍;fixAfterInsertion 是平衡维护(变色+旋转),算法细节面试讲到"红黑树五性质"即可*
- [算法: 红黑树五性质(节点红/黑、根黑、叶黑、红子黑、黑高相等——平衡保证);关联: 域 10 ConcurrentSkipListMap(并发有序替代)]
- 面试: "红黑树 vs AVL"——红黑树平衡要求松(黑高平衡),插入删除旋转少;AVL 更严格(高度差≤1),查找快但维护重——JDK 选红黑树

### 4. "TreeMap 的 API" — NavigableMap 有序操作

场景: 生产"取最小的 key/范围遍历"——TreeMap 的独有能力

- `firstKey()`(288)/lastKey、`ceilingEntry/floorEntry`(≥/≤ 最近)、`subMap(from, to)` 视图
- SortedMap/NavigableMap 接口(284/426 行)
- 应用: 范围查询、排行榜、区间调度
- 关键设计 (斜体): *有序 Map 的核心价值是"范围操作 O(logn)"——floor/ceiling 一次树查找;HashMap 做不到;生产选型: 无序高频→HashMap,有序范围→TreeMap,插入序→LinkedHashMap*
- 面试: "TreeMap vs HashMap 复杂度"——树 logn vs 哈希均摊 1;有序性选型

---

### 核心悬念

Map 家族还有"特种兵": **WeakHashMap 的弱 key 会自己消失**、IdentityHashMap 用 == 比较、EnumMap 用数组——它们各自的适用场景与陷阱?Hashtable 为什么是历史遗留?——下一篇: Map 家族与选型。

> → [04-map-family.md](04-map-family.md)
