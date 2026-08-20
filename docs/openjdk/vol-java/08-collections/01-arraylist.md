# ArrayList：动态数组为什么快，为什么删起来又会疼

> 本文基于 JDK 11 `Collection`、`List`、`Collections` 与 `ArrayList` 源码。重点讨论 ArrayList 作为动态数组实现的存储模型、扩容、删除与视图语义；`modCount` / fail-fast、`HashMap`、并发集合和排序细节留到后续篇章。本文讨论的是 JDK 11 `ArrayList` 作为 List 实现的动态数组机制，不把这里的懒分配、1.5x 扩容和视图/复制取舍外推成所有动态数组容器都必须遵守的统一规范。
> **前置依赖**：[StringBuilder 扩容与字符数组](../01-string/03-build-concat.md)、[System.arraycopy 与数组复制运行时](../03-object-system/02-system-runtime.md)
> **后续**：[LinkedList、Vector、Stack](02-linkedlist-vector.md)

## 先别背 1.5 倍，先问 List 为什么需要一个“会长大的数组”

很多人第一次学集合时，会把 ArrayList 理解成“就是一个能自动扩容的数组”。这句话不算错，但它太像结果，不像机制。真正的问题是：既然 Java 已经有数组，为什么集合框架还要多造一个 ArrayList？

JDK 在 `Collection` 和 `List` 里先定义的是“怎样组织元素、允许哪些操作”，再由 ArrayList 选择用数组去实现这些语义。

```java
// Collection.java:34-41
 * The root interface in the <i>collection hierarchy</i>.  A collection
 * represents a group of objects, known as its <i>elements</i>.  Some
 * collections allow duplicate elements and others do not.  Some are ordered
 * and others unordered.  The JDK does not provide any <i>direct</i>
 * implementations of this interface: it provides implementations of more
 * specific subinterfaces like {@code Set} and {@code List}.
```

`List` 再往下加上“有顺序、可重复、可按索引访问”的约束：

```java
// List.java:31-39
 * An ordered collection (also known as a <i>sequence</i>).  The user of this
 * interface has precise control over where in the list each element is
 * inserted.  The user can access elements by their integer index (position in
 * the list), and search for elements in the list.<p>
 *
 * Unlike sets, lists typically allow duplicate elements.  More formally,
 * lists typically allow pairs of elements {@code e1} and {@code e2}
 * such that {@code e1.equals(e2)}, and they typically allow multiple
```

也就是说，ArrayList 首先是 `List` 的一个实现，其次才是“底层用数组”。它要同时满足：

- 像数组一样支持快速随机访问；
- 像集合一样支持元素个数动态变化；
- 还要维持 `List` 的顺序、重复元素和索引语义。

这就逼出了动态数组的核心设计：**底层数组长度和逻辑元素个数必须分开。**

## 一、ArrayList 的本体：`elementData` 和 `size` 不是一回事

### 动态数组一定要把容量和逻辑大小分开

ArrayList 的存储本体并不复杂：一个数组，加一个记录当前元素数的整数。

```java
// ArrayList.java:166-168
public ArrayList() {
    this.elementData = DEFAULTCAPACITY_EMPTY_ELEMENTDATA;
}
```

上面这段只是默认构造器；真正让它成为“动态数组”的，是底层一直维护着一个 `elementData` 数组和一个独立的 `size`。旧稿已经讲过这两个字段，这里要把它们背后的语义说透：

```text
elementData.length
   → 当前底层数组容量 capacity

size
   → 当前实际存放的元素个数
```

如果这两个值永远相等，就不可能既保留已分配的空槽位，又支持后续追加时少复制几次。ArrayList 的所有行为——扩容、删除、缩容、序列化、`toArray`——都建立在这个分离之上。

### 默认构造为什么不直接分配 10 个槽位

很多面试答案上来就说“ArrayList 默认容量是 10”。这句话只对了一半。JDK 11 的默认构造器并没有直接 `new Object[10]`，而是先指向一个共享空数组：

```java
// ArrayList.java:166-168
public ArrayList() {
    this.elementData = DEFAULTCAPACITY_EMPTY_ELEMENTDATA;
}
```

而带初始容量的构造器则会立即体现你的意图：

