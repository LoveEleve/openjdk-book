# Dubbo：Dubbo2、Triple、Injvm 协议对照

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：同一个 Protocol，为什么三种协议长得完全不同

前面几篇已经把 Dubbo 的窄腰和网络主线立住了：`Protocol` 负责 export/refer，`Invoker` 负责统一调用，`Exporter` 负责 provider 侧登记，Remoting/Exchange/Codec 负责把调用送到网络。

但一看具体实现，差异立刻出现：

- `DubboProtocol` 自己管理 Dubbo2 server、exchange 和 `DubboCodec`。
- `TripleProtocol` 的 HTTP/2 pipeline 却拆到了 `TripleHttp2Protocol`，调用本身又进入 `TripleInvoker` 和 `TripleClientCall`。
- `InjvmProtocol` 根本不建立网络连接，而是直接在本地 exporter map 里找 Invoker。

这三种实现是不是三个不同框架？如果它们共享同一个 `Protocol` 接口，为什么代码结构又差这么多？

答案不是“它们只是换了传输协议”，也不是“它们完全独立”。更准确的说法是：**它们共享 Dubbo 的调用窄腰，但分别选择了不同的调用落地方式。**

## 二、前情回顾：共享抽象已经立住，现在看具体协议在哪里分叉

在前面的窄腰篇中，我们已经知道 `Protocol.export()/refer()` 是协议边界，`Invoker` 是统一调用体，`Exporter` 是 provider 侧导出句柄。

在 remoting 篇中，我们又看过默认 Dubbo + Header Exchange + Netty 如何把 invocation 变成 Request、字节，再从字节回到 provider Invoker。

这一篇不再重复这些抽象的定义，而是换一种阅读方式：**不要按“Dubbo2 有什么特性、Triple 有什么特性、Injvm 有什么特性”去横向扫，而要按同一组问题去对照三种协议分别怎么回答。**

这组问题可以压成四个：

1. export 时，provider 端把什么登记起来？  
2. refer 时，consumer 端拿回来的到底是什么？  
3. request/response 在 wire 层怎样承载？  
4. 网络被拿掉之后，哪些 RPC 语义仍然保留？

这一篇真正要回答的是：**同一套抽象，具体实现到底在哪些地方必须做出不同选择？**

## 三、先走三条失败的路

### 失败方案一：三种协议是三个独立 RPC 框架

如果它们是三个独立框架，应该各自拥有不同的 proxy、invoker、exporter 和生命周期模型。

但源码并不是这样。三种实现都遵守同一套 `Protocol.export/refer` contract，都返回 `Exporter`/`Invoker`，都能被同一个 Adaptive Protocol 入口选择。

所以差异发生在“调用如何落地”，不是“框架是否共享窄腰”。

### 失败方案二：Triple 就是 Dubbo2 换成 HTTP/2

这个理解只看到了 HTTP/2，没有看到 Triple 的分层方式。

Dubbo2 把更多协议、exchange、codec 路径集中在 `DubboProtocol + DubboCodec` 中；Triple 则把协议生命周期、HTTP/2 wire protocol、stream call、request metadata 拆成多个层次。

Triple 不是把同一个 binary codec 换成 HTTP/2，而是重新组织了 RPC 调用和 wire pipeline 的边界。

### 失败方案三：Injvm 不经过网络，所以不算真正 Dubbo 调用

Injvm 确实绕过了 remoting，但它仍然保留 Dubbo 的 Protocol、Invoker、Exporter、timeout、context、token、async 等调用语义。

它不是 mock，也不是业务代码直接反射调用的旁路，而是一个共享同一窄腰的本地协议实现。正因为它去掉了网络而保留了调用模型，所以它反而是验证 Dubbo 抽象是否真正成立的最好 control case。

## 四、最小总图：共享窄腰，三处落地

三种协议共享的上层骨架是：

```text
Protocol.export/refer
       ↓
Invoker / Exporter contract
       ↓
ProxyFactory / Cluster / Filter
```

但具体落地路径不同：

```text
Dubbo2
  Protocol
    ↓
  DubboProtocol + DubboCodec + Header Exchange + Netty
    ↓
  binary Request/Response

Triple
  Protocol
    ↓
  TripleProtocol + TripleHttp2Protocol + TripleClientCall
    ↓
  HTTP/2/HTTP3/WebSocket + gRPC-like streams

Injvm
  Protocol
    ↓
  InjvmProtocol + local exporterMap lookup
    ↓
  local Invoker.invoke()
```

这三种协议的共同点证明了 Dubbo 的扩展边界，差异点则说明 `Protocol` 这个抽象到底允许实现自由到什么程度。

