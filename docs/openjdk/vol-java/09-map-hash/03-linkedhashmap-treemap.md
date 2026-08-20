# LinkedHashMap 与 TreeMap：Map 要“有序”，到底是在保什么序

> 本文基于 JDK 11 `LinkedHashMap` 与 `TreeMap` 源码。重点讨论遍历顺序、访问顺序、LRU、红黑树与 `NavigableMap` 能力；不展开红黑树完整证明和并发有序容器内部实现。本文讨论的是 JDK 11 两类有序 Map 的顺序语义与结构边界，不把这里的全局链维护、访问序 LRU 和比较树定位方式外推成所有有序映射实现都必须遵守的统一规范。
> **前置依赖**：[HashMap 的存储与哈希](01-hashmap-storage-hash.md)、[HashMap 的扩容与树化](02-resize-treeify.md)
> **后续**：[Map 家族与选型](04-map-family.md)

## 真正该先问的，不是“哪个 Map 有序”，而是“你要保哪一种顺序”

很多人一听到“有序 Map”，脑中就会自然联想到一个问题：那不就是遍历时有顺序吗？

但对业务来说，至少有两种完全不同的顺序需求：

- 我想保留插入历史，或者最近访问历史；
- 我想让 key 本身按比较规则排序，并支持范围查询。

这两个需求表面都叫“有序”，但底层结构完全不是一回事。也正因为如此，JDK 没有只给你一种“ordered map”，而是分成两条路线：

```text
LinkedHashMap
   → 维护遍历顺序
   → 关心谁先插入、谁最近访问

TreeMap
   → 维护 key 的比较顺序
   → 关心谁更小、谁在某个区间里
```

如果一开始不把这个分歧立住，后面就很容易把 `LinkedHashMap` 误看成“轻量版 TreeMap”，或者把 `TreeMap` 误看成“会自动保留插入序的 HashMap”。

## 一、LinkedHashMap：它保留的不是“排序结果”，而是一条全局历史链

### LinkedHashMap 没有放弃哈希结构，它是在 HashMap 上额外加了一条链

JDK 11 的类注释一开头就把结构说穿了：

```java
// LinkedHashMap.java:33-48
 * <p>Hash table and linked list implementation of the {@code Map} interface,
 * with predictable iteration order.  This implementation differs from
 * {@code HashMap} in that it maintains a doubly-linked list running through
 * all of its entries.  This linked list defines the iteration ordering,
 * which is normally the order in which keys were inserted into the map
 * (<i>insertion-order</i>).
```

这句话很关键，因为它直接告诉你：`LinkedHashMap` 不是把 HashMap 的桶结构换掉了，而是在原来的哈希存储之上，又额外维护了一条贯穿所有 entry 的双向链。

也就是说，它不是：

```text
HashMap 被链表取代
```

而是：

```text
HashMap 桶结构照旧
   +
一条独立的全局 before/after 双向链
```

### 每个 entry 多出来的是 before / after 指针

```java
// LinkedHashMap.java:192-197
static class Entry<K,V> extends HashMap.Node<K,V> {
    Entry<K,V> before, after;
    Entry(int hash, K key, V value, Node<K,V> next) {
        super(hash, key, value, next);
    }
}
```

这说明 `LinkedHashMap` 的顺序能力，不是来自哈希桶内部的 `next` 链，而是来自另一组字段：`before` / `after`。

桶里的 `next` 仍然只负责解决哈希冲突；全局顺序则由这条新链维护。把这两条链混在一起理解，是阅读 `LinkedHashMap` 时最常见的误区。

### `head` / `tail` 让它能直接知道谁最老、谁最新

```java
// LinkedHashMap.java:204-217
transient LinkedHashMap.Entry<K,V> head;

transient LinkedHashMap.Entry<K,V> tail;

/**
 * The iteration ordering method for this linked hash map: {@code true}
 * for access-order, {@code false} for insertion-order.
 */
final boolean accessOrder;
```

