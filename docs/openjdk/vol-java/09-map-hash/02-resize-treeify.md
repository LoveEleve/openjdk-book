# 02. HashMap 的扩容与树化 — resize、阈值、红黑树、JDK8 并发改进

> **前置依赖**: [09-map-hash/01 — HashMap 存储与哈希](01-hashmap-storage-hash.md)(putVal 六步)
> → **后续**:[09-map-hash/03 — LinkedHashMap 与 TreeMap](03-linkedhashmap-treemap.md)
> 关联: 域 10 并发集合(并发演进)

## HashMap 的难点:扩容与树化

`++size > threshold` 触发扩容——扩容时每个元素怎么搬?为什么负载因子是 0.75?为什么链表 8 个就转树?"JDK8 修了死循环"是什么意思?这篇把 resize、阈值体系、树化和并发改进讲清楚。

## 1. "resize 怎么扩容" — 2 倍 + 高低位拆分

### 1.1 容量与阈值翻倍

`resize`(`HashMap.java:673`)——容量 2 倍(`HashMap.java:683`):

```java
// HashMap.java:683-686(截取核心,逐字)
else if ((newCap = oldCap << 1) < MAXIMUM_CAPACITY &&
         oldCap >= DEFAULT_INITIAL_CAPACITY)
    newThr = oldThr << 1; // double threshold
```

`newCap = oldCap << 1`(2 倍)、`newThr = oldThr << 1`(阈值同步翻倍,`threshold = newThr`@698)。

### 1.2 逐桶拆分:(e.hash & oldCap) == 0

扩容的精华在**逐桶 rehash**——桶内链表按新增位拆成两条(`HashMap.java:712-741`):

```java
// HashMap.java:712-741(截取核心,逐字)
Node<K,V> loHead = null, loTail = null;
Node<K,V> hiHead = null, hiTail = null;
Node<K,V> next;
do {
    next = e.next;
    if ((e.hash & oldCap) == 0) {
        if (loTail == null)
            loHead = e;
        else
            loTail.next = e;
        loTail = e;
    }
    ...
} while ((e = next) != null);
if (loTail != null) {
    loTail.next = null;
    newTab[j] = loHead;             // lo 链 → 原下标
}
if (hiTail != null) {
    hiTail.next = null;
    newTab[j + oldCap] = hiHead;    // hi 链 → 原下标 + oldCap
}
```

**为什么用位判断不用重算 hash**: 容量翻倍后,新下标 = `hash & (newCap - 1)`——newCap-1 比 oldCap-1 多一位。`(e.hash & oldCap) == 0` 判断"新增的那一位是 0 还是 1":

- **0** → 下标不变,进 **lo 链**,留原下标
- **1** → 下标 + oldCap,进 **hi 链**,搬 `j + oldCap`

**保持链表顺序**(loTail/hiTail 尾插)——JDK7 的头插会反转(第 4 节)。一次遍历 O(n) 完成全表搬移,均摊 O(1)。

关键设计(斜体):*JDK8 扩容的精妙: 元素的新位置只可能是"原下标"或"原下标+oldCap"(容量翻倍多出一位)——**用位判断代替重算 hash**,且保持链表顺序。面试"(e.hash & oldCap)==0 什么意思": hash 的新增最高位是 0 → 留原位;是 1 → 搬高位区。*

## 2. "为什么 loadFactor 是 0.75" — 空间与时间的平衡

### 2.1 常量与语义

`DEFAULT_LOAD_FACTOR = 0.75f`(`HashMap.java:249`): **size > capacity × 0.75 → 扩容**;threshold = capacity × loadFactor(首次容量 `tableSizeFor` 结果存 threshold@453,resize 时按 `newCap * loadFactor` 计算@696-697)。

### 2.2 泊松分布注释

源码注释(`HashMap.java:182-198`)给了数学依据: 理想 hash 下**桶内节点数服从泊松分布**,列出各级概率——`HashMap.java:198`:

```
// HashMap.java:198(截取核心)
* 8:    0.00000006
```

**桶内出现 8 个节点的概率约 0.00000006(亿分之六)**——树化阈值 8 的来源。

关键设计(斜体):*0.75 是"空间占用率 vs 碰撞概率"的权衡——过大(如 1.0)桶密碰撞多,过小(0.5)浪费空间;泊松分布注释给出碰撞概率的数学依据。面试能引"泊松分布注释"是加分项。生产: `new HashMap<>(预估容量 / 0.75)` 避免扩容;`MAXIMUM_CAPACITY = 1 << 30`(`HashMap.java:244`)。*

## 3. "为什么 8 转树" — 树化阈值

### 3.1 三个阈值

`HashMap.java:259`/`266`/`274`:

```
TREEIFY_THRESHOLD   = 8    // 桶内节点数 ≥8 → 转树
UNTREEIFY_THRESHOLD = 6    // 扩容拆分后 ≤6 → 退树(留缓冲,防"树↔链"抖动)
MIN_TREEIFY_CAPACITY = 64  // 表容量 <64 → 先扩容不树化
```

### 3.2 treeifyBin:容量不足先扩容

`treeifyBin`(`HashMap.java:751-754`):

```java
// HashMap.java:751-754(截取核心,逐字)
final void treeifyBin(Node<K,V>[] tab, int hash) {
    int n, index; Node<K,V> e;
    if (tab == null || (n = tab.length) < MIN_TREEIFY_CAPACITY)
        resize();
    ...
```

**表容量 <64 时先扩容不树化**——容量小说明是"整体装载"阶段,扩容分散比树化划算。

关键设计(斜体):*阈值 8 的数学依据(源码注释): 理想 hash 下桶内节点数服从泊松分布,>8 概率亿分之六——**树化是"防御哈希碰撞攻击"的兜底**(恶意构造同 hash 的 key),不是常规路径;8→6 留 2 的缓冲避免"树↔链"抖动。面试答"8 是安全阈值 + 6 防抖动 + 64 防小表树化"有区分度。*

## 4. "HashMap 线程安全吗" — JDK7 环链与 JDK8 改进

### 4.1 JDK7:头插法环链

JDK7 的扩容用**头插法**迁移链表: 多线程并发 resize 时,两条线程互相倒置链表节点——**环形链表形成,get 死循环**(经典生产事故,CPU 100%)。

### 4.2 JDK8:尾插修复

JDK8 改用**尾插法 + 高低位拆分**(第 1 节): 迁移保持顺序,不再倒置——**环链问题已修复**。

### 4.3 仍不安全

"修了死循环"≠"线程安全": put 并发覆盖(getNode/putVal 无同步)、size 竞态——并发写仍丢数据。

关键设计(斜体):*面试完整答法: ① JDK7 环链机制(头插)② JDK8 尾插修复 ③ 并发仍不安全(覆盖)④ 正解 = ConcurrentHashMap(域 10)。生产: 并发场景禁 HashMap;要变安全用 ConcurrentHashMap 或 Collections.synchronizedMap。*

## 核心悬念

HashMap 无序——但业务要**有序**: 按插入顺序、按访问顺序、按键排序。"LinkedHashMap 的 LRU 怎么实现?""TreeMap 的红黑树保证什么?"——下一篇: LinkedHashMap 与 TreeMap。

> → [09-map-hash/03 — LinkedHashMap 与 TreeMap](03-linkedhashmap-treemap.md)
