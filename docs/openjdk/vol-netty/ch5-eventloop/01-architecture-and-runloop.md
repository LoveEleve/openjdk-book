# EventLoop 的本质：谁在单线程里把 I/O 和任务拴在一起

> 本文基于当前 Netty `SingleThreadIoEventLoop` / `SingleThreadEventLoop` / `NioEventLoop` 实现。前置：Ch3 Selector 三篇、Ch4 ByteBuf 五篇；本文只讲 EventLoop 的自包含结构、单线程主循环、任务队列、tailTasks 和异步 register，不展开 SelectStrategy、selectedKeys 优化、epoll bug rebuild 和多线程 chooser。

## ByteBuf、Selector、Channel 都有了，但它们不会自己动起来

第 4 章已经把 Netty 的内存模型铺满了：ByteBuf 负责读写进度、容量和生命周期；视图和 Composite 让一份数据可以被切片、拼接、延迟复制。

第 3 章也已经把 JDK NIO 的等待模型讲透了：Selector 负责统一等 I/O 条件，Channel 负责实际 read/write，selectedKeys 是待消费结果集。

可这些零件本身都不会自动运行。

- ByteBuf 不会自己去读 Socket。
- Selector 不会自己调用 `select()`。
- Channel 不会自己在正确线程里完成 register。
- 外部线程提交的任务，也不会自动和 I/O 就绪事件排好次序。

所以这里真正需要的，不是“再来一个工具类”，而是一个长期活着的驱动者。它必须同时承担四个职责：

```text
一、守着 Selector 等 I/O
二、在正确线程里推进 Channel 的 register/read/write
三、执行外部提交的普通任务和定时任务
四、保证同一个 Channel 的动作保持线程亲和性
```

这就是 EventLoop。

很多人第一次接触 Netty，会把它想成“一个包装过的线程池线程”。这只对了一半。线程池确实也会取任务执行，但 EventLoop 不是纯任务执行器。它是一个把 I/O 驱动和任务执行装进同一条单线程循环里的调度者：线程既是 Selector 的等待者，也是任务队列的消费者，还是 Channel 生命周期动作的归宿。

因此本篇最重要的判断不是“EventLoop 里有一个线程”，而是：

```text
EventLoop 不是把 I/O 扔给线程池
而是让同一个线程同时负责 I/O 事件和任务推进
```

这也是为什么第 3 章讲完 Selector 之后，下一章必须进入 EventLoop：只有它把 `select()`、`read/write`、`runAllTasks()` 和 `register()` 串起来，前面那些零件才真正形成可持续运转的数据流。

## 一、先别把 EventLoop 想成普通线程池槽位

### 1. 线程池解决“谁来跑任务”，EventLoop 还要解决“谁来等 I/O”

普通线程池的主线很简单：有任务就取出来跑，没有任务就等待下一个任务。它并不关心某个任务是不是 Socket 就绪事件，也不关心这个任务是否必须与某个 Channel 保持单线程亲和。

EventLoop 面对的问题比线程池多一层：

```text
没有 I/O 事件时，线程该阻塞在 select 上
没有任务时，线程也可以阻塞
但只要任一边有工作，就不能让另一边无限期等待
```

如果只把 EventLoop 当成 `ThreadPoolExecutor` 的变体，你很快会遇到两个解释不通的问题：

1. 为什么任务队列不能简单用阻塞 `take()`？
2. 为什么 register 这类动作要先回到 EventLoop 线程再做，而不是哪个线程调用就哪个线程执行？

答案都指向同一件事：EventLoop 的线程不是只服务任务，它还要维护 I/O 主循环和 Channel 线程亲和性。

### 2. “单线程”不是为了简单，而是为了把锁问题前移成归属问题

只要 Selector、Channel、ByteBuf 生命周期和任务回调都落在同一个 EventLoop 线程里，很多原本需要锁协调的问题，会退化成“你有没有把动作交给正确的线程”。

这和第 3 章的 NIO 事件循环是一脉相承的：JDK 的 select loop 已经说明，一线程多连接的前提是把等待责任统一托管。Netty 进一步做的，不只是继续用 select，而是把“等待 + I/O + 任务 + 注册 + 释放”尽可能都塞回这条单线程路径。

所以单线程 EventLoop 不是为了拒绝并发，而是为了给局部并发设边界：

```text
多线程可以提交任务或发起请求
真正的 I/O 推进和状态修改尽量回到所属 EventLoop 线程
```

