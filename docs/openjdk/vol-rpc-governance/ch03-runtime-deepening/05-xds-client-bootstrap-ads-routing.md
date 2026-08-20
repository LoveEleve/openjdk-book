# grpc-java xDS 客户端：从 Bootstrap/ADS 到动态路由与负载均衡

> 基于 grpc-java v1.83.1

## 一、困惑开场：`xds:///service` 为什么不只是解析成地址

普通 gRPC 客户端的目标名，通常可以沿着一条比较直观的路径走下去：resolver 把名字解析成地址，LoadBalancer 根据地址创建 subchannel，picker 再选一个 subchannel，transport 最后把请求发出去。

但当目标变成 `xds:///service`，事情突然复杂了。客户端不再只是收到一批 IP 地址，而是可能收到 listener、route、cluster、endpoint、重试策略、负载均衡策略，甚至每次 RPC 都可能根据 path、headers 或权重选择不同的 cluster。

这就引出了几个很实际的问题：

- bootstrap 文件到底决定了什么？
- 客户端什么时候连接 xDS control plane？
- ADS 收到 LDS、RDS、CDS、EDS 后，谁负责把它们拼起来？
- 为什么 resolver 最后生成的是 service config 和 `InternalConfigSelector`，而不是地址列表？
- xDS 资源变化后，已经创建的 channel 和后续 RPC 怎么看到新配置？

如果把 xDS 理解成“一个更高级的名字解析器”，这些问题都解释不通。grpc-java 的 xDS 客户端真正做的事情是：**用控制面持续改写原本的 resolver、route、service config 和 LB 选择链。**

## 二、前情回顾：普通 resolver/LB 主线之后，xDS 把控制面插了进来

在 ch01/04 中，我们已经知道普通 gRPC 的主线：逻辑 target 经过 resolver 变成地址，地址被 LB 组织成 subchannel，picker 决定一次 RPC 走哪条连接，transport 最终承载字节。

在 ch03/01 中，我们又知道 service config 可以继续影响 retry、hedging 和每次调用的运行时策略。在 ch05/02 中，我们则从生产视角看过 picker、subchannel 和 transport 如何决定一次 RPC 是否真的离开进程。

把普通链路拆开看，xDS 插入了四个位置：

- **resolver 入口**：`xds:///service` 不再只触发本地地址解析，而是触发 bootstrap 和资源 watch。
- **resolver 输出**：输出不再只有地址，还包含 service config、cluster manager 和 ConfigSelector。
- **每次 RPC 入口**：调用在真正进入 picker 前，先经过 route/virtual host/weighted cluster 选择。
- **LB 输入**：child LB 不再只消费本地静态配置，而是消费 CDS/EDS 翻译后的动态配置。

xDS 的特殊之处在于，它不是把这条主线推翻重写，而是在这些接缝处插入一个动态控制面。普通 resolver/LB/transport 仍然存在，只是它们收到的输入变成了控制面持续改写后的结果。

所以这篇文章回答的是：**控制面下发的资源，如何一路改写成 grpc-java 数据面真正能消费的配置。**

## 三、先走三条失败的路

### 失败方案一：xDS 就是高级版名字解析，最后还是返回地址

这个理解只看到了 EDS 或 endpoint，却忽略了 xDS 资源树的上游部分。

如果 xDS 只是返回地址，那么 route、virtual host、weighted cluster、retry policy、timeout 和 child LB 配置都没有位置可放。但 grpc-java 的 `XdsNameResolver` 最终生成的并不是一个地址列表，而是 service config、`InternalConfigSelector` 和 `cluster_manager` 风格的负载均衡配置。

所以 xDS 不是“更聪明的 DNS”。它把控制面里的路由和策略翻译成了 grpc-java 调用链能够理解的对象。

### 失败方案二：ADS 收到资源后，直接交给 LB 就够了

这个方案忽略了资源之间的依赖关系。

LDS 可能引用 RDS；RDS 中的 route 又引用 cluster；cluster 再引用 endpoint，或者继续引用 aggregate cluster。任何一份资源单独拿出来，都可能是不完整的。