这三个字段把 `LinkedHashMap` 的顺序世界完全搭起来了：

```text
head
   → 当前顺序里的最老节点

tail
   → 当前顺序里的最新节点

accessOrder
   → 决定“最新”是按插入算，还是按访问算
```

因此，`LinkedHashMap` 维护顺序的成本，不在哈希定位层，而在每次插入、删除、访问后，都要把这条全局双链维持正确。

## 二、插入序为什么默认成立：因为新节点总是挂到尾部

### 新 entry 一创建，就会接到双链尾部

`LinkedHashMap` 在创建新节点时，会直接把它链到尾部：

```java
// LinkedHashMap.java:221-230
private void linkNodeLast(LinkedHashMap.Entry<K,V> p) {
    LinkedHashMap.Entry<K,V> last = tail;
    tail = p;
    if (last == null)
        head = p;
    else {
        p.before = last;
        last.after = p;
    }
}
```

而 `newNode` 会马上调用它：

```java
// LinkedHashMap.java:255-259
Node<K,V> newNode(int hash, K key, V value, Node<K,V> e) {
    LinkedHashMap.Entry<K,V> p =
        new LinkedHashMap.Entry<>(hash, key, value, e);
    linkNodeLast(p);
    return p;
}
```

这就解释了为什么默认遍历顺序是插入序：**每次真正新增一个 key，新的 entry 都被接到 tail 后面。**

所以只要 `accessOrder` 没打开，链上的历史就等于“首次进入 map 的先后顺序”。重复 `put` 同一个 key 只是更新 value，并不会凭空再造一个新节点，也不会把它重新挂到尾部。

## 三、访问序为什么能成立：因为命中后节点会被移动到尾部

### `accessOrder=true` 时，`get()` 也会改变顺序

JDK 11 的文档把这件事讲得非常明确：访问序模式下，一系列读取和计算方法都会被视为一次 entry access。

```java
// LinkedHashMap.java:61-79
 * <p>A special {@link #LinkedHashMap(int,float,boolean) constructor} is
 * provided to create a linked hash map whose order of iteration is the order
 * in which its entries were last accessed, from least-recently accessed to
 * most-recently (<i>access-order</i>).  This kind of map is well-suited to
 * building LRU caches.  Invoking the {@code put}, {@code putIfAbsent},
 * {@code get}, {@code getOrDefault}, {@code compute}, {@code computeIfAbsent},
 * {@code computeIfPresent}, or {@code merge} methods results
 * in an access to the corresponding entry (assuming it exists after the
 * invocation completes). The {@code replace} methods only result in an access
 * of the entry if the value is replaced.  The {@code putAll} method generates one
 * entry access for each mapping in the specified map, in the order that
 * key-value mappings are provided by the specified map's entry set iterator.
 * <i>No other methods generate entry accesses.</i>  In particular, operations
 * on collection-views do <i>not</i> affect the order of iteration of the
 * backing map.
 *
 * <p>The {@link #removeEldestEntry(Map.Entry)} method may be overridden to
 * impose a policy for removing stale mappings automatically when new mappings
 * are added to the map.
```

它甚至在类注释里额外提醒：在 access-order 模式下，连 `get()` 都算结构性修改的一部分。

```java
// LinkedHashMap.java:112-118
 * A structural modification is any operation that adds or deletes one or more
 * mappings or, in the case of access-ordered linked hash maps, affects
 * iteration order.  In insertion-ordered linked hash maps, merely changing
 * the value associated with a key that is already contained in the map is not
 * a structural modification.  <strong>In access-ordered linked hash maps,
 * merely querying the map with {@code get} is a structural modification.
 * </strong>)
```

这和普通 `HashMap`、普通插入序 `LinkedHashMap` 都很不一样。因为这里的“结构”不再只有桶和节点数量，还包括那条全局顺序链。

### 命中后移到尾部，访问序就自然形成了

真正做这件事的是 `afterNodeAccess`：

