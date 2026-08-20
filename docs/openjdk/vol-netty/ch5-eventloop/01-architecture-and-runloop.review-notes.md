# Ch5-01 EventLoop 架构与单线程执行 — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| 单个 EventLoop 自己可 register Channel | `SingleThreadEventLoop.java:111-120` | ✅ |
| `SingleThreadIoEventLoop.next() -> this` | `SingleThreadIoEventLoop.java:228-230` | ✅ |
| 当前 `NioEventLoop` 是 `SingleThreadIoEventLoop` 薄壳并已 deprecated | `NioEventLoop.java:38-45` | ✅ |
| `run()` 主循环顺序 | `SingleThreadIoEventLoop.java:191-205` | ✅ |
| `runIo() = ioHandler.run(context)` | `SingleThreadIoEventLoop.java:223-225` | ✅ |
| `maxTaskProcessingQuantum` 默认值与最小 100ms | `SingleThreadIoEventLoop.java:38-40` | ✅ |
| `canBlock()` 同时检查普通任务与定时任务 | `SingleThreadIoEventLoop.java:43-48` | ✅ |
| `tailTasks` 入队与 wakeup | `SingleThreadEventLoop.java:137-150` | ✅ |
| `afterRunningAllTasks()` 执行 tailTasks | `SingleThreadEventLoop.java:163-166` | ✅ |
| `hasTasks()` 包含 tailTasks | `SingleThreadEventLoop.java:168-170` | ✅ |
| MPSC queue 与“never calls takeTask()” | `SingleThreadIoEventLoop.java:289-293` | ✅ |
| `maxPendingTasks` 下限 16 | `SingleThreadEventLoop.java:36-39`、`SingleThreadEventExecutor.java:222-246` | ✅ |
| `register(handle)` 的线程内/线程外分支 | `SingleThreadIoEventLoop.java:233-242` | ✅ |
| `registerForIo0` 成功后增加注册计数并包装返回 | `SingleThreadIoEventLoop.java:250-260` | ✅ |
| `IoRegistrationWrapper.cancel()` 递减计数 | `SingleThreadIoEventLoop.java:295-323` | ✅ |
| `canSuspend` 额外要求 `numRegistrations == 0` | `SingleThreadIoEventLoop.java:211-215` | ✅ |
| NIO register 要回 EventLoop 线程以避免底层锁阻塞 | `NioEventLoop.java:71-109` | ✅ |

### 深审发现

- **无高风险事实错误。** 旧大纲里的“EventLoop extends EventLoopGroup”接口层次在当前源码中已经不适合作为主叙事，正文已改为“单个 loop 的自包含效果”表达，并用 `next() -> this` 与 `register(this, promise)` 作为当前实现证据。✅
- **无旧 `ioRatio` 回退。** 正文已明确当前实现使用 `maxTaskProcessingQuantum`，未混入旧版百分比模型。✅

## 第二轮：因果审

- ByteBuf/Selector/Channel 都不会自己跑 -> 需要一个长期活着的驱动者：✅
- 线程池只执行任务 -> EventLoop 还要统一 I/O 等待与线程亲和：✅
- 单线程归属 -> 把锁问题前移成“是否回到正确线程”：✅
- `run()` 交替执行 I/O 与任务 -> 防止任一方无限独占循环：✅
- `canBlock` 检查任务与定时任务 -> 有待处理工作时不应阻塞 select：✅
- MPSC queue + wakeup -> 提交线程与 EventLoop 消费线程解耦：✅
- register 异步化 -> 维持线程亲和并规避底层 register/select 锁争：✅
- `numRegistrations` -> suspend 不只看任务，还要看手上还有没有 I/O 归属：✅

因果链完整，没有把设计推断写成作者意图。✅

## 第三轮：结构审

正文按“为什么需要 EventLoop -> 自包含结构 -> run 主循环 -> canBlock/量子 -> MPSC/tailTasks -> register 异步化 -> 收网”组织，没有被具体 NIO 细节或旧架构资料牵着走。✅

后续篇章（SelectStrategy、selector 优化、epoll bug rebuild）只做导航，没有提前透支。✅

## 第四轮：读者审

删掉代码块后，主线仍然清楚：EventLoop 是单线程 I/O+任务调度骨架，既处理 I/O，又执行任务，还要求 register 回到所属线程。✅

“EventLoop 不是普通线程池槽位”“自包含效果”“任务量子”“tailTasks 时间语义”“register 回线程”五个锚点都能帮助陌生读者抓住主线。✅

## 第五轮：边界审

- 明确当前架构基于 `SingleThreadIoEventLoop + IoHandler`，不把旧 `NioEventLoop` 结构写成当前事实。✅
- 明确 `maxTaskProcessingQuantum` 不是实时公平调度保证。✅
- 明确 MPSC 说明只针对当前 `SingleThreadIoEventLoop` 的任务队列设计。✅
- 明确 Promise/Future 只作最小结果承载解释，不展开监听器语义。✅
- 明确 SelectStrategy、selectedKeys 优化和 rebuild 留到后文。✅

## 第六轮：依赖审

- Ch3 Selector 和 Ch4 ByteBuf 已完成，作为硬前置依赖满足。✅
- Ch5-02、Ch5-03、Ch5-04、Ch6、Ch7 只做导航式桥接。✅
- 没有把后文结论当前置事实引用。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 411。
- 去码后字符数：约 9,290。
- 去码去空白后字符数：约 8,380。
- 对主链路篇来说接近下限，但仍完成了单篇闭环，后续若深审发现某节解释不足可局部扩写。✅

## 结论

Ch5-01 六轮 review 完成，无需修订。可进入 Ch5-02 SelectStrategy 与 selector 优化。
