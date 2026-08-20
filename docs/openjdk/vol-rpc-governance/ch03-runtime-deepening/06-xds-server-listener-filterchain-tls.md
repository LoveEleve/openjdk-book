# grpc-java xDS 服务端：动态 Listener、Filter Chain、TLS 与路由切换

> 基于 grpc-java v1.83.1

## 一、困惑开场：为什么动态配置不能只是替换一个 handler

在普通 grpc-java 服务端里，服务启动之后，监听地址、transport、ServerCall 和 handler 之间的关系相对稳定。你把服务注册给 `ServerBuilder`，server 启动，连接进来，协议协商完成，请求再进入对应的 handler。

但 xDS 服务端改变了一个前提：监听什么、哪些连接允许进入、连接使用哪套 TLS、请求匹配哪条 route，都可能由控制面动态下发。

于是问题来了：收到一份新的 LDS/RDS 配置后，grpc-java 能不能直接把旧 handler 换掉？如果旧连接已经建立，新的 filter chain 要不要立即作用到它？如果 TLS context 变了，正在握手的连接怎么办？如果 RDS 还没到，服务端能不能先用半成品 listener 接请求？

这些问题说明，xDS 服务端不是“给普通 server 多加一个配置来源”。它实际上接管了服务端接入层的生命周期：连接建立前要选 filter chain，协议协商时要选 TLS，连接建立后请求还要继续经过 routing；配置更新时，新连接要使用新 selector，旧连接要按 drain 规则退出。

## 二、前情回顾：客户端 xDS 改写出站路径，服务端 xDS 改写入站路径

在上一页 xDS 客户端篇中，我们沿着 `xds:///service` 走过了 bootstrap、ADS、LDS/RDS/CDS/EDS、`XdsConfig`、ConfigSelector、cluster_manager 和 child LB。那条链解决的是：客户端如何根据控制面决定“请求应该发给谁”。

服务端篇的方向正好相反，但不是简单镜像：它解决的是“连接进来之后，应该进入哪套 listener/filter chain/TLS/routing”。

如果把两篇并排看，镜像关系其实很清楚：

- 客户端篇改写的是**出站选择链**：route / cluster / child LB / transport。  
- 服务端篇改写的是**入站接入链**：listener / filter chain / TLS / request routing。  
- 客户端每次 RPC 都经 `InternalConfigSelector` 重新选 cluster；服务端每次新连接都经 `FilterChainSelector` 重新选接入链。  

也正因为如此，客户端篇最关键的接缝是 resolver 和 ConfigSelector，而服务端篇最关键的接缝是 protocol negotiator 和 interceptor。

普通服务端可以粗略画成：

```text
ServerBuilder → ServerImpl → transport → ServerCall → handler
```

xDS 服务端则在 transport 进入 ServerCall 之前插入了动态选择层：

```text
XdsServerBuilder
  → XdsServerWrapper
  → LDS/RDS
  → FilterChainSelector
  → Netty protocol negotiation
  → TLS / filter chain
  → request routing
  → ServerCall / handler
```

所以这篇不是重复讲服务端调用主线，而是解释 xDS 如何动态重写“连接入口”和“请求入口”。

## 三、先走三条失败的路

### 失败方案一：服务端 xDS 就是客户端 xDS 的反向 resolver

客户端 xDS 关注的是出站选择：目标名、route、cluster、endpoint、child LB。服务端 xDS 关注的是入站接入：listener、连接属性、filter chain、TLS、请求 routing。

两者虽然都依赖 LDS/RDS 和 XdsClient，但数据面接缝完全不同。客户端在 resolver/ConfigSelector 处切入，服务端在 Netty protocol negotiator 和 server interceptor 处切入。

所以服务端 xDS 不是“反向名字解析器”，而是动态接入层。

### 失败方案二：收到新 LDS/RDS 后直接替换 handler

如果直接替换 handler，会遇到两个问题。

第一，已经建立的连接不应该被半途强行换成另一套 TLS/filter chain。连接级属性和握手结果已经决定了它属于哪条 filter chain。

第二，配置更新可能只影响新连接，或者只影响后续请求。把旧 handler 瞬时替换掉，无法表达这种生命周期差异。

grpc-java 的做法是构造新的 `FilterChainSelector`，原子替换当前 selector。新连接使用新配置，旧连接按照 drain 和 transport 生命周期逐步退出。

### 失败方案三：TLS、filter chain、routing 都放到请求 handler 里

TLS 必须在 gRPC handler 之前完成；filter chain 匹配依赖连接属性；routing 则依赖请求的 authority、path 和 headers。

