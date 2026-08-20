# Dubbo：Remoting、Exchange、Dispatcher 与网络/线程派发 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch06-dubbo-runtime`
- 篇：`04 Remoting、Exchange、Dispatcher 与网络/线程派发`
- 对应主题：`D-MAIN-4 Remoting / Exchange / Dispatcher`
- 文章类型：主干运行时网络篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：前三篇已经讲清 Dubbo 如何 export/refer、Invoker 如何成为窄腰、consumer 如何经过 Directory/Router/LoadBalance/Cluster 选出目标，但读者仍然没有看到“真正的网络请求”是怎么发生的：`Invoker.invoke()` 什么时候变成 `Request`？`Request` 如何变成字节？Response 又如何按 request id 回到原来的 future？provider 收到字节后，什么时候从 Netty IO 线程切到业务线程？
- 一句话顿悟：Dubbo 把“调用变成网络”拆成四层：`Transporter/Channel` 负责连接和字节搬运，`Codec` 负责对象与 wire bytes 互转，`Exchange` 负责 Request/Response、request id、future、one-way/heartbeat，`Dispatcher` 负责 handler 事件在哪个线程执行；最后 `DubboProtocol` 把解码后的 `Invocation` 接回 exporter/invoker，完成“网络消息 → 业务调用”的最后一跳。
- 文章边界：本篇重点讲默认 Dubbo + Header Exchange + Netty 的完整 consumer/provider 网络主线、Request/Response 匹配、Codec 接入、one-way/heartbeat/timeout 和 dispatcher 线程切换；不展开具体二进制协议字段、序列化算法、Triple/HTTP/2 具体协议、TLS 和完整线程池配置。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/02-invoker-protocol-exporter-proxy-filter.md`：已经知道 Invoker、Protocol、Exporter 和 Proxy 窄腰。
- `ch06-dubbo-runtime/03-directory-router-loadbalance-cluster.md`：已经知道 consumer 最终怎样选出目标 Invoker。

### SOFT

- 不要求先懂 Netty 全量源码。
- 不要求先懂 Dubbo 二进制协议每个 header 字段。

### NAV

- 后续可接：Dubbo2 / Triple 协议对照
- 后续可接：线程池、连接复用、心跳与生产诊断专题

## 一句话困惑

一次 `Invoker.invoke()` 如何变成网络上的字节，provider 又如何把这些字节还原成 Invocation 并回到业务对象？Request/Response、Codec、Channel、Dispatcher 各在哪一层负责什么？

## 一句话顿悟

Dubbo 的网络主线是：consumer `Invoker -> Request -> ExchangeClient -> Channel -> Codec -> socket`，provider `socket -> Codec -> Request -> Dispatcher -> ExchangeHandler -> DubboProtocol -> Exporter/Invoker`；Transporter 搬字节，Codec 转换对象，Exchange 管 request-response，Dispatcher 管线程，Protocol 把解码后的 invocation 接回业务调用。

## 读者理解路径

1. 先否定“Invoker 直接写 socket”或“Protocol 直接阻塞等响应”的粗糙理解。
2. 建立 consumer/provider 双向总图。
3. 解释 consumer `DubboInvoker.doInvoke()` 如何把 RpcInvocation 放进 Request。
4. 解释 HeaderExchangeChannel 如何用 request id 和 DefaultFuture 关联 response。
5. 解释 Channel/Transporter/Netty pipeline 如何搬运并编码字节。
6. 解释 provider Codec 如何从半包字节恢复 Request/Invocation。
7. 解释 ExchangeHandler 如何区分 request/response/one-way/heartbeat。
8. 解释 DubboProtocol 如何按 service key 找 Exporter/Invoker。
9. 解释 Dispatcher 如何把网络 IO 事件与业务执行线程分开。
10. 收束到四层边界：Transporter、Codec、Exchange、Dispatcher。

## 失败方案推演

### 失败方案一：Invoker 直接操作 Netty socket

- 这会让 RPC 语义和具体网络实现耦合。
- Invoker 应只表达调用，Exchange/Transport 才负责 Request、Channel 和字节。
- 否则 Dubbo2、Triple、Injvm 等协议无法共享统一的调用抽象。

### 失败方案二：Request 就是 RpcInvocation

- Request 是 exchange 层的 envelope，包含 id、two-way、event、payload、data。
- RpcInvocation 是 RPC 层的数据体，放在 `Request.data` 中。
- 二者混在一起会导致 request-response、heartbeat、one-way 与业务 invocation 语义无法分层。

### 失败方案三：网络解码和业务执行必须在同一个线程

- 这会把 Netty IO event loop 和 provider 业务处理互相阻塞。
- `Dispatcher` 可以把 Request 提交到业务 executor，而 response、connect、heartbeat 等事件保留在 IO 线程。
- 所以线程派发是独立的运行时边界，不是 Codec 或 Protocol 的附属细节。

## 必须澄清的误解

1. `Channel` 不是 RPC client，也不是业务调用对象，只代表一条连接。
2. `Request` 不是 `RpcInvocation`，它是 exchange envelope，Invocation 是其中的 data。
3. `twoWay=false` 不是“不发送”，而是发送但不期待业务 response。
4. `sent=true` 与 two-way 是两套不同语义，前者是发送确认，后者是业务响应。
5. `ExchangeClient.request()` 负责 future/response 关联，不负责业务执行。
6. Dispatcher 决定事件在哪个线程执行，不负责协议路由或 exporter 查找。

## 文章结构与字数预算

1. 困惑开场：为什么 Invocation 到网络不是一步（800-1000 字）
2. 最小总图：consumer/provider 双向网络主线（1000-1400 字）
3. Consumer：DubboInvoker -> Request -> ExchangeClient（1400-2000 字）
4. Exchange：HeaderExchangeChannel、DefaultFuture、Request/Response（1600-2200 字）
5. Transport 与 Codec：Channel 如何变成网络字节（1400-2000 字）
6. Provider：字节 -> Request -> ExchangeHandler -> Protocol -> Invoker（1800-2400 字）
7. Dispatcher：IO event loop 如何切到业务 executor（1200-1800 字）
8. one-way/heartbeat/timeout 与边界误解（1000-1400 字）
9. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

### consumer outbound
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboInvoker.java:89` — 选择 ExchangeClient
- `DubboInvoker.java:119` — 创建 Request / 放入 invocation data
- `DubboInvoker.java:128` — one-way send
- `DubboInvoker.java:133` — two-way request
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/exchange/support/header/HeaderExchangeChannel.java:135` — request 包装
- `HeaderExchangeChannel.java:153` — DefaultFuture / timeout / send

### transport / codec
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/Transporter.java:24` — Transporter SPI
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/Channel.java:21` — Channel
- `dubbo-remoting/dubbo-remoting-netty4/src/main/java/org/apache/dubbo/remoting/transport/netty4/NettyClient.java:111` — client pipeline
- `dubbo-remoting/dubbo-remoting-netty4/src/main/java/org/apache/dubbo/remoting/transport/netty4/NettyCodecAdapter.java:63` — outbound encode
- `dubbo-remoting/dubbo-remoting-netty4/src/main/java/org/apache/dubbo/remoting/transport/netty4/NettyServer.java:168` — server pipeline
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboCodec.java:154` — request decode
- `DubboCodec.java:187` — DecodeableRpcInvocation

