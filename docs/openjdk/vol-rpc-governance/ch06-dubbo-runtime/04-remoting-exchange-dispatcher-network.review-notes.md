# Dubbo：Remoting、Exchange、Dispatcher 与网络/线程派发 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `DubboInvoker.doInvoke()` 从 `RpcInvocation` 选择 `ExchangeClient`、计算 timeout、创建 Request、放入 invocation data，并按 one-way/two-way 选择 `send()` 或 `request()`，证据：`dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboInvoker.java:89`、`:119`、`:128`、`:133`。
2. `HeaderExchanger` 把底层 Client 包成 `HeaderExchangeClient`，后者再持有 `HeaderExchangeChannel`，证据：`dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/exchange/support/header/HeaderExchanger.java:40`、`HeaderExchangeClient.java:66`。
3. `HeaderExchangeChannel.request()` 创建 `DefaultFuture`、注册 timeout、发送 Request，证据：`HeaderExchangeChannel.java:135`、`:153`。
4. Netty pipeline 通过 `NettyCodecAdapter` 调用 Dubbo codec，将 Request/Response 对象和 ByteBuf/网络字节互转，证据：`dubbo-remoting-netty4/src/main/java/org/apache/dubbo/remoting/transport/netty4/NettyClient.java:111`、`NettyCodecAdapter.java:63`、`NettyServer.java:168`。
5. `DubboCodec` 在 request 分支创建 Request、读取 two-way/event/payload，并进一步创建 `DecodeableRpcInvocation`，证据：`dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboCodec.java:154`、`:187`。
6. `HeaderExchangeHandler.received()` 按 request/response/one-way/event 分派，`handleRequest()` 调用 `ExchangeHandler.reply()` 并在 CompletionStage 完成后构造 Response，证据：`dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/exchange/support/header/HeaderExchangeHandler.java:196`、`:107`。
7. `DubboProtocol.requestHandler.reply()` 根据 service key 查 exporter，取得 invoker 并执行 `invoker.invoke(inv)`，证据：`dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboProtocol.java:118`、`:318`、`:331`。
8. `Transporter` 负责 connect/bind，`Channel` 代表单条连接，不负责 RPC 路由和业务执行，证据：`dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/Transporter.java:24`、`Channel.java:21`。
9. `ExecutionChannelHandler` 只把 Request 事件交给 executor，response/connect/disconnect/heartbeat 可留在当前 IO 线程，证据：`dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/transport/dispatcher/execution/ExecutionChannelHandler.java:33`、`:43`。
10. `Request.twoWay=false` 表示 one-way，仍然发送请求但 provider 不走普通 response 路径，证据：`DubboInvoker.java:128`、`HeaderExchangeHandler.java:204`。
11. heartbeat 通过 Request event 标记，与普通 RPC response 匹配分开，证据：`NettyClientHandler.java:99`、`Request.java:144`、`HeaderExchangeHandler.java:63`。

### 测试证据已核对

1. `HeaderExchangeHandlerTest` — request/response/one-way/异常响应。
2. `HeaderExchangeChannelTest` — future、send、timeout、closed channel。
3. `HeartbeatHandlerTest` — heartbeat request/response/idle close。
4. `ChannelEventRunnableTest` — dispatcher 事件与线程。
5. Netty codec/client/server handler tests — encode/decode、半包、多包。
6. Dubbo protocol tests — service key、exporter 查找、provider invoke。

### 深审发现

1. **高风险：容易把 Invoker 直接等同于网络 client。** 当前正文已拆开 RPC/Exchange/Transport 三层。
2. **高风险：容易把 Request 和 RpcInvocation 混为一谈。** 当前正文已明确 Request 是 exchange envelope，Invocation 是 data。
3. **中风险：容易把 one-way 写成“不发送”。** 当前正文已说明 one-way 仍发送，只是不期待业务 response。
4. **中风险：容易把 heartbeat 当普通 RPC。** 当前正文已将 heartbeat event 单独隔离。
5. **低风险：容易忽略 IO 线程到业务 executor 的边界。** 当前正文已用 execution dispatcher 作为主例。

## 第二轮：因果审

- Invoker 必须先转换为 Request，才能让 RPC 调用语义进入 exchange 层：✅
- Request 必须独立于 RpcInvocation，才能同时表达 request id、two-way、heartbeat、event 等控制语义：✅
- Exchange 必须先登记 DefaultFuture 再发送 request，否则 response 到达时无法按 id 找回原调用：✅
- Codec 必须独立于 Transporter/Channel，否则协议对象和网络实现会耦合：✅
- Dispatcher 必须独立于 Codec/Protocol，否则 IO event loop 会直接承载业务执行：✅
- provider 必须经过 service key → exporter → invoker，才能在协议层隔离业务对象和网络请求：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → consumer/provider 总图 → DubboInvoker → Exchange → Transport/Codec → Provider 入站 → Dispatcher → request-response/one-way/heartbeat/timeout → 误解澄清 → 收网总结”推进，没有退化成 Netty 源码导览。

失败方案已覆盖：
- Invoker 直接操作 Netty socket
- Request 就是 RpcInvocation
- 网络解码和业务执行必须同一个线程

每一层拆解均包含：角色边界 → 对象转换 → 运行时证据 → 线程/协议结论，符合 remoting 主干篇要求。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- consumer `Invoker → Request → ExchangeClient → Channel → Codec → network`
- provider `network → Codec → Request → ExchangeHandler → DubboProtocol → Exporter/Invoker`
- Transporter、Codec、Exchange、Dispatcher 四层边界
- one-way、heartbeat、timeout 的区别
- IO event loop 到业务 executor 的派发边界

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开 Dubbo 二进制协议 header 字段。✅
- 未展开 Hessian/Kryo/Protobuf 等具体序列化实现。✅
- 未展开 Triple/HTTP2/TLS 等其他协议和连接实现。✅
- 未展开完整线程池配置、连接复用、callback service、graceful shutdown。✅
- 重点仍压在默认 Dubbo + Header Exchange + Netty 网络主线，边界收得住。✅

## 第六轮：依赖审

- 已承接第二篇 Invoker/Protocol/Exporter/Proxy 窄腰：本篇解释 Invoker 如何进入网络。
- 已承接第三篇 Directory/Router/LoadBalance/Cluster：本篇默认上游已经选出具体 Invoker。
- 后续可自然承接 Dubbo2/Triple 协议对照与生产网络诊断。

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅
- 代码块：使用少量文字图，不承担主叙事骨架。✅
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `DubboInvoker`、`HeaderExchangeChannel`、`NettyCodecAdapter`、`DubboCodec`、`HeaderExchangeHandler`、`DubboProtocol`、`ExecutionChannelHandler`。
- 去掉代码块后正文仍成立：是。✅
- 叙述性正文字符数（不含代码块与空白行）：约 `15,919`。
- 目标定位：Dubbo remoting/exchange 主干篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 Dubbo 的“网络魔法”拆成四层边界：Transporter/Channel 搬字节，Codec 转对象，Exchange 管 request-response，Dispatcher 管线程；再由 DubboProtocol 把解码后的 Invocation 接回 Exporter/Invoker。只要这条链成立，后续具体协议和生产网络问题都能在正确的层级上继续展开。