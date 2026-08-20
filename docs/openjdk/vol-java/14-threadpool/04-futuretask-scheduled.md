# FutureTask 与定时调度：为什么任务执行和结果管理必须绑成同一个对象

> 本文基于 JDK 11 `FutureTask`、`AbstractExecutorService` 与 `ScheduledThreadPoolExecutor`。讨论范围聚焦 FutureTask 状态机、`run/get/cancel`、`set/setException/finishCompletion/awaitDone`，以及 ScheduledThreadPoolExecutor 的 `ScheduledFutureTask`、`DelayedWorkQueue`、固定频率与固定延迟语义；Executors 工厂与大范围参数调优放到下一篇。本文讨论的是 JDK 11 Java 层实现路径，不把这里的 Future 语义和调度实现外推成所有执行框架都必须遵守的统一规范。
> **前置依赖**：[execute 流程与 Worker 生命周期](02-execute-worker.md)、[关闭与拒绝策略](03-shutdown-reject.md)
> **后续**：[Executors 工厂与选型](05-executors-selection.md)

## 先看一个最容易把“任务跑了”和“结果交付了”混成一件事的误会

很多人第一次用线程池时，只把注意力放在“任务有没有被执行”。可一旦开始用 `submit()`、`Future.get()`、`cancel()`、定时调度，这个视角马上就不够了。因为调用方关心的已经不只是“线程有没有跑这个任务”，还包括：结果谁来保存？异常怎么带回来？取消到底取消了什么？如果任务本来应该 5 秒后再跑，线程池为什么不能只是让某个线程先 sleep 5 秒？

这些问题之所以会同时冒出来，是因为线程池到这里已经不只是执行器，而开始承担“**结果和时间约束的管理者**”角色。执行线程和提交线程围绕的是同一份任务，但他们需要观察的是两条不同视角：一条是 Runnable/Callable 的执行过程，另一条是 Future 的结果、异常、取消和等待语义。

这就是 `FutureTask` 要解决的核心：**让同一个对象既能被线程池当成任务执行，又能被调用方当成结果句柄观察。** 而 `ScheduledThreadPoolExecutor` 则继续往这套模型上再加一层：不仅要把执行和结果绑在一起，还要把“应该什么时候运行”也绑进去。

所以这篇不把 FutureTask 和定时线程池当成两个独立 API 包装，而是沿着同一条主线来讲：为什么任务执行、结果发布、异常封装、取消竞态和时间排序，都必须落在一套统一状态机上。

## 一、FutureTask 为什么不能只用 done / not-done 两态：结果、异常和取消根本不是同一种结局

### 先看最朴素但不够用的模型

如果你只想表达“任务有没有完成”，那一个布尔 `done` 好像就够了：没完成就 false，完成了就 true。但这个模型一旦进入真实并发环境，几乎立刻不够用。因为“完成”本身就分很多种：正常返回、抛异常结束、被取消、正在中断取消、结果刚写了一半但还没完全稳定……

调用方如果只看一个 done，根本不知道自己接下来该返回结果、抛 `ExecutionException`、抛取消异常，还是继续等到中间态结束。

这也是为什么 JDK 11 的 `FutureTask` 一上来就不是布尔标志，而是一整套状态机。类定义在 `FutureTask.java:66`，状态常量和迁移注释在 `77-99` 一带，核心状态包括：

- `NEW`
- `COMPLETING`
- `NORMAL`
- `EXCEPTIONAL`
- `CANCELLED`
- `INTERRUPTING`
- `INTERRUPTED`

它们可以压成两条主线：

```text
正常完成线
  NEW → COMPLETING → NORMAL / EXCEPTIONAL

取消线
  NEW → CANCELLED
  NEW → INTERRUPTING → INTERRUPTED
```

这个设计说明得很清楚：**FutureTask 不是在问“有没有结束”，而是在问“这次结束到底是哪一种结局，以及当前有没有处在还不能对外暴露的过渡态”。**

### `COMPLETING` 和 `INTERRUPTING` 为什么是必要的中间态

很多人会觉得这两个中间态像实现细节，多看一眼就过去了。实际上，它们正好解决了“结果还在写入、取消还在处理中”这类不能直接暴露给外部观察者的窗口。

以正常完成为例：线程刚算出结果，还没把它稳定写进 `outcome` 并切到最终 `NORMAL` 时，如果另一个线程的 `get()` 已经跑进来读状态，就不能让它误以为结果已经完全可取。取消路径也是一样：如果已经开始对 runner 发 interrupt，但还没把状态切成最终稳定的 `INTERRUPTED`，调用方也不能把这段中间过程和真正完成的取消终态混为一谈。