这样，系统复杂度的主问题就从“处处要锁”变成“谁拥有这条 Channel/IoHandle 的执行权”。

## 二、EventLoop 的自包含效果：它自己就是一个可注册、可执行的单元

### 1. 单个 loop 不只是消费者，它自己就能 register

当前源码里，`SingleThreadEventLoop.register(Channel)` 直接调用 `channel.unsafe().register(this, promise)`，见 `SingleThreadEventLoop.java:111-120`。也就是说，单个 EventLoop 自己就具备把 Channel 绑定到本线程的能力。

对于 I/O handle，`SingleThreadIoEventLoop.register(handle)` 同样直接存在于单个 loop 上，见 `SingleThreadIoEventLoop.java:233-242`。

这说明一个重要事实：在当前实现中，单个 EventLoop 不是“等上层 Group 选完我之后，我才被动接活”的纯执行终点。它自己就是一个可以接收注册、推进 I/O 和执行任务的完整单元。

### 2. `next() -> this` 体现的是“单元素 group”的运行效果

`SingleThreadIoEventLoop.next()` 直接返回自身，见 `SingleThreadIoEventLoop.java:228-230`。这就是 EventLoop 自包含效果最直接的源码证据：对一个单独的 loop 来说，再调用 `next()`，不会选出另一个对象，而是返回自己。

因此可以把它理解成：

```text
多线程 group：负责在多个 loop 之间做分发
单个 loop：对自己来说已经是“唯一可选的下一个”
```

这里要特别说明一个版本边界：很多旧资料会从旧接口层次图出发，把 EventLoop 解释成“同时继承 Group”。在当前这份源码里，真正稳定的事实不是某个旧的接口继承关系，而是这种运行效果：单个 EventLoop 既能执行、也能注册、`next()` 也回到自己。

### 3. `NioEventLoop` 现在更像一个薄壳

当前 `NioEventLoop` 已经只是 `SingleThreadIoEventLoop` 上面的一层 NIO 适配外壳，类注释明确标记为 deprecated，并建议改用 `SingleThreadIoEventLoop` 配 `NioIoHandler`，见 `NioEventLoop.java:38-45`。

这说明 Netty 当前架构把“单线程 I/O 事件循环”和“具体 I/O 实现（NIO、epoll、kqueue、local ...）”拆开了：

```text
SingleThreadIoEventLoop
  -> 负责主循环、任务队列、注册时序
IoHandler
  -> 负责具体 I/O 后端如何 select / register / wakeup / process
```

这个拆分的好处是，EventLoop 的调度骨架不必被某一个传输后端绑死。第 5 章第一篇因此应该聚焦在骨架本身，而不是一开始就掉进 Selector 优化细节。

## 三、run() 主循环：每一轮都在 I/O 和任务之间来回切换

### 1. 先看主线，不急着看具体 I/O 后端

当前 `SingleThreadIoEventLoop.run()` 的主体非常短：

```text
initialize
  -> runIo()
  -> if shutting down: prepareToDestroy()
  -> runAllTasks(maxTaskProcessingQuantumNs)
  -> while (!confirmShutdown() && !canSuspend())
```

实现见 `SingleThreadIoEventLoop.java:191-205`。

这条主线短得有点反直觉，因为我们很容易以为 EventLoop 一定藏着非常长的 `select -> process -> execute` 代码。实际上，当前架构的关键不是把所有细节都写进 `run()`，而是把责任拆清：

- `runIo()` 负责本轮 I/O 推进。
- `runAllTasks(...)` 负责普通任务和定时任务。
- shutdown/suspend 条件决定这条循环何时收尾。

而 `runIo()` 自己又只是一层委托：`ioHandler.run(context)`，见 `SingleThreadIoEventLoop.java:223-225`。这让 EventLoop 的主循环保持稳定，SelectStrategy、Selector 优化、不同传输后端都可以放到后续篇章。

### 2. 为什么不是“永远先 I/O 跑到空，再跑任务”

如果只从 Reactor 角度看，一个很自然的设计是：

```text
while (true) {
    select/process all io;
    run all tasks;
}
```

但这里有两个陷阱。

第一个陷阱是 I/O 饥饿任务。假设高峰期一直有连接可读可写，如果主循环总想“先把 I/O 都处理干净”，那外部线程提交到 EventLoop 的普通任务可能长时间排队。

