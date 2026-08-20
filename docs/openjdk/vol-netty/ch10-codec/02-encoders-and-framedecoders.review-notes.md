# Ch10-02 `02-encoders-and-framedecoders.md` review notes

## 第一轮：事实核对

### 已核对的核心结论

1. 四种常见拆包器 `FixedLengthFrameDecoder`、`DelimiterBasedFrameDecoder`、`LineBasedFrameDecoder`、`LengthFieldBasedFrameDecoder` 当前都直接继承 `ByteToMessageDecoder`，因此复用父类 cumulation/callDecode 骨架，证据：各类定义位置 `codec-base/src/main/java/io/netty/handler/codec/*.java`。
2. `FixedLengthFrameDecoder` 的当前 decode 逻辑确实只有两步：`readableBytes() < frameLength -> null`，否则 `readRetainedSlice(frameLength)`，证据：`codec-base/src/main/java/io/netty/handler/codec/FixedLengthFrameDecoder.java:71`。
3. `DelimiterBasedFrameDecoder` 当前会在多个 delimiter 中选择能形成最短 frame 的那个分隔符，而不是第一个遍历到的分隔符，证据：`codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:233`。
4. `DelimiterBasedFrameDecoder` 当前在 delimiters 恰好是 `"\n"` 和 `"\r\n"` 且类未被子类化时，会委托给 `LineBasedFrameDecoder`，证据：`codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:173`。
5. `LineBasedFrameDecoder` 当前用 `offset` 记录上次扫描位置，避免每次找不到换行时都从头重扫，证据：`codec-base/src/main/java/io/netty/handler/codec/LineBasedFrameDecoder.java:55`、`:173`。
6. `LineBasedFrameDecoder` 当前注释明确提醒了 lone `\n` 的宽松匹配可能带来的 SMTP smuggling / parser differential 风险，证据：`codec-base/src/main/java/io/netty/handler/codec/LineBasedFrameDecoder.java:36`。
7. `LengthFieldBasedFrameDecoder` 当前整帧长度公式为：`frameLength = getUnadjustedFrameLength(...) + lengthAdjustment + lengthFieldEndOffset`，证据：`codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:409`、`:416`。
8. `LengthFieldBasedFrameDecoder` 当前用 `frameLengthInt == -1` 表示“尚未确定当前帧总长度”，确定后仅检查 `readableBytes() < frameLengthInt` 等待整帧到齐，证据：`codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:200`、`:397`、`:429`。
9. `LengthFieldBasedFrameDecoder` 当前明确处理了负长度、调整后长度小于 `lengthFieldEndOffset`、`initialBytesToStrip` 大于 frame 长度、超长帧 discard/failFast 等边界，证据：`codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:349`、`:355`、`:380`、`:364`、`:480`。
10. `ReplayingDecoder` 当前通过缓存的 `Signal REPLAY` 实现回退控制流，证据：`codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:270`。
11. `ReplayingDecoderByteBuf` 当前在 `checkReadableBytes()` / `checkIndex()` 等路径直接抛 `REPLAY`，而不是返回 false，证据：`codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoderByteBuf.java:1091`、`:1097`。
12. `ReplayingDecoder.callDecode()` 当前和父类不同，会把“没有产出消息、readerIndex 未变、state 也未变”视为未推进并抛 `DecoderException`，证据：`codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:363`、`:376`、`:409`。
13. `MessageToByteEncoder.write()` 当前顺序确实是：`acceptOutboundMessage` -> `allocateBuffer` -> `encode` -> `finally release(cast)` -> 写 `buf/EMPTY_BUFFER` -> 外层 finally 回收未移交的 `buf`，证据：`codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:99`。
14. `MessageToByteEncoder` 默认 `preferDirect=true`，`allocateBuffer()` 默认使用 `ctx.alloc().ioBuffer()`，证据：`codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:54`、`:72`、`:137`。
15. 因为 `ReferenceCountUtil.release(cast)` 在 `encode()` 的 finally 中，所以当前实现下 encode 抛异常不会导致原始 msg 泄漏，证据：`codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:106`。

