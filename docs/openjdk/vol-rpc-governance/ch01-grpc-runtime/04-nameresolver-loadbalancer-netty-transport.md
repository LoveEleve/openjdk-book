# 为什么一次 RPC 真正发出去之前，还要先过 NameResolver、LoadBalancer 和 Transport：gRPC-Java 的发现、选址与 Netty HTTP/2 桥接主线

> 本文基于 `grpc-java v1.83.1` 当前源码。前面三篇已经把客户端调用主线、服务端调用主线和横切面协议立住了：客户端那边，本地方法会被压成 `ClientCall` 和 stream；服务端这边，transport stream 会被抬升成 `ServerCallImpl`、`ServerCalls` 与具体调用模式；横切面那边，拦截器、`Context` 和 `Deadline` 会稳定挂回整条 RPC 调用链。本文继续接这条主线，只讲调用真正发出去之前还要经过的另一段桥：逻辑 target 怎样被解析成地址，多个实例之间怎样做选择，这次选择又怎样继续压到真正的 Netty HTTP/2 transport 上。重点放在 `NameResolver`、`LoadBalancer`、`SubchannelPicker`、`ManagedChannelImpl`、`GrpcHttp2ConnectionHandler`、`NettyClientHandler`、`NettyServerHandler` 这几层如何接力；不展开 Spring Cloud/Nacos/Dubbo 的对照，不重讲前三篇已经建立的客户端、服务端与横切面基线。

## 为什么“找人、选人、发出去”不能混成一层

只要把一次 RPC 真正往线上环境里放，而不是停留在单机 demo，你很快就会发现：调用主线里还有一段特别容易被讲糊的桥。

- 目标名是逻辑名字，不是固定 socket 地址
- 一个服务通常有多个实例，不是只有一个远端
- 解析结果会变，不是“一查完就永远不变”
- 某些实例会进入 `READY`，某些会掉进 `TRANSIENT_FAILURE`
- transport 最后还要把一次调用落到真正的 HTTP/2 连接和 stream 上

如果不把这几层拆开，很容易把整个过程粗暴讲成一句：

- “channel 会自己解析地址，然后负载均衡挑一个连接发出去。”

这句话的问题不在于完全错误，而在于它把三件性质完全不同的事情压成了一层：

- **找人**：这个逻辑 target 现在到底对应哪些地址和属性？
- **选人**：多个可用实例里，这次调用到底该落到哪一个 subchannel？
- **发出去**：选出来的目标最终怎样变成真正的 `ClientTransport` / HTTP/2 stream 动作？

只要你把问题问得再具体一点，这种混讲方式立刻就失效了。

比如：

- 为什么 `NameResolver` 不只是一次性 DNS 查询，而要提供持续更新？
- 为什么 `LoadBalancer` 不是一个“挑地址”的小函数，而会关心 subchannel 状态、refresh 和 picker 快照？
- 为什么 `ManagedChannelImpl` 中间还要站一个 delayed transport，而不是解析完、选完、立刻直连？
- 为什么 Netty 的 handler 明明都已经很底层了，却又不负责“解析和选址”？
- 为什么有的调用明明已经创建了，还能在 name resolution 尚未完成时先挂起？

这些问题都说明：

- gRPC 真正解决的不是“怎样拿到一个地址”
- 而是“怎样把逻辑 target、连续解析结果、选址状态机和 HTTP/2 transport 稳定接成一条链”

所以本文真正要回答的问题不是：

- gRPC 有没有 NameResolver
- gRPC 有没有 LoadBalancer
- gRPC 有没有 Netty transport

而是：

**为什么一次 RPC 真正发出去之前，必须先经过解析、选址和 transport 桥接这三段完全不同的运行时结构。**

如果先把最小总图压缩一下，它其实长这样：

```text
target
  -> NameResolver
  -> ResolvedAddresses
  -> LoadBalancer
  -> SubchannelPicker
  -> ClientTransport / ClientStream
  -> Netty HTTP/2 connection handler
```

这张图一旦立住，后面你再看：

