# Ch7-04 初始化与生命周期 — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| `ChannelInitializer` 是 `@Sharable`，内部用 `initMap` 防重入 | `ChannelInitializer.java:53-59` | ✅ |
| `handlerAdded` / `channelRegistered` 两个初始化入口 | `ChannelInitializer.java:72-88`、`:105-117` | ✅ |
| `initChannel(ctx)` finally 中自移除 | `ChannelInitializer.java:124-141` | ✅ |
| `removeState()` 对已移除/未移除 ctx 的同步与异步清理 | `ChannelInitializer.java:143-157` | ✅ |
| `pendingHandlerCallbackHead` 作为延迟回调链头 | `DefaultChannelPipeline.java:73-83` | ✅ |
| 未注册时 add/remove 只挂 callback，不立即 handlerAdded/Removed | `DefaultChannelPipeline.java:188-205`、`:401-427` | ✅ |
| 首次注册时批量补发 `handlerAdded()` | `DefaultChannelPipeline.java:593-601`、`:1118-1139` | ✅ |
| callback 链在 synchronized 外执行以避免死锁 | `DefaultChannelPipeline.java:1131-1137` | ✅ |
| `PendingHandlerAddedTask` / `PendingHandlerRemovedTask` 的 executor 分发 | `DefaultChannelPipeline.java:1456-1529` | ✅ |
| `handlerState` 与 `callHandlerAdded/callHandlerRemoved/invokeHandler` | `AbstractChannelHandlerContext.java:980-1017` | ✅ |
| remove 先摘链，再按注册/线程条件触发 removed | `DefaultChannelPipeline.java:401-427` | ✅ |
| replace 先 new handler added，再 old handler removed | `DefaultChannelPipeline.java:474-524` | ✅ |
| `replace0` 让 `oldCtx.prev/next` 都指向 `newCtx` | `DefaultChannelPipeline.java:526-542` | ✅ |
| `destroyUp/destroyDown` 两阶段 | `DefaultChannelPipeline.java:790-856` | ✅ |
| channel 关闭且 unregistered 后触发 destroy | `DefaultChannelPipeline.java:1406-1413` | ✅ |

### 深审发现

- **无高风险事实错误。** `ChannelInitializer` 的 once-only 初始化、自移除、pending callback 触发时机、replace/destroy 的两阶段顺序都与当前源码一致。✅
- **边界已确认：** `handlerState == ADD_PENDING` 在非 ordered executor 场景下可能仍允许 `invokeHandler()` 返回 true，这一细节已通过“best effort 可见性”叙事保留，没有被误写成所有情况下都必须等到 `ADD_COMPLETE`。✅

## 第二轮：因果审

- Pipeline 结构改了 != handler 立即可接事件 -> 需要 pending callback 与 `handlerState`：✅
- `ChannelInitializer` 只做一次装配 -> 完成后自移除：✅
- 未注册 channel 上不能立刻 `handlerAdded()` -> 需要延迟到 registered 后批量补发：✅
- `callHandlerAdded()` 先设 `ADD_COMPLETE` -> 防止回调内生成事件却被自己 miss 掉：✅
- replace 先 added 新的再 removed 旧的 -> 因为旧 handler 的 removed 过程可能触发读写到新 handler：✅
- destroy 先 up 再 down -> 处理跨 executor 线程归属，并保证 handlerRemoved 在事件处理收尾之后：✅

因果链完整，没有把链表修改和生命周期回调混成一步。✅

## 第三轮：结构审

正文按“结构变化 != 生命周期可见 -> ChannelInitializer -> pending callback/handlerState -> remove/replace -> destroy -> 收网”推进，符合理解路径。✅

没有被 `DefaultChannelPipeline` 长文件顺序绑架，而是围绕“什么时候生效/什么时候离场”组织。✅

## 第四轮：读者审

删掉代码块后，主线仍能复述：

- `ChannelInitializer` 只是一次性装配器。
- 未注册时 add/remove 回调会被挂起。
- `handlerState` 决定 handler 是否真正对传播可见。
- replace 先让新 handler ready，再让旧 handler 离场。
- destroy 需要两阶段处理跨 executor 清理。

最容易误解的五点（add 完即生效、initializer 常驻、remove 同步完成、replace 顺序、destroy 只是拆函数）都已单独澄清。✅

## 第五轮：边界审

- `@Sharable` 已限定为实例复用，不等于线程安全证明。✅
- `handlerState` 被明确当作当前实现细节，用于解释时序，而非用户 API 合同。✅
- replace 的 `oldCtx.prev/next = newCtx` 已限定为当前实现下的 forward 保护。✅
- destroy 两阶段被解释为线程归属/顺序问题，不夸大成唯一正确架构。✅
- 未提前展开 initializer 与 bootstrap 的全部交互细节。✅

## 第六轮：依赖审

- Ch7-01/02/03 已完成，为结构、类型和出站生命周期提供前置。✅
- Ch5 EventLoop 的线程归属前置已正确复用。✅
- Ch8 只作后续桥接，没有提前透支内存池化结论。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 438。
- 去码后字符数：约 8,820。
- 去码去空白后字符数：约 7,945。
- 作为 Pipeline 生命周期专题已形成闭环。✅

## 结论

Ch7-04 六轮 review 完成，无需修订。Ch7 Pipeline+Handler 四篇全部完成，可进入 Ch8 内存池化。