这里再加一个路标：后面不是按“功能模块”散讲，而是沿着同一组问题去比较三种协议——谁负责 export，谁负责 refer，谁承担 request/response，谁处理 wire path，谁在去掉网络之后仍保留 RPC 语义。这样读者不会把它误读成一个特性对比表。

## 五、Adaptive Protocol：URL 如何选择三种实现

`Protocol` 是 Adaptive 扩展，通常根据 URL protocol 选择具体实现：

```text
url.protocol=dubbo → DubboProtocol
url.protocol=tri   → TripleProtocol
url.protocol=injvm → InjvmProtocol
```

Adaptive 代码生成器会在没有显式 key 时读取 `url.getProtocol()`，如果没有协议则回退到 SPI 默认值。

`AdaptiveClassCodeGenerator.java:286` — URL protocol 选择
`AdaptiveClassCodeGenerator.java:297` — default fallback
`Protocol.java:81` — Adaptive export
`Protocol.java:99` — Adaptive refer

所以三个协议不是在上层手动 if/else 选择，而是被同一个 ExtensionLoader/Adaptive Protocol 入口动态选择。

这也解释了为什么“协议不同”不会破坏前面写过的 export/refer 主线：上层只需要知道 Protocol contract，具体实现由 URL 决定。

## 六、Dubbo2：集中式的传统 RPC wire path

### 6.1 export：Protocol 自己管理 server 和 exporter

`DubboProtocol.export()` 会创建 `DubboExporter`，将它按 service key 放入 exporter map，并打开或复用对应 server。

`DubboProtocol.java:346` — export 入口
`DubboProtocol.java:351` — 创建并登记 exporter
`DubboProtocol.java:371` — server 准备

provider 侧的 service key 包含 path、group、version、port 等信息。远程请求到来后，协议能够依靠这个 key 找回正确的 exporter。

### 6.2 `createServer()`：Dubbo2 把 exchange 和 codec 组得很集中

Dubbo2 的具体协议实现会强制使用 Dubbo codec，校验 transporter，然后通过 `Exchangers.bind(url, requestHandler)` 绑定 server。

`DubboProtocol.java:407` — create server
`DubboProtocol.java:413` — codec / transporter 配置
`DubboProtocol.java:426` — `Exchangers.bind`

这说明 Dubbo2 的代码结构比较集中：协议本身清楚地把“服务暴露、exchange server、Dubbo codec、request handler”串在一起。

但这里要防止一个误读：这只是 Dubbo2 当前实现的集中式选择，不是 `Protocol` 契约要求所有协议都必须这么组织。后面看 Triple 时你会发现，同样遵守 `export/refer` contract，也完全可以把 wire protocol、stream call 和 metadata 拆成独立层。

### 6.3 provider 请求：service key 找 exporter

`DubboProtocol.requestHandler.reply()` 收到 invocation 后，会从 path、group、version 等字段重建 service key，查找 `DubboExporter`，再拿出其中的 Invoker 执行。

`DubboProtocol.java:118` — request handler
`DubboProtocol.java:288` — 解析 invocation 信息
`DubboProtocol.java:318` — service key 查 exporter
`DubboProtocol.java:331` — exporter invoker invoke

所以 Dubbo2 的 provider 请求路径是：

```text
binary request
  → DubboCodec.decode()
  → Invocation
  → service key
  → DubboExporter
  → Invoker.invoke()
```

### 6.4 consumer refer 与 binary request

consumer 侧 `protocolBindingRefer()` 创建 `DubboInvoker`，并从 `getClients(url)` 获取 ExchangeClient。这里可以支持共享连接、独占连接和 lazy connect 等连接策略。

`DubboProtocol.java:451` — refer
`DubboProtocol.java:462` — clients
`DubboProtocol.java:491` — client/connection 选择

`DubboInvoker.doInvoke()` 把 invocation 放进 Request，再通过 ExchangeClient 发出：

`DubboInvoker.java:90` — doInvoke
`DubboInvoker.java:121` — Request 创建

### 6.5 `DubboCodec`：传统协议的集中式消息边界

`DubboCodec` 负责 Dubbo2 的 header/body 解析：

- request / response 区分
- request id
- two-way / event / heartbeat flag
- `DecodeableRpcInvocation`
- `DecodeableRpcResult`
- 接口、path、version、method、signature、args、attachments

`DubboCodec.java:92` — header/flags
`DubboCodec.java:155` — request decode
`DubboCodec.java:279` — request encode
`DubboCodec.java:330` — response encode

Dubbo2 的独特气质也就在这里：协议、exchange、codec、服务 key 和 request handler 的关系非常集中。

## 七、Triple：Protocol 与 wire protocol 的分层

### 7.1 `TripleProtocol` 负责生命周期，不包揽全部 wire

