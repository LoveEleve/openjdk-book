# Ch6-01 Promise/Future 状态模型与 Listener — rewrite-plan

## 篇章定位

- 核心困惑：EventLoop 的 register/connect/write 都是异步的，那调用方怎么知道“已经完成了”“失败原因是什么”“什么时候该回调、什么时候该阻塞等待”？
- 一句话顿悟：Netty 用 `Future`/`Promise` 把“读结果”和“写结果”分开，再用 `DefaultPromise.result` 单字段编码完成状态，用 listener 回调替代轮询，并在必要时用 `await/sync` 提供阻塞等待，同时防止 EventLoop 线程自我阻塞。
- 篇章边界：聚焦 `Future`/`Promise` 读写分离、`DefaultPromise.result` 状态编码、listener 存储与通知、`await/sync` 与死锁检测、取消 cause 的懒创建；组合器、不可变 Future、ChannelPromise 特化留后续篇。

## 依赖

### HARD

- Ch5 EventLoop：为什么异步结果必须回到 EventLoop 线程通知，为什么 EventLoop 线程上 await 会死锁。
- Channel/Bootstrap 基础：`register/connect/write` 返回的都是 Future/Promise 风格结果。

### SOFT

- Java `Future`/阻塞等待经验：用来对照 Netty 为什么要把 listener 当一等公民。
- 基础并发：CAS、volatile、wait/notify 的最小理解。

### NAV

- Ch6-02：PromiseCombiner、PromiseNotifier、CompleteFuture、PromiseTask。
- Ch6-03：ChannelPromise、VoidPromise、scheduled task 与 flush checkpoint。
- Ch7：Pipeline/Handler 如何围绕 Future 串联异步处理。

## 素材事实卡片

### 卡片 A：读写分离接口

- `Future.java:26-168`：只读接口——`isSuccess/isCancellable/cause/addListener/await/sync/getNow/cancel`。
- `Promise.java:21-90`：可写接口——`setSuccess/trySuccess/setFailure/tryFailure/setUncancellable`。
- 关键叙事：调用方通常拿 Future 视角，执行方/EventLoop 持有 Promise 视角。
- JDK Future 对比：Netty 把 listener 放进接口主线，而不仅是 `get()`。

### 卡片 B：result 单字段编码

- `DefaultPromise.java:55-63`：`RESULT_UPDATER`、`SUCCESS`、`UNCANCELLABLE`、`CANCELLATION_CAUSE_HOLDER`、`volatile Object result`。
- `DefaultPromise.java:144-152`：`isSuccess/isCancellable`。
- `DefaultPromise.java:171-188`：`cause()` / `cause0()`，对取消 cause 懒替换为 `LeanCancellationException`。
- `DefaultPromise.java:337-345`：`getNow()` 对 `SUCCESS/UNCANCELLABLE/CauseHolder` 返回 null。
- `DefaultPromise.java:638-655`：`setSuccess0/setFailure0/setValue0`，CAS `null/UNCANCELLABLE -> result`。
- 关键边界：当前源码并不是“5 个布尔位”，而是单字段 + sentinel / CauseHolder；状态判断要以 `result` 的具体对象类型为准。

### 卡片 C：listener 存储与通知

- `DefaultPromise.java:66-83`：一个 `listener` 字段 + 一个 `DefaultFutureListeners listeners` 字段，受 synchronized 保护。
- `DefaultPromise.java:190-249`：`addListener(s)` / `removeListener(s)`。
- `DefaultPromise.java:612-623`：`addListener0`：0 个 listener 直接放 `listener` 字段；已有 1 个时升级为 `DefaultFutureListeners`; 再多则走其内部数组。
- `DefaultPromise.java:498-590`：`notifyListeners`、stack depth 保护、`notifyListenersNow`、通知期间新 listener 的处理。
- `DefaultPromise.java:601-609`：单个 listener 异常不会中断后续通知，只记 warn。
- 关键纠偏：当前实现不是“大纲里的 null→1→2→array[2] 显式三态”，而是“单 listener / DefaultFutureListeners 聚合”两层显式结构。

### 卡片 D：阻塞等待与死锁检测

- `DefaultPromise.java:252-335`：`await/awaitUninterruptibly/await0` 走 `wait()` + waiters 计数。
- `DefaultPromise.java:417-429`：`sync/syncUninterruptibly = await + rethrowIfFailed`。
- `DefaultPromise.java:474-479`：`checkDeadLock()`：若 executor 非空且当前线程在 executor 事件循环内，抛 `BlockingOperationException`。
- `DefaultChannelPromise.java:156-161`：只有 channel 已 registered 时才做 deadlock 检查。
- `DefaultPromise.java:661-666`：`checkNotifyWaiters()` 负责 `notifyAll()` + 是否有 listeners。
- 关键叙事：await 使用的不是 FutureTask 那套 LockSupport，而是对象监视器 wait/notifyAll；死锁防护是 EventLoop 模型的硬边界。

