# Map 家族与选型：先看键语义，再看性能数字

> 本文基于 JDK 11 `WeakHashMap`、`IdentityHashMap`、`EnumMap`、`Hashtable` 源码。重点讨论它们的键语义、生命周期语义与底层特化结构；并发容器与 `ConcurrentHashMap` 留到后续域展开。
> **前置依赖**：[HashMap 的存储与哈希](01-hashmap-storage-hash.md)、[HashMap 的扩容与树化](02-resize-treeify.md)
> **后续**：域 13 原子类、域 10 并发集合

## 真正的选型分水岭，不是 O(1) 还是 O(log n)`，而是“这个 key 到底意味着什么”

当人们讨论 Map 选型时，最容易犯的一个错误是把问题过早简化成“哪个更快”。

但对 Map 来说，很多时候决定结构的第一因素根本不是复杂度表，而是：**key 的语义是什么。**

- 这个 key 会不会被 GC 回收？
- 这个 key 是按内容相等，还是按对象身份相等？
- 这个 key 的全集是不是固定、天然可枚举？
- 你是在写现代业务代码，还是在对接历史 API？

如果这几个问题不先分开，就很容易把 `WeakHashMap` 误用成普通缓存，把 `IdentityHashMap` 当成更快的 `HashMap`，或者在枚举键场景继续机械地写 `HashMap<Enum, V>`。

这篇文章不再讲主流的 `HashMap` / `LinkedHashMap` / `TreeMap`，而是专门讲四个“特种兵”——它们不是性能变种，而是**键语义与生命周期的特化 Map**。

## 一、WeakHashMap：这里的 key 本来就允许自己消失

### 它和普通 Map 最大的区别，不是实现技巧，而是语义本身

JDK 11 一开头就把它定义成 weak keys map：

```java
// WeakHashMap.java:37-45
 * Hash table based implementation of the {@code Map} interface, with
 * <em>weak keys</em>.
 * An entry in a {@code WeakHashMap} will automatically be removed when
 * its key is no longer in ordinary use.  More precisely, the presence of a
 * mapping for a given key will not prevent the key from being discarded by the
 * garbage collector, that is, made finalizable, finalized, and then reclaimed.
 * When a key has been discarded its entry is effectively removed from the map,
 * so this class behaves somewhat differently from other {@code Map}
 * implementations.
```

这几句几乎已经把所有“不正常表现”提前说完了：在 `WeakHashMap` 里，entry 是否继续存在，不只取决于你有没有 `remove`，还取决于 key 是否仍然被普通强引用持有。

也就是说，对它而言：

```text
key 没有强引用了
   → GC 可以回收 key
   → entry 之后也会被清理掉
```

所以如果你看到 `WeakHashMap` 里的条目“自己没了”，第一反应不应该是“Map 坏了”，而应该是：这正是它被设计出来要做的事。

### 弱的是 key，不是 value

它的 entry 结构非常直白：

```java
// WeakHashMap.java:86-103
 * <p> Each key object in a {@code WeakHashMap} is stored indirectly as
 * the referent of a weak reference.  Therefore a key will automatically be
 * removed only after the weak references to it, both inside and outside of the
 * map, have been cleared by the garbage collector.
 *
 * <p> <strong>Implementation note:</strong> The value objects in a
 * {@code WeakHashMap} are held by ordinary strong references.  Thus care
 * should be taken to ensure that value objects do not strongly refer to their
 * own keys, either directly or indirectly, since that will prevent the keys
 * from being discarded.  Note that a value object may refer indirectly to its
 * key via the {@code WeakHashMap} itself; that is, a value object may
 * strongly refer to some other key object whose associated value object, in
 * turn, strongly refers to the key of the first value object.  If the values
 * in the map do not rely on the map holding strong references to them, one way
 * to deal with this is to wrap values themselves within
 * {@code WeakReferences} before
 * inserting, as in: {@code m.put(key, new WeakReference(value))},
 * and then unwrapping upon each {@code get}.
```

再看底层字段：

