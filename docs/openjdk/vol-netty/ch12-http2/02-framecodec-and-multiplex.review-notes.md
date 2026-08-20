# Ch12-02 HTTP/2 Netty API 层：FrameCodec 与 Multiplex — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `Http2FrameCodec` 当前类注释明确：它负责把 inbound HTTP/2 frame 映射成 `Http2Frame` 对象，并把 outbound `Http2Frame` 写回 wire format，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:45`。  
2. 读入的 `Http2StreamFrame` 当前总会带一个 `Http2FrameStream` 句柄，而写出时应用需要先把 stream 句柄挂上去，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:55`、`:59`。  
3. outbound stream 当前可通过 `Http2ChannelDuplexHandler.newStream()` 先创建 stream 句柄，再写出 `Http2HeadersFrame` 建立，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:82`。  
4. `Http2FrameCodec` 当前允许在 `encoderEnforceMaxConcurrentStreams` 下缓冲暂时不能创建的新 stream，并在关闭或 GOAWAY 时失败对应写入，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:115`。  
5. `Http2FrameCodec` 当前会把 stream 级异常包装成 `Http2FrameStreamException`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:125`。  
6. `Http2FrameCodec` 当前在传播带 `ReferenceCounted` 内容的 frame 前会 `retain()`，应用消费后仍需 release，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:131`。  
7. `Http2FrameCodec` 当前构造时会安装 `FrameListener`、`ConnectionListener` 和 remote flow controller listener，并为 stream / upgrade 创建 property key，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:167`。  
8. `Http2FrameCodec.newStream()` 当前返回 `DefaultHttp2FrameStream`，说明 API 层先有 stream 句柄，再由具体 frame 把它带入协议流，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:179`。  
9. `Http2MultiplexHandler` 当前类注释明确：它会为每个 stream 创建 child channel，必须与 `Http2FrameCodec` 配合使用，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:45`。  
10. 普通 `Http2StreamFrame` 当前会被分派到对应 child channel，而 `Http2ResetFrame` / `Http2PriorityFrame` 会改走 user event，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:168`、`:180`。  
11. `Http2MultiplexHandler` 当前在 `Http2FrameStreamEvent.Type.State` 到来时，会为 OPEN / HALF_CLOSED_* 等状态创建并注册 `Http2MultiplexHandlerStreamChannel`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:215`。  
12. `Http2MultiplexHandler` 当前类注释明确：child channel active 并不等于 HTTP/2 stream 已完全 active，真正映射到活跃 stream 还要等 headers 成功收发，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:75`。  
13. `Http2MultiplexHandler` 当前类注释明确：child channel writability 只观察 stream 级远端流控，并不知道 connection-level 窗口，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:83`。  
14. `Http2MultiplexHandler` 当前类注释明确：关闭 child channel 时，如有需要会发送 `RST_STREAM(CANCEL)`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:91`。  
15. `Http2StreamChannelBootstrap` 当前会在父 channel 上查找 `Http2MultiplexCodec` 或 `Http2MultiplexHandler` 的上下文，没有则报错或 closed，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2StreamChannelBootstrap.java:135`。  
16. `Http2StreamChannelBootstrap.open0(...)` 当前会创建 outbound stream channel，初始化 pipeline / option / attr，并在父 event loop 中注册，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2StreamChannelBootstrap.java:164`。  
17. `Http2FrameCodecTest.stateChanges()` 当前证明入站 headers 会建立 stream 并附着到 `Http2FrameStream`，随后 outbound response frame 可复用同一 stream 句柄，证据：`codec-http2/src/test/java/io/netty/handler/codec/http2/Http2FrameCodecTest.java:167`。  
18. `Http2MultiplexHandlerTest` 当前证明异常会被转发到 child channel 侧，且可被包装成 `Http2MultiplexActiveStreamsException` 形式，证据：`codec-http2/src/test/java/io/netty/handler/codec/http2/Http2MultiplexHandlerTest.java:59`。

### 深审发现

1. **中风险：容易把 `Http2FrameCodec` 写成单纯对象包装器。** 正文已补 `Http2FrameStream` 句柄与 stream 级异常边界。  
2. **中风险：容易把 child channel active 写成 stream 已完全建立。** 正文已明确分离这两层边界。  
3. **中风险：容易把 child channel writability 写成整个连接都可写。** 正文已保留“它不知道 connection-level window”的边界。  
4. **低风险：容易忽略 reset/priority 与普通 read 的传播差异。** 正文已单独立节说明 user event 路径。  
5. **低风险：容易写漏 API 层的引用计数责任。** 正文已在末段单独收网。

## 第二轮：因果审

- 只暴露父连接上的 frame 洪流 -> 业务需要自己做 stream 路由和状态管理 -> 这不是 Netty 风格 API：✅  
- `Http2FrameCodec` 先把 frame 变成带 stream 句柄的对象流 -> 后续 child channel 才有稳定附着点：✅  
- `Http2MultiplexHandler` 再把 stream 句柄投影成 child channel -> 业务才能复用 Netty pipeline 语义：✅  
- child channel active/writable/close 都只是 stream 局部视图，不等于父连接全局真相：✅  
- `Http2StreamChannelBootstrap` 的存在说明主动开 stream 也必须接入同一运行时语义，而不是裸构造对象：✅

## 第三轮：结构审

正文结构按“协议地基已懂但业务仍难写 -> 失败方案 -> FrameCodec 第一层翻译 -> stream 句柄 -> Multiplex 第二层翻译 -> 三个最易误解边界 -> Bootstrap -> ownership/异常传播 -> 收网”推进，没有按类文件顺序平铺。✅

失败方案已覆盖：
- 只暴露一条父连接上的所有 frame  
- 只做 frame 对象化，不做 child channel  
- 业务自己模拟 child pipeline  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `Http2FrameCodec` 负责 frame -> object 流的翻译  
- `Http2FrameStream` 是 API 层 stream 句柄，不是简单编号包装  
- `Http2MultiplexHandler` 负责 stream -> child channel 的投影  
- child channel active / writable / close 都只是局部 stream 语义  
- `Http2StreamChannelBootstrap` 负责主动开 outbound stream 的 Netty 式入口  
- ownership 与异常传播到 API 层依旧成立  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把 `Http2FrameCodec` 展开成完整 encoder/decoder 主链。✅  
- 未把 `Http2MultiplexCodec` 与 `Http2MultiplexHandler` 差异过度展开。✅  
- 未把 gRPC / Triple 细节提前写透，只建立桥接。✅  
- 未把 child channel writability 写成 connection-level flow control 的完整镜像。✅

## 第六轮：依赖审

- 依赖 Ch12-01 的 frame/stream/flow-control 地基，真实存在。✅  
- 依赖 Ch7-05 / Ch7-06 的托管区、writability 与 flush 前置，真实存在。✅  
- 依赖 Ch4-06 / Ch4-07 的 ownership 与 leak-aware 前置，真实存在。✅  
- 后续 encoder/decoder 主链与 gRPC/Triple 只作导航，没有把后文结论当前置。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 15,950。  
- 去掉常见 markdown 标记后的字符数：约 15,577。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立 HTTP/2 Netty API 层的三层翻译主线：frame -> object，`Http2FrameStream` 负责承接 stream 句柄，stream -> child channel。Ch12-02 可作为后续 encoder/decoder 主链与 gRPC / Triple 映射篇的直接前置篇。