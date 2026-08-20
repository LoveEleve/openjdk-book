# Promise/Future 的核心：异步操作做完以后，结果怎么回来

> 本文基于当前 Netty `Future` / `Promise` / `DefaultPromise` / `DefaultChannelPromise` 实现。前置：Ch5 EventLoop 四篇；本文只讲读写分离、`result` 单字段状态编码、listener 存储与通知、`await/sync` 死锁检测和取消 cause 的懒创建，不展开组合器和 ChannelPromise 的更多特化。

## EventLoop 决定了“什么时候做”，Promise/Future 决定“做完以后怎么办”

第 5 章把 EventLoop 的驱动骨架讲完整了：

- Channel 的 register、read/write、flush 都回到所属 EventLoop 线程。
- EventLoop 在 I/O 和任务之间交替推进。
- Selector 的就绪事件最终都会被 loop 消费。

但 EventLoop 解决的是“什么时候做”和“谁来做”，没有回答另一个 equally 关键的问题：

```text
某个异步动作已经发出之后
调用方怎么知道它成功了、失败了、还是还没完成？
```

比如：

```text
ChannelFuture f = channel.connect(remote)
```

这一行返回时，连接通常还没完成。调用方此刻真正需要的，不是“一个将来可能会有结果的黑盒”，而是一套可操作语义：

- 我现在能不能判断它成功？
- 如果失败了，异常放在哪？
- 我要阻塞等它，还是注册回调？
- 谁拥有把结果写进去的权力？

Netty 对这个问题的回答不是单个类，而是一组分工：

```text
Future  -> 只读结果视图
Promise -> 可写结果视图
DefaultPromise -> 当前最核心的状态机和通知实现
```

所以这一章真正要讲的，不是“Future 有哪些方法”，而是这套异步结果模型的三条主线：

1. 读和写为什么要分开。
2. 一个异步结果如何用一个字段编码状态。
3. listener 和 await 为什么是两种完全不同的等待方式。

## 一、先把读和写分开：调用方看到 Future，执行方拿 Promise

### 1. `Future` 只回答“现在结果怎么样了”

Netty 的 `Future<V>` 接口继承自 `java.util.concurrent.Future<V>`，但它加上了更适合异步 I/O 的方法：`isSuccess()`、`isCancellable()`、`cause()`、`addListener(...)`、`sync()`、`await()`、`getNow()` 等，见 `Future.java:26-168`。

这组方法的核心不是写结果，而是读结果：

```text
isSuccess()     -> 成功了吗
cause()         -> 失败原因是什么
isDone()        -> 完成了吗
getNow()        -> 不阻塞地拿当前结果
addListener()   -> 完成后请通知我
await()/sync()  -> 我选择阻塞等待
```

这正是调用方的视角。调用方发起异步操作之后，通常没有资格也没有能力把这个结果写成成功或失败；它只能观察或等待。

### 2. `Promise` 才拥有写入权

`Promise<V>` 在 `Future<V>` 基础上增加了可写入口：`setSuccess`、`trySuccess`、`setFailure`、`tryFailure`、`setUncancellable`，见 `Promise.java:21-90`。

这意味着 Promise 和 Future 的根本差别不是“多几个方法”，而是角色差别：

```text
Future  = 我只能看结果
Promise = 我可以把结果写进去
```

这条读写分离是 Netty 异步模型的第一条纪律。如果所有人都能把一个 future 改成 success/failure，状态机会立刻失控：到底谁的结果算数？失败之后还能不能再成功？多个线程同时写时如何决定胜负？

把写入权集中到 Promise，一下子就把这些问题收束成“谁是这个异步动作的完成者”。在 Netty 的典型场景里，这通常就是 EventLoop 或底层执行者：

```text
调用方拿到 Future
EventLoop/执行方持有 Promise
操作完成时由执行方 setSuccess / setFailure
```

### 3. 为什么不直接满足于 JDK `Future.get()`

如果只用 JDK Future，调用方最直觉的消费方式是：

```text
result = future.get()
```