如果把三者全部塞进请求 handler，TLS 会太晚，连接级 filter chain 无法真正参与协议协商，动态证书也无法在握手阶段生效。

因此服务端 xDS 必须拆成两层：

- 连接级：protocol negotiator 选择 filter chain 和 TLS。
- 请求级：`ConfigApplyingInterceptor` 根据已选配置匹配 route。

## 四、最小总图：控制面如何改写服务端入口

先建立整篇文章的总图：

```text
XdsServerBuilder
    ↓
XdsServerWrapper
    ↓
Bootstrap / XdsClient
    ↓
LDS listener
    ↓
RDS / filter chain / TLS dependencies
    ↓
FilterChainSelectorManager
    ↓ 新连接
FilterChainMatchingProtocolNegotiators
    ↓
TLS / protocol negotiation / selected filter chain
    ↓ 已建立连接上的请求
ConfigApplyingInterceptor
    ↓
route / virtual host matching
    ↓
ServerCall / handler
```

这条链有三个边界：

1. `XdsServerWrapper` 负责控制面资源和配置依赖。
2. `FilterChainSelectorManager` 负责当前 selector 的生命周期和替换。
3. negotiator 与 interceptor 分别负责连接级选择和请求级 routing。

这里要先把最容易混淆的一刀提前切开：**selector 是连接级的，interceptor 是请求级的。** 连接一建立，selector 就要根据连接属性决定这条连接挂到哪条 filter chain、用哪套 TLS；而 interceptor 要等 HTTP/2 和 gRPC 请求已经进入服务端之后，才能拿 authority/path/headers 去做 route 匹配。后面所有实现细节，都围绕这两个时间边界展开。

## 五、XdsServerBuilder：把 xDS 接入普通 Netty server

### 5.1 builder 不是另起一套 server

`XdsServerBuilder` 的职责不是实现一套新的 RPC server，而是包装普通 Netty server builder，把 xDS 所需的 selector manager、wrapper 和协议协商器接到原有 server 生命周期里。

`XdsServerBuilder.java:44` — builder 结构
`XdsServerBuilder.java:109` — 创建 `FilterChainSelectorManager`
`XdsServerBuilder.java:120` — 创建 `XdsServerWrapper`

这条设计很重要：xDS 服务端仍然复用 grpc-java 已经成熟的 ServerImpl、ServerCall、transport 和 handler 体系，xDS 只改写连接进入这些体系之前的选择过程。

### 5.2 为什么需要 wrapper

如果只把 bootstrap 和 XdsClient 塞进 builder，builder 很快会承担太多职责：资源 watch、LDS/RDS 依赖、selector 更新、启动失败、delegate server 生命周期都会混在构造阶段。

反过来说，如果没有 wrapper，只靠普通 `ServerBuilder` 想做热更新，你几乎只剩下两条坏路可走：

- 要么在 `build()`/`start()` 时同步等所有 xDS 依赖齐全，这会把控制面延迟直接塞进服务启动路径；  
- 要么在普通 server 已经运行时硬替换 listener/filter chain/TLS 配置，这又会把新旧连接的生命周期边界全部打乱。

`XdsServerWrapper` 把这些运行时职责从 builder 中拿出来。builder 负责装配，wrapper 负责运行。

`XdsServerWrapper.java:175` — wrapper start
`XdsServerWrapper.java:197` — bootstrap / XdsClient / listener resource

这让服务端可以在 server 已经创建后，继续等待 LDS/RDS 配置，并在配置准备好时更新 selector，而不是要求所有 xDS 配置在 `build()` 时同步完成。

## 六、XdsServerWrapper：LDS/RDS 依赖如何变成 selector

### 6.1 DiscoveryState 是服务端 coordinator

`XdsServerWrapper` 内部的 `DiscoveryState` 是服务端 xDS 的主要 coordinator。它负责 watch server listener resource，并根据 listener 配置继续处理 RDS、filter chain 和 routing 依赖。

`XdsServerWrapper.java:377` — DiscoveryState watch LDS

服务端接收 LDS 后，不是立即宣布“配置已经完成”。它还要检查 listener 的地址、协议、filter chain 是否有效，并判断 RDS 是 inline 还是需要继续订阅远端资源。

`XdsServerWrapper.java:405` — LDS response / RDS 依赖

### 6.2 为什么必须等待依赖完整

一个 server listener 可能包含多个 filter chain，每条 filter chain 又可能关联 TLS context、HTTP connection manager 和 RDS route。只收到 listener 外壳，不代表服务端已经拥有可用的接入配置。

