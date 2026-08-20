# Ch5-04 多线程与特殊 EventLoop — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| 默认线程数 `max(1, eventLoopThreads or cpu*2)` | `MultithreadEventLoopGroup.java:37-45` | ✅ |
| `nThreads==0` 使用默认值 | `MultithreadEventLoopGroup.java:51-69` | ✅ |
| 默认 thread factory 使用 `Thread.MAX_PRIORITY` | `MultithreadEventLoopGroup.java:71-74` | ✅ |
| group `register(...)` 委托 `next().register(...)` | `MultithreadEventLoopGroup.java:84-98` | ✅ |
| children 创建、chooser 构造、termination listener | `MultithreadEventExecutorGroup.java:83-129` | ✅ |
| `next()` 委托 chooser | `MultithreadEventExecutorGroup.java:136-139` | ✅ |
| 2 的幂 chooser 用位与 | `DefaultEventExecutorChooserFactory.java:30-54` | ✅ |
| generic chooser 用 `AtomicLong` + `%` | `DefaultEventExecutorChooserFactory.java:57-71` | ✅ |
| `DefaultEventLoop.run()` 使用 `takeTask()` 纯任务循环 | `DefaultEventLoop.java:49-62` | ✅ |
| `ManualIoEventLoop` 由用户线程驱动 | `ManualIoEventLoop.java:41-49` | ✅ |
| `nonBlockingContext.canBlock() == false` | `ManualIoEventLoop.java:62-80` | ✅ |
| `canBlock()` 默认返回 true | `ManualIoEventLoop.java:97-99` | ✅ |
| `run(context, timeout)` 的一轮推进逻辑 | `ManualIoEventLoop.java:215-242` | ✅ |
| `ThreadPerChannelEventLoopGroup` 的 active/idle 双池 | `ThreadPerChannelEventLoopGroup.java:51-56` | ✅ |
| `next()` 不支持 | `ThreadPerChannelEventLoopGroup.java:151-153` | ✅ |
| `register()` 通过 `nextChild()` 获取或新建 loop | `ThreadPerChannelEventLoopGroup.java:271-320` | ✅ |
| 当前 `NioEventLoop` 是 deprecated 薄壳 | `NioEventLoop.java:38-45` | ✅ |

### 深审发现

- **无高风险事实错误。** 旧大纲里关于 `DefaultEventLoop` 使用 poll、普通 `next()` 轮询和旧架构中心的说法，正文都已按当前源码修正。✅
- **chooser 路径无溢出陷阱误判。** generic chooser 先对 `executors.length` 取模，再做 `Math.abs`，结果范围已受控，正文未夸大其风险。✅

## 第二轮：因果审

- 单个 EventLoop 已完整 -> 但吞吐/隔离受限 -> 需要 group 组织多个单线程 loop：✅
- 多线程 group 负责编组和分配，不破坏单个 loop 的线程亲和：✅
- chooser 选择 child -> 2 的幂场景用位与避免取模路径：✅
- DefaultEventLoop 没有 I/O 责任 -> 可以阻塞在 `takeTask()`：✅
- ManualIoEventLoop 的线程 ownership 在用户手里 -> 运行节奏也交给用户调用入口控制：✅
- ThreadPerChannelEventLoopGroup 把“每个连接一个 loop”推到极端 -> active/idle 双池承接租用/复用语义：✅
- `NioEventLoop` deprecated -> 架构中心从具体 NIO 类迁移到“调度骨架 + IoHandler”组合：✅

因果链完整，没有把默认值当定理，也没有把特殊 loop 当成“功能缺失版”模型。✅

## 第三轮：结构审

正文按“为什么单个 loop 不够 -> 多线程 group -> chooser -> DefaultEventLoop -> ManualIoEventLoop -> ThreadPerChannel -> NioEventLoop 薄壳化 -> 收网”组织，符合理解路径。✅

没有被类文件顺序绑架，也没有过早进入 Promise/Future 细节。✅

## 第四轮：读者审

删掉代码块后，主线仍然清楚：

- group 负责分摊和分配。
- chooser 负责决定新 Channel 归属。
- DefaultEventLoop 是纯任务模型。
- ManualIoEventLoop 是线程归用户所有的模型。
- ThreadPerChannel 是每连接一 loop 的极端模型。
- `NioEventLoop` 薄壳化说明新架构中心已经迁移。

陌生读者可复述每种模型解决的约束变化。✅

## 第五轮：边界审

- CPU*2 被明确写成当前默认值，而非最优规律。✅
- `Thread.MAX_PRIORITY` 被限定为当前 thread factory 的实现，不外推到操作系统调度效果。✅
- chooser 没有被写成绝对性能结论。✅
- `DefaultEventLoop` 已按当前源码写成 `takeTask()`，未沿用旧大纲里的 poll。✅
- `ManualIoEventLoop` 已明确是 ownership 模型变化，而不是简化版 NIO loop。✅
- `ThreadPerChannelEventLoopGroup` 的 deprecated 和特殊用途已明确。✅
- `NioEventLoop` deprecated 不被误写成 NIO 不可用。✅

## 第六轮：依赖审

- Ch5-01 到 Ch5-03 的主循环、策略、rebuild 前置已完成并正确复用。✅
- Ch6 Promise/Future 只做下一章桥接，没有提前透支。✅
- 没有引入未分析的 chooser 自动扩缩容或 native transport 结论。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 355。
- 去码后字符数：约 7,950。
- 去码去空白后字符数：约 7,140。
- 作为多模型对照专题已形成闭环。✅

## 结论

Ch5-04 六轮 review 完成，无需修订。Ch5 EventLoop 四篇全部完成，可进入 Ch6 Promise/Future。
