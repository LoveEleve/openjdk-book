# HashMap 的扩容与树化：为什么 JDK 8 之后几乎不重算桶位

> 本文基于 JDK 11 `HashMap` 源码。重点讨论 `resize()` 的 lo/hi 拆分、负载因子与阈值、树化/退树条件，以及 JDK7 到 JDK8 的迁移策略差异；红黑树旋转细节和并发容器机制留到后续篇章。本文讨论的是 JDK 11 `HashMap` 扩容与树化协同机制，不把这里的 lo/hi 拆桶、阈值联动和历史修复路径外推成所有哈希表实现都必须遵守的统一规范。
> **前置依赖**：[HashMap 的存储与哈希](01-hashmap-storage-hash.md)
> **后续**：[LinkedHashMap 与 TreeMap](03-linkedhashmap-treemap.md)

## 扩容真正值得学的，不是“翻倍”这件事，而是“为什么几乎不用重算桶位”

很多人背 `HashMap.resize()`，会记住几个结果：

- 容量翻倍；
- 阈值跟着变；
- 链长到 8 可能树化；
- JDK8 修了 JDK7 的死循环问题。

这些结论都没错，但如果不抓住中间那条主线，就很容易把扩容看成“又一次把所有元素重新哈希一遍，再扔进新数组”。

JDK 8 以后真正精彩的地方恰恰在这里：**扩容时，新桶位几乎不是重新完整计算出来的，而是利用“容量翻倍只多出一位”这个事实，直接把旧桶节点拆成 lo / hi 两组。**

整篇文章都围绕这个点展开：

```text
为什么扩容时
不是重新 hashCode() / 重新 % newCap
而只是判断一个新增位？
```

## 一、`resize()` 的第一层动作：容量翻倍，阈值同步调整

### 先看 JDK 11 的扩容入口

`resize()` 的前半段先处理容量和阈值：

```java
// HashMap.java:664-698
final Node<K,V>[] resize() {
    Node<K,V>[] oldTab = table;
    int oldCap = (oldTab == null) ? 0 : oldTab.length;
    int oldThr = threshold;
    int newCap, newThr = 0;
    if (oldCap > 0) {
        if (oldCap >= MAXIMUM_CAPACITY) {
            threshold = Integer.MAX_VALUE;
            return oldTab;
        }
        else if ((newCap = oldCap << 1) < MAXIMUM_CAPACITY &&
                 oldCap >= DEFAULT_INITIAL_CAPACITY)
            newThr = oldThr << 1;
    }
    else if (oldThr > 0)
        newCap = oldThr;
    else {
        newCap = DEFAULT_INITIAL_CAPACITY;
        newThr = (int)(DEFAULT_LOAD_FACTOR * DEFAULT_INITIAL_CAPACITY);
    }
    if (newThr == 0) {
        float ft = (float)newCap * loadFactor;
        newThr = (newCap < MAXIMUM_CAPACITY && ft < (float)MAXIMUM_CAPACITY ?
                  (int)ft : Integer.MAX_VALUE);
    }
    threshold = newThr;
```

这里先别急着关心每个分支，先抓住最核心的扩容主路：

```text
oldCap > 0
   → newCap = oldCap << 1
   → newThr = oldThr << 1
```

也就是：容量翻倍，阈值同步翻倍。

### 为什么“翻倍”比“加固定值”更关键

如果只是单纯为了放更多元素，你当然也可以想象别的增长方式。但 `HashMap` 这里坚持翻倍，不只是出于摊还复杂度，更是因为下一步的拆桶逻辑完全依赖这个条件。

只有当容量从 `oldCap` 变成 `2 * oldCap` 时，新掩码才会比旧掩码**只多出一位有效位**。而这正是“旧桶元素新位置只会二选一”的根源。

所以这一节看似只是在改数字，其实是在为后面最关键的位判断做铺垫。

## 二、为什么新位置只可能是“原下标”或“原下标 + oldCap”

### 扩容的精髓不在 `newCap`，而在新增出来的那一位

上一篇已经讲过，`HashMap` 的桶定位是：

```text
index = (n - 1) & hash
```