第二个陷阱是任务饥饿 I/O。假设某个 handler 不断往 EventLoop 提交短任务，如果每一轮都先把任务跑到彻底清空，再去碰 I/O，那么 select loop 的响应延迟又会上去。

所以主循环的关键，不是简单确定“谁优先级更高”，而是强迫两类工作在同一条时间线上交替出现。当前 EventLoop 采取的就是这种交替：

```text
先推进一轮 I/O
  -> 再给任务一段执行时间
  -> 再回去看下一轮 I/O
```

这不是严格公平调度，也不是数学意义上的实时保证；但它明确拒绝了“某一边无限独占循环”的策略。

### 3. 任务量子是当前架构的平衡杆

`SingleThreadIoEventLoop` 引入了 `maxTaskProcessingQuantumNs`，默认值来自系统属性 `io.netty.eventLoop.maxTaskProcessingQuantumMs`，并且至少是 100ms，默认取 1000ms，见 `SingleThreadIoEventLoop.java:38-40`。

`runAllTasks(maxTaskProcessingQuantumNs)` 的意义是：本轮任务执行不会无限拉长。EventLoop 会给任务一段量子时间，然后优先把控制权还给下一轮主循环。

这里要克制两个过度解读：

1. 它不是“每一轮任务恰好只执行这么久”的硬实时保证。
2. 它也不是旧版 Netty 常见的 `ioRatio` 百分比模型；当前源码走的是“任务时间量子”这条线，而不是“按百分比切分 I/O 与任务时间”。

更准确的理解是：

```text
任务可以连续跑
但连续跑多久，当前实现给了一个上限方向
这样 I/O 至少有机会被重新检查
```

所以主循环最该记住的不是 `run()` 里那几行代码，而是这条调度哲学：同一线程既不能把任务彻底外包，也不能让 I/O 永远压制任务。

## 四、为什么 EventLoop 只有在没有任务时才允许阻塞

### 1. `canBlock()` 同时看普通任务和定时任务

`SingleThreadIoEventLoop` 传给 `IoHandler` 的 `IoHandlerContext` 中，`canBlock()` 的实现很直接：只有 `!hasTasks() && !hasScheduledTasks()` 时才返回 true，见 `SingleThreadIoEventLoop.java:43-48`。

这句代码比很多高层描述都重要。它说明 EventLoop 是否允许在 I/O 后端里阻塞等待，不是只看 selected key 是否为空，而是先看：当前有没有任何待执行工作。

这里的“工作”包括两类：

- 普通 task queue 里的任务。
- 已经到时或即将到时的 scheduled task。

只要其中任意一类存在，当前 loop 就不应长时间睡在 select 上。

### 2. 为什么任务队列不能用阻塞 take

`SingleThreadIoEventLoop.newTaskQueue0` 的注释明说，这个 event loop 永远不会调用 `takeTask()`，见 `SingleThreadIoEventLoop.java:289-293`。它创建的是 MPSC 队列，但消费方式是 poll，不是阻塞等待。

这背后的逻辑和 `canBlock()` 完全一致：

```text
线程阻塞点应该由 I/O 等待策略统一控制
而不是被任务队列的 take() 抢走
```

如果 EventLoop 线程阻塞在任务队列 `take()` 上，就会失去对 I/O 等待时机的主导权；而如果它阻塞在 select 上，又需要有办法在新任务到来时被唤醒。这正是 wakeup 和任务队列协同存在的原因。

因此当前设计不是“任务来了线程就靠阻塞队列苏醒”，而是：

- 任务进入无锁 MPSC 队列。
- 如有必要，通过 wakeup 打断 I/O 阻塞。
- EventLoop 在线程自己的主循环里 poll 任务。

这条路径把“线程何时阻塞、阻塞在哪”收回到了 EventLoop 设计本身。

### 3. taskQueue 和 tailTasks 是两种不同时间语义

普通任务进入主 taskQueue；而 `executeAfterEventLoopIteration` 会把任务加入 `tailTasks`，见 `SingleThreadEventLoop.java:137-150`。

两者的区别不是“优先级高低”，而是时机：

```text
普通 task：进入 runAllTasks 的主要执行流
 tailTask：留到本轮 runAllTasks 结束后统一执行
```

`SingleThreadEventLoop.afterRunningAllTasks()` 会调用 `runAllTasksFrom(tailTasks)`，见 `SingleThreadEventLoop.java:163-166`。而 `hasTasks()` 也把 tailTasks 算进去，见 `SingleThreadEventLoop.java:168-170`。

