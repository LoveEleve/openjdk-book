# 组合器与已完成 Future：当一个 Promise 不够时，Netty 怎么编排

> 本文基于当前 Netty `CompleteFuture` / `SucceededFuture` / `FailedFuture` / `PromiseCombiner` / `PromiseNotifier` / `PromiseTask` 实现。前置：Ch6-01 `01-state-model-and-listeners.md`；本文解释“已完成结果”“多 Future 汇总”“结果级联”和“Runnable/Callable 桥接 Promise”的核心模型，不展开 ChannelPromise 特化与 scheduled/progressive 细节。

## 单个 Promise 解决的是“一次完成”，但真实异步链往往不止一次

上一节我们把 Promise/Future 的基本结果模型建立起来了：

- Future 只读，Promise 可写。
- `DefaultPromise.result` 用一个字段编码完成状态。
- listener 是异步主路径，`await/sync` 是阻塞备选。

但一旦离开单个操作，这套模型还不够。

很快会遇到三类新问题：

1. 有些操作一开始就已经完成了，我还需要走完整的 Promise 状态机吗？
2. 我有 3 个、30 个甚至 300 个异步 Future，怎么在它们“全都完成以后”再继续？
3. 我手上有一个 Runnable/Callable，想把它放进 Executor 里跑，但又想继续使用 Promise/Future 这套通知语义，怎么桥接？

这就是 Ch6 第二篇要讲的内容。它看起来像几块零散工具，实际上都在回答同一个问题：

```text
当“单个异步结果”不再够用时
Netty 怎样继续保持 Promise/Future 的统一语义
```

这篇文章的主线有四个角色：

```text
CompleteFuture  -> 结果一开始就已经确定
PromiseCombiner -> 多个 Future 全部完成后再给一个总结果
PromiseNotifier -> 一个 Future 完成后，把结果级联到其他 Promise
PromiseTask     -> 把 Runnable/Callable 桥接到 Promise 体系
```

它们分别解决“已完成”“聚合”“级联”“桥接”四种不同场景，但背后的设计目标一致：不要让异步编排退回到手写 if/else、手动计数和自定义回调嵌套。

## 一、CompleteFuture：结果已经确定，通知就不该再绕远路

### 1. 先完成的 Future，不需要再维护 listener 列表

`CompleteFuture` 的定位非常明确：它表示一个已经完成的 Future，见 `CompleteFuture.java:23-25`。

这意味着它从一开始就满足两个条件：

```text
isDone() == true
结果状态不会再变化
```

既然不会再变化，那么它就不需要像 `DefaultPromise` 那样维护 `result` 的可变状态机，也不需要为“未来某个时间点通知 listener”保留一套 listener 列表。因为这个“未来”已经到了。

当前实现里，`addListener` 和 `addListeners` 不是把回调先收起来等以后完成，而是直接调用 `DefaultPromise.notifyListener(executor(), this, listener)`，见 `CompleteFuture.java:46-63`。

这条路径的核心不是“代码更短”，而是减少了一整个阶段：

```text
普通 Promise
  -> 注册 listener
  -> 某个时刻完成
  -> 再通知 listener

CompleteFuture
  -> 注册 listener 时，结果已经确定
  -> 直接进入通知路径
```

### 2. “立即通知”不等于“总在当前线程裸调用”

这里要特别收一道边界。很多资料会把 CompleteFuture 简化成“addListener 时就在当前线程同步直接调用 listener”。当前源码事实更细一点：`CompleteFuture.addListener()` 走的是 `DefaultPromise.notifyListener(executor(), ...)`，见 `CompleteFuture.java:46-49`。

而 `DefaultPromise.notifyListener(...)` 内部还会考虑两件事：

- 当前线程是不是这个 executor 的 event loop 线程。
- 当前 listener 通知递归栈深是否超过阈值。

如果条件不合适，它仍可能把通知封装成任务交给 executor，见 `DefaultPromise.java:490-549`。

因此 CompleteFuture 的真正优势不是“保证当前线程内联执行”，而是：

```text
结果不用再等未来完成
listener 可以立刻进入通知协议
至于最终是同步回调还是经 executor 调度
仍遵守 DefaultPromise 的通知保护规则
```

这点和上一节的 listener 栈深保护是连着的。Netty 不会因为 future 已完成，就放弃对递归通知和线程归属的保护。

### 3. `SucceededFuture` 和 `FailedFuture` 分别把终态钉死

`SucceededFuture` 持有一个 `result`，`isSuccess()` 恒为 true，`cause()` 恒为 null，`getNow()` 直接返回结果，见 `SucceededFuture.java:23-49`。

