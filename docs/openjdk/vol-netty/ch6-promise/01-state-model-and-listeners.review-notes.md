# Ch6-01 Promise/Future 状态模型与 Listener — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| Future 只读接口语义 | `Future.java:26-168` | ✅ |
| Promise 可写接口语义 | `Promise.java:21-90` | ✅ |
| `result`、`SUCCESS`、`UNCANCELLABLE`、取消 holder | `DefaultPromise.java:55-63` | ✅ |
| `isSuccess/isCancellable` | `DefaultPromise.java:144-152` | ✅ |
| `cause()` / `cause0()` | `DefaultPromise.java:171-188` | ✅ |
| set/try API 与 `setValue0` CAS | `DefaultPromise.java:109-133`、`:638-655` | ✅ |
| listener/`DefaultFutureListeners` 字段结构 | `DefaultPromise.java:66-83` | ✅ |
| `addListener0` 的当前渐进升级逻辑 | `DefaultPromise.java:612-623` | ✅ |
| 已完成 future 的 listener 立即通知 | `DefaultPromise.java:190-203` | ✅ |
| listener 递归深度保护与 executor fallback | `DefaultPromise.java:37-53`、`:498-549` | ✅ |
| 单 listener 异常不会阻断后续 listener | `DefaultPromise.java:601-609` | ✅ |
| `await` 的 wait/notifyAll 路径 | `DefaultPromise.java:252-305`、`:661-676` | ✅ |
| `sync = await + rethrowIfFailed` | `DefaultPromise.java:417-429` | ✅ |
| 通用 deadlock 检测 | `DefaultPromise.java:474-479` | ✅ |
| ChannelPromise 的 `isRegistered()` 限制 | `DefaultChannelPromise.java:156-161` | ✅ |
| `cancel()` 的懒 cause 路径 | `DefaultPromise.java:397-405`、`:171-188` | ✅ |

### 深审发现

1. **低风险：取消 holder 初始装载对象需要更精确。** 初稿写成“预置的是 LeanCancellationException”，当前源码实际是先放 `StacklessCancellationException`，第一次 `cause()` 时再 CAS 替换成 `LeanCancellationException`。已修正。
2. **中风险：大纲里的 listener 渐进升级模型已过时。** 正文已按当前源码改为“单 listener / DefaultFutureListeners 聚合”，没有沿用旧数组[2]叙事。✅

## 第二轮：因果审

- EventLoop 把动作异步化 -> 需要统一结果传播协议：✅
- 调用方只读、执行方可写 -> Future/Promise 读写分离：✅
- 一个字段编码结果状态 -> `SUCCESS/UNCANCELLABLE/CauseHolder/实际值/null`：✅
- listener 是主路径 -> 已完成也要立即通知 -> 递归过深时回 executor：✅
- await/sync 阻塞等待 -> EventLoop 线程会自锁 -> 必须 deadlock 检测：✅
- 取消常见但多数没人读 cause -> 懒创建取消异常：✅

未把设计动机越界写成作者主观意图，均可回到源码行为。✅

## 第三轮：结构审

正文按“为什么需要异步结果 -> 读写分离 -> result 单字段 -> listener 主路径 -> await/sync -> 取消 cause -> 收网”推进，符合理解路径。✅

没有按 `DefaultPromise` 文件顺序罗列所有方法，而是围绕调用者困惑组织。✅

## 第四轮：读者审

删掉代码块后，主线仍能复述：

- Future 只读、Promise 可写。
- DefaultPromise 用单字段编码状态。
- listener 是异步主路径。
- await/sync 是阻塞路径且有 EventLoop 自锁风险。
- cancel 的 cause 创建被延后以节省成本。

误解澄清覆盖 `getNow()==null`、已完成 addListener、listener vs await、取消异常时机等核心混淆点。✅

## 第五轮：边界审

- 当前 listener 容器结构与大纲旧认知已区分。✅
- `SUCCESS/UNCANCELLABLE/CauseHolder` 被明确限定为当前实现 sentinel。✅
- `DefaultChannelPromise` deadlock 检测的注册前后差异已写清。✅
- 没把 listener 立即通知写成“总在当前线程同步完成”，保留 executor/栈深边界。✅
- 没把取消懒创建写成 Java Future 的通用行为。✅

## 第六轮：依赖审

- Ch5 EventLoop 四篇已完成，为“谁完成 Promise、为什么 EventLoop 线程不能 await”提供硬前置。✅
- Ch6-02/03 只作导航，没有提前透支组合器或 void promise 实现。✅
- 没引用未分析域的结论。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 441。
- 去码后字符数：约 8,730。
- 去码去空白后字符数：约 7,824。
- 对状态模型专题篇已形成清晰闭环。✅

## 结论

Ch6-01 六轮 review 完成，深审发现 1 处取消 cause 细节表述并已修正。可进入 Ch6-02 组合器与不可变 Future。
