# 09-map-hash/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `LinkedHashMap`、`TreeMap`。本文聚焦顺序语义、双向链钩子、访问序 LRU、红黑树有序性与 `NavigableMap` 能力，不展开红黑树完整证明和并发有序容器实现。
> 目标：把“LinkedHashMap 与 TreeMap”改写成一篇围绕“有序 Map 为什么分成‘保持遍历顺序’与‘按 key 排序’两条路线”的机制文章，并把 LRU 与范围查询分别挂到这两条路线下。

## 1. 读者困惑

- `LinkedHashMap` 为什么能保持插入顺序，而 `HashMap` 做不到？
- `accessOrder=true` 到底改变了什么，为什么 `get()` 都会影响迭代顺序？
- `removeEldestEntry` 为什么能几乎零成本搭出一个 LRU？
- `TreeMap` 的“有序”到底是插入顺序、访问顺序，还是按 key 比较结果排序？
- `TreeMap` 为什么必须依赖 `Comparator` / `Comparable`，而不是 `hashCode()`？
- `TreeMap` 与 `HashMap` 的复杂度差异，换来的到底是什么能力？
- 为什么业务要“有序 Map”时，JDK 没有只保留一种实现？

## 2. 一句话顿悟

**LinkedHashMap 和 TreeMap 都解决“Map 需要顺序”这个问题，但它们维护的根本不是同一种顺序：LinkedHashMap 维护的是遍历顺序，所以在 HashMap 之上再挂一条双向链；TreeMap 维护的是比较意义上的键有序，所以直接把整个存储结构建成红黑树。一个擅长保持历史顺序与实现 LRU，一个擅长范围查询与按 key 导航。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `LinkedHashMap` 的 `head` / `tail` / `accessOrder`、`afterNodeAccess`、`afterNodeInsertion` 与 LRU 模式。
- 已覆盖 `TreeMap` 的 `comparator`、`root`、`put`、`fixAfterInsertion`、旋转和 `NavigableMap` 能力。
- 已给出选型对照表与下一篇家族收束。

### 必须重写

- 旧稿偏“两个类分别讲”，需要先建立统一主问题：为什么有序 Map 要分成两条结构路线。
- `LinkedHashMap` 需要明确“HashMap 桶结构完全保留，只额外叠加一条 before/after 链”，避免读者误以为它是链表式 Map。
- `accessOrder=true` 需要强调它让 `get` 成为结构性修改的一部分，这与普通插入序很不一样。
- LRU 部分应从“为什么头部就是最老元素”这条机制讲清，而不仅是给代码片段。
- `TreeMap` 需要先强调“比较定义 key 是否相等”，再讲红黑树与 `NavigableMap`，避免只剩算法名词。

## 4. 理解路径

### 第一节：先建立总问题——有序 Map 到底想保什么序

开头直接对比三种“顺序”：
- 插入顺序
- 最近访问顺序
- 按 key 比较的排序顺序

指出 `LinkedHashMap` 和 `TreeMap` 分别只解决其中不同的一类需求。

### 第二节：LinkedHashMap 为什么能保序，但哈希性能几乎不变

证据：
- `LinkedHashMap.java:33-48`：类注释里“Hash table + linked list”
- `LinkedHashMap.java:192-197`：`Entry` 多 `before/after`
- `LinkedHashMap.java:204-217`：`head` / `tail` / `accessOrder`
- `LinkedHashMap.java:221-230`：`linkNodeLast`
- `LinkedHashMap.java:255-259`：`newNode` 时挂链

主线：
- HashMap 的桶、hash、树化、扩容逻辑照旧。
- LinkedHashMap 做的只是给每个 entry 多一对 before/after 指针，再用 `head/tail` 串成全局双链。
- 因此它保持顺序的额外成本主要是链维护，而不是放弃哈希结构。

### 第三节：插入序 vs 访问序，到底差在哪

证据：
- `LinkedHashMap.java:61-75`：access-order 文档
- `LinkedHashMap.java:217`：`accessOrder`
- `LinkedHashMap.java:305-327`：`afterNodeAccess`
- `LinkedHashMap.java:112-118`：access-order 下 get 也是结构性修改

主线：
- 默认 `accessOrder=false`，遍历顺序 = 首次插入顺序；重复 put 同 key 不改变顺序。
- `accessOrder=true` 时，命中的节点会被移动到尾部，“最近访问”更新顺序。
- 这让 `get()` 本身也会影响迭代次序，和普通 `HashMap` / 插入序 `LinkedHashMap` 有根本区别。

### 第四节：LRU 为什么能被一个钩子“顺手做出来”

证据：
- `LinkedHashMap.java:77-79`：文档提 `removeEldestEntry`
- `LinkedHashMap.java:297-303`：`afterNodeInsertion`
- `LinkedHashMap.java:305-327`：访问后移尾
- 旧稿中的 LRU 示例可保留为示意代码块

主线：
- access-order 下，头部永远是最久未访问，尾部永远是最近访问。
- 插入后只需检查一次头部是否该淘汰；若该淘汰，删 head 即可。
- 因而 LRU 不是“额外算法”，而是顺序语义刚好吻合缓存淘汰需求。

### 第五节：TreeMap 不是“有序 HashMap”，而是完全不同的存储结构

证据：
- `TreeMap.java:33-42`：红黑树 + log(n)
- `TreeMap.java:44-55`：比较与 equals 一致性说明
- `TreeMap.java:121-123`：`comparator` / `root`

