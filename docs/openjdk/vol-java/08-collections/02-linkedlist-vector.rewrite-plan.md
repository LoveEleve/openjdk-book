# 08-collections/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `LinkedList`、`Vector`、`Stack`。本文聚焦结构与定位语义、同步粒度与历史设计包袱，不展开 `modCount` / fail-fast 和并发集合内部实现。
> 目标：把“LinkedList/Vector/Stack”从三段式背诵稿，改写成一篇围绕“链表理论优势为什么在现代 Java 中经常落空，旧同步容器又为什么不再是默认选择”的机制文章。

## 1. 读者困惑

- LinkedList 不是号称插入删除快吗，为什么生产里经常比 ArrayList 更慢？
- 链表的 O(1) 插入到底成立在什么前提下？
- LinkedList 同时实现 `List` 和 `Deque` 到底意味着什么？
- Vector 明明线程安全，为什么官方和社区还是几乎都让你用 ArrayList 或别的并发容器？
- Stack 不是标准栈实现吗，为什么源码自己都建议用 `Deque` / `ArrayDeque`？
- “历史类不推荐”到底是情绪结论，还是有清楚的结构原因？

## 2. 一句话顿悟

**LinkedList 的优势只发生在“已经站到目标节点旁边”时，而现代业务更常见的是随机访问、遍历、缓存友好的顺序读写；Vector 与 Stack 则把早期 Java 的粗粒度同步和继承式接口污染一起带到了今天，所以它们更多是历史兼容类，而不是现代默认选择。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `LinkedList` 的 `Node`、`first/last`、`linkLast`、`node(index)`。
- 已指出“中间插入 = 定位 O(n) + 改指针 O(1)”这一关键纠偏。
- 已覆盖 `Vector` 的方法级 `synchronized`、增长策略，以及 `Stack` 继承 `Vector` 的问题。
- 已给出下一篇 `ArrayDeque` 的承接方向。

### 必须重写

- 旧稿仍偏“知识点拼盘”，需要先建立一个总问题：为什么理论教材里看起来很强的链表，在现代 Java 程序里往往不是优先解。
- `LinkedList` 需要区分两种成本：节点改链是局部 O(1)，但定位节点往往才是主成本。
- 要把 `List` 语义和 `Deque` 语义同时挂到 `LinkedList` 上，说明它为什么还能做队列双端操作。
- `Vector` 不能只说“线程安全”，要把“方法级锁为什么不等于业务安全”讲成完整失败方案。
- `Stack` 需要明确两层问题：同步冗余 + 暴露了整套 `Vector/List` 能力，导致 LIFO 语义被污染。

## 4. 理解路径

### 第一节：先从 ArrayList 的反面问题进入

开头直接反问上一篇：既然 ArrayList 读快、尾插快，为什么教材还总把 LinkedList 说成“增删快”？让读者意识到，这是一个需要拆条件的判断，而不是通用结论。

### 第二节：LinkedList 的结构到底换来了什么

证据：
- `LinkedList.java:83-85`：实现 `List`、`Deque`
- `LinkedList.java:92-97`：`first` / `last`
- `LinkedList.java:144-153`：`linkLast`
- `LinkedList.java:175-188`：`unlinkFirst`
- `LinkedList.java:194-207`：`unlinkLast`

主线：
- 链表不是“数组去掉下标”，而是节点对象通过 `prev/next` 串起来。
- 头尾插入删除只改少量引用，所以在已知位置时很便宜。
- 代价是每个元素都包一层 `Node`，对象数、指针数、内存局部性都更差。

### 第三节：为什么 `get(i)` 和中间插入仍然慢

证据：
- `LinkedList.java:570-584`：`node(int index)`
- `LinkedList.java:599-615`：`indexOf`
- `LinkedList.java:628-643`：`lastIndexOf`

主线：
- `node(index)` 只做了折半优化：前半从头走，后半从尾走。
- 这只能把常数减半，不能把复杂度从 O(n) 变成 O(1)。
- “链表插入快”只在已经拿到目标节点或迭代器停在目标位置时成立；如果调用者只有 index，那真正成本往往是定位。

失败方案：把链表的 O(1) 插入拿来对比数组的任意位置插入，却忽略“先走到那个位置”的 O(n)。

### 第四节：LinkedList 作为 Deque 的合理位置

证据：
- `LinkedList.java:296-308`：`addFirst` / `addLast`
- `LinkedList.java:654-679`：`peek` / `poll`
- `LinkedList.java:711-714`：`offerFirst`

主线：
- `LinkedList` 同时实现 `Deque`，说明它不仅是“线性表”，还是双端队列。
- 真正适合它的语义是头尾操作，而不是大量随机读写。
- 但即便是头尾操作，下一篇还要比较为什么 `ArrayDeque` 通常更好。

### 第五节：Vector 的问题不是“有锁”，而是锁得不对地方

证据：
- `Vector.java:103-122`：`elementData`、`elementCount`、`capacityIncrement`
- `Vector.java:163-165`：默认容量 10
- `Vector.java:200-202`：同步方法示例
- `Vector.java:237-242`：`ensureCapacity`
- `Vector.java:277-289`：`newCapacity`
- 还需补一个 `add(E)` 的同步方法实际行号（重写时读取）

