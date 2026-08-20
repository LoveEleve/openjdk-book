# Ch12-01 `01-http2-codec.md` review notes

## 第一轮：事实审

### 已核对的核心结论

1. `DefaultHttp2FrameReader.preProcessFrame()` 当前按 3B length、1B type、1B flags、4B streamId 读取 9 字节帧头，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:188`。
2. 标准 HTTP/2 帧类型常量当前确实是 10 种：DATA/HEADERS/PRIORITY/RST_STREAM/SETTINGS/PUSH_PROMISE/PING/GO_AWAY/WINDOW_UPDATE/CONTINUATION，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameTypes.java:21`。
3. `DefaultHttp2FrameReader.readFrame()` 当前流程是 `preProcessFrame -> verifyFrameState -> processPayloadState`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:147`。
4. `DefaultHttp2FrameReader` 当前在 `verifyContinuationFrame()` 中强制 continuation streamId 与 pending headers streamId 一致，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:391`。
5. `readHeadersFrame()` / `readDataFrame()` / `readSettingsFrame()` / `readWindowUpdateFrame()` 当前分别按 frame type 分发到 listener，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:246`、`:415`、`:427`、`:525`、`:595`。
6. `DefaultHttp2Connection` 当前维护 `streamMap`、`activeStreams`、`localEndpoint`、`remoteEndpoint` 作为多 Stream 连接状态，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:63`。
7. `DefaultEndpoint` 当前 server 端从 streamId=2 开始，client 端从 streamId=1 开始，并用奇偶判断 streamId 是否归当前端点，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:731`、`:761`。
8. `createStream()` 当前会校验新 streamId、创建 `DefaultStream`、加入 `streamMap` 并 activate，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:776`。
9. `DefaultStream` 当前维护 `State` 与若干 metaState 位，支持 `OPEN/HALF_CLOSED_*/CLOSED` 等状态推进，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:381`。
10. `goAwaySent/goAwayReceived` 当前会更新 `lastStreamKnownByPeer` 并关闭超过该 streamId 的活跃流，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:226`、`:250`、`:277`。
11. `HpackStaticTable` 当前静态表共 61 项，其中 `:method GET` 在索引 2，`:method POST` 在 3，`:path /` 在 4，`:path /index.html` 在 5，`:status 200` 在 8，`:status 404` 在 13，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/HpackStaticTable.java:52`。
12. `HpackEncoder.encodeHeader()` 当前优先处理敏感 header，再看动态表、静态表，否则 literal 编码并在允许时加入动态表，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/HpackEncoder.java:161`。
13. `HpackDecoder.decode()` 当前会先 `decodeDynamicTableSizeUpdates()`，再进主状态机解 header representation，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/HpackDecoder.java:126`。
14. `HpackDecoder` 中多类压缩错误被定义为 `ShutdownHint.HARD_SHUTDOWN` 的连接级错误，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/HpackDecoder.java:55`。
15. `DefaultHttp2LocalFlowController.DEFAULT_WINDOW_UPDATE_RATIO` 当前是 `0.5f`，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2LocalFlowController.java:47`。
16. `consumeBytes(stream, numBytes)` 当前确实会同时消费 connectionState 和 stream state，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2LocalFlowController.java:176`、`:195`。
17. `DefaultHttp2RemoteFlowController.isWritable(stream)` 当前要求 `isWritableConnection() && state.isWritable()` 同时成立，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2RemoteFlowController.java:170`、`:606`。
18. 连接级 writability 当前还受 `Channel.isWritable()` 与 `connectionState.windowSize() - totalPendingBytes > 0` 共同约束，证据：`codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2RemoteFlowController.java:655`。

### 术语精度检查

- 正文把 streamId 说成“最小路由键”，符合帧 reader 先根据 streamId 再把 frame 交给上层流语义的事实。
- 正文没有把 HPACK 写成“纯静态表压缩”；已明确动态表是连接级共享。
- 正文把 HTTP/2 的 HOL 改善限定在应用层/请求层，没有误写成 TCP 层彻底消除。

## 第二轮：因果审

### 因果链是否成立

1. “HTTP/2 的提升不只是二进制，而是把连接与请求拆成 frame + stream 两层” 由 9B 帧头 + streamId 路由 + `DefaultHttp2Connection` 流状态维护共同支撑，成立。
2. “奇偶 streamId 提供双方各自的编号空间，避免冲突并指示发起方” 由 endpoint 初始化与 `isValidStreamId` 逻辑直接支撑，成立。
3. “HPACK 动态表连接级共享，因此收益和风险都跨 Stream 扩散” 由 encoder/decoder 的连接级状态和 hard shutdown 错误语义直接支撑，成立。
4. “双层流控解决的是总量控制 + 单流公平性，两者缺一不可” 由 local/remote flow controller 的 connection+stream 双重消费/判定直接支撑，成立。
5. “gRPC 只是把 RPC 语义映射到 HEADERS/DATA/END_STREAM” 作为跨框架桥接属于概念性总结，未当作源码细节展开，表述克制。

### 需要克制的推断

- 正文说“二进制更快不只是 CPU 喜欢数字，而是定长头和状态机更容易解析”，这是基于帧 reader 结构的合理解释，没有夸大成 benchmark 结论。
- 对 HTTP/3/QUIC 的提及仅限传输层 HOL 边界，不把其内部实现当前置事实。

## 第三轮：结构审

### 当前结构是否按理解路径推进

1. 从 HTTP/1.1 连接与请求绑死的痛点切入。
2. 先推演“只是把报文变二进制 / 还是一连接一请求 / 只做连接级窗口”的失败方案。
3. 再讲 9 字节帧头和 reader 主线。
4. 然后讲 Stream 生命周期与奇偶 streamId。
5. 再讲 HPACK 静态/动态表。
6. 再讲双层流控。
7. 最后用误解澄清和 gRPC/Triple 桥接收束。

这符合“问题 -> 失败 -> 顿悟 -> 机制 -> 回收”，不是按源码文件顺序机械解说。

### 结构风险检查

- 没有先讲 HPACK 细节再补 frame/stream 背景，顺序正确。
- 没有把 `Http2FrameCodec`/`Http2MultiplexHandler` API 层细节混进底层机制主线，范围控制正确。
- gRPC 桥接放在篇末，不挤占当前机制线。

## 第四轮：读者审

### 删码测试判断

删除 fenced code block 后，正文仍能复述：

1. HTTP/2 为什么要把连接和请求分层。
2. 9 字节帧头如何成为多路复用的路由基础。
3. streamId 奇偶和 Stream 状态如何工作。
4. HPACK 为什么是连接级上下文压缩。
5. 为什么流控要分连接级和流级两层。

代码块和 file:line 主要承担证据位，不承担全部叙事骨架。

### 阅读风险点

- HTTP/2 组件较多，正文已先给出“frame/stream/hpack/flow control”四层总图再分讲，减轻碎片感。
- HPACK 容易滑成过度编码细节；正文只保留静态表关键索引、命中路径和动态表共享后果，控制合理。
- 流控容易空泛；正文抓住 `consumeBytes` 和 `isWritable` 两个最核心入口解释，足够支撑理解。

## 第五轮：边界审与缺陷猎取

### 已覆盖边界

- HTTP/2 只消除应用层 HOL，TCP 层 HOL 仍在。
- streamId=0 仅用于连接级控制，不参与普通请求流。
- GOAWAY 会限制后续可创建 streamId，并关闭超过 last-known-stream 的活跃流。
- HPACK 动态表共享导致连接级上下文损坏风险。
- 流控窗口双层消费与双层判定。

### Bug / issue 候选检查

本轮未形成可单列 issue 的源码缺陷：

- `DefaultHttp2FrameReader` 的 9B 头读取、帧大小检查和 continuation 状态校验当前自洽，未发现明显状态穿透漏洞。
- `DefaultHttp2Connection` 的奇偶 streamId、GOAWAY 限制和 active stream 生命周期当前逻辑一致，未发现可证实的编号或状态机漏洞。
- HPACK 动态表共享与 hard shutdown 是协议设计代价，不是当前实现 bug。
- local/remote flow controller 的双窗口逻辑与类注释、接口语义一致，本轮未发现窗口更新竞态证据。

结论：本篇未发现需要单列 issue 候选的源码 bug。

## 第六轮：依赖审

### 前置依赖

- Ch11 HTTP：请求/响应语义、header/body 分层是本篇理解 HEADERS/DATA 的硬前置，真实存在。
- Ch10 Codec：frame reader / state machine 解析风格是本篇理解 `DefaultHttp2FrameReader` 的硬前置，真实存在。
- Ch7 Pipeline：listener 回调和 codec 分层属于软前置，已在正文中只复用必要结论。
- Ch14 timer 仅作为“状态拥有者”设计风格的延续，不承担硬依赖。

### 后续桥接

- gRPC / Dubbo Triple 桥接只停留在传输语义层，未把后续源码分析结论前置成已知事实。
- 没有把 HTTP/3 细节混入当前主线，只保留边界提示。

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

预期：正文不命中。

### 删码测试目标

删除全部 fenced code block 后，正文仍应保留：

- frame/stream/hpack/flow-control 四层总图
- 9 字节帧头与 streamId 路由逻辑
- 奇偶 streamId 与 Stream 生命周期
- HPACK 连接级共享上下文
- 双层流控的设计意图