所以这些中间态不是“为了复杂而复杂”，而是在帮 FutureTask 给多线程观察者一个一致承诺：**要么你看到未完成，要么你看到一个已经稳定的最终结局，中间施工态不能直接当成结果。**

## 二、为什么执行和结果必须是同一个对象：submit 返回的其实就是被线程池执行的那个 FutureTask

### 先看为什么不能“线程池跑一个任务，调用方再拿另一个结果壳”

如果执行者和结果持有者是两个独立对象，中间就需要再造一层同步协议：谁来告诉结果对象任务开始了、结束了、抛异常了、被取消了？这会把一个任务拆成两个需要额外同步对齐的实体，复杂度平白上升。

JDK 11 的做法恰好相反：让同一个对象既实现 `RunnableFuture`，又自己持有状态机和结果。于是线程池执行的是它的 Runnable 面，调用方拿到的是它的 Future 面，本体却是同一份状态。执行、结果、取消和等待全都围着这一个对象转。

### submit 的包装链为什么证明了这一点

这条链在 `AbstractExecutorService` 中很清楚：

- `newTaskFor(Runnable, T)` 位于 `AbstractExecutorService.java:92`
- `newTaskFor(Callable)` 位于 `107`
- `submit(...)` 位于 `115-139`

它的主线很简单：先把任务包装成 `RunnableFuture`，默认就是 `FutureTask`；然后把这个同一个对象交给 `execute()` 去跑；再把这个同一个对象返回给调用方。

这说明 submit 不是“创建一个 Future 壳，再让线程池执行别的东西”，而是：**FutureTask 自己同时扮演执行实体和结果句柄。**

这一层一定要讲透，因为它解释了为什么 `get()`、`cancel()`、任务异常和运行状态都落在同一个类里，而不是散在多层包装之间。

## 三、run / set / setException / finishCompletion 为什么共同构成结果发布闭环

### 先看任务执行真正在哪里转成结果状态

`FutureTask.run()` 位于 `FutureTask.java:254-281`。它并不只是“帮你调用 callable.call()”这么简单，而是在执行结束后立刻决定状态机走向：

- 正常返回：走 `set()`（`FutureTask.java:228-232`）
- 抛出异常：走 `setException()`（`246-250`）

两条路径都先把状态从 `NEW` 推到 `COMPLETING`，把结果或异常对象写进 `outcome`，再进入最终稳定态 `NORMAL` 或 `EXCEPTIONAL`，然后统一调用 `finishCompletion()`（`361`）。

这条链正好把“执行任务”和“对外发布结果”绑成了一个闭环：不是执行线程跑完就完事，而是它还要负责把结局写进状态机，并唤醒所有在等这个结局的人。

### `finishCompletion` 为什么不是装饰钩子

很多人会把 `finishCompletion()` 看成“任务结束后顺带做点收尾”，实际上它是 FutureTask 真正把内部状态变化转成外部可观察行为的关键一步。它要负责：

- 唤醒等待在 `get()` 上的线程
- 清理等待链
- 调用 `done()` 钩子

也就是说，任务执行线程不是只负责跑任务，还负责把“任务已经有了稳定结局”这个事件正式广播给调用方那一侧。

这一层的收束是：**FutureTask 的 run 不只是运行逻辑入口，它也是结果状态机的写入入口。**

## 四、get 为什么不是“等线程跑完”，而是在等 FutureTask 状态稳定到最终结局

### 先看 get 真正等待的对象是什么

`get()` 位于 `FutureTask.java:187-203`。很多人会顺口说它“等任务线程执行完”，这个说法只说对了一半。更准确地说，它等的是 **FutureTask 状态离开中间态，并稳定到某个最终结果态**。

因为就算线程的 `call()` 主体逻辑已经返回了，如果状态还卡在 `COMPLETING` 这类中间窗口里，调用方也还不能安全拿结果。同样，取消路径里如果还在 `INTERRUPTING`，调用方也不能把这当成最终取消状态。

真正让 `get()` 睡下和醒来的，是 `awaitDone()`（`FutureTask.java:393-443`）。它会在任务未进入最终状态时 park 等待，等状态稳定后再回来根据终态作出不同处理：

- `NORMAL`：返回结果
- `EXCEPTIONAL`：抛出 `ExecutionException`
- `CANCELLED` / `INTERRUPTED`：走取消语义

