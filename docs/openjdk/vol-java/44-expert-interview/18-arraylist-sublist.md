# 为什么 `ArrayList.subList` 返回的是视图而不是副本？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`08-collections/01-arraylist`
> 版本边界：下文引用的 `ArrayList.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

`list.subList(from, to)` 返回的是新的 ArrayList 还是原列表的一个视图？修改子列表会影响原列表吗？为什么这样设计？

## 常见答法

> 返回的是视图，修改子列表会同步到原列表。subList 返回的是 SubList 视图，不是独立副本。

这个答法方向对，但没答"为什么"。如果每次 subList 都复制一份，那调用方得到一个独立的 ArrayList，修改子列表不影响原列表，反而更安全。**为什么 JDK 偏要返回一个视图，让调用方稍不注意就改了原数据？**

## 追问一：subList 为什么不做成"复制一份"？CopyOnWrite 那种思路不行吗？

> 答：subList 的目的是"提供一段连续范围的视图"，不是为了做快照。复制会破坏性能——一次 subList 就要 O(n) 复制，而且后续对子列表的每次修改也要同步回原列表，成本更高。

`SubList`（`ArrayList.java:1142`）只是一个持着 `root` 引用和 `offset`/`size` 的轻量对象。`get(i)` 直接走 `root.elementData(offset + i)`（`:1181`），`set(i, e)` 也一样（`:1173-1174`）。零额外复制。

如果每次 subList 都复制一份，就意味着：

- 大列表上取一小段子列表也要 O(n) 复制
- 子列表的修改还要另写一套同步逻辑才能写回原列表
- 如果只想"读几行"，用不着复制整段

所以视图设计才是正确的选择：**轻量、无复制、共享底层数组。** 代价就是调用方必须知道"修改子列表会同步到原列表"。

## 追问二：那修改子列表导致原列表并发修改，会抛 ConcurrentModificationException 吗？

> 答：会。SubList 的修改操作会更新原列表的 modCount，如果同时有别的线程在遍历原列表，就会抛出 CME。

对。SubList 的修改操作（`add`、`remove`、`set` 等）最终都会调用 `root` 的方法，更新的是原列表的 `modCount`。所以如果你在遍历原列表的同时修改子列表，或者反过来，都会触发 `ConcurrentModificationException`。

这也说明 SubList 不是"独立副本"，它和原列表共享同一个结构修改计数器，本质上就是一个"换了个视角看原数组"的轻量对象。

## 追问三：那 subList 的视图设计最大的坑是什么？

> 答：创建 subList 后修改原列表的结构，subList 的操作会抛异常。

这是 subList 最容易被忽略的边界。`SubList` 的 `get`/`set` 走的是 `root.elementData` 数组索引，但 `add`/`remove` 会修改原列表的 `size`。如果在创建 subList 后，原列表的结构变了（增删元素），subList 的 `offset` 和 `size` 就失效了，再去操作 subList 会抛 `IndexOutOfBoundsException` 或 `ConcurrentModificationException`。

所以 subList 的"视图"是有隐含前提的：**创建子列表后，原列表的结构不应该再变。** 如果一定要变，那就重新调一次 subList。

## 源码证据

- `subList(fromIndex, toIndex)`（`ArrayList.java:1137-1139`）：返回 `new SubList<>(this, fromIndex, toIndex)`
- `SubList` 类结构（`:1142`）：持有 `root`、`offset`、`size`，不复制元素
- `get(i)` 实现（`:1181`）：`root.elementData(offset + i)`，直接按偏移量访问原数组
- `set(i, e)` 实现（`:1173-1174`）：同样直接修改原数组

## 一句话顿悟

**subList 返回视图而不是副本，不是因为"偷懒"，而是因为"视图是常量时间的轻量操作，副本是 O(n) 的复制操作"——subList 的设计意图是"给你一段数组的另一个视角"，不是"给你一段数据的独立存档"。** 面试官真正想听的不是你会背"subList 是视图"，而是你知道 SubList 的 `offset+root` 结构、以及为什么视图设计的代价是"修改原列表后 subList 会失效"。