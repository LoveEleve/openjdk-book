# ChannelPromise、Scheduled 与 Progressive：当结果不仅仅是“成功或失败”

> 本文基于当前 Netty `DefaultChannelPromise`、`VoidChannelPromise`、`ScheduledFutureTask`、`DefaultProgressivePromise` 和 `DefaultChannelProgressivePromise` 实现。前置：Ch6-01 `01-state-model-and-listeners.md`、Ch6-02 `02-combinators-and-immutable.md`、Ch5 EventLoop 四篇；本文解释 Promise 在 Channel、定时任务和进度通知场景下的特化，不展开 Pipeline 或 ChannelOutboundBuffer 的全部细节。

## 通用 Promise 已经够表达“完成”，但业务 API 还会提出别的约束

前两篇 Promise/Future 已经把最通用的异步语义讲清楚了：

- Future 负责读结果，Promise 负责写结果。
- `DefaultPromise` 负责状态机、listener 和阻塞等待。
- `CompleteFuture`、`PromiseCombiner`、`PromiseNotifier`、`PromiseTask` 负责已完成、组合、级联和桥接。

可一旦 Promise 进入 Netty 的具体业务 API，很快就会遇到通用模型表达不够的地方。

比如：

```text
channel.write(msg, promise)
```

这里的结果不是抽象的“某个异步操作”，而是“这个 Channel 上的一次写”。listener 应该在哪个线程上回调？与 flush 顺序相关的计数该放在哪？

又比如：

```text
ctx.write(msg, ctx.voidPromise())
```

调用方明确表示：我不想观察这个结果，也不想加 listener，更不想 await。那这个 Promise 还应该保持通用 Promise 的全部能力吗？

再比如：

```text
eventLoop.scheduleAtFixedRate(task, ...)
```

这个 Future 不是“一次完成就结束”，而是会反复到期、反复执行。它和普通 PromiseTask 的终态语义根本不同。

还有：

```text
uploadPromise.setProgress(progress, total)
```

这里结果不是只有“成不成功”，而是完成之前要不断报告中间进度。

所以 Ch6 第三篇的核心不是“再讲几个 Promise 子类”，而是：

```text
当异步结果开始携带 Channel 归属、无结果、周期执行和中间进度这些约束时
Promise/Future 如何继续保持统一，而不是被业务特殊情况击碎
```

## 一、`DefaultChannelPromise`：结果不只是某个操作完成了，而是“这个 Channel 上的操作完成了”

### 1. ChannelPromise 多出来的第一件事是归属

`DefaultChannelPromise` 直接继承 `DefaultPromise<Void>`，同时实现 `ChannelPromise` 和 `FlushCheckpoint`，见 `DefaultChannelPromise.java:30-33`。

这条继承关系说明两件事：

- 它仍然沿用通用 Promise 的状态机、listener、await/sync 等机制。
- 它在此基础上再绑定一个具体的 `Channel`，并增加与 flush 相关的额外语义。

它最核心的新字段只有两个：

```text
channel     -> 这个 promise 属于哪个 Channel
checkpoint  -> 这次写/flush 在累计写出序列里的位置
```

先别急着看 checkpoint。先看 channel 绑定本身。

对通用 Promise 来说，`executor()` 只知道“通知该交给哪个 EventExecutor”；对 ChannelPromise 来说，还要回答：如果调用者没显式传 executor，那 listener 应该回到哪条线程？

当前 `DefaultChannelPromise.executor()` 的实现是：

- 如果父类已经有 executor，就用它。
- 否则回退到 `channel().eventLoop()`。

见 `DefaultChannelPromise.java:56-64`。

这条回退非常关键。它把 Promise 通知重新钉回了 EventLoop 线程亲和模型：

```text
这个写操作属于哪个 Channel
  -> 这个 Channel 属于哪个 EventLoop
  -> 这个 Promise 的默认通知线程就落回那个 EventLoop
```

所以 ChannelPromise 的价值不只是“多了个 `channel()` getter”，而是把异步结果和 Channel 归属重新绑紧了。

### 2. 为什么不能让 Channel write 的 listener 随便在哪个线程跑

设想一个出站写完成后的 listener 里继续做：

```text
future.addListener(f -> channel.close())
```

如果这个 listener 不回到 Channel 所属 EventLoop，而是在某个任意线程执行，就会重新把第 5 章好不容易收住的线程亲和问题放出来。Channel 的状态推进、Pipeline 里的后续动作、flush 计数更新，都可能被扯回多线程竞争。

这就是 `executor()` 回退到 `channel().eventLoop()` 的真正意义。它不是一个“顺手给个默认值”的便利函数，而是把 Promise 通知线程继续纳入 Channel 的归属纪律里。

