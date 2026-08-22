# 为什么 `volatile` 能禁止重排序，却仍然不保证复合操作原子性？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`40-java-lang/05-jmm-volatile-final`、`44-expert-interview/10-volatile-not-atomic`
> 版本边界：下文引用的 `Unsafe.java`、`AtomicInteger.java` 行号均为 JDK 11 源码；`volatile` 的核心语义来自 JMM 规范，源码这里主要用来对照“可见性/有序性”和“原子更新”不是一回事。

## 题目

为什么大家都说 `volatile` 能禁止指令重排序、保证可见性，但 `count++` 加上 `volatile` 之后还是不安全？

## 常见答法

> 因为 `volatile` 只能保证可见性，不能保证原子性。

这个答法方向对，但还差最关键的一步：**不是“volatile 比较弱”这么简单，而是它解决的是“读到什么顺序上的值”问题，不解决“多个线程如何竞争同一次读改写”问题。** `count++` 不是一次动作，而是“读 -> 加一 -> 写回”三个阶段；`volatile` 只能让读写更可见、更有序，不能把这三步捏成一个不可分割的整体。

## 追问一：`volatile` 到底保证了什么？

> 答：保证可见性，并在读写两侧建立内存语义，限制某些重排序。

`Unsafe` 的相关文档就直接把 volatile 语义写出来了：例如 volatile read / volatile store 的说明（`Unsafe.java:853`、`:908`）明确强调了这是带 volatile memory semantics 的访问；`fullFence()`（`:1218-1219`）则体现了更强的内存屏障语义。

放到 `volatile` 字段上，含义就是：**写线程对这个变量的写，不会被随意重排到它后面；读线程对这个变量的读，也会建立相应的可见性边界。** 所以它非常适合“发布一个状态位”“停止标志”“双检里的已初始化标记”这类场景。

## 追问二：那为什么 `count++` 还是不安全？

> 答：因为 `count++` 是读改写复合操作，多个线程可能基于同一个旧值同时计算。

假设 `count` 当前是 5，两个线程同时做 `count++`：

- 线程 A 读到 5
- 线程 B 也读到 5
- A 算出 6 写回
- B 也算出 6 写回

最后结果是 6，不是 7。

这里每次“读”与“写”本身即使都是 volatile 访问，也挡不住**两个线程在中间那段计算窗口里彼此覆盖结果**。所以 volatile 解决不了 lost update，本质原因不是“看不见”，而是“大家都看见了同一个旧值”。

## 追问三：那真正的原子自增靠什么？

> 答：靠 CAS 或锁，把整次读改写变成一个不可被别人插进来的原子更新。

这就是为什么 `AtomicInteger.incrementAndGet()`（`AtomicInteger.java:215-216`）不会只靠一个 volatile 字段，而是直接走 `U.getAndAddInt(...)`；`compareAndSet()`（`:133`）也提供了原子更新语义。

所以边界非常清楚：

- `volatile`：保证看见最新值、限制重排序
- CAS / 锁：保证整次复合更新不被并发线程拆穿

如果场景只是“一个线程写标志，其他线程读标志”，`volatile` 很合适；如果场景是“多个线程一起做读改写”，那就必须上 CAS、原子类或锁。

## 源码证据

- volatile read 语义说明（`Unsafe.java:853`）：读取具有 volatile memory semantics
- volatile store 语义说明（`Unsafe.java:908`）：写入具有 volatile memory semantics
- `fullFence()`（`Unsafe.java:1218-1219`）：更强内存屏障语义对照
- `AtomicInteger.compareAndSet()`（`AtomicInteger.java:133`）：原子更新入口
- `AtomicInteger.incrementAndGet()`（`AtomicInteger.java:215-216`）：自增不是普通 volatile 写，而是 `U.getAndAddInt(...)`

## 一句话顿悟

**`volatile` 禁止重排序、保证可见性，解决的是“值什么时候对别人可见”；原子性解决的是“这次读改写能不能被别人插进来”。** 面试官真正想听的不是你会背"volatile 不保证原子性"，而是你知道它为什么挡不住 `count++` 这种复合竞争，以及为什么原子类必须再往前走一步，用 CAS 或锁把整次更新包起来。