# Ch7-01 Pipeline 结构与传播骨架 — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| `ChannelPipeline` 官方双向传播图与跳过规则 | `ChannelPipeline.java:84-175` | ✅ |
| Pipeline 保存 head/tail/channel/succeededFuture/voidPromise | `DefaultChannelPipeline.java:49-68` | ✅ |
| 构造时先建 tail/head 再互连 | `DefaultChannelPipeline.java:91-101` | ✅ |
| `newContext` 与 `childExecutor(group)` | `DefaultChannelPipeline.java:118-143` | ✅ |
| `internalAdd` 通过 addFirst/addLast/addBefore/addAfter 插入 context | `DefaultChannelPipeline.java:161-205` | ✅ |
| 链表插入函数修改 prev/next | `DefaultChannelPipeline.java:212-235`、`:249-279` | ✅ |
| pipeline 入站从 head 发起、出站从 tail 发起 | `DefaultChannelPipeline.java:915-1044` | ✅ |
| TailContext 是 inbound 兜底 | `DefaultChannelPipeline.java:1263-1322` | ✅ |
| HeadContext 持有 unsafe 并落地 outbound 操作 | `DefaultChannelPipeline.java:1324-1392` | ✅ |
| AbstractChannelHandlerContext 保存 prev/next/mask/executor/state | `AbstractChannelHandlerContext.java:62-116` | ✅ |
| `executor()` 默认回退 channel.eventLoop | `AbstractChannelHandlerContext.java:133-140` | ✅ |
| `fireChannelRead` 先找下一个 inbound context，再按 executor 直接调用或切线程 | `AbstractChannelHandlerContext.java:341-367` | ✅ |
| `fireChannelRegistered` 等其他入站事件也采用同样模式 | `AbstractChannelHandlerContext.java:148-175` | ✅ |
| 同组 handler 默认 pin 到同一 child executor，除非配置关闭 | `DefaultChannelPipeline.java:122-143` | ✅ |

### 深审发现

- **无高风险事实错误。** 入站/出站方向、head/tail 角色、childExecutor pin 行为均与当前源码一致。✅
- **边界已确认：** `Pipeline` 对外的 `fireChannelRead` 从 head 开始，`write/flush` 从 tail 开始，这与“head 负责 outbound 落地、tail 负责 inbound 兜底”并不冲突，因为它们分别是传播起点和边界节点。✅

## 第二轮：因果审

- 巨型 handler 会把解码/业务/编码/异常混成一体 -> 需要显式责任链：✅
- 入站与出站本来就是两条相反传播方向 -> 需要双向链表与方向过滤：✅
- 不是 handler 本身而是 context 节点参与传播 -> 因为还要携带 prev/next/mask/executor/state：✅
- head/tail 哨兵消除了边界分支，并连接真实 I/O 与未处理尾声：✅
- child executor pin 保持同一 channel 在同组 handler 上的线程稳定性：✅

因果链完整，没有把“结构选择”写成纯实现偶然。✅

## 第三轮：结构审

正文按“为什么需要 pipeline -> 总图 -> head/tail 双向链表 -> context 才是真节点 -> childExecutor 线程归属 -> 收网”推进，符合理解路径。✅

没有被 `DefaultChannelPipeline` 大文件顺序绑架。✅

## 第四轮：读者审

删掉代码块后，主线仍然可复述：Pipeline 是双向责任链，head/tail 提供边界，context 决定下一个节点和线程归属，用户 handler 只是在这条骨架上插拔。✅

最容易误解的五点（列表、方向、执行者、哨兵、随机 executor）均有专门澄清。✅

## 第五轮：边界审

- 没把 head/tail 写成普通用户 handler。✅
- 没把 pipeline 写成“总是无锁/总是零拷贝”的结构口号。✅
- childExecutor 的 pin 行为已限定为当前默认配置下；关闭 `SINGLE_EVENTEXECUTOR_PER_GROUP` 时会直接 `group.next()`。✅
- 本篇只讲骨架，不提前展开 inbound/outbound handler 分类与生命周期。✅

## 第六轮：依赖审

- Ch5 EventLoop 和 Ch6 Promise 已完成，作为执行线程与出站 promise 前置依赖满足。✅
- Ch7-02/03/04、Ch10 只作导航，没有提前透支。✅
- Ch4 ByteBuf 只作为流动物体背景，没有被当前篇硬展开。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 447。
- 去码后字符数：约 8,575。
- 去码去空白后字符数：约 7,652。
- 作为骨架篇已形成闭环。✅

## 结论

Ch7-01 六轮 review 完成，无需修订。可进入 Ch7-02 handler 类型与 mask。
