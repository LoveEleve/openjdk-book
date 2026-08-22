# 为什么 `LinkedHashMap` 能顺手实现 LRU，而 `HashMap` 不行？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`08-collections/05-linkedhashmap`
> 版本边界：下文引用的 `LinkedHashMap.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

为什么大家总说“自己写个简单 LRU，直接继承 `LinkedHashMap` 就行”？它为什么天生适合做 LRU，而普通 `HashMap` 不行？

## 常见答法

> 因为 `LinkedHashMap` 有双向链表，能记录访问顺序，再配合 `removeEldestEntry` 就能淘汰最老的数据。

这个答法方向对，但还差关键一步。**不是“有链表”就能做 LRU，而是 `LinkedHashMap` 把“哈希查找”和“顺序维护”绑在了一起：查找仍然走 `HashMap` 的 O(1) 桶定位，命中后再通过 `afterNodeAccess` 把节点挪到链表尾部。** 也就是说，它不是额外再扫一遍找“最近使用”，而是把“访问”这件事顺手转成了链表重排。

## 追问一：它怎么同时做到 O(1) 查找和维护访问顺序？

> 答：底层还是哈希表找节点，但每个节点再挂到一条双向链表里。

`LinkedHashMap` 继承自 `HashMap`，节点在桶里照样按哈希组织；同时它额外维护 `head` / `tail`（`LinkedHashMap.java:204-209`）形成双向链表。新增节点时，`newNode(...)`（`:255`）会创建带链表指针的节点，并通过 `linkNodeLast(...)`（`:222`）挂到尾部。

所以它不是在 `HashMap` 外面再维护一个独立索引，而是**同一个节点同时属于“哈希桶结构”和“全局访问顺序链表”两套结构。**

## 追问二：为什么访问一次就能变成“最近使用”？

> 答：因为开启 `accessOrder=true` 后，`get` 命中会触发 `afterNodeAccess(e)`，把节点移到尾部。

`LinkedHashMap` 构造器可以指定 `accessOrder=true`（`LinkedHashMap.java:393-402`）。一旦开启这个模式，`get()` 命中后会调用 `afterNodeAccess(e)`（`:442-443`），而这个方法本身的职责就是把当前节点从链表中摘出来，再接到尾部（`:305-307`）。

这意味着链表头部永远更接近“最久没被访问”的节点，尾部则是“最近刚访问”的节点。于是 LRU 所需的“最近使用顺序”就自然形成了。

## 追问三：淘汰最老元素又是怎么接上的？

> 答：插入后走 `afterNodeInsertion`，再由 `removeEldestEntry` 决定要不要删头节点。

`afterNodeInsertion(...)`（`LinkedHashMap.java:297-299`）会在插入后检查 `removeEldestEntry(first)`。如果你重写这个方法，让 size 超过上限时返回 `true`，它就会把链表头对应的最老节点删掉。

所以 `LinkedHashMap` 适合做 LRU，不是因为它“刚好有顺序”，而是因为它把三件事都串好了：

- 哈希定位
- 访问后重排到尾部
- 插入后按头节点淘汰

普通 `HashMap` 只有第一件事，没有后两件事，你就得自己再补一套顺序结构。

## 源码证据

- `head` / `tail`（`LinkedHashMap.java:204-209`）：维护全局双向链表
- `accessOrder`（`:217`）：决定是插入顺序还是访问顺序
- `linkNodeLast(...)`（`:222`）：新节点挂尾
- `newNode(...)`（`:255`）：创建同时参与哈希桶和链表的节点
- `afterNodeInsertion(...)`（`:297-299`）：插入后检查是否淘汰 eldest
- `afterNodeAccess(...)`（`:305-307`）：访问后把节点移到尾部
- 构造器 `accessOrder=true`（`:393-402`）：开启 LRU 所需的访问顺序模式
- `get()` 命中调用 `afterNodeAccess(e)`（`:442-443`）：访问行为直接驱动顺序重排

## 一句话顿悟

**`LinkedHashMap` 适合做 LRU，不是因为“它有链表”这么简单，而是因为它把“哈希查找、访问后重排、插入后淘汰”三件事做成了同一套节点结构上的内建机制。** 面试官真正想听的不是你会背"重写 `removeEldestEntry`"，而是你知道 `accessOrder + afterNodeAccess + head/tail` 才是 LRU 能成立的完整闭环。