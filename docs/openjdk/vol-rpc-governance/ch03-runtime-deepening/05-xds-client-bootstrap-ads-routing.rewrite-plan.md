# grpc-java：xDS 客户端 — 从 Bootstrap/ADS 到动态路由与负载均衡 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch03-runtime-deepening`
- 篇：`05 xDS 客户端：从 Bootstrap/ADS 到动态路由与负载均衡`
- 对应主题：`G-DEEP-6 xDS`
- 文章类型：高阶机制补深篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：前面的 resolver / LB / transport 主线已经说明一次普通 gRPC 调用怎样从目标名走到 subchannel，再落到 transport。但一旦引入 xDS，这条链会被彻底重写：目标名不再只解析成地址，控制面会动态下发 listener、route、cluster、endpoint 和 LB policy，甚至每次 RPC 的 cluster 选择都可能变化。读者真正困惑的是：grpc-java 的 xDS 客户端到底在哪些节点改写了原有主线？Bootstrap、ADS、LDS/RDS/CDS/EDS、ConfigSelector、cluster_manager 这些名字之间是什么关系？
- 一句话顿悟：grpc-java 的 xDS 客户端本质上是在 `xds:///target` 上插入了一条“控制面到数据面”的配置链：bootstrap 决定去连谁，`XdsClientImpl`/`ControlPlaneClient` 通过 ADS 持续同步 LDS/RDS/CDS/EDS，`XdsDependencyManager` 把这些资源组织成 `XdsConfig`，`XdsNameResolver` 再把它翻译成 gRPC 的 service config、`InternalConfigSelector` 和 cluster 选择逻辑，最后交给 `cluster_manager`/`cds`/child LB 去驱动真实 subchannel 和 transport。xDS 不是“更聪明的 resolver”，而是一层持续重写 resolver/LB/router 的控制面。
- 文章边界：本篇只讲 grpc-java xDS 客户端主链路：`XdsNameResolverProvider`、`GrpcBootstrapperImpl`、`XdsClientImpl`、`ControlPlaneClient`、`XdsDependencyManager`、LDS/RDS/CDS/EDS、`XdsConfig`、`InternalConfigSelector`、`ClusterManagerLoadBalancer`、`CdsLoadBalancer2` 这些环节如何串起来；不展开 xDS 服务端的 `XdsServerWrapper` / filter chain / TLS，不展开每个 child LB（ring hash、locality、outlier detection）的算法细节。

## 前置依赖

### HARD

- `ch01/04-nameresolver-loadbalancer-netty-transport.md`：已经知道普通 resolver/LB/transport 主线。
- `ch03/01-service-config-retry-hedging.md`：已经知道 service config 如何进入调用运行时。
- `ch05/02-channel-subchannel-picker-diagnosis.md`：已经知道 picker / subchannel / transport 的状态诊断方式。

### SOFT

- 不要求先懂 Envoy xDS 规范的全部细节。
- 不要求先懂 xDS 服务端实现。

### NAV

- 后续可接：`xDS 服务端：动态 Listener、Filter Chain 与 TLS 路由切换`。
- 后续可接：filters/security/RBAC/fault injection 等专题。

## 一句话困惑

为什么一个 `xds:///service` 目标在 grpc-java 里不只是“解析成地址”，而是会动态改写 route、cluster、LB policy，甚至每次 RPC 的 cluster 选择？Bootstrap、ADS、LDS/RDS/CDS/EDS、ConfigSelector 和 cluster_manager 到底谁先谁后？

## 一句话顿悟

xDS 客户端真正做的事情不是“返回一批地址”，而是“把控制面下发的一整棵资源树翻译成 grpc-java 自己的调用与负载均衡模型”：bootstrap 选控制面、ADS 同步资源、`XdsDependencyManager` 组装依赖、`XdsNameResolver` 生成 service config 和 `InternalConfigSelector`，每次 RPC 再通过 route/cluster 选择落到 child LB 和真实 transport。

## 读者理解路径

1. 先否定“xDS 就是高级一点的 service discovery”这种理解。
2. 建立最小总图：`xds URI -> bootstrap -> XdsClient/ADS -> LDS/RDS/CDS/EDS -> XdsConfig -> ConfigSelector -> cluster_manager/CDS -> child LB -> transport`。
3. 解释 bootstrap：grpc-java 怎么决定去连哪个 control plane、用什么 node/authority。
4. 解释 `XdsClientImpl` / `ControlPlaneClient`：控制面 channel、ADS stream、ACK/NACK、resource watch。
5. 解释 `XdsDependencyManager`：为什么 grpc-java 需要一个“资源依赖管理器”把 LDS/RDS/CDS/EDS 组织成 `XdsConfig`。
6. 解释 `XdsNameResolver`：为什么它不直接返回地址，而是生成 `InternalConfigSelector` 和 service config。
7. 解释每次 RPC 如何经过 route 匹配、virtual host、weighted cluster、cluster 选择，再把结果塞进 CallOptions。
8. 解释 `cluster_manager` / `cds` / child LB 怎样继续把 cluster 选择落到真实 subchannel/transport。
9. 收束到：xDS 客户端不是一个更胖的 resolver，而是一条持续重写 resolver/LB/router 的控制面主链。

