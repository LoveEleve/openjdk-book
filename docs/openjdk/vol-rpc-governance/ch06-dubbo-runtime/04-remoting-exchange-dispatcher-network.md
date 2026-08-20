# Dubbo：Remoting、Exchange、Dispatcher 与网络/线程派发

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：`Invoker.invoke()` 之后到底发生了什么

前三篇已经把 Dubbo 的入口、窄腰和 consumer 流量主线立住了：业务代码拿到 proxy，proxy 背后进入 `Invoker`；`Directory`、`Router`、`LoadBalance`、`Cluster` 决定这一次调用选谁、失败后怎么办。

但到这里，网络还没有真正出现。

`Invoker.invoke()` 只是一个内存里的方法调用。它还没有变成 request id，没有进入 request-response future，没有被编码成字节，也没有进入 Netty channel。provider 侧也一样：网络上收到的字节，还不是 `RpcInvocation`，更不是业务对象方法调用。

所以本篇要解决的困惑是：**一次 invocation 怎样变成网络请求，网络请求又怎样回到 provider 的 exporter/invoker？**

## 二、前情回顾：前面讲的是调用选择，这一篇讲调用如何上网

在第一篇里，我们建立了 provider `ref -> Invoker -> Exporter` 与 consumer `URL/Registry -> Invoker -> Proxy` 两条对象变形链。

在第二篇里，我们知道 `Invoker` 是 Dubbo 的窄腰，不同协议都可以把远程能力包装成 `Invoker`。

在第三篇里，我们又知道 consumer 如何通过 Directory、Router、LoadBalance、Cluster 选出本次要调用的 Invoker。

现在还差最后一段：选中的 Invoker 怎样进入真正的网络？

这篇只做这一件事，不展开具体协议字段，而是沿着默认 Dubbo + Header Exchange + Netty 主线，追踪：

```text
Invoker → Request → ExchangeClient → Channel → Codec → network
network → Codec → Request → ExchangeHandler → DubboProtocol → Exporter/Invoker
```

## 三、先走三条失败的路

### 失败方案一：Invoker 直接操作 Netty socket

如果 `Invoker.invoke()` 直接拿 Netty channel 写 socket，那么每个协议、每种调用模式都得理解 Netty、编码、request id 和 response future。

这会把 RPC 调用语义和具体网络实现绑死。Dubbo2、Triple、Injvm 都无法共享同一个调用抽象。

所以 Dubbo 把中间过程拆开：Invoker 负责“我要调用”，Exchange 负责“这是一个 request-response 交互”，Transport 负责“怎么建立连接并搬字节”。

### 失败方案二：Request 就是 RpcInvocation

`RpcInvocation` 是 RPC 层对象，描述接口、方法、参数和 attachments；`Request` 是 exchange 层 envelope，额外携带 request id、two-way、event、heartbeat、payload 等控制信息。

如果把两者混成一个对象，one-way、heartbeat、response matching 就会污染业务 invocation；而 request id 也会和方法参数混在一起。

所以 Request 的 data 可以是 RpcInvocation，但 Request 不等于 RpcInvocation。

### 失败方案三：网络解码和业务执行必须在同一个线程

如果 Netty IO event loop 收到数据后直接执行 provider 业务方法，那么一个慢业务就能阻塞同一连接甚至同一 event loop 上的其他网络事件。

Dubbo 通过 Dispatcher 把“网络事件如何传播”和“业务 request 在哪个 executor 执行”拆开。Codec 负责转对象，Dispatcher 负责切线程，业务执行由后续 handler 完成。

## 四、最小总图：consumer 出站与 provider 入站

### 4.1 consumer 出站

```text
Invoker.invoke(invocation)
    ↓
DubboInvoker.doInvoke()
    ↓
Request(data = RpcInvocation)
    ↓
ExchangeClient.request()
    ↓
HeaderExchangeChannel
    ↓
DefaultFuture + request id
    ↓
Channel.send()
    ↓
NettyCodecAdapter
    ↓
DubboCodec.encode()
    ↓
TCP bytes
```

### 4.2 provider 入站

```text
TCP bytes
    ↓
Netty decoder
    ↓
DubboCodec.decode()
    ↓
Request / DecodeableRpcInvocation
    ↓
Dispatcher
    ↓
DecodeHandler / HeaderExchangeHandler
    ↓
DubboProtocol.requestHandler.reply()
    ↓
service key → Exporter → Invoker
    ↓
业务对象方法
    ↓
Response
    ↓
encode → network
```

