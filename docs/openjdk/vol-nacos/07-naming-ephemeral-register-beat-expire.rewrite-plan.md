# Nacos：naming ephemeral path——register / beat / unhealthy / expire / cleanup — rewrite plan

## 篇章定位

- 写作卷：`vol-nacos`
- 章节：`ch03-naming`
- 篇：`07 Nacos：naming ephemeral path——register / beat / unhealthy / expire / cleanup`
- 对应主题：`N-07 naming ephemeral`
- 文章类型：注册与心跳主线篇
- 正文状态：未开始
- 分析对象：`Nacos 3.0.3` naming v2

## 文章定位

- 核心困惑：上一篇已经讲清 naming v2 的静态对象图，但真实线上最常见的问题不是对象图，而是：实例到底怎么注册上去、为什么 beat 丢了实例会先不健康再消失、为什么有时一个 beat 竟然还能把实例“补注册”回来、为什么实例明明是 ephemeral，却又会看到 metadata 走了 CP 通道。问题不是“有没有心跳”，而是：**ephemeral path 到底怎样把 HTTP/gRPC 请求落到 client-owned publish state、再怎样通过 event/index/read-model 映射成可见服务视图，并在 heartbeat 缺失时收敛到 unhealthy / expire / client release。**
- 一句话顿悟：Nacos 3.0.3 的 ephemeral path 不是“把 instance 挂到 service 上然后等心跳续租”，而是**先把实例挂到 client 的 `publishers` 上，再通过 `ClientRegisterServiceEvent -> ClientServiceIndexesManager -> ServiceStorage` 投影出 service 视图；heartbeat 刷新的不是 service TTL，而是 `HealthCheckInstancePublishInfo.lastHeartBeatTime`，随后由 unhealthy checker、expired checker、client manager cleanup 三层机制逐步收敛。**
- 文章边界：本篇重点讲 ephemeral register/deregister/beat/unhealthy/expire/client cleanup 主线，以及 metadata overlay 与 CP metadata 写入的混合边界；不深讲 persistent path、push/subscriber 通知链、Distro 跨节点同步细节。

## 前置依赖

### HARD

- `06-naming-domain-model-service-client-metadata.md`
- `03-remote-grpc-request-handler-connection-auth.md`

### SOFT

- 对“租约/心跳/过期清理”有直觉会有帮助，但不是前提。

### NAV

- 后续可接：persistent path、subscriber/push path、Distro 同步篇。

## 一句话困惑

ephemeral 实例到底是怎么注册、续命、变不健康、过期删除，并最终从 service 视图里消失的？

## 一句话顿悟

ephemeral 实例不是直接住在 service 下，而是先住在 client 的 `publishers` 里；可见 service 视图则是通过 indexes 和 `ServiceStorage` 反投影出来的。beat 刷新的不是 service TTL，而是 instance heartbeat time，后续再由 unhealthy / expire / client release 三层机制收敛。

## 读者理解路径

1. 先否定“service 直接挂 instance”“heartbeat 只是简单续租”这两个朴素模型。
2. 先走 register 入口：HTTP v2/v3 与 gRPC 分叉，但都收敛到 `ClientOperationService`。
3. 解释 client ownership、service canonicalization、publish info 落点。
4. 解释 event/index/read-model 是怎样把 client-owned state 投影成 service 视图的。
5. 解释 beat、light beat、补注册语义。
6. 解释 unhealthy / expired / client cleanup 三层收敛链。
7. 解释 metadata 为什么是 sidecar，并且为什么更新走 CP 通道。
8. 收束到：ephemeral path 是 AP 主线 + metadata CP sidecar 的混合模型。

## 失败方案推演

### 失败方案一：ephemeral 注册就是“向 service 添加一个 instance”

- 真正 mutation 的对象是 client 的 `publishers`。
- service 视图是后续投影出来的，不是直接在 service 对象里 append。
- 所以写路径与读路径分离，是 naming v2 最重要的事实。

### 失败方案二：heartbeat 只是续租，不会改变注册状态

- heartbeat 丢失先导致 unhealthy，再导致真正删除。
- 带完整 beat 内容的请求在某些条件下还会触发补注册。
- 所以 beat 不只是“续一口气”，而是会驱动注册状态机变化。

### 失败方案三：ephemeral 数据完全不碰 CP/一致性层

- 实例本体是 AP / client-owned。
- 但 instance metadata 更新走 `CPProtocol.write(...)`，再由读路径 overlay 回来。
- 所以 ephemeral 主线与 metadata sidecar 之间是“AP + CP 混合模型”。

### 失败方案四：client 就等于一个连接

- HTTP 路径生成的是 `ip:port#true` 这种 `IpPortBasedClient`。
- gRPC 路径则更自然地使用 connectionId。
- “ephemeral”说的是实例/服务语义，不等于“client 必然是 connection-based”。

## 必须澄清的误解

