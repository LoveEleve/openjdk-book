# Ch12-03 HTTP/2 ConnectionHandler、Encoder/Decoder 主链 — rewrite plan

## 篇章定位

- 核心困惑：前两篇已经说明 HTTP/2 frame 如何被解析、如何变成 Netty 对象、如何映射成 child channel，但一条连接真正运行时到底由谁把前置、SETTINGS、frame reader、encoder、decoder、流控、GOAWAY 和关闭收在一起？为什么一个 DATA 写入最终要经过 stream 状态检查、远端流控和公平分配，入站 DATA 又要经过本地流控和内容长度校验？
- 一句话顿悟：`Http2ConnectionHandler` 是连接级总编排器，负责 preface、ByteToMessageDecoder 接入、flush 推进和连接关闭；`DefaultHttp2ConnectionDecoder` 在 frame reader 之上补 HTTP/2 语义、设置确认、入站流控和 listener 回调；`DefaultHttp2ConnectionEncoder` 在 frame writer 之上补 stream 状态、远端 SETTINGS、出站流控和生命周期推进。二者必须共享同一个 `Http2Connection`，这不是普通的依赖注入，而是保证 stream 状态、端点设置、流控窗口、GOAWAY 和关闭状态处于同一个状态世界。
- 文章边界：本篇主讲 ConnectionHandler -> Decoder/Encoder -> Connection/FlowController 的主链，主讲 outbound DATA/HEADERS、inbound DATA/SETTINGS/GOAWAY、preface、flush、关闭、并发 stream 缓冲和公平分配；不重新展开 frame reader 字节解析、HPACK 算法和 child channel API 细节。

## 依赖声明

### HARD

- Ch12-01 `ch12-http2/01-http2-codec.md`：理解 frame、stream、HPACK、双层流控的协议地基。
- Ch12-02 `ch12-http2/02-framecodec-and-multiplex.md`：理解 FrameCodec/Multiplex API 层如何消费 encoder/decoder 的结果。
- Ch7-05 `ch7-pipeline/05-outbound-buffer-and-writability.md`：理解 flush、pending bytes、writability 的 Netty 出站语义。
- Ch7-06 `ch7-pipeline/06-write-flush-and-consolidation.md`：理解 ConnectionHandler 的 flush 为什么会推进 remote flow controller。
- Ch4-06 `ch4-bytebuf/06-ownership-and-reference-counting.md`：理解 DATA、GOAWAY debug data 和失败路径的 release 责任。

### SOFT

- Ch10 codec：只复用 ByteToMessageDecoder 的“输入缓冲 -> 解码事件”心智模型。
- Ch6 promise：只复用 promise/future 异步完成模型。

### NAV

- 后续：WeightedFairQueueByteDistributor 深入专题。
- 后续：gRPC / Dubbo Triple 如何调用 Http2ConnectionHandler 和 stream API。

## 结构设计

### 1. 开场：协议组件很多，谁负责把它们收成一条运行时主链
- 从“frame reader、frame writer、connection、flow controller、pipeline 各自都能工作，但组合后谁负责时序”切入。
- 给出总图：ConnectionHandler -> Decoder/Encoder -> Connection -> FlowController -> FrameReader/Writer。
- 预计 1000-1400 字。

### 2. `Http2ConnectionHandler`：连接级总编排器
- 为什么继承 `ByteToMessageDecoder` 又实现 `ChannelOutboundHandler`。
- preface decoder -> frame decoder 的阶段切换。
- handlerAdded 时初始化、客户端/服务端 preface、flush 时推进 remote flow controller。
- channelInactive 时关闭 encoder/decoder 和全部 streams。
- 预计 2000-2500 字。

### 3. `DefaultHttp2ConnectionDecoder`：frame reader 之上的入站协议语义
- `decodeFrame()` 只是把输入交给 frameReader，真正语义在 `FrameReadListener`。
- SETTINGS 自动 ACK 与 `Http2SettingsReceivedConsumer` 的可选手动确认。
- 入站 DATA 的本地流控、unconsumed bytes、content-length 校验和 listener 回调。
- GOAWAY 如何先通知 listener 再更新 connection 状态。
- 预计 2200-2800 字。