`DiscoveryState` 要维护这些依赖的状态：哪些 RDS 已经到达，哪些 filter chain 已经能解析，哪些 TLS provider 可用，哪些 routing config 仍在等待。

`XdsServerWrapper.java:455` — filter chain / RDS 等待

如果依赖不完整，服务端不能用半成品 selector 接收请求。生产上这种情况最常见的症状不是“进程直接崩了”，而是更隐蔽的两类表现：

- **新连接迟迟接不进来**：控制面看起来已经推送成功，但 selector 还没形成，连接入口层没有真正切到新配置。  
- **新配置迟迟不生效**：旧连接还在按旧 selector 处理，而新 selector 因依赖未齐全根本没有原子替换上去。

所以看到“LDS 已经 ACK，但服务端行为没变”时，不要只看 LDS，要继续查 RDS、TLS provider 和 filter chain 是否完整。

### 6.3 构造新的 FilterChainSelector

当资源依赖终于完整，wrapper 会根据当前 listener、filter chain、TLS 和 routing 配置构造新的 selector，然后原子替换当前 selector。

`XdsServerWrapper.java:526` — 构造并原子替换 selector

这里的关键不是“把配置对象存起来”，而是生成一个可以被连接建立阶段消费的选择器。selector 代表了某个时间点上，服务端应该如何处理新连接。

## 七、FilterChainSelector：连接级选择与请求级 routing

### 7.1 selector 负责哪一层

`FilterChainSelector` 负责的是连接级选择。它根据连接的目标地址、远端地址、TLS/ALPN 等属性，决定当前连接匹配哪条 filter chain。

它不负责解析每一个 RPC 方法，也不负责决定某个 path 应该进入哪个业务 handler。那是请求级 routing 的工作。

### 7.2 连接级 filter chain

`XdsListenerResource` 同时处理 client-side listener 和 server-side listener 两种资源分支。服务端分支会解析 TCP listener 和 filter chain。

`XdsListenerResource.java:103` — client-side listener 分支
`XdsListenerResource.java:133` — server-side listener 分支
`XdsListenerResource.java:145` — server filter chain 解析

一条 filter chain 可以包含：

- 匹配条件
- TLS context
- HTTP connection manager
- route 配置
- server-side interceptor/filter 信息

这说明 filter chain 不是简单的“一个 handler 列表”，而是连接级接入策略的完整快照。

### 7.3 请求级 routing

连接匹配完成后，请求进入 gRPC server，还要经过 `ConfigApplyingInterceptor`。它根据当前 filter chain 里的 routing config，匹配 virtual host 和 route。

`XdsServerWrapper.java:876` — `ConfigApplyingInterceptor` 请求路由

因此服务端 xDS 有一个非常清楚的二层边界：

```text
连接属性 → FilterChainSelector → TLS / filter chain
RPC authority/path/headers → ConfigApplyingInterceptor → route
```

这也是它不能把所有逻辑都放进 handler 的原因：连接级和请求级不是同一个时间点，也不是同一个输入。

## 八、Protocol Negotiator：TLS 必须在 gRPC handler 之前完成

### 8.1 negotiator 是连接入口

`FilterChainMatchingProtocolNegotiators` 接入 Netty 协议协商阶段。它在连接还没有进入普通 gRPC handler 之前，根据 selector 选择 filter chain，并注入对应的 TLS context、ALPN 和协议协商逻辑。

`FilterChainMatchingProtocolNegotiators.java:68` — negotiator 接入
`FilterChainMatchingProtocolNegotiators.java:98` — filter chain / TLS 选择

这解释了一个生产问题：为什么 TLS 配置变化后，旧连接不会立刻换证书？因为 TLS context 是连接建立/握手阶段选择的，已经完成握手的连接不可能被中途改写成另一套 TLS。

### 8.2 动态 TLS provider

`TlsContextManagerImpl` 同时管理 client/server TLS provider，并通过引用计数管理 provider 生命周期。

`TlsContextManagerImpl.java:29` — TLS context manager
`TlsContextManagerImpl.java:59` — provider / reference lifecycle

当新 selector 携带新的 TLS context 时，新连接会根据新 provider 建立；旧连接则继续使用已经协商完成的安全上下文，直到 drain 或自然终止。

所以“控制面已经更新 TLS，但旧连接还在使用旧证书”不一定是配置没生效，而可能是连接生命周期本来就允许旧连接继续存在。