```java
// WeakHashMap.java:177-180
/**
 * Reference queue for cleared WeakEntries
 */
private final ReferenceQueue<Object> queue = new ReferenceQueue<>();
```

这里的结构关系必须讲清：

- key 通过 `WeakReference` 存着；
- value 默认仍是强引用；
- 被 GC 回收的 key 会进入 `ReferenceQueue`，后续再由 map 清理。

这就是 `WeakHashMap` 最核心的陷阱来源：**弱的是键，不是整条 entry，更不是 value。**

### 为什么 value 反过来引用 key 会把弱引用语义绕穿

JDK 11 的文档直接警告了这一点，因为它太常见：如果 value 强引用了自己的 key，那么从 GC 可达性视角看，这个 key 就可能始终还能被 value 间接抓住，于是弱键根本清不掉。

也就是说，这样的结构：

```text
WeakHashMap
   key --weak--> K
   value --strong--> V
   V --strong--> K
```

会让“弱 key 自动消失”的预期失效。

这也是为什么说 `WeakHashMap` 和 `ThreadLocalMap` 在心智模型上非常接近：

- 都是弱 key；
- 都依赖后续访问触发清理；
- 都可能因为 value 反引 key 而出现“看起来该清，实际上没清掉”的泄漏风险。

### 清理并不是独立后台线程，而是被动触发的

JDK 11 的 stale entry 清理逻辑就在这里：

```java
// WeakHashMap.java:314-344
/**
 * Expunges stale entries from the table.
 */
private void expungeStaleEntries() {
    for (Object x; (x = queue.poll()) != null; ) {
        synchronized (queue) {
            @SuppressWarnings("unchecked")
                Entry<K,V> e = (Entry<K,V>) x;
            int i = indexFor(e.hash, table.length);

            Entry<K,V> prev = table[i];
            Entry<K,V> p = prev;
            while (p != null) {
                Entry<K,V> next = p.next;
                if (p == e) {
                    if (prev == e)
                        table[i] = next;
                    else
                        prev.next = next;
                    e.value = null;
                    size--;
                    break;
                }
                prev = p;
                p = next;
            }
        }
    }
}
```

而 `get()` 在真正查找前会先拿 `getTable()`，顺手做一次清理：

```java
// WeakHashMap.java:346-352
/**
 * Returns the table after first expunging stale entries.
 */
private Entry<K,V>[] getTable() {
    expungeStaleEntries();
    return table;
}
```

```java
// WeakHashMap.java:395-406
public V get(Object key) {
    Object k = maskNull(key);
    int h = hash(k);
    Entry<K,V>[] tab = getTable();
    int index = indexFor(h, tab.length);
    Entry<K,V> e = tab[index];
    while (e != null) {
        if (e.hash == h && eq(k, e.get()))
            return e.value;
        e = e.next;
    }
    return null;
}
```

所以 `WeakHashMap` 的行为看起来像“某个无名线程偷偷删数据”，其实是：GC 负责清掉 key 引用，本体清理则常在后续访问时被动发生。

## 二、IdentityHashMap：这里根本不是“内容相等”，而是“是不是同一个对象实例”

### 它故意违反普通 Map 的相等性契约

JDK 11 的文档非常不客气：

```java
// IdentityHashMap.java:37-50
 * This class implements the {@code Map} interface with a hash table, using
 * reference-equality in place of object-equality when comparing keys (and
 * values).  In other words, in an {@code IdentityHashMap}, two keys
 * {@code k1} and {@code k2} are considered equal if and only if
 * {@code (k1==k2)}.
 *
 * <p><b>This class is <i>not</i> a general-purpose {@code Map}
 * implementation!  While this class implements the {@code Map} interface, it
 * intentionally violates {@code Map's} general contract, which mandates the
 * use of the {@code equals} method when comparing objects.  This class is
 * designed for use only in the rare cases wherein reference-equality
 * semantics are required.</b>
```

这说明 `IdentityHashMap` 不是“更快的 HashMap”，而是“换了相等语义的专用容器”。

在这里，两个 key 是否算同一个，不是看 `equals()`，而是看：

```text
k1 == k2 ?
```

