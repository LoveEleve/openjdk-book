# 03. ArrayDeque 与 PriorityQueue — 环形数组、二叉堆

> **前置依赖**: [08-collections/02 — LinkedList/Vector/Stack](02-linkedlist-vector.md)(Deque 接口)
> → **后续**:[08-collections/04 — 迭代器与 fail-fast](04-iterator-failfast.md)
> 关联: JLS §10(数组类型与下标语义)

## 两个标准答案:队列与优先级

"栈用什么实现""TopK 用什么"——面试的两个标准答案是 **ArrayDeque**(环形数组)和 **PriorityQueue**(二叉堆)。为什么 ArrayDeque 头尾都 O(1)?"环形"是什么?二叉堆为什么 offer/poll 是 O(log n) 却不是有序的?这篇把两个结构讲透,最后收 Queue/Deque 的接口契约。

## 1. "ArrayDeque 为什么头尾都 O(1)" — 环形数组

### 1.1 数组 + 双指针

`ArrayDeque`(`java/util/ArrayDeque.java`)的核心(`ArrayDeque.java:111`/`119`/`126`):

```java
// ArrayDeque.java:111 + 119 + 126(截取核心,逐字)
transient Object[] elements;

transient int head;

transient int tail;
```

- `elements`:存储数组
- `head`:队头下标
- `tail`:队尾下标(下一个写入位置)

### 1.2 环形语义:指针回绕

普通数组的 addFirst 要**整体后移所有元素**(O(n));环形数组只需**移动指针**(O(1))。指针回绕是条件判断(`ArrayDeque.java:227-231`):

```java
// ArrayDeque.java:227-231(截取核心,逐字)
static final int dec(int i, int modulus) {
    if (--i < 0) i = modulus - 1;
    return i;
}
```

`addFirst`(`ArrayDeque.java:285-291`)就是"head 前移一格再写入":

```java
// ArrayDeque.java:285-291(截取核心,逐字)
public void addFirst(E e) {
    if (e == null)
        throw new NullPointerException();
    final Object[] es = elements;
    es[head = dec(head, es.length)] = e;
    if (head == tail)
        grow(1);
}
```

`addLast`(`ArrayDeque.java:302`)对称: 写入 tail 后 `inc`。`pollFirst`(`ArrayDeque.java:377-386`)读 head、**置 null**(防内存泄漏,与 ArrayList.fastRemove 同款)、`inc`。

### 1.3 满员歧义:空与满都是 head == tail

环形数组的经典问题: **head == tail 既可能是空也可能是满**。grow 里用第三个信号区分(`ArrayDeque.java:152-154`):

```java
// ArrayDeque.java:152-154(截取核心,逐字)
if (tail < head || (tail == head && es[head] != null)) {
    // wrap around; slide first leg forward to end of array
```

`es[head] != null` 是"满"的判据(空时该位置是 null)。

### 1.4 扩容

`grow`(`ArrayDeque.java:141` 起): **容量 <64 时 +2(近似翻倍),否则 +50%**(`ArrayDeque.java:147-148` 的 `jump` 计算)——与 ArrayList 的 1.5x 同类取舍。**回绕状态扩容要搬移**: tail < head 时把前半段滑到数组尾部(`ArrayDeque.java:158-164` 的 System.arraycopy)。

关键设计(斜体):*"环形"让头尾插入都免搬移——普通数组的 addFirst 要整体后移 O(n),环形数组只需移动指针 O(1)。面试答"为什么 ArrayDeque 头尾 O(1)": 指针回绕(dec/inc)+ 满员歧义用 es[head]!=null 区分。JDK9+ 的条件回绕(if 判断)取代了 JDK8 的 & (len-1)(不再要求 2 的幂长度)。*

## 2. "PriorityQueue 是什么结构" — 二叉堆

### 2.1 数组存储的堆

`PriorityQueue`(`java/util/PriorityQueue.java`)的核心(`PriorityQueue.java:101`/`112`):

```java
// PriorityQueue.java:101 + 112(截取核心,逐字)
transient Object[] queue; // non-private to simplify nested class access

private final Comparator<? super E> comparator;
```

**二叉堆用数组存储**: 下标 i 的父是 `(i-1) >>> 1`(`PriorityQueue.java:660`),子是 `2i+1`/`2i+2`。默认小顶堆(自然序)——**堆顶 = 最小值**;`comparator`(@112)可自定义。

### 2.2 offer:上浮

`offer`(`PriorityQueue.java:338-348`): 新元素放尾部,`siftUp`(`PriorityQueue.java:650`)与父比较交换直至满足堆序——**上浮**。O(log n)。

### 2.3 poll:下沉

`poll`(`PriorityQueue.java:586`)→ `siftDown`(`PriorityQueue.java:691`): 堆顶取出,尾元素放顶,**与较小子交换下沉**直至堆序恢复。O(log n)。`peek` O(1)。

### 2.4 heapify:批量构造 O(n)

`heapify`(`PriorityQueue.java:740`): 从 `(n >>> 1) - 1` 开始向下 siftDown——**从最后一个非叶节点往上**批量建堆,总代价 O(n)(不是 O(n log n))。

关键设计(斜体):*二叉堆是"部分有序"——只保证堆顶极值,不保证全序(这就是堆不能做有序遍历,而 TreeSet 可以,域 09)。offer/poll 均 O(log n)、peek O(1)、heapify O(n)。面试"TopK 问题": 小顶堆容量 K 维护 TopK 大数(比根小就替换);"PriorityQueue vs TreeSet": 堆=极值优先,树=有序集合。*

## 3. "Queue/Deque 接口语义" — 两套方法约定

### 3.1 抛异常 vs 返回特殊值

`Queue` 接口定义了两套方法:

| 操作 | 失败抛异常 | 失败返回特殊值 |
|------|-----------|---------------|
| 入队 | `add(e)` | `offer(e)` → false |
| 出队 | `remove()` | `poll()` → null |
| 查看 | `element()` | `peek()` → null |

**限流队列的契约**: 业务上 `offer` 判断成功(不抛异常),语法上 `add` 失败即 bug(立即暴露)——生产队列满的处理决策(丢弃/等待/抛错)对应不同 API 选择。

### 3.2 Deque:头尾两组

`Deque` 扩展 Queue: 头尾各一组 `addFirst`/`addLast` + 对应 remove/poll/peek——这就是 ArrayDeque/LinkedList 能当"双端队列/栈"用的接口基础。

### 3.3 实现选择

- 无界:ArrayDeque(栈/队列)/LinkedList
- 有界/阻塞:`BlockingQueue` 家族(域 10 并发集合)

关键设计(斜体):*"抛异常 vs 返回特殊值"两套 API 是队列的经典设计——offer 适合业务判断,add 适合断言。面试"BlockingQueue 与普通 Queue 区别": 阻塞语义(域 10 并发集合)。*

## 核心悬念

遍历集合时**一边遍历一边修改**会抛 ConcurrentModificationException——`modCount` 到底怎么检测的?增强 for 的底层是什么?`iterator.remove` 为什么安全而 `list.remove` 不安全?——下一篇: 迭代器与 fail-fast。

> → [08-collections/04 — 迭代器与 fail-fast](04-iterator-failfast.md)
