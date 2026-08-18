# 02. LinkedList/Vector/Stack — 双向链表、同步数组、历史类定位

> **前置依赖**: [08-collections/01 — ArrayList](01-arraylist.md)(动态数组的对照)
> → **后续**:[08-collections/03 — ArrayDeque 与 PriorityQueue](03-deque-priorityqueue.md)
> 关联: 内部卷 09-memory-core(JVM 内部链结构与指针串接思路的对照)

## 三个"历史类"的定位

ArrayList 是"数组",LinkedList 是"链表"——但"链表插入快"这句面试话术有多精确?"Vector 线程安全为什么还不用?""实现栈为什么不用 Stack?"——这篇把三个类的真实定位讲清楚: LinkedList 的 Node 双向链与定位成本、Vector 的方法级同步与伪线程安全、Stack 的继承污染。

## 1. "LinkedList 的结构" — Node 双向链

### 1.1 头尾指针 + Node

`LinkedList` 的核心(`LinkedList.java:92`/`97` + `974`):

```java
// LinkedList.java:92 + 97 + 974-979(截取核心,逐字)
transient Node<E> first;

transient Node<E> last;

private static class Node<E> {
    E item;
    Node<E> next;
    Node<E> prev;
    ...
```

- `first`/`last`:头尾指针(`transient`)
- `Node`:item + next + prev 三字段——**双向链**: 每个节点都知道前后邻居

add 5 个元素后的内存形状: 5 个 Node 对象,每个带着 item 和两个指针串成链。

### 1.2 linkLast:尾部插入

`linkLast`(`LinkedList.java:144-150`):

```java
// LinkedList.java:144-150(截取核心,逐字)
void linkLast(E e) {
    final Node<E> l = last;
    final Node<E> newNode = new Node<>(l, e, null);
    last = newNode;
    if (l == null)
        first = newNode;
    else
        l.next = newNode;
    ...
```

新建 Node 接在 last 后,更新 last(空链表时同时设 first)。`unlinkFirst`(`LinkedList.java:175`)/`unlinkLast`(`LinkedList.java:194`)是头尾删除——改相邻指针 + 置空引用助 GC。

关键设计(斜体):*"链表" = 指针串接——插入/删除只需改相邻指针(O(1),但**先要定位**);对比 ArrayList 的"复制移动",LinkedList 换来了指针开销: 每元素一个 Node 对象,内存是 ArrayList 的 2-3 倍。面试"LinkedList 实现了哪些接口": List + Deque(双向队列语义,头尾都可操作)。*

## 2. "LinkedList 的 add/get 到底多快" — 定位成本

### 2.1 node(index):折半优化,仍是 O(n)

`node(int)`(`LinkedList.java:570-584`)是随机访问的核心:

```java
// LinkedList.java:570-584(截取核心,逐字)
Node<E> node(int index) {
    // assert isElementIndex(index);

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

**折半优化**: `index < (size >> 1)` 从头走,否则从尾走——最坏仍是 O(n/2)。`get(500000)`(100 万元素)要走 50 万步。

### 2.2 中间插入:定位 O(n) + 改指针 O(1)

`add(index, e)` = `node(index)` 定位(O(n))+ 改指针(O(1))= **总体 O(n)**。"链表插入快"只在**已持有 Node 引用**时成立(迭代器场景,直接改指针 O(1))。

关键设计(斜体):*面试标准答案的精确版: LinkedList 的"插入快"是**局部快**(持有 Node 时 O(1)),"随机访问慢"是**必然**(O(n))。现代 JVM 实测: ArrayList 几乎全面优于 LinkedList(连续内存缓存友好),LinkedList 只剩"头尾操作频繁"场景——而那个场景 ArrayDeque 更好(下一篇)。*

## 3. "Vector 为什么被淘汰" — 同步的代价

### 3.1 三个差异点

| | ArrayList | Vector |
|---|---|---|
| 同步 | 无 | **方法级 synchronized**(`Vector.java:825` 的 `add`) |
| 字段可见性 | private | **protected**(`Vector.java:103` 的 `elementData`、`122` 的 `capacityIncrement`) |
| 增长策略 | 1.5x | **capacityIncrement 可配**: 默认 2x,指定时固定增量(`Vector.java:277-287`) |

增长策略(`Vector.java:277-287`): `oldCapacity + ((capacityIncrement > 0) ? capacityIncrement : oldCapacity)`——capacityIncrement 默认 0 → `+ oldCapacity` = 2x;显式指定则每次加固定量。

### 3.2 伪线程安全

Vector 的两个问题:

1. **方法级锁粒度粗**: 每个方法单独加锁——与 StringBuffer 同类问题(域 01)
2. **复合操作仍不安全**: `if (!v.contains(x)) v.add(x)`——两次调用之间锁已释放,其他线程可以插入 → "get-then-set"竞态。**整体同步但复合操作不安全 = 伪线程安全**

官方建议: 并发用 `CopyOnWriteArrayList`/`Collections.synchronizedList`,单线程用 ArrayList。

关键设计(斜体):*"Vector 线程安全为什么还不用"——面试官想听的是"粗粒度同步的陷阱": 方法级锁既慢又不解决复合操作。答出"伪线程安全"这个词就有区分度。*

## 4. "Stack 的问题" — 继承 Vector 的栈

### 4.1 同步是多余的

`Stack`(`Stack.java:49` 的 `class Stack<E> extends Vector<E>`)——栈是单线程访问结构,**同步完全多余**。而且同步方式值得细看:

- `pop`(`Stack.java:80`)/`peek`(`Stack.java:98`):`synchronized` 修饰
- `push`(`Stack.java:66-69`):**没有 synchronized 修饰**——它调 `addElement`(Vector 的 synchronized 方法,`Vector.java:646`),间接同步

### 4.2 接口污染:栈语义不纯粹

Stack 继承了 Vector 的**所有 List 方法**——`add(0, x)` 往栈底插、`get(i)` 随机访问、`remove(0)` 删栈底。**栈的 LIFO 语义被 List 能力污染**: 使用者可以绕过 push/pop 直接操作内部。

这是"继承复用"的设计教训: **应该组合不该继承**——Stack 是 Java 集合框架最早的错误设计之一。官方建议: `ArrayDeque` 实现栈(下一篇),`Deque` 接口的 push/pop 才是干净的 LIFO。

关键设计(斜体):*面试"为什么不用 Stack"——能说出"接口污染(List 方法全暴露)+ 同步冗余(单线程结构背了锁)"两层,比背"官方不推荐"有深度。设计教训: 复用通过组合(持有),不通过继承(暴露全部接口)。*

## 核心悬念

List 家族讲完,但**队列和堆**呢?`ArrayDeque` 的**环形数组**怎么实现头尾 O(1)?`PriorityQueue` 的**二叉堆**怎么保证 offer/poll O(log n)?为什么 ArrayDeque 是官方推荐的"栈/队列"实现?——下一篇: ArrayDeque 与 PriorityQueue。

> → [08-collections/03 — ArrayDeque 与 PriorityQueue](03-deque-priorityqueue.md)
