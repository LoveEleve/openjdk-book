# grpc-java xDS 服务端：动态 Listener、Filter Chain、TLS 与路由切换 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch03-runtime-deepening`
- 篇：`06 xDS 服务端：动态 Listener、Filter Chain、TLS 与路由切换`
- 对应主题：`G-DEEP-6 xDS`
- 文章类型：高阶机制补深篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：xDS 客户端篇讲的是控制面如何动态改写 resolver、route、cluster 和 LB，但服务端为什么也需要一套独立的 xDS runtime？服务端收到 LDS/RDS 后，究竟是在修改什么？为什么不是简单替换一个 handler，而是要经过 filter chain、protocol negotiator、TLS context、selector 原子切换和旧连接 drain？
- 一句话顿悟：grpc-java xDS 服务端把“服务端如何接收连接并决定请求进入哪套处理链”交给控制面动态管理：`XdsServerBuilder` 包装普通 Netty server，`XdsServerWrapper` 通过 XdsClient watch LDS/RDS，`DiscoveryState` 将 listener/filter chain/routing 资源编排成 `FilterChainSelector`，Netty 协议协商阶段再根据连接属性选择 filter chain、TLS 和 server routing；配置更新不是简单替换 handler，而是新 selector 原子生效、旧连接按生命周期 drain。
- 文章边界：本篇重点讲 `XdsServerBuilder`、`XdsServerWrapper`、LDS/RDS、`FilterChainSelectorManager`、`FilterChainMatchingProtocolNegotiators`、动态 TLS 和 `ConfigApplyingInterceptor` 的服务端主链；不展开客户端 xDS（已在 05 篇）、RBAC/ext_authz/ext_proc/fault injection 的具体算法，不展开 Envoy 规范全量。

## 前置依赖

### HARD

- `ch03-runtime-deepening/05-xds-client-bootstrap-ads-routing.md`：已经知道 xDS client、ADS、资源 watch 和控制面资源树。
- `ch01/02-servercall-and-streaming-model.md`：已经知道普通 grpc-java 服务端如何从 transport 进入 ServerCall/handler。
- `ch05/03-keepalive-flowcontrol-connection.md`：已经知道 GOAWAY、drain、连接生命周期。

### SOFT

- 不要求先懂 Envoy filter chain 全量规范。
- 不要求先懂 TLS provider 的所有 credential 类型。

### NAV

- 后续可接：xDS filters/security/RBAC/fault injection 专题。
- 后续可接：Netty HTTP/2 protocol negotiation 专题。

## 一句话困惑

服务端收到 xDS 的 LDS/RDS 配置后，到底改变了什么？为什么必须通过 FilterChainSelector 和 Netty protocol negotiator，才能把动态 TLS、连接属性匹配、路由和旧连接 drain 安全地接进 grpc-java server？

## 一句话顿悟

xDS 服务端不是“动态替换一个 handler”，而是把 listener/filter chain/TLS/routing 组成一个可原子切换的选择器：`XdsServerWrapper` 负责资源依赖和 selector 构造，`FilterChainSelectorManager` 负责生命周期，Netty 协议协商阶段根据连接属性选择 filter chain 与 TLS，`ConfigApplyingInterceptor` 再在请求层做 route 匹配；新连接用新 selector，旧连接按 drain 规则结束。

## 读者理解路径

1. 先否定“服务端 xDS 就是客户端 xDS 的反向 resolver”这种理解。
2. 建立总图：`XdsServerBuilder → XdsServerWrapper → LDS/RDS → FilterChainSelector → Netty protocol negotiation → TLS/filter chain → request routing`。
3. 解释为什么 `XdsServerBuilder` 必须包装普通 Netty server，而不是另起一个 server runtime。
4. 解释 `XdsServerWrapper` / `DiscoveryState` 如何 watch listener、route 并等待依赖完整。
5. 解释 FilterChainSelector 的结构：连接级选择与请求级 routing 分层。
6. 解释协议协商阶段如何根据连接属性选择 filter chain、TLS 和 security context。
7. 解释 selector 热更新和旧连接 drain：新连接使用新配置，旧连接不强行瞬时切换。
8. 解释配置缺失、not-serving、delegate server 和错误恢复的服务端语义。
9. 收束到：xDS 服务端是动态接入层和生命周期管理器，不是普通 handler 配置器。

