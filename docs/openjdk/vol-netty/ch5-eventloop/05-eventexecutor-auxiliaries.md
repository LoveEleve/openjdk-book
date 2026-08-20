# Ch5-05 EventExecutor 辅助体系：DefaultEventExecutor、GlobalEventExecutor、NonSticky 与 Unordered

## 先把执行体系从“EventLoop vs 线程池”二分法里拆出来

前面写 EventLoop、Promise/Future、WriteTask、timeout handler 的时候，其实已经反复碰到一个边界：并不是所有任务都应该回到 I/O EventLoop 上执行，但也不是所有任务都能随便扔进一个普通线程池就完事。只要任务还想保留 Netty 的一些基本语义——比如 `inEventLoop()`、`Promise` 绑定、`ScheduledFuture`、关闭生命周期、或者某条执行链内部的顺序保证——从 Netty 当前的设计分层看，它就已经不再适合被简单等同为一个纯 `Executor` 层面的普通任务。

这也正是 `EventExecutor` 辅助体系存在的原因。Netty 的执行模型并不是“只有 EventLoop 和线程池”两级，而是至少还夹着一层“非 I/O、但仍然保留 Netty 执行语义”的辅助执行面。

- `DefaultEventExecutor` / `DefaultEventExecutorGroup` 负责给某些 handler 或辅助逻辑提供一条脱离 I/O、但仍然顺序执行的执行面；
- `GlobalEventExecutor` 负责少量全局低频任务和默认 future/termination 之类的辅助语义；
- `NonStickyEventExecutorGroup` 试图在无序底座之上恢复单条执行链的顺序感；
- `UnorderedThreadPoolEventExecutor` 则明确承认“这批任务根本不要求严格顺序”；
- `AbstractScheduledEventExecutor` 和 `ScheduledFutureTask` 把定时任务能力统一铺在这些执行器之下。

所以本篇真正要解决的核心困惑不是“这些类各自干嘛”，而是：**哪些任务必须留在 EventLoop，哪些任务可以脱离 I/O 但仍然需要 Netty 式执行语义，而哪些任务则根本不该再假装自己是强顺序执行链的一部分。**

## `EventExecutor`：它不是普通 Executor，而是“带线程归属与 Promise 语义的执行面”

最先要讲清楚的是，`EventExecutor` 从抽象层面就已经不是普通 `Executor` 了。接口一开始就把自己描述成一种特殊的 `EventExecutorGroup`：除了通用执行能力，还额外提供 `inEventLoop()` 这样的线程归属判断，以及默认的 `newPromise()`、`newSucceededFuture()`、`newFailedFuture()` 之类工厂方法，见 `common/src/main/java/io/netty/util/concurrent/EventExecutor.java:21`。

这说明它真正多出来的，不是“还能 execute 一个 Runnable”这种功能，而是三类额外语义。

第一类是**线程归属语义**。`inEventLoop(Thread)` 和无参 `inEventLoop()` 让调用方能够判断：当前代码是不是跑在这个执行器自己的线程上下文里，见 `common/src/main/java/io/netty/util/concurrent/EventExecutor.java:39`。对于 Netty 来说，这不是可有可无的小工具，而是决定“这个动作能不能直接执行，还是必须封装成任务投递回去”的关键边界。

第二类是**future/promise 绑定语义**。`newPromise()`、`newProgressivePromise()`、`newSucceededFuture()`、`newFailedFuture()` 这些默认方法意味着：只要你选择了某个 `EventExecutor`，对应 future/promise 的完成线程、listener 通知线程以及一些死锁检查语义，就都能和这个执行面绑定起来。

第三类是**调度/挂起语义**。接口甚至还保留了 `isSuspended()`、`trySuspend()` 这类钩子，见 `common/src/main/java/io/netty/util/concurrent/EventExecutor.java:84`。这说明 Netty 从抽象层就已经承认：这些执行器不仅负责“跑任务”，还可能承担更细的生命周期和资源管理语义。

所以第一层心智模型应该这样立：**`EventExecutor` 不是把 `Executor` 换个名字，而是“把任务执行、线程归属、future/promise 工厂和定时/生命周期边界打包在一起的执行面”。**

一旦这层抽象看清，后面就不容易把 `DefaultEventExecutor`、`GlobalEventExecutor` 这些类当成“没什么特别的线程池包装器”。它们其实都是这套执行语义在不同场景下的具体落点。

## `DefaultEventExecutor`：脱离 I/O，但仍保持单线程顺序执行面

如果说 EventLoop 是“带 I/O 驱动的单线程执行面”，那 `DefaultEventExecutor` 更像是“没有 I/O、但仍然保留单线程顺序”的执行面。