当容量翻倍时，`newCap = oldCap << 1`，那么：

- 旧掩码是 `oldCap - 1`
- 新掩码是 `newCap - 1`

因为 `oldCap` 是 2 的幂，所以新掩码相对旧掩码，实际上只多了一位 1。也就是说，新下标和旧下标的区别，只取决于 `hash` 在这一新增位上到底是 0 还是 1。

这就是为什么扩容时，不需要重新完整取模，也不需要重新调用用户的 `hashCode()`。JDK 只需要看：

```text
hash 在新增那一位上是 0 还是 1
```

### 这就是 `(e.hash & oldCap) == 0` 的真正含义

看链桶迁移这段最核心：

```java
// HashMap.java:702-744
if (oldTab != null) {
    for (int j = 0; j < oldCap; ++j) {
        Node<K,V> e;
        if ((e = oldTab[j]) != null) {
            oldTab[j] = null;
            if (e.next == null)
                newTab[e.hash & (newCap - 1)] = e;
            else if (e instanceof TreeNode)
                ((TreeNode<K,V>)e).split(this, newTab, j, oldCap);
            else {
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
                    else {
                        if (hiTail == null)
                            hiHead = e;
                        else
                            hiTail.next = e;
                        hiTail = e;
                    }
                } while ((e = next) != null);
                if (loTail != null) {
                    loTail.next = null;
                    newTab[j] = loHead;
                }
                if (hiTail != null) {
                    hiTail.next = null;
                    newTab[j + oldCap] = hiHead;
                }
            }
        }
    }
}
```

这里的 `(e.hash & oldCap) == 0`，不是在做“某种神秘重算”。它只是在检测：**扩容后新增的那一位是否为 1。**

因此，同一个旧桶里的节点，扩容后只有两种去向：

```text
新增位 = 0
   → 仍留在原下标 j
   → 进入 lo 链

新增位 = 1
   → 移到 j + oldCap
   → 进入 hi 链
```

这就是面试里那句最该真正理解的话：**扩容后元素的位置只可能不变，或者移动一个 oldCap 的偏移。**

### 这也是为什么说 JDK 8 扩容“几乎不重算桶位”

严格地说，节点当然还是要重新挂到 `newTab` 里；但它不需要：

- 重新调用 `key.hashCode()`；
- 重新走完整 `% newCap` 或者所有位计算；
- 对每个节点独立做一套昂贵的重新定位逻辑。

它只是在旧桶内顺序扫描，然后依据 `hash & oldCap` 这一位，把元素一分为二。

所以 JDK 8+ 扩容最精妙的地方，不是“更快地循环”，而是把问题从“每个节点重新算去哪儿”降成了“每个节点看新增位是 0 还是 1”。

## 三、为什么要拆成 lo / hi 两条链，还要保持原顺序

### JDK 8 的迁移不是头插，而是尾插保序

上面的 `loTail` / `hiTail` 很容易被一眼略过，但它们其实非常重要。JDK 11 在拆分旧桶节点时，使用的是尾插：

```text
落到 lo
   → 接到 loTail 后面

落到 hi
   → 接到 hiTail 后面
```

这样做的直接效果是：**同一条 lo 链内部、同一条 hi 链内部，都保留了旧桶中的相对顺序。**

### 保序不只是“好看”，它和 JDK7 的事故直接相关

JDK7 的扩容迁移使用过头插法。头插会把链表顺序反过来，而在并发 resize 的交错场景下，这种反转可能把链指针织成环，最终让 `get()` 在桶链上死循环，CPU 飙满。

JDK8 之后的尾插保序 + lo/hi 拆分，修掉的正是这类“迁移过程中反转链表结构”的风险。

所以这里必须把三个事实分开：

```text
JDK7
   → 头插迁移
   → 顺序反转
   → 并发 resize 下可能形成环链

JDK8+
   → 尾插保序
   → lo / hi 拆分
   → 修掉环链事故机制
```

但这不等于 HashMap 从此线程安全，这一点后面还会专门收束。

## 四、负载因子 0.75 为什么不是玄学，而是空间与碰撞的工程平衡