```java
// ArrayList.java:152-160
public ArrayList(int initialCapacity) {
    if (initialCapacity > 0) {
        this.elementData = new Object[initialCapacity];
    } else if (initialCapacity == 0) {
        this.elementData = EMPTY_ELEMENTDATA;
    } else {
        throw new IllegalArgumentException("Illegal Capacity: "+
                                           initialCapacity);
    }
}
```

这意味着三个场景并不一样：

```text
new ArrayList()
   → 先不分配业务槽位，共享默认空数组

new ArrayList(0)
   → 也是空数组，但不是“默认容量懒分配”那条分支

new ArrayList(100)
   → 立即分配 100 个槽位
```

为什么默认构造要这么做？因为空列表在真实业务里极其常见。一个 Web 请求对象、一个 ORM 实体、一个 DTO，可能都挂着若干集合字段，但其中大部分在很多请求里始终为空。如果每次 `new ArrayList()` 都立刻分配 10 个槽位，大量空列表会把堆空间浪费在根本用不到的数组上。

所以真正准确的说法是：**默认容量 10 是“首次需要增长时的默认目标”，不是“默认构造时已经分配好的数组长度”。**

### ArrayList 为什么读起来快

ArrayList 最核心的优势，是按索引读取几乎就是数组下标访问：

```java
// ArrayList.java:458-460
public E get(int index) {
    Objects.checkIndex(index, size);
    return elementData(index);
}
```

这背后没有链表跳转，也没有哈希查找，只有一次越界检查和一次数组访问。只要你知道索引，读取就是 O(1)。这也是它能成为 `List` 默认首选实现的根本原因：大多数业务对“读”和“尾部追加”的需求，远大于对“中间频繁插入删除”的需求。

## 二、扩容不是一句“1.5 倍”就结束，第一次和后面不是同一件事

### 先看 add 的真实路径

ArrayList 的追加最终会落到 `grow` 和 `newCapacity`：

```java
// ArrayList.java:497-500
public boolean add(E e) {
    modCount++;
    add(e, elementData, size);
    return true;
}
```

真正做增长的是这里：

```java
// ArrayList.java:237-244
private Object[] grow(int minCapacity) {
    return elementData = Arrays.copyOf(elementData,
                                       newCapacity(minCapacity));
}

private Object[] grow() {
    return grow(size + 1);
}
```

而新容量计算逻辑在 `newCapacity`：

```java
// ArrayList.java:255-269
private int newCapacity(int minCapacity) {
    int oldCapacity = elementData.length;
    int newCapacity = oldCapacity + (oldCapacity >> 1);
    if (newCapacity - minCapacity <= 0) {
        if (elementData == DEFAULTCAPACITY_EMPTY_ELEMENTDATA)
            return Math.max(DEFAULT_CAPACITY, minCapacity);
        if (minCapacity < 0)
            throw new OutOfMemoryError();
        return minCapacity;
    }
    return (newCapacity - MAX_ARRAY_SIZE <= 0)
        ? newCapacity
        : hugeCapacity(minCapacity);
}
```

这段代码里至少有三层信息，不能只背中间那一行公式。

### 第一次 add 不是 1.5 倍，而是先跳到默认容量

`oldCapacity + (oldCapacity >> 1)` 确实是 1.5x，但默认构造的首次写入并不走你熟悉的“从旧容量乘出来”的直觉，因为那时 `oldCapacity` 还是 0。

JDK 11 专门留了一个分支：

```java
// ArrayList.java:260-261
if (elementData == DEFAULTCAPACITY_EMPTY_ELEMENTDATA)
    return Math.max(DEFAULT_CAPACITY, minCapacity);
```

这意味着：

```text
new ArrayList()
   → 第一次 add
   → 不是 0 扩成 0
   → 而是直接扩到 DEFAULT_CAPACITY，也就是 10
```

而 `new ArrayList(0)` 不同，它走的是 `EMPTY_ELEMENTDATA`，首次添加时并不会自动跳到“默认 10”这条懒分配路径。

所以“ArrayList 默认容量是 10”这句话如果不补这一层，读者在源码面前会立刻困惑：默认构造明明没分配 10，为什么你却说它默认 10？

### 后续为什么选择 1.5x，而不是 2x

当 ArrayList 已经进入正常增长状态时，计算式就是：

```java
// ArrayList.java:257-258
int oldCapacity = elementData.length;
int newCapacity = oldCapacity + (oldCapacity >> 1);
```

