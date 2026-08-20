# Ch6-02 组合器与已完成 Future — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| CompleteFuture 已完成语义 | `CompleteFuture.java:23-45` | ✅ |
| CompleteFuture `addListener` 走 `DefaultPromise.notifyListener` | `CompleteFuture.java:46-63` | ✅ |
| CompleteFuture `removeListener(s)` NOOP，await/sync 立即完成但仍检查中断 | `CompleteFuture.java:65-124` | ✅ |
| SucceededFuture/FailedFuture 的终态行为 | `SucceededFuture.java:23-49`、`FailedFuture.java:26-67` | ✅ |
| PromiseCombiner 状态字段与内部 listener | `PromiseCombiner.java:35-65` | ✅ |
| PromiseCombiner 必须在指定 EventExecutor 线程内调用 | `PromiseCombiner.java:20-34`、`:163-166` | ✅ |
| add/addAll/finish 三阶段 | `PromiseCombiner.java:101-177` | ✅ |
| first-cause 语义与 `tryPromise()` | `PromiseCombiner.java:21-25`、`:157-170` | ✅ |
| PromiseNotifier clone promises | `PromiseNotifier.java:54-61` | ✅ |
| cascade 双向取消传播与取消短路 | `PromiseNotifier.java:75-110` | ✅ |
| PromiseNotifier 成功/取消/失败通知路径 | `PromiseNotifier.java:112-130` | ✅ |
| PromiseTask 继承关系、哨兵任务 | `PromiseTask.java:21-46` | ✅ |
| PromiseTask `run()` 模板 | `PromiseTask.java:102-112` | ✅ |
| PromiseTask 公开写禁用、内部写保留 | `PromiseTask.java:125-177` | ✅ |

### 深审发现

- **无高风险事实错误。** 正文已避免把 CompleteFuture 简化成“总在当前线程裸调用”，也没有沿用旧 PromiseCombiner/PromiseTask 的过时叙事。✅
- **一处边界已确认无误：** `PromiseNotifier.operationComplete` 当前确实使用 `future.get()`，而不是 `getNow()`；由于该路径只在 future 已完成时执行，正文保持“传播结果”叙事即可，无需强行展开实现细节。✅

## 第二轮：因果审

- 单个 Promise 只解决一次完成 -> 需要已完成 Future、聚合器、级联器和任务桥接：✅
- CompleteFuture 已知终态 -> 不再维护 listener 列表/状态转移，只进入通知协议：✅
- PromiseCombiner 通过 `expectedCount/doneCount` 聚合 -> first-cause + all-done 决定 aggregate promise：✅
- PromiseNotifier/cascade 把一个 future 的结果传播到其他 promise，并处理双向取消：✅
- PromiseTask 把执行结果写回 Promise，但不允许外部篡改完成状态：✅

因果链完整，没有把“多 Future 汇总”和“单 Future 级联”混成一类。✅

## 第三轮：结构审

正文按“为什么单 Promise 不够 -> CompleteFuture -> PromiseCombiner -> PromiseNotifier -> PromiseTask -> 收网”组织，符合从简单到复杂的理解路径。✅

没有被各类工具类的源码顺序牵着走。✅

## 第四轮：读者审

删掉代码块后，主线仍可复述：

- CompleteFuture 处理“结果已知”的场景。
- PromiseCombiner 处理“多 Future 全部结束才给总结果”。
- PromiseNotifier 处理“一个 Future 的结果传播给别的 Promise”。
- PromiseTask 处理“Runnable/Callable 如何回到 Promise 体系”。

误解澄清覆盖了“立即通知”“收集全部 cause”“Combiner vs Notifier”“单向传播”“PromiseTask 可随便 setSuccess”等核心混淆点。✅

## 第五轮：边界审

- CompleteFuture 的“立即通知”已限定为进入 `DefaultPromise.notifyListener` 协议，而不是无条件当前线程裸调用。✅
- PromiseCombiner 的线程限制已明确，未写成通用线程安全工具。✅
- first-cause 语义已明确，不承诺收集全部失败。✅
- cascade 的取消防护被限定为“避免最直接的双取消死循环”，没有夸大成完美协议。✅
- PromiseTask 的公开写禁用与内部写保留边界已明确。✅

## 第六轮：依赖审

- Ch6-01 的 Future/Promise 读写分离、listener 语义和 await/sync 已完成并被正确复用。✅
- Ch6-03 ChannelPromise/scheduled/progressive 只作导航，没有提前透支。✅
- 没有把 Channel 层特化逻辑提前当成当前篇前提。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 375。
- 去码后字符数：约 8,440。
- 去码去空白后字符数：约 7,640。
- 对异步编排专题篇已形成闭环。✅

## 结论

Ch6-02 六轮 review 完成，无需修订。可进入 Ch6-03 Channel 层 Promise 与 scheduled/progressive 扩展。