```text
普通 Promise：谁创建，谁决定通知 executor
ChannelPromise：即使没显式给 executor，也优先回到 channel.eventLoop()
```

### 3. `checkDeadLock()` 为什么又要多看一眼 `isRegistered()`

上一节已经讲过，`DefaultPromise.checkDeadLock()` 只要发现当前线程已经在 executor 的 event loop 里，就会抛 `BlockingOperationException`。

`DefaultChannelPromise` 又多补了一层：只有 `channel().isRegistered()` 时，才调用父类的死锁检测，见 `DefaultChannelPromise.java:156-161`。

这条条件不是多余，而是说明 Channel 语义比纯 Promise 更具体。

```text
如果 Channel 还没注册到 EventLoop
  -> “我在 EventLoop 线程上 await 自己” 这件事还没完全成立

如果 Channel 已注册
  -> await 极有可能阻塞正负责推进这个 Channel 的那条线程
```

所以 ChannelPromise 的 deadlock 检测不是更宽，而是更精细。它利用了 Channel 自己的生命周期阶段，把“现在 await 到底危险不危险”判断得更接近真实执行语境。

### 4. FlushCheckpoint 为什么在 ChannelPromise 层，而不在通用 Promise 层

`DefaultChannelPromise` 实现了 `FlushCheckpoint`，暴露 `flushCheckpoint()` 和 `flushCheckpoint(long)`，见 `DefaultChannelPromise.java:141-149`。

这说明 checkpoint 不是所有 Promise 都共有的语义。它只对“写到 Channel 的哪一步了”有意义。

通用 Promise 只关心完成状态：

```text
未完成 / 成功 / 失败 / 取消
```

而 Channel 写路径还需要知道：

```text
这次 promise 对应的写出边界在累计写计数里的哪个位置
```

这是一条非常具体的 Channel outbound 约束，与普通异步任务、组合器、通知器完全无关。把它放到 Promise 基类，会把 Channel 的写路径知识污染到所有异步结果对象上。

所以 FlushCheckpoint 之所以在 ChannelPromise 层，不是因为 Netty 忘了抽象，而是因为它本来就不属于通用 Promise 语义。

## 二、`VoidChannelPromise`：当调用方明确说“我不关心结果”

### 1. 它不是“很快就完成的 Void Promise”

`VoidChannelPromise` 最容易被误解成：一个没有结果值、所以大概总会很快完成的 Promise。

当前源码根本不是这个意思。

`VoidChannelPromise` 继承的是 `AbstractFuture<Void>` 而不是 `DefaultPromise`，并且它几乎主动拒绝了大部分观察能力，见 `VoidChannelPromise.java:27-53`。

- `addListener(s)` 直接 `fail()`，抛 `IllegalStateException("void future")`，见 `VoidChannelPromise.java:56-66`、`:197-199`。
- `sync/syncUninterruptibly` 和带超时的 `await*` 会直接 fail；无参 `await()` 只处理中断后返回自身，不提供真正的等待语义，见 `VoidChannelPromise.java:81-116`、`:153-163`。
- `isDone/isSuccess/isCancelled/cause` 都不提供普通完成语义，见 `VoidChannelPromise.java:123-150`。

因此它不是“已经完成”或“会很快完成”的 Promise，而是：

```text
我明确声明：这次操作的结果不值得被 Future 语义完整观察
```

换句话说，它不是加速版结果对象，而是主动裁掉大部分观察能力的 API 契约。

### 2. 为什么需要这么激进的裁剪

如果某个调用方压根不关心结果，还把它包装成完整的 ChannelPromise，就意味着框架得继续保留：

- listener 注册能力
- await/sync 能力
- 结果状态查询能力
- 相关对象和错误使用路径

这在大量“我就是 fire-and-forget 写一下”场景里，会让调用方误以为自己仍然可以监听或等待，反而模糊了意图。

`VoidChannelPromise` 的设计非常鲜明：

```text
你说你不关心结果
那我就把“关心结果”的大部分入口都关掉
```

这比“给你一个普通 promise，但你自己别用那些方法”更诚实，也更能在误用时尽快报错。

### 3. 它仍然可以选择把异常 fire 回 pipeline

`VoidChannelPromise` 构造时可以选择是否安装 `fireExceptionListener`，见 `VoidChannelPromise.java:29-53`。当 `setFailure` 或 `tryFailure` 被调用时，它不会像普通 Promise 那样保存失败结果，而是调用 `fireException0(cause)`，见 `VoidChannelPromise.java:166-180`。