所以 tailTasks 不是一个“无关紧要的小队列”。它表达的是一种非常具体的时序需求：

```text
这项任务不是立即打断当前任务流
而是请在本轮事件循环迭代收尾时再做
```

这类语义很难用普通立即执行任务表达，因为立即执行会把它插到当前任务流中间，而不是自然落在一轮 event loop 的尾部。

## 五、MPSC 任务队列：多生产者把工作塞进同一条单线程循环

### 1. 为什么是 MPSC

EventLoop 线程自己会产生任务，外部线程也可能提交任务。于是队列至少要支持多生产者；但消费者只有一个，就是 EventLoop 自己的线程。

这正是 MPSC 的典型模型：

```text
多个外部线程 offer(task)
一个 EventLoop 线程 poll(task)
```

`SingleThreadIoEventLoop.newTaskQueue0` 返回的就是 `PlatformDependent.newMpscQueue()` 或其带上限版本，见 `SingleThreadIoEventLoop.java:289-293`。

它比“随便来个 synchronized queue”更契合当前结构：

- 生产端并发写入。
- 消费端单线程读取。
- 不要求消费端在队列上阻塞等待。

### 2. `maxPendingTasks` 是拒绝策略边界

`SingleThreadEventLoop` 定义了 `DEFAULT_MAX_PENDING_TASKS`，最小为 16，默认系统属性是 `Integer.MAX_VALUE`，见 `SingleThreadEventLoop.java:36-39`。

而 `SingleThreadEventExecutor` 在构造时也把 `maxPendingTasks` 夹到至少 16，见 `SingleThreadEventExecutor.java:222-246`。

这意味着任务队列并不是无条件无限接受。超过允许积压后，最终会进入 `RejectedExecutionHandler` 的处理逻辑。这个机制的存在提醒我们：EventLoop 虽然是单线程，但它不是一个可以吞掉无限提交压力的黑洞。积压边界必须被表达，否则任务系统只会把背压变成内存增长。

本篇只建立这条边界存在的事实；具体拒绝策略对业务的影响，属于运行时调优和 Promise/Future 协作的后续问题。

### 3. 任务入队不等于立即执行

MPSC 队列的一个重要后果是：外部线程 `execute(task)` 成功，只代表任务成功进入某条单线程消费路径，并不代表它马上运行。

真正的执行时机仍然由 EventLoop 主循环决定：

```text
offer(task)
  -> 任务进入队列
  -> 如有必要唤醒 EventLoop
  -> EventLoop 在 runAllTasks 中 poll 并执行
```

这也是为什么“任务队列是线程安全的”并不足够。还必须让提交方理解线程亲和和时序：你提交的是“请这个 EventLoop 在合适时机执行”，不是“请当前线程立刻帮我做完”。

## 六、register 为什么要异步回到 EventLoop 线程

### 1. 当前线程不是 loop 线程时，不直接 register

`SingleThreadIoEventLoop.register(handle)` 先创建 Promise；如果当前已经在 EventLoop 线程里，就直接调用 `registerForIo0`，否则把它包装成任务交给 `execute(...)`，见 `SingleThreadIoEventLoop.java:233-242`。

这条路径的意义不是为了“让 API 看起来更异步”，而是为了保证 register 的线程归属：

```text
不在 loop 线程
  -> 不直接碰底层 I/O 注册
  -> 把注册动作排回所属 EventLoop
```

注册成功与否，再通过 Promise 返回给调用方。

### 2. 为什么 register 不能谁调用谁执行

第 3 章讲 JDK Selector 时已经埋过这个雷：register 与 select 的协作涉及底层锁、interest set 更新和 wakeup 边界。如果允许外部线程随意直接打到底层 selector，线程亲和性会被打破，register 还可能卡在底层同步点上。

这一点在 `NioEventLoop.register(SelectableChannel, interestOps, NioTask)` 里写得很明白：如果不在 event loop 线程，就把 register0 提交到 EventLoop，因为 `AbstractSelectableChannel.register` 可能在争取内部锁时阻塞较长时间，见 `NioEventLoop.java:71-109`。

因此 register 异步化的真正动机是：

```text
保持 I/O 状态修改尽量回到所属 EventLoop 线程
并避开底层 register/select 锁争被外部线程直接放大的路径
```