主线：
- TreeMap 不再依赖 hash 分桶，而是用 comparator / Comparable 决定整棵树上的相对位置。
- “相等 key”在 TreeMap 里本质上是 `compare(...) == 0`，这也是为什么比较器与 equals 一致性很重要。
- 它解决的是“按 key 排序”的全局结构问题，不是插入历史问题。

### 第六节：TreeMap 的 put / get 为什么天然是 O(log n)

证据：
- `TreeMap.java:340-359`：`getEntry`
- `TreeMap.java:367-383`：`getEntryUsingComparator`
- `TreeMap.java:533-584`：`put`
- `TreeMap.java:2218-2234`：`rotateLeft`
- `TreeMap.java:2237-2250`：`rotateRight`
- `TreeMap.java:2254+`：`fixAfterInsertion`

主线：
- 查找就是二叉搜索树查路：比较后左走/右走。
- 插入先按 BST 找位置，再用变色/旋转恢复红黑性质。
- 红黑树的价值是把最坏复杂度稳定在 O(log n)`，为后面的范围查询打地基。

### 第七节：为什么 `NavigableMap` 是 TreeMap 的真正核心价值

证据：
- `TreeMap.java:34`：`NavigableMap`
- `TreeMap.java:392-409`：`getCeilingEntry`
- 可补 `firstKey` / `subMap` 精确位置，如需要再读

主线：
- 业务要的往往不是“排好序看着舒服”，而是 `floor/ceiling/higher/lower/subMap` 这类范围导航。
- 这些操作在哈希结构里做不到自然的对数复杂度，因为它们需要比较序。
- 因此 TreeMap 的核心不是“它是红黑树”，而是“它提供了按 key 顺序导航的一整套能力”。

### 第八节：最终选型为什么必须分流

统一对照：
- 无序高速访问：HashMap
- 保持插入/访问顺序：LinkedHashMap
- 需要按 key 排序与范围查询：TreeMap

让读者明白“有序”不是一个需求，而是至少两种不同顺序语义。

## 5. 失败方案清单

1. 以为 LinkedHashMap 的顺序来自桶链表本身，而不是独立的全局双向链。
2. 用默认构造的 LinkedHashMap 期待得到访问序 LRU 行为。
3. 覆写 `removeEldestEntry` 却没打开 `accessOrder=true`，误以为就是 LRU。
4. 把 TreeMap 当成“能排序的 HashMap”，忽略它依赖 comparator 的完全不同结构。
5. 提供与 equals 不一致的比较器，却期待 TreeMap 仍完全遵守 Map 契约。
6. 只因“有序”就选 TreeMap，却并不需要范围查询或 key 导航能力。

## 6. 误解清单

1. LinkedHashMap 比 HashMap 慢很多，因为底层完全变成链表。
2. LinkedHashMap 的 get 不会改变结构；在 access-order 模式下它会影响顺序。
3. LRU 需要自己维护队列；LinkedHashMap 已经把顺序队列嵌进去了。
4. TreeMap 判断 key 是否相同仍然靠 hashCode/equals。
5. TreeMap 的有序性只是遍历效果，不影响查找路径。
6. “有序 Map”只有一种语义实现方式。

## 7. 证据清单

- `LinkedHashMap.java:33-48`：Hash table + linked list 注释
- `LinkedHashMap.java:61-79`：access-order 与 `removeEldestEntry` 注释
- `LinkedHashMap.java:112-118`：access-order 下 get 也是结构性修改
- `LinkedHashMap.java:192-197`：`Entry.before/after`
- `LinkedHashMap.java:204-217`：`head` / `tail` / `accessOrder`
- `LinkedHashMap.java:221-230`：`linkNodeLast`
- `LinkedHashMap.java:255-259`：`newNode`
- `LinkedHashMap.java:297-303`：`afterNodeInsertion`
- `LinkedHashMap.java:305-327`：`afterNodeAccess`
- `TreeMap.java:33-42`：红黑树 + log(n)
- `TreeMap.java:44-55`：比较与 equals 一致性
- `TreeMap.java:121-123`：`comparator` / `root`
- `TreeMap.java:340-359`：`getEntry`
- `TreeMap.java:367-383`：`getEntryUsingComparator`
- `TreeMap.java:392-409`：`getCeilingEntry`
- `TreeMap.java:533-584`：`put`
- `TreeMap.java:2218-2234`：`rotateLeft`
- `TreeMap.java:2237-2250`：`rotateRight`
- `TreeMap.java:2254+`：`fixAfterInsertion`

## 8. 版本与边界

- 基于 JDK 11。
- 不展开 `LinkedHashMap` 在并发场景下的完整替代设计，只提醒同步边界。
- 不展开红黑树五性质的完整证明，只保留足以支撑 TreeMap 复杂度与平衡维护的直观说明。
- 不展开 `ConcurrentSkipListMap`，仅作为后续并发有序对照路标。

## 9. 删除代码测试与最终验收标准

- 删除源码块后，读者仍能复述“LinkedHashMap = HashMap + 全局双向链，维护遍历顺序；access-order + removeEldestEntry 自然形成 LRU；TreeMap = comparator 驱动的红黑树，维护 key 有序并提供 NavigableMap 范围能力”。
- 必须明确 LinkedHashMap 与 TreeMap 维护的是两种不同‘顺序’。
- 必须说明 TreeMap 的 key 相等性从 `compare(...) == 0` 角度定义，而不是哈希角度。
- 必须把 LRU 讲成 access-order 与头尾语义的自然结果。
- 结尾要自然引到 `04-map-family.md`。