但对网络框架来说，这条路有两个问题。

第一，`get()` 的主语是阻塞等待。它适合少量异步结果的收尾，不适合把“完成通知”当作一等语义。Netty 里大量操作都应该由回调触发后续动作，而不是靠大量线程卡在 `get()`。

第二，JDK Future 没有把 listener 注册作为主线能力暴露出来。Netty 则直接把 `addListener` 放进 `Future` 接口，见 `Future.java:49-81`。这说明它从一开始就承认：

```text
在异步网络模型里
回调注册不是附加能力
而是主路径
```

这也解释了为什么这一章必须紧跟 EventLoop：当一切操作都不再同步完成，异步结果传播本身就成了框架骨架的一部分。

## 二、一个 `result` 字段，怎么装下成功、失败、取消和未完成

### 1. 不是 5 个布尔位，而是一个 `volatile Object`

`DefaultPromise` 里最重要的字段只有一个：

```text
private volatile Object result;
```

围绕它，当前实现还定义了三个哨兵/包装对象：`SUCCESS`、`UNCANCELLABLE` 和 `CANCELLATION_CAUSE_HOLDER`，以及用于 CAS 的 `RESULT_UPDATER`，见 `DefaultPromise.java:55-63`。

这意味着 DefaultPromise 的核心状态机不是“好多布尔字段叠在一起”，而是：

```text
null                  -> 未完成，可取消
SUCCESS               -> 成功完成，但返回值为 null/Void
UNCANCELLABLE         -> 尚未完成，但已经不可取消
CauseHolder(cause)    -> 失败或取消
普通结果对象 V         -> 成功完成，且结果值非 null
```

其中取消也是用 `CauseHolder` 表达的，只不过初始存进去的是专用的取消 cause holder。

这就是大纲里所谓“5 态编码”的当前源码落点：不是五个 enum，也不是五个布尔位，而是“一个字段 + 几个特殊对象”。

### 2. 为什么成功时还需要 `SUCCESS` 这个哨兵

最容易被忽略的一种成功，是“成功了，但没有返回值”。比如很多 `Promise<Void>` 场景，或者只关心完成与否、不关心 payload 的操作。

如果不用哨兵，只靠 `result == null` 表达“没有结果值”，就会和“还没完成”冲突。

因此 `setSuccess(null)` 实际会把 `SUCCESS` 写进 result，见 `DefaultPromise.java:638-640`。这让以下两个状态被明确区分：

```text
result == null     -> 还没完成
result == SUCCESS  -> 已成功完成，只是没有返回值
```

`isSuccess()` 的实现也体现了这点：只要 result 非 null、不是 `UNCANCELLABLE`、也不是 `CauseHolder`，就算成功，见 `DefaultPromise.java:144-148`。

这是一条非常经济的设计：一份单字段状态既保留了“未完成”和“成功但无值”的差别，又不需要额外布尔位。

### 3. `UNCANCELLABLE` 不是 done，它只是把取消通道关掉

`setUncancellable()` 会尝试把 `result` 从 null CAS 成 `UNCANCELLABLE`，见 `DefaultPromise.java:135-142`。这一步并不意味着 future 已经成功或失败，它只是把“还没完成但可以取消”变成“还没完成但不再允许取消”。

所以 `UNCANCELLABLE` 处于一个很特殊的位置：

```text
它不是成功
它不是失败
它不是取消
它也不是普通的未完成
```

更准确地说，它表示“完成权还保留给执行方，但取消权已经不再开放”。之后如果操作正常结束，`setValue0` 允许从 `UNCANCELLABLE` 再 CAS 到真正结果，见 `DefaultPromise.java:646-655`。

这个状态的存在说明 Promise 状态机并不是简单线性：它不仅要表达“完成没完成”，还要表达“完成之前，取消权是否还存在”。

### 4. 失败和取消都经由 `CauseHolder`

`cause()` 并不靠 `result instanceof Throwable` 判断失败，而是通过 `CauseHolder` 包装异常，见 `DefaultPromise.java:171-188`。这避免了另一种冲突：如果 V 本身恰好就是一个 Throwable 对象，你不能光靠类型判断它是“成功结果”还是“失败原因”。