- 为什么 `NameResolver` 要强调连续更新和 `refresh()`
- 为什么 `LoadBalancer` 要强调 synchronization context 和 picker 快照
- 为什么 `ManagedChannelImpl` 要处理 idle、pending call、delayed transport
- 为什么 Netty handler 只负责承接已经选好的连接与 stream

整条桥接主线就不会再像若干 API 名词的并列堆叠。

## 先看失败方案：为什么这段桥不能粗暴压平

### 失败方案一：channel 自己拿 target 去建连接

这是最自然、也最容易产生的错觉。

因为从业务方眼里看，很多时候你只写了一个 target：

- `dns:///service`
- `localhost:8080`
- 某个 authority 字符串

于是很容易脑补成：

- channel 自己拿着这个 target，解析一下，然后直接建连接就行

问题在于，这个模型完全低估了解析层的职责。

它解释不了：

- 为什么解析结果会持续更新，而不是一次性返回
- 为什么解析结果里不只有地址，还有 attributes 和 service config
- 为什么解析失败不能简单抛异常，而要通过 listener / refresh 协议继续参与运行时
- 为什么 `NameResolver.Args` 里还要带 proxy detector、offload executor、service config parser、synchronization context 这些看上去与“查地址”并不直接等价的能力

也就是说，解析层真正解决的不是“从字符串拿到地址”，而是：

- **把逻辑 target 变成一条持续更新的解析结果流**

如果这一层不存在，后面的选址状态机和 transport 桥接根本无处接起。

### 失败方案二：地址解析出来后，负载均衡随便挑一个就结束

另一种常见误解，是把 `LoadBalancer` 想成一个很薄的函数：

- 有一批地址
- 每次调用来时挑一个
- 结束

这种理解的问题在于，它只盯着“挑人”这一瞬间，却完全忽略了状态机。

因为真实运行时里，负载均衡关心的从来不只是“此刻选谁”，还包括：

- subchannel 什么时候创建
- 什么时候 request connection
- 什么时候进入 `CONNECTING`
- 什么时候从 `READY` 掉进 `IDLE` 或 `TRANSIENT_FAILURE`
- 什么时候需要 refresh name resolution
- 什么时候要更新 picker，让后续 RPC 看见一个新的可选快照

也就是说，负载均衡不是一个选址函数，而是：

- **围绕 subchannel、连接状态和 picker 快照演化的状态机**

如果只把它讲成“选地址”，后面像 `PickResult.withSubchannel(...)`、`requestConnection()`、`refreshNameResolution()` 这些关键行为都会显得很零散。

### 失败方案三：picker 直接控制 transport 细节

还有一种误区，是反过来把 picker 讲得太重。

比如：

- picker 选好了 subchannel
- 那它是不是就等于已经把 transport 发出去了？

不是。

`SubchannelPicker` 真正干的是：

- 在新 RPC 到来时，给出当前这一刻的选址决策快照

它不直接负责：

- resolver 的生命周期
- delayed transport 的 pending stream
- stream 何时真正开始
- HTTP/2 连接 handler 怎样创建

这些事情仍然在 `ManagedChannelImpl` 与 transport 世界那边。

所以 picker 不是 transport 实现，而是：

- **从选址状态机向调用世界暴露出来的一个快照边界**

如果把它讲成“picker 发起连接”，就会把选址层和 transport 层重新糊成一团。

### 失败方案四：Netty handler 负责发现和负载均衡

这也是一个特别容易在“越往下越底层”的惯性里犯的错。

因为 `GrpcHttp2ConnectionHandler`、`NettyClientHandler`、`NettyServerHandler` 看上去已经足够底层了，于是很多人会不自觉觉得：

- 最终的连接和 stream 都在这里了
- 那这里也顺手负责“决定连谁”吧

这正好错了。

Netty handler 真正承接的是：

- 已经决定好的连接语义
- 已经开始创建的 transport / stream
- HTTP/2 连接主链、flow control、reader/writer、keepalive 等运行时细节

它不负责上游的：

- target 解析
- 地址更新
- picker 选址
- subchannel 状态机

