# Ch12-03 HTTP/2 ConnectionHandler、Encoder/Decoder 主链 — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `Http2ConnectionHandler` 当前同时继承 `ByteToMessageDecoder`、实现 `ChannelOutboundHandler` 和 `Http2LifecycleManager`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:55`。  
2. `Http2ConnectionHandler` 当前要求 encoder 与 decoder 共享同一个 `Http2Connection`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:101`。  
3. preface decoder 当前会验证客户端 preface 和首个 SETTINGS，然后切换到 `FrameDecoder`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:236`、`:253`。  
4. `Http2ConnectionHandler.flush(...)` 当前先调用 remote flow controller 的 `writePendingBytes()`，再继续 `ctx.flush()`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:190`。  
5. channel inactive 当前会关闭 encoder、decoder 并关闭 connection 中全部 streams，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2ConnectionHandler.java:208`。  
6. `DefaultHttp2ConnectionDecoder` 当前在 frame reader 之上处理 inbound frame 语义，并通过 `Http2FrameListener` 向上委托，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:44`。  
7. `decodeFrame(...)` 当前把输入交给 `frameReader.readFrame(...)`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:184`。  
8. decoder 当前会初始化 local flow controller，并把 encoder 的 frame writer 交给它，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:143`。  
9. decoder 当前支持自动 SETTINGS ACK，也支持关闭自动 ACK 后委托给 `Http2SettingsReceivedConsumer`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:80`、`:134`。  
10. decoder 的 `FrameReadListener.onDataRead(...)` 当前会结合 stream、local flow controller、readable bytes、padding 处理入站 DATA，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:250`。  
11. decoder 当前维护 content-length 状态并在 DATA/END_STREAM 路径校验，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:233`。  
12. `onGoAwayRead0(...)` 当前先通知 listener，再更新 connection 的 GOAWAY 状态，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionDecoder.java:227`。  
13. encoder 当前在构造时确保 connection 拥有 remote flow controller，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:38`。  
14. encoder 当前会把远端 SETTINGS 应用到 push、最大并发 stream、header table、header list、frame size 和 initial window 配置，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:79`。  
15. `writeData(...)` 当前只允许 `OPEN` 和 `HALF_CLOSED_REMOTE` 状态，并在失败时释放 data、fail promise，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:120`、`:137`。  
16. DATA 当前会交给 remote flow controller 的 `addFlowControlled(...)`，而不是直接交给 frame writer，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:142`。  
17. `writeHeaders0(...)` 当前会创建/打开 stream、校验 headers 状态，并在编码后更新 headersSent 与 lifecycle manager，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2ConnectionEncoder.java:187`、`:230`。  
18. `StreamBufferingEncoder` 当前在达到最大并发 stream 限制时缓存新 stream 及其 frames，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/StreamBufferingEncoder.java:35`。  
19. `StreamBufferingEncoder` 当前会在 stream close 或远端设置提高上限时尝试创建 pending streams，并在 GOAWAY/close 时失败缓冲写入，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/StreamBufferingEncoder.java:121`、`:242`。  
20. `WeightedFairQueueByteDistributor` 当前是对 stream priority 敏感的 `StreamByteDistributor`，负责可发送额度分配，不是完整流控器，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:44`。  
21. 分配器当前维护 connection stream、priority state、stream added/active/closed/removed listener 和 state-only map，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/WeightedFairQueueByteDistributor.java:73`、`:115`。

### 深审发现