`FailedFuture` 则持有一个不可为 null 的 `cause`，`isSuccess()` 恒为 false，`cause()` 直接返回异常，`getNow()` 返回 null，而且 `sync()/syncUninterruptibly()` 会直接把异常抛出去，见 `FailedFuture.java:26-67`。

这两者和 `DefaultPromise` 的差别不在于“一个能成功一个能失败”，而在于：

```text
DefaultPromise  -> 还没完成，需要状态转移
SucceededFuture -> 终态已知，不再转移
FailedFuture    -> 终态已知，不再转移
```

所以 CompleteFuture 系列是对“立即完成场景”的专门优化。它没有取消 Promise/Future 的统一接口，只是省掉了本来就不需要的那部分可变状态和延迟通知成本。

### 4. 为什么 removeListener 可以是 NOOP

`CompleteFuture.removeListener(s)` 和 `removeListeners(s...)` 直接 NOOP，见 `CompleteFuture.java:65-75`。

这不是偷懒，而是由前面的“立即进入通知路径”直接推出来的：如果 listener 没有被存进等待列表，而是在 add 的那一刻就已被通知，那后面再 remove 就没有实质对象可移除了。

这一点也顺便说明 CompleteFuture 的使用边界：它适合表达“结果已经定型”的异步对象，而不适合伪装成一个未来还会继续接受状态变动的 Promise。

## 二、PromiseCombiner：多个 Future 都做完以后，再完成一个聚合 Promise

### 1. 它解决的不是“级联通知”，而是“全部收齐后再给总答案”

假设你发出了三次异步写：

```text
f1 = write(req1)
f2 = write(req2)
f3 = write(req3)
```

如果业务要求“这三次全都完成后，再继续下一步”，单靠给每个 Future 分别挂 listener 很快会写出计数器、共享异常变量和复杂回调嵌套。

`PromiseCombiner` 正是把这件事抽成一个单独对象。它维护四个关键状态：

- `expectedCount`：总共要等多少个 future。
- `doneCount`：已经完成了多少个。
- `aggregatePromise`：最终要通知谁。
- `cause`：第一个观察到的失败原因。

见 `PromiseCombiner.java:35-40`。

它要表达的不是“一个 future 完成时把结果传给另一个 promise”，而是：

```text
我先登记一批 future
等它们全都结束以后
再把一个总结果写进 aggregatePromise
```

### 2. 它的使用顺序是三段式：add -> finish -> aggregate

当前 API 明确分成三个阶段：

1. `add(future)` / `addAll(...)`
2. `finish(aggregatePromise)`
3. 内部 listener 观察所有子 future 完成后 `tryPromise()`

`add(Future)` 会先检查是否还允许添加，再检查当前线程是否在指定 `EventExecutor` 内，然后 `expectedCount++` 并给子 future 注册内部 listener，见 `PromiseCombiner.java:101-112`、`:163-177`。

`finish(Promise<Void>)` 则把 aggregate promise 锁定下来。之后再 add 就会抛 `IllegalStateException`，见 `PromiseCombiner.java:140-177`。

所以它不是一个“随时动态合并 future 的列表”，而是一个有明显生命周期边界的编排器：

```text
准备阶段：不断 add
封口阶段：finish
等待阶段：内部 listener 观察 doneCount == expectedCount
```

这种三段式设计有个直接好处：调用方很容易知道“什么时候还可以继续登记子任务，什么时候已经进入收尾”。

### 3. 为什么它要求必须在指定 EventExecutor 线程内调用

`PromiseCombiner` 类注释明确写着：实现不是线程安全的，所有方法都必须从指定 `EventExecutor` 线程调用，见 `PromiseCombiner.java:20-34`。`checkInEventLoop()` 也会在 add/finish 时强制检查，不在 event loop 线程就抛 `IllegalStateException`，见 `PromiseCombiner.java:163-166`。

这条限制不是拍脑袋定下的，而是和第 5 章 EventLoop 的单线程骨架一脉相承：

```text
既然异步状态本来就倾向在 EventLoop 线程推进
组合器也就干脆要求在同一条线程里维护自己的计数和 cause
```

这样，`expectedCount`、`doneCount`、`cause` 和 `aggregatePromise` 都不需要额外锁来协调。代价是你失去了“任意线程随手 add/finish”的自由；收益是状态机本身保持简单。

### 4. 为什么只记第一个 cause

内部 listener 的 `operationComplete0()` 每完成一个子 future，就 `doneCount++`；如果这个 future 失败且当前 `cause == null`，就把它的失败原因记下来，见 `PromiseCombiner.java:40-65`。

这意味着：