这条链里有四个边界：

- **Transporter / Channel**：建立连接并搬运字节。
- **Codec**：字节与 Dubbo 消息对象互转。
- **Exchange**：Request/Response、id、future、one-way、heartbeat。
- **Dispatcher**：事件在哪个线程执行。

## 五、Consumer 出站：DubboInvoker 如何创建 Request

### 5.1 `DubboInvoker.doInvoke()` 是 RPC 到网络的第一跳

consumer 侧最终进入具体协议 Invoker 的 `doInvoke()`。`DubboInvoker` 先从 `RpcInvocation` 中取得方法名、path、version 等信息，再从 `ClientsProvider` 选择一个 `ExchangeClient`。

`DubboInvoker.java:89` — 选择 `ExchangeClient`
`DubboInvoker.java:105` — 计算 timeout

它随后创建 exchange 层 `Request`，把 `RpcInvocation` 放进 `Request.data`。

`DubboInvoker.java:119` — 创建 Request
`DubboInvoker.java:126` — 设置 payload/data/version

因此此时发生的第一次对象变形是：

```text
RpcInvocation → Request.data
```

`Request` 还会携带 request id、two-way、event 等 exchange 控制信息。

### 5.2 one-way 和 two-way 在这里分叉

如果调用是 one-way，`DubboInvoker` 把 `Request.twoWay` 设为 false，调用 `send()`；如果是普通 request-response，则设置 two-way=true，调用 `request()`。

`DubboInvoker.java:128` — one-way `send()`
`DubboInvoker.java:133` — two-way `request()`

注意：

- `twoWay=false` 仍然会发送网络请求，只是不期待业务 response。
- `sent=true` 表示是否等待底层发送确认，不等于 two-way。

## 六、Exchange：Request、Response 与 DefaultFuture

### 6.1 HeaderExchangeClient 不是连接本身

默认 exchange 实现通过 `HeaderExchanger` 把底层 `Client` 包成 `HeaderExchangeClient`。

`HeaderExchanger.java:40` — transport client 包装成 `HeaderExchangeClient`
`HeaderExchangeClient.java:66` — 构造 `HeaderExchangeChannel`

`HeaderExchangeClient` 的职责比较薄，`request()` 和 `send()` 最终继续转给 `HeaderExchangeChannel`。

### 6.2 `HeaderExchangeChannel.request()` 建立请求响应关联

`HeaderExchangeChannel.request()` 的核心逻辑可以概括为：

1. 确保这是一个 two-way `Request`
2. 按 request id 创建 `DefaultFuture`
3. 把 future 放进 in-flight 映射
4. 启动 timeout 检查
5. 把 request 交给底层 `Channel.send()`
6. 返回 future

`HeaderExchangeChannel.java:135` — request 包装
`HeaderExchangeChannel.java:153` — DefaultFuture / timeout / send

所以 `ExchangeClient.request()` 不是“同步阻塞等待响应”的底层方法，而是先把请求登记起来，再把网络发送出去。上层如何等待，取决于 RPC result 和调用模式。

### 6.3 Response 如何找到原来的调用

response 到达时，`HeaderExchangeHandler` 根据 response id 找到对应的 `DefaultFuture`，再完成它。

这条映射是：

```text
Request.id
    ↓
DefaultFuture.FUTURES[id]
    ↓
Response.id
    ↓
future.complete(response)
```

如果没有 request id，Dubbo 就无法把并发返回的多个 response 交回正确的调用。

## 七、Transport 与 Codec：对象如何变成网络字节

### 7.1 Transporter、Channel 和 socket 的边界

`Transporter` 是具体网络传输实现的 SPI，负责 `connect(URL, handler)` 和 `bind(URL, handler)`。

`Transporter.java:24` — `Transporter` SPI

`Channel` 表示单条连接，提供远端地址、连接状态、属性、发送和关闭能力。

`Channel.java:21` — `Channel extends Endpoint`
`Channel.java:30` — 远端地址/连接状态等职责

它们不负责解释 `RpcInvocation`，也不负责查 exporter，更不负责决定业务线程。

### 7.2 Netty pipeline 接入 Codec

Netty client/server 在 pipeline 中安装 encoder、decoder、idle handler 和 Netty handler。