### 为什么异常要在 get 里“再抛一次”

这也解释了 `submit()` 和 `execute()` 最常见的差别。submit 路线中，任务异常不会直接像未捕获异常那样沿线程出口跑掉，而是先被 FutureTask 收进 `outcome`，状态转成 `EXCEPTIONAL`，等调用方将来 `get()` 时再以 `ExecutionException` 的形式暴露出来。

所以 `get()` 不是简单地“拿返回值”，而是在把执行线程那边的任务结局，重新翻译成调用方线程这边应该观察到的同步结果。

## 五、cancel 为什么不是“撤回历史”，而是在抢 NEW 状态的控制权

### 先拆掉“任务只要还没结束就一定能取消成功”的想象

很多人看到 `cancel(boolean)`，会自然联想到“把任务从系统里撤销掉”。实际上，FutureTask 的取消并不是对历史做回滚，而是在争抢一个很具体的窗口：**这个任务是否仍然处在 `NEW`，还没有进入最终完成线。**

`cancel()` 位于 `FutureTask.java:164-179`。它的核心判断非常直接：只有状态仍然是 `NEW`，才有资格把它推进到 `CANCELLED` 或 `INTERRUPTING → INTERRUPTED`。如果任务已经进入完成线或取消终态，再来一次 cancel 就不是“再试试”，而是已经晚了。

### `cancel(true)` 为什么也不是“保证立刻停掉任务”

`cancel(false)` 表示只改 Future 状态，不主动对运行线程发中断请求；`cancel(true)` 则会进一步尝试 interrupt 当前 runner。但这仍然不是强制 kill，它只是把任务推到“已请求取消并尝试中断”的语义线上。具体任务是不是立刻停止，仍然取决于任务代码是否响应中断。

这点和上一章线程池关闭时的 `shutdownNow()` 完全呼应：线程中断一直都是协作式请求，不是瞬间抹除执行体的命令。

所以 cancel 真正值得记住的是：**它争抢的是任务还未定局时的控制权，而不是对已发生结果的撤销能力。**

## 六、为什么定时调度不能靠“普通线程池 + sleep”：时间排序必须进队列，而不是先占住线程

### 先看最朴素但很浪费的失败方案

如果你想 5 秒后执行一个任务，最直觉的实现是：把任务交给线程池，再让某个工作线程先 `sleep(5s)`，醒来后再跑。这个方案最大的问题是：线程资源被提前占住了。任务还没到执行时刻，worker 已经被锁死在等待里，后面的真正到期任务可能反而没有足够工人立即执行。

同时，普通队列也无法正确表达“谁先到期就先出队”这件事。任务如果只是按提交顺序排着，线程池就得额外再做一层时间判断和重排，逻辑很快会变得混乱。

### ScheduledThreadPoolExecutor 为什么要专门带 DelayedWorkQueue

JDK 11 的 `ScheduledThreadPoolExecutor` 定义在 `ScheduledThreadPoolExecutor.java:134`。类注释 `141-146` 一带已经说明了它的两个关键变化：一是自定义 `ScheduledFutureTask`，二是自定义 `DelayedWorkQueue`。构造器在 `456` 等位置也明确使用了这条延迟工作队列。

`DelayedWorkQueue` 本体定义在 `ScheduledThreadPoolExecutor.java:899`，它本质上是一种按触发时间排序的延迟堆。这样线程不会提前被“未来任务”占住，而是始终优先拿到“此刻已经到期的最早任务”。

这就是它和“普通线程池 + sleep”的根本区别：**时间不是被线程拿在手里等，而是被队列拿来排序。** 线程资源只在真正该执行时才被占用。

## 七、fixedRate 和 fixedDelay 为什么不是两个名字相近的 API，而是两种时间哲学

### 它们真正对齐的不是同一条时间线

`scheduleAtFixedRate()` 位于 `ScheduledThreadPoolExecutor.java:616-625`，`scheduleWithFixedDelay()` 位于 `664-673`。表面看都是周期调度，但它们对“下一次什么时候该开始”给出的答案完全不同。

- fixedRate：下一次时间锚定在**上一次计划开始时间**之后的固定周期
- fixedDelay：下一次时间锚定在**本次真正执行完成时间**之后的固定延迟

前者更像在追赶一张计划表，后者更像每次做完后再休息固定间隔。你如果把它们都背成“固定周期调度”，就会错过最重要的行为差异。

