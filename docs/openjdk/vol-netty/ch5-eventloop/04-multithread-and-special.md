# 多线程与特殊 EventLoop：当一个 loop 不再够用时，Netty 怎么扩展

> 本文基于当前 Netty `MultithreadEventLoopGroup`、`DefaultEventLoop`、`ManualIoEventLoop`、`ThreadPerChannelEventLoopGroup` 和 chooser 实现。前置：Ch5-01 到 Ch5-03；本文解释多线程 group 如何组织多个单线程 loop、如何选择 child，以及几种特殊 loop 为什么存在，不展开 Promise/Future 内部细节。

## 单个 EventLoop 已经能跑，为什么还要再造一层 group

第 5 章前三篇已经把单线程 EventLoop 的骨架讲透了：

- 它在一条线程里交替推进 I/O 和任务。
- 它用 `SelectStrategy` 决定这一轮该不该阻塞。
- 它用 wakeup 协议、计数和 rebuild 处理 selector 的生产级故障。

到这里，一个自然问题会冒出来：既然单个 EventLoop 已经足够完整，为什么 Netty 还需要 `EventLoopGroup`？

答案不是“为了更面向对象”，而是非常现实：

```text
单个 EventLoop 保证了局部状态简单
但它也把同一条线程变成了吞吐上限
```

如果一个服务端同时维护大量连接，或者某些连接上的任务比其他连接重得多，把所有 Channel 都压在同一个 loop 上，很快就会遇到两种问题：

1. 单线程再怎么没有锁，吞吐也有天花板。
2. 一个热点 Channel 的 I/O 或任务，会拖慢同 loop 上其他 Channel 的推进。

于是 Netty 的扩展方向不是把单个 EventLoop 改成多线程并发执行——那会直接破坏前面几篇建立的线程亲和模型——而是把“一个完整的单线程 loop”复制成多个兄弟节点，再在外层加一层 group 负责选择和管理。

这和普通线程池又不一样。线程池面对的是“任务怎么分发给线程”；EventLoopGroup 面对的是：

```text
Channel 应该归哪个 loop 管
这个归属建立后通常不再迁移
每个 loop 仍保持自己那套单线程 I/O+任务主循环
```

所以第 5 章第四篇的主线，不是“Netty 怎么造线程池”，而是：当“单线程 loop 的局部确定性”要扩展到多个线程时，它是怎样保留单个 loop 的模型，同时在外层增加分配和特殊变体的。

## 一、多线程 group 不是把一个 loop 拆开，而是把多个 loop 编成一组

### 1. `MultithreadEventLoopGroup` 的默认线程数只是默认策略

当前 `MultithreadEventLoopGroup` 定义了一个默认线程数：

```text
DEFAULT_EVENT_LOOP_THREADS = max(1, io.netty.eventLoopThreads or availableProcessors() * 2)
```

源码见 `MultithreadEventLoopGroup.java:37-45`。如果构造时传入 `nThreads == 0`，就使用这个默认值，见 `MultithreadEventLoopGroup.java:51-69`。

这里最容易被写成口号的是“CPU*2 为什么正确”。当前源码能证明的事实只有：这是当前默认值，不是放之四海而皆准的最优线程数。它表达的是一种偏好：EventLoop 线程有一部分时间会在 select 等待、任务间切换或等待外部条件，因此默认线程数可以高于 CPU 核数，而不必死守“一核一线程”。

但不能把它写成性能定理：

- 有的负载 I/O 等待多，CPU*2 可能合理。
- 有的负载任务偏重，过多 EventLoop 线程会增加调度开销。
- 用户完全可以通过 `io.netty.eventLoopThreads` 覆盖默认值。

所以这一节最该留下的判断是：

```text
CPU*2 是当前 Netty 的默认起点
不是所有业务的最优终点
```

### 2. group 的工作不是亲自跑 I/O，而是创建 child 并把注册委托给 child

`MultithreadEventExecutorGroup` 在构造时先创建 `children` 数组，再逐个调用 `newChild(executor, args)` 生成子执行器，最后构造 chooser，见 `MultithreadEventExecutorGroup.java:83-129`。

`MultithreadEventLoopGroup` 在这之上只增加了 EventLoop 语义：

- `next()` 返回下一个 `EventLoop`，见 `MultithreadEventLoopGroup.java:77-79`。
- `register(channel/promise)` 直接委托给 `next().register(...)`，见 `MultithreadEventLoopGroup.java:84-98`。

因此 group 自己不直接 select、不直接 read/write，也不自己消费 selected keys。它做的事情更像：

