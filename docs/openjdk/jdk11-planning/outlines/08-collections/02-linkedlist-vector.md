# 02. LinkedList/Vector/Stack — 双向链表、同步数组、历史类定位

> 🔴 Deep | 域 08 集合框架第 2 篇(巨型域 6 篇之二)| Layer 2
> 读者处境: 面试"ArrayList vs LinkedList"必考;LinkedList 内部结构、Vector 为什么被嫌弃、Stack 的问题——历史类一次讲清。

### 1. "LinkedList 的结构？" — Node 双向链

场景: `new LinkedList<>()` 之后 add 5 个元素——内存里是什么形状?

- `LinkedList.java:92` — `transient Node<E> first` / `97` — `transient Node<E> last` — 头尾指针
- Node: `item / next / prev` 三字段(`LinkedList.java:974` 私有静态类)
- `LinkedList.java:144` `linkLast(E)` — 尾部插入: 新建 Node 接在 last 后,更新 last
- `LinkedList.java:175/194` `unlinkFirst/unlinkLast` — 头尾删除(置空引用助 GC)
- 关键设计 (斜体): *"链表" = 指针串接,插入/删除只需改相邻指针(O(1),但**先要定位**——get(i) 从头/尾双向线性走 O(n));对比 ArrayList 的"复制移动"——LinkedList 换来了指针开销(每元素一个 Node 对象,内存 2-3 倍)*
- 面试: "LinkedList 实现了哪些接口"——List + Deque(双向队列语义,头尾都可操作)
- [C++: 内部卷 09-memory-core 对照: JVM 内部链结构(如 monitor 链表)同样思路]

### 2. "LinkedList 的 add/get 到底多快？" — 定位成本

场景: 生产"LinkedList 存 100 万,get(500000) 慢到爆"——为什么?

- `LinkedList.java:570` `node(int index)`: `index < (size >> 1)` 从头走,否则从尾走——**折半优化**,仍是 O(n/2)
- 中间插入 `add(index)`: node(index) O(n) + 改指针 O(1) = **总体 O(n)**——"链表插入快"只在"已持有节点引用"(迭代器)时成立
- 关键设计 (斜体): *面试标准答案的精确版: LinkedList 的"插入快"是**局部快**(持有 Node 时 O(1)),"随机访问慢"是**必然**(O(n));JDK 注释里官方都建议: 大量随机访问用 ArrayList*
- 实测结论: 现代 JVM 下 ArrayList 几乎全面优于 LinkedList(缓存局部性),LinkedList 只剩"头尾操作频繁"场景(可用 ArrayDeque 替代,第 3 篇)

### 3. "Vector 为什么被淘汰？" — 同步的代价

场景: 面试"Vector 和 ArrayList 区别"——"线程安全"之外还有哪些不同?

- `Vector.java:103` `protected Object[] elementData` / `122` `protected int capacityIncrement` — 字段还是 protected(子类可破坏)
- `Vector.java:825` `public synchronized boolean add(E e)` — **方法级 synchronized**(与 StringBuffer 同类问题,域 01)
- 增长策略: `capacityIncrement` 指定(默认 2x;可配固定增量)——与 ArrayList 1.5x 不同
- 关键设计 (斜体): *Vector 的问题: ① 方法级锁粒度粗 ② 整体同步但复合操作(get-then-set)仍不安全——"伪线程安全";官方建议: 并发用 CopyOnWriteArrayList/Collections.synchronizedList,单线程用 ArrayList*
- 面试: "Vector 线程安全为什么还不用?"——复合操作不安全 + 性能差;面试官想听的是"粗粒度同步的陷阱"

### 4. "Stack 的问题" — 继承 Vector 的栈

场景: 面试"实现栈用 Stack 还是 ArrayDeque?"——为什么 Stack 是反模式

- `Stack.java`(141 行): push/pop/peek 全部继承 Vector 的同步——**栈用不到同步**
- 关键问题: Stack 继承了 List 的所有方法——`add(0, x)` 插入中间、`get(i)` 随机访问——**栈语义不纯粹**
- 官方建议: `ArrayDeque` 实现栈(域 08 第 3 篇),`Deque` 接口的 push/pop
- 关键设计 (斜体): *设计教训: "继承复用"导致的接口污染——Stack 是 Java 集合框架最早的错误设计之一(应组合不该继承);面试问"为什么不用 Stack"——能说出接口污染+同步冗余=有深度*
- 面试: "LIFO 用谁?"——ArrayDeque/Deque(LegacyStack 场景除外)

---

### 核心悬念

List 家族讲完,但**队列和堆**呢?`Deque` 的环形数组怎么实现头尾 O(1)?`PriorityQueue` 的二叉堆怎么保证 offer/poll O(logn)?——下一篇: ArrayDeque 与 PriorityQueue。

> → [03-deque-priorityqueue.md](03-deque-priorityqueue.md)