## 失败方案推演

### 失败方案一：服务端 xDS 就是把客户端 xDS 反过来

- 客户端 xDS 主要解决“客户端如何发现并选择目标”；服务端 xDS 解决“连接进来后应该匹配哪套 listener/filter chain/TLS/routing”。
- 服务端必须在协议协商阶段做连接属性匹配，这不是客户端 resolver 的镜像。
- 所以服务端 xDS 是动态接入层，而不是反向名字解析器。

### 失败方案二：收到新 LDS/RDS 后直接替换 handler

- 直接替换 handler 无法安全处理已经建立的连接，也无法保证同一连接上的协议协商上下文不被中途改变。
- grpc-java 选择构造新的 `FilterChainSelector`，原子替换当前 selector，让新连接使用新配置，旧连接按 drain 生命周期退出。
- 所以配置热更新的核心是 selector 生命周期，不是 handler 指针替换。

### 失败方案三：TLS、filter chain、routing 都放在同一层处理

- TLS 需要在 HTTP/2/gRPC 请求建立之前完成；filter chain 匹配依赖连接属性；routing 依赖请求的 authority/path/headers。
- 如果把它们混在请求 handler 里，TLS 太晚、连接级匹配无法完成、旧连接更新也无法控制。
- grpc-java 将连接级选择放在 protocol negotiator，将请求级 route 放在 `ConfigApplyingInterceptor`，形成两层边界。

## 必须澄清的误解

1. xDS 服务端不是客户端 xDS 的反向 resolver，而是动态 listener/filter chain 接入层。
2. LDS/RDS 更新不等于当前所有连接瞬时切换；新 selector 与旧连接 drain 是两个生命周期。
3. FilterChain 选择发生在请求 routing 之前，TLS 也发生在 gRPC handler 之前。
4. `XdsServerWrapper` 不是普通 ServerBuilder 的配置对象，而是服务端资源同步与 selector 生命周期 coordinator。
5. 配置缺失或 RDS 未到时，服务端不会用半成品 filter chain 随意接收请求。

## 文章结构与字数预算

1. 困惑开场：服务端 xDS 为什么不是动态替换 handler（800-1000 字）
2. 最小总图：builder/wrapper/resource/selector/negotiator/routing（1000-1400 字）
3. `XdsServerBuilder`：把 xDS 接入普通 Netty server（1200-1800 字）
4. `XdsServerWrapper` / `DiscoveryState`：LDS/RDS 资源依赖（1800-2400 字）
5. FilterChainSelector：连接级选择与请求级 routing 分层（1600-2200 字）
6. Protocol negotiator 与动态 TLS（1400-2000 字）
7. Selector 热更新、旧连接 drain 与错误恢复（1600-2200 字）
8. 常见服务端症状与误解澄清（1000-1400 字）
9. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

### builder / wrapper
- `xds/src/main/java/io/grpc/xds/XdsServerBuilder.java:44` — builder 结构
- `xds/src/main/java/io/grpc/xds/XdsServerBuilder.java:109` — 创建 `FilterChainSelectorManager`
- `xds/src/main/java/io/grpc/xds/XdsServerBuilder.java:120` — 创建 `XdsServerWrapper`
- `xds/src/main/java/io/grpc/xds/XdsServerWrapper.java:175` — wrapper start
- `xds/src/main/java/io/grpc/xds/XdsServerWrapper.java:197` — bootstrap / XdsClient / listener resource