这正是 `XdsDependencyManager` 存在的原因：它不能让 LDS、RDS、CDS、EDS 各自独立回调 LB，而要先把资源引用组织成一个一致的 `XdsConfig`。

因此，ADS 到 LB 之间不是一条直线，中间还有资源依赖编排这一层。

### 失败方案三：route 在 resolver 阶段算一次，后续 RPC 都一样

如果 route 只在 resolver 更新时算一次，那么同一个 channel 上所有 RPC 都会走同一个 cluster。但 xDS 的设计并不是这样。

`InternalConfigSelector` 会参与每次 RPC 的选择：它可以根据方法路径、headers、权重、hash policy 等信息决定本次调用使用哪个 cluster，再把选择结果放进 CallOptions。

所以 xDS 客户端不是“解析时决定一次”，而是“控制面负责更新规则，每次 RPC 再根据规则裁一刀”。

## 四、最小总图：控制面资源如何变成数据面选择

先建立整篇文章的总图：

```
xds:///service
    ↓
XdsNameResolverProvider
    ↓
GrpcBootstrapperImpl / BootstrapInfo
    ↓
XdsClientImpl / ControlPlaneClient
    ↓
ADS 双向流：DiscoveryRequest ↔ DiscoveryResponse
    ↓
LDS → RDS → CDS → EDS 资源依赖
    ↓
XdsDependencyManager → XdsConfig
    ↓
XdsNameResolver
    ├─ ResolutionResult / service config
    └─ InternalConfigSelector
          ↓ 每次 RPC
      route / virtual host / weighted cluster
          ↓
      cluster_manager → cds → child LB
          ↓
      subchannel → transport
```

这张图里有三个关键转换：

1. **控制面协议 → 资源对象**：ADS 返回 protobuf resource，`XdsClientImpl` 和各 resource parser 把它们变成 grpc-java 对象。
2. **资源对象 → 调用配置**：`XdsDependencyManager` 把资源依赖拼成 `XdsConfig`，`XdsNameResolver` 把它变成 service config 和 ConfigSelector。
3. **调用配置 → 数据面路径**：每次 RPC 通过 ConfigSelector 选 cluster，`cluster_manager`/`cds` 再驱动 child LB，最终进入 subchannel/transport。

## 五、Bootstrap：客户端先要知道去哪里找控制面

### 5.1 `xds` scheme 只是入口，不是控制面连接

用户看到的 URI 是 `xds:///service`。`XdsNameResolverProvider` 注册 `xds` scheme，并根据 URI 创建 `XdsNameResolver`。

`XdsNameResolverProvider.java:37` — `xds` scheme provider
`XdsNameResolverProvider.java:80` — 创建 `XdsNameResolver`

但 provider 本身并不连接 control plane。它只是把一个 URI 交给真正的 resolver。真正的控制面连接信息来自 bootstrap。

### 5.2 bootstrap 决定什么

`GrpcBootstrapperImpl` 负责读取 bootstrap 配置。当前实现支持环境变量、系统属性和内嵌配置等来源，并按既定优先级选择最终配置。

`GrpcBootstrapperImpl.java:65` — bootstrap 环境变量 / 系统属性读取优先级

bootstrap 不是“一个服务器地址”那么简单。它通常还包含：

- xDS server 列表
- node 信息
- authority
- credential 配置
- certificate provider
- client/server listener resource name template

`Bootstrapper.java:32` — Bootstrap 抽象
`Bootstrapper.java:144` — server/node/authority 等模型

这一步的角色关系是：应用只给出 `xds:///service`，bootstrap 决定“控制面是谁、我以什么 node 身份去问它”。

## 六、XdsClient 与 ADS：控制面资源同步的底座

### 6.1 `XdsClient` 暴露的是 resource watch，不是“拉一份配置”

`XdsClient` 的抽象边界不是一个 `getConfig()` 方法，而是一组资源 watch API。它负责监听 LDS、RDS、CDS、EDS 等资源，并在资源发生变化、删除或出错时通知 watcher。

`XdsClient.java:44` — XdsClient 抽象边界与 resource watch API

