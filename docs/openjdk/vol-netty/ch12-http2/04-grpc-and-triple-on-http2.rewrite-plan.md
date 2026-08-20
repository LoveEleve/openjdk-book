# Ch12-04 gRPC / Dubbo Triple 如何落在 HTTP/2 API 与连接主链上 — rewrite plan

## 篇章定位

- 核心困惑：前面已经把 Netty 的 HTTP/2 协议地基、API 层和连接主链讲清楚了，但真正落到上层 RPC 框架时，gRPC 和 Dubbo Triple 是如何把“方法调用 / StreamObserver / 调用元数据 / 写队列 / 连接事件”挂到这些 HTTP/2 组件上的？为什么它们看起来像 RPC，但底下其实仍然在吃 `Http2ConnectionHandler`、frame、flow control 和 child channel 这条主线？
- 一句话顿悟：gRPC 和 Dubbo Triple 并不是各自重新实现一套 HTTP/2 传输栈，而是在 Netty 已经准备好的 HTTP/2 连接主链和 API 层之上，各自补上 RPC 语义翻译：gRPC 通过 `GrpcHttp2ConnectionHandler`、`NettyServerHandler`、`NettyClientHandler` 把 metadata、stream、keepalive、状态机和 listener 接到 `Http2ConnectionHandler` 上；Dubbo Triple 则通过 `TripleHttp2Protocol`、`Http2FrameCodec`、`Http2MultiplexHandler`、`TripleInvoker` 和自定义 flow controller，把 Dubbo 的调用模型投影到同样的 HTTP/2 frame/stream/runtime 上。
- 文章边界：本篇主讲“RPC 语义如何接入前面已经分析过的 Netty HTTP/2 运行时”，通过 gRPC 与 Dubbo Triple 两条对照线解释它们分别复用/扩展了哪一层；不完整展开 gRPC 全部调用路径，不完整展开 Dubbo Triple 业务编解码细节。

## 依赖声明

### HARD

- Ch12-01 `ch12-http2/01-http2-codec.md`：HTTP/2 协议地基。
- Ch12-02 `ch12-http2/02-framecodec-and-multiplex.md`：FrameCodec / Multiplex API 层。
- Ch12-03 `ch12-http2/03-connection-encoder-decoder.md`：连接主链、Encoder/Decoder、流控与 GOAWAY。
- Ch7-05 / Ch7-06：出站托管区、writability、write/flush 主线。
- Ch4-06：ownership 与引用计数边界。

### SOFT

- Ch8-07：指标与调优只作为诊断背景，不承担硬依赖。

### NAV

- 后续：gRPC streaming call / server handler 深入。
- 后续：Dubbo Triple transport / listener / protocol selector 深入。

## 结构设计

### 1. 开场：协议主链已经有了，RPC 框架还要补什么
- 回收前面三篇：协议地基、API 层、连接主链。
- 引出新的问题：RPC 需要把方法调用、元数据、stream observer、状态和错误映射到这条链上。
- 预计 900-1200 字。

### 2. 失败方案：如果 RPC 框架自己重写一套 HTTP/2 传输，会卡在哪
- 失败方案 A：自己重写连接状态机、SETTINGS、GOAWAY、流控。
- 失败方案 B：完全无视 Netty child channel / frame object 语义，只拿 `streamId` 硬路由。
- 失败方案 C：把 RPC 消息直接等同于“某个字节数组写出去”。
- 预计 1500-1900 字。

### 3. gRPC 线：`GrpcHttp2ConnectionHandler` 如何把 RPC 语义挂到 `Http2ConnectionHandler`
- `GrpcHttp2ConnectionHandler` 不是重新实现连接处理器，而是 wrapper/subclass。
- `NettyServerHandler` / `NettyClientHandler` 如何构造 connection、reader、writer、remote/local flow controller。
- gRPC 如何把 metadata、authority、keepalive、transport listener、WriteQueue 等附着到 HTTP/2 主链。
- 预计 2200-2800 字。