1. ephemeral 实例不直接挂在 service 下，而是挂在 client 的 `publishers` 上。
2. beat 刷新的不是 service TTL，而是 publishInfo 的 heartbeat time。
3. unhealthy 与 expired 不是同一件事，而是两阶段收敛。
4. client cleanup 和 instance expiry 不是同一条清理线。
5. ephemeral 主体是 AP 内存链，但 metadata sidecar 可走 CP 通道。

## 文章结构与字数预算

1. 困惑开场：为什么“service 挂 instance + 心跳续租”会写歪（800-1000 字）
2. 总图：HTTP/gRPC register -> client publishers -> indexes -> ServiceStorage（1200-1600 字）
3. register path：HTTP v2/v3 与 gRPC 收敛（1600-2200 字）
4. 写路径落点：`ClientOperationServiceProxy` / `EphemeralClientOperationServiceImpl`（1600-2200 字）
5. event/index/read-model 投影（1400-2000 字）
6. beat/light beat/补注册（1400-2000 字）
7. unhealthy / expire / client release 三层收敛（1800-2400 字）
8. metadata sidecar 与 CP 写入边界（1000-1400 字）
9. 收网总结（600-800 字）

目标叙述性正文：`10000-13000` 字；代码块不计入目标。

## 证据清单

- `naming/controllers/v3/InstanceControllerV3.java:100` — HTTP v3 register entry
- `naming/controllers/v2/InstanceControllerV2.java:381` — beat entry
- `naming/remote/rpc/handler/InstanceRequestHandler.java:58` — gRPC register path
- `naming/core/InstanceOperatorClientImpl.java:106` — register façade
- `naming/core/InstanceOperatorClientImpl.java:110` — HTTP clientId = ip:port#ephemeral
- `naming/core/InstanceOperatorClientImpl.java:231` — beat handling
- `naming/core/v2/service/ClientOperationServiceProxy.java:55` — ephemeral/persistent dispatch
- `naming/core/v2/service/impl/EphemeralClientOperationServiceImpl.java:56` — canonicalization + register
- `naming/core/v2/client/AbstractClient.java:72` — addServiceInstance
- `naming/core/v2/index/ClientServiceIndexesManager.java:117` — index update on register
- `naming/core/v2/index/ServiceStorage.java:106` — read model materialization
- `naming/healthcheck/HealthCheckReactor.java:36` — heartbeat reactor
- `naming/healthcheck/heartbeat/ClientBeatProcessorV2.java:60` — beat processor
- `naming/healthcheck/heartbeat/ClientBeatCheckTaskV2.java:67` — periodic beat check
- `naming/healthcheck/heartbeat/UnhealthyInstanceChecker.java:49` — unhealthy phase
- `naming/healthcheck/heartbeat/ExpiredInstanceChecker.java:52` — expire/delete phase
- `naming/core/v2/client/manager/impl/EphemeralIpPortClientManager.java:63` — client cleanup
- `naming/core/v2/metadata/NamingMetadataOperateService.java:85` — metadata CP write path
- `naming/core/v2/metadata/InstanceMetadataProcessor.java:107` — metadata apply path
- `naming/core/v2/index/ServiceStorage.java:155` — metadata overlay on read path

## 测试与辅助证据

- `naming/core/InstanceOperatorClientImplTest.java:128`
- `naming/core/v2/service/impl/EphemeralClientOperationServiceImplTest.java:113`
- `naming/healthcheck/heartbeat/ClientBeatCheckTaskV2Test.java:99`
- `naming/core/v2/client/manager/impl/EphemeralIpPortClientManagerTest.java:105`
- `test/naming-test/.../ClientBeatNamingITCase.java:67`

## 版本边界

- 当前分析对象固定为 `Nacos 3.0.3` naming v2 ephemeral path。
- 不深讲 persistent 实例 CP 路径。
- 不深讲 push/subscriber 通知链。
- 不深讲 Distro 跨节点同步与 verify 细节。

## 与后续篇章的边界

### 本篇要讲清

- ephemeral register/beat/unhealthy/expire/client cleanup 主线。
- client-owned state 如何投影成 service 视图。
- AP instance body 与 CP metadata sidecar 的边界。

### 本篇不深讲

- persistent client operation
- push/subscriber delivery
- Distro / verify / revision 跨节点同步

## 写作后检查

- [ ] 开篇先抓“service 不直接挂 instance、beat 不只是续租”，而不是直接列处理器类名。
- [ ] 至少展开 4 个失败方案，且包含“ephemeral 完全不碰 CP”“client 就等于连接”。
- [ ] 明确给出 register -> client-owned state -> indexes -> read model 总图。
- [ ] 清楚拆开 unhealthy / expire / client release 三层收敛链。
- [ ] 每个关键结论落到 file:line。
- [ ] 删除代码块后，读者仍能复述 AP 主体 + CP metadata sidecar 的关系。
- [ ] 通过一次性深审收口。
