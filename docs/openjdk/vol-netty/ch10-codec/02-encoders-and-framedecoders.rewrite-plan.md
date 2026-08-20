# Ch10-02 Encoders and Framedecoders rewrite plan

## 一句话困惑

上一篇已经知道 `ByteToMessageDecoder` 负责“积攒 + 循环 + 状态保护”，但真正写协议时，开发者仍会卡在两个更具体的问题上：入站到底该按什么边界把 TCP 字节流切成 frame，出站对象又是谁负责变成可写入 Socket 的 `ByteBuf`？

## 一句话顿悟

Codec 的第二层答案是：入站拆包器并不重新发明积攒逻辑，它们只实现“边界在哪里”的局部判定；出站 `MessageToByteEncoder` 也不管发送时序，它只负责把对象编码进 `ByteBuf`，并在框架层统一收口原消息释放与空 buffer 写出语义。

## 本篇范围

- 主讲四类常见 frame decoder 的“边界判定模型”：固定长度、分隔符、行、长度字段。
- 主讲 `MessageToByteEncoder.write()` 的类型匹配、缓冲分配、编码、释放、写出流程。
- 主讲 `ReplayingDecoder` 如何用 `REPLAY` signal + checkpoint 把“手动 readableBytes 检查”换成“回退后重试”。
- 回答完整性问题 #4/#5/#6/#7/#9。
- 不展开 HTTP codec 细节；只在篇末桥到 Ch11。

## 依赖声明

```text
本篇
├── HARD 前置：ch10-codec/01-bytetomessagedecoder.md
├── HARD 前置：ch4-bytebuf/01-dual-index-and-refcnt.md
├── HARD 前置：ch4-bytebuf/04-views-and-zerocopy.md
├── HARD 前置：ch7-pipeline/01-pipeline-structure.md
├── SOFT 前置：ch8-memorypool/04-pooledbuf-lifecycle.md
├── NAV 后续：ch11-http/01-request-response-and-pipeline.md
└── COMPARE：LengthFieldPrepender / MessageToMessageEncoder（仅导航，不展开）
```

## 结构设计

### 1. 开场：有了解码骨架，还没回答“边界到底怎么找”
- 承接上一篇：父类解决了积攒与循环，但没告诉你 frame 边界在哪里。
- 同时点出出站对偶问题：对象怎么变成字节。
- 预计 700-900 字。

### 2. 失败方案：为什么不能继续让业务 handler 自己 `readInt()/split()/toString()`
- 失败方案 A：业务 handler 自己判断半包和粘包。
- 失败方案 B：把整段 TCP 字节先转字符串再切分。
- 失败方案 C：编码器只管 encode 成功路径，不管 msg 生命周期。
- 预计 1400-1800 字。

### 3. 四种拆包器的总图：它们只回答“边界是什么”，不回答“半包怎么等”
- 定长、分隔符、行、长度字段四模型。
- 明确它们都复用 `ByteToMessageDecoder` 骨架，数据不够统一 `return null`。
- 回答完整性问题 #6/#9 的总前提。
- 预计 1200-1600 字。

### 4. `FixedLengthFrameDecoder`：最简单，但只适合边界天然等宽的协议
- `frameLength` 固定，`readableBytes < frameLength -> null`，否则 `readRetainedSlice`。
- 说明为何它适合定长记录流，不适合 payload 可变协议。
- 预计 900-1200 字。

### 5. `DelimiterBasedFrameDecoder` / `LineBasedFrameDecoder`：边界来自结束符，而不是字段长度
- `indexOf` 搜分隔符，多个 delimiter 取最短 frame。
- 特判 `\n` + `\r\n` 时委托 `LineBasedFrameDecoder`。
- `LineBasedFrameDecoder` 的 `offset` 扫描优化、discarding/failFast 语义、安全注释（SMTP smuggling 风险提示）。
- 回答完整性问题 #9。
- 预计 1700-2200 字。

