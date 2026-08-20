# Ch12-04 gRPC / Dubbo Triple 如何落在 HTTP/2 API 与连接主链上 — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `GrpcHttp2ConnectionHandler` 当前明确继承 `Http2ConnectionHandler`，是 gRPC 对它的 wrapper/subclass，而不是独立重写的 HTTP/2 连接处理器，证据：`grpc-java/netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:32`。  
2. `GrpcHttp2ConnectionHandler` 当前额外承载 negotiation attributes / securityInfo / channelUnused / authority 等 transport 级语义，证据：`grpc-java/netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:37`。  
3. `NettyServerHandler.newHandler(...)` 当前会显式创建 frame reader、frame writer、`DefaultHttp2Connection`、encoder、decoder 和相关 transport 组件，证据：`grpc-java/netty/src/main/java/io/grpc/netty/NettyServerHandler.java:159`。  
4. `NettyClientHandler.newHandler(...)` 当前也会显式创建 connection、reader、writer、remote flow controller 和 distributor，证据：`grpc-java/netty/src/main/java/io/grpc/netty/NettyClientHandler.java:156`、`:177`。  
5. gRPC client handler 当前维护 authority、keepalive、in-use 状态、ping、transport tracer 等 RPC 语义，证据：`grpc-java/netty/src/main/java/io/grpc/netty/NettyClientHandler.java:120`。  
6. `GrpcHttp2Protocol` 当前只是 `TripleHttp2Protocol` 的一个激活入口变体，证据：`dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/GrpcHttp2Protocol.java:19`。  
7. `TripleHttp2Protocol.configClientPipeline(...)` 当前显式组装 `Http2FrameCodec`、`Http2MultiplexHandler`、`TriplePingPongHandler`、`TripleGoAwayHandler`、`TripleTailHandler` 等，证据：`dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:104`。  
8. `TripleHttp2Protocol` 当前会为 client/server connection 注入 `TripleHttp2LocalFlowController` 和 `TripleHttp2RemoteFlowController`，证据：`dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:128`。  
9. `TripleHttp2Protocol.configurerHttp2Handlers(...)` 当前显式组装 `HttpWriteQueueHandler`、`Http2FrameCodec`、settings handler、`FlushConsolidationHandler`、`TripleServerConnectionHandler`、`Http2MultiplexHandler`、`TripleTailHandler`，证据：`dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:236`。  
10. `buildHttp2MultiplexHandler(...)` 当前在 child stream channel 上设置 `AUTO_STREAM_FLOW_CONTROL=false` 并插入 `NettyHttp2FrameCodec` 与 protocol selector，证据：`dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:212`。  
11. `TripleInvoker` 当前通过 `AbstractConnectionClient`、`TripleClientCall`、`TripleWriteQueue`、`ThreadlessExecutor/streamExecutor` 发起 unary 或 streaming 调用，证据：`dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleInvoker.java:91`、`:143`、`:171`。  
12. `TripleInvoker` 当前并不是直接写字节，而是围绕 `RequestMetadata`、`TripleClientCall` 和不同 `RpcType` 分支组织调用，证据：`dubbo/dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleInvoker.java:178`。

### 深审发现

1. **高风险：容易把 gRPC / Triple 写成各自重写一整套 HTTP/2 栈。** 正文已明确它们分别复用连接主链或 API 层组合。  
2. **中风险：容易把 RPC 调用写成脱离 stream / flow control / GOAWAY 的纯业务流程。** 正文已反复压回 HTTP/2 主线。  
3. **中风险：容易把 Triple 写成直接发字节。** 正文已补 `TripleClientCall` / `TripleWriteQueue` / `RequestMetadata`。  
4. **低风险：容易把 gRPC / Triple 的差异写成“谁更底层”。** 正文改成“谁更偏连接 handler 封装、谁更偏 API/pipeline 组合”。

## 第二轮：因果审

- 前三篇已建 HTTP/2 地基/API/连接主链 -> RPC 只需补最后一层语义翻译：✅  
- gRPC 通过 `GrpcHttp2ConnectionHandler` 和 Netty*Handler 把 transport 语义挂到连接主链：✅  
- Triple 通过 `TripleHttp2Protocol` 显式组合 FrameCodec / Multiplex / flow controller / tail handlers：✅  
- `TripleInvoker` 说明方法调用最终仍回到 stream / write queue / async executor：✅  
- 两条线姿态不同，但都没有绕开 HTTP/2 stream、flow control、GOAWAY、write/flush 主线：✅

## 第三轮：结构审

正文结构按“前面三篇地基已好 -> 失败方案 -> gRPC wrapper/handler 线 -> Triple protocol/pipeline 线 -> TripleInvoker -> 对照收束 -> 收网”推进，没有按项目源码目录顺序平铺。✅

失败方案已覆盖：
- RPC 框架自己重写整套 HTTP/2 传输  
- 完全无视 FrameCodec / Multiplex，只按 streamId 硬路由  
- 把 RPC 调用简单等同为“发字节”  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- gRPC 更贴近连接 handler 封装  
- Triple 更贴近 FrameCodec / Multiplex / pipeline 组合  
- `TripleInvoker` 如何把方法调用落到 HTTP/2 stream/write queue 语义  
- 两者都没有绕开 HTTP/2 主链，只是在其上补最后一层 RPC 语义翻译  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把 gRPC / Triple 全部业务编解码细节展开。✅  
- 未深入 TLS/ALPN 协商细节，只保留 negotiation/authority/securityInfo 背景。✅  
- 未把两者所有 transport 优化逐项比较，只强调它们各自复用哪一层。✅

## 第六轮：依赖审

- 依赖 Ch12-01/02/03 的 HTTP/2 协议地基、API 层与连接主链，真实存在。✅  
- 依赖 Ch7-05/06 的 write/flush/writability 前置，真实存在。✅  
- 依赖 Ch4-06 ownership 前置，真实存在。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 13,027。  
- 去掉常见 markdown 标记后的字符数：约 12,670。  
- 目标定位：重大桥接篇，满足篇幅要求。✅

## 结论

当前正文已经建立 gRPC 与 Dubbo Triple 到 Netty HTTP/2 API 层与连接主链的桥接主线。Ch12-04 可作为后续 gRPC streaming、Triple transport 和跨框架对照分析的直接前置篇。