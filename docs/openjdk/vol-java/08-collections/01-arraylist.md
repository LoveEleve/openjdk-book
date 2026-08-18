# 01. ArrayList 与动态数组 — elementData、1.5x 扩容、默认容量

> **前置依赖**: [01-string/03 — StringBuilder 扩容](../01-string/03-build-concat.md)(扩容算法的对照)、[03-object-system/02 — System.arraycopy](../03-object-system/02-system-runtime.md)(复制底层的 stub)
> → **后续**:[08-collections/02 — LinkedList/Vector/Stack](02-linkedlist-vector.md)
> 关联: 内部卷 23-stub-routines 02-arraycopy(数组拷贝 stub)

## 必考题:扩容机制

"ArrayList 扩容机制"是集合面试第一题——大多数人背得出"1.5 倍",但被追问"默认构造真的分配 10 个格子吗""为什么是 1.5 不是 2""删除会不会缩容"时,就露馅了。这篇把 ArrayList 的存储、扩容、删除、toArray/subList 逐行拆开。

## 1. "ArrayList 内部是什么" — Object[] 与懒分配

### 1.1 两个字段

`ArrayList`(`java/util/ArrayList.java`)的核心是两样(`ArrayList.java:136`/`143`):

```java
// ArrayList.java:136 + 143(截取核心,逐字)
transient Object[] elementData; // non-private to simplify nested class access

private int size;
```

- **elementData**:存储数组——`transient`(序列化时绕过它,单独序列化 size 个元素,不把空闲槽位写出去)
- **size**:逻辑大小(元素数)——**≠ 数组长度**(capacity)

### 1.2 默认构造:懒分配

面试第一坑:`new ArrayList()` 到底分配了几个格子?看源码(`ArrayList.java:166-168`):

```java
// ArrayList.java:166-168(截取核心,逐字)
public ArrayList() {
    this.elementData = DEFAULTCAPACITY_EMPTY_ELEMENTDATA;
}
```

**一个格子都没分配**——`DEFAULTCAPACITY_EMPTY_ELEMENTDATA`(`ArrayList.java:128`)是共享空数组。首次 `add` 时 `newCapacity` 里的特殊分支才把它扩到 `DEFAULT_CAPACITY = 10`(`ArrayList.java:116`):

```java
// ArrayList.java:260-261(截取核心,逐字)
if (elementData == DEFAULTCAPACITY_EMPTY_ELEMENTDATA)
    return Math.max(DEFAULT_CAPACITY, minCapacity);
```

**`new ArrayList()` vs `new ArrayList(0)`** 的差别就在这: 前者用 `DEFAULTCAPACITY_EMPTY_ELEMENTDATA`(首次 add 扩到 10),后者用 `EMPTY_ELEMENTDATA`(`ArrayList.java:121`,直接空数组,不懒扩——首次 add 只扩到 1)。

### 1.3 get:O(1) 随机访问

`get(int)`(`ArrayList.java:458-461`): `Objects.checkIndex(index, size)` + `elementData(index)`——就是数组下标访问,这是 ArrayList 的核心优势。

关键设计(斜体):*懒分配让"大量空 ArrayList"零堆开销——创建即分配 10 个格子,100 万个空 list 就是 100 万个数组。capacity(数组长度)与 size(元素数)分离是动态数组的语义核心,后续所有机制(扩容/trimToSize/序列化)都建立在这两个概念上。*

## 2. "扩容一次扩多少" — 1.5x 与溢出保护

### 2.1 add 的完整路径

`add`(`ArrayList.java:497-501`)→ `grow(size + 1)` → `newCapacity`(`ArrayList.java:255-270`):

```java
// ArrayList.java:237-244 + 255-270(截取核心,逐字)
private Object[] grow(int minCapacity) {
    return elementData = Arrays.copyOf(elementData,
                                       newCapacity(minCapacity));
}

private Object[] grow() {
    return grow(size + 1);
}

private int newCapacity(int minCapacity) {
    // overflow-conscious code
    int oldCapacity = elementData.length;
    int newCapacity = oldCapacity + (oldCapacity >> 1);
    if (newCapacity - minCapacity <= 0) {
        if (elementData == DEFAULTCAPACITY_EMPTY_ELEMENTDATA)
            return Math.max(DEFAULT_CAPACITY, minCapacity);
        if (minCapacity < 0) // overflow
            throw new OutOfMemoryError();
        return minCapacity;
    }
    return (newCapacity - MAX_ARRAY_SIZE <= 0)
        ? newCapacity
        : hugeCapacity(minCapacity);
}
```

面试题的答案在 `ArrayList.java:258`: **`oldCapacity + (oldCapacity >> 1)` = 1.5x**——右移一位取半,无乘法。三个保护:

- **DEFAULT 分支**:懒分配数组首次 add 扩到 10(1.2 节)
- **minCapacity < 0 → OOME**:溢出检查(`ArrayList.java:263-264`)
- **MAX_ARRAY_SIZE = Integer.MAX_VALUE - 8**(`ArrayList.java:228`)→ 超过走 `hugeCapacity` 抛 OOME