也就是说，Netty transport 再底层，也只是 **承接已经选好的结果**，而不是“上游解析与选址的总管”。

如果这一层界限不先立住，整篇文章会很容易从“发现和选址主线”滑成“Netty 细节重讲”。

## 先立最小总图：从 target 到 HTTP/2 transport 的桥接链

如果先不抠源码细节，最值得先记住的不是类名，而是四段角色顺序。

```text
target string / target uri
  -> NameResolver 持续产出 addresses + attrs + config
  -> LoadBalancer 接住解析结果并维护 subchannel/picker 状态机
  -> SubchannelPicker 为每个新 RPC 给出决策快照
  -> ManagedChannelImpl / delayed transport 把决策压成真实 transport/stream
  -> Netty handler 承接已经开始的 HTTP/2 连接与 stream 运行时
```

如果换成人话，这条线其实只发生了五件事。

第一，**逻辑 target 先要被翻译成当前这一刻“可能去哪里”的候选集合**。

第二，**这些候选集合不能直接拿来发调用，而要先经过一个持续演化的选址状态机**。

第三，**选址状态机不能直接碰 transport，它只能给新 RPC 一个“当前可怎么走”的快照**。

第四，**channel 运行时要负责把这个快照继续压成真正的 subchannel、transport 与 stream 动作**。

第五，**Netty transport 最后承接的，不是解析或负载均衡本身，而是已经选好的连接与 HTTP/2 运行时。**

也就是说，本篇真正该记住的不是“gRPC 有这些类”，而是：

- 解析、选址、发出去，是三层不同职责

先有这张图，后面再落代码，读者才不会把 resolver、lb 和 transport 写成一个大黑箱。

## 第一层：`NameResolver` 为什么不是一次性 DNS 查询，而是持续解析协议

从名字上看，`NameResolver` 很容易被想成“帮你做 DNS 解析的对象”。

但类注释一开始就把定位写得更大：

- 它是一个可插拔组件
- 输入是 target URI
- 输出是地址
- 而且地址和属性可以随着时间变化，所以调用方会注册 listener 来接收持续更新

见 `api/src/main/java/io/grpc/NameResolver.java:39`

这说明 `NameResolver` 第一层就已经不是“查一次地址”，而是：

- **持续产出解析结果的协议面**

### 为什么它必须是连续更新，而不是一次性返回

类注释还明确指出：

- 解析结果会变化
- listener 负责接收连续更新
- resolver 本身不需要在失败时自动重试，而是由 listener 在合适回退后调用 `refresh()`

见 `api/src/main/java/io/grpc/NameResolver.java:45`、`:48`

这非常关键。

因为它说明 gRPC 这里解决的根本不是“把字符串翻成 IP”，而是：

- 目标名对应的地址集合、属性、service config 可能随时变化
- 解析错误也属于运行时状态，不是构造期异常

所以 `NameResolver` 必须天然是一个“持续对话”的协议，而不是一次性工具方法。

### 为什么它如此强调 synchronization context 和 offload executor

`NameResolver` 注释里还有一个特别容易被忽略、但能说明设计重心的地方：

- `start()` / `shutdown()` / `refresh()` 这些有副作用的方法，都保证在同一个 `SynchronizationContext` 上顺序调用
- 但又明确要求：不要阻塞这个 context，耗时工作应该 offload 给单独线程

见 `api/src/main/java/io/grpc/NameResolver.java:52`

这说明解析层在 gRPC 里从一开始就被看作：

- 一个和 channel 运行时强耦合、又必须避免阻塞主调度上下文的组件

也就是说，它不是“随便查一下地址”的小工具，而是整个 channel 状态机里的一环。

### `Factory` 和 `Args` 说明解析层真正接的不是字符串，而是 channel 运行时

再往下看 `Factory.newNameResolver(...)` 和 `Args`，信息量就更大了。

`Factory` 明确说明：

- 是否能解析某个 target，首先看 scheme
- 普通 authority string 还要靠 default scheme 构造成 target URI

