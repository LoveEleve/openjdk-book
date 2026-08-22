# 为什么 `CompletableFuture` 默认用 `ForkJoinPool.commonPool()`？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`15-async/01-cf-basics`、`03-forkjoinpool`
> 版本边界：下文引用的 `CompletableFuture.java`、`ForkJoinPool.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

`CompletableFuture` 的 `thenApply` / `thenAccept` 等默认在哪个线程上执行？`thenApplyAsync` 又是在哪个线程上？为什么默认线程池是 `ForkJoinPool.commonPool()`？

## 常见答法

> 同步版本在调用线程上执行，异步版本在 `ForkJoinPool.commonPool` 上执行。

这个答法只背了结论，没有回答"为什么是 `commonPool` 而不是专有线程池"。真正的问题是：**`commonPool` 是所有并行流、`CompletableFuture` Async、`fork/join` 任务共享的执行器，为什么 JDK 要把它设计成共享的，而不是像线程池那样各自独立？**

## 追问一：`commonPool` 和普通线程池有什么区别？

> 答：commonPool 是全局共享的，默认线程数 = CPU 核数 - 1，适合计算密集型的并行任务，不适合阻塞型任务。

JDK 11 的 `ForkJoinPool.commonPool()`（`ForkJoinPool.java:2395`）是一个 JVM 进程内全局共享的 ForkJoinPool。它的默认并行度是 `Runtime.getRuntime().availableProcessors() - 1`，意味着它设计来吃的就是"计算密集型、自主调度、不阻塞"的任务。

`CompletableFuture` 之所以选它做默认异步执行器，是因为它的 async 链路（`thenApplyAsync`、`thenComposeAsync` 等）本质上就是"把一段回调交给另一个线程去跑"——这正好是 ForkJoinPool 最擅长的短任务调度。如果给每个 CompletableFuture 都建一个专有线程池，资源浪费不说，池子之间也无法互相偷取任务。

## 追问二：那 `CompletableFuture` 的默认执行器是 `commonPool` 吗？如果不是会怎样？

> 答：默认是 `commonPool`，但如果 `commonPool` 的并行度不支持（比如单核或禁用），会退到一个 `ThreadPerTaskExecutor`。

对。JDK 11 的 `CompletableFuture` 源码里有一段判断（`CompletableFuture.java:437`）：如果 `commonPool` 不支持并行，就退到 `new ThreadPerTaskExecutor()`（每个任务新开一个线程）。这个回退路径的存在说明：**`commonPool` 是首选但不是唯一，`CompletableFuture` 在设计上保证即使 `commonPool` 不可用，异步任务也不会挂掉。**

## 追问三：那在 `commonPool` 里做阻塞 IO 会有什么后果？

> 答：commonPool 的线程数非常有限，阻塞 IO 会把线程占住，导致其他并行任务和 CompletableFuture 回调都拿不到线程。

这是最常见也最危险的生产误用。`commonPool` 的线程数等于 CPU 核数 - 1，而且它没有"扩线程"机制。如果你在 `thenApplyAsync` 里做了阻塞 IO（数据库查询、远程调用），那这个线程就被占住了，其他也在等 `commonPool` 的任务（包括并行流、其他 CompletableFuture 回调、fork/join 任务）都可能被拖慢甚至死锁。

所以生产规范里有一条：**如果异步任务包含阻塞操作，应该显式传一个自定义 `Executor`（如线程池），而不是用 `commonPool` 的默认。**

## 源码证据

- 默认执行器选择逻辑（`CompletableFuture.java:437`）：`ForkJoinPool.commonPool() : new ThreadPerTaskExecutor()`
- 回退判断（`CompletableFuture.java:429-430`）：`USE_COMMON_POOL` 标志，控制并行度不足时是否回退
- `commonPool()` 方法（`ForkJoinPool.java:2395`）：全局共享池，并行度 = CPU 核数 - 1

## 一句话顿悟

**`CompletableFuture` 选 `commonPool` 作为默认异步执行器，不是因为"偷懒用已有的"，而是因为 `commonPool` 天然适合计算密集型短任务调度，且共享池避免资源浪费；但如果你在 `commonPool` 里做阻塞 IO，就等于在有限线程上放了无限等待——这是最需要换成自定义 `Executor` 的场景。** 面试官真正想听的不是你会背"Async 用 commonPool"，而是你知道 shared pool 的线程数限制、阻塞风险、以及 `ThreadPerTaskExecutor` 回退保护。