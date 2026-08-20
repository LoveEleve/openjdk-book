# Ch7-02 Handler 类型与 mask — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| `ChannelInboundHandler` 的入站回调集合 | `ChannelInboundHandler.java:22-75` | ✅ |
| `ChannelOutboundHandler` 的出站回调集合，`read()` 属于出站请求 | `ChannelOutboundHandler.java:23-99` | ✅ |
| `ChannelDuplexHandler` 叠加入站与出站能力 | `ChannelDuplexHandler.java:23-29` | ✅ |
| inbound/outbound adapter 默认转发并打 `@Skip` | `ChannelInboundHandlerAdapter.java:20-145`、`ChannelOutboundHandlerAdapter.java:22-127` | ✅ |
| `ChannelHandlerMask` 的 17 位掩码与 inbound/outbound 聚合位 | `ChannelHandlerMask.java:35-63` | ✅ |
| mask 按 class 用 `FastThreadLocal<WeakHashMap>` 缓存 | `ChannelHandlerMask.java:65-85` | ✅ |
| `mask0` 先按接口置位，再按 `@Skip` 清位 | `ChannelHandlerMask.java:91-164` | ✅ |
| `Skip` 注解语义与非继承性 | `ChannelHandlerMask.java:188-204`、`:193-196` | ✅ |
| `findContextInbound/Outbound` 与 `skipContext` 的 executor 条件 | `AbstractChannelHandlerContext.java:927-954` | ✅ |
| `@Sharable` 文档语义 | `ChannelHandler.java:154-218` | ✅ |
| `ChannelHandlerAdapter.isSharable()` 的缓存 | `ChannelHandlerAdapter.java:41-62` | ✅ |
| `checkMultiplicity()` 对非 sharable 重复添加的检查 | `DefaultChannelPipeline.java:544-553` | ✅ |
| `SimpleChannelInboundHandler` 的匹配/透传/autoRelease 语义 | `SimpleChannelInboundHandler.java:42-120` | ✅ |
| `CombinedChannelDuplexHandler` 的入/出站双委托与 `DelegatingChannelHandlerContext` | `CombinedChannelDuplexHandler.java:220-389` | ✅ |

### 深审发现

- **无高风险事实错误。** 旧大纲里关于 `@Sharable`、自动释放和 Combined“只是一个 duplex 子类”的泛化说法，正文均已按当前源码收紧。✅
- **关键边界已正确体现：** `skipContext` 不只是看 mask，还要看当前 executor 是否一致；这一点已准确纳入主线。✅

## 第二轮：因果审

- Pipeline 需要回答“谁该处理这个事件” -> handler 分类先把职责边界静态化：✅
- adapter 默认转发 -> `@Skip` 把“纯转发”转成可跳过信息：✅
- `ChannelHandlerMask` 把能力预编码 -> 传播时不必每次从零识别：✅
- `skipContext` 还要看 executor -> 跳过不能破坏线程顺序：✅
- `@Sharable` 解决实例复用边界，`checkMultiplicity` 在 add 阶段执行约束：✅
- `SimpleChannelInboundHandler` 把“类型过滤 + 自动释放”组合起来：✅
- `CombinedChannelDuplexHandler` 让一个 pipeline 位置中容纳两套方向代理：✅

因果链完整，没有把分类体系说成“只是类太多”。✅

## 第三轮：结构审

正文按“为什么要分类型 -> adapter/Skip -> mask -> executor 边界 -> sharable/multiplicity -> special handlers -> 收网”展开，符合理解路径。✅

没有被源码类文件顺序绑架，也没有提前进入 Pipeline 生命周期或 outbound buffer。✅

## 第四轮：读者审

删掉代码块后，主线仍能复述：

- handler 类型先声明自己处理哪类事件；
- adapter + `@Skip` 说明哪些默认实现只是转发；
- mask 把这种能力预先编码；
- context 传播时按 mask 和 executor 条件跳过不匹配节点；
- `@Sharable` 管实例复用，Simple/Combined 管两类典型特殊需求。

误解澄清覆盖了 `@Skip`、`read()`、`@Sharable`、mask、autoRelease 五个高频坑。✅

## 第五轮：边界审

- `@Skip` 已明确是 Netty 自己的传播优化，不是 JVM 机制。✅
- `read()` 的出站含义已明确，不与 `channelRead` 混淆。✅
- `@Sharable` 未被写成线程安全证明。✅
- `SimpleChannelInboundHandler` 的 autoRelease 限定在“匹配且被它接住”的消息。✅
- `CombinedChannelDuplexHandler` 已按“一个位置里两套委托”理解，而不是“普通 duplex 子类”。✅
- 未提前展开 initializer/lifecycle/outbound buffer。✅

## 第六轮：依赖审

- Ch7-01 的 Pipeline 骨架、Head/Tail、context 传播前置已正确复用。✅
- Ch7-03/04 仅作桥接，不提前透支。✅
- Ch4 ByteBuf、Ch6 Promise 只在释放与出站 promise 处做最小引用。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 407。
- 去码后字符数：约 8,940。
- 去码去空白后字符数：约 8,080。
- 对 handler 类型与传播优化专题已形成闭环。✅

## 结论

Ch7-02 六轮 review 完成，无需修订。可进入 Ch7-03 出站与写缓冲区。