它直接继承 `SingleThreadEventExecutor`，实现非常短：`run()` 就是反复 `takeTask()`、`runTask(task)`、`updateLastExecutionTime()`，直到 `confirmShutdown()` 为止，见 `common/src/main/java/io/netty/util/concurrent/DefaultEventExecutor.java:21`。这说明它根本不承担 select、I/O ready 集合或 channel 生命周期管理，而是只做一件事：在自己的单线程上下文里顺序跑任务。

这个定位特别适合那些“不该再占用 I/O EventLoop，但又还想保留强顺序和 Netty future 语义”的场景。比如某个 handler 的业务回调、某段不直接依赖 socket state 的附加逻辑、或者某类必须串行化但不必跑在 I/O 主循环里的计算任务，都更适合落在这样的执行面上，而不是继续和 select/read/write 绑死。

这也是为什么 `DefaultEventExecutorGroup` 的存在非常自然。它继承 `MultithreadEventExecutorGroup`，只是把每个 child executor 具体化成 `DefaultEventExecutor`，见 `common/src/main/java/io/netty/util/concurrent/DefaultEventExecutorGroup.java:21`。所以它提供的不是“多线程 EventLoop”，而是“一组彼此独立的单线程辅助执行面”。

这点一定要和前面 EventLoop 体系区分开：

- EventLoop 的单线程语义，是为了绑定 I/O 与任务；
- `DefaultEventExecutor` 的单线程语义，是为了在不参与 I/O 的情况下，仍然保留顺序执行和 Netty promise/future 上下文。

因此不要把它看成“名字不同的 EventLoop”。最准确的理解是：**它是脱离 I/O 的顺序执行面。**

## 为什么不能把所有非 I/O 任务都直接扔给普通线程池

理解 `DefaultEventExecutor` 的最好方式，不是先看它怎么 run，而是先问：既然它不做 I/O，那我直接用普通线程池不就好了？

这个问题表面上很合理，但忽略了 Netty 运行时里几个非常敏感的边界。

第一，普通线程池没有 `inEventLoop()` 语义。你很难从它那一侧稳定判断“当前是不是这条执行链自己的线程”，于是像 promise 通知、handler 回调、任务重入、某些线程内断言等机制都要自己重建。

第二，普通线程池没有默认的 `Promise` / `Future` 工厂语义。前面写 Promise/Future 时已经反复看到，执行器选择会直接影响 future 绑定和回调通知。如果直接换成普通线程池，Netty 这条 promise 语义链要么断掉，要么需要额外外包一层适配。

第三，普通线程池也没有统一的定时任务承载面。可很多 Netty 辅助逻辑并不是纯 execute，而是还需要 schedule、fixed-rate/fixed-delay，后面 `AbstractScheduledEventExecutor` 就是为这个边界准备的。

所以第二层判断应该是：**“不是 I/O 任务”不等于“应该退化成普通线程池任务”。**只要这批任务还依赖 Netty 的线程归属、future/promise、调度或关闭语义，它们就更适合放在某种 `EventExecutor` 上，而不是直接退回最普通的 JDK 线程池。

这也解释了为什么 `DefaultEventExecutor(Group)` 在大量测试和使用点里会出现在 handler offload、timeout 回调或辅助逻辑场景中。它不是为了替代 EventLoop，而是为了避免非 I/O 任务把 I/O 主线拖重的同时，还能保留 Netty 执行语义。

## `GlobalEventExecutor`：单例、低频、自启动、自停，不适合高吞吐任务

如果 `DefaultEventExecutor` 是“每个场景都可以自己配一条单线程执行面”，那 `GlobalEventExecutor` 则代表另一种完全不同的取舍：只准备一个全局单线程辅助执行器，专门承担少量低频任务和一些全局默认 future 语义。

类注释一开始就把边界写死了：这是一个单线程 singleton `EventExecutor`，没有任务时可以在 quiet period 之后自停；同时它明确提醒——不要往这里塞大量任务，这个执行器不适合高扩展性场景，见 `common/src/main/java/io/netty/util/concurrent/GlobalEventExecutor.java:38`。

它内部最值得注意的不是“有个线程”，而是 quiet period 机制。类里预置了一个 `quietPeriodTask`，并在没有更多真实任务时允许线程在 quiet period 之后停下来，等有新任务再自动启动，见 `common/src/main/java/io/netty/util/concurrent/GlobalEventExecutor.java:47`、`:86`。这说明它的设计目标根本不是稳定承载大量长期任务，而是为那些偶尔发生、但又需要一个全局 `EventExecutor` 的动作提供一个低成本落点。

