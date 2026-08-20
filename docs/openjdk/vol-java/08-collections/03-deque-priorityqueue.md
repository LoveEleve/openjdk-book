# ArrayDeque 与 PriorityQueue：为什么一个擅长头尾，一个擅长极值

> 本文基于 JDK 11 `ArrayDeque`、`PriorityQueue` 及 `Queue` / `Deque` 接口源码。重点讨论环形数组、二叉堆和两套队列 API 契约；阻塞队列、并发优先队列和 fail-fast 细节留到后续篇章。本文讨论的是 JDK 11 这两类非阻塞队列/堆结构的核心语义，不把这里的回绕判定、堆序维护和失败契约外推成所有队列或优先级结构都必须遵守的统一规范。
> **前置依赖**：[LinkedList、Vector、Stack](02-linkedlist-vector.md)
> **后续**：[迭代器与 fail-fast](04-iterator-failfast.md)

## 两个问题，几乎可以代表一半集合选型场景

如果你问“现代 Java 里栈一般怎么实现”，标准答案通常不是 `Stack`，而是 `ArrayDeque`。

如果你再问“持续取最小值、做 TopK、做优先级调度一般用什么”，标准答案通常不是“每次排个序”，而是 `PriorityQueue`。

这两个答案背后，其实是同一类思路：**不要维护比业务需要更多的顺序。**

- 栈、队列、双端队列只关心头尾，不关心中间有序；
- 优先队列只关心“当前最小或最大是谁”，不关心整体已经完全排好。

也正因为它们只维护自己真正关心的那部分结构，ArrayDeque 和 PriorityQueue 才能把常见操作压到很低的成本。

## 一、ArrayDeque 为什么能让数组支持头尾 O(1)

### 普通数组做队头操作，痛点在搬移

如果你用一个普通线性数组表达队列，尾插还算容易，但头插或头删会很痛：因为逻辑上的第一个元素就放在物理数组开头，前面没有空间，想在头部再塞一个元素，往往只能整体搬移已有内容。

环形数组的关键改写是：**逻辑上的头尾位置，不再和物理数组的开头结尾绑定。**

JDK 11 的 `ArrayDeque` 只维护三样核心状态：数组、头指针、尾指针。

```java
// ArrayDeque.java:107-126
 * The array in which the elements of the deque are stored.
 * All array cells not holding deque elements are always null.
 * The array always has at least one null slot (at tail).
 */
transient Object[] elements;

/**
 * The index of the element at the head of the deque
 */
transient int head;

/**
 * The index at which the next element would be added to the tail
 */
transient int tail;
```

这三个量就够了：

```text
head
   → 当前第一个元素在哪里

tail
   → 下一个尾插位置在哪里

elements
   → 物理存储还是普通数组
```

所以 ArrayDeque 的“环形”并不是把数组变成什么神秘结构，而是让逻辑顺序可以跨过数组末尾再从开头继续。

### 回绕不是魔法，只是下标越界后折回去

JDK 11 的回绕逻辑非常直接：加一越界就回到 0，减一越界就回到最后一个槽位。

```java
// ArrayDeque.java:218-230
static final int inc(int i, int modulus) {
    if (++i >= modulus) i = 0;
    return i;
}

static final int dec(int i, int modulus) {
    if (--i < 0) i = modulus - 1;
    return i;
}
```

这就是环形数组最本质的动作：**下标不是只会一路变大，而是可以在数组两端首尾相接地走。**

### `addFirst` / `addLast` 真正做的只是移动指针再写值

看头插就最明显：

```java
// ArrayDeque.java:285-291
public void addFirst(E e) {
    if (e == null)
        throw new NullPointerException();
    final Object[] es = elements;
    es[head = dec(head, es.length)] = e;
    if (head == tail)
        grow(1);
}
```

尾插则是对称操作：

```java
// ArrayDeque.java:302-308
public void addLast(E e) {
    if (e == null)
        throw new NullPointerException();
    final Object[] es = elements;
    es[tail] = e;
    if (head == (tail = inc(tail, es.length)))
        grow(1);
}
```

你会发现，和普通数组的根本差别就在这里：ArrayDeque 头尾插入时并不急着搬整段元素，而是先通过 `inc/dec` 调整逻辑边界，再把值写到新位置。

也就是说：

```text
普通数组头插
   → 物理位置被固定在 0
   → 往往要整体搬移

环形数组头插
   → head 往前绕一格
   → 直接写入
```

这就是 ArrayDeque 头尾 O(1) 的结构来源。

## 二、环形数组的难点不在回绕，而在“空”和“满”长得很像

### `head == tail` 单独看是不够的

环形结构里最容易困惑的一点是：如果头尾指针绕了一圈重新重合，那么 `head == tail` 到底表示空，还是表示已经塞满一圈？

