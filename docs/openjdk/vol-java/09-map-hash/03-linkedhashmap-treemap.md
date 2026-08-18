# 03. LinkedHashMap 与 TreeMap — 插入/访问序、LRU、红黑树

> **前置依赖**: [09-map-hash/01 — HashMap 存储](01-hashmap-storage-hash.md)、[09-map-hash/02 — 扩容与树化](02-resize-treeify.md)(HashMap 机制)
> → **后续**:[09-map-hash/04 — Map 家族与选型](04-map-family.md)
> 关联: 域 10(ConcurrentSkipListMap 并发有序替代)

## 顺序 Map 双雄

HashMap 无序——但业务要有序。**LinkedHashMap**(插入/访问序)和 **TreeMap**(按键排序)是顺序 Map 双雄: 前者是"HashMap + 双向链",后者是红黑树。这篇讲 LinkedHashMap 的顺序机制与 LRU 实现、TreeMap 的红黑树保证与 NavigableMap 有序操作。

## 1. "LinkedHashMap 怎么保持顺序" — 双向链

### 1.1 HashMap + 一条链

`LinkedHashMap`(`java/util/LinkedHashMap.java`,755 行)的结构: **在 HashMap 之上多了一条贯穿所有 Entry 的双向链**(`LinkedHashMap.java:204`/`209`):

```java
// LinkedHashMap.java:204 + 209 + 217(截取核心,逐字)
transient LinkedHashMap.Entry<K,V> head;

transient LinkedHashMap.Entry<K,V> tail;

final boolean accessOrder;
```

- `head`/`tail`:全局双向链表(每个 Entry 多 before/after 指针)
- `accessOrder`(@217):**false = 插入序(默认),true = 访问序**

哈希语义完全不变——HashMap 的桶/树结构照旧,额外一条链记录顺序。

### 1.2 两个钩子

顺序维护靠 HashMap 留给子类的钩子方法:

- `afterNodeAccess`(`LinkedHashMap.java:305`,注释 "move node to last"):**get 命中时把节点移到尾部**——accessOrder=true 时每次访问刷新顺序
- `afterNodeInsertion`(`LinkedHashMap.java:297`,注释 "possibly remove eldest"):插入后检查淘汰

关键设计(斜体):*LinkedHashMap = HashMap + 双向链——"额外一条链记录顺序",哈希语义不变;accessOrder=true 时每次 get 把节点移到尾部——**LRU 的天然结构**。面试"LinkedHashMap 默认有序?": 插入序;要访问序必须 `new LinkedHashMap<>(..., true)`。*

## 2. "LRU 缓存怎么实现" — removeEldestEntry 钩子

### 2.1 钩子机制

`afterNodeInsertion`(`LinkedHashMap.java:297-303`):

```java
// LinkedHashMap.java:297-303(截取核心,逐字)
void afterNodeInsertion(boolean evict) { // possibly remove eldest
    LinkedHashMap.Entry<K,V> first;
    if (evict && (first = head) != null && removeEldestEntry(first)) {
        K key = first.key;
        removeNode(hash(key), key, null, false, true);
    }
}
```

每次 put 后检查头部:`removeEldestEntry(first)` 返回 true → **移除头部**。默认实现返回 false(`LinkedHashMap.java:508-510`);子类覆写即可定义淘汰策略。

### 2.2 LRU 三行代码

**accessOrder=true(访问序)+ 覆写 removeEldestEntry = 完整 LRU**:

```java
class LRU<K,V> extends LinkedHashMap<K,V> {
    private final int cap;
    LRU(int cap) { super(cap, 0.75f, true); this.cap = cap; }  // 访问序
    @Override
    protected boolean removeEldestEntry(Map.Entry<K,V> eldest) {
        return size() > cap;
    }
}
```

机制闭环: 访问序下 get 即把节点移到尾部(最常访问的在尾),头部永远是最久未访问——满了淘汰头部。

关键设计(斜体):*"LRU 三行代码"的底层: afterNodeInsertion 在每次 put 后检查一次头部——头 = 最久未访问(访问序下)。生产注意: 并发场景要包装(synchronizedMap 或 ConcurrentHashMap,域 10)。*

## 3. "TreeMap 是什么结构" — 红黑树

### 3.1 结构

`TreeMap`(`java/util/TreeMap.java`,3012 行)的核心(`TreeMap.java:121`/`123`):

```java
// TreeMap.java:121 + 123(截取核心,逐字)
private final Comparator<? super K> comparator;

private transient Entry<K,V> root;
```

**红黑树根 + 比较器**(自然序或自定义)。

### 3.2 操作与平衡

- `put`(`TreeMap.java:533`):二叉搜索插入 → `fixAfterInsertion`(`TreeMap.java:2254`,**红黑树修复:变色+旋转**)
- `rotateLeft`(`TreeMap.java:2218`)/`rotateRight`(`TreeMap.java:2237`):旋转操作
- `getEntry`(340)/`getEntryUsingComparator`(367):查找

**红黑树保证: 插入/删除/查找最坏 O(log n)**——自平衡二叉搜索树。

关键设计(斜体):*红黑树 vs HashMap: **有序性 vs 常数时间**的取舍(HashMap 平均 O(1) 最坏 O(n))。红黑树 vs AVL: 红黑树平衡要求松(黑高平衡),插入删除旋转少;AVL 更严格(高度差≤1),查找快但维护重——JDK 选红黑树。面试讲到"红黑树五性质"即可。*

## 4. "TreeMap 的 API" — NavigableMap 有序操作

### 4.1 范围操作

`TreeMap` 实现 `NavigableMap`(`TreeMap.java:111` 的类声明;接口在 `NavigableMap.java:97`):

- `firstKey()`(`TreeMap.java:288` → `getFirstEntry`@2122)/lastKey
- `floorEntry(key)`(`TreeMap.java:718`)/`ceilingEntry`(`TreeMap.java:740`):≤/≥ 的最近 entry
- `subMap(from, to)`(`TreeMap.java:908`):范围视图

### 4.2 选型

| 需求 | 选型 |
|------|------|
| 无序高频存取 | HashMap(均摊 O(1)) |
| 有序范围查询 | TreeMap(O(log n) 的 floor/ceiling) |
| 插入/访问序 | LinkedHashMap |

关键设计(斜体):*有序 Map 的核心价值是"范围操作 O(logn)"——floor/ceiling 一次树查找;HashMap 做不到。面试"TreeMap vs HashMap 复杂度": 树 log n vs 哈希均摊 1——有序性选型。*

## 核心悬念

Map 家族还有"特种兵": **WeakHashMap 的弱 key 会自己消失**、IdentityHashMap 用 == 比较、EnumMap 用数组——它们各自的适用场景与陷阱?Hashtable 为什么是历史遗留?——下一篇: Map 家族与选型。

> → [09-map-hash/04 — Map 家族与选型](04-map-family.md)