`NettyClient.java:111` — client pipeline
`NettyServer.java:168` — server pipeline

出站方向，`NettyCodecAdapter` 接收 Dubbo 对象，交给 `DubboCodec.encode()`，再写入 Netty `ByteBuf`。

`NettyCodecAdapter.java:63` — outbound encode

所以 consumer 出站路径是：

```text
Request → NettyCodecAdapter → DubboCodec.encode() → ByteBuf → socket
```

### 7.3 Codec 负责什么，不负责什么

Codec 负责对象与 bytes 互转：

- 读取 Dubbo header
- 判断 request/response
- 读取 request id
- 判断 two-way、event、heartbeat
- 对 body 选择序列化方式
- 还原 Request、Response、RpcInvocation

它不负责：

- 建立 socket
- request-response future
- exporter 查找
- 业务线程执行

## 八、Provider 入站：字节怎样回到业务对象

### 8.1 半包数据先由 decoder 处理

Netty server handler 收到的是网络字节。`NettyCodecAdapter.InternalDecoder` 会把 `ByteBuf` 包装成 Dubbo `ChannelBuffer`，循环调用 codec。

如果输入数据不完整，它返回 `NEED_MORE_INPUT`，恢复 reader index，等待下一批字节；如果一次输入包含多个消息，它也可以连续解出多个对象。

`NettyCodecAdapter.java:91` — decoder 主循环

所以 provider 侧不能假设“一次 read 就是一条 RPC”。网络边界和 Dubbo 消息边界不是同一个概念。

### 8.2 DubboCodec 把 bytes 变成 Request

`DubboCodec.decodeBody()` 会先读 flag、request id，然后区分 response 和 request。

request 路径会构造 `Request`，读取 two-way、event、payload，并在普通 RPC 场景创建 `DecodeableRpcInvocation`。

`DubboCodec.java:154` — request 分支
`DubboCodec.java:187` — DecodeableRpcInvocation

如果解码失败，则构造 broken request，后续 exchange 层会返回 `BAD_REQUEST`，而不是让半个对象继续进入业务逻辑。

### 8.3 ExchangeHandler 区分 request、response、one-way、heartbeat

`HeaderExchangeHandler.received()` 根据消息类型和 request 标志分派：

- two-way request → `handleRequest()`，需要构造 response
- one-way request → 只把 data 交给 handler，不生成 response
- response → 按 id 完成客户端 future
- heartbeat/event → 走专门处理

`HeaderExchangeHandler.java:196` — request/response/one-way 分派

`handleRequest()` 调用 `ExchangeHandler.reply()`，返回的 `CompletionStage` 完成后再构造 `Response`。

`HeaderExchangeHandler.java:107` — reply / response

这意味着 provider 业务方法即使返回异步结果，exchange 层也能等到 future 完成后再写 response。

### 8.4 DubboProtocol 找到 Exporter/Invoker

`DubboProtocol.requestHandler.reply()` 是网络消息接回 RPC 层的最后一跳。它会：

1. 确认消息是 Invocation
2. 从 path、group、version、port 拼出 service key
3. 从 `exporterMap` 找到 `DubboExporter`
4. 取出 exporter 内部的 Invoker
5. 调用 `invoker.invoke(inv)`

`DubboProtocol.java:118` — request handler
`DubboProtocol.java:318` — service key 查 exporter
`DubboProtocol.java:331` — exporter invoker invoke

于是 provider 完成了反向对象变形：

```text
network bytes → Request → RpcInvocation → Exporter → Invoker → ref.method()
```

## 九、Dispatcher：IO event loop 如何切到业务 executor

### 9.1 Dispatcher 的位置

Netty IO event loop 负责建立连接、读写数据和触发 channel handler。它不应该直接承载所有 provider 业务方法。

Dubbo 通过 Dispatcher 把 channel handler 包装成另一层 handler。

`Dispatcher.java:27` — Dispatcher SPI
`ChannelHandlers.java:31` — dispatcher wrapper

### 9.2 `execution`：只把 Request 交给业务线程池

`ExecutionChannelHandler` 的语义很适合作为主例：

```text
Request       → executor
Response      → IO thread
Connect       → IO thread
Disconnect    → IO thread
Heartbeat     → IO thread
```

`ExecutionChannelHandler.java:33` — execution dispatcher 语义
`ExecutionChannelHandler.java:43` — Request 提交 executor

这意味着典型 provider 线程边界是：