主线：
- `Vector` 的历史定位是“同步动态数组”。
- 其同步模型是每个方法单独 `synchronized`，解决的是单个方法的互斥，不是业务级复合操作原子性。
- `if (!contains(x)) add(x)` 仍可能被并发穿插。
- 增长策略也保留了更老的 `capacityIncrement` 设计和字段可见性包袱。

### 第六节：Stack 为什么是继承式设计的反面教材

证据：
- `Stack.java:29-44`：Javadoc 明说优先用 `Deque`
- `Stack.java:49`：`extends Vector`
- `Stack.java:66-69`：`push`
- `Stack.java:80-88`：`pop`
- `Stack.java:98-103`：`peek`

主线：
- `Stack` 并不是一套独立栈结构，而是“Vector + 五个 LIFO 方法”。
- 因为继承了 `Vector`，调用者仍能使用随机访问、任意位置插入删除等非栈语义操作。
- 这让“栈”不再是干净抽象，而是被上层父类能力污染。
- 再叠加来自 `Vector` 的同步包袱，最终得到一个既不纯粹也不轻量的历史类。

### 第七节：收束到现代选型

把三者放回现代 Java 语境：
- 线性表默认：ArrayList
- 双端队列 / 栈：ArrayDeque
- 并发列表：专门并发容器或受控包装
- `LinkedList`、`Vector`、`Stack` 主要是特定语义或历史兼容

结尾自然引到下一篇 `ArrayDeque` 与 `PriorityQueue`。

## 5. 失败方案清单

1. 把“链表插入快”理解成所有插入场景都快。
2. 用 `LinkedList.get(i)` 处理大量随机访问数据。
3. 用 `LinkedList` 只因为教材说它“适合增删”，却忽略缓存局部性与对象开销。
4. 看到 `Vector` 有同步就把它当成通用线程安全列表。
5. 用多步复合操作操作 `Vector`，误以为自动具备整体原子性。
6. 把 `Stack` 当成现代 Java 栈首选实现。
7. 因为 `Stack` 有 `push/pop`，就忽略它还暴露了整套 `Vector`/`List` 操作。

## 6. 误解清单

1. LinkedList 的插入删除总是 O(1)。
2. `node(index)` 从头尾折半就说明随机访问已经足够快。
3. LinkedList 只是 `List`，与队列语义无关。
4. `Vector` 线程安全等于业务代码并发安全。
5. `synchronized` 方法越多越安全，只是慢一点而已。
6. Stack 是专门为栈设计的独立实现。
7. 官方不推荐 Stack 只是风格问题；实际是结构问题。

## 7. 证据清单

- `LinkedList.java:83-85`：实现 `List`、`Deque`
- `LinkedList.java:92-97`：`first` / `last`
- `LinkedList.java:144-153`：`linkLast`
- `LinkedList.java:175-188`：`unlinkFirst`
- `LinkedList.java:194-207`：`unlinkLast`
- `LinkedList.java:570-584`：`node(index)`
- `LinkedList.java:599-615`：`indexOf`
- `LinkedList.java:628-643`：`lastIndexOf`
- `LinkedList.java:296-308`：`addFirst` / `addLast`
- `LinkedList.java:654-679`：`peek` / `poll`
- `LinkedList.java:711-714`：`offerFirst`
- `Vector.java:103-122`：核心字段
- `Vector.java:163-165`：默认容量
- `Vector.java:200-202`：同步方法示例
- `Vector.java:237-242`：`ensureCapacity`
- `Vector.java:277-289`：增长策略
- `Vector.java`：`add(E)` 的 `synchronized` 方法（重写时补精确行号）
- `Stack.java:29-44`：Javadoc 推荐 `Deque`
- `Stack.java:49`：继承 `Vector`
- `Stack.java:66-69`：`push`
- `Stack.java:80-88`：`pop`
- `Stack.java:98-103`：`peek`

## 8. 版本与边界

- 基于 JDK 11。
- 不在本文展开 fail-fast 迭代器机制，留给 `04-iterator-failfast.md`。
- 不展开 `CopyOnWriteArrayList` 或 `Collections.synchronizedList` 的内部实现，只用于选型定位。
- 不做完整微基准结论，只说明结构性原因：定位成本、对象开销、缓存局部性、锁粒度。

## 9. 删除代码测试与最终验收标准

- 删除源码块后，读者仍能复述“LinkedList 的节点结构 → 定位成本吞掉中间插入优势 → Deque 语义是它更自然的位置 → Vector 只保证方法级互斥，不保证复合操作安全 → Stack 因继承 Vector 产生接口污染与同步冗余”。
- 必须把“链表插入快”的成立条件说完整。
- 必须解释 `Vector` 的问题是同步粒度与抽象层次不匹配，而不是一句“老旧”。
- 必须明确 `Stack` 的问题不只是慢，而是抽象不干净。
- 结尾要自然引到 `03-deque-priorityqueue.md`。
