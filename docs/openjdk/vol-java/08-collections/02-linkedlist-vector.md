# LinkedList、Vector、Stack：为什么这些老朋友今天很少当默认选项

> 本文基于 JDK 11 `LinkedList`、`Vector`、`Stack` 源码。重点讨论双向链表的结构成本、`Deque` 语义、`Vector` 的方法级同步和 `Stack` 的继承式设计问题；fail-fast、并发容器和 `ArrayDeque` 的内部实现放到后续篇章。本文讨论的是 JDK 11 这三类老式集合实现的结构边界，不把这里的节点成本、方法级同步模型和继承污染问题外推成所有链表、并发列表或栈容器都必须遵守的统一规范。
> **前置依赖**：[ArrayList 与动态数组](01-arraylist.md)
> **后续**：[ArrayDeque 与 PriorityQueue](03-deque-priorityqueue.md)

## 先纠正一句传播很广、但条件经常被省掉的话

很多教材都会说：ArrayList 适合查，LinkedList 适合增删。

这句话的问题不在于完全错误，而在于把前提省掉了。LinkedList 的插入删除确实可以只改少量引用，但那成立的前提是：**你已经站在要修改的位置旁边。** 如果你只有一个下标，或者你要先搜索目标元素，那么真正先发生的通常不是 O(1) 改链，而是 O(n) 走链。

也正因为这个前提在业务代码里经常不成立，现代 Java 里 `LinkedList`、`Vector`、`Stack` 更多是“你需要知道它们为什么存在、为什么还留着”，而不是“默认先选它们”。

这篇文章要回答三个问题：

```text
LinkedList
   → 链表到底快在哪里，慢又慢在哪里？

Vector
   → 有 synchronized 为什么还不是好并发容器？

Stack
   → 明明是标准栈类，为什么源码自己都建议用 Deque？
```

## 一、LinkedList 的真正本体：不是“数组的对立面”，而是一串节点对象

### LinkedList 同时是 List，也是 Deque

JDK 11 的 `LinkedList` 并不只想做“线性表的另一种实现”，它同时实现了 `List` 和 `Deque`：

```java
// LinkedList.java:83-85
public class LinkedList<E>
    extends AbstractSequentialList<E>
    implements List<E>, Deque<E>, Cloneable, java.io.Serializable
```

这很重要。它说明 `LinkedList` 的天然语义不只是“支持按索引放元素”，还包括“头尾两端都能高效操作”。如果你只把它理解成 ArrayList 的替代品，就已经错过了一半定位。

### 双向链表换来的，是局部改链能力

它的核心状态也很直接：维护头节点和尾节点。

```java
// LinkedList.java:92-97
transient Node<E> first;

transient Node<E> last;
```

尾部插入时，JDK 11 做的事情是创建新节点，挂到 `last` 后面，再更新尾指针：

```java
// LinkedList.java:144-153
void linkLast(E e) {
    final Node<E> l = last;
    final Node<E> newNode = new Node<>(l, e, null);
    last = newNode;
    if (l == null)
        first = newNode;
    else
        l.next = newNode;
    size++;
    modCount++;
}
```

头尾删除也只是改相邻引用并断开旧节点，帮助 GC：

```java
// LinkedList.java:175-188
private E unlinkFirst(Node<E> f) {
    final E element = f.item;
    final Node<E> next = f.next;
    f.item = null;
    f.next = null;
    first = next;
    if (next == null)
        last = null;
    else
        next.prev = null;
    size--;
    modCount++;
    return element;
}
```

```java
// LinkedList.java:194-207
private E unlinkLast(Node<E> l) {
    final E element = l.item;
    final Node<E> prev = l.prev;
    l.item = null;
    l.prev = null;
    last = prev;
    if (prev == null)
        first = null;
    else
        prev.next = null;
    size--;
    modCount++;
    return element;
}
```

如果从“局部修改”视角看，链表确实很优雅：一旦你已经拿到要改的节点，新增和删除都不需要像 ArrayList 那样大段搬移元素。

### 但这份优雅是拿对象和指针换来的

链表的代价也同样明确：每个元素不是直接躺在一个连续数组里，而是包在一个节点对象里，通过前后指针串起来。也就是说，链表换来的是：

```text
优点
   → 已知节点位置时，改链代价小

代价
   → 每个元素多一个 Node 包装
   → 额外的 prev / next 引用
   → 内存更散，缓存局部性更差
```

