# Ch5-04 多线程与特殊 EventLoop — rewrite-plan

## 篇章定位

- 核心困惑：单个 EventLoop 已经能跑通 I/O 和任务，但真实服务不会只有一个线程。多个 EventLoop 怎么组成 group、怎么给新 Channel 选 loop、为什么默认线程数是 CPU*2？另外，既然有 NIO loop，为什么还需要 `DefaultEventLoop`、`ManualIoEventLoop`、`ThreadPerChannelEventLoopGroup` 这些看起来很“偏门”的模型？
- 一句话顿悟：多线程 EventLoopGroup 不是“把一个 EventLoop 复制 N 份”那么简单，它同时要解决线程数默认值、轮询分配、子 loop 创建与生命周期管理；而特殊 loop 则是在“不需要 Selector”“线程归用户所有”或“一连接一线程”这些非常不同的约束下，把同一套 EventLoop 抽象拉到不同极端。
- 篇章边界：讲 `MultithreadEventLoopGroup`、chooser、`DefaultEventLoop`、`ManualIoEventLoop`、`ThreadPerChannelEventLoopGroup`，以及当前 `NioEventLoop` 的 deprecated 薄壳地位；不展开 Promise/Future 内部细节，后续留 Ch6。

## 依赖

### HARD

- Ch5-01：单线程 EventLoop、自包含效果、run 主循环、register 线程亲和。
- Ch5-02：select 阶段策略和 selectedKeys 优化，作为 NIO 单 loop 背景。
- Ch5-03：selector rebuild 只影响单个 loop，作为多线程隔离前置。

### SOFT

- 线程池与 Reactor 差异：正文会内嵌最小解释。
- Promise/Future：只解释异步 register 返回值的最小语义。

### NAV

- Ch6：Promise/Future 为什么成为 EventLoop 异步 API 的统一结果类型。
- Pipeline/Bootstrap 后续：为什么某些 handler 会选择 DefaultEventLoop 等特殊 loop。

## 素材事实卡片

### 卡片 A：MultithreadEventLoopGroup 与默认线程数

- `MultithreadEventLoopGroup.java:37-45`：`DEFAULT_EVENT_LOOP_THREADS = max(1, io.netty.eventLoopThreads or availableProcessors()*2)`。
- `MultithreadEventLoopGroup.java:51-69`：`nThreads==0` 时采用默认值。
- `MultithreadEventLoopGroup.java:71-74`：默认 thread factory 使用 `Thread.MAX_PRIORITY`。
- `MultithreadEventLoopGroup.java:82-98`：group 的 register 直接委托 `next().register(...)`。
- 不能把 CPU*2 写成性能定理，只能写成当前默认值及其设计意图。

### 卡片 B：chooser 与分配

- `MultithreadEventExecutorGroup.java:83-129`：children 数组创建、chooser 构建、termination listener。
- `MultithreadEventExecutorGroup.java:136-151`：`next()` 委托 chooser；`executorCount()` 返回子执行器数量。
- `DefaultEventExecutorChooserFactory.java:30-40`：判断是否 2 的幂。
- `DefaultEventExecutorChooserFactory.java:43-54`：power-of-two chooser 用 `idx.getAndIncrement() & executors.length - 1`。
- `DefaultEventExecutorChooserFactory.java:57-71`：generic chooser 用 `AtomicLong` + `% executors.length`，注释说明避免 32 位溢出边界问题。
- 不给出未经实测的“快多少周期”数字，只说明它避免了取模路径。

### 卡片 C：特殊 loop

- `DefaultEventLoop.java:23-63`：继承 `SingleThreadEventLoop`；`run()` 用 `takeTask()` 执行纯任务循环，没有 I/O 处理。
- 这与大纲“非阻塞 poll”不同，正文需按当前源码纠正。
- `ManualIoEventLoop.java:41-49`：用户拥有线程，需要手动调用 `runNow()/run(long)/waitAndRun()`。
- `ManualIoEventLoop.java:50-61`：内部状态机常量、MPSC taskQueue。
- `ManualIoEventLoop.java:62-80`：`nonBlockingContext.canBlock() = false`。
- `ManualIoEventLoop.java:215-242`：`run(context, timeout)` 先 lazy initialize，再 `handler.run(context)` + `runAllTasks(...)`。
- `ManualIoEventLoop.java:97-99`：默认 `canBlock()` 为 true，但是否阻塞由调用路径上下文决定。

### 卡片 D：ThreadPerChannelEventLoopGroup

- `ThreadPerChannelEventLoopGroup.java:43-56`：一连接一 EventLoop，`activeChildren` + `idleChildren`。
- `ThreadPerChannelEventLoopGroup.java:271-320`：register 时走 `nextChild()`；先从 idleChildren 取，没有则新建；达到 maxChannels 抛错。
- `ThreadPerChannelEventLoopGroup.java:151-153`：`next()` 不支持。
- 这不是普通轮询 group，而是按 channel 需求租用/回收 loop 的模型。