### 需保持精确的措辞

- 正文中“return null”用于四种 frame decoder 的人话描述是成立的，因为这四类 decode 的 protected object-returning 版本确实使用 `null` 表示数据不足；但必须和上一篇父类 `decode(List<Object> out)` 无返回值区分，正文已区分。
- 正文没有把 `LineBasedFrameDecoder` 说成 `DelimiterBasedFrameDecoder` 的子类；源码事实是委托，不是继承，正文已保持正确。

## 第二轮：因果审

### 因果链是否成立

1. “四种拆包器只定义边界、不重新管理半包” 由它们统一继承 `ByteToMessageDecoder` 且 decode 中不持有额外 cumulation 状态直接支撑，成立。
2. “`FixedLengthFrameDecoder` 之所以简单，是因为协议边界已被约束为固定宽度” 是对源码角色的准确解释，成立。
3. “`DelimiterBasedFrameDecoder` 的主要风险是 delimiter 长期不出现导致 frame 无界增长，因此需要 `maxFrameLength` + discard 模式” 有当前 discard 状态字段与 decode 分支直接支撑，成立。
4. “`LengthFieldBasedFrameDecoder` 的真正难点是长度字段原值与整帧长度不总相等” 由当前整帧长度公式和 `lengthAdjustment` 语义直接支撑，成立。
5. “`ReplayingDecoder` 把不够读编码成控制流回退而非错误语义” 由 `Signal REPLAY` 的 catch→readerIndex 回退→break 直接支撑，成立。
6. “`MessageToByteEncoder` 真正统一的是 encode→release→write 协议，而不只是调用子类 encode” 由 `write()` 骨架直接支撑，成立。

### 需要克制的推断

- 对 `ioBuffer()` 更贴近 socket I/O 路径的解释，是 Netty 常见设计语义，正文只说“默认偏向典型出站 I/O 路径”，没有夸大到绝对零拷贝保证，保持在合理边界内。
- 对 `LineBasedFrameDecoder` 的安全说明仅停留在源码注释级边界，没有扩展成正式漏洞定性，符合证据边界。

## 第三轮：结构审

### 当前结构是否按理解路径推进

当前结构是：

1. 承接上一篇，说明这篇要解决“边界在哪里 / 对象何时变字节”。
2. 先走 3 个失败方案，说明为什么不能回退到业务层手工处理。
3. 再给四种拆包器总图，先统一角色，再拆具体类。
4. 先讲最简单的 `FixedLengthFrameDecoder` 校准子类职责。
5. 再讲 `DelimiterBasedFrameDecoder` / `LineBasedFrameDecoder` 这组边界来自结束符的模型。
6. 再讲最复杂的 `LengthFieldBasedFrameDecoder`。
7. 再讲 `ReplayingDecoder` 这种控制流变体。
8. 最后转出站 `MessageToByteEncoder`，形成入站/出站对偶闭环。
9. 误解澄清后收网桥接 HTTP。

这条顺序是“边界模型从易到难 + 再讲控制流变体 + 最后讲出站对偶”，不是源码文件遍历，成立。

### 结构风险检查

- 没有一上来就把 `LengthFieldBasedFrameDecoder` 四参数硬砸出来，而是先用总图与失败方案把读者心智模型立住，合理。
- `ReplayingDecoder` 放在四种基础边界模型之后，有助于读者先掌握普通 return-null 模型，再理解 REPLAY 变体，合理。
- `MessageToByteEncoder` 放在后段形成入站/出站对偶，能帮助篇末收网，合理。

## 第四轮：读者审

### 删掉代码块后是否仍成立

删掉代码块后，正文仍可复述：

1. 四种拆包器分别按什么信息定义边界。
2. 它们为什么不自己再管理半包缓存。
3. `LengthFieldBasedFrameDecoder` 的四参数到底在补偿什么。
4. `ReplayingDecoder` 为什么能省掉手动边界检查。
5. `MessageToByteEncoder` 为什么能保证 encode 抛异常时原消息不泄漏。

