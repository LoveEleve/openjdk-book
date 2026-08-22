# 为什么 `CopyOnWriteArrayList` 适合读多写少，而不只是“线程安全版 ArrayList”？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`10-concurrent-collections/03-copyonwrite`
> 版本边界：下文引用的 `CopyOnWriteArrayList.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

为什么大家都说 `CopyOnWriteArrayList` 只适合读多写少？它不就是一个线程安全版的 `ArrayList` 吗？

## 常见答法

> 因为它写的时候要复制数组，开销大，所以只适合读多写少。

这个答法只讲了表面。**真正的关键不只是"写时复制很贵"，而是它把读写彻底拆成了两套路径：读线程永远只看一个不可变快照，不加锁；写线程每次都复制整份数组，在锁内改完后再用一次 volatile 写把新数组发布出去。** 所以它优化的是"读无锁、迭代稳定"，代价才是"写放大、内存抖动"。

## 追问一：它的读为什么可以完全不加锁？

> 答：因为底层数组引用是 volatile 的，读线程只读当前快照，不会碰到中间态。

`CopyOnWriteArrayList` 的底层数组是 `volatile Object[] array`（`CopyOnWriteArrayList.java:105`）。`get(int index)`（`:397-399`）只是 `getArray()` 后直接取元素，不加锁。

之所以安全，是因为写线程不是在原数组上改，而是先复制一份新数组，改完后再 `setArray(es)`（`:118`）一次性替换底层引用。这样读线程要么看到旧数组，要么看到新数组，不会看到一半修改到一半没修改的中间态。

## 追问二：那它为什么写开销特别大？

> 答：因为每次 `add` / `set` / `remove` 都可能复制整份数组。

`add(E e)`（`CopyOnWriteArrayList.java:428-435`）在锁内先拿到旧数组，再 `Arrays.copyOf(es, len + 1)` 复制整份，再把新元素塞进去，最后 `setArray(es)` 发布。`set(int index, E element)`（`:407-418`）即使只改一个位置，也可能先 `clone()` 整个数组。

所以它的写不是"改一个元素"，而是"复制整个世界再切换引用"。元素越多，写放大越严重；写越频繁，GC 压力和内存带宽消耗越明显。

## 追问三：那它真正适合什么场景？

> 答：读远多于写，而且非常在意遍历时不加锁、不抛 `ConcurrentModificationException` 的场景。

`CopyOnWriteArrayList` 真正的价值，不是"它线程安全"，而是：

- 读操作完全无锁，性能稳定
- 迭代基于快照，不会被并发写打断
- 读线程不需要和写线程争同一把锁

所以它很适合监听器列表、白名单缓存、配置快照这类"偶尔改、经常读、读时还希望遍历稳定"的场景。反过来，如果你的列表会高频增删改，`CopyOnWriteArrayList` 往往比加锁的普通列表还差，因为它把每次写都放大成了 O(n) 复制。

## 源码证据

- `volatile Object[] array`（`CopyOnWriteArrayList.java:105`）：快照发布的基础
- `setArray(Object[] a)`（`:118`）：通过 volatile 写发布新数组
- `get(int index)`（`:397-399`）：纯读快照，不加锁
- `set(int index, E element)`（`:407-418`）：锁内 clone 后替换引用
- `add(E e)`（`:428-435`）：锁内 `Arrays.copyOf(...)` 后替换引用

## 一句话顿悟

**`CopyOnWriteArrayList` 不是简单的“线程安全版 ArrayList”，而是“读走快照、写走整表复制”的特殊权衡。** 面试官真正想听的不是你会背"读多写少"，而是你知道它为什么能读无锁、为什么迭代稳定、以及这个能力是靠每次写都复制整份数组换来的。