### 卡片 E：当前 NioEventLoop 的地位

- `NioEventLoop.java:38-45`：当前类已 deprecated，推荐 `SingleThreadIoEventLoop + NioIoHandler`。
- 这是架构演进的证据：调度骨架与 IO 实现解耦。

## 理解路径

1. **从“单个 loop 已跑通，为何还需要 group”切入**：服务端需要多个单线程 loop 分担 channel，而不是把一个 loop 做大。
2. **先讲默认线程数只是默认策略**：CPU*2 来自当前实现，而不是绝对定律；nThreads=0 才启用默认值。
3. **再讲 chooser**：group.next() 怎样从多个 child 中选一个，为什么 power-of-two 能更便宜，为什么 generic chooser 用 long。
4. **然后立特殊模型对照**：DefaultEventLoop（纯任务）、ManualIoEventLoop（用户持有线程）、ThreadPerChannelEventLoopGroup（一连接一 loop），分别说明它们解决的是哪个约束变化。
5. **收 NioEventLoop 的 deprecated 薄壳**：说明新架构是 EventLoop 调度骨架 + IoHandler 插件化后端。
6. **收网**：多线程 group 解决分摊和隔离，特殊 loop 解决约束变化；下一章 Promise/Future 解释异步结果为何能串起来。

## 失败方案推演

- 所有 Channel 共用一个 EventLoop：线程安全简单，但单线程 I/O 与任务负载会成为瓶颈。
- 给每个连接都无条件创建线程：隔离强，但线程数量和调度成本失控。
- chooser 永远取模：正确但在 2 的幂场景下放弃了更轻的索引路径。
- 把 DefaultEventLoop 当成 NioEventLoop 的弱化版：忽略了它根本没有 Selector。
- 把 ManualIoEventLoop 当成“少功能测试桩”：忽略了它表达的是“线程归用户控制”的不同 ownership 模型。
- 把 ThreadPerChannelEventLoopGroup 讲成普通 `next()` 轮询 group：会误解 active/idle 双池和 `next()` 不支持的事实。

## 文章结构与预算

1. 为什么单个 EventLoop 不够（1000-1300 字）
2. 多线程 group：默认线程数与 child 生命周期（1800-2300 字）
3. chooser：power-of-two 与 generic 两条分配路径（1600-2100 字）
4. DefaultEventLoop：没有 Selector 的纯任务 loop（1200-1600 字）
5. ManualIoEventLoop：线程归用户所有（1700-2200 字）
6. ThreadPerChannelEventLoopGroup：一连接一 loop 的极端模型（1600-2100 字）
7. NioEventLoop 薄壳化与架构演进（1000-1400 字）
8. 误解澄清与 Ch6 桥接（900-1200 字）

目标：删掉代码后的叙述性正文 9500-11000 字。

## 证据清单

- `MultithreadEventLoopGroup.java:37-98`
- `MultithreadEventExecutorGroup.java:83-151`
- `DefaultEventExecutorChooserFactory.java:30-71`
- `DefaultEventLoop.java:23-63`
- `ManualIoEventLoop.java:41-99`
- `ManualIoEventLoop.java:215-242`
- `ThreadPerChannelEventLoopGroup.java:43-56`
- `ThreadPerChannelEventLoopGroup.java:151-153`
- `ThreadPerChannelEventLoopGroup.java:271-320`
- `NioEventLoop.java:38-45`

## 边界清单

- CPU*2 是当前默认值，不等于所有负载下的最优线程数。
- `Thread.MAX_PRIORITY` 是默认 thread factory 的当前实现，不外推到所有平台调度效果。
- chooser 的位运算优势只按实现路径解释，不给出未经证据支撑的周期数字。
- DefaultEventLoop 当前用 `takeTask()`，不能沿用旧大纲里的“非阻塞 poll”说法。
- ManualIoEventLoop 是线程 ownership 不同，不是“缩减版 NioEventLoop”。
- ThreadPerChannelEventLoopGroup 当前已 deprecated，正文要交代其实验/特殊用途边界。
- `NioEventLoop` deprecated 代表架构演进，不等于 NIO 不再可用；真正的 I/O 逻辑在 `NioIoHandler`。

## 深审预警

- [ ] 修正旧大纲里关于 `EventLoop extends EventLoopGroup`、`takeTask/poll`、`CPU*2 推导` 的旧认知。
- [ ] 不把 power-of-two chooser 写成“总是更快很多”，只说明避免了取模路径。
- [ ] 不把 ThreadPerChannelEventLoopGroup 讲成普通 next() 轮询 group。
- [ ] 明确 DefaultEventLoop 没有 Selector，也没有 runIo。 
- [ ] 明确 ManualIoEventLoop 的 run 是由用户驱动，而非内部线程自动 loop。
- [ ] 保留对当前 deprecated 类的版本边界说明。