因此失败和取消最终都会经过：

```text
result = new CauseHolder(cause)
```

只不过取消路径有专门的初始占位符，后面还会做懒替换。这个我们放到最后一节再讲。

### 5. 为什么状态转移要用 CAS

异步操作最大的危险之一，是多个竞争者都认为自己有资格完成 promise。

比如：

- 一个线程检测到连接成功，想 `setSuccess()`。
- 另一个线程同时检测到超时，想 `setFailure()`。
- 第三个线程还可能在做 `cancel()`。

如果状态写入不是原子的，就可能发生“后来者覆盖前者”的混乱。`DefaultPromise.setValue0` 的核心就是：只有 `result == null` 或 `result == UNCANCELLABLE` 时，CAS 才允许把结果写入，见 `DefaultPromise.java:646-655`。

这意味着 Promise 的完成语义是：

```text
第一个成功完成状态转移的人获胜
之后所有完成尝试都失败或抛异常
```

于是：

- `setSuccess` / `setFailure`：失败时抛 `IllegalStateException`。
- `trySuccess` / `tryFailure`：失败时返回 false。

当前实现见 `DefaultPromise.java:109-133`。

这正是 set/try 两组 API 同时存在的原因：一组表达“这里完成必须成功，否则就是编程错误”，另一组表达“这里存在竞争，失败是正常结果”。

## 三、listener 不是附属品，而是异步模型的主路径

### 1. 先别把 listener 想成“一个 List”

很多人第一次看 Promise，会自然脑补成：内部大概有个 `List<Listener>`，完成时遍历一遍。

当前 `DefaultPromise` 不是这样写的。它有两个字段：

- `listener`：保存单个 listener。
- `listeners`：保存 `DefaultFutureListeners` 聚合对象。

见 `DefaultPromise.java:66-83`。

这背后的优化动机非常朴素：大部分 future 不会挂很多监听器。为 0 或 1 个 listener 预先创建集合对象，浪费比收益更大。

### 2. 当前实现的渐进升级是“单 listener -> 聚合容器”

`addListener0` 的逻辑是：

```text
还没有 listener
  -> 直接放到 listener 字段
已经有一个 listener，且还没有聚合容器
  -> 创建 DefaultFutureListeners，把原 listener 和新 listener 一起放进去
已经有聚合容器
  -> 继续 add 到聚合容器
```

实现见 `DefaultPromise.java:612-623`。

这和一些旧资料里常见的“null -> 单 listener -> 长度为 2 的数组 -> 再升级”的讲法不同。当前源码显式结构是“单 listener / DefaultFutureListeners”两层，而不是把数组[2] 作为独立状态写在 `DefaultPromise` 里。

这也再次说明：正文必须以当前源码为准，不能把曾经见过的旧实现习惯性写进来。

### 3. 已经完成的 future，`addListener` 会立即触发通知

`addListener` 在把 listener 挂进去之后，会检查 `isDone()`；如果 future 已经完成，就直接调用 `notifyListeners()`，见 `DefaultPromise.java:190-203`。

这条语义非常重要。它意味着 listener 模型不是“只有完成前注册才有效”，而是：

```text
只要你注册了
  -> 如果未来完成，会在完成时通知
  -> 如果现在已经完成，会立即安排通知
```

这让 listener 成为真正的一等消费方式。调用方不必额外判断“它是不是已经 done 了，我还来得及加 listener 吗”。

### 4. 为什么 listener 递归通知会有栈深保护

异步回调最麻烦的地方之一，是 listener 里可能继续完成别的 promise，后者又通知新的 listener，形成递归链。

当前 `DefaultPromise` 用 `MAX_LISTENER_STACK_DEPTH` 限制这种递归深度，默认最多 8 层，见 `DefaultPromise.java:37-53`、`:498-549`。

如果当前线程已经在 EventExecutor 线程内，且递归深度还没超过阈值，就直接同步通知；否则就通过 `safeExecute` 把通知封装成任务交给 executor，避免继续在当前调用栈上递归。