见 `api/src/main/java/io/grpc/NameResolver.java:149`、`:169`

而 `Args` 则带了一大堆只有“解析是运行时组件”才说得通的东西：

- default port
- proxy detector
- synchronization context
- service config parser
- scheduled executor
- channel logger
- offload executor
- overrideAuthority
- metricRecorder
- nameResolverRegistry
- custom args

见 `api/src/main/java/io/grpc/NameResolver.java:348`

这说明：

- resolver 接的绝不是一个裸 target string
- 它接的是一整套 channel 运行时支撑条件

所以解析层真正要回答的问题是：

- 在当前 channel 运行时环境里，这个 target 现在应该解析成什么

而不是“给我查个地址”。

### 测试怎么证明 `NameResolver` 不是简单 DNS 查询

`ManagedChannelImplTest.nameResolverArgsPropagation()` 直接证明：`NameResolver.Args` 里确实会传播 defaultPort、proxyDetector、offloadExecutor 和自定义参数，见 `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3835`。

这说明 resolver 不是孤立工具，而是被 channel 运行时完整喂养的组件。

`DnsNameResolverTest` 那边也给了两个有代表性的边界：

- `shouldUseJndi_*` 说明解析策略不是“凡 DNS 就查”，而有明确的 host 类型边界，见 `core/src/test/java/io/grpc/internal/DnsNameResolverTest.java:1135`
- `parseServiceConfig_capturesParseError()` 说明 TXT/service config 解析失败会被转成解析错误，而不是静默吞掉，见 `core/src/test/java/io/grpc/internal/DnsNameResolverTest.java:1208`

所以第一层可以先收一句：

- `NameResolver` 不是一次性 DNS 查询，而是把 target 持续翻译成“地址 + 属性 + config”结果流的运行时协议

## 第二层：`LoadBalancer` 为什么不是选址函数，而是 subchannel/picker 状态机

如果说 `NameResolver` 负责解决“现在可能去哪里”，那 `LoadBalancer` 解决的就不是“把地址取出来”了，而是：

- **多个可能目标里，这次调用现在该怎么走**

类注释一开始就把职责拆得很清楚：

- `LoadBalancer` 是主接口，负责接收 resolver 结果、subchannel 状态变化和 shutdown
- `SubchannelPicker` 负责每个新 RPC 的实际 pick
- `Factory` 负责创建新的 load balancer

见 `api/src/main/java/io/grpc/LoadBalancer.java:37`

这说明负载均衡在 gRPC 里一开始就不是一个小函数，而是一组分层角色。

### 为什么它如此强调 synchronization context 与 picker 快照

`LoadBalancer` 的大段注释反复强调两件事：

- 所有 `LoadBalancer` 方法都在同一个 `SynchronizationContext` 上串行执行
- picker 应该持有一份 snapshot，只管自己的状态，不要回头重新抓 LoadBalancer 的可变状态

见 `api/src/main/java/io/grpc/LoadBalancer.java:58`、`:85`

这说明 gRPC 对负载均衡的理解非常明确：

- 选址状态机和每次 RPC 的 pick 行为，不能混成一个同步共享大对象
- 前者在同步上下文里演化，后者拿快照并发工作

这也是为什么 `SubchannelPicker` 的定位如此关键。

因为它不是“顺手挑一个 subchannel”，而是：

- **负载均衡状态机对调用世界暴露出来的当前快照**

### 为什么 `acceptResolvedAddresses()` 说明解析层和选址层之间还有一道协议门

`LoadBalancer.acceptResolvedAddresses(...)` 很值得细看。

它不是简单接个地址列表，而是接：

- `ResolvedAddresses`

里面既有地址列表，也有 attributes，还可能带 load balancing policy config，见 `api/src/main/java/io/grpc/LoadBalancer.java:188`。

这说明解析层和选址层之间并不是“给你几个地址，自己想办法”，而是有一个正式的结果对象协议。

它还进一步暴露出一个关键边界：

- 如果 resolver 给出的是空地址列表，而 balancer 又不接受这种情况，channel 会把它转成 `UNAVAILABLE` 再走 `handleNameResolutionError()`

