# HashMap 的存储与哈希：它为什么不是 `hash % n` 的教学版数组

> 本文基于 JDK 11 `HashMap` 源码。重点讨论 `hash()` 扰动、2 的幂寻址、`table` + `Node` 桶结构，以及 `putVal` / `getNode` 的主分支；扩容拆桶、树化/退化和更细的冲突治理放到下一篇。本文讨论的是 JDK 11 `HashMap` 的基础存储与寻址骨架，不把这里的扰动策略、位与寻址和树化资格检查外推成所有哈希表实现都必须遵守的统一规范。
> **前置依赖**：[String.hashCode 与哈希契约](../01-string/02-equals-hashcode-compare.md)、[迭代器与 fail-fast](../08-collections/04-iterator-failfast.md)
> **后续**：[扩容与树化](02-resize-treeify.md)

## 真正该先纠正的，不是某个面试答案，而是那个过于简化的教学模型

很多人第一次学哈希表时，脑中都有一个非常顺手的模型：

```text
数组
   + hashCode
   + 取模
   + 冲突时挂链表
```

这个模型足够入门，但如果你拿它直接去解释 JDK 11 的 `HashMap`，很快就会撞墙。因为真实实现必须同时处理这些问题：

- `hashCode()` 的低位分布可能很差；
- 寻址必须尽量快；
- 正常情况下希望平均 O(1)`；
- 极端碰撞时又不能退化得太惨；
- 桶里元素很少时不值得上树，太多时又不能一直忍着链表。

所以 JDK 里的 `HashMap`，不是“数组 + 哈希函数”这么朴素，而是一套围绕“让碰撞更少、碰撞后也别太惨”不断补细节的工程方案。

## 一、HashMap 的底层不是单一结构，而是“数组 + 桶节点”的多形态组合

### 先把最底层的容器摆出来：`table`

JDK 11 里真正存桶入口的是一个节点数组：

```java
// HashMap.java:376-392
/**
 * Returns a power of two size for the given target capacity.
 */
static final int tableSizeFor(int cap) {
    int n = -1 >>> Integer.numberOfLeadingZeros(cap - 1);
    return (n < 0) ? 1 : (n >= MAXIMUM_CAPACITY) ? MAXIMUM_CAPACITY : n + 1;
}

/* ---------------- Fields -------------- */

/**
 * The table, initialized on first use, and resized as
 * necessary. When allocated, length is always a power of two.
 */
transient Node<K,V>[] table;
```

这里先别急着看 `tableSizeFor`，先抓住 `table` 这个事实：**HashMap 的第一层确实是数组。** 但数组槽位里放的不是值本身，而是桶入口节点。

### 桶里装的是 `Node`，不是直接一对 key/value

```java
// HashMap.java:276-291
/**
 * Basic hash bin node, used for most entries.
 */
static class Node<K,V> implements Map.Entry<K,V> {
    final int hash;
    final K key;
    V value;
    Node<K,V> next;