所以 LinkedList 不是“天然比数组更高级”，而是把 ArrayList 的搬移成本，换成了节点对象和走链成本。

## 二、LinkedList 为什么经常慢：真正贵的通常不是改链，而是先找到地方

### `node(index)` 只做了折半，没有改变复杂度级别

很多人知道 LinkedList 按索引访问慢，但不知道它慢在什么地方。关键逻辑在 `node(int index)`：

```java
// LinkedList.java:570-584
Node<E> node(int index) {
    if (index < (size >> 1)) {
        Node<E> x = first;
        for (int i = 0; i < index; i++)
            x = x.next;
        return x;
    } else {
        Node<E> x = last;
        for (int i = size - 1; i > index; i--)
            x = x.prev;
        return x;
    }
}
```

这段代码做的是折半优化：前半段从头走，后半段从尾走。它确实比“永远从头遍历”更聪明，但本质没有变：**你还是要一跳一跳地走过去。**

所以：

```text
LinkedList.get(5)
   → 走几步，问题不大

LinkedList.get(500000)
   → 即使折半，也要走几十万步
```

折半优化降低的是常数，不是复杂度级别。它把最坏情况从走一整条链，缩成走半条链，但仍然是 O(n)。

### “中间插入快”只在你已经拿到节点时成立

这也是为什么“链表插入快”必须补前提。

如果你调用的是按下标插入，事情通常不是一句 O(1) 就能概括，而是：

```text
先 node(index)
   → O(n) 定位
再改前后指针
   → O(1) 改链
合起来
   → 总体仍由定位成本主导
```

也就是说，LinkedList 真正的优势场景不是“我知道第 500000 个位置要插入”，而是“我已经通过迭代器或业务流程站在那个节点旁边，现在只想在这里接入或摘掉一个节点”。

### 搜索成本也不会因为是链表就消失

按值搜索同样要顺着节点扫描：

```java
// LinkedList.java:599-615
public int indexOf(Object o) {
    int index = 0;
    if (o == null) {
        for (Node<E> x = first; x != null; x = x.next) {
            if (x.item == null)
                return index;
            index++;
        }
    } else {
        for (Node<E> x = first; x != null; x = x.next) {
            if (o.equals(x.item))
                return index;
            index++;
        }
    }
    return -1;
}
```

因此，现代业务里只要你存在这些需求，LinkedList 就很容易吃亏：

- 频繁随机访问；
- 大量按下标定位；
- 需要缓存友好的顺序遍历；
- 数据量大到节点对象本身带来明显内存和指针开销。

这就是为什么上一篇刚讲完 ArrayList，这一篇就必须纠偏：教材里的“链表增删快”只描述了局部操作，不描述整个到达路径。

## 三、LinkedList 真正自然的位置：双端队列，而不是随机访问列表

### 头尾操作才是它最顺手的语义

因为它同时实现 `Deque`，所以 `LinkedList` 的很多方法天然围绕头尾展开。

头尾添加直接复用改链：

```java
// LinkedList.java:296-308
public void addFirst(E e) {
    linkFirst(e);
}

public void addLast(E e) {
    linkLast(e);
}
```

读队头、弹队头也都是围绕 `first`：

```java
// LinkedList.java:654-679
public E peek() {
    final Node<E> f = first;
    return (f == null) ? null : f.item;
}

public E element() {
    return getFirst();
}

public E poll() {
    final Node<E> f = first;
    return (f == null) ? null : unlinkFirst(f);
}
```

所以如果把 LinkedList 当成一个双端队列，它的结构就比“按索引列表”更说得通：

```text
队头入队 / 出队
   → 改 first 周围的引用

队尾入队 / 出队
   → 改 last 周围的引用
```

### 但就连这个位置，现代 Java 里通常也会让给 ArrayDeque

这里先不展开 `ArrayDeque` 的内部实现，下一篇会细讲。但从选型方向上，现在就可以先记住一个事实：即使在“头尾操作频繁”的场景里，LinkedList 也常常不是第一推荐，因为环形数组既避免了链表的大量节点对象，又保留了很好的头尾操作性能。

所以 LinkedList 在现代 Java 里的准确定位更像是：

- 你需要 `List + Deque` 的组合语义；
- 你确实围绕头尾或迭代器当前位置做局部修改；
- 你清楚自己接受节点对象和走链的代价。

而不是“只要听说增删多，就先上 LinkedList”。

## 四、Vector 的问题：不是“有锁”本身，而是只锁住了方法边界

### 它保留的是早期 Java 的同步动态数组模型