也就是说，两个内容一样、`equals` 也为真的对象，只要不是同一个实例，就会被视为两个不同 key。

### 它服务的是“对象身份”问题，而不是“对象内容”问题

这类语义在一般业务 Map 里很少需要，但在某些场景反而是刚需：

- 对象图去重、深拷贝、序列化图遍历；
- 调试/代理系统里，为每个具体对象实例挂一个伴随对象；
- 任何“必须按引用身份区分同内容对象”的场景。

如果你用普通 `HashMap` 做这些事，只要两个对象 `equals` 相等，就会被合并；而这恰恰违背了“同一实例”的需求。

### 既然语义变了，底层结构也跟着变了

JDK 11 并没有在 HashMap 上硬改 equals 路线，而是直接采用了线性探测数组哈希表：

```java
// IdentityHashMap.java:120-125
 * <p>Implementation note: This is a simple <i>linear-probe</i> hash table,
 * as described for example in texts by Sedgewick and Knuth.  The array
 * alternates holding keys and values.  (This has better locality for large
 * tables than does using separate arrays.)
```

基础结构和 null 占位也很直接：

```java
// IdentityHashMap.java:192-205
static final Object NULL_KEY = new Object();

private static Object maskNull(Object key) {
    return (key == null ? NULL_KEY : key);
}

static final Object unmaskNull(Object key) {
    return (key == NULL_KEY ? null : key);
}
```

寻址和探测路径如下：

```java
// IdentityHashMap.java:296-307
private static int hash(Object x, int length) {
    int h = System.identityHashCode(x);
    return ((h << 1) - (h << 8)) & (length - 1);
}

private static int nextKeyIndex(int i, int len) {
    return (i + 2 < len ? i + 2 : 0);
}
```

这里之所以每次步进 `+2`，是因为底层数组是交错存放 key/value：

```text
table[0] = key0
 table[1] = value0
 table[2] = key1
 table[3] = value1
```

### `get` / `put` 里最关键的是 `item == k`

```java
// IdentityHashMap.java:327-339
public V get(Object key) {
    Object k = maskNull(key);
    Object[] tab = table;
    int len = tab.length;
    int i = hash(k, len);
    while (true) {
        Object item = tab[i];
        if (item == k)
            return (V) tab[i + 1];
        if (item == null)
            return null;
        i = nextKeyIndex(i, len);
    }
}
```

```java
// IdentityHashMap.java:422-439
public V put(K key, V value) {
    final Object k = maskNull(key);

    retryAfterResize: for (;;) {
        final Object[] tab = table;
        final int len = tab.length;
        int i = hash(k, len);

        for (Object item; (item = tab[i]) != null;
             i = nextKeyIndex(i, len)) {
            if (item == k) {
                V oldValue = (V) tab[i + 1];
                tab[i + 1] = value;
                return oldValue;
            }
        }
```

这里的 `item == k` 就是整类语义的缩影：它根本不去问 `equals`。

所以 `IdentityHashMap` 的正确理解必须是：**它不是一种“更快的哈希表”，而是一种“把键语义切换成对象身份”的特殊 Map。**

## 三、EnumMap：这里连哈希都不想算，因为键空间早就写死了

### 枚举键最大的优势，不是“枚举少”，而是“全集已知且顺序稳定”

JDK 11 对 `EnumMap` 的定位也非常直白：

```java
// EnumMap.java:31-38
 * A specialized {@link Map} implementation for use with enum type keys.  All
 * of the keys in an enum map must come from a single enum type that is
 * specified, explicitly or implicitly, when the map is created.  Enum maps
 * are represented internally as arrays.  This representation is extremely
 * compact and efficient.
 *
 * <p>Enum maps are maintained in the <i>natural order</i> of their keys
 * (the order in which the enum constants are declared).
```

这里真正关键的前提不是“键是枚举，所以大概不多”，而是：

- 所有可能 key 来自同一个 enum class；
- 这些 key 的全集在运行时天然可得；
- 每个枚举常量都有稳定的 `ordinal()`。

一旦这三个条件成立，JDK 根本没必要再走通用哈希路线。