### 3. `IoRegistrationWrapper` 让 suspend 判定知道自己还有没有活

`registerForIo0` 在底层 `ioHandler.register(handle)` 成功后，会先把 `numRegistrations` 加一，再把返回的 `IoRegistration` 包装成 `IoRegistrationWrapper` 返回，见 `SingleThreadIoEventLoop.java:250-260`。

这个包装器在 `cancel()` 成功时把 `numRegistrations` 减一，见 `SingleThreadIoEventLoop.java:295-323`。

这不是多此一举。`SingleThreadIoEventLoop.canSuspend(state)` 除了父类条件，还要求 `numRegistrations == 0`，见 `SingleThreadIoEventLoop.java:211-215`。

也就是说，EventLoop 是否允许自己进入 suspend 状态，不只取决于“有没有任务”，还取决于“当前还有没有注册在我身上的 I/O handle”。

```text
有注册对象
  -> loop 仍有职责
  -> 不能轻易 suspend
无注册对象 + 无任务
  -> 才可能 suspend
```

如果没有这个计数器，EventLoop 只能靠任务队列判断活跃度，就会忽略“虽然暂时没任务，但我手上仍绑定着 I/O handle”的状态。

## 七、把 EventLoop 主线收成一张图

到这里，可以把 EventLoop 的第一层主线压成一张总图：

```text
外部线程 / 业务代码
  -> submit/execute/register
  -> 任务进入 MPSC 队列，或注册动作封装成任务
  -> 如有必要唤醒 EventLoop

EventLoop 线程
  -> runIo()      处理本轮 I/O
  -> runAllTasks  在量子时间内处理任务
  -> afterRunningAllTasks 处理 tailTasks
  -> 检查 shutdown / suspend 条件
  -> 下一轮

IoHandler
  -> 提供 select/register/wakeup/run 的具体后端实现
```

这张图解释了前面几个看似分散的设计：

- `next() -> this` 说明单个 loop 自己就是完整调度单元。
- `canBlock()` 说明只有在没有普通任务和定时任务时，I/O 才允许阻塞等待。
- MPSC 队列说明任务提交是多生产者、单消费者模型。
- tailTasks 说明“本轮迭代末尾再做”也是一种需要被建模的时序。
- register 异步化说明线程亲和性比“谁先调用到 API”更重要。

## 八、最容易错的五个判断

### 1. EventLoop 就是一个线程池线程

不成立。线程池只需要执行任务；EventLoop 还要统一驱动 I/O、任务、注册和线程亲和。

### 2. `run()` 先跑 I/O 再跑任务，所以任务总是次要的

不成立。当前实现用任务处理时间量子限制任务连跑时长，同时 `canBlock()` 让 I/O 只有在没有任务/定时任务时才允许阻塞，说明两者是在同一条循环中交替平衡，不是谁永久次要。

### 3. 任务队列既然是线程安全的，就可以阻塞 take

不成立。EventLoop 必须自己决定阻塞点。如果阻塞在任务队列上，就失去对 I/O 等待时机的主导。

### 4. tailTasks 只是另一个普通任务队列

不完整。它表达的是“本轮 event loop 迭代末尾再执行”的时间语义，不是简单的另一批任务。

### 5. register 异步只是为了返回 Promise

不成立。Promise 只是结果承载；真正原因是把 register 放回 EventLoop 线程，维持线程亲和并规避底层 register/select 锁争。

## 收网：EventLoop 不是附件，它是数据流真正的驱动者

现在可以回到本章最开始的问题：ByteBuf、Selector、Channel 都准备好了，谁让它们动起来？

答案就是 EventLoop，而且不是“顺手跑一跑任务”的弱角色，而是整个运行时的单线程驱动骨架：

```text
它守着 I/O
它消费任务
它接住 register
它维持线程亲和
它决定什么时候阻塞、什么时候继续推进
```

因此本篇最核心的结论不是“EventLoop 有一个 run()”，而是：

```text
EventLoop 把 I/O 和任务放进同一条单线程时间线里
让 Netty 不必在“线程池执行器”和“Reactor 循环”之间二选一
```

后续篇章会继续拆开这条循环的内部关键点：为什么有任务时不该阻塞 select，SelectStrategy 如何决定本轮走 SELECT 还是 CONTINUE，selectedKeys 的 JDK HashSet 为什么不够，Netty 又怎样把它替换成更轻的结构。这就是下一篇要展开的内容。