Vector 的骨架与 ArrayList 很像，也是数组加元素个数；只是这些字段带着更老的设计痕迹：

```java
// Vector.java:103-122
protected Object[] elementData;

protected int elementCount;

protected int capacityIncrement;
```

默认构造也会直接分配 10 个槽位：

```java
// Vector.java:163-165
public Vector() {
    this(10);
}
```

它的增长策略和 ArrayList 也不同：默认是翻倍；如果指定了 `capacityIncrement`，就按固定增量增长。

```java
// Vector.java:277-289
private int newCapacity(int minCapacity) {
    int oldCapacity = elementData.length;
    int newCapacity = oldCapacity + ((capacityIncrement > 0) ?
                                     capacityIncrement : oldCapacity);
    if (newCapacity - minCapacity <= 0) {
        if (minCapacity < 0)
            throw new OutOfMemoryError();
        return minCapacity;
    }
    return (newCapacity - MAX_ARRAY_SIZE <= 0)
        ? newCapacity
        : hugeCapacity(minCapacity);
}
```

### 真正的问题是“方法级同步”不等于业务级安全

Vector 最常被提起的一点是“线程安全”，因为它很多方法都直接 `synchronized`：

```java
// Vector.java:200-202
public synchronized void copyInto(Object[] anArray) {
    System.arraycopy(elementData, 0, anArray, 0, elementCount);
}
```

```java
// Vector.java:825-828
public synchronized boolean add(E e) {
    modCount++;
    add(e, elementData, elementCount);
    return true;
}
```

这类同步能保证的是：**单个方法调用期间，内部状态不会被另一个线程同时改坏。** 但它解决不了大量真实业务里更常见的问题：多个方法拼起来才构成一个业务原子步骤。

最典型的失败方案就是：

```java
if (!vector.contains(x)) {
    vector.add(x);
}
```

`contains` 和 `add` 各自都加锁，但两次调用之间锁会释放，其他线程仍然可以插队。于是你得到的是：

```text
单次方法互斥
   ≠
复合操作原子
```

这就是为什么说 Vector 经常只是“方法级安全”，而不是你真正想要的“并发语义正确”。再叠加粗粒度锁带来的吞吐损失，它就很难成为现代默认选择。

### 它还带着更老的可扩展性包袱

`elementData` 和 `capacityIncrement` 是 `protected`，这意味着子类可以更直接地触碰内部状态。对今天的封装设计来说，这也是一种历史包袱：抽象边界更松，更容易被继承层破坏。

所以 Vector 的问题不是一句“过时”就能概括，而是三层叠加：

- 同步粒度停留在单方法互斥；
- 复合操作仍需调用方自己协调；
- 内部状态与扩容策略都保留了更老的暴露方式。

## 五、Stack 的问题更典型：它不是一个干净的栈抽象

### 源码自己已经建议你优先用 Deque

JDK 11 的 `Stack` Javadoc 说得非常直接：更完整、更一致的 LIFO 操作由 `Deque` 及其实现提供，并且应该优先使用。

```java
// Stack.java:29-44
 * The {@code Stack} class represents a last-in-first-out
 * (LIFO) stack of objects. It extends class {@code Vector} with five
 * operations that allow a vector to be treated as a stack. The usual
 * {@code push} and {@code pop} operations are provided, as well as a
 * method to {@code peek} at the top item on the stack, a method to test
 * for whether the stack is {@code empty}, and a method to {@code search}
 * the stack for an item and discover how far it is from the top.
 * <p>
 * When a stack is first created, it contains no items.
 *
 * <p>A more complete and consistent set of LIFO stack operations is
 * provided by the {@link Deque} interface and its implementations, which
 * should be used in preference to this class.  For example:
 * <pre>   {@code
 *   Deque<Integer> stack = new ArrayDeque<Integer>();}</pre>
 *
```

如果一个类的源码文档自己都说“请优先用别的接口实现”，那就说明问题不只是社区口味，而是设计层面真的有更好的后继方案。

### 第一层问题：它继承了 Vector 的同步包袱

`Stack` 根本不是一套独立的数据结构实现，而是直接继承 `Vector`：

```java
// Stack.java:49
class Stack<E> extends Vector<E> {
```

`push` 其实只是调用 `addElement`：

```java
// Stack.java:66-69
public E push(E item) {
    addElement(item);

    return item;
}
```

`pop`、`peek` 也只是围绕 Vector 尾部做包装：