### 4. Dubbo Triple 线：`TripleHttp2Protocol` 如何复用 FrameCodec / Multiplex / ConnectionHandler
- `GrpcHttp2Protocol` 只是 `TripleHttp2Protocol` 的一个变体入口。
- client pipeline：`Http2FrameCodec` + `Http2MultiplexHandler` + ping/goaway/tail handlers。
- server pipeline：codec、settings handler、FlushConsolidationHandler、server connection handler、multiplex handler。
- 自定义 local/remote flow controller 与 `TripleHttp2FrameCodecBuilder` 的意义。
- 预计 2400-3000 字。

### 5. `TripleInvoker`：为什么 RPC 调用最终还是回到 HTTP/2 stream/writeQueue 上
- `TripleInvoker` 如何基于 `AbstractConnectionClient`、`TripleClientCall`、`TripleWriteQueue`、`RequestMetadata` 发起 unary / stream 调用。
- 为什么 sync unary 会引入 `ThreadlessExecutor`，streaming 则走 `streamExecutor`。
- 说明 RPC 语义在上层，但底下仍靠 HTTP/2 write/stream 运行时推进。
- 预计 1800-2300 字。

### 6. 对照收束：gRPC 与 Triple 分别复用了哪一层
- gRPC 更贴近 connection handler / transport handler 封装。
- Triple 更显式复用 FrameCodec / Multiplex / ProtocolSelector 管线组合。
- 但两者都没有绕开 HTTP/2 的 stream、flow control、GOAWAY、write queue 和 ownership 主线。
- 预计 1200-1600 字。

### 7. 收网
- 总结：RPC 不是跳过 HTTP/2，而是把方法/元数据/observer 语义映射到现有连接主链与 API 层之上。
- 桥接到后续更具体的 gRPC streaming 或 Triple transport 专题。
- 预计 600-800 字。

## 证据清单

- `grpc-java/netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:32-110`
- `grpc-java/netty/src/main/java/io/grpc/netty/NettyServerHandler.java:114-215`
- `grpc-java/netty/src/main/java/io/grpc/netty/NettyClientHandler.java:98-201`
- `grpc-java/netty/src/main/java/io/grpc/netty/NettyClientHandler.java:177-182`
- `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/GrpcHttp2Protocol.java:19-22`
- `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:104-126`
- `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:128-133`
- `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:167-209`
- `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:212-249`
- `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleInvoker.java:91-175`
- `dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleInvoker.java:208-259`

## 误解清单

1. gRPC 自己重写了一套和 Netty 无关的 HTTP/2 连接处理器。
2. Dubbo Triple 只是“业务协议包了一层 HTTP/2 壳”，并没有真正接入 FrameCodec / Multiplex / flow control 主线。
3. `StreamObserver` 或 `Invoker` 一出现，底层 `Http2ConnectionHandler` 就不重要了。
4. RPC 调用成功/失败可以脱离 stream、GOAWAY、writability 和 write queue 单独理解。
5. gRPC 和 Triple 都是在“绕开 Netty HTTP/2 API 层”。

## 边界清单

- 本篇不把 gRPC / Triple 业务编解码细节完整展开，只抓其与 Netty HTTP/2 主线的连接点。
- 本篇不深入 TLS/ALPN 协议协商细节，只在必要处点到 negotiation / authority / securityInfo。
- 本篇不把 Triple 和 gRPC 的所有传输优化逐项比较，只强调它们各自复用 Netty 哪一层。

## 深审预警

- [ ] 不把 gRPC / Triple 写成独立重写 HTTP/2 栈。
- [ ] 不把 RPC 调用语义写成脱离 stream / flow control / GOAWAY 的纯业务流程。
- [ ] 不把 `TripleInvoker` 写成直接发字节，要保留 `TripleClientCall` / `TripleWriteQueue` 这层。
- [ ] 不把 `GrpcHttp2ConnectionHandler` 写成普通工具类，要强调它是 `Http2ConnectionHandler` 的包装/子类。