`fireException0` 还有一层边界：只有 channel 已 registered 时，才向 pipeline `fireExceptionCaught(cause)`，见 `VoidChannelPromise.java:230-238`。

这说明 VoidChannelPromise 并不是“彻底吞掉一切错误”。它表达的是：

```text
我不保留这次操作的可观察结果对象
但必要时仍可把 failure 作为 pipeline 事件传播
```

也就是说，它裁掉的是 Future 观察能力，不是整个系统的错误路径。

### 4. `unvoid()` 是把“我又想关心结果了”变回普通 Promise

如果后来你又需要一个可观察结果，`unvoid()` 会创建一个新的 `DefaultChannelPromise(channel)`；如果有 `fireExceptionListener`，还会把它挂到新 promise 上，见 `VoidChannelPromise.java:217-223`。

这条路径很有意思：它说明 Void 并不是“完全不可逆”的死路，而是一种默认轻量模式。需要完整结果语义时，可以显式退回普通 ChannelPromise。

因此最该记住的不是“VoidPromise 很轻”，而是：

```text
VoidChannelPromise 是一个明确的意图声明：我默认不关心结果
需要重新关心时，显式 unvoid 回完整 Promise
```

## 三、`ScheduledFutureTask`：定时任务不是“一次完成的 PromiseTask”

### 1. 一次性任务和周期任务的根本差别

`PromiseTask` 的模型是：运行一次，写入 success 或 failure，然后进入终态。

`ScheduledFutureTask` 在此基础上多了两个关键字段：`deadlineNanos` 和 `periodNanos`，见 `ScheduledFutureTask.java:27-33`。

其中：

- `periodNanos == 0`：一次性定时任务。
- `periodNanos > 0`：固定频率（fixed-rate）周期任务。
- `periodNanos < 0`：固定延迟（fixed-delay）周期任务。

这说明周期调度不是通过“每次再 new 一个 PromiseTask”实现的，而是通过同一个任务对象不断更新 deadline 并重新入队。

### 2. `run()` 里真正分了三条路

当前 `ScheduledFutureTask.run()` 的主线是：

1. 如果还没到 deadline，就重新放回调度队列或在取消时移除。
2. 如果是一次性任务（`periodNanos == 0`），就走 `setUncancellableInternal -> runTask -> setSuccessInternal`。
3. 如果是周期任务，只要没取消，就执行 `runTask()`，然后按 period 的正负更新下一次 `deadlineNanos`，并重新 `scheduleFromEventLoop(this)`。

见 `ScheduledFutureTask.java:146-181`。

最重要的区别是第二、第三条：

```text
一次性任务
  -> 跑完后完成 Promise

周期任务
  -> 跑完后不把自己变成 success
  -> 重新计算下一次 deadline
  -> 再次入队
```

这正是为什么 ScheduledFutureTask 不能简单看成“多了个 deadline 的 PromiseTask”。一旦有 period，它的生命周期就不再是“完成一次就终止”。

### 3. fixed-rate 和 fixed-delay 的差别在 deadline 重算方式

周期任务真正的语义差异，不在名字，而在 `deadlineNanos` 怎么更新：

- `periodNanos > 0`：`deadlineNanos += periodNanos`
- `periodNanos < 0`：`deadlineNanos = now - periodNanos`

见 `ScheduledFutureTask.java:168-175`。

这意味着：

```text
fixed-rate
  -> 以上一次计划时间为基准继续前推

fixed-delay
  -> 以上一次实际执行完成时间为基准重新起算
```

所以 fixed-rate 更像“节拍表”，fixed-delay 更像“上一次做完后再等一段”。这两者对慢任务的行为完全不同。

### 4. 为什么比较顺序还要加一个 id

`ScheduledFutureTask` 既实现 `ScheduledFuture`，也实现 `PriorityQueueNode`。比较时先比 `deadlineNanos`，如果 deadline 相同，再比 `id`，见 `ScheduledFutureTask.java:126-143`。

这条规则的意义不是复杂排序，而是让“相同到期时间的任务”也有稳定先后。否则优先队列在完全相同 deadline 下就没有确定性的次序依据。

这类稳定 tie-break 在异步调度里很重要，因为“看起来同时到期”的任务如果没有稳定顺序，调试和复现都会更难。

## 四、`ProgressivePromise`：结果还没完成，但进度已经值得通知

### 1. 进度不是结果，它是结果之前的中间信号

`ProgressivePromise<V>` 在 `Promise<V>` 基础上增加了两类方法：`setProgress` 和 `tryProgress`，见 `ProgressivePromise.java:21-34`。

它要表达的不是“这个异步操作已经成功”，而是：