```java
// LinkedHashMap.java:305-327
void afterNodeAccess(Node<K,V> e) { // move node to last
    LinkedHashMap.Entry<K,V> last;
    if (accessOrder && (last = tail) != e) {
        LinkedHashMap.Entry<K,V> p =
            (LinkedHashMap.Entry<K,V>)e, b = p.before, a = p.after;
        p.after = null;
        if (b == null)
            head = a;
        else
            b.after = a;
        if (a != null)
            a.before = b;
        else
            last = b;
        if (last == null)
            head = p;
        else {
            p.before = last;
            last.after = p;
        }
        tail = p;
        ++modCount;
    }
}
```

这段代码的本质很清楚：

1. 先把当前命中的节点从原位置摘下来；
2. 再把它接到 tail 后面；
3. 从此它就成了“最近访问”的那个元素。

因此 access-order 的语义并不是某种抽象标签，而是非常具体的链操作结果：

```text
head
   → 最久未访问

tail
   → 最近访问
```

## 四、为什么 LRU 能被 `LinkedHashMap` 很自然地做出来

### 因为 access-order 已经把“最旧”定义在 head 上了

一旦你接受了前面的顺序语义，LRU 的核心其实已经呼之欲出：

- 最近访问的节点会被移到尾部；
- 那么头部自然就是最久未访问的节点。

这正好就是 LRU 需要的淘汰顺序。

### 插入后只要检查一次头部是否该淘汰

JDK 11 直接预留了这个钩子：

```java
// LinkedHashMap.java:297-303
void afterNodeInsertion(boolean evict) { // possibly remove eldest
    LinkedHashMap.Entry<K,V> first;
    if (evict && (first = head) != null && removeEldestEntry(first)) {
        K key = first.key;
        removeNode(hash(key), key, null, false, true);
    }
}
```

这段逻辑的味道非常纯：每次插入之后，看一下当前 `head` 是否该被淘汰；如果该淘汰，就删头部。

而 `removeEldestEntry` 正好是给子类覆写策略的地方。所以 LRU 之所以看起来像“几行代码就能写完”，不是因为 JDK 偷偷给你藏了现成缓存库，而是因为 `LinkedHashMap` 的顺序语义本来就和 LRU 的淘汰规则完全贴合。

### LRU 不是“额外算法”，而是顺序语义的自然结果

所以正确的理解应该是：

```text
accessOrder=true
   → get/put 命中会刷新到尾部
   → head 代表最久未访问

afterNodeInsertion + removeEldestEntry
   → 插入后检查 head 是否该淘汰
   → 满足条件就删 head
```

这比死记“LinkedHashMap 可以实现 LRU”更重要，因为它解释了为什么它可以，而不仅是它恰好能。

## 五、TreeMap 走的是完全不同的路：它维护的是 key 的比较顺序

### TreeMap 从根上就不是哈希结构

`TreeMap` 的类注释开头已经定性：

```java
// TreeMap.java:33-42
 * A Red-Black tree based {@link NavigableMap} implementation.
 * The map is sorted according to the {@linkplain Comparable natural
 * ordering} of its keys, or by a {@link Comparator} provided at map
 * creation time, depending on which constructor is used.
 *
 * <p>This implementation provides guaranteed log(n) time cost for the
 * {@code containsKey}, {@code get}, {@code put} and {@code remove}
 * operations.
```

这说明 `TreeMap` 的“有序”根本不是靠额外挂一条历史链，而是靠整个存储结构本身就是一棵红黑树。

核心状态也很直白：

```java
// TreeMap.java:121-123
private final Comparator<? super K> comparator;

private transient Entry<K,V> root;
```

也就是说，TreeMap 的世界观是：

```text
先有比较规则 comparator / Comparable
   → 再根据比较结果把 key 放到树上的相对位置
   → 整棵树天然携带全局有序性
```

### 在 TreeMap 里，“相等 key”本质上来自 `compare(...) == 0`