```text
Netty worker event loop
    ↓ decode
Dispatcher.received(Request)
    ↓
provider executor
    ↓
HeaderExchangeHandler.handleRequest()
    ↓
DubboProtocol.requestHandler.reply()
    ↓
provider Invoker.invoke()
```

### 9.3 其他 dispatcher 不是同一种语义

- `all`：连接、断开、接收、异常等事件全部交给 executor。  
- `direct`：通常在当前线程直接执行。  
- `message`、`connection`：只把特定类别的事件迁移到 executor。

所以 dispatcher 不等于“业务线程池配置”本身。它只决定某类事件如何派发，executor 的创建和生命周期由更上层的 transport/threadpool 配置负责。

## 十、Request-response、one-way、heartbeat、timeout

### 10.1 Request-response

two-way 请求需要 request id 和 `DefaultFuture`。response 到达时按 id 完成 future；成功、服务异常、超时和连接关闭最终都会体现在 future 的完成状态里。

`DefaultFuture.java:196` — received response
`DefaultFuture.java:254` — status 到异常映射

### 10.2 one-way

one-way 仍然发送 request，但 provider 不走普通 `handleRequest()` response 路径。

`HeaderExchangeHandler.java:204` — one-way request 分派

它适合不需要业务返回值的通知场景，但不代表网络发送本身没有失败可能。

### 10.3 heartbeat

Netty client 安装 idle handler，读空闲时构造 heartbeat `Request`；`Request.isHeartbeat()` 通过 event 标记判断。

`NettyClientHandler.java:99` — 创建 heartbeat request
`Request.java:144` — heartbeat 判断

heartbeat response 不应该进入普通 RPC future 的业务 response 匹配。

### 10.4 timeout

`DefaultFuture` 创建时会放入 in-flight 映射，并启动 timeout task。

`DefaultFuture.java:94` — 注册 future / timeout
`DefaultFuture.java:128` — `newFuture()`

排障时要区分：

- 发送阶段 timeout
- 已发送但等待 provider response timeout
- channel inactive 导致 pending request 失败
- provider 返回 `SERVER_TIMEOUT`
- client 本地 `CLIENT_TIMEOUT`

## 十一、误解澄清

### 误解一：`Channel` 就是 RPC client

不是。Channel 是单条连接抽象；ExchangeClient 管 request-response；Invoker 才是 RPC 调用抽象。

### 误解二：`Request` 就是 `RpcInvocation`

不是。Request 是 exchange envelope，`RpcInvocation` 是它的 data。

### 误解三：one-way 就是“不发网络”

不是。one-way 仍然发送 Request，只是不等待业务 response。

### 误解四：Dispatcher 决定业务路由

不是。Dispatcher 只决定 handler 事件在哪个线程执行，service key 查 exporter 和业务 invoke 仍由 Protocol/Invoker 层负责。

### 误解五：解码一定在 IO 线程，或者一定在业务线程

都不准确。`decode.in.io.thread`、线程隔离模式、延迟解码对象都会影响具体位置，不能把一个实现分支外推成绝对规则。

## 十二、收网总结：四层边界把 invocation 送上网络

回到开头的问题：`Invoker.invoke()` 之后到底发生了什么？

consumer 侧，RPC invocation 被放进 Request，Exchange 用 request id 建立 future，Channel 负责发送，Codec 把对象变成 bytes，Netty 把 bytes 搬上 socket。

provider 侧，Netty 收到 bytes，Codec 还原 Request/Invocation，Dispatcher 决定事件在哪个线程，ExchangeHandler 区分 request/response/one-way，DubboProtocol 再根据 service key 找到 Exporter 和 Invoker，最终回到业务对象。

**三句话总结：**

1. Transporter/Channel 搬字节，Codec 转对象，Exchange 管 request-response，Dispatcher 管事件线程；四层边界不能混成一个“远程调用类”。
2. `Request` 是 exchange envelope，`RpcInvocation` 是业务调用数据；one-way、heartbeat、timeout 这些控制语义属于 exchange，不属于业务对象本身。
3. DubboProtocol 把解码后的 Invocation 接回 Exporter/Invoker，完成从网络消息到业务方法的最后一跳。

**下篇预告：** 下一篇进入 Dubbo SPI / ExtensionLoader / Adaptive 机制，解释为什么这些协议、filter、dispatcher 和 cluster 实现能够被动态装配起来。