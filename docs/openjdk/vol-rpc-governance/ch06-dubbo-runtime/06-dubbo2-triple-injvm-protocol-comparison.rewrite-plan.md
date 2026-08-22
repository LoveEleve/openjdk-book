# Dubbo：Dubbo2、Triple、Injvm 协议对照 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch06-dubbo-runtime`
- 篇：`06 Dubbo2、Triple、Injvm 协议对照`
- 对应主题：`D-EXT-2 Concrete Protocol Comparison`
- 文章类型：协议扩展对照篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：前面几篇已经建立了 Dubbo 的统一抽象：`Protocol.export/refer`、`Invoker`、`Exporter`、`Proxy`、Remoting、Exchange、Codec。但如果所有协议都共享这些抽象，Dubbo2、Triple、Injvm 到底有什么本质差异？它们是不是只是名字不同、底层传输不同？为什么 Dubbo2 把更多逻辑放在 `DubboProtocol + DubboCodec`，Triple 却拆成 `TripleProtocol + TripleHttp2Protocol + TripleClientCall`，Injvm 又几乎没有网络？
- 一句话顿悟：Dubbo2、Triple、Injvm 不是三个独立 RPC 框架，而是同一套 `Protocol/Invoker/Exporter` 窄腰上的三种具体实现：Dubbo2 把 RPC header/body、exchange、serialization 和 provider dispatch 更集中地组织在传统 Dubbo wire path 中；Triple 把协议生命周期与 HTTP/2/HTTP/3/WebSocket wire pipeline 拆开，用 method model 和 stream call 贴近 gRPC/HTTP 语义；Injvm 则去掉远程 transport，却保留 timeout、context、token、async、Invoker/Exporter 语义，作为验证统一抽象的 control case。
- 文章边界：本篇重点对照三种协议如何实现同一 `Protocol` contract，以及它们在 export、refer、request/response、codec/transport 和本地调用上的分叉；不逐字段解析 Dubbo2 binary header，不展开 Triple protobuf/HTTP2 flow-control 全部细节，不展开序列化算法专题。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/02-invoker-protocol-exporter-proxy-filter.md`：已经知道 Protocol/Invoker/Exporter/Proxy 窄腰。
- `ch06-dubbo-runtime/04-remoting-exchange-dispatcher-network.md`：已经知道 Transporter/Exchange/Codec/Dispatcher 边界。

### SOFT

- 不要求先懂 HTTP/2 或 gRPC wire format。
- 不要求先懂 Dubbo2 全部历史兼容特性。

### NAV

- 后续可接：Serialization / Codec 专题。
- 后续可接：Triple HTTP/2 / HTTP/3 与流控专题。

## 一句话困惑

Dubbo2、Triple、Injvm 都实现同一个 `Protocol`，为什么源码结构和请求路径差别这么大？它们共享什么，又在哪些边界真正分叉？

## 一句话顿悟

三种协议共享 `Protocol -> Invoker/Exporter` 生命周期，但具体分叉在“调用如何落地”：Dubbo2 把传统 Dubbo binary codec 和 exchange path 组织得更集中；Triple 把 RPC 调用、HTTP/2 wire protocol、stream call、metadata 拆成多层；Injvm 直接在本地 exporter map 中查 invoker，却保留 Dubbo 的 timeout/async/context/token 调用语义。

## 读者理解路径

1. 先否定“三个独立框架”或“只是换了传输协议”的粗糙理解。
2. 建立共享骨架：同一 `Protocol.export/refer`、同一 `Invoker/Exporter`、同一代理层。
3. 解释 Adaptive Protocol 如何根据 URL protocol 选择 dubbo/tri/injvm。
4. 先讲 Dubbo2：集中式 binary codec + exchange + service key/exporter lookup。
5. 再讲 Triple：Protocol 生命周期、wire protocol、HTTP/2 stream、method model 分层。
6. 最后讲 Injvm：去掉网络但保留 RPC 语义的对照实验。
7. 用表格/总图比较三者的 export/refer/request/response/transport 分叉。
8. 收束到：协议实现不同，但 Dubbo 的窄腰没有变。

## 失败方案推演

### 失败方案一：三种协议只是三个独立 RPC 框架

- 如果独立，应该各自拥有不同的 proxy、invoker、exporter、生命周期模型。
- 实际上三者都实现同一 `Protocol`，共享 `AbstractProtocol`、`AbstractInvoker`、`AbstractExporter` 和上层 ProxyFactory。
- 所以差异在具体协议落地，不在框架窄腰。

### 失败方案二：Triple 就是 Dubbo2 换成 HTTP/2

- Triple 不只是换 wire。它引入了 method model、stream call、request metadata、HTTP/2/HTTP/3/WebSocket wire protocol 分层。
- `TripleProtocol` 与 `TripleHttp2Protocol` 的职责已经分开，说明 Triple 的架构边界也不同。
- 所以 Triple 是对 Dubbo 调用模型的协议拓展，不是简单换 socket。

### 失败方案三：Injvm 不经过网络，所以不算真正 Dubbo 调用

- Injvm 确实绕过 remoting，但仍经过 Protocol、Invoker、Exporter、timeout、context、token、async 等调用语义。
- 它不是 mock，也不是直接反射调用的旁路，而是共享同一窄腰的本地协议实现。
- 所以 Injvm 是最能证明“协议可替换、抽象不变”的 control case。

## 必须澄清的误解

1. 三种协议不是三个独立框架，而是同一 Protocol/Invoker/Exporter contract 的不同实现。
2. Triple 不只是 Dubbo2 的 HTTP/2 版本，它重新切分了 protocol lifecycle、wire protocol 和 stream call。
3. Injvm 不等于绕过 Dubbo，它绕过的是远程 transport，不是 RPC 语义。
4. Dubbo2 的 `DubboCodec`、Triple 的 HTTP/2 pipeline、Injvm 的本地 exporter lookup 是三种不同的“调用落地方式”。
5. 共享 `Protocol` 不代表三种协议的 wire、连接、流式和序列化边界相同。

## 文章结构与字数预算

1. 困惑开场：同一个 Protocol，为什么三种协议长得完全不同（800-1000 字）
2. 最小总图：共享窄腰与具体协议分叉（1000-1400 字）
3. Adaptive Protocol：URL 如何选 dubbo/tri/injvm（1000-1400 字）
4. Dubbo2：集中式 binary codec + exchange + exporter lookup（2000-2600 字）
5. Triple：Protocol / wire protocol / stream call 分层（2200-2800 字）
6. Injvm：去掉网络但保留 RPC 语义（1400-1800 字）
7. 三种协议对照与边界总结（1200-1600 字）
8. 误解澄清与收网（800-1000 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

### shared contract / adaptive
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/Protocol.java:28` — Protocol contract
- `Protocol.java:69` — export
- `Protocol.java:85` — refer
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/protocol/AbstractProtocol.java:61` — exporter/server/invoker runtime frame
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/protocol/AbstractInvoker.java:174` — common invoke shell
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/protocol/AbstractExporter.java:54` — common exporter lifecycle
- `dubbo-common/src/main/java/org/apache/dubbo/common/extension/AdaptiveClassCodeGenerator.java:286` — URL protocol selection
- `AdaptiveClassCodeGenerator.java:297` — default fallback

### Dubbo2
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboProtocol.java:346` — export
- `DubboProtocol.java:407` — create server
- `DubboProtocol.java:426` — `Exchangers.bind`
- `DubboProtocol.java:451` — refer
- `DubboProtocol.java:491` — client creation/shared connection
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboInvoker.java:90` — consumer doInvoke
- `DubboInvoker.java:121` — Request creation
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboCodec.java:92` — header/flags
- `DubboCodec.java:155` — request decode
- `DubboCodec.java:279` — request encode
- `DubboCodec.java:330` — response encode
- `DubboProtocol.java:118` — provider handler
- `DubboProtocol.java:318` — exporter lookup