```text
它还没完成
但已经推进到了某个中间位置
```

这和普通 Promise 的终态信号完全不同。普通 Promise 只关心“最后成没成”；ProgressivePromise 允许在“最终成功/失败”之前，多次发布中间进度。

### 2. `total = -1` 是“总量未知”的显式哨兵

`DefaultProgressivePromise.setProgress` 对 `total < 0` 做了归一化处理：把 total 记成 -1，并且只要求 `progress >= 0`；若 total 已知，则还要求 `0 <= progress <= total`，见 `DefaultProgressivePromise.java:37-54`。

这条规则非常重要，因为现实里并不是每个流式任务都提前知道总量。比如某些流式下载、边读边解码、未知长度的上传场景，只能知道“已经推进了多少”，却不知道终点多大。

所以 progressive 模型并没有强迫“必须先知道 total 才能汇报进度”，而是把“未知总量”显式变成了一个哨兵状态。

### 3. `setProgress` 和 `tryProgress` 的差别和普通 Promise 一致

`setProgress` 在非法区间或 Promise 已完成时会抛异常；`tryProgress` 在这些情况下返回 false，见 `DefaultProgressivePromise.java:37-69`。

这和 `setSuccess/trySuccess` 的设计一致：

```text
setXxx  -> 我预期这一步必须成立，不成立就是状态机错误
tryXxx  -> 我承认这里可能竞争或晚到，失败是正常分支
```

进度通知也需要这层区分。否则清理路径、竞态路径或晚到的进度更新就只能靠异常来表达，控制流会很别扭。

### 4. Channel 绑定版 progressive promise 只是再补一层归属

`DefaultChannelProgressivePromise` 继承 `DefaultProgressivePromise<Void>`，同时实现 `ChannelProgressivePromise` 和 `FlushCheckpoint`，见 `DefaultChannelProgressivePromise.java:29-33`。

它的 `executor()` 同样回退到 `channel().eventLoop()`，`checkDeadLock()` 同样在 channel 已 registered 时才触发，checkpoint 也照样存在，见 `DefaultChannelProgressivePromise.java:56-64`、`:148-167`。

这说明 progressive 和 channel 绑定不是两条互斥分支，而是可以叠加的两个维度：

```text
一维：是否需要进度通知
一维：是否需要绑定到某个 Channel/flush 语义
```

## 五、最容易错的五个判断

### 1. ChannelPromise 只是多了个 `channel()` 方法

不成立。它还把 executor 默认回退到 `channel().eventLoop()`，并把 deadlock 检测和 flush checkpoint 与 Channel 生命周期绑定。

### 2. VoidChannelPromise 就是一个已经完成的 `Future<Void>`

不成立。它主动拒绝 listener/await/sync，大部分状态查询也没有普通完成语义；它表达的是“我不关心结果”，不是“结果已经完成”。

### 3. fixed-rate 和 fixed-delay 只是名字不同

不成立。当前实现里两者的 deadline 重算公式不同：一个以上一次计划时间推进，一个以上一次实际完成时间推进。

### 4. 周期性 `ScheduledFutureTask` 每次 run 都会 setSuccess

不成立。只有非周期任务才在 run 后完成 promise；周期任务会重新计算 deadline 并再次入队。

### 5. ProgressivePromise 的进度就是 success 的另一种写法

不成立。进度是完成前的中间通知，不替代最终 success/failure 结果。

## 收网：Promise 的特化，是把现实约束写回异步协议里

现在可以回到开篇的问题：为什么在通用 Promise 之外，还会有这么多看似“特殊”的变体？

因为现实的异步操作本来就不只是一种形状：

```text
ChannelPromise
  -> 结果属于某个 Channel，通知线程要回到 channel.eventLoop

VoidChannelPromise
  -> 调用方明确不关心结果，只保留必要的异常传播

ScheduledFutureTask
  -> 结果可能不是一次性终态，而是反复到期和重入队

ProgressivePromise
  -> 完成前就需要多次报告中间进度
```

它们并没有推翻 Promise/Future 的通用模型，而是在其上把不同业务约束显式化：线程归属、flush 序号、无结果、周期调度、进度通知。

所以 Ch6 最终留下的主结论不是“Netty Promise 家族很多”，而是：

```text
Promise/Future 的价值不只在统一异步结果
还在于它能承载越来越具体的业务约束
而不必退回每个子系统各写一套回调协议
```

下一章进入 Pipeline。因为到这里为止，我们已经知道：EventLoop 决定什么时候做，Promise 决定结果怎么回来；接下来要回答的就是，数据真正流进 Channel 以后，是谁在管道里接住它、处理它、再把它写出去。