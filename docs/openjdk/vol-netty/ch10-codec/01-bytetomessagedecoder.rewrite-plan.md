# Ch10-01 ByteToMessageDecoder rewrite plan

## 一句话困惑

服务端 child pipeline 已经装好了 handler，可 TCP 给到 `channelRead()` 的仍然只是分段到达、边界不保留的原始字节流；`ByteToMessageDecoder` 到底靠什么把“半包先等等”和“一次 read 里能拆出多个消息”这两件互相拉扯的要求统一起来？

## 一句话顿悟

`ByteToMessageDecoder` 真正提供的不是某一种具体协议解析器，而是一套通用解码骨架：先把多次到达的 `ByteBuf` 累积成 `cumulation`，再用 `callDecode` 循环驱动子类反复尝试解码；如果子类没消费字节就不许声称解出消息，如果数据不够就保持 readerIndex 不动等下一批，而重入和移除风险由父类状态机兜住。

## 本篇范围

- 主讲 `ByteToMessageDecoder` 的 `channelRead -> cumulator -> callDecode` 主线。
- 讲 MERGE / COMPOSITE 两种积攒策略及 `expandCumulation` 边界。
- 讲 `callDecode` 的循环终止条件、`singleDecode`、`CodecOutputList`。
- 讲 `decodeRemovalReentryProtection`、`inputMessages`、`handlerRemoved`、`channelInputClosed/decodeLast`。
- 讲 `discardAfterReads` 与 `discardSomeReadBytes` 的 OOM/共享视图边界。
- 不展开具体拆包器参数，那留给 Ch10-02。

## 依赖声明

```text
本篇
├── HARD 前置：ch4-bytebuf/01-dual-index-and-refcnt.md
├── HARD 前置：ch4-bytebuf/04-views-and-zerocopy.md
├── HARD 前置：ch7-pipeline/01-pipeline-structure.md
├── HARD 前置：ch9-bootstrap/02-bootstrap-server.md
├── SOFT 前置：ch8-memorypool/04-pooledbuf-lifecycle.md
├── NAV 后续：ch10-codec/02-encoders-and-framedecoders.md
└── COMPARE：ReplayingDecoder / LengthFieldBasedFrameDecoder（仅导航，不在本篇展开）
```

## 结构设计

### 1. 开场：child pipeline 已经就位，但 TCP 给你的仍然不是“消息”
- 从半包/粘包和 `channelRead(ByteBuf)` 切入。
- 点明 Codec 第一篇讲通用解码骨架，不讲具体协议参数。
- 预计 700-900 字。

### 2. 失败方案：为什么解码器不能每次 `channelRead()` 都假设拿到完整消息
- 失败方案 A：一次 read 就当完整包。
- 失败方案 B：子类自己各自维护积攒 buffer。
- 失败方案 C：只看 `decode()` 返回 null/非 null 决定是否继续。
- 引出 cumulation 和消费量驱动循环的必要性。
- 预计 1400-1800 字。

### 3. `channelRead()` 主线：先 cumulate，再 `callDecode`
- `selfFiredChannelRead`、`first`、`cumulation == null ? EMPTY_BUFFER : cumulation`。
- `input instanceof ByteBuf` 路径与 reentrant queue 路径。
- `CodecOutputList.newInstance()` / `recycle()` 的位置。
- 预计 1600-2100 字。

### 4. Cumulator：MERGE vs COMPOSITE 与 `expandCumulation`
- MERGE 的“能直接复用 in 就复用；否则写入并 finally release(in)”逻辑。
- COMPOSITE 的“尽量 zero-copy，但索引复杂度更高”。
- `cumulation == in`、`!cumulation.isReadable()`、`refCnt > 1`、`isReadOnly()` 等边界。
- 预计 1800-2200 字。

### 5. `callDecode()`：真正的核心不是 return null，而是“有没有消费字节”
- `outSize > 0` 先 `fireChannelRead` 再继续。
- `oldInputLength` 对比 readableBytes。
- `out.isEmpty() && oldInputLength == in.readableBytes()` -> break。
- `out` 非空但 input 未变 -> `DecoderException`。
- `singleDecode` 的额外截断语义。
- 预计 1900-2400 字。

### 6. 重入与移除：`decodeRemovalReentryProtection`、`inputMessages`、`handlerRemoved`
- `STATE_INIT / STATE_CALLING_CHILD_DECODE / STATE_HANDLER_REMOVED_PENDING`。
- decode 中触发再入 `channelRead` 时如何排队到 `inputMessages`。
- decode 中被 remove 时为何要延后 `handlerRemoved`。
- 结合测试 `reentrantReadSafety`、`reentrantReadThenRemoveSafety`、`testRemoveWhileInCallDecode`。
- 预计 1800-2300 字。

### 7. `discardAfterReads` 与 `decodeLast`：长期运行和收尾边界
- `numReads >= 16` 后 `discardSomeReadBytes()`。
- 仅在 `cumulation.refCnt() == 1 && !first` 时 discard。
- `channelInactive` / `ChannelInputShutdownEvent` 触发 `channelInputClosed()`，再 `decodeLast()`。
- 预计 1300-1700 字。

### 8. `CodecOutputList`：为什么父类连输出 list 都要专门池化
- FastThreadLocal 16 个缓存、`insertSinceRecycled` 标记、`recycle()` 清空。
- 解释它服务的不是协议语义，而是高频 decode 过程中的对象分配压力。
- 预计 700-1000 字。

### 9. 收网与桥接
- 回收：ByteToMessageDecoder 提供的是“积攒 + 循环 + 状态保护”的通用骨架。
- 桥到 Ch10-02：具体拆包器只是实现各自的 `decode()`，统一遵守“不够就不动 readerIndex / return”的父类协议。
- 预计 500-700 字。

## 证据清单

- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:83`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:123`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:163`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:257`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:285`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:365`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:406`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:464`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:541`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:566`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:574`
- `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:38`
- `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:93`
- `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:192`
- `codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:149`
- `codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:217`
- `codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:345`
- `codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:450`
- `codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:688`

## 误解清单

1. `ByteToMessageDecoder` 的循环终止条件是子类 `decode()` 返回 null。
2. COMPOSITE 一定比 MERGE 快，因为它“零拷贝”。
3. 只要 `decode()` 往 `out` 里加了消息，不消费输入字节也没关系。
4. `discardSomeReadBytes()` 每次 read 完都会跑。
5. decode 中把 decoder 从 pipeline 移除或再触发一次 inbound read，不会影响父类状态机。

## 边界清单

- 本篇不展开具体拆包器（FixedLength/Delimiter/LengthField/LineBased）的参数细节。
- 本篇不讲 `MessageToByteEncoder`；留给下一篇与拆包器一起对照。
- 本篇把 `ReplayingDecoder` 只当导航，不拿它混进主叙事。
- 本篇不把 `CodecOutputList` 夸大成协议层机制；它只是解码骨架的性能辅助结构。 