复制本身是 `Arrays.copyOf`(内部 System.arraycopy,域 03 讲过 stub 优化)。

### 2.2 为什么 1.5 不是 2:与 StringBuilder 对照

域 01 的 StringBuilder 扩容是 `(old << 1) + 2`(2x);ArrayList 是 1.5x。增长因子是经典取舍:

| | 2x | 1.5x |
|---|---|---|
| 扩容次数 | 少 | 多 |
| 峰值浪费(上次扩容后剩余空间) | 大(浪费一半) | 小 |
| 均摊复杂度 | O(1) | O(1) |

**1.5x 的均摊证明**: 每次扩容复制 n 个元素,但只有 1/n 的 add 触发扩容——总复制量是几何级数求和,O(n) 总成本、O(1) 均摊。这个结论对任何 >1 的增长因子都成立。

### 2.3 生产规范:预分配

`new ArrayList<>(预估大小)` 避免多次扩容——循环 add 前先算好容量,扩容次数从 log n 次降到 0 次。

关键设计(斜体):*扩容的均摊 O(1) 是面试推导题: 复制成本几何级数求和(1 + 1.5 + 2.25 + ... 收敛),总 O(n) 摊到 n 次 add 是 O(1)。面试答出"1.5x 是增长因子取舍(内存浪费与扩容次数平衡)"+ "均摊推导"就完整了。*

## 3. "remove 怎么删" — fastRemove 与缩容

### 3.1 删除 = 移动元素

`remove(int)`(`ArrayList.java:535-541`)→ `fastRemove`(`ArrayList.java:669-674`):

```java
// ArrayList.java:669-674(截取核心,逐字)
private void fastRemove(Object[] es, int i) {
    modCount++;
    final int newSize;
    if ((newSize = size - 1) > i)
        System.arraycopy(es, i + 1, es, i, newSize - i);
    es[size = newSize] = null;
}
```

**把被删元素之后的所有元素整体前移一位**(System.arraycopy,同数组内平移——域 03 讲过重叠安全),末尾槽位置 null(帮助 GC)。复杂度 **O(n)**:

- 尾部删除:前移 0 个 → O(1)
- 头部删除:前移 n-1 个 → O(n)

**循环删除的坑**: 从头遍历删除百万元素 = 每次 O(n),总 O(n²)。**倒着删**(从尾部往前)把每次前移量压到最小——但最标准的姿势是迭代器的 `remove`(配合 modCount 的 fail-fast 检查,迭代器篇展开)。

### 3.2 不缩容

**remove 不缩容**——数组长度只增不减(避免频繁 resize 的抖动)。容量过剩是删除场景的内存代价,手动缩容用 `trimToSize()`(把数组收缩到 size 大小)。

### 3.3 ArrayList vs LinkedList

"增删谁快"的现代答案: **ArrayList 几乎总是更好**——尾部 add 均摊 O(1) 且缓存友好(连续内存);LinkedList 的"中间插入 O(1)"要付出定位 O(n) 的代价,节点不连续缓存命中差。

关键设计(斜体):*"删除 = 移动元素"决定了 ArrayList 的适用边界: 头部删除 O(n)、尾部删除 O(1)。面试"倒着删"的机制依据就是 fastRemove 的前移成本——越靠后删,前移越少。*

## 4. "toArray 与子视图" — 常用操作内部

### 4.1 两个相反的设计

- **toArray()**:**防御性复制**——返回新数组,外部改数组不影响内部 elementData
- **subList(from, to)**:**视图共享**——JDK11 的 `ArrayList.SubList` 内部类(`ArrayList.java:1142`,JDK9 起从 `AbstractList.SubList` 移入)共享内部数组,结构修改(增删)同步父列表

`subList` 的修改会触发父列表的 modCount 检查(fail-fast 机制,迭代器篇展开)——"subList 能独立增删吗"的答案: 能,但会同步父列表,且与父列表的并发修改互相触发 ConcurrentModificationException。

### 4.2 indexOf 线性扫描

`indexOf`/`lastIndexOf` 是 O(n) 线性扫描,`contains` 用 `equals`(域 01 的 String.equals 契约在这里消费)。

关键设计(斜体):*toArray 的"防御性复制"与 subList 的"视图共享"是两个相反设计——前者防篡改,后者省复制;面试能说出"subList 修改会同步父列表并触发 modCount 检查",就理解了视图的本质。*

## 核心悬念

ArrayList 是"数组",LinkedList 是"链表"——**链表结构长什么样**?`Node<E>` 的 prev/next 怎么串?为什么 LinkedList 的"中间插入"其实没那么快?Vector 和 Stack 又是为什么被嫌弃?——下一篇: LinkedList/Vector/Stack。

> → [08-collections/02 — LinkedList/Vector/Stack](02-linkedlist-vector.md)
