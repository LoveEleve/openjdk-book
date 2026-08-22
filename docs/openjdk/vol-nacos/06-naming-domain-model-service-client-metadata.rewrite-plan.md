# Nacos：naming domain model——service / client / metadata / indexes — rewrite plan

## 篇章定位

- 写作卷：`vol-nacos`
- 章节：`ch03-naming`
- 篇：`06 Nacos：naming domain model——service / client / metadata / indexes`
- 对应主题：`N-06 naming model`
- 文章类型：领域模型总图篇
- 正文状态：未开始
- 分析对象：`Nacos 3.0.3` naming v2

## 文章定位

- 核心困惑：大多数人对注册中心的直觉都是“一个 service 下面挂很多 instance”。但真正到 Nacos 3.0.3 naming v2 源码，这个直觉会立刻失效：`Service` 不是 live instance 容器，发布状态挂在 `Client.publishers` 上，订阅状态挂在 `Client.subscribers` 上，`ClientServiceIndexesManager` 负责 service 到 client 的反向索引，`ServiceStorage` 再把这些拼成对外可读的 `ServiceInfo`。问题不是“有哪些类”，而是：**naming v2 的真实静态对象图到底怎么组织，为什么 `ServiceManager` 是 canonicalization center，service identity 和 instance identity 又分别是什么。**
- 一句话顿悟：Nacos naming v2 不是“service 直接存 instance”的对象树，而是**canonical `Service` 身份节点 + client-owned 发布/订阅状态 + metadata sidecar + reverse indexes + materialized read model**。`ServiceManager` 负责 canonical service identity，`Client` 负责 live publication/subscription，`ServiceStorage` 负责对外读模型。
- 文章边界：本篇只讲 naming v2 的对象模型、标识形成、ownership、索引和读模型装配；不深讲 heartbeat、ephemeral 清理、persistent CP 写路径、push 通知链，这些都留给后续篇章。

## 前置依赖

### HARD

- `01-nacos-source-map-modules-runtime-assembly.md`
- `02-shared-kernel-core-sys-startup-cluster-remote-auth.md`

### SOFT

- 对注册中心“服务/实例/订阅”有基本直觉会有帮助，但不是前提。

### NAV

- 后续可接：ephemeral path、persistent path、push/subscriber path。

## 一句话困惑

Nacos naming v2 里，service、instance、client、cluster、metadata 到底谁拥有谁？

## 一句话顿悟

Nacos naming v2 的核心不是“service 挂 instance”，而是“`ServiceManager` 持有 canonical service identity，`Client` 持有 live instance publish/subscribe state，`ClientServiceIndexesManager` 建立反向索引，`NamingMetadataManager` 管理 sidecar metadata，`ServiceStorage` 把它们拼成最终对外可读的 `ServiceInfo`”。

## 读者理解路径

1. 先否定“service 直接存 instance”这个朴素模型。
2. 建立三层身份：service identity、client identity、instance metadata identity。
3. 解释 `ServiceManager` 为什么是 canonicalization center。
4. 解释 `Client` 为什么持有 publish/subscriber state。
5. 解释 indexes 和 `ServiceStorage` 为什么是独立层，而不是 service 自带查询能力。
6. 解释 metadata 为什么是 sidecar，而 cluster 为什么是 service-scoped metadata。
7. 用静态对象图收束，为后续 ephemeral/persistent/push 动态篇做坐标系。

## 失败方案推演

### 失败方案一：service 直接持有 live instances

- naming v2 中 live publish state 在 `Client.publishers`，不是在 `Service` 自身。
- `Service` 更像 canonical 逻辑标识，而不是实例容器。
- 如果不先打掉这个直觉，后面 ephemeral/persistent/push 都会写反。

### 失败方案二：`ServiceStorage` 是 source of truth

- `ServiceStorage` 不是权威存储，它是读模型装配器。
- 它通过 index、client、metadata 去 materialize `ServiceInfo`。
- 所以它是 read model，不是 domain truth。

### 失败方案三：cluster 是独立根聚合，和 service 并列

- 在 naming v2 里，cluster 落在 `ServiceMetadata.clusters` 中。
- 这说明 cluster 是 service-scoped metadata，不是和 service 并列的顶级根对象。

### 失败方案四：service identity 包含 ephemeral/persistent 维度

- `Service` 虽然有 `ephemeral` 字段，但 `equals/hashCode` 只看 `namespace/group/name`。
- 这说明 service identity 和 registration path 的语义要分开理解。

## 必须澄清的误解