### 先看类注释自己怎么说

`HashMap` 一开始就把负载因子的语义说明白了：

```java
// HashMap.java:58-70
 * <p>An instance of {@code HashMap} has two parameters that affect its
 * performance: <i>initial capacity</i> and <i>load factor</i>.  The
 * <i>capacity</i> is the number of buckets in the hash table, and the initial
 * capacity is simply the capacity at the time the hash table is created.  The
 * <i>load factor</i> is a measure of how full the hash table is allowed to
 * get before its capacity is automatically increased.  When the number of
 * entries in the hash table exceeds the product of the load factor and the
 * current capacity, the hash table is <i>rehashed</i> (that is, internal data
 * structures are rebuilt) so that the hash table has approximately twice the
 * number of buckets.
 *
 * <p>As a general rule, the default load factor (.75) offers a good
```

默认常量也很直接：

```java
// HashMap.java:246-249
/**
 * The load factor used when none specified in constructor.
 */
static final float DEFAULT_LOAD_FACTOR = 0.75f;
```

### 0.75 的本质是：别太空，也别太挤

如果负载因子太小，比如 0.5：

- 扩容更早触发；
- 桶更稀疏；
- 碰撞更少；
- 但空间浪费更大。

如果负载因子太大，比如接近 1.0：

- 桶利用率更高；
- 空间更省；
- 但链长和碰撞概率更高，查找路径更容易变长。

`0.75` 不是数学真理，而是 JDK 对常见业务场景做出的工程折中：在时间与空间之间取一个非常经典的平衡点。

### 泊松分布注释真正想说明的是：长链在正常情况下很罕见

JDK 11 甚至把桶内节点数的概率分布写进了类注释：

```java
// HashMap.java:181-199
 * nodes in bins follows a Poisson distribution
 * (http://en.wikipedia.org/wiki/Poisson_distribution) with a
 * parameter of about 0.5 on average for the default resizing
 * threshold of 0.75, although with a large variance because of
 * resizing granularity. Ignoring variance, the expected
 * occurrences of list size k are (exp(-0.5) * pow(0.5, k) /
 * factorial(k)). The first values are:
 *
 * 0:    0.60653066
 * 1:    0.30326533
 * 2:    0.07581633
 * 3:    0.01263606
 * 4:    0.00157952
 * 5:    0.00015795
 * 6:    0.00001316
 * 7:    0.00000094
 * 8:    0.00000006
 * more: less than 1 in ten million
```

这里最重要的不是你现场会不会推泊松分布，而是你要读懂 JDK 想传达的结构性信息：**在正常分布下，桶里堆到 8 个节点已经是极少见的异常情况。**

这就为后面的树化阈值奠定了语义背景：树化不是常规主路径，而是一种“正常情况几乎用不到，但极端碰撞必须兜底”的防御设计。

## 五、为什么是 8 / 6 / 64：树化不是一个单阈值故事

### 三个阈值必须放在一起看

```java
// HashMap.java:258-274
static final int TREEIFY_THRESHOLD = 8;

/**
 * The bin count threshold for untreeifying a (split) bin during a
 * resize operation.
 */
static final int UNTREEIFY_THRESHOLD = 6;

/**
 * The smallest table capacity for which bins may be treeified.
 */
static final int MIN_TREEIFY_CAPACITY = 64;
```

这三个数不是孤零零存在的：

- `8`：链够长了，值得考虑树化；
- `6`：树桶变稀疏后退回链表，给回退留缓冲；
- `64`：表太小时，先扩容比上树更划算。

### 链长到 8 并不等于立刻树化

触发点来自 `putVal` 里链尾新增时的检查：

```java
// HashMap.java:637-640
if ((e = p.next) == null) {
    p.next = newNode(hash, key, value, null);
    if (binCount >= TREEIFY_THRESHOLD - 1)
        treeifyBin(tab, hash);
```

但 `treeifyBin` 的第一件事不是立刻转树，而是先看表容量：