JDK 11 的一个重要约定写在字段注释里：数组里始终至少保留一个空槽位，`tail` 所指位置始终为空。

这让“重合”不再靠单看头尾值判断，而要结合槽位内容一起判断。

### `grow` 里就能看到歧义拆解方式

扩容逻辑中有一段非常关键的判断：

```java
// ArrayDeque.java:141-160
private void grow(int needed) {
    final int oldCapacity = elements.length;
    int newCapacity;
    int jump = (oldCapacity < 64) ? (oldCapacity + 2) : (oldCapacity >> 1);
    if (jump < needed
        || (newCapacity = (oldCapacity + jump)) - MAX_ARRAY_SIZE > 0)
        newCapacity = newCapacity(needed, jump);
    final Object[] es = elements = Arrays.copyOf(elements, newCapacity);
    if (tail < head || (tail == head && es[head] != null)) {
        int newSpace = newCapacity - oldCapacity;
        System.arraycopy(es, head,
                         es, head + newSpace,
                         oldCapacity - head);
        for (int i = head, to = (head += newSpace); i < to; i++)
            es[i] = null;
    }
}
```

这里最值得抓住的不是所有扩容细节，而是这一点：

```text
tail < head
   → 逻辑顺序已经回绕

head == tail 且 es[head] != null
   → 不是空，而是已经写满到需要扩容
```

也就是说，环形数组的难点不在“怎么算下一格”，而在“如何区分指针重合时到底是哪种状态”。JDK 11 用“保留空槽位 + 结合槽位是否为空”把这个问题拆掉了。

### 扩容时还要把回绕的逻辑顺序重新摊平

如果队列内容已经跨过数组末尾再回到开头，扩容后光把数组变大还不够，还得把前后两段逻辑顺序重新整理到更大数组里。

上面 `System.arraycopy` 那一段做的，就是把从 `head` 到旧数组末尾的那条“前半腿”往新数组更靠后的位置平移，从而给逻辑顺序腾出连续空间。

所以 ArrayDeque 的成本结构很清楚：

- 平时头尾操作只改指针，接近 O(1)；
- 偶尔扩容时，会像 ArrayList 一样付一次复制和重排成本。

这也是它比链表更符合现代 JVM 和 CPU 偏好的原因：大部分时候吃连续数组的好处，少数时候集中付搬移成本。

## 三、为什么 ArrayDeque 常常比 LinkedList 更适合栈和队列

上一章已经讲过，LinkedList 的头尾操作也能做到很便宜，因为它改的是 `first` / `last` 周围的引用。但它的代价是每个元素都要包进一个节点对象里，还要付出更差的缓存局部性和更多指针跳转。

ArrayDeque 则把问题改写成：

```text
不用 Node 包装
   → 少对象分配与引用开销

不用走链
   → 连续数组更利于缓存

头尾操作不搬整段
   → 靠 head / tail 回绕维持语义
```

所以只要你的需求是：

- 栈；
- 普通队列；
- 双端队列；
- 高频头尾进出；

ArrayDeque 往往就是比 LinkedList 更现代、更默认的实现。这也正是为什么 `Stack` 的 Javadoc 最后会把读者引向 `Deque` / `ArrayDeque`。

## 四、PriorityQueue 的关键不是“有序”，而是“只保证堆顶最小”

### 它不是有序数组，而是数组表示的二叉堆

`PriorityQueue` 最容易让人误会的地方，是名字里有个“priority”，很多人就下意识以为内部元素整体是排好序的。

JDK 11 源码一开始就把真实结构写出来了：

```java
// PriorityQueue.java:94-101
 * Priority queue represented as a balanced binary heap: the two
 * children of queue[n] are queue[2*n+1] and queue[2*(n+1)].  The
 * priority queue is ordered by comparator, or by the elements'
 * natural ordering, if comparator is null: For each node n in the
 * heap and each descendant d of n, n <= d.  The element with the
 * lowest value is in queue[0], assuming the queue is nonempty.
```

它的核心字段也很少：一个数组，加一个比较器。

```java
// PriorityQueue.java:101-112
transient Object[] queue;

int size;

private final Comparator<? super E> comparator;
```

这意味着 PriorityQueue 真正维护的是“堆序”，而不是“全序”：

```text
保证
   → 父节点不大于子节点
   → 根节点 `queue[0]` 一定最小

不保证
   → 兄弟节点彼此有序
   → 整个数组按从小到大排开
```

这就是它快的根本：它不去做多余的全排序工作。

### `peek()` 为什么能是 O(1)

既然最小元素总在根节点，也就是数组下标 0，那么查看当前最小值就根本不需要搜索：

