# Ch6-03 Channel 层 + Scheduled + Progressive — rewrite-plan

## 篇章定位

- 核心困惑：通用 Promise/Future 已经能表达异步结果，但 Netty 的实际业务 API 往往与 Channel、flush、定时任务和大文件传输进度绑定。为什么还需要 `DefaultChannelPromise`、`VoidChannelPromise`、`ScheduledFutureTask`、`DefaultProgressivePromise` 这些特化版本？
- 一句话顿悟：这些特化类型不是在重复造 Promise，而是在把“结果属于哪个 Channel”“结果根本没人关心”“结果不是一次性完成而是周期触发/渐进推进”这些业务约束显式编码进 Promise/Future 协议里。
- 篇章边界：重点讲 `ChannelFuture/ChannelPromise` 绑定、executor 回退、FlushCheckpoint、VoidChannelPromise、ScheduledFutureTask 的 fixed-rate/fixed-delay、ProgressivePromise 的进度语义；不展开 Pipeline/ChannelOutboundBuffer 全部细节。

## 依赖

### HARD

- Ch6-01：Future/Promise 读写分离、DefaultPromise 状态机、listener、await/sync 死锁检测。
- Ch6-02：PromiseTask 与已完成 Future，作为 ScheduledFutureTask 的基础。
- Ch5 EventLoop：为什么 ChannelPromise 的 listener 要回到 channel.eventLoop，为什么 scheduled task 归属于某个 executor。

### SOFT

- Channel flush/write 基础：只讲 checkpoint 为什么属于 ChannelPromise，不展开整个 outbound path。
- Progressive listener 使用场景：以大文件/大响应为例即可。

### NAV

- Ch7 Pipeline：ChannelPromise 如何在 pipeline 出站链路上传递。
- 后续 ChannelOutboundBuffer/flush 机制：为什么 checkpoint 和 progressive 进度最终在写路径里被消费。

## 素材事实卡片

### 卡片 A：ChannelPromise/ChannelFuture 绑定

- `DefaultChannelPromise.java:30-64`：channel 字段、executor 回退到 `channel().eventLoop()`。
- `DefaultChannelPromise.java:141-154`：`FlushCheckpoint` getter/setter 和 `promise()`。
- `DefaultChannelPromise.java:156-161`：只有 channel 已 registered 才做 deadlock 检测。
- `DefaultChannelPromise.java:163-170`：`unvoid()` 返回自身、`isVoid=false`。
- `DefaultChannelProgressivePromise.java:29-64`、`:148-167`：渐进版也继承相同 channel/executor/checkpoint/checkDeadLock 语义。
- 关键叙事：通用 Promise 不知道哪个 Channel 完成了什么；ChannelPromise 把这个归属显式化。

### 卡片 B：VoidChannelPromise

- `VoidChannelPromise.java:27-53`：channel + 可选 `fireExceptionListener`。
- `VoidChannelPromise.java:56-66`：`addListener(s)` 直接 fail；不允许注册 listener。
- `VoidChannelPromise.java:81-116`、`:153-163`：`await/sync` 直接 fail，不允许阻塞等待。
- `VoidChannelPromise.java:124-150`：`isDone/isSuccess/isCancelled/cause` 都不提供常规完成语义。
- `VoidChannelPromise.java:166-180`：`setFailure/tryFailure` 会 fire exception，但不形成普通 promise 结果。
- `VoidChannelPromise.java:217-227`：`unvoid()` 创建 `DefaultChannelPromise`，必要时挂上 fireExceptionListener。
- `VoidChannelPromise.java:230-238`：只有 channel 已 registered 时才向 pipeline fire exception。
- 关键边界：它不是“已经完成的 void future”，而是“你主动声明不关心结果，只保留可选异常传播”的特殊 promise。

### 卡片 C：ScheduledFutureTask

- `ScheduledFutureTask.java:27-33`：`deadlineNanos` 与 `periodNanos`，0=非周期，>0=fixed-rate，<0=fixed-delay。
- `ScheduledFutureTask.java:126-143`：按 deadline 再按 id 比较，服务优先级队列稳定排序。
- `ScheduledFutureTask.java:146-181`：run() 中：未到期重入队；非周期走 `setUncancellableInternal -> runTask -> setSuccessInternal`；周期任务不完成 promise，而是 `runTask()` 后根据正负 period 重算 deadline 并 `scheduleFromEventLoop(this)`。
- `ScheduledFutureTask.java:168-175`：`period > 0` 时 `deadlineNanos += periodNanos`；`period < 0` 时 `deadlineNanos = now - periodNanos`。
- `ScheduledFutureTask.java:194-203`：取消后从调度队列移除。
- 关键边界：周期任务不是每次运行都“完成 promise”，而是复用同一个任务对象持续重入队；与普通 PromiseTask 不同。

### 卡片 D：ProgressivePromise