JDK 11 还专门提醒：排序规则最好与 `equals` 一致，否则虽然树本身仍能工作，但它会偏离 `Map` 接口通常期待的相等性契约。

```java
// TreeMap.java:44-55
 * <p>Note that the ordering maintained by a tree map, like any sorted map, and
 * whether or not an explicit comparator is provided, must be <em>consistent
 * with {@code equals}</em> if this sorted map is to correctly implement the
 * {@code Map} interface.  (See {@code Comparable} or {@code Comparator} for a
 * precise definition of <em>consistent with equals</em>.)  This is so because
 * the {@code Map} interface is defined in terms of the {@code equals}
 * operation, but a sorted map performs all key comparisons using its {@code
 * compareTo} (or {@code compare}) method, so two keys that are deemed equal by
 * this method are, from the standpoint of the sorted map, equal.  The behavior
 * of a sorted map <em>is</em> well-defined even if its ordering is
 * inconsistent with {@code equals}; it just fails to obey the general contract
 * of the {@code Map} interface.
```

这点非常重要。对 `HashMap` 来说，key 相等性建立在 `hashCode + equals` 路线上；对 `TreeMap` 来说，真正决定位置和覆盖关系的是比较结果。

所以 TreeMap 不是“会排序的 HashMap”，而是一整套完全不同的相等与定位机制。

## 六、为什么 TreeMap 的 `get` / `put` 天然是 O(log n)`

### 查找就是沿比较结果往左或往右走

```java
// TreeMap.java:340-359
final Entry<K,V> getEntry(Object key) {
    if (comparator != null)
        return getEntryUsingComparator(key);
    if (key == null)
        throw new NullPointerException();
    @SuppressWarnings("unchecked")
        Comparable<? super K> k = (Comparable<? super K>) key;
    Entry<K,V> p = root;
    while (p != null) {
        int cmp = k.compareTo(p.key);
        if (cmp < 0)
            p = p.left;
        else if (cmp > 0)
            p = p.right;
        else
            return p;
    }
    return null;
}
```

带比较器的路径也一样，只是把 `compareTo` 换成 `Comparator.compare`：

```java
// TreeMap.java:367-383
final Entry<K,V> getEntryUsingComparator(Object key) {
    @SuppressWarnings("unchecked")
        K k = (K) key;
    Comparator<? super K> cpr = comparator;
    if (cpr != null) {
        Entry<K,V> p = root;
        while (p != null) {
            int cmp = cpr.compare(k, p.key);
            if (cmp < 0)
                p = p.left;
            else if (cmp > 0)
                p = p.right;
            else
                return p;
        }
    }
    return null;
}
```

这就是标准二叉搜索树路径：比较后决定向左还是向右，直到命中或走空。

### 插入先按二叉搜索树落位，再用红黑树修平衡

```java
// TreeMap.java:533-584
public V put(K key, V value) {
    Entry<K,V> t = root;
    if (t == null) {
        compare(key, key);
        root = new Entry<>(key, value, null);
        size = 1;
        modCount++;
        return null;
    }
    int cmp;
    Entry<K,V> parent;
    Comparator<? super K> cpr = comparator;
    if (cpr != null) {
        do {
            parent = t;
            cmp = cpr.compare(key, t.key);
            if (cmp < 0)
                t = t.left;
            else if (cmp > 0)
                t = t.right;
            else
                return t.setValue(value);
        } while (t != null);
    }
    else {
        if (key == null)
            throw new NullPointerException();
        @SuppressWarnings("unchecked")
            Comparable<? super K> k = (Comparable<? super K>) key;
        do {
            parent = t;
            cmp = k.compareTo(t.key);
            if (cmp < 0)
                t = t.left;
            else if (cmp > 0)
                t = t.right;
            else
                return t.setValue(value);
        } while (t != null);
    }
    Entry<K,V> e = new Entry<>(key, value, parent);
    if (cmp < 0)
        parent.left = e;
    else
        parent.right = e;
    fixAfterInsertion(e);
```