```java
// HashMap.java:751-769
final void treeifyBin(Node<K,V>[] tab, int hash) {
    int n, index; Node<K,V> e;
    if (tab == null || (n = tab.length) < MIN_TREEIFY_CAPACITY)
        resize();
    else if ((e = tab[index = (n - 1) & hash]) != null) {
        TreeNode<K,V> hd = null, tl = null;
        do {
            TreeNode<K,V> p = replacementTreeNode(e, null);
            if (tl == null)
                hd = p;
            else {
                p.prev = tl;
                tl.next = p;
            }
            tl = p;
        } while ((e = e.next) != null);
        if ((tab[index] = hd) != null)
            hd.treeify(tab);
    }
}
```

也就是说：

```text
链长到阈值
   → 不是“直接树化”
   → 而是“先检查当前表是否足够大”

表太小
   → 先 resize
   → 让元素有机会重新分散
```

这背后的直觉很合理：如果表还很小，长链很可能只是“整体装载率太高”的阶段性现象，此时优先扩容往往比把桶升级成红黑树更划算。

### 为什么退树阈值是 6，不是也用 8

如果树化和退树都用同一个阈值，那么桶大小在边界附近抖动时，就会出现“刚树化又退树、刚退树又树化”的来回震荡。

`8` 和 `6` 之间留出的缓冲区，就是为了减少这种结构抖动。它是一种非常典型的工程滞回设计：进入门槛高一点，退出门槛低一点，让状态切换更稳定。

## 六、树桶扩容时也按 lo / hi 拆，只是拆完后可能退回链表

### 树桶并没有单独发明另一套扩容世界观

树桶扩容时，JDK 11 仍然沿用同一套“看 bit 拆 lo/hi”的思路：

```java
// HashMap.java:2193-2247
/**
 * Splits nodes in a tree bin into lower and upper tree bins,
 * or untreeifies if now too small.
 */
final void split(HashMap<K,V> map, Node<K,V>[] tab, int index, int bit) {
    TreeNode<K,V> b = this;
    TreeNode<K,V> loHead = null, loTail = null;
    TreeNode<K,V> hiHead = null, hiTail = null;
    int lc = 0, hc = 0;
    for (TreeNode<K,V> e = b, next; e != null; e = next) {
        next = (TreeNode<K,V>)e.next;
        e.next = null;
        if ((e.hash & bit) == 0) {
            if ((e.prev = loTail) == null)
                loHead = e;
            else
                loTail.next = e;
            loTail = e;
            ++lc;
        }
        else {
            if ((e.prev = hiTail) == null)
                hiHead = e;
            else
                hiTail.next = e;
            hiTail = e;
            ++hc;
        }
    }

    if (loHead != null) {
        if (lc <= UNTREEIFY_THRESHOLD)
            tab[index] = loHead.untreeify(map);
        else {
            tab[index] = loHead;
            if (hiHead != null)
                loHead.treeify(tab);
        }
    }
    if (hiHead != null) {
        if (hc <= UNTREEIFY_THRESHOLD)
            tab[index + bit] = hiHead.untreeify(map);
```

这里有两个重点：

1. 树桶扩容仍然按 `(e.hash & bit)` 决定进 lo 还是 hi；
2. 拆完后，如果某边节点数已经足够少，还会 `untreeify` 回链表。

这说明树并不是一种“上去就不下来的高级状态”。它只是 HashMap 在局部高碰撞下的一种临时高成本防御形态；当扩容后冲突被重新摊薄，回到链表反而更合适。

## 七、JDK8 修了环链，不等于 HashMap 线程安全

### 历史问题修掉的是一种迁移事故机制

JDK7 的经典问题，不是“HashMap 在并发下偶尔慢一点”，而是并发 resize 可能把链表迁移出环，导致后续 `get()` 死循环。

JDK8 通过尾插保序和 lo/hi 拆分，修掉了这类由迁移顺序反转引发的结构性事故。

### 但它仍然没有同步，仍然会有竞态

这一点不要被“修了死循环”误导。JDK 11 的 `HashMap` 依然不是并发容器：

- `put` / `resize` 没有外部同步；
- 多线程同时写仍可能覆盖、丢失更新；
- `size`、桶迁移和可见性都没有并发协议保障。

所以完整的结论必须是：