### 结构就是：知道类型，缓存全集，用数组直存值

```java
// EnumMap.java:86-98
private final Class<K> keyType;

private transient K[] keyUniverse;

/**
 * Array representation of this map.
 */
private transient Object[] vals;
```

构造时直接按枚举常量全集长度分配：

```java
// EnumMap.java:133-137
public EnumMap(Class<K> keyType) {
    this.keyType = keyType;
    keyUniverse = getKeyUniverse(keyType);
    vals = new Object[keyUniverse.length];
}
```

这时候整个定位问题就被改写成了：

```text
key 是哪个枚举常量
   → 看 ordinal()
   → 直接访问 vals[ordinal]
```

### 所以 `get` / `put` 近乎是“零哈希路径”

```java
// EnumMap.java:242-245
public V get(Object key) {
    return (isValidKey(key) ?
            unmaskNull(vals[((Enum<?>)key).ordinal()]) : null);
}
```

```java
// EnumMap.java:263-271
public V put(K key, V value) {
    typeCheck(key);

    int index = key.ordinal();
    Object oldValue = vals[index];
    vals[index] = maskNull(value);
    if (oldValue == null)
        size++;
    return unmaskNull(oldValue);
}
```

这就是为什么 `EnumMap` 快：它不是“更好的哈希算法”，而是**在已知稠密键空间上，干脆绕过了哈希表问题本身。**

所以 `EnumMap` 的选型不是“键碰巧是枚举，可以一试”，而是：

```text
如果 key 空间天然就是某个单一枚举全集
   → EnumMap 往往就是最自然的结构
```

## 四、Hashtable：它保留的是早期同步哈希表语义，不是现代推荐答案

### 它今天仍存在，不代表它今天仍是默认选择

JDK 11 的文档已经讲得很明白：

```java
// Hashtable.java:112-118
 * Java Collections Framework</a>.  Unlike the new collection
 * implementations, {@code Hashtable} is synchronized.  If a
 * thread-safe implementation is not needed, it is recommended to use
 * {@link HashMap} in place of {@code Hashtable}.  If a thread-safe
 * highly-concurrent implementation is desired, then it is recommended
 * to use {@link java.util.concurrent.ConcurrentHashMap} in place of
 * {@code Hashtable}.
```

这意味着 `Hashtable` 继续存在，更多是因为历史兼容和老 API 生态，而不是因为它仍然代表最佳实践。

### 它保留的是“方法级同步 + 非 null 键值”的老式契约

`get` 和 `put` 都直接是 `synchronized`：

```java
// Hashtable.java:378-388
public synchronized V get(Object key) {
    Entry<?,?> tab[] = table;
    int hash = key.hashCode();
    int index = (hash & 0x7FFFFFFF) % tab.length;
    for (Entry<?,?> e = tab[index] ; e != null ; e = e.next) {
        if ((e.hash == hash) && e.key.equals(key)) {
            return (V)e.value;
        }
    }
    return null;
}
```

```java
// Hashtable.java:472-489
public synchronized V put(K key, V value) {
    if (value == null) {
        throw new NullPointerException();
    }

    Entry<?,?> tab[] = table;
    int hash = key.hashCode();
    int index = (hash & 0x7FFFFFFF) % tab.length;
    Entry<K,V> entry = (Entry<K,V>)tab[index];
    for(; entry != null ; entry = entry.next) {
        if ((entry.hash == hash) && entry.key.equals(key)) {
            V old = entry.value;
            entry.value = value;
            return old;
        }
```

这里至少有三层和现代主流 `HashMap` 心智不同：

- 方法级同步；
- 不允许 `null` value；
- 仍走老式 `% tab.length` 开放链扩容路径。

它的 `rehash()` 也保留了老式做法：