这说明解析与选址之间不是软耦合，而是有明确的错误契约。

### `SubchannelPicker` 真正是什么

`SubchannelPicker` 的注释说得很朴素：

- 它是 main balancing logic
- 必须线程安全
- 每个新 RPC 来时，用 `pickSubchannel(args)` 做决策

见 `api/src/main/java/io/grpc/LoadBalancer.java:452`、`:470`

但真正要抓住的点不是线程安全，而是：

- picker 只负责 **每个新 RPC 的选址决策**
- 它不负责 resolver 生命周期
- 不负责 subchannel 长期状态演化
- 也不应该反向回去同步 LoadBalancer 的可变状态

所以 picker 不是 transport，也不是 balancer 全部逻辑，而是状态机的快照出口。

### 测试怎么证明 LB 真的是状态机而不是函数

`PickFirstLeafLoadBalancerTest` 里有几组特别能说明问题的测试。

`refreshNameResolutionAfterSubchannelConnectionBroken()` 证明：当 subchannel 连接断裂、进入失败或空闲时，LB 不只是“换个地址”，而会 refresh name resolution、更新 balancing state 和 picker，见 `core/src/test/java/io/grpc/internal/PickFirstLeafLoadBalancerTest.java:457`。

`pickAfterResolvedAndUnchanged()` 证明解析结果没变时，不会无谓重连，见 `core/src/test/java/io/grpc/internal/PickFirstLeafLoadBalancerTest.java:488`。

`pickAfterResolvedAndChanged()` 又证明解析结果变化时，会替换 subchannel 并重连，见 `core/src/test/java/io/grpc/internal/PickFirstLeafLoadBalancerTest.java:506`。

而 `healthCheckFlow()` 则进一步证明：真正影响 picker 输出的不是“地址列表本身”，而是 subchannel 健康与连接状态如何共同演化，见 `core/src/test/java/io/grpc/internal/PickFirstLeafLoadBalancerTest.java:530`。

所以第二层可以先收一句：

- `LoadBalancer` 不是选址函数，而是围绕 resolved addresses、subchannel 和 picker 快照演化的状态机

## 第三层：`ManagedChannelImpl` 为什么必须站在 resolver、lb、delayed transport 中间

现在到了真正容易被讲成黑箱的一层：

- `ManagedChannelImpl`

如果只看名字，很容易觉得它只是在前面那篇里负责 new call，而发现/选址/transport 桥接这段应该主要由 resolver 和 lb 自己搞定。

这正好低估了 channel 运行时的角色。

### `exitIdleMode()` 说明 channel 不是 passive container，而是整条桥的调度中枢

`ManagedChannelImpl.exitIdleMode()` 一上来就暴露了这种中枢角色。

它会：

- 管 idle timer
- 创建 `LbHelperImpl`
- 让 `loadBalancerFactory.newLoadBalancer(lbHelper)` 真正发生
- 构造 `NameResolverListener`
- 启动 `nameResolver.start(listener)`

见 `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:389`、`:403`、`:414`

这说明：

- resolver 和 lb 并不是自己悬浮运行
- 它们是被 `ManagedChannelImpl` 在特定状态转换点上拉起来的

所以 channel 不是 passive container，而是整条发现/选址桥的调度中枢。

### `refreshNameResolution()` 和 idleness 说明发现层受 channel 生命周期统管

`refreshNameResolution()` 只有在 syncContext 中才能跑，而且只有 resolver 真正启动后才会 refresh，见 `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:454`。

而 `ManagedChannelImplIdlenessTest.newCallExitsIdleness()` 也证明了：新 call 会把 channel 从 idle 拉出来，并触发 resolver/LB 启动，见 `core/src/test/java/io/grpc/internal/ManagedChannelImplIdlenessTest.java:229`。

`delayedTransportHoldsOffIdleness()` 又说明 delayed transport 上如果还有 pending RPC，channel 不能直接进入 idle，见 `core/src/test/java/io/grpc/internal/ManagedChannelImplIdlenessTest.java:282`。

