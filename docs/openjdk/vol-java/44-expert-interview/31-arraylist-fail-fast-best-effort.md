# 为什么 `ArrayList` 的 fail-fast 只是“尽力而为”，不能当并发安全机制？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`08-collections/01-arraylist`
> 版本边界：下文引用的 `AbstractList.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

为什么官方一直强调 `ArrayList` 的 fail-fast 机制只是“best-effort”？既然它能抛 `ConcurrentModificationException`，为什么不能把它当成并发修改检测机制？

## 常见答法

> 因为 fail-fast 只是通过 `modCount` 比较来判断，线程不安全，所以不可靠。

这个答法方向对，但还差关键一步。**不是说“线程不安全所以不可靠”就结束了，而是 fail-fast 从设计上就不是同步协议——它既不加锁，也不保证可见性，只是在迭代器访问关键路径上顺手比较一下 `modCount` 和 `expectedModCount`。即使把计数读取做成可见的，这个检查也不能把后续迭代操作和并发修改绑定成一个原子过程。** 所以它能帮你尽早暴露 bug，但从来不保证一定能发现、一定在第一时间发现、或者一定以同样方式发现。

## 追问一：fail-fast 到底是怎么做的？

> 答：迭代器创建时记下一个 `expectedModCount`，之后每次关键访问时都比对当前 `modCount`。

`AbstractList.Itr`（`AbstractList.java:343`）在创建时会把 `expectedModCount = modCount`（`:361`）保存下来。后续 `next()`（`:367-379`）、`remove()`（`:381-395`）都会调用 `checkForComodification()`（`:397-399`），如果发现当前 `modCount != expectedModCount`，就抛 `ConcurrentModificationException`。

也就是说，fail-fast 本质上只是：**“我记住了当时的结构修改计数，之后用到迭代器时再看看它有没有变。”**

## 追问二：为什么这不等于并发安全？

> 答：因为它既没有可见性保证，也没有把“检查 + 访问”做成原子过程；就算看到了计数变化，也只能说明“某处改过”，不是一个可依赖的并发协议。

`modCount` 的定义是 `protected transient int modCount`（`AbstractList.java:628`），不是 `volatile`，相关读写也没有统一同步。所以在并发场景下，一个线程修改了列表，另一个线程在迭代器里什么时候能看到这个变化，并没有可靠保证。

更重要的是，**即使你把 `modCount` 的读取想象成总能立刻可见，fail-fast 依然不是并发安全机制**。因为它的工作方式只是：先 `checkForComodification()`，再继续 `next()` 里的读取逻辑；在“检查通过”和“真正访问元素”之间，别的线程仍然可能插进来修改列表。

这就导致几种结果都可能发生：

- 很快看到变化，于是抛 `ConcurrentModificationException`
- 暂时没看到变化，继续迭代一会儿才抛
- 检查刚通过，随后别的线程立刻修改，结果读到错乱状态后走到别的异常路径
- 极端情况下，`modCount` 计数回绕后又和 `expectedModCount` 相等，修改也可能没被识别

所以 fail-fast 不是“并发检测协议”，而只是“调试期尽量早点报警”。

## 追问三：那它为什么还值得存在？

> 答：因为在单线程误用或外部同步缺失时，它能比静默读错数据更早暴露问题。

如果没有 fail-fast，很多结构性并发修改会直接把迭代过程带进更隐蔽的错误：漏元素、重复元素、错位访问、偶发异常。`modCount` 至少提供了一个低成本的报警器，让这种误用更早暴露出来。

但一定要记住边界：**它的目标是“尽力发现错误”，不是“提供正确并发语义”。** 真要并发安全，要么外部加锁，要么用并发容器或快照容器，而不是赌 `ConcurrentModificationException` 会不会抛。

## 源码证据

- `AbstractList.Itr`（`AbstractList.java:343`）：默认迭代器实现
- `expectedModCount = modCount`（`:361`）：创建迭代器时记下计数
- `next()`（`:367-379`）：访问前检查计数
- `remove()`（`:381-395`）：删除前检查计数并在成功后刷新 `expectedModCount`
- `checkForComodification()`（`:397-399`）：核心判断逻辑
- `modCount`（`AbstractList.java:628`）：只是普通 `int`，不是并发同步字段

## 一句话顿悟

**`ArrayList` 的 fail-fast 不是并发安全机制，而是一个“顺手做的结构修改报警器”：它不加锁、不保证可见性，只在关键路径上尽力比一下 `modCount`。** 面试官真正想听的不是你会背"fail-fast 不安全"，而是你知道它为什么只能 best-effort，以及为什么 `ConcurrentModificationException` 从来不能当成并发控制手段。