# JDK 8+ 的 `ConcurrentHashMap` 为什么在高并发下还能保持不错的扩展性？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`10-concurrent-collections/01-chm-storage-rw`、`02-resize-count`
> 版本边界：下文引用的 `ConcurrentHashMap.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

JDK 8 以后 `ConcurrentHashMap` 没有 `Segment` 了，为什么高并发下性能还是能打？它到底靠什么保持扩展性？

## 常见答法

> 因为 JDK 8 把分段锁去掉了，改成 CAS + `synchronized`，所以性能更好。

这个答法方向对，但还远远不够。**不是说“去掉 Segment 就自动更快”，而是 JDK 8+ 把竞争拆散到了更细的层级：空桶插入走 CAS，冲突桶只锁当前 bin，扩容时多线程协作搬迁，计数再拆到 `CounterCell` 分摊热点。** 真正的扩展性来自“把一个大热点拆成多个小热点”。

## 追问一：写入时为什么不会退化成一把大锁？

> 答：因为空桶插入直接 CAS，发生哈希冲突时也只是锁住当前 bin 的头节点，不会锁整个表。

`putVal(...)`（`ConcurrentHashMap.java:1010`）里有一条很关键的路径：如果目标桶位是空的，直接 `casTabAt(tab, i, null, new Node...)`（`:1018-1020`）插进去，完全不加锁。

只有发生冲突、桶里已经有节点时，才会进入 `synchronized (f)`（`:1031`）去处理这个 bin。也就是说，竞争被限制在"同一个 hash bin"里，而不是整个 `ConcurrentHashMap` 共享一把锁。只要 key 分布比较均匀，不同桶上的写入就能并行推进。

## 追问二：扩容不是很容易把所有线程都卡住吗？

> 答：不会。JDK 8+ 的 CHM 允许线程一起参与迁移，而不是让一个线程独自搬完整张表。

当线程发现当前桶位是 `MOVED` 状态时，不是傻等扩容完成，而是转去 `helpTransfer(tab, f)`（`ConcurrentHashMap.java:1022-1023`）协助迁移。这意味着扩容不是"一个线程干活，其他线程排队"，而是多个线程一起搬桶，把一次大停顿拆成并行协作。

这也是它在高并发下还能扛住 rehash 的关键：**扩容成本没有被集中压到单线程上。**

## 追问三：那 size 统计和热点计数怎么避免成为瓶颈？

> 答：不用一个全局计数器硬扛，而是用 `baseCount + CounterCell[]` 分散写竞争。

CHM 没有把元素总数全压到一个 `AtomicLong` 上，而是用了 `baseCount`（`ConcurrentHashMap.java:790`）和 `CounterCell[]`（`:815`）这套分片计数机制。低竞争时直接改 `baseCount`，竞争上来后再把更新分散到不同 `CounterCell` 上，最后 `sumCount()`（`:2560`）再汇总。

这和写入分 bin 锁的思路是一致的：**不要让所有线程去争同一个热点变量。** 所以 CHM 的扩展性不是某一个技巧带来的，而是整张表在"桶、扩容、计数"三个层面同时做了热点拆分。

## 源码证据

- `table`（`ConcurrentHashMap.java:778`）：底层桶数组
- `casTabAt(...)`（`:763`）：空桶插入直接 CAS
- `putVal(...)`（`:1010`）：写路径主入口
- `synchronized (f)`（`:1031`）：冲突时只锁当前 bin
- `helpTransfer(...)`（`:1022-1023`）：扩容时协助搬迁
- `baseCount`（`:790`）和 `CounterCell[]`（`:815`）：计数热点拆分
- `sumCount()`（`:2560`）：最终汇总计数

## 一句话顿悟

**JDK 8+ `ConcurrentHashMap` 的扩展性，不是因为“用了 CAS 所以快”，而是因为它把并发热点拆到了多个层次：空桶 CAS、冲突 bin 局部锁、扩容协作迁移、计数分片累加。** 面试官真正想听的不是你会背"JDK 8 去掉了 Segment"，而是你知道它怎么把“一把大锁”的问题拆成很多个小冲突点。