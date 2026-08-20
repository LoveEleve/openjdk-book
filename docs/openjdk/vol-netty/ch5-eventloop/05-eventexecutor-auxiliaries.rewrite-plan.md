# Ch5-05 EventExecutor 辅助体系：DefaultEventExecutor、GlobalEventExecutor、NonSticky 与 Unordered — rewrite-plan

## 篇章定位

- 核心困惑：前面已经写了 EventLoop、Promise/Future、WriteTask、timeout 和一些线程本地基础设施，但 Netty common/concurrent 里还有一批执行器看起来像“不是 EventLoop、又不是普通线程池”的中间层：`DefaultEventExecutor`、`DefaultEventExecutorGroup`、`GlobalEventExecutor`、`NonStickyEventExecutorGroup`、`UnorderedThreadPoolEventExecutor`、`AbstractScheduledEventExecutor`、`ScheduledFutureTask`。它们到底解决了什么问题？哪些任务必须回 EventLoop，哪些可以旁路，哪些执行器只是辅助调度层？
- 一句话顿悟：Netty 的执行体系不是“只有 EventLoop 和普通线程池”两级，而是按边界再细分：`EventLoop` 负责 I/O 与强顺序任务，`DefaultEventExecutor(Group)` 负责给 handler 或辅助逻辑提供独立但仍有 Netty Promise/调度语义的单线程执行面，`GlobalEventExecutor` 负责少量全局低频任务，`NonStickyEventExecutorGroup` 在无序底座上人为恢复单条执行链顺序，`UnorderedThreadPoolEventExecutor` 则显式承认某些协议或任务不要求严格顺序，而 `AbstractScheduledEventExecutor/ScheduledFutureTask` 统一承载这些执行器的定时任务语义。
- 文章边界：本篇主讲这些辅助执行器的职责边界、排序语义、定时任务支持和与 EventLoop 的关系；不重讲 Promise/Future 状态模型，不重讲 EventLoop select 主循环。

## 依赖

### HARD

- Ch5-01/02/04：理解 EventLoop、任务队列、线程模型与多线程 group 的基础。
- Ch6-01~03：理解 Promise/Future / ScheduledFutureTask / ChannelPromise 的完成与调度语义。
- Ch7-07：理解出站任务跨 executor 调度时的壳对象与 release 边界。

### SOFT

- Ch13-01：只复用“promise completion 可能发生在不同 executor”这个边界。
- Ch8-07：只复用“指标和可观测性要按层看”的思路。

### NAV

- 后续：平台专题前的最后一个并发/调度补完篇。
- 后续：更具体的 offload、阻塞任务隔离或执行器误用案例。

## 结构设计

### 1. 开场：Netty 不是只有 EventLoop 和线程池两级
- 回收前文：EventLoop 负责 I/O 和强顺序。
- 引出疑问：那非 I/O 但仍想保留 Netty promise / schedule / ordering 语义的任务怎么办？
- 预计 900-1200 字。

### 2. `EventExecutor` 抽象：什么叫“带 inEventLoop 语义的执行器”
- `parent()`、`inEventLoop()`、`newPromise()`、`newSucceededFuture()`。
- 它不只是 Executor，而是带线程归属/Promise/定时语义的执行面。
- 预计 1400-1800 字。

### 3. `DefaultEventExecutor` / `DefaultEventExecutorGroup`：脱离 I/O 的顺序执行面
- 基于 `SingleThreadEventExecutor` 的串行 run loop。
- 为什么它适合 handler offload / 辅助逻辑，而不直接参与 select。
- group 如何批量创建 child executor。
- 预计 1800-2400 字。

### 4. `GlobalEventExecutor`：为什么它是单例、低频、可自停的
- 单线程 singleton、quiet period、自启动、自停。
- 为什么它不适合大量任务，只适合全局低频辅助任务和默认 promise/termination future 场景。
- 预计 1800-2400 字。