### 卡片 E：取消 cause 与可取消状态

- `DefaultPromise.java:59-61`：预置 `CANCELLATION_CAUSE_HOLDER`。
- `DefaultPromise.java:155-168`：`LeanCancellationException` 覆盖 `fillInStackTrace()`，复用栈。
- `DefaultPromise.java:397-405`：`cancel()` CAS 设置取消 cause holder，然后唤醒等待者/通知监听器。
- `DefaultPromise.java:136-142`：`setUncancellable()` 把 `null -> UNCANCELLABLE`，若已完成且非 cancelled 也返回 true。
- 关键边界：取消异常对象不是一开始就分配好完整栈，而是在真正读取 cause 时懒替换。

## 理解路径

1. **从 Ch5 的异步 API 切入**：register/connect/write 立即返回，结果要怎么回来？
2. **先讲读写分离**：Future 只读、Promise 可写，解释为什么执行方和调用方看到的是同一个对象的不同接口面。
3. **再讲 result 单字段**：为什么不用多个布尔字段，`SUCCESS/UNCANCELLABLE/CauseHolder/实际值/null` 各代表什么。
4. **讲 listener 是主路径，不是附加功能**：注册后已完成怎么办、为什么 listener 异常不能阻断后续 listener、为什么需要递归深度保护。
5. **讲 await/sync 的阻塞语义**：何时可以阻塞，为什么 EventLoop 线程上 await 会抛异常，`DefaultChannelPromise` 为什么要多一层 `isRegistered()` 限制。
6. **讲取消与惰性 cause**：取消如何被编码、为什么懒创建异常对象。
7. **收网**：Future/Promise 回答的是“做完之后结果怎么回来”，下一篇再讲多个 Future 怎么组合。

## 失败方案推演

- 只用 JDK `Future.get()`：调用方只能阻塞或轮询，无法把回调注册为一等语义。
- 用多个 boolean/Throwable 字段表示状态：状态组合膨胀，单次读取无法得出完整结论。
- 每次 addListener 都直接创建数组/列表：常见少量 listener 场景下有额外对象开销。
- listener 回调里再同步通知无限递归：可能 StackOverflow，所以需要栈深保护和 executor fallback。
- EventLoop 线程上允许 await：它会把完成 promise 的那条线程自己阻塞住，形成自锁。
- 取消时立刻创建完整 CancellationException：大多数没人看 cause 的取消也要付出异常对象和栈成本。

## 文章结构与预算

1. 异步结果为什么不能只靠 `get()`（1000-1300 字）
2. Future/Promise 读写分离（1600-2100 字）
3. result 单字段状态机（2200-2700 字）
4. listener 存储与通知（2200-2800 字）
5. await/sync 与死锁检测（1700-2200 字）
6. 取消 cause 与可取消边界（1200-1600 字）
7. 误解澄清、总图与 Ch6-02 桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9500-11000 字。

## 证据清单

- `Future.java:26-168`
- `Promise.java:21-90`
- `DefaultPromise.java:55-63`
- `DefaultPromise.java:109-188`
- `DefaultPromise.java:190-249`
- `DefaultPromise.java:252-345`
- `DefaultPromise.java:397-405`
- `DefaultPromise.java:417-429`
- `DefaultPromise.java:474-609`
- `DefaultPromise.java:638-666`
- `DefaultChannelPromise.java:156-161`

## 边界清单

- 当前实现中的 listener 容器结构以 `listener + DefaultFutureListeners` 为准，不沿用旧文章或大纲中的数组[2]叙事。
- `checkDeadLock()` 的通用规则在 `DefaultPromise`；`DefaultChannelPromise` 只是加上 `channel().isRegistered()` 的条件化边界。
- `SUCCESS`/`UNCANCELLABLE`/`CauseHolder` 是当前实现 sentinel，不外推到所有 Promise 实现。
- 懒创建取消异常是当前 `DefaultPromise` 的优化细节，不写成 Java Future 的普遍行为。
- 本篇不展开 PromiseCombiner/PromiseNotifier/PromiseTask/void promise 细节，只做导航。

## 深审预警

- [ ] 修正大纲中“5 态编码”和当前实现的精确对应，避免把 `null`/`SUCCESS`/`UNCANCELLABLE`/`CauseHolder`/实际值讲混。
- [ ] 不沿用旧 listener 渐进升级模型，要按当前源码改写。
- [ ] 明确 `getNow()==null` 不代表未完成，必须配合 `isDone()` 使用。
- [ ] 说明 listener 已完成时会立即通知，但通知线程和递归保护有边界。
- [ ] 死锁检测要区分 `DefaultPromise` 与 `DefaultChannelPromise` 条件差异。
- [ ] 如果发现 Promise 状态转换或 listener 递归路径里有真实缺陷候选，按方法论记录证据链和 issue 候选。
