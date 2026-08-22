# 为什么 `submit` 要包一层 FutureTask，不直接返回任务本身？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`14-threadpool/04-futuretask-scheduled`
> 版本边界：下文引用的 `AbstractExecutorService.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

`ExecutorService.submit(Runnable)` 和 `Executor.execute(Runnable)` 有什么区别？为什么 `submit` 要多包一层 FutureTask？不能直接返回任务本身吗？

## 常见答法

> submit 返回 Future，可以通过 Future 获取结果和异常；execute 没有返回值，异常直接抛。

这个答法只说对了"有什么差异"，没解释"为什么 submit 必须包一层 FutureTask 才能实现这些差异"。真正的问题是：**线程池执行的是 `execute(Runnable)`，而 `submit` 返回的是 `Future`——这两个接口之间需要一个桥接对象，把"执行"和"结果观察"统一到同一个实体上。**

## 追问一：FutureTask 为什么能同时扮演"执行者"和"结果句柄"？

> 答：因为 FutureTask 实现了 RunnableFuture，即同时是 Runnable 和 Future。

对。`FutureTask` 实现 `RunnableFuture<V>`，所以它既能被 `execute(Runnable)` 接收，又能作为 `Future<V>` 返回给调用方。`submit` 在 `AbstractExecutorService` 中做的事就是：把你的任务包进 `FutureTask`，然后把这个对象同时交给 `execute` 去跑、又返回给调用方当 `Future` 用（`AbstractExecutorService.java:115-118`）。

这意味着同一个对象既跑了任务，又保存了结果和异常，不用额外同步两个对象。

## 追问二：那 `newTaskFor` 为什么是 protected 的？它设计给谁用？

> 答：给子类覆盖，允许自定义 FutureTask 的实现。

`AbstractExecutorService.newTaskFor(Runnable, T)` 是 protected 的（`AbstractExecutorService.java:92-95`），它的默认实现返回 `FutureTask`。但子类可以覆盖这个方法，返回自己的 `RunnableFuture` 实现——比如在 `afterExecute` 里做额外处理、或者自定义取消协议。

这暴露了 `submit` 的设计意图：**`submit` 不是"execute 加一个返回值"这么简单，而是一个模板方法——`newTaskFor` 是扩展点，允许子类定制"执行和结果绑定的对象"。**

## 追问三：如果不用 FutureTask，自己用 synchronized 包一个结果容器，行不行？

> 答：可以，但 FutureTask 做的远不止"存结果"，它还有一个完整的状态机管理取消、中断、超时和等待。

对。`FutureTask` 的状态机至少包含 `NEW`、`COMPLETING`、`NORMAL`、`EXCEPTIONAL`、`CANCELLED`、`INTERRUPTING`、`INTERRUPTED` 七种状态。自建一个"结果容器"不仅实现这些状态管理很困难，而且无法和线程池的 `afterExecute`、`get()` 阻塞等待、`cancel(true)` 中断当前线程等机制无缝配合。

## 源码证据

- `submit(Runnable)` 方法（`AbstractExecutorService.java:115-118`）：通过 `newTaskFor` 包装后 `execute(ftask)`，再返回 `ftask`
- `newTaskFor(Runnable, T)` 是 protected（`:92-95`）：允许子类自定义 `RunnableFuture` 实现
- `FutureTask` 的状态机：`NEW → COMPLETING → NORMAL/EXCEPTIONAL` 和 `NEW → CANCELLED/INTERRUPTING → INTERRUPTED`

## 一句话顿悟

**`submit` 包一层 FutureTask 不是因为"要一个返回值"，而是因为"要把执行和结果观察统一到同一个对象上"——FutureTask 同时是 Runnable（让线程池执行）和 Future（让调用方等结果、拿异常、取消），两个角色合在一个状态机里，不需要额外同步。** 面试官真正想听的不是你会背"submit 返回 Future"，而是你知道 `newTaskFor` 是扩展点、`FutureTask` 是一个双角色状态机、以及为什么单角色做法行不通。