### Triple
- `dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleProtocol.java:107` — export
- `TripleProtocol.java:135` — path mapping / server setup
- `TripleProtocol.java:183` — wire protocol binding
- `TripleProtocol.java:194` — refer
- `dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleHttp2Protocol.java:81` — wire protocol
- `TripleHttp2Protocol.java:104` — HTTP/2 pipeline
- `TripleHttp2Protocol.java:167` — server pipeline
- `TripleHttp2Protocol.java:217` — stream handling
- `dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/TripleInvoker.java:154` — method model / RPC type
- `TripleInvoker.java:178` — call creation
- `TripleInvoker.java:217` — server streaming path
- `dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/RequestMetadata.java:53` — HTTP/gRPC headers
- `dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/call/TripleClientCall.java:88` — response stream
- `TripleClientCall.java:196` — backpressure/request

### Injvm
- `dubbo-rpc/dubbo-rpc-injvm/src/main/java/org/apache/dubbo/rpc/protocol/injvm/InjvmProtocol.java:74` — export
- `InjvmProtocol.java:79` — refer
- `InjvmProtocol.java:83` — isInjvmRefer
- `dubbo-rpc/dubbo-rpc-injvm/src/main/java/org/apache/dubbo/rpc/protocol/injvm/InjvmInvoker.java:102` — local lookup
- `InjvmInvoker.java:136` — timeout/context/token
- `InjvmInvoker.java:179` — local invoker invoke
- `dubbo-rpc/dubbo-rpc-triple/src/main/java/org/apache/dubbo/rpc/protocol/tri/GrpcProtocol.java:21` — Triple subclass/protocol family