```java
// PriorityQueue.java:350-352
public E peek() {
    return (E) queue[0];
}
```

这也是优先队列名字真正的含义：它优先保证“最该先拿出来的那个元素”能立刻拿到，而不是保证你看到的所有元素已经整体有序。

## 五、`offer` 上浮、`poll` 下沉：它为什么是 O(log n)

### 插入时只修复从新节点到根的一条路径

向 PriorityQueue 里插入元素，首先就是把新值放到当前数组尾部：

```java
// PriorityQueue.java:338-347
public boolean offer(E e) {
    if (e == null)
        throw new NullPointerException();
    modCount++;
    int i = size;
    if (i >= queue.length)
        grow(i + 1);
    siftUp(i, e);
    size = i + 1;
    return true;
}
```

真正恢复堆序的是上浮：

```java
// PriorityQueue.java:650-668
private void siftUp(int k, E x) {
    if (comparator != null)
        siftUpUsingComparator(k, x, queue, comparator);
    else
        siftUpComparable(k, x, queue);
}

private static <T> void siftUpComparable(int k, T x, Object[] es) {
    Comparable<? super T> key = (Comparable<? super T>) x;
    while (k > 0) {
        int parent = (k - 1) >>> 1;
        Object e = es[parent];
        if (key.compareTo((T) e) >= 0)
            break;
        es[k] = e;
        k = parent;
    }
    es[k] = key;
}
```

新元素不会和整个数组比一遍，而只会沿着“当前节点 → 父节点 → 祖父节点”这条链往上走，直到堆序恢复为止。路径长度由树高决定，所以是 O(log n)。

### 删除堆顶时也只修复从根往下的一条路径

弹出最小值时，PriorityQueue 先拿走 `queue[0]`，再把最后一个元素挪到根节点位置，然后向下修复：

```java
// PriorityQueue.java:586-604
public E poll() {
    final Object[] es;
    final E result;

    if ((result = (E) ((es = queue)[0])) != null) {
        modCount++;
        final int n;
        final E x = (E) es[(n = --size)];
        es[n] = null;
        if (n > 0) {
            final Comparator<? super E> cmp;
            if ((cmp = comparator) == null)
                siftDownComparable(0, x, es, n);
            else
                siftDownUsingComparator(0, x, es, n, cmp);
        }
    }
    return result;
}
```

向下修复时，总是和更小的那个孩子比较：

```java
// PriorityQueue.java:698-715
private static <T> void siftDownComparable(int k, T x, Object[] es, int n) {
    Comparable<? super T> key = (Comparable<? super T>)x;
    int half = n >>> 1;
    while (k < half) {
        int child = (k << 1) + 1;
        Object c = es[child];
        int right = child + 1;
        if (right < n &&
            ((Comparable<? super T>) c).compareTo((T) es[right]) > 0)
            c = es[child = right];
        if (key.compareTo((T) c) <= 0)
            break;
        es[k] = c;
        k = child;
    }
    es[k] = key;
}
```

因此 `poll()` 的成本也不是“重新整体排序”，而只是沿着一条根到叶子的路径局部修复，所以同样是 O(log n)。

### 这就是 TopK 和调度场景为什么喜欢堆

TopK、定时调度、任务优先级这些问题的共同点，都是你不关心所有元素已经排成一条完整序列，你只关心“现在最该出来的是谁”。

堆恰好只为这件事付成本：

- 看最小值：O(1)；
- 放入一个新候选：O(log n)；
- 取出当前最小值并恢复结构：O(log n)。

这正是“只维护业务需要的那部分顺序”带来的效率优势。

## 六、批量建堆为什么是 O(n)，不是 O(n log n)

如果 PriorityQueue 已经从一个现成集合构造，就没必要把每个元素都当成独立插入。

JDK 11 在从集合初始化后，会直接 `heapify()`：

```java
// PriorityQueue.java:740-750
private void heapify() {
    final Object[] es = queue;
    int n = size, i = (n >>> 1) - 1;
    final Comparator<? super E> cmp;
    if ((cmp = comparator) == null)
        for (; i >= 0; i--)
            siftDownComparable(i, (E) es[i], es, n);
    else
        for (; i >= 0; i--)
            siftDownUsingComparator(i, (E) es[i], es, n, cmp);
}
```

起点 `(n >>> 1) - 1` 是最后一个非叶子节点。它从底向上对每棵局部子树做下沉修复，最后整棵树自然满足堆序。