这意味着 xDS 是持续同步，而不是启动时读取一次配置。控制面后续推送的新版本可能改变 route、cluster、endpoint，甚至让旧资源消失。

### 6.2 `XdsClientImpl`：把 watch 接到控制面连接

第一次 watch 某个资源时，`XdsClientImpl` 会创建 subscriber，选择或创建对应的 `ControlPlaneClient`，并调整该资源类型的订阅集合。

`XdsClientImpl.java:251` — 首次 watch 创建 subscriber / ControlPlaneClient

当 ADS response 到达时，`XdsClientImpl` 负责把 response 交给资源解析、处理 ACK/NACK、更新缓存，并通知对应 watcher。

`XdsClientImpl.java:559` — response 处理 / ACK-NACK 主链
`XdsClientImpl.java:1011` — watcher 通知 / 资源更新路径

### 6.3 `ControlPlaneClient`：ADS stream 的生命周期管理者

`ControlPlaneClient` 负责更底层的 ADS stream 生命周期：

- 维护各 resource type 的 version
- 维护 subscription 和 nonce
- 创建双向 ADS stream
- 发送 DiscoveryRequest
- 接收 DiscoveryResponse
- 处理 stream close、backoff、reconnect、fallback

`ControlPlaneClient.java:55` — coordinator 结构
`ControlPlaneClient.java:143` — version/nonce/subscription 管理

真正创建 Aggregated Discovery Service 双向流的是 `AdsStream`。

`ControlPlaneClient.java:333` — 创建 ADS stream
`ControlPlaneClient.java:371` — 发送 DiscoveryRequest
`ControlPlaneClient.java:424` — 处理 DiscoveryResponse
`ControlPlaneClient.java:475` — stream 关闭 / backoff / reconnect

从生产角度看，这一层最值得建立一条“配置为什么没生效”的故障链：

- **bootstrap 错了**：控制面 channel 根本连不上。  
- **ADS stream 没起来**：后面谈不上资源更新。  
- **response 解析失败或资源校验失败**：客户端会 NACK，而不是静默接受。  
- **nonce / version 继续推进但依赖资源不完整**：控制面“已经推送”，数据面仍未必能形成新配置。  
- **stream 关闭进入 backoff / fallback**：配置更新看起来像“停住了”，其实是控制面连接在重试。

也就是说，当线上看到“xDS 配置没有更新”时，不能只盯着 resolver。你要沿着 `bootstrap -> ADS stream -> ACK/NACK -> 依赖补齐 -> resolver 发布` 这条链逐层往回查，而不是一句“控制面没推过来”就结束。

## 七、资源依赖：为什么需要 `XdsDependencyManager`

### 7.1 LDS/RDS/CDS/EDS 不是四张平行表

xDS 资源更像一棵树，而不是四张互不相关的表：

```
LDS listener
  ├─ inline route config
  └─ RDS route_config_name
        ↓
      RDS route / virtual host
        ↓
      cluster name
        ↓
      CDS cluster
        ├─ EDS service_name
        ├─ logical DNS
        └─ aggregate cluster
              ↓
            child clusters
```

一个资源只有在它引用的下游资源也可用时，才可能形成完整的数据面配置。

### 7.2 从 LDS 启动依赖链

`XdsDependencyManager` 位于 XdsClient 和 NameResolver 之间。它维护不同资源类型的 watcher，并根据资源引用关系动态增加、删除或替换 watch。

`XdsDependencyManager.java:60` — 资源依赖管理器定位
`XdsDependencyManager.java:119` — 从 LDS 启动依赖链

当 listener 到达后，它可能要求继续 watch RDS；RDS 到达后，又可能引入一个或多个 CDS；CDS 到达后，再继续 watch EDS 或解析 aggregate cluster。

如果其中一个依赖缺失，`XdsDependencyManager` 不能简单地把半成品交给 LB，而要维持当前配置或报告资源错误。这一点对生产排障非常关键：控制面已经把 LDS 推过来了，不等于数据面就能立刻切换；如果 RDS 还没到，或者 CDS 指到的 cluster 还没完整，grpc-java 更可能继续保留上一版可用配置，而不是用半成品把数据面切坏。

