# grpc-java xDS 服务端：动态 Listener、Filter Chain、TLS 与路由切换 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `XdsServerBuilder` 不是另起一套 server runtime，而是包装普通 Netty server，并创建 `FilterChainSelectorManager` 与 `XdsServerWrapper`，证据：`xds/src/main/java/io/grpc/xds/XdsServerBuilder.java:44`、`:109`、`:120`。
2. `XdsServerWrapper.start()`/`internalStart()` 会读取 bootstrap、获取 XdsClient、解析 listener resource name 并创建 `DiscoveryState`，证据：`xds/src/main/java/io/grpc/xds/XdsServerWrapper.java:175`、`:197`。
3. `DiscoveryState` 从 LDS 启动服务端资源同步主链，根据 listener 决定 RDS 和 filter chain 依赖，证据：`XdsServerWrapper.java:377`、`:405`、`:455`。
4. 当依赖资源完整时，wrapper 会构造新的 selector 并原子替换当前 selector，证据：`XdsServerWrapper.java:526`。
5. `FilterChainSelectorManager` 负责 selector 生命周期与旧连接处理，证据：`xds/src/main/java/io/grpc/xds/FilterChainSelectorManager.java:27`、`:61`。
6. `XdsListenerResource` 明确区分 client-side listener 和 server-side listener，服务端分支负责解析 TCP listener 和 filter chains，证据：`xds/src/main/java/io/grpc/xds/XdsListenerResource.java:103`、`:133`、`:145`。
7. `FilterChainMatchingProtocolNegotiators` 在 Netty protocol negotiation 阶段选择 filter chain 和 TLS，说明连接级选择早于请求级 routing，证据：`xds/src/main/java/io/grpc/xds/FilterChainMatchingProtocolNegotiators.java:68`、`:98`。
8. `ConfigApplyingInterceptor` 在请求进入服务端后根据已选配置做 routing 匹配，证据：`XdsServerWrapper.java:876`。
9. `TlsContextManagerImpl` 管理 client/server TLS provider 和引用计数生命周期，证据：`xds/src/main/java/io/grpc/xds/internal/security/TlsContextManagerImpl.java:29`、`:59`。
10. selector 更新与旧连接 drain 是分离语义：新 selector 原子生效，新连接使用新配置，旧连接按原连接上下文继续存活直至 drain/终止，证据：`FilterChainSelectorManager.java:61`、`XdsServerWrapper.java:526`。

### 测试证据已核对

1. `XdsServerWrapperTest` 覆盖 wrapper 启动、LDS/RDS 依赖、selector 更新、错误恢复。
2. `FilterChainSelectorManagerTest` 覆盖 selector 生命周期与旧连接处理。
3. `FilterChainMatchingProtocolNegotiatorsTest` 覆盖 filter chain / TLS 匹配。
4. `XdsServerBuilderTest` 覆盖 builder 装配。
5. `XdsServerWrapperRoutingTest` 覆盖 server-side route matching。

### 深审发现

1. **高风险：容易把服务端 xDS 写成“客户端 xDS 的反向版”。** 当前正文已明确入站接入层与出站 resolver 的差异。  
2. **高风险：容易把配置热更新写成 handler 指针替换。** 当前正文已压回 selector 原子切换 + 旧连接 drain 的生命周期。  
3. **中风险：容易把 TLS/filter chain/routing 混成一层。** 当前正文已把连接级 negotiator 与请求级 interceptor 拆开。  
4. **中风险：容易忽略依赖不完整时的等待/恢复语义。** 当前正文已强调 LDS 到了不代表服务端立刻可接入。  
5. **低风险：容易把 `XdsServerWrapper` 看成 builder 的普通附属对象。** 当前正文已强调其运行时 coordinator 角色。  

## 第二轮：因果审

- 服务端 xDS 必须在协议协商阶段做 filter chain/TLS 选择，否则连接级匹配无法成立：✅  
- 配置更新不能直接替换 handler，否则旧连接的 TLS/filter chain 上下文会被中途破坏：✅  
- LDS/RDS 依赖必须等完整再形成 selector，否则服务端会用半成品接入链处理请求：✅  
- selector 必须原子切换且与旧连接 drain 解耦，否则新旧配置会在同一连接生命周期里混杂：✅  
- 请求级 routing 必须放在连接建立之后、ServerCall 之前，否则 authority/path/headers 信息不可用：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → 总图 → builder → wrapper/DiscoveryState → selector/filter chain → negotiator/TLS → 热更新/drain → 误解澄清 → 收网总结”推进，没有退化成服务端 xDS 类目录导览。

失败方案已覆盖：
- 服务端 xDS 是客户端 xDS 的反向 resolver  
- 收到新 LDS/RDS 后直接替换 handler  
- TLS、filter chain、routing 都放到同一层处理  

每一层拆解均包含：生命周期动机 → coordinator 边界 → file:line 证据，符合高阶机制篇要求。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- `XdsServerBuilder -> XdsServerWrapper -> DiscoveryState -> selector -> negotiator -> interceptor` 主链路  
- 服务端 xDS 为什么不是客户端 xDS 的镜像  
- 为什么配置热更新要走 selector 原子切换而不是替换 handler  
- TLS/filter chain 是连接级，routing 是请求级  
- 新 selector 与旧连接 drain 的生命周期关系  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未扩入 xDS 客户端 bootstrap/ADS/resolver/LB 主链。✅  
- 未展开 RBAC/ext_authz/ext_proc/fault injection 的内部算法。✅  
- 未展开 TLS 证书体系全景。✅  
- 未展开 Netty HTTP/2 协议帧细节。✅  
- 重点仍压在服务端 builder/wrapper/selector/negotiator/routing 主链，边界收得住。✅

## 第六轮：依赖审

- 已直接承接 xDS 客户端篇：控制面资源树与 XdsClient 已知，本篇补服务端接入链。✅  
- 已承接 ch01/02：普通服务端调用主线已知，本篇解释 xDS 如何重写它的入口。✅  
- 已承接 ch05/03：drain/GOAWAY/连接生命周期语义已知，本篇补 selector 热更新与旧连接退出。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：使用少量文字图，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验 `XdsServerBuilder`、`XdsServerWrapper`、`XdsListenerResource`、`FilterChainSelectorManager`、`FilterChainMatchingProtocolNegotiators`、`TlsContextManagerImpl`。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数（不含代码块与空白行）：约 `15,143`。  
- 目标定位：xDS 服务端高阶机制篇，篇幅与结构均满足要求。✅

## 结论

当前三件套的目标明确：这一篇应把 xDS 服务端从“动态配置普通 handler”提升到“动态 listener/filter chain/TLS/routing 的接入层生命周期管理器”，讲清 `XdsServerBuilder`、`XdsServerWrapper`、`DiscoveryState`、selector、negotiator 与旧连接 drain 如何共同完成服务端配置热更新。