```text
启动时创建多个单线程 loop
运行时为新 Channel 选择一个 loop
之后把 register 和后续生命周期交给那个 loop
```

这点非常重要，因为它决定了多线程扩展的边界：group 负责“分配归属”，单个 loop 继续负责“真正执行”。

### 3. 默认线程工厂用的是 `Thread.MAX_PRIORITY`

当前 `MultithreadEventLoopGroup.newDefaultThreadFactory()` 返回 `DefaultThreadFactory(getClass(), Thread.MAX_PRIORITY)`，见 `MultithreadEventLoopGroup.java:71-74`。

这是真实源码事实，但也要保持克制：它说明 Netty 当前默认线程工厂会给 EventLoop 线程较高优先级，不等于操作系统一定按这个优先级严格调度，更不等于“优先级高就一定更快”。不同平台、不同容器环境和不同调度器对 Java 线程优先级的实现差异都很大。

所以正文里应把它当作“当前默认实现选择”，而不是性能承诺。

## 二、chooser：给新 Channel 选哪个 child

### 1. `next()` 的关键不在随机，而在便宜且稳定

当 group 里有多个 child，新的 Channel 必须先选定归属。当前实现把这个动作集中到 chooser：`MultithreadEventExecutorGroup.next()` 直接委托 `chooser.next()`，见 `MultithreadEventExecutorGroup.java:136-139`。

选择器工厂的逻辑很简单：如果 child 数组长度是 2 的幂，就用 `PowerOfTwoEventExecutorChooser`；否则用 `GenericEventExecutorChooser`，见 `DefaultEventExecutorChooserFactory.java:30-40`。

这背后的优化意图不是“我要更随机”，而是：

```text
轮询分配足够好
在最常见的 2 的幂 child 数量下
我还能把取模换成更轻的位运算
```

### 2. 为什么 2 的幂路径走位与，而不是 `%`

`PowerOfTwoEventExecutorChooser.next()` 的实现是：

```text
executors[idx.getAndIncrement() & executors.length - 1]
```

见 `DefaultEventExecutorChooserFactory.java:43-54`。

只要 `executors.length` 是 2 的幂，`idx & (length - 1)` 就等价于 `% length`，但走的是更轻的位运算路径。它没有改变轮询语义，只改变索引计算的成本。

这里要注意两个边界：

1. 不能把它写成“总是快很多倍”。当前源码能证明的是它避开了取模路径，而不是给出固定周期数字。
2. 表达式里用的是 `length - 1`，因为掩码必须是低位全 1；如果写成取反，语义就错了。

这类优化在单次调用上看起来很小，但 `next()` 是高频入口：每个新注册 Channel、某些组级分发动作都会走这条路径。Netty 选择在“最常见且容易判定的结构条件”下做低成本优化，而不是把 chooser 设计成复杂负载均衡器。

### 3. 非 2 的幂路径为什么改用 `AtomicLong`

如果 child 数量不是 2 的幂，就退回 `GenericEventExecutorChooser`，实现为：

```text
executors[(int) Math.abs(idx.getAndIncrement() % executors.length)]
```

见 `DefaultEventExecutorChooserFactory.java:57-71`。

这里使用 `AtomicLong` 而不是 `AtomicInteger` 的原因，源码注释写得很清楚：避免 32 位计数器溢出边界附近出现不圆滑的轮询行为，把这个边界推到几乎不可能在现实中遇到的远处。

这又体现了 Netty 在细节上的偏好：

- 常见情况（2 的幂）走更轻的位运算。
- 兜底情况保留标准取模，但把溢出边界处理得更平滑。

chooser 的核心因此不是“复杂智能”，而是“简单轮询 + 实现层的小心思”。

## 三、`DefaultEventLoop`：没有 Selector 的纯任务 loop

### 1. 它不是 NIO loop 的弱化版，而是另一种用途

`DefaultEventLoop` 继承 `SingleThreadEventLoop`，但它的 `run()` 根本没有 I/O 阶段。当前实现是一个非常朴素的循环：

```text
for (;;) {
    task = takeTask()
    if (task != null) runTask(task)
    if (confirmShutdown()) break
}
```

见 `DefaultEventLoop.java:49-62`。

这和大纲里“纯 task 循环、没有 selector”是一致的，但有一个重要纠正：当前实现用的是 `takeTask()`，不是“非阻塞 poll”。这说明它可以把自己阻塞在任务队列上，因为它根本没有要并行维护的 I/O select 阶段。

也就是说：