## 测试证据清单

- `dubbo-rpc/dubbo-rpc-dubbo/src/test/java/org/apache/dubbo/rpc/protocol/dubbo/DubboProtocolTest.java:88` — Dubbo2 export/refer roundtrip
- `DubboProtocolTest.java:103` — richer invocation behavior
- `dubbo-rpc/dubbo-rpc-triple/src/test/java/org/apache/dubbo/rpc/protocol/tri/TripleProtocolTest.java:49` — unary/streaming/bi-streaming
- `dubbo-rpc/dubbo-rpc-injvm/src/test/java/org/apache/dubbo/rpc/protocol/injvm/InjvmProtocolTest.java:73` — local export/refer
- `InjvmProtocolTest.java:118` — `isInjvmRefer` policy
- `InjvmProtocolTest.java:152` — async local invocation

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇只对照 Dubbo2、Triple、Injvm 的 Protocol/Invoker/Exporter 与调用落地差异。
- 不逐字段解析 Dubbo2 binary header。
- 不展开 Triple protobuf packing、HTTP/2 flow-control、HTTP/3/WebSocket 全量细节。
- 不展开具体序列化算法。

## 与其他篇的边界

### 本篇要讲清

- 三种协议如何共享 Protocol/Invoker/Exporter 窄腰。
- Dubbo2 的集中式 binary codec/exchange 路径。
- Triple 的 protocol/wire/stream call 分层。
- Injvm 如何去掉网络但保留 RPC 语义。
- 为什么它们是同一框架里的协议插件，而不是三个独立框架。

### 本篇不深讲

- Dubbo2 packet 每个 header 字段。
- Triple HTTP/2/HTTP/3 flow-control 和 protobuf packing。
- Hessian/Kryo/Protobuf 等序列化算法。
- 具体协议的 TLS、连接复用、线程池调参。

## 写作后检查

- [ ] 开篇先抓“同一个 Protocol 为什么三种协议差异巨大”，而不是直接做特性表。
- [ ] 至少展开 3 个失败方案，且包含“Triple=HTTP/2 Dubbo2”“Injvm 不算真实 Dubbo”。
- [ ] 明确给出共享窄腰与三种协议分叉总图。
- [ ] 不把本篇写成协议功能对比表。
- [ ] 每个协议都先讲角色边界，再给具体源码证据。
- [ ] 删除代码块后，读者仍能复述三种协议共享什么、分叉什么。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。