这就是把旧容量增加一半，也就是 1.5 倍。它不是数学趣味题，而是一个很工程化的折中：

```text
增长因子更大
   → 扩容次数更少
   → 但空闲槽位浪费更多

增长因子更小
   → 空闲浪费更少
   → 但扩容复制更频繁
```

如果直接翻倍，确实能减少扩容次数，但每次扩完后留下的空槽位会更多；如果增长太保守，虽然省空间，但频繁复制又会让追加成本抬高。1.5x 的意义就在于：让复制次数和空间浪费都落在一个比较平衡的位置。

### 为什么它仍然是均摊 O(1)

很多人一看到扩容要 `Arrays.copyOf`，就会担心 `add` 不是 O(1)。这要区分单次成本和均摊成本。

一次触发扩容时，确实要复制已有元素；但不是每次 `add` 都扩容。容量增长形成的是一个几何序列，因此总复制量不会跟每次追加等比例增长。

直觉上可以这样理解：

```text
前一段时间白拿空槽位
   → 直到槽位用完才一次性复制
   → 再换来下一段时间的空槽位
```

复制的痛苦不是每次都付，而是偶尔集中付一次，再摊到一长串普通 `add` 上。于是总成本对 n 次追加仍然是 O(n)，均摊到单次就是 O(1)。

### 扩容还有两个保护边界

源码里还有两个常被忽略、但很值得提的边界：

- 默认空数组首次增长要走 `DEFAULT_CAPACITY` 分支；
- 容量溢出时会抛 `OutOfMemoryError`，并受 `MAX_ARRAY_SIZE` 保护。

```java
// ArrayList.java:228
private static final int MAX_ARRAY_SIZE = Integer.MAX_VALUE - 8;
```

这说明 ArrayList 的扩容不是“无限加一半”那么朴素，它还必须处理 Java 数组长度上限和整数溢出的现实限制。

## 三、删除为什么疼：因为动态数组删除的本质是搬移，不是消失

### `remove` 的主要成本在“搬后缀”

ArrayList 的删除不神秘，核心就是把被删位置之后的元素整体往前挪一格：

```java
// ArrayList.java:535-540
public E remove(int index) {
    Objects.checkIndex(index, size);
    final Object[] es = elementData;

    @SuppressWarnings("unchecked") E oldValue = (E) es[index];
    fastRemove(es, index);
```

真正的搬移逻辑在 `fastRemove`：

```java
// ArrayList.java:669-674
private void fastRemove(Object[] es, int i) {
    modCount++;
    final int newSize;
    if ((newSize = size - 1) > i)
        System.arraycopy(es, i + 1, es, i, newSize - i);
    es[size = newSize] = null;
}
```

这段代码把 ArrayList 删除的代价解释得很清楚：

```text
删尾元素
   → 后面没有元素要搬
   → 代价接近 O(1)

删头部或中间元素
   → 整个后缀整体前移
   → 最坏 O(n)
```

所以删除慢，不是因为“集合抽象很重”，也不是因为“GC 很麻烦”，而是因为动态数组这个存储模型天然要求保持元素连续。只要你删的不是最后一个，就要有人为这个连续性买单。

### 为什么“倒着删”经常更合理

如果你在循环里按从前往后的顺序删大量元素，每次删除都会让后面的元素向前平移，累积成本可能非常高。倒着删的价值不在于魔法，而在于尽量减少每次删除时受影响的后缀长度。

更本质地说，ArrayList 不擅长的是“结构中部高频删改”，它擅长的是：

- 尾部追加；
- 按索引快速读取；
- 偶尔做批量搬移，但不是持续在中间打洞。

### 为什么默认不自动缩容

一个看似自然的想法是：既然插入会扩容，删除后为什么不顺手把数组缩小？

JDK 11 没这么做。真正负责缩容的是显式调用的 `trimToSize()`：

```java
// ArrayList.java:197-203
public void trimToSize() {
    modCount++;
    if (size < elementData.length) {
        elementData = (size == 0)
          ? EMPTY_ELEMENTDATA
          : Arrays.copyOf(elementData, size);
    }
}
```

原因很简单：自动缩容会让“增一点、删一点、再增一点”的场景产生容量抖动。你刚复制出一个更小的数组，下一次追加又要重新扩容，复制成本反而更糟。

所以 ArrayList 的默认策略是：