## 失败方案推演

### 失败方案一：xDS 就是高级版名字解析，最后还是只返回地址

- 这会错过 xDS 最关键的区别：resolver 末端不再只是地址列表，而是 route、cluster、LB policy 和每次 RPC 的 cluster 选择。
- `XdsNameResolver` 最终生成的是 service config、`InternalConfigSelector` 和 `cluster_manager` 风格的 LB 配置，不是一个简单地址列表。
- 所以 xDS 不是“更聪明的 DNS”，而是“控制面动态重写调用路径”。

### 失败方案二：ADS 收到资源后，grpc-java 直接交给 LB 就够了

- 这会漏掉资源依赖的层次：LDS 可能引用 RDS，RDS 里的 route 又引用 cluster，cluster 再引用 endpoint 或 aggregate cluster。
- `XdsDependencyManager` 的存在，正是因为 grpc-java 不能把每份资源孤立处理，它必须把资源树先拼成一个一致的 `XdsConfig` 视图。
- 所以 ADS -> LB 之间不是直接连线，中间还有依赖编排这一层。

### 失败方案三：xDS route 只是某次解析时算一次，后续 RPC 都一样

- 这会忽略 `InternalConfigSelector` 的作用。
- grpc-java 不是在 resolver 完成时就把某个 cluster 固化给整个 channel，而是每次 RPC 都经过 ConfigSelector 做 route/cluster 选择，可能根据 path、headers、hash policy、weighted cluster 选不同目标。
- 所以 xDS 客户端不是“解析时决定一次”，而是“每次 RPC 再裁一刀”。

## 必须澄清的误解

1. xDS 客户端不只是 resolver，它还动态改写 route、cluster、LB policy 与 per-RPC 选择。
2. `withSubchannel()` 这些最终 picker 行为仍然存在，但在 xDS 里它们前面多了一整层 route/cluster/control-plane 翻译。
3. LDS/RDS/CDS/EDS 不是并列平铺关系，而是一棵有依赖顺序的资源树。
4. `InternalConfigSelector` 不是附属小工具，而是 xDS 客户端按 RPC 做动态 route/cluster 选择的关键切口。
5. xDS 客户端与 xDS 服务端是两条独立主线，本篇只讲客户端。

## 文章结构与字数预算

1. 困惑开场：为什么 `xds:///service` 不只是解析成地址（800-1000 字）
2. 最小总图：bootstrap/ADS/resources/config selector/child LB 整链路（1000-1400 字）
3. bootstrap 与控制面 channel（1200-1800 字）
4. `XdsClientImpl` / `ControlPlaneClient`：ADS watch / ACK / NACK / fallback（1600-2200 字）
5. `XdsDependencyManager`：LDS/RDS/CDS/EDS 资源树如何被编排（1800-2400 字）
6. `XdsNameResolver` 与 `InternalConfigSelector`：每次 RPC 如何被动态选路（1800-2400 字）
7. `cluster_manager` / `cds` / child LB：控制面配置如何继续落到 subchannel/transport（1400-2000 字）
8. 收网总结：xDS 作为“持续重写 resolver/LB/router 的控制面”（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

### bootstrap / resolver 入口
- `xds/src/main/java/io/grpc/xds/XdsNameResolverProvider.java:37` — `xds` scheme provider
- `xds/src/main/java/io/grpc/xds/XdsNameResolverProvider.java:80` — 创建 `XdsNameResolver`
- `xds/src/main/java/io/grpc/xds/GrpcBootstrapperImpl.java:65` — bootstrap 环境变量 / 系统属性读取优先级
- `xds/src/main/java/io/grpc/xds/client/Bootstrapper.java:32` — Bootstrap 抽象与 `BootstrapInfo`
- `xds/src/main/java/io/grpc/xds/client/Bootstrapper.java:144` — authority / server / node 等模型