`TripleProtocol.export()` 仍然遵守 Protocol contract：创建 exporter、登记路径、准备 server、更新健康状态和绑定端口。

`TripleProtocol.java:107` — export
`TripleProtocol.java:135` — path mapping / server setup
`TripleProtocol.java:150` — server/export 相关处理

但它不把所有 HTTP/2 细节塞在自己内部。wire protocol 和 pipeline 继续由 `TripleHttp2Protocol` 等类承担。

`TripleProtocol.java:183` — wire protocol binding

### 7.2 `TripleHttp2Protocol`：HTTP/2 pipeline 是独立层

`TripleHttp2Protocol` 配置 HTTP/2 codec、stream channel、WebSocket upgrade、flow-control 和协议 handler。

`TripleHttp2Protocol.java:81` — wire protocol
`TripleHttp2Protocol.java:104` — HTTP/2 pipeline
`TripleHttp2Protocol.java:167` — server pipeline
`TripleHttp2Protocol.java:217` — stream handling

这和 Dubbo2 形成明显对照：

- Dubbo2：`DubboProtocol + DubboCodec` 更集中
- Triple：`TripleProtocol + TripleHttp2Protocol + stream call` 更分层

### 7.3 `TripleInvoker`：按 method model 分流

Triple 的 consumer invoker 不只是“创建一个 Request 然后发出去”。它会先取得 method descriptor，根据 RPC 类型选择 unary、server-streaming、client-streaming、bidi-streaming 不同的 call path。

`TripleInvoker.java:154` — method model / RPC type
`TripleInvoker.java:178` — call creation
`TripleInvoker.java:217` — server streaming
`TripleInvoker.java:237` — streaming path

这意味着 Triple 的 Invoker 与方法契约之间结合得更紧，它更接近 HTTP/2/gRPC 风格的 stream call 模型。

### 7.4 RequestMetadata：调用如何进入 HTTP/2 headers

Triple 的 request metadata 会生成：

- `:scheme`
- `:authority`
- `POST`
- full method path
- `content-type=application/grpc+proto`
- `te=trailers`
- timeout、version、group、application、compression
- attachments

`RequestMetadata.java:53` — headers 生成

所以 Triple 不是把 Dubbo2 的二进制 Request 原样搬到 HTTP/2，而是将调用语义重新映射到 HTTP/2 headers、stream 和 message framing。

### 7.5 `TripleClientCall`：Response stream 与背压

Triple client call 负责接收 stream message、通过 method descriptor 解析 response、通知 listener，并通过 stream `request(...)` 推动背压。

`TripleClientCall.java:88` — response stream
`TripleClientCall.java:132` — message / response handling
`TripleClientCall.java:168` — close/cancel
`TripleClientCall.java:196` — request/backpressure

如果把它和 Dubbo2 并排看，差异会更清楚：

- Dubbo2 把 request/response、future 匹配和 codec header 紧紧绑在 `Request/Response + DefaultFuture + DubboCodec` 这组对象上。  
- Triple 则把同样的问题拆成 stream call、method model、metadata/trailers 和 HTTP/2 stream 生命周期。

也就是说，Dubbo2 的“调用信封”更像一个集中式二进制 envelope，而 Triple 的“调用信封”被拆进了 stream、headers、trailers 和 call state 里。这就是 Triple 与 Dubbo2 在运行体验上的一个重要差异：Triple 的协议层更显式地暴露了 stream、metadata、trailers 和 backpressure 的边界。

## 八、Injvm：去掉网络，但保留 Dubbo 语义

### 8.1 export：只登记本地 exporter

`InjvmProtocol.export()` 创建 `InjvmExporter` 并放入本地 exporter map，不绑定端口，不创建 remoting server。

`InjvmProtocol.java:74` — export
`InjvmExporter.java:34` — exporter

### 8.2 refer：返回本地 invoker

`InjvmProtocol.protocolBindingRefer()` 返回 `InjvmInvoker`，它通过同一份本地 exporter map 找到 provider Invoker。

`InjvmProtocol.java:79` — refer

`isInjvmRefer()` 还会根据 scope、显式 injvm、直连 URL、同 JVM provider 是否存在等条件决定是否采用本地路径。

`InjvmProtocol.java:83` — `isInjvmRefer()`

### 8.3 `InjvmInvoker` 仍然保留 RPC 语义

Injvm 调用不是直接 `ref.method()`。它仍然会：

- 按规则查本地 exporter / invoker  
- 读取 timeout  
- 传播 token  
- 设置本地 `RpcContext`  
- 处理 async/future 语义  
- 必要时重建 invocation 和参数  
- 最终调用本地 provider Invoker  

