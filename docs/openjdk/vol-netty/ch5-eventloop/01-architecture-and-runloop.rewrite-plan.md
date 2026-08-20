# Ch5-01 EventLoop 架构与单线程执行 — rewrite-plan

## 篇章定位

- 核心困惑：ByteBuf、Selector、Composite 都已经就位，但到底是谁把“Channel 注册、Selector 等待、读写事件、任务队列”串成一条持续运转的主循环？
- 一句话顿悟：EventLoop 不是“套了线程池皮肤的 Reactor”，而是一个自包含的单线程调度器：它既是执行器、也是自己的单元素 Group；它把 I/O 事件和普通任务放进同一条循环里，并用“只在没有任务时才允许阻塞”的规则维持响应性。
- 篇章边界：重点讲 EventLoop/Group 的自包含关系、`SingleThreadIoEventLoop.run()` 主循环、MPSC 任务队列、tailTasks、异步 register 到 IoHandler；SelectStrategy、selector 优化、epoll bug rebuild、多线程组装留后续篇。

## 依赖

### HARD

- Ch3 Selector：register/select/selectedKeys/wakeup/cancel 基础。
- Ch4 ByteBuf 五篇：EventLoop 驱动的数据载体和生命周期。
- Channel 基础：register 需要回到 EventLoop 线程执行。

### SOFT

- SingleThreadEventExecutor/OrderedEventExecutor：本篇会给最小解释。
- Promise/Future：只用 `register` 返回 Promise 的最小语义，不展开完成通知体系。

### NAV

- Ch5-02：SelectStrategy 与 selectedKeys 优化。
- Ch5-03：epoll bug、premature select returns 与 rebuildSelector。
- Ch5-04：多线程 EventLoopGroup、chooser、特殊 loop。
- Ch6：Promise/Future 作为 EventLoop 异步结果语义。
- Ch7：Pipeline 如何在 EventLoop 线程上被驱动。

## 素材事实卡片

### 卡片 A：自包含 EventLoop

- 大纲中 `EventLoop extends EventLoopGroup` 已过时，当前源码应以 `SingleThreadIoEventLoop.next() -> this` 和 `SingleThreadEventLoop.next() -> (EventLoop) super.next()` 说明单个 loop 的“自包含”效果，而不是强行沿用旧接口层次。
- `SingleThreadIoEventLoop.java:228-230`：`next()` 返回自身。
- `SingleThreadEventLoop.java:101-120`：`register(Channel)` 直接走 `channel.unsafe().register(this, promise)`。
- `NioEventLoop.java:38-45`：当前 `NioEventLoop` 已是 `SingleThreadIoEventLoop + NioIoHandler` 的薄壳，旧术语要标注为架构演进背景。

### 卡片 B：run() 主循环

- `SingleThreadIoEventLoop.java:38-40`：默认 `maxTaskProcessingQuantum` 取系统属性，最小 100ms，默认 1000ms。
- `SingleThreadIoEventLoop.java:43-71`：`IoHandlerContext` 回调：`canBlock/delayNanos/deadlineNanos/reportActiveIoTime/shouldReportActiveIoTime`。
- `SingleThreadIoEventLoop.java:191-205`：`run()` 顺序：`initialize` -> `runIo()` -> 若 shutting down 则 `prepareToDestroy()` -> `runAllTasks(maxQuantum)` -> 直到 `confirmShutdown()` 或 `canSuspend()`。
- `SingleThreadIoEventLoop.java:223-225`：`runIo() = ioHandler.run(context)`。
- `SingleThreadIoEventLoop.java:45-48`：只有 `!hasTasks() && !hasScheduledTasks()` 才允许阻塞。
- 不能沿用旧 `ioRatio` 叙事；当前源码用任务处理时间量子，不是旧版百分比切分。

### 卡片 C：任务队列与 tailTasks

- `SingleThreadEventLoop.java:36-39`：`DEFAULT_MAX_PENDING_TASKS` 与 `tailTasks` 字段。
- `SingleThreadEventLoop.java:137-150`：`executeAfterEventLoopIteration` 入 tailTasks，关闭时拒绝。
- `SingleThreadEventLoop.java:163-170`：`afterRunningAllTasks()` 统一跑 tailTasks；`hasTasks()` 也把 tailTasks 算进去。
- `SingleThreadIoEventLoop.java:289-293`：`newTaskQueue0` 返回 MPSC queue，注释“never calls takeTask()”。
- `SingleThreadEventExecutor.java:222-246`：主 taskQueue 在构造时建立，maxPendingTasks 最低 16。
- 需要强调：EventLoop 不阻塞在任务队列上，而是通过 wakeup 协作让 select/任务共享单线程。

### 卡片 D：异步 register 与 IoRegistrationWrapper