这背后的问题不是“递归不优雅”，而是：

```text
监听器完成监听器再完成监听器...
如果永远同步深入
最终可能 StackOverflow
```

所以 listener 通知模型实际上又和 EventLoop 线程模型接上了：回调既要尽量快，也要避免把当前线程栈压穿。

### 5. 单个 listener 抛异常，不应阻断后续 listener

`notifyListener0` 对单个 listener 的 `operationComplete` 做了 try/catch；如果 listener 抛异常，只记 warn 日志，不会让后续 listener 停掉，见 `DefaultPromise.java:601-609`。

这条策略非常关键。否则只要某个 listener 写坏了，后面所有注册在同一 promise 上的 listener 都会被跳过，异步结果传播会被一个局部 bug 截断。

因此 listener 链的语义是：

```text
一个 listener 的失败
不能取消“这个 future 已完成”的事实
也不能阻止其他 listener 接收这个事实
```

## 四、`await` / `sync`：阻塞等待不是默认主路径，而且在 EventLoop 线程上可能直接报错

### 1. `await()` 真的是 `wait()`，不是轻量轮询

当前 `DefaultPromise.await()` 的实现会先检查 `isDone()`，处理中断，再调用 `checkDeadLock()`，随后在 `synchronized(this)` 里进入 `wait()` 循环，并用 `waiters` 计数当前阻塞等待者，见 `DefaultPromise.java:252-305`、`:661-676`。

也就是说，它不是“不断 while 轮询结果”，而是明确使用 Java 对象监视器的 wait/notifyAll 语义。

`checkNotifyWaiters()` 会在 promise 完成时先 `notifyAll()` 所有 waiters，再决定是否还有 listeners 需要通知，见 `DefaultPromise.java:646-666`。

这说明 Promise 完成后会推进两类消费者：

```text
阻塞等待者 -> notifyAll 唤醒
listener     -> notifyListeners 回调
```

### 2. `sync()` 比 `await()` 多一步：同步抛出异步失败

`s​​ync()` 的定义非常朴素：先 `await()`，再 `rethrowIfFailed()`，见 `DefaultPromise.java:417-429`。

这两者的区别因此不是“一个阻塞，一个不阻塞”，而是：

```text
await() -> 只等完成，不自动抛失败原因
sync()  -> 等完成，如果失败就把 cause 同步抛出来
```

这让调用方可以明确选择：

- 我只想知道它做完了没有，用 `await`。
- 我把这个异步操作当同步断点看待，失败就直接抛出，用 `sync`。

### 3. 为什么 EventLoop 线程上 `await()` 会死锁

`DefaultPromise.checkDeadLock()` 的实现很直接：只要 executor 非空，且当前线程已经在这个 executor 的 event loop 内，就抛 `BlockingOperationException`，见 `DefaultPromise.java:474-479`。

这条规则和第 5 章的 EventLoop 模型完全一致。

如果你在 EventLoop 线程里执行：

```text
future.await()
```

那这条线程就会阻塞在 wait 上；而完成这个 future 的逻辑，很可能也正需要同一条 EventLoop 线程继续推进 I/O 或任务。于是它会变成：

```text
我等自己把自己完成
```

这就是自锁。

所以 `BlockingOperationException` 不是 Promise 层额外耍脾气，而是 EventLoop 单线程模型的自我保护：不允许这条线程用阻塞等待破坏它自己的推进责任。

### 4. `DefaultChannelPromise` 多了一层“已注册才算真的危险”

`DefaultChannelPromise` 重写了 `checkDeadLock()`：只有当 `channel().isRegistered()` 时，才调用父类的死锁检查，见 `DefaultChannelPromise.java:156-161`。

这条边界很精细。它承认一个现实：

- 如果 Channel 还没注册到 EventLoop，上述“我等自己完成自己”的条件尚未成立得那么强。
- 一旦 Channel 已经注册，相关异步动作就更明确地依赖所属 EventLoop 推进。