`InjvmInvoker.java:102` — local lookup
`InjvmInvoker.java:136` — timeout/context/token
`InjvmInvoker.java:179` — local invoker invoke

所以 Injvm 去掉的是：

```text
TCP / codec / exchange / remoting
```

但保留的是：

```text
Protocol / Invoker / Exporter / invocation / timeout / context / async
```

这点要讲得更硬一点：Injvm 不是“偷懒直接本地调方法”，而是“把远程 transport 这一段换成本地 exporter lookup，其他 RPC 语义尽量不变”。也正因为如此，它才能作为 Dubbo 统一抽象是否成立的对照实验。

### 8.4 为什么 Injvm 是最好的 control case

如果 Dubbo 的窄腰设计依赖网络，那 Injvm 应该无法复用同一套抽象。但事实相反：它只是替换了“远程 transport”这一段，仍然能插入相同的 Protocol/Invoker/Exporter 体系。

这证明 Dubbo 的核心抽象不是为某个具体网络协议临时拼出来的，而是真正把“调用语义”和“传输方式”分开了。

## 九、三种协议放在一起对照

| 维度 | Dubbo2 | Triple | Injvm |
|------|--------|--------|-------|
| Protocol contract | 共享 | 共享 | 共享 |
| Provider export | `DubboExporter` + server | exporter + path/server | local exporter map |
| Consumer refer | `DubboInvoker` + ExchangeClient | `TripleInvoker` + stream call | `InjvmInvoker` |
| Wire path | Dubbo binary protocol | HTTP/2/HTTP3/WebSocket family | 无远程 wire |
| Codec boundary | `DubboCodec` 集中处理 | method model + HTTP/2 wire layers | 无网络 codec |
| Request/response | Request/Response + future | stream call + metadata/trailers | 直接 local invoker，但保留 future 语义 |
| 适合的语义 | 传统 Dubbo RPC | 云原生/HTTP2/gRPC-like streaming | 同 JVM 快速调用 |

这张表不能代替源码主线，但它能帮助你记住三种协议的差异落在哪里：

- 不是差在上层有没有 `Invoker`。
- 而是差在 `Invoker` 下面如何连接、如何编码、如何处理 stream 和本地调用。

## 十、误解澄清

### 误解一：三种协议是三个独立 RPC 框架

不是。它们共享同一 `Protocol`、`Invoker`、`Exporter` 和上层 proxy/cluster 体系。

### 误解二：Triple 只是 Dubbo2 换成 HTTP/2

不是。Triple 重新拆分了 protocol lifecycle、wire protocol、stream call、metadata 和 method model。

### 误解三：Injvm 只是直接反射调用，不算 Dubbo

不是。Injvm 绕过的是远程 transport，不是 RPC 语义；timeout、context、token、async 和 Invoker 仍然存在。

### 误解四：共享 Protocol 就意味着三种协议 wire path 一样

不是。共享的是 export/refer contract 和 Invoker 窄腰，具体 codec、stream、connection、serialization 边界可以完全不同。

### 误解五：共享抽象就意味着流式、序列化和连接生命周期也天然一致

也不是。共享 `Protocol` 只能说明三种实现都接受同一套 export/refer 入口，不说明它们在 Request/Response 模型、stream 语义、metadata/trailers、backpressure、连接复用和序列化边界上采取同样设计。抽象共享的是上层调用模型，不是下面的 wire 形态。

## 十一、收网总结：协议可替换，窄腰不变

回到开头的问题：同一个 Protocol，为什么 Dubbo2、Triple、Injvm 的代码结构差异这么大？

因为 `Protocol` 只规定了“如何把 Invoker export/refer 出去”，没有规定所有协议必须采用同一种 wire path。

- Dubbo2 选择了集中式的 binary codec + exchange + service key/exporter 路径。
- Triple 选择了更贴近 HTTP/2/gRPC 的 stream、metadata、method model 和 wire protocol 分层。
- Injvm 选择直接在本地 exporter map 中查找 Invoker，同时保留 Dubbo 的 RPC 语义。

**三句话总结：**

1. Dubbo2、Triple、Injvm 是同一套 Protocol/Invoker/Exporter 窄腰上的三种具体落地，不是三个独立 RPC 框架。
2. Dubbo2 的差异集中在 binary codec 和传统 exchange 路径，Triple 的差异集中在 HTTP/2/stream/wire protocol 分层，Injvm 的差异集中在去掉远程 transport。
3. 理解协议对照时，先看共享抽象，再看 Invoker 下面的调用落地；不要把“换了 wire”误写成“换了整个框架”。

**下篇预告：** 下一篇进入 Dubbo 集成层，讲 Spring/Spring Boot 注解与配置如何接入 `DubboBootstrap`、`ServiceConfig` 和 `ReferenceConfig`。