- `SingleThreadIoEventLoop.java:233-242`：外部线程 `register(handle)` 时，若不在 loop 线程就 `execute(() -> registerForIo0(...))`。
- `SingleThreadIoEventLoop.java:250-260`：`registerForIo0`: `ioHandler.register(handle)` -> `numRegistrations.incrementAndGet()` -> Promise success 包装器。
- `SingleThreadIoEventLoop.java:295-323`：`IoRegistrationWrapper.cancel()` 时 `numRegistrations.decrementAndGet()`。
- `SingleThreadIoEventLoop.java:211-215`：`canSuspend` 还要求 `numRegistrations == 0`。
- `NioEventLoop.java:71-109`：注册非 Netty `SelectableChannel` 也要 offload 到 EventLoop，避免底层 register 内部锁阻塞外部线程。

## 理解路径

1. **从 Ch4 的收网问题切入**：ByteBuf 不会自己读 Socket，Selector 也不会自己运行，需要一个长期存在的单线程驱动者。
2. **先解释“EventLoop 不是普通线程池任务槽”**：它既要执行任务，又要执行 I/O，还要维持 Channel 线程亲和性。
3. **再立起自包含结构**：单个 EventLoop 自己就能 register Channel、自己就是调度入口的一部分，不需要业务层关心 Group/Loop 的硬分界。
4. **拆 run() 主循环**：`runIo`、`runAllTasks(maxQuantum)`、shutdown/suspend 检查，解释为什么是交替而不是先后无限偏向某一方。
5. **讲 canBlock 和任务量子**：有任务/定时任务时不要阻塞 select；任务执行也不能无限吞掉 loop。
6. **讲 MPSC 队列与 tailTasks**：为什么用 poll 而不是 take，为什么 tailTasks 要在一轮 event loop 末尾执行。
7. **讲异步 register**：为什么 register 必须落到 EventLoop 线程，如何通过 Promise 和 wrapper 维护注册计数。
8. **收网**：EventLoop 的本质是“单线程 I/O+任务调度器”，下一篇再进入 select 策略与 selectedKeys 优化。

## 失败方案推演

- 直接用 `ThreadPoolExecutor`：任务可以跑，但没有统一的 I/O 等待与 Channel 线程亲和语义。
- run() 只跑 I/O，任务等下一次空闲：外部提交任务的响应变差。
- run() 只要有任务就无限跑任务：I/O 可能长时间饥饿。
- 任务队列用阻塞 `take()`：EventLoop 会被任务队列阻塞，失去与 select 协同的主循环控制权。
- register 允许任意线程直接打到底层 selector：会重新暴露 Ch3 的 register 锁争与时序问题。
- tailTasks 与普通任务混在一起立即执行：无法表达“本轮循环末尾再做”的语义。

## 文章结构与预算

1. EventLoop 到底驱动什么（1000-1300 字）
2. 自包含设计：为什么一个 loop 自己就像一个微型 group（1700-2200 字）
3. run() 主循环：IO 与任务交替（2200-2800 字）
4. canBlock 与任务量子：不让任何一边饿死（1500-1900 字）
5. MPSC 队列与 tailTasks（1700-2200 字）
6. register 异步化与 IoRegistrationWrapper（1700-2200 字）
7. 误解澄清、总图与 Ch5-02 桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9000-10500 字。

## 证据清单

- `SingleThreadIoEventLoop.java:38-40`
- `SingleThreadIoEventLoop.java:43-71`
- `SingleThreadIoEventLoop.java:191-205`
- `SingleThreadIoEventLoop.java:211-215`
- `SingleThreadIoEventLoop.java:223-230`
- `SingleThreadIoEventLoop.java:233-266`
- `SingleThreadIoEventLoop.java:289-323`
- `SingleThreadEventLoop.java:36-39`
- `SingleThreadEventLoop.java:101-120`
- `SingleThreadEventLoop.java:137-170`
- `SingleThreadEventExecutor.java:222-246`
- `NioEventLoop.java:38-45`
- `NioEventLoop.java:71-109`

## 边界清单

- 基于当前 Netty 架构：`SingleThreadIoEventLoop + IoHandler`；不把旧版 `ioRatio`、旧版 `NioEventLoop` 结构写成当前实现事实。
- “EventLoop 自包含”表述以 `next()->this`、`register(this, promise)` 的运行效果为主，不强行依赖旧版接口继承图。
- maxTaskProcessingQuantum 是当前任务量子机制，不是实时硬保证。
- MPSC queue 说明只针对当前 `SingleThreadIoEventLoop` 的非阻塞 poll 设计，不外推所有 Netty executor。
- 本篇不展开 SelectStrategy、SelectedSelectionKeySet、epoll bug rebuild；只做桥接。
- Promise/Future 只用最小成功/失败语义，不提前展开监听器与 cause 传播。

## 深审预警

- [ ] 不沿用大纲里过时的 `EventLoop extends EventLoopGroup` 事实表述，需改成当前实现下的“自包含效果”。
- [ ] 不把 `runAllTasks(maxQuantum)` 写成严格公平调度，只说明当前实现意图与边界。
- [ ] 明确 `canBlock` 同时检查普通任务和定时任务。
- [ ] 明确 tailTasks 在 `afterRunningAllTasks()` 执行，而不是普通队列的一部分。
- [ ] 明确 register 异步化是线程亲和与底层锁争规避，不是为了“看起来异步”。
- [ ] 如发现 EventLoop 当前实现与大纲/旧文章认知不一致，优先修正文案而非强套旧结构。
