# Ch5-05 EventExecutor 辅助体系：DefaultEventExecutor、GlobalEventExecutor、NonSticky 与 Unordered — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `EventExecutor` 当前不仅继承 `EventExecutorGroup`，还提供 `inEventLoop()`、`newPromise()`、`newSucceededFuture()` 等线程归属与 future 工厂语义，证据：`common/src/main/java/io/netty/util/concurrent/EventExecutor.java:21`。  
2. `DefaultEventExecutor` 当前基于 `SingleThreadEventExecutor`，其 `run()` 就是顺序消费任务队列直到 shutdown，证据：`common/src/main/java/io/netty/util/concurrent/DefaultEventExecutor.java:21`。  
3. `DefaultEventExecutorGroup` 当前只是批量创建 `DefaultEventExecutor` child，并不参与 I/O select 主循环，证据：`common/src/main/java/io/netty/util/concurrent/DefaultEventExecutorGroup.java:21`。  
4. `GlobalEventExecutor` 当前是单线程 singleton、带 quiet period、自启动自停，并明确不适合大量任务，证据：`common/src/main/java/io/netty/util/concurrent/GlobalEventExecutor.java:38`。  
5. `GlobalEventExecutor` 当前通过 `quietPeriodTask` 与 `takeTask()/fetchFromScheduledTaskQueue()` 协调普通任务和调度任务，证据：`common/src/main/java/io/netty/util/concurrent/GlobalEventExecutor.java:61`、`:101`。  
6. `NonStickyEventExecutorGroup` 当前要求底座 group 不能包含 `OrderedEventExecutor`，因为它要在无序底座上恢复单条执行链的顺序感，证据：`common/src/main/java/io/netty/util/concurrent/NonStickyEventExecutorGroup.java:34`。  
7. `NonStickyEventExecutorGroup.next()` 当前返回的是 `NonStickyOrderedEventExecutor` 壳，而不是底座 executor 本体，证据：`common/src/main/java/io/netty/util/concurrent/NonStickyEventExecutorGroup.java:75`。  
8. `NonStickyOrderedEventExecutor` 当前通过本地任务队列、state 和 `maxTaskExecutePerRun` 分批 re-submit 到底座 executor，证据：`common/src/main/java/io/netty/util/concurrent/NonStickyEventExecutorGroup.java:215`。  
9. `UnorderedThreadPoolEventExecutor` 当前明确不保证 ordering，且已被标记为 deprecated，证据：`common/src/main/java/io/netty/util/concurrent/UnorderedThreadPoolEventExecutor.java:38`。  
10. 它本质上是 `ScheduledThreadPoolExecutor` + `EventExecutor` 语义包装，而非 EventLoop 替代品，证据：`common/src/main/java/io/netty/util/concurrent/UnorderedThreadPoolEventExecutor.java:51`。  
11. `AbstractScheduledEventExecutor` 当前维护 `scheduledTaskQueue` 并统一承载 schedule / fixed-rate / fixed-delay 调度语义，证据：`common/src/main/java/io/netty/util/concurrent/AbstractScheduledEventExecutor.java:28`。  
12. `ScheduledFutureTask` 当前用 `deadlineNanos`、`periodNanos` 和 `id` 表达一次性 / fixed-rate / fixed-delay 任务语义，证据：`common/src/main/java/io/netty/util/concurrent/ScheduledFutureTask.java:27`。  
13. `GlobalEventExecutorTest`、`NonStickyEventExecutorGroupTest`、`UnorderedThreadPoolEventExecutorTest` 等测试路径与使用点，证明这些执行器不是抽象摆设，而是贯穿 channel group、pool、promise、transport 的真实执行面，证据：本地搜索结果。

### 深审发现

1. **高风险：容易把 EventExecutor 和 EventLoop 混成一层。** 正文已明确 EventLoop 是 I/O + 任务主线，辅助执行器是非 I/O 但仍保留 Netty 语义的执行面。  
2. **中风险：容易把 `GlobalEventExecutor` 写成高吞吐任务执行器。** 正文已限定为全局低频辅助单例。  
3. **中风险：容易把 `NonStickyEventExecutorGroup` 的顺序保证写成“全局单线程顺序”。** 正文已改成“单条壳对象上的顺序视图”。  
4. **中风险：容易轻描淡写 `UnorderedThreadPoolEventExecutor` 的无序语义。** 正文已保留 deprecated 和不推荐语义。  
5. **低风险：容易把 `ScheduledFutureTask` 当成 PromiseTask 别名。** 正文已把它放回执行器调度承载面。

## 第二轮：因果审

- 不是所有任务都该回 EventLoop，但很多任务又仍需要 Netty 的线程归属 / future / schedule 语义：✅  
- `DefaultEventExecutor` 提供脱离 I/O 的顺序执行面：✅  
- `GlobalEventExecutor` 提供低频全局辅助执行面：✅  
- `NonStickyEventExecutorGroup` 在无序底座上恢复单条逻辑链顺序：✅  
- `UnorderedThreadPoolEventExecutor` 明确承认某些任务不要求顺序：✅  
- `AbstractScheduledEventExecutor` / `ScheduledFutureTask` 把调度语义统一挂到这些执行器之下：✅

## 第三轮：结构审

正文结构按“拆掉 EventLoop vs 线程池二分法 -> EventExecutor 抽象 -> DefaultEventExecutor(Group) -> GlobalEventExecutor -> NonSticky -> Unordered -> Scheduled 底座 -> 收网”推进，没有按源码文件顺序平铺。✅

失败/误解已覆盖：
- 非 I/O 任务都随便丢普通线程池  
- DefaultEventExecutor 和 EventLoop 没区别  
- GlobalEventExecutor 适合高吞吐常驻任务  
- NonSticky 会恢复全局顺序  
- Unordered 是更快 EventLoop 替代品  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- EventExecutor 是带线程归属与 future/schedule 语义的执行面  
- Default/Global/NonSticky/Unordered 各自补哪一层灰色地带  
- 哪些任务必须回 EventLoop，哪些任务可以旁路  
- 调度任务如何统一落在 AbstractScheduledEventExecutor / ScheduledFutureTask 上  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把这些执行器写成性能优劣榜。✅  
- 未重讲 Promise/Future 完整状态模型。✅  
- 未把 deprecated 的无序执行器写成推荐实践。✅  
- 未把 GlobalEventExecutor 写成系统级调度中心。✅

## 第六轮：依赖审

- 依赖 Ch5、Ch6、Ch7、Ch13 前置，真实存在。✅  
- 相关测试和使用点搜索已确认这些执行器的真实落点。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 9,372。  
- 去掉常见 markdown 标记后的字符数：约 9,030。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立 EventExecutor 辅助体系的层级：脱离 I/O 的顺序执行面、低频全局辅助面、在无序底座上恢复局部顺序、以及显式无序执行面。本篇不承担平台 I/O executor（epoll / io_uring）语义，它们留给后续平台专题。Ch5-05 可作为后续平台专题和更具体 offload / 调度误用案例的前置篇。