### 5. `NonStickyEventExecutorGroup`：怎样在无序底座上恢复单条链顺序
- 包装的 group 不能包含 `OrderedEventExecutor`。
- 每次 `next()` 返回 `NonStickyOrderedEventExecutor` 壳。
- `maxTaskExecutePerRun`、state、re-submit、自旋消费语义。
- 预计 1800-2400 字。

### 6. `UnorderedThreadPoolEventExecutor`：什么时候明确放弃顺序保证
- 它是 `ScheduledThreadPoolExecutor` + `EventExecutor` 语义结合体。
- 明确“不保证 ordering”，并被标注为 deprecated。
- 说明它适合什么，不适合什么。
- 预计 1400-1800 字。

### 7. `AbstractScheduledEventExecutor` / `ScheduledFutureTask`：辅助执行器的定时任务底座
- scheduledTaskQueue、deadline、period、fixed-rate / fixed-delay。
- 和前面 Ch6-03 的关系：这里从“任务对象”回到“执行器承载面”。
- 预计 1600-2200 字。

### 8. 收网：哪些任务必须回 EventLoop，哪些可以旁路
- I/O 状态、Channel 主线、writability/flush 主线必须回 EventLoop。
- 低频全局任务、定时辅助、无强顺序任务、包装执行面各自落在哪种 executor 上。
- 预计 700-1000 字。

## 证据清单

- `common/src/main/java/io/netty/util/concurrent/EventExecutor.java:21-113`
- `common/src/main/java/io/netty/util/concurrent/DefaultEventExecutor.java:21-74`
- `common/src/main/java/io/netty/util/concurrent/DefaultEventExecutorGroup.java:21-60`
- `common/src/main/java/io/netty/util/concurrent/GlobalEventExecutor.java:38-260`
- `common/src/main/java/io/netty/util/concurrent/NonStickyEventExecutorGroup.java:34-260`
- `common/src/main/java/io/netty/util/concurrent/UnorderedThreadPoolEventExecutor.java:38-220`
- `common/src/main/java/io/netty/util/concurrent/AbstractScheduledEventExecutor.java:28-220`
- `common/src/main/java/io/netty/util/concurrent/ScheduledFutureTask.java:27-227`
- `common/src/test/java/io/netty/util/concurrent/GlobalEventExecutorTest.java`
- `common/src/test/java/io/netty/util/concurrent/NonStickyEventExecutorGroupTest.java`
- `common/src/test/java/io/netty/util/concurrent/UnorderedThreadPoolEventExecutorTest.java`

## 误解清单

1. 只要不是 EventLoop，就可以随便扔到任何线程池里。
2. `DefaultEventExecutor` 和 `EventLoop` 没区别，只是名字不同。
3. `GlobalEventExecutor` 适合承载大量常驻任务。
4. `NonStickyEventExecutorGroup` 会强行给所有底座恢复全局顺序。
5. `UnorderedThreadPoolEventExecutor` 只是更快的 EventLoop 替代品。
6. `ScheduledFutureTask` 只是 PromiseTask 的别名，对执行器层没有额外意义。

## 边界清单

- 本篇不把这些执行器写成“性能优劣榜”，重点是职责边界与顺序语义。
- 本篇不重讲 Promise/Future 完整状态流，只消费其结论。
- 本篇不把 deprecated 的 `UnorderedThreadPoolEventExecutor` 写成推荐实践。
- 本篇不把 `GlobalEventExecutor` 写成系统级调度中心，它是低频辅助单例。

## 深审预警

- [ ] 不把 EventExecutor 和 EventLoop 混成同一层。
- [ ] 不把 `GlobalEventExecutor` 写成适合高吞吐任务。
- [ ] 不把 `NonStickyEventExecutorGroup` 的顺序保证写成“全局单线程顺序”。
- [ ] 不把 `UnorderedThreadPoolEventExecutor` 的无序特性轻描淡写。