这就是它和普通 resolver 最大的差异之一：它管理的不是“最新地址列表”，而是一张异步资源图的一致性。

### 7.3 `XdsConfig`：资源树的中间表示

当依赖资源已经足够完整时，管理器会构造 `XdsConfig`。这个对象不是控制面原始 proto 的简单包装，而是数据面真正需要的中间表示，包含 listener、route、active virtual host、cluster config、endpoint 或 aggregate cluster config。

`XdsConfig.java:35` — `XdsConfig` 定义
`XdsConfig.java:104` — listener/route/cluster 等配置内容

`XdsDependencyManager.java:192` — 根据资源依赖构造 `XdsConfig`

这个中间层很重要：它把“控制面资源怎么组织”与“grpc-java resolver/LB 怎么消费”隔离开。后续 resolver 不需要重新理解 LDS/RDS/CDS/EDS 的全部 proto 关系，只消费已经拼装好的 `XdsConfig`。

## 八、XdsNameResolver：它返回的不是地址，而是一套调用规则

### 8.1 resolver 如何消费 `XdsConfig`

普通 resolver 往往把地址列表放进 `ResolutionResult`。xDS resolver 的输出更复杂：它要把 cluster、LB policy、retry/timeout、route 选择器等信息转换成 grpc-java 能消费的 service config 和 selector。

`XdsNameResolver.java:314` — 生成 `cluster_manager_experimental` service config

这条 service config 会继续驱动 `cluster_manager`、CDS 和下游 child LB，而不是直接让 resolver 自己创建所有 subchannel。

### 8.2 每次 RPC 的 `InternalConfigSelector`

更关键的是，xDS 的 route 选择不是只发生在 resolver 刷新时。`XdsNameResolver` 会创建 `InternalConfigSelector`，每次 RPC 到来时，根据当前方法和调用元数据执行选择。

`XdsNameResolver.java:412` — per-RPC route / cluster 选择

一次选择可能包含：

- 根据 method/path 匹配 virtual host 和 route
- 根据权重选择 weighted cluster
- 计算 hash policy
- 更新 cluster 引用计数
- 把选中的 cluster 写入 CallOptions
- 注入 route filters 和 retry/timeout 配置

可以把它想成这样：同一个 `xds:///shopping` channel，下一个 `/cart.AddItem` 可能被路由到 cluster-A，而 `/checkout.Submit` 可能被路由到 cluster-B；即使是同一个方法，如果控制面刚把 weighted cluster 从 90/10 改成 50/50，后续 RPC 也会按照新规则重新选择。也就是说，变化的不只是“地址池”，而是“每次调用怎么被分类和送往哪个 cluster”。

这就是 xDS 为什么能支持灰度、按 header 路由、按权重分流和动态策略：控制面更新的是规则，每次 RPC 执行的是规则。

### 8.3 控制面更新如何影响后续调用

当新的 LDS/RDS/CDS/EDS 资源到达并形成新的 `XdsConfig` 后，resolver 会发布新的 resolution result/config selector。已经创建的 transport 不一定立刻被销毁，但后续 RPC 会看到新的路由规则，child LB 也会根据新配置调整 picker 和 subchannel。

因此生产上看到“控制面已经更新，但旧连接还在”并不矛盾：资源更新和连接生命周期不是同一个瞬间。路由规则可以先变，旧连接可能等 drain、idle、GOAWAY 或 LB 重算后才退出。

## 九、从 cluster_manager 到真实 transport

### 9.1 `cluster_manager`：按 RPC 选中的 cluster 继续往下走

xDS resolver 将 cluster 选择写进 CallOptions 后，`ClusterManagerLoadBalancer` 会读取这个 cluster 名称，在 child policy 中选择对应的 picker。

`ClusterManagerLoadBalancer.java:42` — cluster_manager LB 入口
`ClusterManagerLoadBalancer.java:140` — child picker / cluster 选择

这一步把“每次 RPC 的 cluster 选择”接到了 grpc-java 原本的 picker 主线。

### 9.2 `cds`：把 cluster resource 翻译成下游 LB