```text
JDK8+
   → 修了 JDK7 头插迁移导致的环链事故
   → 但没有把 HashMap 变成线程安全容器
```

这也是为什么并发场景的正解依旧是 `ConcurrentHashMap`，而不是“放心用新版 HashMap 就行”。

## 十、五个最容易混掉的边界：扩容不是重算所有桶位，`oldCap` 不是旧数字摆设，树阈值不是单个 8，JDK8 修复不等于线程安全，0.75 也不是拍脑袋

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，扩容不是“把所有元素重新完整取模一遍”。JDK 8+ 真正厉害的地方，恰恰是利用容量翻倍只多出一位这个事实，把旧桶直接拆成 lo/hi 两半，而不是重新从头计算每个桶位。

第二，`oldCap` 也不是旧容量数字摆设。它在扩容判断里扮演的是新增高位掩码：`(e.hash & oldCap) == 0` 问的不是旧容量大小，而是“新增那一位到底是 0 还是 1”。

第三，树化阈值更不是单个 8 的故事。真正起作用的是 8 / 6 / 64 这一组联动条件：链够长才值得考虑上树，太稀疏又要退回链表，表太小则先扩容更划算。

第四，JDK 8 修掉环链事故也不等于 HashMap 从此线程安全。它修掉的是扩容迁移时头插反转在并发 resize 下形成环链的经典坑，不是把无同步的结构共享 magically 变成可并发使用。

第五，0.75 负载因子也不是拍脑袋经验值。它表达的是空间浪费和碰撞长度之间的折中：太小会过早扩容，太大又会让桶变挤。JDK 甚至用泊松分布注释把“长链通常极少见”这层背景直接写进了源码。

把这五条边界记稳，HashMap 扩容与树化这一篇就不会重新塌回“扩容翻倍、链长到 8 上树”的面试口诀印象。它真正想讲的是：JDK 8+ 怎样把旧桶迁移、碰撞兜底和工程常数同时做成一套紧密咬合的设计。

## 收网：扩容与树化的核心，不是记住数字，而是看懂它们如何互相配合

现在回到这篇文章的主问题：为什么 JDK 8 之后的 HashMap 扩容几乎不重算桶位？

因为容量翻倍以后，新的掩码只比旧掩码多一位。于是旧桶中的每个节点，新位置只会有两种可能：留在原位，或者搬到 `原下标 + oldCap`。JDK 只需要看这一新增位的值，就能把旧桶拆成 lo / hi 两边。

再往上看，负载因子、树化阈值、最小树化容量、退树阈值，也都不是独立知识点，而是在围绕同一个目标协同工作：

- 平时让平均路径尽量短；
- 装载变高时再扩容；
- 极端长链时用树兜底；
- 扩容后若冲突缓解，再退回链表；
- 修掉旧版迁移顺序带来的结构性事故，但不假装自己已经线程安全。

把整篇压成一张图，就是：

```text
size 超 threshold
   → resize()
   → 容量翻倍
   → 新掩码只多一位
   → 旧桶按 (hash & oldCap) 拆成 lo / hi
   → 留原位或搬 oldCap 偏移
   → 长链触发树化检查
       ├── 表太小：先扩容
       └── 表够大：转树
   → 扩容后若树桶变稀：可退回链表
```

实际使用时，先记住四条：

1. **扩容后节点新位置只可能是原位或 `原位 + oldCap`**；这是 JDK8+ 扩容设计的核心。
2. **`(e.hash & oldCap) == 0` 判断的是扩容新增那一位**；不是重新完整算 hash。
3. **树化阈值必须连着 8 / 6 / 64 一起理解**；链长到 8 并不等于立刻上树。
4. **JDK8 修掉了环链事故，但没有让 HashMap 变成并发安全容器。**

下一篇进入“有序 Map”的两条路线：一条是保持插入/访问顺序的 `LinkedHashMap`，一条是按 key 排序的 `TreeMap`。到那里，Map 的“无序默认”和“有序特例”就能完整闭环。

> → 下一篇：[LinkedHashMap 与 TreeMap](03-linkedhashmap-treemap.md)