    Node(int hash, K key, V value, Node<K,V> next) {
        this.hash = hash;
        this.key = key;
        this.value = value;
        this.next = next;
    }
```

这就把 HashMap 的真实形态说清楚了一半：

```text
table[i]
   → 不是直接一个 value
   → 而是某个桶的首节点 Node

Node
   → 持有 hash / key / value / next
   → next 让同桶冲突项能串起来
```

所以当别人说“HashMap 底层是数组”时，他说到了第一层；说“底层是链表”时，他说到了桶内冲突形态；说“JDK 8 之后是红黑树”时，他说到的是高冲突桶在某些条件下的升级形态。

完整说法应该是：**HashMap 是一个数组，数组每个槽位是一个桶入口，桶内部平时是 Node 链，过度拥挤时才可能转树。**

### 为什么本篇先提树阈值，但不展开树实现

JDK 11 很早就把树化相关常量定义出来了：

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

第一篇先把这些阈值摆出来，是为了让读者知道：JDK 11 从一开始就没把“链表冲突”当成唯一终点。但树化到底何时触发、为什么容量小于 64 时优先扩容、扩容后链和树怎么拆，这些细节更适合下一篇集中讲。

## 二、`hash()` 为什么一定要做扰动：因为寻址只看低位

### JDK 11 的扰动函数很短，但它不是装饰动作

```java
// HashMap.java:322-340
/**
 * Computes key.hashCode() and spreads (XORs) higher bits of hash
 * to lower.  Because the table uses power-of-two masking, sets of
 * hashes that vary only in bits above the current mask will
 * always collide.
 */
static final int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```

它只做了两件事：

- `null` key 直接返回 0；
- 非空 key 先拿 `hashCode()`，再把高 16 位右移后与自身异或。

很多人会背“高位异或低位”，但不明白为什么必须这么做。真正原因在下一节才会完整显现：**HashMap 的下标寻址只吃低位。**

### 如果只吃低位，就必须尽量把高位信息折下来

假设两个 key 的 `hashCode()` 恰好低位一样、高位不同。如果你后面只用低几位去定位桶，那它们就会被迫落到同一个槽位，即使原始 `hashCode()` 并不相同。

`(h >>> 16) ^ h` 的作用，就是用极低成本做一次“高位参与低位”的折叠。它不会神奇消灭碰撞，但能明显减少“高位明明不同，却因为低位相同而系统性扎堆”的问题。

这也是 JDK 注释里为什么强调：由于表使用 2 的幂掩码，高于当前 mask 的那些位如果不下沉，就永远不会参与索引计算。

### `null` key 为什么能工作

JDK 11 的 `hash(null)` 直接给 0。这不是额外开一套旁门逻辑，而是最简单的稳定路径：

```text
null key
   → hash = 0
   → 后续照常参与桶定位
```

所以 `HashMap` 允许 `null` key，不是因为桶逻辑完全特殊，而是因为它给 `null` 规定了一个固定哈希值，并让它走正常管线。

## 三、为什么容量必须是 2 的幂：因为 JDK 想把取模变成位与

### `tableSizeFor` 保证最终容量落在 2 的幂上

JDK 11 会把用户给出的目标容量抬到最近的 2 的幂：

```java
// HashMap.java:376-381
static final int tableSizeFor(int cap) {
    int n = -1 >>> Integer.numberOfLeadingZeros(cap - 1);
    return (n < 0) ? 1 : (n >= MAXIMUM_CAPACITY) ? MAXIMUM_CAPACITY : n + 1;
}
```

比如 `new HashMap(100)`，最终并不是 100 个桶，而是 128。原因不是拍脑袋凑整，而是为了让后面的寻址公式成立。

### 真正的桶定位不是 `% n`，而是 `(n - 1) & hash`

不管是 `getNode` 还是 `putVal`，定位桶时都走同一个表达式：

```java
// HashMap.java:563-566
if ((tab = table) != null && (n = tab.length) > 0 &&
    (first = tab[(n - 1) & hash]) != null) {
```

```java
// HashMap.java:621-627
final V putVal(int hash, K key, V value, boolean onlyIfAbsent,
               boolean evict) {
    Node<K,V>[] tab; Node<K,V> p; int n, i;
    if ((tab = table) == null || (n = tab.length) == 0)
        n = (tab = resize()).length;
    if ((p = tab[i = (n - 1) & hash]) == null)
        tab[i] = newNode(hash, key, value, null);
```

当 `n` 是 2 的幂时，`(n - 1)` 的二进制就是低位全 1，这样位与操作本质上就等价于对 `n` 取模，但成本更低、实现更直。

### 所以扰动函数和 2 的幂寻址是配套设计，不是两个孤立技巧

到这里就能把前两节连起来了：

```text
先把容量限定成 2 的幂
   → 让寻址可以用 (n - 1) & hash
   → 速度更好

但这样只会读取 hash 的低位
   → 所以必须先做扰动
   → 把高位信息折进低位
```

也就是说：

- 没有 2 的幂容量，位与寻址这套收益就不成立；
- 没有扰动函数，位与寻址就更容易因为低位偏斜产生碰撞。

这两个设计是前后咬合的一套组合拳。

## 四、`putVal` 的真正逻辑不是“放进去”，而是一连串分支决策

### `put` 只是把任务转交给 `putVal`

```java
// HashMap.java:607-608
public V put(K key, V value) {
    return putVal(hash(key), key, value, false, true);
}
```

真正的主战场是 `putVal`。

### 把它当成一棵决策树，比背六条更容易真正理解

```java
// HashMap.java:621-661
final V putVal(int hash, K key, V value, boolean onlyIfAbsent,
               boolean evict) {
    Node<K,V>[] tab; Node<K,V> p; int n, i;
    if ((tab = table) == null || (n = tab.length) == 0)
        n = (tab = resize()).length;
    if ((p = tab[i = (n - 1) & hash]) == null)
        tab[i] = newNode(hash, key, value, null);
    else {
        Node<K,V> e; K k;
        if (p.hash == hash &&
            ((k = p.key) == key || (key != null && key.equals(k))))
            e = p;
        else if (p instanceof TreeNode)
            e = ((TreeNode<K,V>)p).putTreeVal(this, tab, hash, key, value);
        else {
            for (int binCount = 0; ; ++binCount) {
                if ((e = p.next) == null) {
                    p.next = newNode(hash, key, value, null);
                    if (binCount >= TREEIFY_THRESHOLD - 1)
                        treeifyBin(tab, hash);
                    break;
                }
                if (e.hash == hash &&
                    ((k = e.key) == key || (key != null && key.equals(k))))
                    break;
                p = e;
            }
        }
        if (e != null) {
            V oldValue = e.value;
            if (!onlyIfAbsent || oldValue == null)
                e.value = value;
            afterNodeAccess(e);
            return oldValue;
        }
    }
    ++modCount;
    if (++size > threshold)
        resize();
    afterNodeInsertion(evict);
    return null;
}
```

如果把这段代码翻译成人话，路径其实很清楚：

1. 先看表是否已经分配；没有就先初始化。
2. 用 `(n - 1) & hash` 算出目标桶下标。
3. 如果桶空，直接落一个新节点，这是最理想路径。
4. 如果桶首节点就是同一个 key，那本次是覆盖，不是新增。
5. 如果桶已经是树，交给树插入路径。
6. 如果桶还是链，就顺着 `next` 走：找到同 key 就停，走到尾部就挂新节点。
7. 链太长时，触发树化检查。
8. 真正发生新增后，`size` 才增长，并在必要时触发扩容。

这就是 `put` 真正的工程味：不是“算个下标往里塞”，而是一层层根据桶当前形态做分支决策。

### 树化检查并不等于“链长到 8 就一定上树”

在链表尾部新增时，JDK 11 会做树化检查：

```java
// HashMap.java:637-640
if ((e = p.next) == null) {
    p.next = newNode(hash, key, value, null);
    if (binCount >= TREEIFY_THRESHOLD - 1)
        treeifyBin(tab, hash);
```

但 `treeifyBin` 里第一件事不是立刻变树，而是先看表容量够不够：

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

这意味着：**桶长到阈值，只是触发“树化资格检查”；当表太小时，JDK 11 更愿意先扩容，而不是直接把桶树化。**

下一篇会专门讲为什么这样设计，以及扩容如何重分桶。

## 五、`getNode` 和 `putVal` 是镜像关系：先定位桶，再看桶内形态

### `get` 也不是“一步拿值”，而是先走同一套桶定位

```java
// HashMap.java:563-580
final Node<K,V> getNode(int hash, Object key) {
    Node<K,V>[] tab; Node<K,V> first, e; int n; K k;
    if ((tab = table) != null && (n = tab.length) > 0 &&
        (first = tab[(n - 1) & hash]) != null) {
        if (first.hash == hash &&
            ((k = first.key) == key || (key != null && key.equals(k))))
            return first;
        if ((e = first.next) != null) {
            if (first instanceof TreeNode)
                return ((TreeNode<K,V>)first).getTreeNode(hash, key);
            do {
                if (e.hash == hash &&
                    ((k = e.key) == key || (key != null && key.equals(k))))
                    return e;
            } while ((e = e.next) != null);
        }
    }
    return null;
}
```

可以看到，读取和写入的主线是一致的：

- 先算扰动后的 hash；
- 再用位与定位桶；
- 先比较首节点；
- 再根据桶是树还是链决定下一步。

### 为什么总是先比较首节点

这不是无意义的模板动作。正常情况下，桶空或单节点桶其实是常态；即使有碰撞，首节点命中的概率也很高。先比较首节点，能让最常见路径尽快返回，不必一上来就走链或进树。

所以 `HashMap` 的平均 O(1)`，靠的不是某个神奇公式，而是：

- 定位桶尽量快；
- 常见路径尽量短；
- 冲突时按桶形态分支；
- 极端长桶再逐步升级治理。

## 六、键为什么必须尊重 `equals` / `hashCode` 契约

### HashMap 认“同一个 key”，要同时满足哈希和相等性条件

无论在 `getNode` 还是 `putVal`，JDK 判断“是不是同一个 key”都不是只看 `equals`，也不是只看 hash，而是两步一起：

```text
先 hash 相同
再 equals 成立
```

也就是源码里的这种判断：

```java
// HashMap.java:567-576
if (first.hash == hash &&
    ((k = first.key) == key || (key != null && key.equals(k))))
    return first;
```

### 这就是为什么违反契约会直接把 HashMap 搞坏

如果两个 key `equals` 为真，但 `hashCode` 却不同，那么它们会被定位到不同桶。这样一来，你后续拿“逻辑上相等”的另一个对象去查找，可能永远也找不到原来的映射。

可变 key 也是同一个坑：对象放进 map 之后，如果你又修改了参与 `equals` / `hashCode` 的字段，那么它重新计算出来的 hash 可能已经对应另一个桶位。Map 里旧节点还在原桶里，但你以后按新 hash 去找，自然像“丢了”一样。

所以对 `HashMap` 来说，键正确性的铁律是：

- `equals` 相等的对象，`hashCode` 必须相等；
- 作为 key 使用期间，参与 `equals` / `hashCode` 的状态最好不可变；
- `null` key 例外但仍有稳定规则：固定走 hash 0 路径。

## 九、五个最容易混掉的边界：HashMap 不是 `% n` 教学表，扰动不是花活，树阈值不是立即上树，`put` 不是直塞，`null` key 也不是旁门例外

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，HashMap 不是“`hashCode % n` 的教学版数组”那么简单。它真正站在的是工程语义里：低位分布不可信、寻址要尽量快、冲突要可治理，所以数组、桶节点、树化阈值和扩容路径必须一起配合。

第二，`hash()` 的扰动也不是无意义花活。只要寻址最终只吃低位，那高位信息如果不被折下来，就永远不会参与桶定位；扰动函数的价值，正是在极低成本下减少这种低位系统性扎堆。

第三，链长到阈值也不等于立刻上树。树化阈值触发的是“是否具备树化资格”的检查；表容量太小时，JDK 11 会优先扩容而不是急着把桶转成树。这说明链长数字本身从来不是唯一判据。

第四，`put` 更不是“算完下标就直接塞进去”。真正的路径是一棵决策树：先看表是否初始化、桶是否为空、首节点是否同 key、桶当前是链还是树、是覆盖还是追加、最后才看是否触发扩容或树化检查。

第五，`null` key 也不是绕开主逻辑的旁门例外。它只是被赋予了一个稳定的 hash=0，再照常参与同一套桶定位与节点管理流程；特殊的是取值，不是整条机制。

把这五条边界记稳，HashMap 这一篇就不会重新塌回“数组、链表、红黑树三选一”和“记住 2 的幂”这种面试口诀印象。它真正想讲的是：HashMap 的平均 O(1)` 来自一整套彼此咬合的分布修复、寻址优化和冲突分支治理。

## 收网：HashMap 的平均 O(1)` 不是凭空来的，而是一整套互相咬合的设计

现在回到最开始那个过于简化的教学模型。

真实的 JDK 11 `HashMap` 当然仍然是哈希表，但它不是“直接 `hashCode % n` 后挂链表”这么简单。它真正做的是：

- 先用扰动函数把高位信息折进低位；
- 再把容量维持在 2 的幂上，让位与寻址成立；
- 用 `table` 作为第一层桶数组；
- 用 `Node` 作为桶内基本节点；
- 在 `put/get` 时先定位桶，再按桶当前形态分支；
- 在冲突增长到一定程度时，准备升级到树化治理。

把整篇压成一张图，就是：

```text
key
   → hashCode()
   → hash() 扰动
   → (n - 1) & hash 定位桶
   → table[i]
        ├── 空桶：直接放 / 查无此 key
        ├── 单节点或链：逐个比较 hash + equals
        └── 树桶：交给树路径
```

实际使用时，先记住四条：

1. **HashMap 的底层不是“数组 or 链表 or 红黑树”三选一，而是数组 + 桶多形态结构。**
2. **扰动函数与 2 的幂寻址是配套设计**；一个改善低位分布，一个让位与取模成立。
3. **`putVal` 的本质是一棵分支决策树**，不是简单“算下标然后塞进去”。
4. **HashMap 的正确性高度依赖 key 的 `equals` / `hashCode` 契约**；可变 key 和契约违规都会直接破坏查找。

下一篇进入这套设计里最容易被追问、也是 JDK 8 以后最精彩的一段：扩容和树化。为什么扩容时节点不是重新计算完整 hash，而只看一位？为什么链长到 8 还不一定马上变树？这些都在下一篇收口。

> → 下一篇：[扩容与树化](02-resize-treeify.md)
