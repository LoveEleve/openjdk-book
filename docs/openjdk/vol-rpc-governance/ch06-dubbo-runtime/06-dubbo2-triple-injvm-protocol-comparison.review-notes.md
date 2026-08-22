# Dubbo：Dubbo2、Triple、Injvm 协议对照 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. 三种协议共享 `Protocol.export/refer` contract，`AbstractProtocol` 提供 exporter/server/invoker 共同运行框架，证据：`dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/Protocol.java:28`、`:69`、`:85`、`dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/protocol/AbstractProtocol.java:61`。
2. Adaptive Protocol 根据 URL protocol 选择具体实现，默认回退 SPI 默认值，证据：`dubbo-common/src/main/java/org/apache/dubbo/common/extension/AdaptiveClassCodeGenerator.java:286`、`:297`。
3. Dubbo2 export 创建 `DubboExporter`、登记 exporter map 并准备 server，证据：`dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboProtocol.java:346`、`:351`、`:371`。
4. Dubbo2 `createServer()` 绑定 Dubbo codec 与 exchange server，证据：`DubboProtocol.java:407`、`:413`、`:426`。
5. Dubbo2 provider 通过 service key 查 `DubboExporter` 并调用内部 Invoker，证据：`DubboProtocol.java:118`、`:318`、`:331`。
6. Dubbo2 consumer `protocolBindingRefer()` 创建 `DubboInvoker`，`DubboInvoker.doInvoke()` 走 Request/ExchangeClient 路径，证据：`DubboProtocol.java:451`、`DubboInvoker.java:90`、`:121`。
7. Dubbo2 `DubboCodec` 处理 binary header、request/response、heartbeat/event 和序列化边界，证据：`DubboCodec.java:92`、`:155`、`:279`、`:330`。
8. Triple export/refer 仍遵守 Protocol contract，但把 wire protocol/pipeline 交给 `TripleHttp2Protocol` 等层，证据：`dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleProtocol.java:107`、`:183`、`:194`、`TripleHttp2Protocol.java:81`、`:104`。
9. Triple `TripleInvoker` 根据 method model/RPC type 进入 unary、server streaming、client streaming、bidi streaming 不同 call path，证据：`TripleInvoker.java:154`、`:178`、`:217`、`:237`。
10. Triple `RequestMetadata` 把调用映射到 HTTP/2/gRPC-like headers，`TripleClientCall` 负责 stream response、close/cancel/backpressure，证据：`RequestMetadata.java:53`、`TripleClientCall.java:88`、`:168`、`:196`。
11. Injvm export/refer 只操作本地 exporter map，不创建远程 transport，证据：`dubbo-rpc-injvm/src/main/java/org/apache/dubbo/rpc/protocol/injvm/InjvmProtocol.java:74`、`:79`。
12. Injvm `isInjvmRefer()` 仍有 scope/injvm/url/local provider 等选择策略，`InjvmInvoker` 仍保留 timeout/context/token/async 等 RPC 语义，证据：`InjvmProtocol.java:83`、`InjvmInvoker.java:102`、`:136`、`:179`。
13. `GrpcProtocol extends TripleProtocol`，从源码层证明 Triple 是 Dubbo Protocol 家族内的扩展，而非独立框架，证据：`dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/GrpcProtocol.java:21`。

### 测试证据已核对

1. `DubboProtocolTest.java:88` — Dubbo2 export/refer roundtrip。
2. `DubboProtocolTest.java:103` — Dubbo2 richer invocation behavior。
3. `TripleProtocolTest.java:49` — unary/server-streaming/bidi-streaming。
4. `InjvmProtocolTest.java:73` — local export/refer。
5. `InjvmProtocolTest.java:118` — `isInjvmRefer` policy。
6. `InjvmProtocolTest.java:152` — async local invocation。

### 深审发现