这说明：

- name resolution 和 load balancing 的生命周期，不是独立后台线程自己决定的
- 它们受 channel 的 idle/active/pending-call 状态统一调度

### `ChannelStreamProvider` 说明 pick 结果到真正 stream 之间还隔着一层 transport 桥

`ManagedChannelImpl.ChannelStreamProvider.newStream(...)` 是本篇最该记住的桥之一。

它会：

- 在当前 `Context` 下把请求交给 delayed transport
- 如果启用 retry/hedging，还会进一步构造 `RetriableStream`

见 `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:461`

这说明 picker 即使已经选出一个方向，也不意味着“调用立刻就落到真实 socket 上”。

在 gRPC 里，中间还站着一层：

- delayed transport
- pending stream
- retry/hedging 的子流

这层桥存在的意义是：

- 让选址结果和真正 transport 下沉之间留出一个可重处理、可缓冲、可重试的空间

所以 `ManagedChannelImpl` 不是薄转发器，而是：

- resolver/lb 状态机与真实 transport 之间的缓冲和桥接层

### `NameResolver.Args` 与 `getNameResolver(...)` 说明 resolver 也是 channel 中央装配出来的

构造器里 `ManagedChannelImpl` 还会集中装配 `NameResolver.Args`，把 defaultPort、proxyDetector、syncContext、scheduledExecutor、serviceConfigParser、channelLogger、offloadExecutor、overrideAuthority、metricRecorder、nameResolverRegistry 和 custom args 一次性喂给 resolver，见 `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:582`。

接着再通过 `getNameResolver(...)`：

- 创建 resolver
- 包成 `RetryingNameResolver`
- 必要时再包 overrideAuthority

见 `core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:595`、`:669`

这再次说明：

- resolver 不是“某个外部对象回调给 channel”
- 它从构造阶段开始就是 channel 运行时精心装配出来的部件

### 测试怎么证明 `ManagedChannelImpl` 真在串这一整段桥

`ManagedChannelImplTest.startCallBeforeNameResolution()` 直接证明：调用可以先创建，resolver/LB/transport ready 之后才真正落到 `mockTransport.newStream()`，见 `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:520`。

`newCallWithConfigSelector()` 还证明 config selector 可以在 pick 前改写调用行为，见 `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:565`。

`nameResolverArgsPropagation()` 则证明 `NameResolver.Args` 的传播不是文档装饰，而是真正从 channel 构造一路传进 resolver，见 `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3835`。

`nameResolverHelper_*` 与 `disableServiceConfigLookUp_*` 这组测试又证明：service config 解析、LB config 选择和 default config 回退，也都在这条桥里完成，见 `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3901`。

所以第三层可以先收一句：

- `ManagedChannelImpl` 是把 resolver、lb、pending call、delayed transport 和真实 transport 串成一条桥的中枢，而不是薄转发器

## 第四层：一次 pick 怎样真正落成 subchannel、transport 和 stream

现在可以把“选人”和“发出去”之间最后那一步拆开了。

### picker 返回的不是连接本身，而是 `PickResult`

`SubchannelPicker.pickSubchannel(args)` 返回的不是 socket、不是 stream，而是 `PickResult`。这件事虽然在 API 上很普通，但意义很大：

- 选址层输出的是决策
- 不是 transport 对象本身

于是它可以表达的不只是“选中了一个 subchannel”，还包括：

- `withSubchannel(...)`
- `withError(...)`
- `withNoResult()`

也就是说，picker 的输出天然就是“这次调用现在应该怎么办”的快照，而不是“已经发出去了”。

### `requestConnection()` 为什么说明 subchannel 和 picker 都还停留在 transport 之前

`PickFirstLeafLoadBalancerTest` 有一个非常典型的细节：

当 subchannel 处于 `IDLE` 时，picker 被调用两次返回相同结果，但真正的 `requestConnection()` 只会触发一次，见 `core/src/test/java/io/grpc/internal/PickFirstLeafLoadBalancerTest.java:432`。