### 4. `DefaultHttp2ConnectionEncoder`：frame writer 之上的出站协议语义
- 远端 SETTINGS 如何改写 header table、max frame size、max concurrent streams、initial window。
- DATA 写入前的 stream 状态检查，失败时立即释放 data。
- DATA 为什么不直接 frameWriter，而是交给 remote flow controller。
- HEADERS 如何创建/打开 stream、校验 headers 状态、交给 lifecycle manager 推进关闭。
- 预计 2400-3000 字。

### 5. 一个共享 `Http2Connection`：为什么 Encoder 和 Decoder 必须绑定同一状态世界
- Handler 构造器校验 encoder.connection == decoder.connection。
- decoder 使用 local flow controller，encoder 使用 remote flow controller。
- stream 状态、settings、GOAWAY、lifecycle manager 之间如何互相影响。
- 预计 1500-2100 字。

### 6. 并发 stream 上限：`StreamBufferingEncoder` 为什么要在 encoder 外再加一层
- SETTINGS_MAX_CONCURRENT_STREAMS 到达上限时不直接拒绝，而是缓存 stream 与对应 frames。
- stream 关闭或远端设置提高后自动 drain。
- GOAWAY / connection close 时不同失败类型，及 buffered DATA 的 release。
- 预计 1800-2400 字。

### 7. 公平写出：WeightedFairQueueByteDistributor 如何把可发送额度分给多个 stream
- connection stream、依赖树、权重、allocation quantum。
- streamable bytes + flow window + priority tree 的交汇。
- 明确它只是可发送额度的分配策略，不是完整流控器，也不承诺固定带宽或绝对公平。
- 预计 1800-2400 字。

### 8. 收网：一条 HTTP/2 连接的运行时闭环
- 入站：preface/frame reader -> decoder semantic listener -> local flow control -> API。
- 出站：API -> encoder state validation -> remote flow control/distributor -> frame writer -> flush。
- 失败：stream error / connection error / GOAWAY / channel close -> lifecycle cleanup。
- 预计 800-1100 字。

## 失败方案推演

- 只让 `Http2FrameReader` 直接回调业务：缺少 settings、流控、状态和连接级错误编排。
- Encoder 直接把 DATA 交给 frameWriter：绕过 remote flow controller，单流可能耗尽连接或违反窗口。
- Decoder 收到 DATA 就直接交给 listener：无法保证本地流控消费、content-length 和 stream 状态语义。
- 达到最大并发 stream 就直接失败：会把协议允许的暂时排队机会变成业务错误。
- 只按 streamId 轮询写出：无法表达优先级依赖、streamable bytes 和连接级额度。
- channelInactive 只关底层 reader/writer：遗留 streams 和未完成 promise 会继续悬挂。

## 证据清单

- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:55-104`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:190-217`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:236-260`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:44-65`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:125-186`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:227-260`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:38-60`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:79-118`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:120-145`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:187-260`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/StreamBufferingEncoder.java:35-55`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/StreamBufferingEncoder.java:121-143`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/StreamBufferingEncoder.java:168-229`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:44-57`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:93-186`
- `codec-http2/src/test/java/io/netty/handler/codec/http2/Http2ConnectionHandlerTest.java:227-260`

## 边界清单

- 本篇不重新讲 9 字节 frame 头、HPACK 编码和 child channel 创建细节。
- 本篇不把 `WeightedFairQueueByteDistributor` 写成严格带宽保证，只讨论其分配策略。
- 本篇不把 SETTINGS 自动 ACK 写成唯一配置，保留 `autoAckSettings=false` 的委托路径。
- 本篇不把 channel close、GOAWAY、stream error 混成同一种异常，必须区分连接级和 stream 级收尾。
- 本篇不展开所有 HTTP/2 frame listener 回调，只抓 DATA、SETTINGS、GOAWAY 和关键状态事件。

## 深审预警

- [ ] 不把 ConnectionHandler 写成只负责字节解码，它还负责 outbound flush、preface 和关闭。
- [ ] 不把 Encoder/Decoder 写成无状态的 frame 转换器，它们共享 `Http2Connection` 并维护协议语义。
- [ ] 不把 DATA 写出写成直接调用 frameWriter，必须经过 remote flow controller。
- [ ] 不把 Decoder 的 DATA 回调写成“读到就交业务”，要保留本地流控和 content-length 检查。
- [ ] 不把 StreamBufferingEncoder 的缓存写成永久队列，必须讲 GOAWAY/close/stream close 的 drain/fail/release。
- [ ] 不把公平分配器的权重写成实际吞吐承诺。