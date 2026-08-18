# 01. HashMap 的存储与哈希 — table、扰动、寻址、put/get 全流程

> **前置依赖**: [01-string/02 — String.hashCode](../01-string/02-equals-hashcode-compare.md)(31 倍乘与哈希契约)、[08-collections/04 — 迭代器与 fail-fast](../08-collections/04-iterator-failfast.md)(集合的 modCount 已见)
> → **后续**:[09-map-hash/02 — 扩容与树化](02-resize-treeify.md)
> 关联: 域 03 对象系统第 1 篇(可变 key 的问题)

## 面试三连问的源码答案

"HashMap 底层结构""put 过程""为什么容量是 2 的幂"——面试三连问,答案都在这一个文件里(`java/util/HashMap.java`,2462 行)。这篇从 `hash()` 的扰动函数讲到 `putVal` 的完整流程: 哈希怎么算、寻址为什么用位与、put 的六步、以及键的比较语义。

## 1. "hash() 为什么扰动" — 高位异或

### 1.1 源码

`HashMap.hash`(`HashMap.java:338-341`):

```java
// HashMap.java:338-341(截取核心,逐字)
static final int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```

两件事: **null key → 0**(HashMap 允许 null key,进 0 桶);否则 **hashCode 右移 16 位与自己异或**。

### 1.2 动机:让高位参与低位计算

数组寻址只用到低位(`(n - 1) & hash`): 如果 hashCode 的高位信息在低位没有体现(比如两个对象低位相同、高位不同),它们必然碰撞。**右移 16 异或把高位混入低位**——低成本(一次移位一次异或,O(1))的分布优化。

String 的 31 倍乘 hashCode 分布已经不错,但自定义 hashCode 可能低位分布差——扰动函数是兜底。

关键设计(斜体):*"扰动函数"是"低成本分布优化"——一次移位异或,显著改善低位碰撞。面试"hash 为什么要 >>>16"的标准答案: 让高位参与低位计算,减少低位相同导致的碰撞。*

## 2. "寻址为什么用 & (n-1)" — 2 的幂取模

### 2.1 容量恒为 2 的幂

`tableSizeFor`(`HashMap.java:379-381`)保证容量是 2 的幂:

```java
// HashMap.java:379-381(截取核心,逐字)
static final int tableSizeFor(int cap) {
    int n = -1 >>> Integer.numberOfLeadingZeros(cap - 1);
    return (n < 0) ? 1 : (n >= MAXIMUM_CAPACITY) ? MAXIMUM_CAPACITY : n + 1;
}
```

**基于前导零计数**: `Integer.numberOfLeadingZeros(cap - 1)` 算出 cap-1 的二进制位数,`-1 >>>` 把它扩成"低 n 位全 1",`+1` 得到 2 的幂。`new HashMap(100)` → 128。

### 2.2 位与 = 取模

**`(n - 1) & hash` = `hash % n`**(n 为 2 的幂)——位运算比取模快(无除法)。这就是"容量必须 2 的幂"的原因。

关键设计(斜体):*"2 的幂 + 位与"是哈希表工程惯例——JDK 刻意限制容量为 2 的幂换取快速取模;代价: 只用到低 n 位,所以扰动函数(§1)必须存在——**两个设计互相成全**。面试"new HashMap(100) 实际容量多少": 128(tableSizeFor 取上一位 2 的幂)。*

## 3. "put 的完整流程" — putVal 逐行

### 3.1 六步

`map.put(key, value)`(`HashMap.java:607`)→ `putVal`(`HashMap.java:621`):

```java
// HashMap.java:621-668(截取核心,逐字)
final V putVal(int hash, K key, V value, boolean onlyIfAbsent,
               boolean evict) {
    Node<K,V>[] tab; Node<K,V> p; int n, i;
    if ((tab = table) == null || (n = tab.length) == 0)
        n = (tab = resize()).length;                        // ① table 空 → resize
    if ((p = tab[i = (n - 1) & hash]) == null)
        tab[i] = newNode(hash, key, value, null);           // ② 桶空 → 直接放
    else {
        Node<K,V> e; K k;
        if (p.hash == hash &&
            ((k = p.key) == key || (key != null && key.equals(k))))
            e = p;                                          // ③ 桶首 key 相同 → 覆盖
        else if (p instanceof TreeNode)
            e = ((TreeNode<K,V>)p).putTreeVal(this, tab, hash, key, value);  // ④ 树插入
        else {
            for (int binCount = 0; ; ++binCount) {
                if ((e = p.next) == null) {
                    p.next = newNode(hash, key, value, null); // ⑤ 链表尾部新增
                    if (binCount >= TREEIFY_THRESHOLD - 1) // -1 for 1st
                        treeifyBin(tab, hash);              //    链表太长 → 判树化
                    break;
                }
                if (e.hash == hash && ...equals...)
                    break;
                p = e;
            }
        }
        ...
```

六步:

1. **table 空 → resize**():首次 put 才分配(懒初始化,与 ArrayList 同思路)
2. **桶空 → new Node 直接放**(最快路径,O(1))
3. **桶首 key 相同 → 覆盖**(比较 hash + equals,`HashMap.java:630-632`)
4. **桶是 TreeNode → putTreeVal**(红黑树插入,`HashMap.java:634`)
5. **链表遍历** → 找到覆盖 / 尾部新增;链表长度到阈值(`TREEIFY_THRESHOLD = 8`@259)→ `treeifyBin` 判树化
6. `++size > threshold` → resize

### 3.2 get 对称

`get`(`HashMap.java:551`)→ `getNode`(`HashMap.java:563`): 定位桶 → 首节点比较 → 树/链表查找。

关键设计(斜体):*put 的复杂度: 平均 O(1)(桶空路径)、退化 O(log n)(树)/O(n)(链表)。"桶首直接比较"的意义: 无冲突的单节点桶是常态——命中它就不用进入任何遍历(JDK8 新增节点插在链表尾部,p.next = newNode,@HashMap.java:638,不存在"最近插入在头部"的局部性)。面试手写 put 流程按 6 步答全。*

## 4. "Node 与 equals 语义" — 键的比较

### 4.1 判断条件

HashMap 判断"同一个 key": **hash 相同 AND equals 相同**(`getNode`@563 内的比较,第 3 节代码块的 `p.hash == hash && (...equals...)`)。

### 4.2 契约依赖

- **equals 相等 ⇒ hashCode 必相等**(域 01 契约)——**违反契约的 key 直接导致 HashMap 失效**(hash 不同 → 定位到不同桶 → 永远找不到)
- **可变 key 修改字段后 hash 变** → 对象"丢"(域 03 对象系统第 1 篇的 HashSet 剧本讲过同类问题)
- **null key 允许**(hash 返回 0,进 0 桶)

关键设计(斜体):*HashMap 正确性完全依赖键的 hashCode/equals 契约(域 01)。生产规范: key 用不可变对象(String/Integer)。面试"HashMap 的 key 能用可变对象吗": 能但不该——改了 equals 就找不到了。*

## 核心悬念

哈希桶满了怎么办?——**扩容**。`resize` 一次扩多少?rehash 时元素怎么搬?`(e.hash & oldCap) == 0` 判断了什么?为什么说 JDK8 的扩容解决了 JDK7 的"环链死循环"?——下一篇: 扩容与树化。

> → [09-map-hash/02 — 扩容与树化](02-resize-treeify.md)