所以当前实现不是简单粗暴地“凡是 EventLoop 线程上 await 都错”，而是对 ChannelPromise 多补了一层注册状态判断。

## 五、取消 cause 为什么要懒创建

### 1. 取消并不是先造好一个完整异常对象

`DefaultPromise.cancel()` 的第一步，是 CAS 把 `result` 从 null 改成 `CANCELLATION_CAUSE_HOLDER`，见 `DefaultPromise.java:397-405`。

这个 holder 里最初放的是一个预置的 `StacklessCancellationException`，见 `DefaultPromise.java:57-63`。真正的 `cause()` 在读取到这个特殊 holder 时，才会创建 `LeanCancellationException`，并尝试用新的 `CauseHolder(ce)` 替换回 result，见 `DefaultPromise.java:171-188`。

换句话说：

```text
cancel()
  -> 先标记“这是取消态”
  -> 不急着给每个 future 立刻分配完整异常对象

第一次 cause()
  -> 再把这个取消态具象化成 LeanCancellationException
```

### 2. 为什么值得这么做

不是每个取消的 future 都有人去查 `cause()`。如果每次取消都立刻创建完整异常对象并填栈，大量“没人真的关心失败细节”的取消也要支付分配和栈处理成本。

当前 `LeanCancellationException.fillInStackTrace()` 会复用缓存栈，而不是重新填充复杂堆栈，见 `DefaultPromise.java:155-168`。这进一步说明：取消在 Netty 看来是一种非常高频、但大多数时候不值得重成本建模的状态。

所以取消路径的设计目标不是“异常尽可能详细”，而是：

```text
先便宜地记住取消事实
只有真正有人问 cause 时
再把它转成可观察的异常对象
```

## 六、最容易错的五个判断

### 1. Future 和 Promise 只是名字不同

不成立。Future 是只读结果视图，Promise 是可写结果视图；这条读写分离是异步状态机的第一层边界。

### 2. `getNow()==null` 就说明还没完成

不成立。成功但结果为 null/Void、UNCANCELLABLE、中间失败 holder 等路径都可能让 `getNow()` 返回 null；必须结合 `isDone()` 判断。

### 3. 已完成的 future 再 `addListener` 已经来不及了

不成立。当前实现会在 `addListener` 后发现 future 已完成，并立即安排通知。

### 4. listener 和 await 只是两种写法，语义差不多

不成立。listener 是异步主路径；await/sync 是阻塞等待路径，而且在 EventLoop 线程上可能直接抛 `BlockingOperationException`。

### 5. 取消就是立刻生成一个 `CancellationException`

不成立。当前实现先写入取消 holder，真正读取 cause 时才懒创建 `LeanCancellationException`。

## 收网：Promise/Future 让“做完以后怎么办”变成框架级协议

现在可以回答本章开头的问题：异步操作发出去以后，结果怎么回来？

Netty 的回答不是单个回调函数，而是一套分层协议：

```text
Future
  -> 只读观察：成功了吗、失败原因是什么、现在能不能拿结果

Promise
  -> 可写完成：由执行方决定 success/failure/uncancellable

DefaultPromise
  -> 用一个 result 字段编码状态
  -> 用 listener 推动异步回调
  -> 用 await/sync 提供阻塞等待
  -> 用死锁检测保护 EventLoop 线程
```

这套协议之所以重要，是因为它正好补上了第 5 章之后最缺的那一块：

```text
EventLoop 决定什么时候做
Promise/Future 决定做完之后怎么把结果传出去
```

如果没有它，Netty 的异步 API 最终还是会退回两条很糟糕的路：不是到处阻塞等 `get()`，就是到处写不统一的回调封装。

而有了它，异步结果本身就成了一个统一的框架对象：既能被 listener 消费，也能在必要时被同步等待，还能明确区分谁有资格把状态写进去。

下一篇进入组合器与不可变 Future。因为单个 Promise 解决的是“一次异步操作怎么完成”；当 10 个、100 个异步操作需要一起编排时，只靠单个 `addListener` 就不够了。