为什么很多地方会用到它？从全局搜索就能看出来：默认 termination future、某些 channel group、部分 channel pool、一些默认 promise 场景都会把 `GlobalEventExecutor.INSTANCE` 当成兜底执行器。这些用法共同说明，它更像是 Netty 里的**全局低频辅助线程**，而不是一个“哪里都能扔任务”的万能池。

因此这里必须把边界钉硬：

- `GlobalEventExecutor` 适合低频、全局、辅助性的任务或 future 上下文；
- 它经常还承担默认 promise / termination future / 全局兜底执行面的角色；
- 它不适合承载大量常驻业务任务；
- 它的单例和可自停机制本来就是为了“少量任务时也别为它准备一整组常驻线程”。

所以第三层心智模型应该这样立：**`GlobalEventExecutor` 是 Netty 的全局低频辅助执行面，而不是高吞吐线程池。**

## `NonStickyEventExecutorGroup`：在无序底座上恢复单条执行链的顺序感

再往下看，`NonStickyEventExecutorGroup` 是这一组里最容易被名字误导的一个。它看起来像某种“去粘性”的执行器包装，真正的问题却是：**底座本来不保证顺序时，怎么给某条任务链补回顺序感。**

类注释已经把前提写得很死：它包装的 `EventExecutorGroup` 不能包含 `OrderedEventExecutor`，因为它的目的就是在本来无序的底座上，恢复某条逻辑执行链的顺序，而不是再叠一层顺序执行器，见 `common/src/main/java/io/netty/util/concurrent/NonStickyEventExecutorGroup.java:34`。

它的做法也很有代表性。每次 `next()` 并不是直接返回底层 executor，而是返回一个新的 `NonStickyOrderedEventExecutor` 壳，见 `common/src/main/java/io/netty/util/concurrent/NonStickyEventExecutorGroup.java:75`。这个壳内部维护自己的任务队列、状态机和 `maxTaskExecutePerRun`，再把实际执行工作委托给底层 executor，见 `common/src/main/java/io/netty/util/concurrent/NonStickyEventExecutorGroup.java:215`。

也就是说，它恢复的不是“全局所有任务的总顺序”，而是**单条壳对象看到的那条任务链顺序**。底座线程可以变，底座执行器可以换，但只要这条壳自己的队列仍然一条条吐任务，调用者就会观察到一种有序执行感。

这里最容易出错的理解有两个。

第一，不要把它看成“变相单线程”。底座仍然可能是无序线程池，任务也只是通过壳对象人为排队和分批 re-submit，所以恢复的是局部执行链顺序，不是全局串行。

第二，不要把它看成“顺序一定绝对稳定地绑定到某个线程”。类注释已经说了，它不保证由哪个具体 `EventExecutor` 或线程来执行，只保证这条逻辑链的顺序不乱。

所以这一层更像是：**在无序底座上挂一个“顺序视图壳”。**更准确地说，它恢复的是“通过这个包装器进入的那条任务链”的顺序感，而不是底座 executor 上所有任务的全局顺序。对于某些协议或逻辑，只要顺序不能乱，但又不需要真绑定 I/O EventLoop 或单线程执行器，这种模式就很有价值。

## `UnorderedThreadPoolEventExecutor`：显式承认“这批任务不需要顺序”

如果 `NonStickyEventExecutorGroup` 是在无序底座上恢复局部顺序感，那 `UnorderedThreadPoolEventExecutor` 就反过来明确承认：这批任务本来就不需要严格顺序。

类注释说得非常重：这个执行器**不保证任务执行顺序**，因为可能有多个线程同时跑这些任务；而且它已经被标记成 deprecated，原因正是这种行为明显偏离了典型 Netty 执行模型，容易引发微妙问题，见 `common/src/main/java/io/netty/util/concurrent/UnorderedThreadPoolEventExecutor.java:38`。

从实现看，它直接继承 `ScheduledThreadPoolExecutor`，再实现 `EventExecutor` 接口，见 `common/src/main/java/io/netty/util/concurrent/UnorderedThreadPoolEventExecutor.java:51`。这说明它比 `DefaultEventExecutor` 更接近普通线程池，只是在外面补了一层 Netty 的 `EventExecutor` 语义：

- 可以 `newPromise()`；
- 可以 `schedule(...)`；
- 可以 `inEventLoop(thread)`；
- 可以暴露 terminationFuture。

但它没有尝试恢复任何顺序保证。类注释已经强调了，这样的执行器只适合那些协议或任务本来就不要求严格有序的场景。

所以这里一定要把两个边界同时钉死：