这说明：

- picker 的职责是让新 RPC 在当前状态下有一个一致的选址视图
- 真正的连接建立仍然是 subchannel 世界的动作

也就是说，即使 picker 已经做了选择，transport 世界还没真正启动。它只是拿到了“应该去哪个 subchannel”的结论。

### 从解析结果到 `acceptResolvedAddresses()` 再到 picker

`ManagedChannelImplTest` 里另一条很重要的证据是：name resolver 结果会先被交给 LB 的 `acceptResolvedAddresses(...)`，随后 helper 创建 subchannel，再由 picker 在 `READY` 后返回 `PickResult.withSubchannel(subchannel)`，最终 transport 才 `newStream()`，见：

- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3411`
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3440`
- `core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3447`

这条证据链非常适合回答一个常见误解：

- 解析结果不是直接喂给 transport
- 中间必须先经过 LB 吸收、转换、稳定成 picker 快照

所以真正的桥是：

- `ResolvedAddresses`
- `LoadBalancer.acceptResolvedAddresses()`
- `SubchannelPicker`
- `PickResult`
- `Subchannel`
- `ClientTransport.newStream()`

而不是“resolver 一解析完就能建流”。

## 第五层：Netty transport 在这条链上的真正位置

现在终于可以把 Netty 这一头接上来了。

如果不先把前面三层立住，很容易误以为 Netty handler 也负责“决定连谁”。

实际上不是。

### `GrpcHttp2ConnectionHandler` 说明 transport 承接的是连接主链，不是解析与选址

`GrpcHttp2ConnectionHandler` 的类注释非常克制：

- 它只是 gRPC 对 `Http2ConnectionHandler` 的 wrapper

见 `netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:32`

这里最值钱的不是它包了什么字段，而是它没有声称自己负责什么：

- 不负责 target 解析
- 不负责 picker 选址
- 不负责 resolver 生命周期

它承接的是：

- 已经建立的连接语义
- negotiation 完成后的 attributes/securityInfo
- 与 HTTP/2 连接主链相接的 transport 运行时

见 `netty/src/main/java/io/grpc/netty/GrpcHttp2ConnectionHandler.java:75`

所以这层在本篇里最该记住的是：

- Netty transport 不是上游选址总管，而是 HTTP/2 连接主链承接者

### `NettyClientHandler` 说明 transport 真正在这里关心的是连接、flow control 和 authority

`NettyClientHandler.newHandler(...)` 会显式创建：

- `Http2Connection`
- frame reader / writer
- `UniformStreamByteDistributor`
- remote/local flow controller
- `StreamBufferingEncoder`
- settings

同时还持有：

- authority
- keepalive
- in-use state
- transport lifecycle manager
- eag attributes

见：

- `netty/src/main/java/io/grpc/netty/NettyClientHandler.java:120`
- `netty/src/main/java/io/grpc/netty/NettyClientHandler.java:156`
- `netty/src/main/java/io/grpc/netty/NettyClientHandler.java:177`

这些信息很能说明它的真实职责：

- 到了 Netty transport 这一层，gRPC 已经不再问“选谁”
- 它问的是“已经选好的连接与 stream，怎样稳定落进 HTTP/2 连接主链”

所以 client transport 关心的是：

- authority
- flow control
- keepalive
- lifecycle
- stream buffering

而不是 resolver 或 picker 状态机本身。

### `NettyServerHandler` 为什么也需要在这一篇出现

服务端这边也一样，但它在本篇里的作用不只是“顺手证明一下服务端也有 handler”。

`NettyServerHandler.newHandler(...)` 会创建 connection、remote/local flow controller、settings、keepalive enforcer、RST 计数器等，见 `netty/src/main/java/io/grpc/netty/NettyServerHandler.java:159`、`:254`。

这说明它和客户端那边的 `NettyClientHandler` 一起，共同完成了一件对本篇很关键的事：

- **把“transport 只承接连接与 stream 运行时，不承接上游解析与选址”这条边界在 client/server 两侧都钉死。**