```java
// Hashtable.java:406-433
protected void rehash() {
    int oldCapacity = table.length;
    Entry<?,?>[] oldMap = table;

    int newCapacity = (oldCapacity << 1) + 1;
    Entry<?,?>[] newMap = new Entry<?,?>[newCapacity];

    modCount++;
    threshold = (int)Math.min(newCapacity * loadFactor, MAX_ARRAY_SIZE + 1);
    table = newMap;

    for (int i = oldCapacity ; i-- > 0 ;) {
        for (Entry<K,V> old = (Entry<K,V>)oldMap[i] ; old != null ; ) {
            Entry<K,V> e = old;
            old = old.next;

            int index = (e.hash & 0x7FFFFFFF) % newCapacity;
            e.next = (Entry<K,V>)newMap[index];
            newMap[index] = e;
        }
    }
}
```

这和前面讲的 JDK 8+ `HashMap` 2 的幂扩容、位掩码定位、lo/hi 拆分完全不是同一路思路。

### 为什么它仍然重要：因为 `Properties` 等老体系还建立在它上面

`Hashtable` 今天最值得记住的，不是“它可以用”，而是“它为什么还在”。答案通常来自历史 API 兼容，比如 `Properties` 这类配置体系仍然继承它的老契约。

所以在新代码里，它更多是一个你必须认识、但很少应该主动选择的历史容器。

## 五、把四个“特种兵”放回统一选型坐标系

现在就能看到，这四个 Map 真正分化的维度其实非常统一：

### 先看键语义和生命周期

```text
key 会自己被 GC 清掉
   → WeakHashMap

key 按对象身份区分
   → IdentityHashMap

key 来自单一枚举全集
   → EnumMap

key 走传统 equals/hashCode，且你还在历史同步生态里
   → Hashtable（更多是兼容，不是新代码首选）
```

### 再看它们为什么各自长成现在的结构

- `WeakHashMap`：因为 key 生命周期受 GC 管理，所以必须有弱引用和引用队列；
- `IdentityHashMap`：因为相等语义换成 `==`，所以干脆用线性探测数组服务对象身份映射；
- `EnumMap`：因为键空间固定且稠密，直接按 ordinal 下标存值最自然；
- `Hashtable`：因为它来自旧时代同步哈希表世界，所以保留了方法级同步和老式 rehash 路线。

也就是说，Map 家族的差异首先不是“谁更先进”，而是谁在为不同的 key 语义、生命周期和兼容背景做特化。

## 收网：Map 选型不是性能排行题，而是语义匹配题

如果只看表面 API，这四个类都实现了 `Map`。但实现 `Map` 这个共同接口，不代表它们在回答同一个问题。

`WeakHashMap` 回答的是：当 key 不再被业务持有时，映射能不能自动退场。

`IdentityHashMap` 回答的是：当“内容相等”和“对象身份相同”必须区分时，Map 应该按哪种相等性工作。

`EnumMap` 回答的是：当 key 空间天然固定且可枚举时，为什么还要走通用哈希路线。

`Hashtable` 则更多是一个历史答案：它保留了早期同步哈希表的语义，因此今天仍然需要被理解，但通常不再是新设计的默认答案。

把整篇压成一张图，就是：

```text
Map 选型
   ├── 先问 key 会不会被 GC 回收 → WeakHashMap
   ├── 先问 key 是按身份还是按内容比较 → IdentityHashMap
   ├── 先问 key 空间是否固定且可枚举 → EnumMap
   └── 再考虑是否在历史同步/配置生态里 → Hashtable / Properties
```

实际使用时，先记住四条：

1. **WeakHashMap 的条目自己消失通常不是 bug，而是语义本身；真正要小心的是 value 反引 key。**
2. **IdentityHashMap 不是通用 Map 替代品，它解决的是“对象身份”而不是“对象内容”。**
3. **EnumMap 快，不是因为枚举少，而是因为它绕过了哈希，直接走 ordinal 数组下标。**
4. **Hashtable 重要的地方在历史兼容，不在现代推荐；今天真正并发场景的答案通常不再是它。**

到这里，Map 家族已经从无序哈希、顺序哈希、树有序，一直收束到弱键、身份键、枚举键和历史同步变体。下一步按照写作顺序，会先进入域 13 原子类，把 CAS 这条并发基础线补上，再回到域 10 并发集合看 `ConcurrentHashMap` 为什么能成为现代并发 Map 的主角。

> → 下一篇：域 13 原子类