```text
多个 future 同时失败
  -> aggregatePromise 最终只会记录其中一个 cause
  -> 到底是哪一个，源码明确说是 undefined
```

类注释也直接承认了这一点：如果多个 future 都失败，aggregate promise 会失败，但到底采用哪个 cause，没有顺序保证，见 `PromiseCombiner.java:21-25`。

这是一个设计选择，而不是遗漏。`PromiseCombiner` 要表达的是“全部成功才成功，否则总失败”，不是“收集所有失败详情”。如果你的业务需要保留全部失败原因，就该在更高层单独收集，而不是期待 combiner 自动变成错误报告器。

### 5. 为什么最终写 aggregatePromise 用的是 `trySuccess/tryFailure`

当 `doneCount == expectedCount` 且 aggregatePromise 已经设置好时，`tryPromise()` 会：

- `cause == null` -> `aggregatePromise.trySuccess(null)`
- 否则 -> `aggregatePromise.tryFailure(cause)`

见 `PromiseCombiner.java:157-170`。

这里用的是 try，不是 set。原因也很直接：组合器只想尽最大努力完成总 promise，而不想因为竞态或重复触发再抛出一层新的 `IllegalStateException`。

尤其是在边界时序里，最后几个 future 可能非常接近地完成。使用 try 让“只允许第一个完成 aggregate 的动作成功”这条规则继续保持一致。

## 三、PromiseNotifier：一个 Future 完成后，把结果级联到其他 Promise

### 1. 它和 Combiner 解决的不是同一类问题

`PromiseCombiner` 关注的是“等一组 future 全部结束后再通知一个 aggregate promise”。

`PromiseNotifier` 则是另一种关系：一个 Future 完成后，把它的成功、失败或取消结果转发到一个或多个 Promise，见 `PromiseNotifier.java:25-37`、`:112-130`。

也就是说：

```text
Combiner  = 多 -> 一，等全体
Notifier  = 一 -> 多，结果传播
```

这两种关系很容易在概念上混淆。如果不先区分，就会把 `cascade` 看成一种“组合器语法糖”，或者把 combiner 理解成“批量 notifier”。当前源码两者的状态机和使用动机完全不同。

### 2. `cascade` 还额外处理了双向取消传播

`PromiseNotifier.cascade(future, promise)` 做了两件事：

1. 给 `promise` 挂一个 listener：如果 promise 被取消，就尝试 `future.cancel(false)`。
2. 给 `future` 挂一个 `PromiseNotifier`：future 完成后，把结果通知 promise。

实现见 `PromiseNotifier.java:75-110`。

因此 cascade 不是单向转发，而是：

```text
future 完成 -> 通知 promise
promise 取消 -> 反向取消 future
```

这是一种典型的“结果和取消都要同步”的桥接关系。它比普通 notifier 多了一层双向耦合，因此也更容易踩循环传播的坑。

### 3. 为什么要特判“两个都已经取消”的情况

`cascade` 创建的匿名 notifier 在 `operationComplete` 里先检查：如果 `promise.isCancelled()` 且 `future.isCancelled()`，就直接 return，见 `PromiseNotifier.java:99-107`。

这就是当前实现对双向取消死循环的最小防护：

```text
promise 取消 -> future.cancel(false)
future 取消完成 -> 再通知 promise
如果此时两边都已经是取消态
  -> 不再继续级联
```

这里不要夸大成“绝对完美的双向状态同步协议”。当前源码能支撑的事实是：它显式防止了已经双取消时的继续级联，避免最直接的死循环。

### 4. 为什么构造器要 clone promises 数组

`PromiseNotifier` 构造器会对传入 promises 执行 `clone()`，见 `PromiseNotifier.java:54-61`。这是一条防御性复制：通知器不希望外部在构造后再偷偷改动 promise 数组内容，从而影响后续传播目标。

这再次体现出异步编排工具的一条常见原则：一旦注册完成，后续传播目标应尽量固定，避免“对象图在传播过程中被外部重写”。

## 四、PromiseTask：把 Runnable/Callable 直接接进 Promise 体系

### 1. 它不是普通 FutureTask 的翻版，而是桥接器

`PromiseTask<V>` 继承 `DefaultPromise<V>`，同时实现 `RunnableFuture<V>`，见 `PromiseTask.java:21-21`。

这意味着它一头连着 JDK executor 语义：可以被当作 `Runnable`/`Callable` 提交执行；另一头连着 Netty promise 语义：可以 `addListener`、`sync()`、`cause()`、`getNow()`。

所以它解决的问题不是“如何再实现一个 FutureTask”，而是：

