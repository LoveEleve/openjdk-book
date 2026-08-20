# Ch5-02 SelectStrategy 与 selector 优化 — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| SelectStrategy 三态常量与 `>=0` 语义 | `SelectStrategy.java:26-51` | ✅ |
| DefaultSelectStrategy：有任务时调用 `selectSupplier.get()`，无任务时返回 `SELECT` | `DefaultSelectStrategy.java:28-31` | ✅ |
| `NioIoHandler.run()` 消费策略结果的 switch | `NioIoHandler.java:420-469` | ✅ |
| `CONTINUE` 直接返回 0 | `NioIoHandler.java:423-429` | ✅ |
| `BUSY_WAIT` 在 NIO 上退化为 `SELECT` | `NioIoHandler.java:430-433` | ✅ |
| `select()` 内 deadline 到期、任务再检查、阻塞条件与 break 条件 | `NioIoHandler.java:630-677` | ✅ |
| selectedKeys 优化结构：数组 + size + 翻倍 | `SelectedSelectionKeySet.java:25-46` | ✅ |
| `remove()` 恒 false，`contains()` 线性，`reset()` 清槽位 | `SelectedSelectionKeySet.java:48-108` | ✅ |
| selector 包装器每次 select 前 reset | `SelectedSelectionKeySetSelector.java:24-68` | ✅ |
| `openSelector()` 同时替换 `selectedKeys/publicSelectedKeys`，失败回退原始 selector | `NioIoHandler.java:143-233` | ✅ |
| optimized/plain 两条遍历路径 | `NioIoHandler.java:510-583` | ✅ |
| `needsToSelectAgain` 时 `reset(i+1)` + `selectAgain()` | `NioIoHandler.java:574-581` | ✅ |
| `selectAgain()` 只是 `selector.selectNow()` 刷新 | `NioIoHandler.java:762-768` | ✅ |

### 深审发现

- **无高风险事实错误。** 旧大纲里“hasTasks 直接返回 CONTINUE”的说法已被纠正为当前源码事实：默认策略在有任务时先执行 `selectSupplier.get()`。✅
- **无 `0 == CONTINUE` 混淆。** 正文已明确区分策略返回值和 `run()` 的外层效果。✅

## 第二轮：因果审

- Ch5-01 已经建立“有任务时别轻易阻塞” -> 本篇补全“本轮 select 阶段谁来决定、怎么决定”：✅
- DefaultSelectStrategy 用 `selectNow` 先试探 -> 避免简单粗暴地跳过全部 I/O：✅
- `NioIoHandler.run()` 结合策略值与上下文 -> 才形成最终的 select/continue 路径：✅
- JDK HashSet/Iterator 语义通用 -> Netty 当前消费模式只需要 append/顺序遍历/reset -> 数组结构更贴近热点路径：✅
- 注入失败 -> plain 路径保持正确性，只失去性能优化：✅
- `needsToSelectAgain` -> 旧未处理 keys 先清理，再 `selectNow` 刷新状态：✅

因果链完整，没有把实现细节过度上升为抽象规范。✅

## 第三轮：结构审

正文按“本轮到底等不等 I/O -> 策略层 -> `run()` 如何消费 -> JDK set 为什么不够 -> 数组优化与注入 -> 遍历与刷新 -> 收网”组织，符合理解路径。✅

没有被 `NioIoHandler` 的长方法顺序牵着走，而是按读者问题切分。✅

## 第四轮：读者审

删掉代码块后，主线仍然清楚：

- SelectStrategy 只负责 select 阶段意图，不是 EventLoop 总状态机。
- DefaultSelectStrategy 在有任务时先试探 `selectNow`。
- `SelectedSelectionKeySet` 是面向当前模式的专用数组，不是通用集合。
- optimized 遍历把 per-key remove 改成置 null + 批量 reset。

陌生读者可复述核心流程。✅

## 第五轮：边界审

- 明确 `BUSY_WAIT` 在当前 NIO 上不真正支持。✅
- 明确 `0` 不是 `CONTINUE` 常量本身。✅
- 明确数组优化不是通用 Set 替代品。✅
- 明确 Unsafe/反射注入只是优化，失败可回退。✅
- 明确 `needsToSelectAgain` 与 epoll rebuild 不是同一个机制。✅

## 第六轮：依赖审

- Ch5-01 已完成，为本篇提供 `canBlock`、主循环、MPSC 前置。✅
- Ch3 Selector 已完成，为 `select/selectNow/wakeup/selectedKeys` 提供前置。✅
- Ch5-03 rebuild、Ch5-04 chooser 只作导航，没有提前透支。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 448。
- 去码后字符数：约 9,430。
- 去码去空白后字符数：约 8,425。
- 对主机制篇已满足闭环要求。✅

## 结论

Ch5-02 六轮 review 完成，无需修订。可进入 Ch5-03 epoll bug 与 Selector 重建。