为什么这能做到 O(n) 而不是 O(n log n)`？因为越靠底层的节点越多，但它们能下沉的高度越短；越靠上层的节点能下沉更远，但数量又更少。总代价不是每个节点都走满整棵树高度。

这也是一个很典型的工程优化：如果你一开始就拿到整批数据，批量建堆比一个个 `offer` 更划算。

## 七、Queue / Deque 为什么要设计两套看起来很像的方法

### 真正的区别是：失败时你想怎么表达

很多人第一次看 `Queue` 接口会觉得重复：

- `add` 和 `offer` 都像是入队；
- `remove` 和 `poll` 都像是出队；
- `element` 和 `peek` 都像是看队头。

它们的关键差异不在“做什么”，而在“失败怎么表达”。

```text
add / remove / element
   → 失败时抛异常

offer / poll / peek
   → 失败时返回特殊值（false / null）
```

这个区分不是语法小花样，而是非常实际的 API 契约：

- 如果失败意味着程序状态不合理、你希望立刻暴露问题，用抛异常那组；
- 如果失败是业务上的正常分支，比如容量不够、当前为空、稍后再试，就用返回特殊值那组。

### Deque 只是把这套契约复制到头尾两端

到了 `Deque`，这套设计会同时出现在头和尾：

- `addFirst` / `offerFirst`
- `removeFirst` / `pollFirst`
- `getFirst` / `peekFirst`
- 以及尾部对应版本

这也是为什么 `ArrayDeque` 不只是“一个更快的队列”，它还是一个更完整的双端语义实现：你可以明确地选择操作哪一端，也可以明确地选择失败该抛异常还是返回特殊值。

## 九、五个最容易混掉的边界：环形数组不是神秘结构，head==tail 不天然代表空，ArrayDeque 不是链表替身，PriorityQueue 不是全序容器，offer/poll 也不是 add/remove 的随便别名

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，环形数组不是另一种神秘内存结构。它底层仍然是普通数组，只是逻辑顺序不再被物理开头和结尾绑死，`head/tail` 负责把“从哪开始、到哪结束”这件事改写成可回绕的状态问题。

第二，`head == tail` 也不天然等于空。放到环形结构里，这个状态既可能表示空，也可能表示已经绕满一圈；JDK 必须借助“始终保留空槽位”和槽位内容一起拆歧义。

第三，`ArrayDeque` 也不是“把 LinkedList 换成数组”这么简单。它真正赢的地方，是把头尾操作从“节点改链 + 节点对象开销”改写成“指针回绕 + 偶尔扩容复制”，从而更符合现代 JVM 和 CPU 的成本结构。

第四，`PriorityQueue` 更不是“内部已经排好序，所以遍历就是从小到大”。它只保证堆顶最小，保证的是部分有序而不是全序；一旦把它误当成排序容器，很多遍历和删除预期都会立刻错位。

第五，`offer/poll/peek` 也不是 `add/remove/element` 的随便别名。它们真正表达的是不同的失败语义：一个选择抛异常，一个选择用返回值把失败交回调用方。名字看似近，契约却不是同一层。

把这五条边界记稳，`ArrayDeque/PriorityQueue` 这一篇就不会重新塌回“一个是双端队列、一个是堆”的词条印象。它真正想讲的是：这两种结构之所以高效，正是因为它们都只维护业务真正需要的那部分有序性。

## 收网：这两个结构都很快，因为它们只维护最需要的那部分秩序

现在回到开头的两个标准答案。

为什么栈和双端队列今天通常首选 ArrayDeque？因为它用环形数组把“头尾操作”从整体搬移问题，改写成指针回绕问题；在大多数时间里，你只是在连续数组上移动 `head` 和 `tail`。

为什么 TopK、调度和极值优先场景常首选 PriorityQueue？因为它不去维护整体排好序，而只维护“堆顶就是当前最该先出来的元素”。这让 `peek`、`offer`、`poll` 的成本都紧贴实际需求。

把整篇压成一张图，就是：

```text
ArrayDeque
   → 连续数组
   → head / tail 回绕
   → 头尾 O(1)
   → 偶尔扩容重排

PriorityQueue
   → 数组表示二叉堆
   → 只保证根最小
   → offer 上浮 / poll 下沉
   → 极值操作高效
```

实际使用时，先记住四条：

1. **ArrayDeque 的“环形”是逻辑顺序绕环，不是底层换结构**；物理上它仍然是普通数组。
2. **ArrayDeque 快在平时只改边界，不改整段元素**；扩容时仍可能复制和重排。
3. **PriorityQueue 是部分有序，不是全序容器**；遍历结果不能当成完整排序结果。
4. **Queue / Deque 的双套方法是在表达失败语义**；不是简单的命名重复。

下一篇进入一个所有集合都会撞上的运行时问题：为什么一边遍历一边修改常常会抛 `ConcurrentModificationException`，以及迭代器到底在替你维护什么约束。

> → 下一篇：[迭代器与 fail-fast](04-iterator-failfast.md)
