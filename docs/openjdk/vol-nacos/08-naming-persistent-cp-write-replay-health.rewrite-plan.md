# Nacos：naming persistent path——CP write / replay / health / read model — rewrite plan

## 篇章定位

- 写作卷：`vol-nacos`
- 章节：`ch03-naming`
- 篇：`08 Nacos：naming persistent path——CP write / replay / health / read model`
- 对应主题：`N-08 naming persistent`
- 文章类型：持久实例主线篇
- 正文状态：未开始
- 分析对象：`Nacos 3.0.3` naming v2

## 文章定位

- 核心困惑：很多人会把 persistent path 理解成“ephemeral 去掉心跳就行”，或者“service 直接被写进 Raft”。真实源码并不是这样：persistent path 同样维持 client-owned publish state，但写入入口会先进入 `CPProtocol.write(...)`，随后通过 `JRaftProtocol/JRaftServer/NacosStateMachine` 的 apply 流把状态重放回内存；健康状态变化也不是本地直接改，而是会重新走一遍 update/CP write 链。问题不是“是不是持久化了”，而是：**persistent path 到底怎样从 HTTP/gRPC 入口一路进入 CP write、再回到运行时 client/index/read model，为什么它和 ephemeral 的差别是 ownership 相同、mutation 语义完全不同。**
- 一句话顿悟：Nacos naming persistent path 不是“service 直接住在 Raft 里”，而是**persistent `IpPortBasedClient(false)` 仍然拥有 publish state，但所有 register/deregister/update/health 状态改变都先被序列化成 CP write log，再由 apply/replay 重新落回 client state；读路径仍然通过 indexes 和 `ServiceStorage` 反投影。**
- 文章边界：本篇重点讲 persistent register/deregister/update/health/read path、CP write/replay 事实、persistent client 语义、snapshot/replay 在 naming 视角的意义，以及和 ephemeral 的关键差异；不深讲完整 JRaft 实现细节，不深讲 push/subscriber，不深讲通用 AP/CP 理论。

## 前置依赖

### HARD

- `06-naming-domain-model-service-client-metadata.md`
- `07-naming-ephemeral-register-beat-expire.md`
- `04-cluster-membership-server-to-server-coordination.md`

### SOFT

- 对“日志提交 -> 状态机 apply”有直觉会有帮助，但不是前提。

### NAV

- 后续可接：subscriber/push、consistency deep-dive、diagnostics。

## 一句话困惑

persistent 实例到底是“直接写进 Raft 的 service 记录”，还是“另一条通过 CP 驱动的 client-owned 状态链”？

## 一句话顿悟

persistent path 仍然是 client-owned publish state，只是所有状态突变都先变成 `CPProtocol.write(...)`，再由 Raft apply/replay 落回 client/index/read-model；所以它不是“另一套对象模型”，而是“同一对象模型上的 CP mutation path”。

## 读者理解路径

1. 先否定“persistent = ephemeral 去掉心跳”“service 直接住在 Raft 里”两个直觉。
2. 建立 HTTP/gRPC persistent 注册入口。
3. 解释 `ClientOperationServiceProxy -> PersistentClientOperationServiceImpl` 分流。
4. 解释 `CPProtocol.write -> JRaftProtocol -> JRaftServer -> NacosStateMachine -> onApply` 链。
5. 解释 apply 后为什么仍然是 client-owned state。
6. 解释 read path 为什么仍然走 `ServiceStorage`，而不是 direct raft read。
7. 解释 persistent health 为什么也要重走 CP update。
8. 解释 snapshot/replay 对 naming 视角意味着什么。

## 失败方案推演

### 失败方案一：persistent path 就是 ephemeral 去掉心跳

- persistent path 有独立 handler、独立 service impl、独立 CP group、独立 apply/replay 链。
- 它不是少了一条心跳线，而是多了一整条 CP mutation path。

### 失败方案二：persistent 注册就是把实例直接写进 service

- apply 之后真正的 mutation 点仍然是 persistent client 的 `publishers`。
- service 视图仍然要通过 indexes + `ServiceStorage` 反投影。

### 失败方案三：persistent 读请求直接从 Raft 读

- naming 读路径仍然通过 `ServiceStorage` 从内存态 client/index/materialized read model 取数据。
- Raft 是 mutation/replay authority，不是 naming query 的直接响应引擎。

### 失败方案四：persistent 实例健康变化可以像 ephemeral 一样本地直接改

- persistent 健康变化也会回到 update -> CP write 路径。
- 这说明 persistent 的“健康状态”同样属于一致性控制的写路径。

## 必须澄清的误解