### 6. `LengthFieldBasedFrameDecoder`：真正难的是“长度字段的值”与“实际整帧长度”不是一回事
- 用 `[2B len][4B header][payload]` 作为主例子。
- 解释 `lengthFieldOffset` / `lengthFieldLength` / `lengthAdjustment` / `initialBytesToStrip`。
- 解释 `frameLengthInt == -1` 两阶段状态：先读长度再等整帧。
- 解释负长度、调整后小于 endOffset、strip 超界、超长帧 discard 模式、failFast。
- 回答完整性问题 #4。
- 预计 2200-2800 字。

### 7. `ReplayingDecoder`：不是异常处理，而是把“不够读”编码成一种控制流
- `ReplayingDecoderByteBuf` 如何伪装成“永远可读”，实际在越界时抛 `REPLAY`。
- `checkpoint()` 和 `checkpoint(state)` 如何更新回退点。
- `callDecode()` 比父类多出的“状态未变也算没推进”判据。
- 性能代价与局限：重复解码、禁止部分 ByteBuf 操作、状态副作用需自清理。
- 回答完整性问题 #5。
- 预计 1900-2400 字。

### 8. `MessageToByteEncoder`：出站对偶不是“把对象写出去”，而是“把对象生命周期收口成一段 encode→release→write 协议”
- `acceptOutboundMessage`、`allocateBuffer`、`encode`、`release(cast)`、`ctx.write`。
- `preferDirect=true` 默认与 `ioBuffer()`。
- `encode` 抛异常时原 msg 是否泄漏；空 buf 为何写 `EMPTY_BUFFER`。
- 回答完整性问题 #7。
- 预计 1800-2300 字。

### 9. 误解澄清：return null、REPLAY、DirectBuffer、stripDelimiter 不是一回事
- 至少 4 个误解：
  1. 拆包器自己管理半包缓存。
  2. ReplayingDecoder 比普通 decoder 更“高级”。
  3. LengthField 四参数是背模板。
  4. MessageToByteEncoder encode 抛异常会泄漏原消息。
- 预计 900-1300 字。

### 10. 收网与桥接
- 收束：四种拆包器只是“定义边界”；编码器只是“定义对象到字节的映射”；真正的运行骨架仍来自前一篇。
- 桥到 HTTP：HTTP codec 也是在这些边界与编码骨架之上叠协议语义。
- 预计 500-700 字。

## 证据清单

- `codec-base/src/main/java/io/netty/handler/codec/FixedLengthFrameDecoder.java:43`
- `codec-base/src/main/java/io/netty/handler/codec/FixedLengthFrameDecoder.java:71`
- `codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:64`
- `codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:173`
- `codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:229`
- `codec-base/src/main/java/io/netty/handler/codec/LineBasedFrameDecoder.java:45`
- `codec-base/src/main/java/io/netty/handler/codec/LineBasedFrameDecoder.java:104`
- `codec-base/src/main/java/io/netty/handler/codec/LineBasedFrameDecoder.java:173`
- `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:189`
- `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:397`
- `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:454`
- `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:480`
- `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:270`
- `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:293`
- `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:341`
- `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoderByteBuf.java:60`
- `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoderByteBuf.java:1097`
- `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:48`
- `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:94`
- `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:99`
- `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:137`

## 误解清单

1. 四种拆包器都要自己管理 cumulation。
2. `ReplayingDecoder` 只是“try/catch 包一层异常”。
3. `LengthFieldBasedFrameDecoder` 的四参数只要套模板，不需要理解整帧长度怎么算。
4. `MessageToByteEncoder.encode()` 抛异常时，原始 `msg` 会泄漏。
5. `DelimiterBasedFrameDecoder` 和 `LineBasedFrameDecoder` 只是命名不同的同一个实现。

## 边界清单

- 本篇不展开 HTTP/WebSocket 等上层协议的具体 codec 类。
- 本篇不讲 `LengthFieldPrepender`，只在导航中提到它是长度字段出站对偶。
- 本篇不把 `ReplayingDecoder` 推荐成默认方案；必须明确其局限和性能代价。
- 本篇对 `LineBasedFrameDecoder` 的 SMTP 风险只做源码注释级边界提示，不展开安全专题。 