```text
如何让一段可执行任务
天然拥有 Promise/Future 的异步通知语义
```

### 2. `run()` 自己负责把执行结果写回 Promise

当前 `run()` 模板是：

```text
if (setUncancellableInternal()) {
    result = runTask()
    setSuccessInternal(result)
}
catch (Throwable e) {
    setFailureInternal(e)
}
```

见 `PromiseTask.java:102-112`。

这条路径说明 PromiseTask 的完成权并不对外开放，而是收敛在 `run()` 内部：只有真正执行这段任务的代码，才有资格写入成功或失败结果。

这和上一节 Promise 的“读写分离”完全一致。只不过这里，写入者不是外部某个 EventLoop 回调，而是 PromiseTask 自己的 `run()`。

### 3. 为什么公开 `setSuccess/trySuccess/setFailure` 都被禁掉

PromiseTask 覆盖了公开的 `setSuccess`、`trySuccess`、`setFailure`、`tryFailure`、`setUncancellable`，并直接抛 `IllegalStateException` 或返回 false，见 `PromiseTask.java:125-177`。

这不是为了“限制用户自由”，而是为了守住它的角色：

```text
PromiseTask 的状态
应该由它包装的那段任务执行结果决定
而不是由外部某个调用者随手改写
```

如果允许外部直接 `setSuccess()`，那 PromiseTask 就会失去作为 `Runnable/Callable -> Promise` 桥接器的意义：调用者完全可以在任务真正运行前就篡改结果状态。

因此 PromiseTask 的 promise 能力是“可观察的”，不是“对所有人都可写的”。

### 4. 哨兵 Runnable 解决的是“完成后再被调度一次怎么办”

`PromiseTask` 内部定义了 `COMPLETED`、`CANCELLED`、`FAILED` 三个哨兵 Runnable，完成后会用它们替换原始 task，见 `PromiseTask.java:44-46`、`:114-123`。

这样做的目的不是为了好看，而是为了在某些重复调度或取消边界里，避免再次执行原始任务，同时还能从 `toString()` 等调试路径上看出它已经进入什么终态。

也就是说，它把“原始任务已经没有必要再跑”的事实也编码进了对象内部，而不是只靠一个完成状态字段隐含表示。

## 五、最容易错的五个判断

### 1. 已完成的 Future 加 listener 一定在当前线程裸调用

不成立。当前 `CompleteFuture.addListener()` 走的是 `DefaultPromise.notifyListener(executor(), ...)`；是否内联，还要看 executor 线程归属和栈深保护。

### 2. PromiseCombiner 会收集所有失败 cause

不成立。它只记第一个观察到的失败 cause；多个失败时，哪个 cause 最终进入 aggregate promise，源码明确说是 undefined。

### 3. PromiseNotifier 和 PromiseCombiner 差不多

不成立。Combiner 是“多 future 全部完成后再汇总到一个 promise”；Notifier/cascade 是“一个 future 完成后把结果传播到一个或多个 promise”。

### 4. `cascade` 只是单向结果传播

不成立。当前实现还把取消从 promise 反向传播到 future，并对“双取消已成立”的情况做了短路防护。

### 5. PromiseTask 既然继承 DefaultPromise，外部自然可以直接 setSuccess

不成立。当前实现显式禁掉了这些公开写入口，完成权只属于 `run()` 内部执行路径。

## 收网：一批异步结果，不该逼调用方退回手写回调地狱

现在可以把这篇压成四类角色：

```text
CompleteFuture
  -> 结果一开始就确定，直接进入通知协议

PromiseCombiner
  -> 一组 Future 全部结束后，给一个 aggregate Promise 定总结果

PromiseNotifier / cascade
  -> 一个 Future 完成后，把结果和取消传播给别的 Promise

PromiseTask
  -> 把 Runnable/Callable 直接桥接进 Promise/Future 体系
```

它们共同解决的，不是“某一个 Future 怎么完成”，而是“当异步关系开始组合、传播、桥接时，还能不能继续沿用同一套 Promise/Future 语义”。

如果没有这些工具，调用方迟早会退回到：

- 手写计数器等所有写操作完成。
- 手写回调把一个 future 的结果塞给另一个 promise。
- 手写 Runnable 包装，把异常和结果塞回自定义容器。

而有了它们，Netty 仍然能把这些更复杂的异步关系维持在同一套抽象里。

这也正好为下一篇做桥接：前两篇讲的是通用 Promise/Future 语义和通用组合器，但真正贴近业务 API 的，是 `ChannelPromise`、void promise、scheduled/progressive 这些和 Channel 生命周期更强绑定的变体。下一篇就进入这一层。