### xDS client / ADS
- `xds/src/main/java/io/grpc/xds/client/XdsClient.java:44` — XdsClient 抽象边界与资源 watch API
- `xds/src/main/java/io/grpc/xds/client/XdsClientImpl.java:251` — 首次 watch 创建 subscriber / ControlPlaneClient
- `xds/src/main/java/io/grpc/xds/client/XdsClientImpl.java:559` — 响应处理 / ACK-NACK 主链
- `xds/src/main/java/io/grpc/xds/client/XdsClientImpl.java:1011` — watcher 通知 / 资源更新路径
- `xds/src/main/java/io/grpc/xds/client/ControlPlaneClient.java:55` — control-plane client coordinator
- `xds/src/main/java/io/grpc/xds/client/ControlPlaneClient.java:143` — version/nonce/subscription 管理
- `xds/src/main/java/io/grpc/xds/client/ControlPlaneClient.java:333` — 创建 ADS stream
- `xds/src/main/java/io/grpc/xds/client/ControlPlaneClient.java:371` — 发送 DiscoveryRequest
- `xds/src/main/java/io/grpc/xds/client/ControlPlaneClient.java:424` — 处理 DiscoveryResponse
- `xds/src/main/java/io/grpc/xds/client/ControlPlaneClient.java:475` — stream 关闭 / backoff / reconnect

### resource dependency / resolver
- `xds/src/main/java/io/grpc/xds/XdsDependencyManager.java:60` — 资源依赖管理器定位
- `xds/src/main/java/io/grpc/xds/XdsDependencyManager.java:119` — 从 LDS 启动依赖链
- `xds/src/main/java/io/grpc/xds/XdsDependencyManager.java:192` — 构造 `XdsConfig`
- `xds/src/main/java/io/grpc/xds/XdsConfig.java:35` — `XdsConfig` 中间表示
- `xds/src/main/java/io/grpc/xds/XdsNameResolver.java:203` — resolver start，获取 XdsClient / listener resource name
- `xds/src/main/java/io/grpc/xds/XdsNameResolver.java:314` — 生成 `cluster_manager_experimental` service config
- `xds/src/main/java/io/grpc/xds/XdsNameResolver.java:412` — per-RPC route / cluster 选择逻辑（ConfigSelector）

### LB integration
- `xds/src/main/java/io/grpc/xds/XdsLbPolicies.java:19` — xDS LB policy 名称常量
- `xds/src/main/java/io/grpc/xds/ClusterManagerLoadBalancer.java:42` — cluster_manager LB 入口
- `xds/src/main/java/io/grpc/xds/ClusterManagerLoadBalancer.java:140` — child picker / cluster 选择
- `xds/src/main/java/io/grpc/xds/CdsLoadBalancer2.java:76` — CDS LB 入口
- `xds/src/main/java/io/grpc/xds/CdsLoadBalancer2.java:104` — cluster config -> child LB config

## 测试证据清单

- `xds/src/test/java/io/grpc/xds/XdsNameResolverTest.java` — xDS resolver + route/cluster 选择主线
- `xds/src/test/java/io/grpc/xds/XdsDependencyManagerTest.java` — LDS/RDS/CDS/EDS 依赖编排
- `xds/src/test/java/io/grpc/xds/client/XdsClientImplTest.java` — watch / ACK / NACK / fallback
- `xds/src/test/java/io/grpc/xds/client/ControlPlaneClientTest.java` — ADS stream 生命周期与重连
- `xds/src/test/java/io/grpc/xds/ClusterManagerLoadBalancerTest.java` — cluster_manager 分流
- `xds/src/test/java/io/grpc/xds/CdsLoadBalancer2Test.java` — CDS -> child LB 路径

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇只讲 xDS 客户端主链路，不展开 xDS 服务端。
- 本篇只在需要时点明 filter/security/locality/ring-hash 的挂载位置，不展开具体算法或安全实现。
- 本篇不把 VHDS 作为当前实现中的独立完整主线来展开。

## 与其他篇的边界

### 本篇要讲清

- xDS 客户端如何从 bootstrap 走到 ADS，再走到 route/cluster/LB 配置。
- `XdsDependencyManager` 和 `XdsConfig` 为什么是客户端主链路的关键接缝。
- `XdsNameResolver` / `InternalConfigSelector` 如何按 RPC 动态选路。
- `cluster_manager` / `cds` / child LB 如何继续落到 transport。

### 本篇不深讲

- xDS 服务端 `XdsServerWrapper` / filter chain / TLS。
- RBAC / ext_authz / ext_proc / fault injection 具体实现。
- ORCA / LRS / outlier detection 等进阶专题的内部算法。

## 写作后检查

- [ ] 开篇先抓“xds 不只是解析成地址”，而不是直接讲 bootstrap。
- [ ] 至少展开 3 个失败方案，且包含“xDS=高级版名字解析”“ADS 到 LB 可直接连线”。
- [ ] 明确给出控制面到数据面的完整总图。
- [ ] 不把本篇写成 xds 目录导览。
- [ ] 每个关键 coordinator 都先讲它在整条链里的职责，再给 file:line。
- [ ] 删除代码块后，读者仍能复述 bootstrap → ADS → 资源树 → ConfigSelector → child LB 这条链。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。