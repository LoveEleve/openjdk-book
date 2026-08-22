# 为什么 ThreadLocalMap 用开放寻址、不使用链地址法？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`11-thread-threadlocal/02-threadlocal`
> 版本边界：下文引用的 `ThreadLocal.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

ThreadLocalMap 为什么不用和 HashMap 一样的链地址法解决哈希冲突，而要用开放寻址？

## 常见答法

> 因为 ThreadLocalMap 的 Entry 数量少，开放寻址更简单，可以节省内存（不用额外链表节点）。

这个答法方向对，但"数量少"只是现象，没讲透**为什么少就能用开放寻址、而 HashMap 为什么不这么做**。真正的分界线是：**ThreadLocalMap 是每线程一张小表，一般只有几个 Entry，而且删除后有清理逻辑（`expungeStaleEntry`）重排后续探测链，不会让冲突长期堆积。HashMap 则是面向通用场景的大表实现，元素规模更大、冲突模式更复杂；如果也用开放寻址，冲突链会更容易恶化，删除后的维护成本也更高。**

## 追问一：开放寻址和链地址法各自适合什么场景？

> 答：开放寻址适合小表、元素少、删除频率低的场景；链地址法适合大表、元素多、删除频繁的场景。

`HashMap` 用链地址法，是因为它要处理大量元素、高冲突率——链表（或红黑树）能在冲突时把额外元素挂上去，不需要整个表大范围重排。开放寻址在线性探测时，删除一个元素可能在探测链上留下空洞，导致后续元素找不到，必须 `expunge` 或 `rehash`。

`ThreadLocalMap` 的 `Entry[] table`（`ThreadLocal.java:348`）默认大小是 16（`:342`），而且每个线程的 ThreadLocalMap 通常只装几个 ThreadLocal 对应的值。这样的小表，开放寻址不仅实现简单，而且内存局部性好——整个表就在一个连续数组里，CPU 缓存友好。

## 追问二：那 ThreadLocalMap 的开放寻址是怎么解决"删除后探测链断裂"的？

> 答：`expungeStaleEntry` 在清理脏槽时会顺带 rehash 后续探测链上的元素，保证链不中断。

`ThreadLocalMap` 的 `expungeStaleEntry` 方法在清理一个 key 为 null 的脏槽时，不是简单地把槽位清空，而是把后续探测链上的元素拿出来重新插入（rehash），保证没有被清理的 Entry 仍然能被 `nextIndex`/`prevIndex`（`:370`、`:377`）的线性探测路径找到。

这个设计代价是"清理时的一次 O(n) 扫描"，但这对小表来说可以接受。HashMap 如果也用开放寻址，在大表上做一次 O(n) 的 rehash 扫描成本就太高了。

## 追问三：为什么 HashMap 不也用开放寻址？

> 答：HashMap 要处理大量元素，开放寻址的冲突链会快速恶化，删除后探测链维护成本太高。

HashMap 的默认容量已经是 16，但它的负载因子是 0.75，意味着扩容前最多装 12 个元素就会扩容。如果 HashMap 用开放寻址，随着冲突链变长，线性探测的查找效率会急剧下降，而且在删除时维护探测链的复杂度远超链地址法。

所以数据结构选型的本质是：**ThreadLocalMap 的"小表 + 低频删除"让它适合开放寻址；HashMap 的"大表 + 高频删除"让它适合链地址法。** 不是"谁更好"，而是"谁更匹配你的访问模式"。

## 源码证据

- `ThreadLocalMap.INITIAL_CAPACITY = 16`（`ThreadLocal.java:342`）：小表起步
- `Entry[] table`（`:348`）：连续数组，开放寻址
- `nextIndex(i, len)`（`:370`）：线性探测的下一个位置
- `prevIndex(i, len)`（`:377`）：线性探测的前一个位置
- `expungeStaleEntry`：清理脏槽时 rehash 后续探测链，维持路径完整性

## 一句话顿悟

**ThreadLocalMap 用开放寻址不是因为"链表更复杂"，而是因为"小表 + 连续数组 + 探测链 rehash"在它的使用场景下比链地址法更简单、更快、缓存更友好。** 面试官真正想听的不是你会背"ThreadLocalMap 用开放寻址"，而是你知道开放寻址和链地址法各自的前提条件，以及 `expungeStaleEntry` 的 rehash 机制是维持探测链完整性的关键。