```text
扩容自动做
   → 因为不扩就放不下新元素

缩容不自动做
   → 因为是否值得回收空槽位，要看业务后续是否还会继续增长
```

这是一种明显偏向吞吐的默认选择：宁可暂时多占一点容量，也不愿在增删波动中不停复制。

## 四、`toArray` 和 `subList` 为什么一个复制，一个共享

### `toArray()` 选择防御性复制

很多 API 设计的味道，在 `toArray()` 上特别明显。JDK 11 的实现非常直接：

```java
// ArrayList.java:400-402
public Object[] toArray() {
    return Arrays.copyOf(elementData, size);
}
```

泛型版本也保持同样思路：不够就新建，够用就复制进去，并在尾部补 `null`：

```java
// ArrayList.java:430-436
if (a.length < size)
    return (T[]) Arrays.copyOf(elementData, size, a.getClass());
System.arraycopy(elementData, 0, a, 0, size);
if (a.length > size)
    a[size] = null;
return a;
```

这里最重要的不是“怎么复制”，而是为什么一定要复制：**ArrayList 不能把自己的内部存储直接暴露给外部。** 否则外部拿到数组后随便改一个槽位，就会绕过 `List` 的语义约束，破坏内部状态一致性。

所以 `toArray()` 体现的是集合 API 很经典的一种策略：为了封装边界和不变量，宁可付出一次复制成本。

### 视图集合为什么又选择共享

可一到 `subList()` 这类视图语义，集合框架又走了另一条路。`Collection` 文档明确介绍了 view collections 的概念：

```java
// Collection.java:111-128
 * <h2><a id="view">View Collections</a></h2>
 *
 * <p>Most collections manage storage for elements they contain. By contrast, <i>view
 * collections</i> themselves do not store elements, but instead they rely on a
 * backing collection to store the actual elements. Operations that are not handled
 * by the view collection itself are delegated to the backing collection. Examples of
 * view collections include the wrapper collections returned by methods such as
 * {@link Collections#checkedCollection Collections.checkedCollection},
 * {@link Collections#synchronizedCollection Collections.synchronizedCollection}, and
 * {@link Collections#unmodifiableCollection Collections.unmodifiableCollection}.
 * Other examples of view collections include collections that provide a
 * different representation of the same elements, for example, as
 * provided by {@link List#subList List.subList},
 * {@link NavigableSet#subSet NavigableSet.subSet}, or
 * {@link Map#entrySet Map.entrySet}.
 * Any changes made to the backing collection are visible in the view collection.
 * Correspondingly, any changes made to the view collection &mdash; if changes
 * are permitted &mdash; are written through to the backing collection.
```

这代表另一种设计哲学：如果调用方需要的不是“独立副本”，而只是“原集合的一段窗口”，那就不必复制整段元素，而是直接共享底层存储，再通过视图维护边界和一致性。

于是 `toArray()` 与 `subList()` 形成了一组非常好的对照：

```text
toArray()
   → 目标是把数据交出去
   → 选择复制，隔离内部状态

subList()
   → 目标是继续在集合体系内操作一段窗口
   → 选择共享，减少复制成本
```

共享的代价就是：视图和原列表不是彼此独立的世界。结构修改会联动，后续还会牵扯到 `modCount` 和 fail-fast，这部分放到迭代器篇再展开。

## 五、为什么现代 Java 里，ArrayList 往往比 LinkedList 更先被选中

### `List` 接口自己就提醒过你：索引和搜索的代价依赖实现

`List` 文档并没有承诺“按索引访问永远便宜”。它反而显式提醒：某些实现里，按索引访问可能跟索引值成比例增长。

```java
// List.java:50-56
 * The {@code List} interface provides four methods for positional (indexed)
 * access to list elements.  Lists (like Java arrays) are zero based.  Note
 * that these operations may execute in time proportional to the index value
 * for some implementations (the {@code LinkedList} class, for
 * example). Thus, iterating over the elements in a list is typically
 * preferable to indexing through it if the caller does not know the
```

它还提醒过，搜索方法在很多实现里会线性扫描：

```java
// List.java:64-67
 * The {@code List} interface provides two methods to search for a specified
 * object.  From a performance standpoint, these methods should be used with
 * caution.  In many implementations they will perform costly linear
 * searches.<p>
```

`Collections` 里的算法也会根据是否支持快速随机访问切换策略：