```text
Nio/IoEventLoop
  -> 阻塞点要和 select 协调

DefaultEventLoop
  -> 没有 select，阻塞在 takeTask 完全合理
```

这再次说明 EventLoop 不是单一类型的小变种，而是一组围绕约束变化分化出来的调度模型。

### 2. 什么时候需要 DefaultEventLoop

只要某条执行链不需要 Selector 驱动 I/O，但仍想保留 Netty 的单线程事件执行语义，DefaultEventLoop 就是候选。

它适合的不是“网络 I/O 比较少”的场景，而是“不需要这个 loop 自己持有 I/O 等待职责”的场景。例如某些纯任务 handler、进程内通信或拆分出来的 CPU 工作流，都更接近这种模型。

如果把 DefaultEventLoop 错当成“更轻的 NioEventLoop”，会立刻犯两个错：

- 以为它也会处理 Selector 事件。
- 以为它在等待任务时还要随时响应网络 I/O。

这两件事在当前实现里都不成立。

## 四、`ManualIoEventLoop`：线程归用户所有，推进节奏也归用户所有

### 1. 这是完全不同的 ownership 模型

`ManualIoEventLoop` 的类注释开门见山：这个 `IoEventLoop` 由用户持有线程，因此也必须由用户手动驱动，调用 `runNow()`、`run(long)` 或 `waitAndRun()` 执行 I/O 和任务，见 `ManualIoEventLoop.java:41-49`。

这和前面的 `SingleThreadIoEventLoop` 差别非常大。

普通 EventLoop 的线程是 Netty 自己创建和驱动的；ManualIoEventLoop 则把线程所有权交给外部。线程可以在合适时机主动进入 EventLoop 的一次运行，然后再返回做别的工作。

所以它不是“测试桩版 NioEventLoop”，而是一种 ownership 反转：

```text
普通 loop：框架拥有线程，用户提交工作
Manual loop：用户拥有线程，框架提供 I/O+任务推进原语
```

### 2. 为什么它的 `nonBlockingContext.canBlock()` 永远返回 false

`ManualIoEventLoop` 内部同时准备了 non-blocking 和 blocking 两种上下文。其中 `nonBlockingContext.canBlock()` 明确返回 false，见 `ManualIoEventLoop.java:62-80`。

这和它的设计目标一致：当用户明确调用“立即跑一轮”时，框架不该擅自把线程长时间睡进 I/O 等待。用户拥有线程，就意味着用户也拥有“我现在愿不愿意让这条线程阻塞”的决定权。

默认的 `canBlock()` 方法返回 true，见 `ManualIoEventLoop.java:97-99`，但真正是否阻塞，仍要结合使用的上下文和调用入口。

### 3. 它的 `run(...)` 更像“一次推进”，不是“线程自旋主循环”

`ManualIoEventLoop.run(context, timeout)` 的主线是：首次调用时 lazy initialize handler；之后如果未 shutdown，就执行一次 `handler.run(context)`，再按传入 timeout 运行任务，见 `ManualIoEventLoop.java:215-242`。

这不是像 `SingleThreadIoEventLoop.run()` 那样自己包着一个 `do { ... } while (...)` 主循环，而更像：

```text
用户调用一次
  -> EventLoop 推进一轮 I/O
  -> 再跑一段任务
  -> 把控制权还给用户线程
```

这使它非常适合测试和高级集成场景：你可以精确控制“什么时候推进一轮”“推进完之后检查什么状态”，而不是被后台线程自动推进。

## 五、`ThreadPerChannelEventLoopGroup`：把“一个 group 管很多 channel”推到另一极端

### 1. 这不是普通的轮询 group

`ThreadPerChannelEventLoopGroup` 的类注释写得很直接：每个 Channel 一个 EventLoop，且当前类已标记 deprecated，见 `ThreadPerChannelEventLoopGroup.java:43-49`。

它内部维护两套集合：

- `activeChildren`：当前已经分配给活跃 Channel 的 EventLoop。
- `idleChildren`：当前空闲、可复用的 EventLoop。

见 `ThreadPerChannelEventLoopGroup.java:51-56`。

这里最重要的事实是：它的 `next()` 直接抛 `UnsupportedOperationException`，见 `ThreadPerChannelEventLoopGroup.java:151-153`。这说明它根本不是“下一轮轮询挑一个 child”的普通 group。

### 2. 真正的入口是 `nextChild()`

当调用 `register(channel)` 时，当前实现会进入 `nextChild()`：

