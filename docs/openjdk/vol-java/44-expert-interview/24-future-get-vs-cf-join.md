# 为什么 `Future.get()` 会抛 `InterruptedException`，而 `CompletableFuture.join()` 却抛 `CompletionException`？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`12-juc/06-completablefuture`
> 版本边界：下文引用的 `Future.java`、`CompletableFuture.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

同样是等异步结果，为什么 `Future.get()` 要声明 `InterruptedException` / `ExecutionException`，而 `CompletableFuture.join()` 却只抛 `CompletionException` 这类运行时异常？

## 常见答法

> 因为 `join()` 更方便，不用写 checked exception。

这个答法只说了表面。**本质区别不在"语法更方便"，而在它们对"中断"的态度不同：`get()` 是可中断等待，线程被中断就立刻返回 `InterruptedException`；`join()` 走的是不可中断等待，等待过程中如果线程被中断，它会记下中断标记，等结果到了再把中断状态补回去。**

## 追问一：`get()` 和 `join()` 在等待方式上到底差在哪？

> 答：`get()` 调的是可中断等待，`join()` 调的是不可中断等待。

`Future.get()` 的接口定义（`Future.java:143`）明确声明了 `InterruptedException`。`CompletableFuture` 内部则把等待逻辑统一放在 `waitingGet(boolean interruptible)`（`CompletableFuture.java:1809`）里：

- `get()` 走 `waitingGet(true)`（`CompletableFuture.java:2004`）
- `join()` 走 `waitingGet(false)`（`CompletableFuture.java:2049`）

这不是异常包装层面的差异，而是等待策略本身就不同。`get()` 一旦发现线程被中断，就按中断语义退出；`join()` 则选择继续等结果。

## 追问二：那 `join()` 遇到中断到底怎么处理？

> 答：它不把中断翻译成 `InterruptedException`，而是继续等，最后再把线程的中断标记补回去。

`waitingGet(false)` 这条路径即使在等待期间观察到中断，也不会像 `waitingGet(true)` 那样返回 `null` 交给 `reportGet()` 抛 `InterruptedException`。相反，它会继续等结果；等到结果到达后，如果等待期间被中断过，会在退出前执行 `Thread.currentThread().interrupt()`（`CompletableFuture.java:1839`），把中断标记重新设回当前线程。

所以 `join()` 不是"无视中断"，而是**不让中断打断这次等待，但保留中断事实给后续代码处理**。

## 追问三：那为什么异常一个叫 `ExecutionException`，一个叫 `CompletionException`？

> 答：因为 `get()` 走的是 `Future` 老接口的 checked-exception 语义，`join()` 走的是 `CompletableFuture` 新接口的 unchecked-exception 语义。

`reportGet()`（`CompletableFuture.java:382-397`）会把异常结果包装成 `ExecutionException`，并且把中断翻译成 `InterruptedException`。`reportJoin()`（`CompletableFuture.java:403-414`）则完全走 unchecked 路线：如果已经是 `CompletionException` 就直接抛，不是的话就包一层 `CompletionException`。

所以 `join()` 的设计目标不是单纯"少写 try/catch"，而是：**既保持流式 API 的调用体验，又避免把中断作为这条等待路径的直接控制信号。**

## 源码证据

- `Future.get()`（`Future.java:143`）：接口层就声明 `InterruptedException` / `ExecutionException`
- `waitingGet(boolean interruptible)`（`CompletableFuture.java:1809`）：统一等待入口
- `get()`（`CompletableFuture.java:2004-2005`）：走 `waitingGet(true)` + `reportGet(...)`
- `join()`（`CompletableFuture.java:2046-2050`）：走 `waitingGet(false)` + `reportJoin(...)`
- `reportGet()`（`CompletableFuture.java:382-397`）：中断转 `InterruptedException`，异常转 `ExecutionException`
- `reportJoin()`（`CompletableFuture.java:403-414`）：异常统一走 `CompletionException`
- `Thread.currentThread().interrupt()`（`CompletableFuture.java:1839`）：`join()` 路径会补回中断标记

## 一句话顿悟

**`Future.get()` 和 `CompletableFuture.join()` 的真正分界线，不是 checked vs unchecked，而是可中断等待 vs 不可中断等待。** 面试官真正想听的不是你会背"join 更方便"，而是你知道 `get()` 走 `waitingGet(true)`、`join()` 走 `waitingGet(false)`，以及 `join()` 会在结果回来后补回线程中断标记。