这段代码清楚地显示：TreeMap 的 put 不是哈希落桶，而是二叉搜索落位。落位完成后，还要调用 `fixAfterInsertion` 恢复红黑树平衡。

### 旋转和修复是为了让“最坏也别太深”

```java
// TreeMap.java:2218-2234
private void rotateLeft(Entry<K,V> p) {
    if (p != null) {
        Entry<K,V> r = p.right;
        p.right = r.left;
        if (r.left != null)
            r.left.parent = p;
        r.parent = p.parent;
        if (p.parent == null)
            root = r;
        else if (p.parent.left == p)
            p.parent.left = r;
        else
            p.parent.right = r;
        r.left = p;
        p.parent = r;
    }
}
```

```java
// TreeMap.java:2237-2250
private void rotateRight(Entry<K,V> p) {
    if (p != null) {
        Entry<K,V> l = p.left;
        p.left = l.right;
        if (l.right != null) l.right.parent = p;
        l.parent = p.parent;
        if (p.parent == null)
            root = l;
        else if (p.parent.right == p)
            p.parent.right = l;
        else p.parent.left = l;
        l.right = p;
        p.parent = l;
    }
}
```

```java
// TreeMap.java:2254-2287
private void fixAfterInsertion(Entry<K,V> x) {
    x.color = RED;

    while (x != null && x != root && x.parent.color == RED) {
        if (parentOf(x) == leftOf(parentOf(parentOf(x)))) {
            Entry<K,V> y = rightOf(parentOf(parentOf(x)));
            if (colorOf(y) == RED) {
                setColor(parentOf(x), BLACK);
                setColor(y, BLACK);
                setColor(parentOf(parentOf(x)), RED);
                x = parentOf(parentOf(x));
            } else {
                if (x == rightOf(parentOf(x))) {
                    x = parentOf(x);
                    rotateLeft(x);
                }
                setColor(parentOf(x), BLACK);
                setColor(parentOf(parentOf(x)), RED);
                rotateRight(parentOf(parentOf(x)));
            }
```