1. `Service` 不是 live instance 容器。
2. `Client` 不是 SDK 客户端对象，而是 server-side 发布/订阅状态拥有者。
3. `ServiceStorage` 是 materialized read model，不是 truth store。
4. cluster 是 service-scoped metadata，不是独立顶级聚合。
5. service identity 和 instance identity 不在同一层。

## 文章结构与字数预算

1. 困惑开场：为什么“service 挂 instance”直觉是错的（800-1000 字）
2. naming v2 总图：canonical service + client-owned state + metadata + indexes + read model（1200-1600 字）
3. 三层身份：service / client / instance metadata identity（1600-2200 字）
4. `ServiceManager`：canonicalization center（1400-2000 字）
5. `Client` / `ClientManagerDelegate`：发布与订阅状态所有权（1600-2200 字）
6. `ClientServiceIndexesManager` + `ServiceStorage`：反向索引与读模型装配（1600-2200 字）
7. `NamingMetadataManager` + `ServiceMetadata` / `InstanceMetadata`：sidecar metadata（1200-1800 字）
8. 静态对象图收束与后续边界（800-1200 字）

目标叙述性正文：`10000-13000` 字；代码块不计入目标。

## 证据清单

- `naming/core/v2/pojo/Service.java:35` — service fields
- `naming/core/v2/pojo/Service.java:105` — equals/hashCode semantics
- `naming/core/v2/ServiceManager.java:38` — singleton repository
- `naming/core/v2/ServiceManager.java:61` — getSingleton canonicalization
- `naming/core/v2/client/Client.java:28` — server-side client concept
- `naming/core/v2/client/AbstractClient.java:46` — publishers map
- `naming/core/v2/client/AbstractClient.java:48` — subscribers map
- `naming/core/v2/client/impl/IpPortBasedClient.java:69` — client id shape
- `naming/core/v2/client/impl/ConnectionBasedClient.java:56` — connection-based client ephemeral semantics
- `naming/core/v2/client/manager/ClientManagerDelegate.java:42` — top-level client manager router
- `naming/core/v2/index/ClientServiceIndexesManager.java:49` — service->client indexes
- `naming/core/v2/index/ServiceStorage.java:51` — read model role
- `naming/core/v2/index/ServiceStorage.java:106` — materialization path
- `naming/core/v2/metadata/NamingMetadataManager.java:48` — metadata maps
- `naming/core/v2/metadata/ServiceMetadata.java:53` — cluster metadata is service-scoped
- `naming/core/v2/metadata/InstanceMetadata.java:35` — instance metadata sidecar
- `naming/core/v2/pojo/InstancePublishInfo.java:35` — publish info shape
- `naming/core/v2/pojo/InstancePublishInfo.java:126` — instance metadata identity
- `naming/core/InstanceOperatorClientImpl.java:109` — register path uses client + service
- `naming/core/v2/service/impl/EphemeralClientOperationServiceImpl.java:59` — client-owned publish mutation
- `naming/core/ServiceOperatorV2Impl.java:92` — service metadata path

## 测试与辅助证据

- `naming/core/ServiceOperatorV2ImplTest.java:72`
- `naming/core/InstanceOperatorClientImplTest.java:112`
- `naming/core/v2/service/impl/EphemeralClientOperationServiceImplTest.java:113`
- `naming/core/v2/service/impl/PersistentClientOperationServiceImplTest.java:156`
- `naming/core/v2/index/ServiceStorageTest.java:156`
- `naming/core/v2/index/ClientServiceIndexesManagerTest.java:140`

## 版本边界

- 当前分析对象固定为 `Nacos 3.0.3` naming v2。
- 不回退到旧 naming 模型做主体叙述。
- 不深讲 heartbeat / health / cleanup / push / CP 写路径。

## 与后续篇章的边界

### 本篇要讲清

- naming v2 的核心对象模型。
- service/client/instance 三层身份与 ownership。
- canonical service、indexes、metadata、read model 的关系。

### 本篇不深讲

- ephemeral 心跳与清理
- persistent CP 路径
- push / subscriber 通知链
- distro / raft 细节

## 写作后检查

- [ ] 开篇先抓“service 不直接存 instance”，而不是直接罗列类。
- [ ] 至少展开 4 个失败方案，且包含“ServiceStorage 是 truth store”“cluster 是顶级聚合”。
- [ ] 明确给出 naming v2 静态对象总图。
- [ ] 明确区分 service identity、client identity、instance metadata identity。
- [ ] 每个关键关系落到 file:line。
- [ ] 删除代码块后，读者仍能复述 naming v2 的 ownership 与 read model 关系。
- [ ] 通过一次性深审收口。
