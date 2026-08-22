# ArrayList 和 LinkedList 到底该怎么选？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`08-collections/01-arraylist`、`02-linkedlist-vector`
> 版本边界：下文引用的 `ArrayList.java`、`LinkedList.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

ArrayList 和 LinkedList 各自的优势是什么？什么时候用 ArrayList，什么时候用 LinkedList？

## 常见答法

> ArrayList 适合随机访问，LinkedList 适合频繁插入删除。ArrayList 内存连续，LinkedList 每个节点有额外开销。

这个答法方向对，但"频繁插入删除"这个结论在真实场景下经常被误用。**LinkedList 的插入删除"快"是有前提的——快的前提是你已经持有迭代器或节点引用。如果插入删除是通过索引进行的，`list.add(index, e)` 首先要 O(n) 遍历到那个位置，再 O(1) 插入，总成本还是 O(n)。** 很多场景下，ArrayList 的批量插入因为内存局部性好，反而更快。

## 追问一：那 `list.add(index, e)` 在 LinkedList 里为什么不是 O(1)？

> 答：因为需要先找到 index 这个位置，LinkedList 的查找是 O(n) 的。

`LinkedList.get(int index)`（`LinkedList.java:479`）走的是 `node(int index)`（`:570`），从头或尾遍历到目标位置，O(n)。所以 `add(index, e)` 要先 O(n) 定位、再 O(1) 插入，总成本还是 O(n)。

而 `ArrayList.add(int index, E)` 是 O(n) 的数组元素平移，但它的 O(n) 是连续内存批量移动，内存局部性好，缓存友好。在多数真实场景下，ArrayList 的 O(n) 批量移动反而比 LinkedList 的 O(n) 逐个节点遍历 + 碎片化的节点分配更快。

## 追问二：那 LinkedList 到底什么时候真的有优势？

> 答：队首/队尾操作、或者通过迭代器批量删除时。

`LinkedList` 的 `linkLast(e)`（`:342`）是 O(1) 的尾部插入，`unlinkFirst/linkFirst` 是 O(1) 的头部操作。如果你需要频繁的"从队列头取/从队列尾加"，LinkedList 比 ArrayList 快。同样，如果你已经持有某个节点的迭代器，迭代器上的 `remove()` 是 O(1) 的，不需要遍历。

但绝大多数"随机索引插入删除"的场景，ArrayList 反而不慢多少——因为它的连续内存移动和缓存局部性比 LinkedList 的节点遍历 + 节点分配更高效。

## 追问三：那内存上呢？LinkedList 的每个节点开销有多大？

> 答：每个节点存一个前驱引用、一个后继引用、一个元素引用，加上 Node 对象头，开销约 24-32 字节。

ArrayList 存的是 `Object[]` 数组，每个元素就是一个引用（4 或 8 字节），加上数组本身的少量开销。LinkedList 每个元素要包一个 `Node`（`LinkedList.java:974`），持三个引用。在元素数量大时，LinkedList 的内存开销可能是 ArrayList 的 2-3 倍。

## 源码证据

- `ArrayList` 底层是 `Object[]` 数组（`ArrayList.java:136`）：连续内存，随机访问 O(1)
- `LinkedList` 的 `node(int index)`（`LinkedList.java:570`）：从头/尾双向遍历，随机访问 O(n)
- `LinkedList.linkLast(e)`（`:342`）：尾部插入 O(1)，但前提是不需要先定位
- `LinkedList.Node`（`:974`）：三个引用 + 对象头，内存开销比 ArrayList 的引用数组大得多

## 一句话顿悟

**"ArrayList 适合随机访问、LinkedList 适合插入删除"这个口诀需要加一个前提——插入删除如果通过索引进行，LinkedList 要先 O(n) 定位，总成本不比 ArrayList 低；真正的优势在队首/队尾操作和迭代器上的删除。** 面试官真正想听的不是你会背"ArrayList 查快、LinkedList 改快"，而是你知道 `node(index)` 的 O(n) 遍历成本、以及"连续内存批量移动 vs 碎片化节点分配"在真实性能下的差异。