这里不用把整套红黑树证明展开到细节，但至少要抓住一点：**TreeMap 之所以能保证查找/插入/删除最坏 O(log n)`，不是因为二叉树天然如此，而是因为它不断通过变色和旋转阻止树退化成一条长链。**

## 七、TreeMap 真正的价值，不是“看起来有序”，而是 `NavigableMap` 能力

### 范围导航才是它和哈希结构最大的分野

如果只是想遍历时有个顺眼顺序，`LinkedHashMap` 已经能做到。但 `TreeMap` 的真正价值不在“有序输出”，而在“围绕比较序做范围导航”。

比如 `getCeilingEntry`：

```java
// TreeMap.java:392-409
final Entry<K,V> getCeilingEntry(K key) {
    Entry<K,V> p = root;
    while (p != null) {
        int cmp = compare(key, p.key);
        if (cmp < 0) {
            if (p.left != null)
                p = p.left;
            else
                return p;
        } else if (cmp > 0) {
            if (p.right != null) {
                p = p.right;
            } else {
                Entry<K,V> parent = p.parent;
                Entry<K,V> ch = p;
```

这类 `ceiling` / `floor` / `higher` / `lower` / `subMap` 能力，都是“顺着 key 的比较顺序导航”的直接结果。哈希结构没有全局比较序，就不可能自然提供这种对数复杂度的范围查询。

所以对业务而言，TreeMap 的核心价值应当表述为：

```text
不是只是“有序”
而是“能围绕 key 的比较顺序做导航和范围操作”
```

## 八、最终选型为什么必须分流

现在就能把两条“有序 Map”路线真正分开了。

### 什么时候选 LinkedHashMap

当你关心的是：

- 插入顺序；
- 最近访问顺序；
- LRU 这类基于历史访问痕迹的淘汰语义；
- 仍然希望保留接近 HashMap 的哈希访问特性。

### 什么时候选 TreeMap

当你关心的是：

- key 的自然序或自定义比较序；
- `floor/ceiling/subMap` 这类范围导航；
- 有序区间、排行榜、边界搜索；
- 能接受 O(log n)` 的结构维护成本来换取顺序能力。

所以“有序 Map”绝不是一个单一选型题，而至少有两种不同的顺序语义：

```text
保历史顺序
   → LinkedHashMap

保比较顺序
   → TreeMap
```

## 九、五个最容易混掉的边界：LinkedHashMap 不是链表 Map，accessOrder 不是默认插入序，LRU 不是额外魔法，TreeMap 不是有序 HashMap，compare==0 也不只是排序细节

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`LinkedHashMap` 不是“把 HashMap 换成链表”。它保留了原来的哈希桶结构，只是在每个 entry 上额外挂 `before/after`，维护一条贯穿所有 entry 的全局顺序链。

第二，`accessOrder=true` 也不是默认行为。默认构造出来的 `LinkedHashMap` 仍然按插入顺序遍历；只有显式打开访问序之后，命中的 entry 才会被移动到尾部，`get()` 也因此可能成为结构性修改。

第三，LRU 也不是 JDK 额外藏了一套缓存算法。访问序已经让 head 天然代表最久未访问节点，`removeEldestEntry` 只需在插入后检查并淘汰它，所以 LRU 是既有顺序语义和淘汰策略自然对齐的结果。

第四，`TreeMap` 更不是“会排序的 HashMap”。它从根上就放弃哈希分桶，改用 comparator/Comparable 驱动红黑树；它维护的不是访问历史，而是 key 的全局比较顺序。

第五，TreeMap 里的 `compare(...) == 0` 也不只是排序细节。它直接决定两个 key 在树里是否落到同一个逻辑位置，所以如果比较器与 `equals` 不一致，树本身仍然能工作，但 Map 契约语义会发生偏移。

把这五条边界记稳，LinkedHashMap 与 TreeMap 这一篇就不会重新塌回“两个有序 Map 的类实现对比”这种表面印象。它真正想讲的是：业务说“要有序”时，必须先问自己要保的是历史顺序，还是 key 的比较顺序。

## 收网：同样叫“有序”，但它们维护的根本不是同一种秩序

现在回到最开始的那个总问题：Map 要“有序”，到底是在保什么序？

`LinkedHashMap` 维护的是一条历史链：谁先插入、谁最近访问，它就在 `head` / `tail` 和 `before/after` 这条双向链上体现出来。它的哈希定位能力基本保留，只是多付出链维护成本，因此顺手就能做出 LRU。

`TreeMap` 维护的是比较秩序：谁比谁小、谁落在哪个区间、某个 key 的前驱后继是谁，这些信息不是额外挂链能补出来的，必须让整个结构都服从比较器，也就是红黑树路线。

把整篇压成一张图，就是：

```text
Map 需要顺序
   ├── 保遍历/历史顺序
   │    → LinkedHashMap
   │    → HashMap + before/after 双向链
   │    → 插入序 / 访问序 / LRU
   └── 保 key 比较顺序
        → TreeMap
        → 红黑树
        → floor / ceiling / subMap
```

实际使用时，先记住四条：

1. **LinkedHashMap 与 TreeMap 维护的是两种完全不同的“有序”语义。**
2. **LinkedHashMap 的顺序来自 HashMap 之外额外挂的一条全局双向链。**
3. **`accessOrder=true` + `removeEldestEntry` 之所以能形成 LRU，是因为 head/tail 已经天然表达了“最久未访问/最近访问”。**
4. **TreeMap 的相等与定位核心来自比较结果，而不是哈希；它换来的关键能力是范围导航。**

下一篇把整个 Map 家族收束起来：什么时候该用 `HashMap`、`LinkedHashMap`、`TreeMap`，什么时候又该转向 `WeakHashMap`、`IdentityHashMap`、`EnumMap` 这些特种兵。

> → 下一篇：[Map 家族与选型](04-map-family.md)