### LDS/RDS / selector
- `xds/src/main/java/io/grpc/xds/XdsServerWrapper.java:377` — DiscoveryState watch LDS
- `xds/src/main/java/io/grpc/xds/XdsServerWrapper.java:405` — LDS response / RDS 依赖
- `xds/src/main/java/io/grpc/xds/XdsServerWrapper.java:455` — filter chain / RDS 等待
- `xds/src/main/java/io/grpc/xds/XdsServerWrapper.java:526` — 构造并原子替换 selector
- `xds/src/main/java/io/grpc/xds/FilterChainSelectorManager.java:27` — selector manager
- `xds/src/main/java/io/grpc/xds/FilterChainSelectorManager.java:61` — selector 生命周期

### filter chain / TLS / routing
- `xds/src/main/java/io/grpc/xds/XdsListenerResource.java:103` — client-side listener 分支
- `xds/src/main/java/io/grpc/xds/XdsListenerResource.java:133` — server-side listener 分支
- `xds/src/main/java/io/grpc/xds/XdsListenerResource.java:145` — server filter chain 解析
- `xds/src/main/java/io/grpc/xds/FilterChainMatchingProtocolNegotiators.java:68` — negotiator 接入
- `xds/src/main/java/io/grpc/xds/FilterChainMatchingProtocolNegotiators.java:98` — filter chain / TLS 选择
- `xds/src/main/java/io/grpc/xds/XdsServerWrapper.java:876` — `ConfigApplyingInterceptor` 请求路由
- `xds/src/main/java/io/grpc/xds/internal/security/TlsContextManagerImpl.java:29` — TLS context manager
- `xds/src/main/java/io/grpc/xds/internal/security/TlsContextManagerImpl.java:59` — provider / ref lifecycle

## 测试证据清单

- `xds/src/test/java/io/grpc/xds/XdsServerWrapperTest.java` — wrapper 启动、LDS/RDS、selector 更新、错误恢复
- `xds/src/test/java/io/grpc/xds/FilterChainSelectorManagerTest.java` — selector 生命周期与旧连接处理
- `xds/src/test/java/io/grpc/xds/FilterChainMatchingProtocolNegotiatorsTest.java` — filter chain / TLS 匹配
- `xds/src/test/java/io/grpc/xds/XdsServerBuilderTest.java` — builder 装配
- `xds/src/test/java/io/grpc/xds/XdsServerWrapperRoutingTest.java` — server-side route matching

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇只讲 xDS 服务端主链，不展开客户端 xDS。
- RBAC、ext_authz、ext_proc、fault injection、CEL matcher 只讲接入位置，不展开算法实现。
- TLS 只讲动态 provider/context 与 negotiator 接缝，不展开证书协议全景。

## 与其他篇的边界

### 本篇要讲清

- `XdsServerBuilder` 如何接入普通 Netty server。
- `XdsServerWrapper` / `DiscoveryState` 如何同步 LDS/RDS 并组织依赖。
- `FilterChainSelector` 如何把连接级匹配与请求级 routing 分层。
- protocol negotiator 如何接入动态 TLS/filter chain。
- selector 热更新、旧连接 drain 和错误恢复。

### 本篇不深讲

- xDS 客户端 bootstrap/ADS/resolver/LB（已在 05 篇）。
- RBAC/ext_authz/ext_proc/fault injection 的内部算法。
- TLS 证书体系全景。
- Netty HTTP/2 协议帧细节。

## 写作后检查

- [ ] 开篇先抓“动态替换 handler 为什么不够”，而不是直接讲 XdsServerBuilder。
- [ ] 至少展开 3 个失败方案，且包含“服务端 xDS 是客户端 xDS 反向版”“LDS/RDS 更新直接替换 handler”。
- [ ] 明确给出服务端 xDS 总图。
- [ ] 不把本篇写成服务端 xDS 类目录导览。
- [ ] 每个核心 coordinator 都先讲生命周期职责，再给 file:line。
- [ ] 删除代码块后，读者仍能复述 builder → wrapper → selector → negotiator → routing 链路。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。