### provider inbound / exchange
- `dubbo-remoting/dubbo-remoting-netty4/src/main/java/org/apache/dubbo/remoting/transport/netty4/NettyServerHandler.java:112` — handler.received
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/exchange/support/header/HeaderExchanger.java:47` — provider exchange handler chain
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/exchange/support/header/HeaderExchangeHandler.java:196` — request/response/one-way 分派
- `HeaderExchangeHandler.java:107` — reply / response
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboProtocol.java:118` — request handler
- `DubboProtocol.java:318` — service key 查 exporter
- `DubboProtocol.java:331` — exporter invoker invoke

### dispatcher
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/Dispatcher.java:27` — Dispatcher SPI
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/transport/dispatcher/ChannelHandlers.java:31` — dispatcher wrapper
- `dubbo-remoting/dubbo-remoting-api/src/main/java/org/apache/dubbo/remoting/transport/dispatcher/execution/ExecutionChannelHandler.java:33` — execution dispatcher 语义
- `ExecutionChannelHandler.java:43` — Request 提交 executor

## 测试证据清单

- `HeaderExchangeHandlerTest` — request/response/one-way/异常响应
- `HeaderExchangeChannelTest` — future、send、timeout、closed channel
- `HeartbeatHandlerTest` — heartbeat request/response/idle close
- `ChannelEventRunnableTest` — dispatcher 事件线程
- `NettyCodecAdapter` / client/server handler tests — encode/decode、半包、多包
- Dubbo protocol tests — service key、exporter 查找、provider invoke

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇聚焦默认 Dubbo + Header Exchange + Netty 主线。
- 不展开具体序列化算法、二进制协议字段、Triple/HTTP/2、TLS。
- 不展开完整线程池配置和连接复用策略。

## 与其他篇的边界

### 本篇要讲清

- Invocation 如何变成 Request。
- Exchange 如何关联 Request/Response。
- Channel/Transporter 如何搬运字节。
- Codec 如何完成对象与 bytes 的互转。
- Provider 如何从 Request 回到 Exporter/Invoker。
- Dispatcher 如何划分 IO 线程和业务线程。

### 本篇不深讲

- Dubbo2/Triple wire protocol 逐字段解析。
- Hessian/Kryo/Protobuf 等序列化算法。
- TLS、HTTP/2、连接复用。
- 线程池全量配置与生产调参。

## 写作后检查

- [ ] 开篇先抓“Invocation 如何变成网络请求”，而不是直接讲 Netty。
- [ ] 至少展开 3 个失败方案，且包含“Request=Invocation”“解码和业务必须同线程”。
- [ ] 明确给出 consumer/provider 双向总图。
- [ ] 不把本篇写成 Netty 源码导览。
- [ ] 每个层次都先讲职责边界，再给 file:line。
- [ ] 删除代码块后，读者仍能复述 Transporter/Codec/Exchange/Dispatcher 四层关系。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。