### 为什么 ScheduledFutureTask 和 reExecutePeriodic 必须参与这件事

周期任务不是执行完就消失，它们要在每轮结束后重新计算下一次触发时间，再重新入队。JDK 11 里：

- `ScheduledFutureTask` 定义在 `ScheduledThreadPoolExecutor.java:185-236`
- `reExecutePeriodic` 位于 `356`

这说明周期调度不是线程自己在 while 循环里 sleep，而是**任务对象自己携带时间语义，每轮执行完再按规则算出下一次时间，重新回到延迟队列里参与排序。**

这一层真正要记住的是：fixedRate 和 fixedDelay 的差别，不在 API 名字，而在“下一轮到底对齐计划时间还是完成时间”。

## 八、四个最容易记错的边界：submit 不只是多返回值，get 不只是等线程结束，cancel 不是回滚，定时调度不是线程先睡着

在收网之前，先把这篇最容易混掉的四条边界压实。

第一，`submit()` 不是在 `execute()` 旁边额外多塞了一个返回值。它真正多做的，是先把任务包装成 `FutureTask` 这样的 `RunnableFuture`，再把这个同一个对象交给线程池执行并返还给调用方。所以 `submit` 改变的不只是调用形式，还改变了异常、结果和取消的观察入口。

第二，`get()` 也不是“等执行线程结束”这么简单。它等待的是 FutureTask 状态稳定到最终结局：正常结果、异常结果或者取消终态都可以；但 `COMPLETING`、`INTERRUPTING` 这类中间态还不行。把它错记成线程 join，很容易看不懂为什么异常和取消也会从 `get()` 这边重新表现出来。

第三，`cancel()` 不是对既成事实做回滚。它只能在任务还处在 `NEW` 这类未定局窗口时抢控制权；一旦结果已经正常发布或异常已经落定，再调用 cancel 也不会把历史倒回去。`cancel(true)` 能做的也只是再多发一个协作式 interrupt 请求，而不是强制抹除正在执行的代码。

第四，定时调度也不是“线程池帮你提前派一个线程去睡觉”。真正睡在时间上的，是队列里的触发顺序，不是 worker 本身。`DelayedWorkQueue` 的意义正是让未来任务先按到期时间排着，等真正到点时再占用线程；否则线程会被大量未来任务提前卡死，调度语义也会退化成粗糙的 sleep 管理。

把这四条边界记稳，FutureTask 和 ScheduledThreadPoolExecutor 才不会重新塌回“一个拿结果的壳”和“一个能延时的线程池”这种说明书印象。它们真正做的是两层状态管理：先把执行结果绑成同一个任务对象，再把时间约束也塞进同一套排队与重入机制里。

## 收网：FutureTask 让任务执行与结果结局同体，ScheduledThreadPoolExecutor 再把时间约束叠上去

回到开头那个总问题，现在已经能看清为什么线程池不仅要会执行任务，还必须会管理结果和时间。`execute()` 只解决“任务怎么被工人拿去跑”；但一旦调用方还关心结果、异常、取消和等待，就必须有一个像 FutureTask 这样的状态机对象，把执行线程和调用方线程围到同一个任务本体上。这样，同一个对象既能被线程池当成 Runnable 执行，又能被调用方当成 Future 等待、取消和取结果。

而一旦再叠加“什么时候该执行”这层约束，普通线程池与普通队列又不够了。ScheduledThreadPoolExecutor 做的事，就是把 FutureTask 这条“结果状态机”继续包进带触发时间的任务对象里，再用 DelayedWorkQueue 维护时间顺序，让未来任务在真正到点前不占住线程资源。

把整篇压成一张总图，就是：

```text
FutureTask
  → run 执行任务
  → set / setException 发布结果结局
  → cancel 争抢 NEW 状态控制权
  → get 等最终稳定结局

ScheduledThreadPoolExecutor
  → 任务额外带上触发时间
  → DelayedWorkQueue 按到期顺序出队
  → periodic task 每轮执行后再计算下一次时间并重入队
```

如果前几篇讲的是线程池怎样收任务、怎样养工人、怎样退场，这一篇真正补上的就是：**任务被执行之后，结果怎么被交付；任务还没到时间之前，时间又怎样被建模成队列排序规则。**

下一篇继续顺着这条线往上收束：JDK 提供了这么多 `Executors` 工厂方法，它们到底各自给你拼了什么线程池参数组合？为什么有些工厂看起来很方便，生产上却常常不推荐直接用？这会把线程池域从机制层收回到最终选型层。