也就是说，`NettyServerHandler` 在本篇中的价值不是参与“找人、选人”，而是帮助读者看清：

- transport 层无论在 client 还是 server，一旦开始工作，面对的都已经是某条确定的连接与 stream
- 上游发现、解析、实例选择这些问题，到这里已经结束了

这和发现/选址没有直接关系，但它恰恰能反过来证明前面三层桥接没有被偷偷塞进 transport。

所以把 Netty client/server handler 放到这一篇里，不是为了重讲 HTTP/2，也不是为了凑一个对照，而是为了强调一条在双侧都成立的边界：

- 上游 resolver/LB/channel 负责把调用送到正确的 transport 入口
- Netty handler 负责从 transport 入口继续进入 HTTP/2 运行时

## 最后把整条桥接主线收回来：gRPC 怎样把发现、选址和 HTTP/2 transport 接成整体

现在可以把整篇文章的主线收回来了。

如果只记一句最短的人话答案，那就是：

**gRPC 先用 `NameResolver` 把逻辑 target 持续翻译成“地址 + 属性 + config”，再用 `LoadBalancer` 把这些结果收束成 subchannel/picker 状态机，再由 `ManagedChannelImpl` 把 picker 决策压到 delayed transport、`ClientTransport` 与 `ClientStream` 这一层桥上，最后才交给 Netty handler 进入 HTTP/2 连接主链。**

也就是说，真正完整的下沉顺序不是“picker 之后立刻 Netty”，而是：

```text
NameResolver
  -> LoadBalancer / SubchannelPicker
  -> ManagedChannelImpl / delayed transport
  -> ClientTransport / ClientStream
  -> Netty HTTP/2 handler
```

把它拆开，就是四层非常稳定的分工。

### 第一层：`NameResolver` 负责“找人”

- 把 target URI 变成持续更新的解析结果流
- 结果里不仅有地址，还有 attributes 与 config
- 失败通过 listener / refresh 协议回到运行时

### 第二层：`LoadBalancer` 负责“选人”

- 吸收解析结果
- 维护 subchannel 状态机
- 通过 picker 快照为每个新 RPC 提供决策

### 第三层：`ManagedChannelImpl` 负责“把选址结果变成 transport 桥动作”

- 管 idle / active / pending call
- 装配 resolver args 与 helper
- 串 delayed transport、retry/hedging 与 real transport
- 把 picker 决策继续压成真正的 `ClientTransport` / `ClientStream`

### 第四层：Netty transport 负责“把已经选好的 transport 动作落进 HTTP/2 主线”

- `GrpcHttp2ConnectionHandler` 包 HTTP/2 连接 handler
- `NettyClientHandler` / `NettyServerHandler` 管连接、flow control、keepalive、authority 与 stream 运行时
- 不负责上游解析与选址

## 这篇先立住的，不是服务发现大全，而是 gRPC 的发现-选址-transport 桥接协议

到这里为止，这篇文章故意没有展开很多你已经能想到的线：

- Spring Cloud Commons 怎样抽象发现与负载均衡
- Nacos 怎样推送地址与 config
- Dubbo Registry / Cluster 怎样建自己的发现与选址模型
- pick_first / round_robin / xDS 的全量策略实现细节
- retry/hedging 怎样独立演化成更复杂的 transport 策略

不是这些不重要，而是第四篇如果不先把 gRPC 自己这条桥接主线立住，后面所有跨框架对照都会重新退化成“这边也有 resolver，那边也有 lb”的名词平铺。

所以这篇真正要留下来的心智模型只有一条：

```text
解析层回答：现在可能去哪里
选址层回答：这次调用现在该走谁
channel/transport 桥回答：这个决策怎样真正落成 stream 和 HTTP/2 连接动作
```

只要这条线立住，后面再去看 Spring Cloud Commons、Nacos、Dubbo Registry 或 Gateway 里的发现和路由机制，读者脑中就已经有了一条可对照的基准主线。

而这，正是 gRPC-Java 在“RPC 与治理”主题里最适合作为第四篇留下来的桥接地基。