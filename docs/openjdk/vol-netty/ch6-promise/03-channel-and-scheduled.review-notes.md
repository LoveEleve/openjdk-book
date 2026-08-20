# Ch6-03 Channel 层 + Scheduled + Progressive — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| `DefaultChannelPromise` 绑定 Channel 和 FlushCheckpoint | `DefaultChannelPromise.java:30-33` | ✅ |
| `executor()` 回退到 `channel().eventLoop()` | `DefaultChannelPromise.java:56-64` | ✅ |
| `checkDeadLock()` 只在 channel 已注册时触发 | `DefaultChannelPromise.java:156-161` | ✅ |
| checkpoint getter/setter 与 `promise()` | `DefaultChannelPromise.java:141-154` | ✅ |
| `VoidChannelPromise` 不是 `DefaultPromise` 子类 | `VoidChannelPromise.java:27-53` | ✅ |
| `addListener(s)` 直接 fail | `VoidChannelPromise.java:56-66`、`:197-199` | ✅ |
| 无参 `await()` 只处理中断后返回自身；超时 await 与 sync fail | `VoidChannelPromise.java:81-116`、`:153-163` | ✅ 已修正文案 |
| `isDone/isSuccess/isCancelled/cause` 不提供普通完成语义 | `VoidChannelPromise.java:123-150` | ✅ |
| `setFailure/tryFailure` 走 `fireException0` | `VoidChannelPromise.java:166-180` | ✅ |
| `unvoid()` 创建 `DefaultChannelPromise` 并继承 fireExceptionListener | `VoidChannelPromise.java:217-223` | ✅ |
| 只有 registered channel 才 fire exception into pipeline | `VoidChannelPromise.java:230-238` | ✅ |
| `ScheduledFutureTask` 的 `deadlineNanos/periodNanos` 语义 | `ScheduledFutureTask.java:27-33` | ✅ |
| 同 deadline 用 id 打平局 | `ScheduledFutureTask.java:126-143` | ✅ |
| 周期/非周期 run 分支与 fixed-rate/fixed-delay 重算 | `ScheduledFutureTask.java:146-181` | ✅ |
| cancel 后从调度队列移除 | `ScheduledFutureTask.java:194-203` | ✅ |
| `ProgressivePromise` 接口的 progress 语义 | `ProgressivePromise.java:21-34` | ✅ |
| `DefaultProgressivePromise` 的 `total=-1`、`setProgress/tryProgress` 边界 | `DefaultProgressivePromise.java:37-69` | ✅ |
| `DefaultChannelProgressivePromise` 叠加 channel/executor/checkpoint/deadlock 语义 | `DefaultChannelProgressivePromise.java:29-64`、`:148-167` | ✅ |

### 深审发现

1. **中风险：VoidChannelPromise 的 await 语义需要更精确。** 初稿把 `await/sync` 一概写成直接 fail，当前源码里无参 `await()` 只处理中断并返回自身，真正 fail 的是超时 `await*` 和 `sync*`。已修正。
2. **无高风险事实错误。** fixed-rate/fixed-delay、progress=-1、executor 回退、fireException 条件均与当前源码一致。✅

## 第二轮：因果审

- 通用 Promise 不知道 Channel 归属 -> `DefaultChannelPromise` 把通知线程与 flush 语义绑回 Channel：✅
- 调用方明确不关心结果 -> `VoidChannelPromise` 主动裁掉观察能力，仅保留最小异常传播路径：✅
- 定时任务不是一次性完成模型 -> `ScheduledFutureTask` 用 deadline/period 重入队：✅
- 进度不是终态 -> `ProgressivePromise` 用中间通知补齐“完成前反馈”：✅
- ChannelProgressivePromise 把进度语义与 Channel 归属叠加：✅

因果链完整，没有把特殊化写成“只是 API 更丰富”。✅

## 第三轮：结构审

正文按“为什么通用 Promise 不够 -> ChannelPromise -> VoidChannelPromise -> ScheduledFutureTask -> ProgressivePromise -> 收网”推进，符合理解路径。✅

特殊化类型按“现实约束”分段，不按类文件顺序堆叠。✅

## 第四轮：读者审

删掉代码块后仍能复述：

- ChannelPromise 把结果归属和线程归属收回到 Channel。
- VoidChannelPromise 是“不关心结果”的明确契约，而不是已完成 future。
- ScheduledFutureTask 通过 period 正负区分 fixed-rate/fixed-delay。
- ProgressivePromise 解决完成前的中间进度通知。

误解澄清覆盖了最易错的五个判断。✅

## 第五轮：边界审

- 没把 `VoidChannelPromise` 写成“快速完成的 void future”。✅
- 已明确 `fireException0` 只有 registered channel 才向 pipeline 传播。✅
- 已明确周期任务不会像一次性 PromiseTask 那样 run 后直接进入 success 终态。✅
- fixed-rate/fixed-delay 按当前 deadline 重算逻辑表述，没有抽象口号化。✅
- `ProgressivePromise` 的 `total=-1` 未知总量边界清晰。✅
- 未提前展开 ChannelOutboundBuffer/Pipeline 的全部实现。✅

## 第六轮：依赖审

- Ch6-01 的 Promise/Future 主模型与 Ch6-02 的 PromiseTask 已正确复用。✅
- Ch5 EventLoop 线程亲和为 executor 回退和 scheduled task 归属提供硬前置。✅
- Ch7 Pipeline 只作桥接，没有透支后文实现。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 390。
- 去码后字符数：约 8,510。
- 去码去空白后字符数：约 7,680。
- 对 Promise 特化专题篇已形成闭环。✅

## 结论

Ch6-03 六轮 review 完成，深审修正 1 处 VoidChannelPromise await 语义。Ch6 Promise/Future 三篇全部完成，可进入 Ch7 Pipeline+Handler。