1. **高风险：容易把 encoder/decoder 写成无状态 frame 转换器。** 正文已强调共享 `Http2Connection`、流控、SETTINGS 和 lifecycle。  
2. **中风险：容易把本地窗口更新简化成“收到数据就恢复”。** 正文已改为强调应用消费进度参与本地流控器的窗口更新判断。  
3. **中风险：容易把 StreamBufferingEncoder 写成只有一条总队列。** 正文已补 `PendingStream` 按 stream 保存 HEADERS 与后续帧的路径。  
4. **中风险：容易把初始 HEADERS 的状态时序泛化成所有 frame。** 正文已限定为当前 `writeHeaders0(...)` 初始 HEADERS 路径的源码注释约束。  
2. **中风险：容易把 DATA 写出写成直接 frame writer。** 正文已明确经过 remote flow controller。  
3. **中风险：容易把入站 DATA 写成 reader 直接回调业务。** 正文已补 local flow controller、content-length 和 listener 语义。  
5. **中风险：容易把公平分配器写成带宽保证。** 正文已限定为可发送额度分配策略。  
6. **低风险：容易把 stream buffer 写成永久缓存。** 正文已补 stream close、SETTINGS、GOAWAY、connection close 的 drain/fail 边界。

## 第二轮：因果审

- reader/writer 直连业务 -> 缺少状态、SETTINGS、流控和关闭编排 -> 需要 ConnectionHandler/Encoder/Decoder 层：✅  
- 共享同一个 `Http2Connection` -> encoder/decoder 对同一份 stream、window、SETTINGS、GOAWAY 状态负责：✅  
- handler 先处理 preface -> 再切换 frame decoder -> 连接状态阶段明确：✅  
- 入站 DATA -> local flow control/content-length -> listener -> 消费与窗口更新：✅  
- 出站 DATA -> stream 状态检查 -> remote flow control -> distributor/frame writer：✅  
- stream 上限 -> buffering -> stream close/settings drain 或 GOAWAY/close fail：✅

## 第三轮：结构审

正文结构按“组件很多但缺总链 -> reader/writer 直连失败方案 -> ConnectionHandler -> Decoder -> Encoder -> 共享 connection -> stream buffering -> fair allocation -> 闭环”推进，没有按源码文件顺序平铺。✅

失败方案已覆盖：
- reader/writer 直接面对业务  
- Encoder 直接调用 frameWriter  
- Decoder 收到 DATA 就直接回调  
- 并发流达到上限就立即失败  
- 只按 streamId 轮询写出  
- channelInactive 只关闭底层 reader/writer  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- ConnectionHandler 是连接级总编排器  
- Encoder/Decoder 是 frame reader/writer 之上的协议语义层  
- 两者必须共享同一个 Http2Connection 状态世界  
- 入站 DATA 和出站 DATA 分别如何经过本地/远端流控  
- StreamBufferingEncoder 如何处理最大并发 stream 限制  
- WeightedFairQueueByteDistributor 只是可发送额度分配策略  
- GOAWAY、stream error、channel close 如何收尾  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重新展开 frame reader 字节解析、HPACK 和 child channel API。✅  
- 未把公平分配器写成完整流控器或带宽保证。✅  
- 未把 SETTINGS 自动 ACK 写成唯一配置。✅  
- 未把 GOAWAY、stream error、connection close 混成同一种异常。✅  
- 未展开所有 frame listener，只抓 DATA、SETTINGS、GOAWAY 和关键生命周期。✅

## 第六轮：依赖审

- 依赖 Ch12-01 的 HTTP/2 协议地基，真实存在。✅  
- 依赖 Ch12-02 的 API 层投影，真实存在。✅  
- 依赖 Ch7-05/06 的出站托管与 flush，真实存在。✅  
- 依赖 Ch4-06 的 ownership 前置，真实存在。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 16,233。  
- 去掉常见 markdown 标记后的字符数：约 15,942。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立 HTTP/2 连接级主链：ConnectionHandler 编排时序，Decoder/Encoder 补协议语义，FlowController/Distributor 决定数据推进，共享 Http2Connection 维持一致状态。本篇明确承担连接状态机主线，不再重复 `Ch12-02` 中 API 层 child channel 的解释。Ch12-03 可作为后续 gRPC / Triple 传输映射和 WeightedFairQueueByteDistributor 深入篇的直接前置篇。