```java
// Collections.java:192-197
 * <p>This method runs in log(n) time for a "random access" list (which
 * provides near-constant-time positional access).  If the specified list
 * does not implement the {@link RandomAccess} interface and is large,
 * this method will do an iterator-based binary search that performs
 * O(n) link traversals and O(log n) element comparisons.
```

这几段放在一起，其实已经给出下一篇的伏笔：链表理论上在中间插入删除节点很便宜，但如果为了找到那个位置先走了半天链，实际收益就会被吃掉。再加上数组连续内存对 CPU 缓存更友好，ArrayList 在现代应用里通常是更常见、更稳妥的默认选择。

## 七、五个最容易混掉的边界：默认 10 不等于已分配 10，size 不是数组长度，1.5x 不是首次即生效，remove 慢不在 GC，subList 也不是独立副本

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，默认容量 10 不等于默认构造时已经分配了长度 10 的数组。JDK 11 的 `new ArrayList()` 先挂的是共享空数组，真正到第一次写入时，才会把目标容量跳到默认值。

第二，`size` 也不是底层数组长度。它表达的是当前逻辑上真正装了多少元素；数组长度只是当前可用槽位规模。两者分离，才让“先保留空槽位、后续少复制几次”这件事成立。

第三，1.5x 扩容也不是从第一次添加就一直生效。默认构造的第一次 add 走的是“从共享空数组跳到默认容量”的特殊分支；只有进入正常增长区间后，1.5x 才成为持续的扩容策略。

第四，`remove` 慢也不是因为集合抽象很重或者 GC 拖后腿。它真正疼在后缀搬移：只要删的不是尾巴，就得拿 `System.arraycopy` 把后面一整段元素往前挪一格，数组连续性在这里要收回成本。

第五，`subList()` 更不是“给你拷一份独立小列表”。它代表的是共享底层视图：范围变了、游标和结构边界跟着变了，但底层元素仍然背靠原列表。这和 `toArray()` 的防御性复制正好是相反设计。

把这五条边界记稳，ArrayList 这一篇就不会重新塌回“默认 10、扩容 1.5 倍、查询快删除慢”的面试口诀印象。它真正想讲的是：动态数组为什么要把逻辑大小和底层容量拆开，以及复制、共享、扩容、搬移这些代价是怎样被安排到不同路径上的。

## 收网：ArrayList 的快与痛，其实来自同一个设计

现在回到最开始的问题：为什么 `List` 需要一个“会长大的数组”？

因为它想同时得到两件事：数组式的快速随机访问，以及集合式的动态增删能力。为此，ArrayList 把底层存储设计成“容量”和“逻辑大小”分离的动态数组。

这套设计带来的好处和代价是成对出现的：

- 因为底层是数组，所以 `get(int)` 很快；
- 因为要动态增长，所以默认构造先不分配，首次写入再扩到默认容量；
- 因为扩容要复制，所以采用 1.5x 在空间浪费和复制频率之间折中；
- 因为元素必须连续，所以删除中间元素会搬移后缀；
- 因为不想频繁抖动，所以删除后不自动缩容；
- 因为有的场景要隔离，有的场景要共享，所以 `toArray()` 复制而 `subList()` 共享视图。

把整篇压成一张图，就是：

```text
List 契约
   → 需要有序、可重复、可按索引访问
   → 选择数组作为底层存储
   → capacity 与 size 分离
   → 默认构造懒分配
   → 首次 add 跳到 10，后续按 1.5x 增长
   → 删除靠搬移，不自动缩容
   → 导出数组时复制，切片视图时共享
```

实际使用里，只要记住四条规则就够了：

1. **`new ArrayList()` 不会立刻分配 10 个槽位**；10 是首次增长时的默认目标。
2. **ArrayList 的强项是随机访问和尾部追加**；中间高频删改会把数组搬移成本放大。
3. **删除后不自动缩容是故意的**；真的要回收空槽位时，再显式调用 `trimToSize()`。
4. **`toArray()` 是防御性复制，`subList()` 是共享视图**；两者针对的是不同的 API 目标。

下一篇进入链表和老式同步容器：如果 ArrayList 的本质是“连续数组”，那么 LinkedList 的节点链到底换来了什么，又付出了什么？

> → 下一篇：[LinkedList、Vector、Stack](02-linkedlist-vector.md)