```java
// Stack.java:80-88
public synchronized E pop() {
    E       obj;
    int     len = size();

    obj = peek();
    removeElementAt(len - 1);

    return obj;
}
```

```java
// Stack.java:98-103
public synchronized E peek() {
    int     len = size();

    if (len == 0)
        throw new EmptyStackException();
    return elementAt(len - 1);
}
```

这意味着，只要你用了 Stack，就自动把 Vector 的同步模型和历史包袱也一起背上了。

### 第二层问题：它把“栈”暴露成了“带 push/pop 的 List”

更根本的缺陷是抽象污染。

如果一个类型真想表达“栈”，它最理想的能力应该围绕 LIFO：push、pop、peek、empty。可 Stack 因为继承自 Vector，调用方依然能直接使用：

- 任意位置插入；
- 按索引读取；
- 删除栈底元素；
- 使用整套 `List` / `Vector` 方法绕开栈语义。

于是它不再是一个干净的“只能以 LIFO 方式访问”的抽象，而成了一个“顺手加了几个栈方法的老式动态数组”。

这就是典型的继承复用问题：父类暴露的能力太多，子类无法把不想继承的接口收回去。对外看起来是复用，实际上是把不该暴露的操作一并公开了。

## 七、五个最容易混掉的边界：链表插入快有前提，LinkedList 不只是 List，Vector 不是并发容器，方法加锁不等于业务原子，Stack 也不是现代栈默认实现

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，链表“插入删除快”是有前提的：你必须已经站到了目标节点旁边。只要调用方拿到的还是下标或普通值搜索，真正先发生的通常就是 O(n) 的走链定位，而不是 O(1) 的改链。

第二，`LinkedList` 也不只是 `List` 的另一种实现。它同时实现 `Deque`，这恰恰说明它更自然的语义位置往往在头尾操作和双端队列，而不是高频随机访问的线性表。

第三，`Vector` 更不是“因为线程安全，所以更适合并发”的现代答案。它提供的是方法级 `synchronized` 互斥，而不是面向业务复合操作的并发协议；一旦问题变成多步组合，光靠方法同步就不够了。

第四，方法加锁也不等于业务原子。`contains` 和 `add` 分别是同步方法，并不自动让“先判断再插入”这件两步操作变成一个整体原子动作。把这两层混在一起，是很多老容器误用的根源。

第五，`Stack` 也不是现代 Java 里的默认栈实现。它的问题不只是“老”，而是抽象不干净：一边想表达 LIFO，一边又继承了整套 `Vector/List` 的随机访问和插入删除能力，结果栈语义被父类接口污染了。

把这五条边界记稳，`LinkedList/Vector/Stack` 这一篇就不会重新塌回“链表增删快、Vector 有锁、Stack 是标准栈”这种教科书口号印象。它真正想讲的是：这些老朋友各自都带着非常具体的结构前提和历史包袱，知道它们为什么存在，比把它们当默认选项更重要。

## 收网：这三类结构今天更像“需要理解其局限”，而不是“默认优先项”

现在把三者放在一起看，会更清楚它们为什么在现代 Java 里很少当默认选项。

LinkedList 的结构优势发生在“已经定位到目标节点”的局部时刻；一旦你的入口是 index、搜索或随机访问，链表的走链成本和节点开销就会迅速冒头。

Vector 解决的是早期 Java 对“方法级互斥”的需要，但真实并发程序常常需要的是更高层的原子性和更细致的并发策略。只有 `synchronized` 方法，不等于拿到了正确的并发抽象。

Stack 则更进一步暴露了早期继承设计的问题：它不是一套干净的栈结构，而是把 Vector 连同同步和列表能力一起继承下来，再在表面加一层 LIFO 包装。

所以实际选型时，可以先记住这四条：

1. **LinkedList 的“插入快”只在你已经拿到目标节点时成立**；只给 index 时，定位通常才是主成本。
2. **LinkedList 更自然的语义是 `Deque`，不是高频随机访问的 `List`**。
3. **Vector 的方法级同步只能保护单次调用，不自动保证复合操作正确**。
4. **Stack 的问题不只是老，而是抽象不纯：它把栈做成了继承自 Vector 的混合体**。

下一篇进入真正现代的队列与栈默认选择：`ArrayDeque` 为什么能同时承担栈和双端队列，`PriorityQueue` 又为什么能用堆把优先级操作控制在对数复杂度。

> → 下一篇：[ArrayDeque 与 PriorityQueue](03-deque-priorityqueue.md)