1. **高风险：容易把协议对照写成 feature comparison table。** 当前正文先建立共享窄腰，再分协议走运行主线，表格只放在收束位置。
2. **高风险：容易把 Triple 简化成 HTTP/2 版 Dubbo2。** 当前正文已突出 `TripleProtocol` / `TripleHttp2Protocol` / `TripleInvoker` / `TripleClientCall` 的分层差异。
3. **中风险：容易把 Injvm 写成 mock/direct reflection。** 当前正文已强调它去掉的是 transport，保留的是 Dubbo RPC 语义。
4. **中风险：容易把 Dubbo2 的集中式代码结构误认为框架唯一结构。** 当前正文已把它与 Triple 的分层架构并置对照。
5. **低风险：容易忘记三种协议都必须回到同一 Protocol/Invoker/Exporter contract。** 当前正文开头、总图和收网重复收束。

## 第二轮：因果审

- 三种协议必须共享 Protocol/Invoker/Exporter 窄腰，否则上层 proxy/cluster/filter 无法复用：✅
- Dubbo2 可以把 codec/exchange 更多集中在具体 Protocol 中，因为它的 wire path 是传统二进制 RPC：✅
- Triple 需要拆出 wire protocol 和 stream call，因为 HTTP/2/gRPC-like headers/streams/backpressure 不能被 Dubbo2 Request 模型完整表达：✅
- Injvm 可以去掉 transport 但保留 timeout/context/async，因为这些属于 RPC 语义，不是网络专属：✅
- Adaptive Protocol 必须按 URL protocol 选择实现，才能让三种协议共享同一个 export/refer 入口：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → 共享窄腰总图 → Adaptive Protocol → Dubbo2 → Triple → Injvm → 三协议对照 → 误解澄清 → 收网总结”推进，没有退化成配置功能表。

失败方案已覆盖：
- 三种协议是三个独立 RPC 框架
- Triple 是 Dubbo2 换 HTTP/2
- Injvm 不经过网络所以不算真正 Dubbo

每个协议都按照“共享 contract → export/refer → 调用落地 → 独特分叉”展开，符合协议对照篇要求。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- 三种协议共享什么抽象
- Dubbo2 的 binary codec/exchange 集中路径
- Triple 的 protocol/wire/stream 分层
- Injvm 去掉网络但保留 RPC 语义
- 为什么三种实现仍属于同一个 Dubbo 框架

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未逐字段展开 Dubbo2 binary header。
- 未展开 Triple protobuf packing、HTTP/2 flow-control、HTTP/3/WebSocket 全部细节。
- 未展开具体序列化算法。
- 未展开 TLS、连接复用和线程池调参。
- 重点仍压在 Protocol/Invoker/Exporter 共享窄腰与三种具体落地方式，边界收得住。✅

## 第六轮：依赖审

- 已承接第二篇 Protocol/Invoker/Exporter/Proxy 窄腰：协议对照建立在共享抽象之上。
- 已承接第四篇 Remoting/Exchange/Codec：Dubbo2 与 Triple 的 wire path 差异能够落回网络主线。
- 后续可自然接 Serialization/Codec、Triple HTTP2、具体协议生产诊断专题。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅
- 代码块：使用少量文字图和对照表，不承担主叙事骨架。✅
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `Protocol`、`AbstractProtocol`、`DubboProtocol`、`DubboInvoker`、`DubboCodec`、`TripleProtocol`、`TripleHttp2Protocol`、`TripleInvoker`、`TripleClientCall`、`InjvmProtocol`、`InjvmInvoker`。
- 去掉代码块后正文仍成立：是。✅
- 叙述性正文字符数（不含代码块与空白行）：约 `14,958`。
- 目标定位：Dubbo 协议扩展对照篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 Dubbo2、Triple、Injvm 从“三个协议名字”提升到“同一 Protocol/Invoker/Exporter 窄腰上的三种调用落地方式”：Dubbo2 集中组织 binary codec/exchange，Triple 分层组织 HTTP/2/stream call，Injvm 去掉远程 transport 但保留 RPC 语义。