## 九、selector 热更新、旧连接 drain 与错误恢复

### 9.1 新 selector 不等于旧连接瞬时切换

selector 更新的核心策略是：新连接使用新 selector，旧连接不被强行在中途重做 filter chain/TLS。

`FilterChainSelectorManager` 负责当前 selector 的保存、替换和连接生命周期管理。

`FilterChainSelectorManager.java:27` — selector manager
`FilterChainSelectorManager.java:61` — selector 生命周期

这和 ch05/03 里的 GOAWAY/drain 语义是同一类问题：配置更新和连接终止不是同一个事件。新配置可以立即影响新连接，但旧连接要等到 drain、idle、GOAWAY 或自然结束。

### 9.2 配置缺失时，服务端不能用半成品启动数据面

如果 LDS 到了但 RDS 没到，或者 filter chain 的 TLS provider 无法构造，服务端不能假装已经拥有完整配置。它要么继续等待依赖，要么进入不提供服务/错误恢复路径，具体行为取决于 wrapper 当前生命周期状态。

这类问题的排障顺序应该是：

1. LDS 是否收到并通过校验？
2. RDS 是否已经到达？
3. filter chain 是否完整？
4. TLS provider 是否能构造？
5. selector 是否已经原子替换？
6. 新连接是否真的经过了新的 negotiator？

### 9.3 错误恢复不是简单重启 server

`XdsServerWrapper` 的价值之一，是把控制面错误和 delegate server 生命周期隔离开。xDS stream 断开、资源 NACK、配置暂时缺失，不应自动等价于整个 Java server 进程崩溃。

生产上看到服务端“暂时不接新连接”时，要区分：

- control-plane stream 在重连
- listener/filter chain 依赖不完整
- TLS context 构造失败
- selector 正在等待新的有效配置
- delegate server/transport 正在 drain

这些问题都可能表现成“服务不可用”，但修复动作完全不同。

## 十、误解澄清

### 误解一：xDS 服务端就是客户端 xDS 的反向版本

不是。客户端 xDS 主要在出站调用前做 route/cluster/LB 选择；服务端 xDS 在入站连接建立和请求处理前做 listener/filter chain/TLS/routing 选择。两者共享控制面资源，但数据面切入点不同。

### 误解二：LDS/RDS 更新后所有连接立刻使用新配置

不是。新 selector 可以立即成为新连接的选择依据，但已经完成 TLS/协议协商的旧连接通常继续使用旧上下文，直到 drain 或终止。

### 误解三：TLS、filter chain、routing 都是 handler 内部逻辑

不是。TLS 和连接级 filter chain 必须在 protocol negotiation 阶段处理；请求级 routing 才由 `ConfigApplyingInterceptor` 完成。把三者混在 handler 中会把时间边界和输入边界都弄错。

### 误解四：控制面推送成功，就等于旧连接已经切到新 TLS / filter chain

也不是。控制面推送成功，只说明新资源已经具备被消费的可能；真正作用到连接上，还要看 selector 是否已原子替换，以及这条连接是在旧 selector 还是新 selector 之下建立的。已经完成握手的旧连接，通常会继续使用旧 TLS / filter chain，直到 drain 或自然终止。

## 十一、收网总结：xDS 服务端是动态接入层

回到开头的困惑：为什么服务端 xDS 不能简单替换一个 handler？

因为它动态管理的是一整套连接接入生命周期：

- `XdsServerBuilder` 把 xDS 接入普通 Netty server。
- `XdsServerWrapper` 通过 XdsClient 同步 LDS/RDS 并等待依赖完整。
- `FilterChainSelectorManager` 管理当前 selector 及其生命周期。
- protocol negotiator 在连接建立时选择 filter chain 和 TLS。
- `ConfigApplyingInterceptor` 在请求层匹配 virtual host 和 route。
- 新配置作用于新连接，旧连接按 drain/GOAWAY/idle 生命周期退出。

**三句话总结：**

1. xDS 服务端不是客户端 xDS 的反向 resolver，而是动态 listener、filter chain、TLS 和 routing 的接入层。
2. 服务端配置更新不是 handler 指针替换，而是 selector 原子切换与旧连接 drain 的生命周期协调。
3. 服务端 xDS 的关键边界是“连接级选择先于请求级 routing”：TLS/filter chain 在 negotiator，route 在 interceptor，二者不能混为一层。

**下篇说明：** xDS 客户端与服务端主链已经闭环；后续可以继续拆 filters/security/RBAC/fault injection 等独立专题，也可以进入平台与生态变体层。