- `ProgressivePromise.java:21-34`：`setProgress/tryProgress`。
- `DefaultProgressivePromise.java:37-69`：`total < 0` 归一为 -1，表示未知总量；`setProgress` 在 done 后抛异常，`tryProgress` 在 done/非法进度时返回 false。
- `DefaultProgressivePromise.java:52-68`：进度更新最终走 `notifyProgressiveListeners(progress, total)`。
- `DefaultChannelProgressivePromise.java:94-97`：Channel 绑定版的 `setProgress` 回 fluent self。
- 关键叙事：progress 不是“完成结果”，而是完成前的中间信号；total=-1 让未知总量场景也能进入同一套协议。

## 理解路径

1. **从通用 Promise 的不足切入**：通用 Future 只知道“某个异步结果完成了”，但不知道它属于哪个 Channel、要不要等、是不是周期触发、是不是有中间进度。
2. **先讲 Channel 绑定**：DefaultChannelPromise 把 executor 回退到 channel.eventLoop，把 flush checkpoint 和 deadlock 条件化绑到 Channel 生命周期。
3. **再讲 void 场景**：当调用方明确不关心结果时，为什么需要一个主动拒绝 listener/await 的 Promise，而不是“完成得很快的 Promise”。
4. **讲 ScheduledFutureTask**：周期任务与一次性任务在 Promise 语义上的根本不同；fixed-rate/fixed-delay 只是重算 deadline 的不同，不是两套任务模型。
5. **讲 ProgressivePromise**：进度是完成前的中间通知，不应该和最终 success/failure 混在一起。
6. **收网**：Promise 层特化的核心不是 API 丰富，而是把 Channel、无结果、周期、进度这几类现实约束显式放进异步协议。

## 失败方案推演

- 所有 Channel 写都只用通用 Promise：listener 线程归属不明确，flush 路径也缺 checkpoint 位置。
- 用普通 Promise 代替 VoidChannelPromise：明明不关心结果，却仍保留完整 listener/await 能力，容易误用并增加对象语义负担。
- 周期任务每次都创建一个新 PromiseTask：会把周期调度和一次性完成混在一起，无法自然复用 deadline/id/队列节点。
- 用成功/失败替代进度：调用方无法在完成前拿到中间状态，只能靠自定义 side channel。

## 文章结构与预算

1. 通用 Promise 还缺哪几类约束（1000-1300 字）
2. DefaultChannelPromise：Channel 绑定、executor 回退、checkpoint（2200-2800 字）
3. VoidChannelPromise：不关心结果时为什么要显式拒绝（1700-2200 字）
4. ScheduledFutureTask：固定频率 vs 固定延迟（2200-2800 字）
5. ProgressivePromise：完成前的中间通知（1600-2100 字）
6. 误解澄清、总图与 Ch7 桥接（1000-1300 字）

目标：删掉代码后的叙述性正文 9500-11000 字。

## 证据清单

- `DefaultChannelPromise.java:30-64`
- `DefaultChannelPromise.java:141-170`
- `VoidChannelPromise.java:27-66`
- `VoidChannelPromise.java:81-116`
- `VoidChannelPromise.java:124-180`
- `VoidChannelPromise.java:217-238`
- `ScheduledFutureTask.java:27-33`
- `ScheduledFutureTask.java:126-143`
- `ScheduledFutureTask.java:146-203`
- `DefaultProgressivePromise.java:37-69`
- `ProgressivePromise.java:21-34`
- `DefaultChannelProgressivePromise.java:29-64`
- `DefaultChannelProgressivePromise.java:148-167`

## 边界清单

- `ChannelPromise` 的线程语义取决于 `channel().eventLoop()` 回退，不能脱离 EventLoop 背景理解。
- `VoidChannelPromise` 不是“done=false 的普通 promise 变体”这种抽象概念，而是一个明确拒绝等待/监听的 API 契约。
- `ScheduledFutureTask` 的 fixed-rate/fixed-delay 语义以当前 deadline 重算逻辑为准，不外推为 JDK `ScheduledExecutorService` 的全部细节等价物。
- Progressive progress 只是一条额外通知通道，不等于最终完成状态。
- 本篇不展开 ChannelOutboundBuffer / Pipeline 全部使用点，只在需要时点到为止。

## 深审预警

- [ ] 不把 `VoidChannelPromise` 讲成“完成很快的 Void promise”；它本质是拒绝大多数观察能力。
- [ ] `fireExceptionListener` 只有在 channel 已 registered 时才向 pipeline 传播，必须写清。
- [ ] ScheduledFutureTask 周期任务不会像一次性 PromiseTask 那样完成后终结，重入队逻辑要讲准。
- [ ] fixed-rate/fixed-delay 要以 `periodNanos > 0 / < 0` 的当前实现为证据，不写成抽象口号。
- [ ] ProgressivePromise 的 `total=-1` 未知总量语义要写清。
- [ ] 如果在这些特化类型中发现线程归属、状态语义或边界处理的真实 bug 候选，按方法论记录 issue 候选。