- 它不是“更快的 EventLoop”；
- 也不是“推荐的并行化方案”；
- 它只是一个明确告诉你“这里没有 ordering 保证”的 Netty 风格线程池执行面。

也正因为如此，后续如果应用想获得更细粒度的并行处理，Netty 反而建议显式 offload 到自己的线程池，而不是把所有事情都塞进这种无序执行器里。

## `AbstractScheduledEventExecutor` 与 `ScheduledFutureTask`：辅助执行器的定时任务底座

前面几类执行器都在说“谁来执行任务”，但只要涉及 timeout、retry、keepalive 或 quiet period，就还得再回答另一个问题：**这些执行器如何承载定时任务。**

`AbstractScheduledEventExecutor` 正是这条定时语义的底座。它内部维护 `scheduledTaskQueue` 和 `nextTaskId`，并通过 `peekScheduledTask()`、`pollScheduledTask(...)`、`fetchFromScheduledTaskQueue(...)` 这些方法，把到期任务从调度队列转移到真实可执行队列里，见 `common/src/main/java/io/netty/util/concurrent/AbstractScheduledEventExecutor.java:28`。

它最重要的意义不是“有个优先队列”，而是把定时任务语义接进了前面 `EventExecutor` 那条执行面模型里。这样定时任务不再是外部系统附着在执行器旁边的别的东西，而是这个执行器自己内部生命周期的一部分。

而 `ScheduledFutureTask` 则是这套调度底座的实际任务对象。它在 `PromiseTask` 基础上再加了：

- `deadlineNanos`
- `periodNanos`
- `id`
- priority queue index

见 `common/src/main/java/io/netty/util/concurrent/ScheduledFutureTask.java:27`。

最值得注意的地方是 `periodNanos` 的语义：

- `0` 表示一次性任务；
- `> 0` 表示 fixed-rate；
- `< 0` 表示 fixed-delay。

而 `run()` 会根据这些语义决定是一次执行后成功完成，还是重新计算下次 deadline 再次入队，见 `common/src/main/java/io/netty/util/concurrent/ScheduledFutureTask.java:145`。

这说明前面在 Promise/Future 篇章里讲到的定时任务对象，到了这里终于落回了执行器本身的承载面：不是“有一个 ScheduledFutureTask 类”，而是“辅助执行器如何把调度队列、时间推进和 Promise 语义重新拧成一体”。

所以这条线的核心判断应该是：**辅助执行器之所以仍然属于 Netty 执行体系，不只是因为它能跑 Runnable，而是因为它还能用统一的调度队列和 `ScheduledFutureTask` 承载时间语义。**

## 最后收束：哪些任务必须回 EventLoop，哪些可以旁路

讲到这里，最重要的不是记住每个类的构造器，而是把整个执行体系重新放回主线里。

### 必须回 EventLoop 的

- 直接依赖 Channel I/O 状态的逻辑；
- `ChannelOutboundBuffer`、writability、flush 这类强绑定托管区与 I/O 主线的动作；
- 依赖严格 `inEventLoop()` 语义的 Channel 状态修改；
- HTTP/2 连接主链、flow control、child channel 状态这些强协议状态机动作。

这些任务旁路出去，很容易直接破坏顺序和状态一致性。

### 可以脱离 I/O、但仍需要 Netty 执行语义的

- 某些 handler 的辅助任务；
- 某些 promise/listener、timeout、keepalive、quiet period 之类的调度任务；
- 仍希望保留 `inEventLoop()`、`Promise`、`ScheduledFuture`、terminationFuture 等语义的执行链。

这里更适合 `DefaultEventExecutor(Group)`、`GlobalEventExecutor` 或其他 Netty 风格辅助执行器。

### 明确不要求顺序的

- 某些协议或任务本来就不依赖严格执行顺序；
- 或调用方自己已经明白无序执行的后果，并愿意承担这种语义。

这时才轮到 `UnorderedThreadPoolEventExecutor` 这类执行器成立，但它绝不是普通推荐路径。

所以本篇真正要留下来的结论是：**Netty 的执行体系不是“EventLoop 和线程池”二分法，而是一组按线程归属、顺序语义、调度能力和生命周期边界细分出来的执行面。**

有了这层理解，后面再看默认 Promise 绑定到哪个执行器、某个 handler 为什么要 offload 到 `DefaultEventExecutorGroup`、为什么 `GlobalEventExecutor` 只能做低频辅助任务、为什么某些无序执行器被标成 deprecated，就不会再只把它们当成并发包里的零散实现，而会知道：它们共同解决的，是 EventLoop 之外、但仍然要保留 Netty 执行语义的那一片灰色地带。