因此代码块和 `file:line` 承担的是证据位，不是叙事骨架。

### 可能的阅读负担点

- `LengthFieldBasedFrameDecoder` 的 `lengthAdjustment` 容易仍然抽象；正文已用 `[2B len][4B header][payload]` 持续贯穿，负担可接受。
- `ReplayingDecoder` 和 `ReplayingDecoderByteBuf` 的关系容易混；正文已先讲“谁在抛 REPLAY”，再讲 `callDecode`，顺序正确。

## 第五轮：边界审

### 已明确边界

1. 本篇不展开 HTTP/WebSocket 等上层 codec。
2. 本篇不讲 `LengthFieldPrepender`。
3. 本篇不把 `ReplayingDecoder` 包装成默认推荐方案，而是明确其局限与代价。
4. 本篇对 `LineBasedFrameDecoder` 的 SMTP 风险只做源码注释级提示，不扩展为安全专题。

### 失败路径与代价覆盖

- 已覆盖：分隔符协议下 delimiter 长期不出现导致的 discard 模式与 `TooLongFrameException`。
- 已覆盖：长度字段协议下负长度、补偿后越界、strip 超界、超长帧 failFast 语义。
- 已覆盖：`ReplayingDecoder` 的重复解码代价、受限 ByteBuf 操作、副作用状态风险。
- 已覆盖：`MessageToByteEncoder` 对原 msg 与输出 `buf` 的两层释放边界。

### Bug / issue 候选检查

本轮未发现足够形成 issue 候选的真实缺陷：

- `MessageToByteEncoder` 的异常释放语义和当前实现是一致的，没有发现“encode 抛异常导致原 msg 泄漏”的缺口。
- `LengthFieldBasedFrameDecoder` 的长度公式与边界处理在当前源码里是自洽的，未发现本轮足以定性的索引漏洞。
- `ReplayingDecoder` 的 REPLAY 控制流虽然有性能代价，但这是显式设计取舍，不是功能缺陷。
- `LineBasedFrameDecoder` 的安全注释是边界提示，不构成当前实现内可单列的 bug。

结论：本篇未发现需要单列 issue 候选的源码缺陷。

## 第六轮：依赖审

### 前置依赖检查

- 硬依赖 Ch10-01：本篇多次复用“父类负责积攒与循环”的结论，依赖真实存在。
- 硬依赖 ByteBuf：`readRetainedSlice`、readerIndex、引用计数、视图共享是本篇多个结论的前提。
- 硬依赖 Pipeline：`ctx.write`、handler 透传、outbound 类型匹配属于 pipeline 语义。
- 软依赖 direct/heap buffer 与内存池：仅用于解释 `preferDirect`，不影响主线成立。

### 后续桥接检查

- 篇末只桥到 HTTP codec 建立在当前 Codec 地基之上，没有提前使用 HTTP 结论，方向正确。
- 没有把 `LengthFieldPrepender`、HttpObjectAggregator 等未分析域当前置成既定事实。

## 机械检查

### 禁用词扫描目标

- 此处不再赘述
- 不再展开
- 类似地
- 同理
- 依此类推
- 篇幅所限
- 显然
- 容易看出
- 细节读者自行阅读源码

预期：正文不命中偷懒词。

### 行号复核重点

- `codec-base/src/main/java/io/netty/handler/codec/FixedLengthFrameDecoder.java:71`
- `codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:173`
- `codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:229`
- `codec-base/src/main/java/io/netty/handler/codec/LineBasedFrameDecoder.java:173`
- `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:416`
- `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:341`
- `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoderByteBuf.java:1097`
- `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:99`

### 删码测试目标

删除全部 fenced code block 后，正文仍应保留：

- 四种边界模型的总图
- `LengthFieldBasedFrameDecoder` 的整帧长度计算逻辑
- `ReplayingDecoder` 的 REPLAY + checkpoint 回退机制
- `MessageToByteEncoder` 的 encode→release→write 骨架
- 误解澄清与篇末桥接