1. persistent 不是 ephemeral minus heartbeat。
2. persistent 状态写入后仍然落回 client-owned state，而不是 service 树。
3. 读路径仍然是 `ServiceStorage` materialize，不是 direct raft read。
4. persistent health 变化同样要走 CP update。
5. metadata sidecar 仍然独立于 publish body，并不是 persistent 就合并成一个日志对象。

## 文章结构与字数预算

1. 困惑开场：为什么“ephemeral 去掉心跳”会写错 persistent（800-1000 字）
2. 总图：HTTP/gRPC -> proxy -> persistent service -> CP write -> apply -> client/index/read model（1200-1600 字）
3. persistent register/deregister 入口（1400-2000 字）
4. CP write / apply / replay 链（1800-2600 字）
5. apply 后的真实 mutation 点：persistent client publishers（1200-1800 字）
6. read model：为什么仍然是 `ServiceStorage`（1200-1800 字）
7. persistent health update 也走 CP（1200-1800 字）
8. snapshot/replay 在 naming 视角的意义（1000-1400 字）
9. 与 ephemeral / consistency / push 的边界（800-1200 字）
10. 收网总结（600-800 字）

目标叙述性正文：`10000-13000` 字；代码块不计入目标。

## 证据清单

- `naming/controllers/v3/InstanceControllerV3.java:100` — HTTP persistent register entry
- `naming/remote/rpc/handler/PersistentInstanceRequestHandler.java:60` — gRPC persistent register entry
- `naming/core/InstanceOperatorClientImpl.java:109` — persistent HTTP clientId/service build
- `naming/core/v2/service/ClientOperationServiceProxy.java:55` — ephemeral/persistent split
- `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:99` — register self as CP processor
- `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:106` — persistent register chain
- `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:117` — CP write log build
- `core/distributed/raft/JRaftProtocol.java:178` — protocol write
- `core/distributed/raft/JRaftServer.java:230` — multi raft group create
- `core/distributed/raft/NacosStateMachine.java:121` — apply to processor
- `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:231` — onApply register mutation
- `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:245` — onApply deregister mutation
- `naming/core/v2/index/ServiceStorage.java:109` — read model still via storage
- `naming/remote/rpc/handler/ServiceQueryRequestHandler.java:66` — query path uses ServiceStorage
- `naming/healthcheck/v2/PersistentHealthStatusSynchronizer.java:46` — health change back into update path
- `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:316` — snapshot
- `naming/core/v2/metadata/NamingMetadataOperateService.java:85` — metadata CP sidecar path
- `naming/core/InstanceOperatorClientImpl.java:140` — admin metadata update path

## 测试与辅助证据

- `naming/core/v2/service/impl/PersistentClientOperationServiceImplTest.java:114`
- `naming/core/v2/service/impl/PersistentClientOperationServiceImplTest.java:156`
- `naming/core/v2/service/ClientOperationServiceProxyTest.java:95`
- `naming/remote/rpc/handler/PersistentInstanceRequestHandlerTest.java:50`
- `naming/healthcheck/v2/PersistentHealthStatusSynchronizerTest.java:42`
- `naming/core/ServiceOperatorV2ImplTest.java:107`
- `naming/core/InstanceOperatorClientImplTest.java:159`

## 版本边界

- 当前分析对象固定为 `Nacos 3.0.3` naming persistent path。
- 不深讲完整 JRaft transport / leader election / route table。
- 不深讲 push/subscriber delivery。
- 不深讲 general AP/CP theory beyond naming path needs。

## 与后续篇章的边界

### 本篇要讲清

- persistent register/deregister/update 的 CP 路径。
- apply 后如何回到 client-owned state。
- 读路径仍然为什么走 `ServiceStorage`。
- persistent health update 与 snapshot/replay 在 naming 视角的意义。

### 本篇不深讲

- JRaft 内部实现细节
- push/subscriber 通知链
- 通用 consistency 理论总结

## 写作后检查

- [ ] 开篇先抓“persistent 不是 ephemeral minus heartbeat”，而不是直接列 CP 类。
- [ ] 至少展开 4 个失败方案，且包含“service 直接住在 Raft 里”“persistent 读直接从 Raft 读”。
- [ ] 明确给出 `entry -> CP write -> apply -> client state -> read model` 总图。
- [ ] 清楚对比 persistent 与 ephemeral 在 ownership 相同、mutation 语义不同的事实。
- [ ] 每个关键结论落到 file:line。
- [ ] 删除代码块后，读者仍能复述 persistent path 的真正写入和读出链。
- [ ] 通过一次性深审收口。