`CdsLoadBalancer2` 根据 CDS cluster 类型选择下游处理方式：EDS、aggregate cluster、priority 等都会被翻译成不同的 child LB 配置。

`CdsLoadBalancer2.java:76` — CDS LB 入口
`CdsLoadBalancer2.java:104` — cluster config → child LB config

到了这里，xDS 的资源已经被逐层转换成普通 grpc-java LB 可以处理的配置。再往下，就是我们在 ch01/04 和 ch05/02 讲过的 subchannel、picker、transport 状态机。

### 9.3 xDS 没有消灭普通 LB，只是给它动态喂配置

这是理解 grpc-java xDS 的关键收束：xDS 并没有另造一套完全独立的 transport。它把控制面资源转换成 service config、ConfigSelector 和 child LB 配置，最终仍然落入普通 grpc-java 的 subchannel/picker/transport 主线。

所以当 xDS 线上出现“选不到实例”“调用卡住”“状态 READY 但没发出去”时，排障仍然可以回到 ch05/02 的四问法，只是要在 picker 之前再加一层：**控制面下发的 route/cluster 规则是否已经形成了正确的 ConfigSelector 和 child LB。**

## 十、误解澄清

### 误解一：xDS 就是一个 resolver

不是。resolver 只是 xDS 客户端对接 grpc-java 主线的一个出口。真正的 xDS 客户端还负责 bootstrap、ADS、资源 watch、ACK/NACK、LDS/RDS/CDS/EDS 依赖、service config 和 per-RPC ConfigSelector。

### 误解二：ADS response 到了，配置就已经生效

不一定。response 还要经过资源校验、依赖补齐、`XdsConfig` 构造、resolver 发布和 child LB 更新。任何一个环节失败，控制面“收到了”不等于数据面“已经用了”。

### 误解三：xDS 选路只在 resolver 刷新时发生

不是。resolver 负责发布规则，但 `InternalConfigSelector` 会参与每次 RPC 的 route/cluster 选择。控制面更新规则，数据面每次调用执行规则。

### 误解四：ADS response 到了，配置就一定已经生效

不一定。response 到达只是第一步。后面还要经过资源校验、依赖补齐、`XdsConfig` 构造、resolver 发布，以及 child LB 的更新。任何一个环节卡住，都可能造成“控制面明明推过了，数据面却还没变”。

### 误解五：看不到新 picker / 新 subchannel，一定是 transport 故障

也不一定。很可能控制面配置已经收到了，但依赖资源还没补齐，或者 ConfigSelector 已更新而 child LB 还没完成切换。xDS 客户端问题经常发生在 transport 之前，所以排障不能一上来就盯着 socket 和 Netty。 

## 十一、收网总结：xDS 是持续重写调用主线的控制面

回到开头的困惑：为什么 `xds:///service` 不只是解析成地址？

因为 grpc-java xDS 客户端根本不是一个“高级版 DNS”。它做的是一条持续运行的翻译链：

- bootstrap 决定控制面和 node 身份
- ADS 持续同步 LDS/RDS/CDS/EDS
- `XdsDependencyManager` 把资源引用拼成一致的 `XdsConfig`
- `XdsNameResolver` 把它翻译成 service config 和 `InternalConfigSelector`
- 每次 RPC 再根据 route/cluster 规则做选择
- `cluster_manager` / `cds` / child LB 最后落回普通 subchannel/picker/transport

**三句话总结：**

1. xDS 客户端不是更胖的 resolver，而是控制面到数据面的持续翻译器。
2. LDS/RDS/CDS/EDS 不是平行配置表，而是一棵需要依赖编排的资源树，`XdsDependencyManager` 和 `XdsConfig` 是其中的关键接缝。
3. xDS 最终没有替代 grpc-java 原有的 resolver/LB/transport 主线，而是动态重写它；因此理解 xDS 的最好方式，是沿着“控制面资源如何变成每次 RPC 的 picker 选择”一路追下去。

**下篇预告：** 下一篇进入 xDS 服务端篇，讲 `XdsServerBuilder`、动态 Listener、Filter Chain、TLS 与服务端路由如何被控制面重写。