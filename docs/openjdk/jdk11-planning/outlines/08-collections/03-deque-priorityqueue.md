# 03. ArrayDeque 与 PriorityQueue — 环形数组、二叉堆

> 🟡 Working | 域 08 集合框架第 3 篇(巨型域 6 篇之三)| Layer 2
> 读者处境: 面试"栈用什么实现""TopK 用什么"——ArrayDeque 的环形数组和 PriorityQueue 的二叉堆是标准答案;生产任务队列/优先级调度都基于它们。

### 1. "ArrayDeque 为什么头尾都 O(1)？" — 环形数组

场景: `deque.addFirst(x)` 时数组满了怎么办?——"环形"是什么意思

- `ArrayDeque.java:111` — `transient Object[] elements` / `119` `head` / `126` `tail` — 数组 + 双指针
- 环形语义: **条件回绕**——`dec(head, len)`/`inc(tail, len)` 越界回绕(`addFirst` 289 / `addLast` 307);JDK8 用 `& (len-1)`(要求 2 的幂长度),JDK9+ 改为条件回绕 + 跳变扩容,长度不再要求 2 的幂
- `ArrayDeque.java:285` `addFirst(E)` — head 前移一格写入;`377` `pollFirst()` — 读 head 并置 null(防内存泄漏)
- 扩容 `grow`(`ArrayDeque.java:141`): 容量 <64 时 +2(近似翻倍),否则 +50%;**环形回绕时扩容要搬移**(tail<head 时滑动前半段,141-158)
- 关键设计 (斜体): *"环形"让头尾插入都免搬移——普通数组的 addFirst 要整体后移 O(n),环形数组只需移动指针 O(1);代价是数组长度必须是 2 的幂(指针回绕用 & 运算)与满员判定(head==tail)的歧义处理*
- 面试: "ArrayDeque vs LinkedList 做队列"——ArrayDeque 缓存友好(连续数组)+ 无 Node 对象开销,官方推荐
- [JLS §10: 数组类型与下标语义;性能: 连续数组的缓存局部性(ArrayDeque vs LinkedList 的实测差距来源)]

### 2. "PriorityQueue 是什么结构？" — 二叉堆

场景: `new PriorityQueue<>(10)` 是"容量 10 的队列"吗?offer 5 个元素后内部什么样?

- `PriorityQueue.java:101` — `transient Object[] queue` — **二叉堆的数组存储**(父 i 的子 = 2i+1/2i+2)
- 默认小顶堆(自然序): 堆顶 = 最小值;`Comparator`(112)可自定义
- `PriorityQueue.java:338` `offer(E)` → `siftUp`(650)— **上浮**: 新元素放尾部,与父比较交换直至满足堆序
- `PriorityQueue.java:586` `poll()` → `siftDown`(691)— **下沉**: 堆顶取出,尾元素放顶,与较小子交换
- `PriorityQueue.java:740` `heapify` — 批量构造 O(n)(从 n/2 向下 siftDown)
- 关键设计 (斜体): *二叉堆是"部分有序"——只保证堆顶极值,不保证全序(这就是为什么堆不能做有序遍历,而 TreeSet 可以,域 09);offer/poll 均 O(logn),peek O(1),heapify O(n)*
- 面试: "TopK 问题"——小顶堆容量 K 维护 TopK 大数(面试高频);"PriorityQueue vs TreeSet"——堆=极值优先,树=有序集合

### 3. "Queue/Deque 接口语义" — 两套方法约定

场景: `add` vs `offer` 都会失败——区别在哪?

- Queue: `add/remove/element`(失败抛异常)vs `offer/poll/peek`(失败返回 false/null)——**限流队列的契约**
- Deque: 头尾各一组 addFirst/addLast + 对应 remove/poll/peek
- 实现选择: 无界用 ArrayDeque/LinkedList;有界/阻塞用 BlockingQueue 家族(域 10 并发集合)
- 关键设计 (斜体): *"抛异常 vs 返回特殊值"两套 API 是队列的经典设计——业务上 offer 判断成功(不抛异常),语法上 add 失败即 bug(立即暴露);生产队列满的处理决策(丢弃/等待/抛错)对应不同 API*
- 面试: "BlockingQueue 与普通 Queue 区别"——阻塞语义(域 10 展开)

---

### 核心悬念

遍历集合时**一边遍历一边修改**会抛 ConcurrentModificationException——`modCount` 到底怎么检测的?增强 for 底层是什么?——下一篇: 迭代器与 fail-fast。

> → [04-iterator-failfast.md](04-iterator-failfast.md)