- 如果 group 正在关闭，拒绝。
- 先从 `idleChildren` 取一个 loop。
- 没有空闲 loop 时，如果超过 `maxChannels`，直接抛错。
- 否则新建一个 child，并加入 `activeChildren`。

源码见 `ThreadPerChannelEventLoopGroup.java:271-320`。

可以把它理解成：

```text
这不是“从固定线程池里轮询拿一个”
而是“优先复用空闲 loop，不够再租一个新 loop”
```

这和普通 multithread group 的哲学完全不同。后者默认 child 数量固定，Channel 只是选择归属；前者 child 数量与 Channel 数量强相关，EventLoop 更像是按连接生命周期租用的执行单元。

### 3. 为什么它现在更像特殊/过渡模型

一连接一 loop 的好处很直观：线程隔离最强，不需要在多个 Channel 之间共享 loop 的调度预算。

代价也同样直观：

- 线程数量可能随连接数增长。
- 调度和内存成本上升。
- 与 Netty 后续主流“少量 EventLoop 管大量连接”的设计方向不一致。

这也是为什么当前类已经被标记 deprecated。它仍然能帮助我们理解 EventLoop 模型的另一极端：如果把“单线程亲和性”推到每连接一个线程，会得到怎样的组装方式和代价。

## 六、`NioEventLoop` 变成 deprecated 薄壳，说明架构中心已经转移

前几篇已经反复提到：当前 `NioEventLoop` 本身已是 deprecated 薄壳，见 `NioEventLoop.java:38-45`。

这件事放到多线程组和特殊 loop 这一篇里看，意义会更清楚：EventLoop 的真正中心已经从“某个具体 NIO 类”转移到了“单线程调度骨架 + IoHandler 后端”。

也就是说，Netty 当前想强调的是：

```text
EventLoop
  -> 负责单线程调度模型
IoHandler
  -> 负责具体 I/O 后端
Group/Chooser
  -> 负责多线程编组与分配
```

这让 NIO、epoll、kqueue、manual、default 等不同模型可以共享更多骨架，而不是每个都从零实现一套 run loop。

## 七、最容易错的五个判断

### 1. CPU*2 就是 EventLoop 线程数的正确答案

不成立。它只是当前默认值。实际最佳线程数取决于 I/O 等待比例、任务负载、部署环境和是否需要更强隔离。

### 2. power-of-two chooser 总是快很多

不应这样写。当前源码能证明它避开了取模路径；至于快多少，要靠具体 benchmark，而不是靠直觉许诺。

### 3. DefaultEventLoop 是不带优化的 NioEventLoop

不成立。它根本没有 Selector，也没有 runIo；当前 `run()` 就是纯任务循环。

### 4. ManualIoEventLoop 只是测试桩

不完整。它确实很适合测试，但核心差异是线程 ownership 在用户手里，这是一种不同的调度约束，不只是“功能少一点”。

### 5. ThreadPerChannelEventLoopGroup 也是通过 `next()` 轮询 child

不成立。当前类的 `next()` 直接不支持，实际依赖 `nextChild()` 从 idle/active 双池里取或建 loop。

## 收网：多线程 group 解决分摊，特殊 loop 解决约束变化

现在可以把第 5 章最后一篇压成一张图：

```text
单个 EventLoop
  -> 一条线程里维护 I/O + 任务 + 线程亲和

MultithreadEventLoopGroup
  -> 创建多个这样的 child
  -> chooser 决定新 Channel 归属到哪个 child

DefaultEventLoop
  -> 不做 I/O，只做纯任务单线程执行

ManualIoEventLoop
  -> I/O 仍存在，但推进节奏由用户线程掌握

ThreadPerChannelEventLoopGroup
  -> 把“单线程亲和”推到每连接一个 loop 的极端
```

因此多线程章节最重要的结论不是“Netty 有很多 EventLoop 类型”，而是：

```text
Netty 没有放弃单线程 loop 模型
它是在外层增加编组和分配，在边缘引入特殊 loop
来适应不同的线程 ownership 与 I/O 约束
```

到这里，第 5 章已经把“谁来驱动数据流”讲完整了：

- 单个 EventLoop 如何驱动 I/O 与任务。
- select 阶段如何决定等待与优化结果集。
- selector 出故障时如何识别与恢复。
- 多个 loop 怎样编组，以及为什么还会存在非标准 loop。

下一章进入 Promise/Future。因为 EventLoop 的所有关键动作——register、bind、connect、write、flush——都不是同步返回结果，而是把结果放进异步完成链里。前面这些 loop 决定了“什么时候做”，下一章要回答的就是“做完以后，结果怎么传回来”。