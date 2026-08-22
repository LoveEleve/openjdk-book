# Dubbo：Metadata、MetadataReport 与元数据服务 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch08-dubbo-control-plane`
- 篇：`04 Metadata、MetadataReport 与元数据服务`
- 对应主题：`D-CTRL-4 Metadata Report / Metadata Service`
- 文章类型：控制面支撑设施篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：Dubbo 里的 metadata 不是一个东西。它既可能指 provider 公开的服务定义，也可能指应用级 `MetadataInfo` 聚合快照，还可能指 service instance 上的 revision、storage type 或 interface→application 的 mapping。读者最容易困惑的是：这些 metadata 到底分别服务于谁？为什么有 metadata center，又有 metadata service RPC？为什么 application-level discovery 必须依赖 metadata 才能把 app instance 重新变回接口服务？
- 一句话顿悟：Dubbo metadata 的核心不是“存一点描述信息”，而是把 provider 侧已暴露服务折叠成一个可版本化的应用快照，再让 consumer 通过 metadata center 或 metadata service RPC 把这个快照取回来；所以 metadata 是 application-level discovery、migration、service definition introspection 和治理平面共享的一块基础设施，而 `MetadataReport` / `MetadataInfo` / `MetadataService` 则分别处在“存什么、怎么存、怎么取”的三个层次。
- 文章边界：本篇重点讲 `MetadataInfo` revision 模型、`MetadataReport` SPI 与 backends、provider 侧 metadata 发布、consumer 侧 metadata 拉取，以及 metadata service RPC 的角色；只点到 application-level discovery 如何依赖 metadata，不重讲 migration / registry 主线，不深入 vendor-specific backend 实现。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/01-serviceconfig-referenceconfig-export-refer.md`
- `ch08-dubbo-control-plane/02-service-discovery-migration.md`
- `ch08-dubbo-control-plane/03-config-center-dynamic-override.md`

### SOFT

- 不要求先懂具体 metadata backend（ZK/Nacos）。
- 不要求先懂 Dubbo metadata V1/V2 的所有细节。

### NAV

- 后续可接：Dubbo observability / metadata metrics
- 后续可接：Dubbo 控制面总排障篇

## 一句话困惑

Dubbo metadata 到底是什么？是服务定义、应用级服务快照、service instance 上的 revision，还是 interface→application 的映射？为什么既有 MetadataReport，又有 MetadataService？

## 一句话顿悟

Dubbo metadata 可以压成三层：`MetadataInfo` 回答“应用当前暴露了什么服务”，`MetadataReport` 回答“这份信息往哪里存、怎么被取回”，`MetadataService` 回答“如果不走中心存储，provider 自己怎样把这份信息通过 RPC 暴露出来”；三者一起支撑 application-level discovery 和治理平面。

## 读者理解路径

1. 先否定“metadata 就是一份服务描述文档”的理解。
2. 建立最小总图：provider export -> MetadataInfo 聚合 -> revision -> metadata report / metadata service -> consumer retrieval -> service discovery 使用。
3. 解释 `MetadataInfo`：为什么它是应用级快照而不是单服务记录。
4. 解释 `MetadataReport` SPI：为什么服务定义、应用快照、interface→app mapping 能共用同一抽象。
5. 解释 provider 侧 metadata 发布：什么时候更新 revision、什么时候上报。
6. 解释 consumer 侧 metadata 拉取：remote metadata center 与 metadata service RPC 两条路径。
7. 解释 application-level discovery 为什么需要 metadata。
8. 收束到：metadata 是 Dubbo 控制面的一块共享基础设施。

## 失败方案推演

### 失败方案一：metadata 就是一份服务描述文档

- 这会漏掉 application-level `MetadataInfo`、instance revision 和 service-name mapping。
- Dubbo metadata 同时服务于 introspection、控制面和 discovery，不是单用途文档。

### 失败方案二：有 metadata center 就不需要 metadata service RPC

- `MetadataUtils.getRemoteMetadata(...)` 会根据 storage type 决定是走 metadata center 还是直接 refer 远端 metadata service。
- 所以 RPC 和中心存储不是互斥替代，而是两种 retrieval 策略。

### 失败方案三：metadata 更新后 consumer 会立刻像新模型一样工作

- metadata 只是 service-discovery 链上的输入之一。
- 还要经过 mapping、serviceUrls 重建、directory notify、migration currentAvailableInvoker 选择等环节。
- 所以 metadata 变化是必要条件，不是立刻生效的充分条件。

## 必须澄清的误解

1. metadata 不是单一概念，至少包括 service definition、application metadata、instance metadata、service-name mapping。
2. `MetadataReport` 不是 registry，它存的是描述和映射，不直接承担 provider 地址通知。
3. `metadata=local` 不等于“完全不需要远端 metadata”；consumer 仍可能通过 metadata service RPC 拉取。
4. metadata center 和 metadata service RPC 是两种 retrieval 策略，不是重复实现。
5. application-level discovery 依赖 metadata，但 metadata 本身不等于 service discovery。

## 文章结构与字数预算

1. 困惑开场：Dubbo metadata 到底是什么（800-1000 字）
2. 最小总图：provider 聚合 → report/service → consumer retrieval（1000-1400 字）
3. `MetadataInfo`：应用级快照与 revision（1400-2000 字）
4. `MetadataReport`：存储、映射与 retrieval SPI（1600-2200 字）
5. provider 侧发布链（1400-2000 字）
6. consumer 侧拉取链（1400-2000 字）
7. metadata 与 application-level discovery 的关系（1000-1400 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

- `dubbo-metadata/dubbo-metadata-api/src/main/java/org/apache/dubbo/metadata/MetadataInfo.java:62` — MetadataInfo 核心状态
- `MetadataInfo.java:146` — addService
- `MetadataInfo.java:186` — revision 计算
- `dubbo-metadata/dubbo-metadata-api/src/main/java/org/apache/dubbo/metadata/report/MetadataReport.java:33` — MetadataReport SPI
- `dubbo-metadata/dubbo-metadata-api/src/main/java/org/apache/dubbo/metadata/report/support/AbstractMetadataReport.java:84` — 通用 report 逻辑
- `AbstractMetadataReport.java:289` — provider/service definition store
- `AbstractMetadataReport.java:388` — service metadata save
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/AbstractServiceDiscovery.java:155` — register service instance
- `AbstractServiceDiscovery.java:379` — revision 更新
- `AbstractServiceDiscovery.java:390` — publish app metadata
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/metadata/MetadataUtils.java:77` — publish service definition
- `MetadataUtils.java:242` — getRemoteMetadata
- `MetadataUtils.java:287` — metadata center retrieval
- `MetadataUtils.java:134` — metadata service refer
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/metadata/ExporterDeployListener.java:80` — metadata service export 触发
- `ConfigurableMetadataServiceExporter.java:113` — export V1
- `ConfigurableMetadataServiceExporter.java:138` — export V2
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/ServiceDiscoveryRegistry.java:63` — old/new model bridge
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/metadata/MetadataServiceNameMapping.java:79` — publish mapping
- `MetadataServiceNameMapping.java:171` — subscribe mapping

## 测试证据清单

- `MetadataInfoTest` / revision 相关测试
- `ServiceDiscoveryRegistryTest.java:184`
- `ServiceInstancesChangedListenerTest.java:228`
- `ZookeeperMetadataReport` / `NacosMetadataReport` tests
- `MetadataServiceNameMapping` tests

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇以控制面支撑设施为主，不展开具体 vendor backend 的所有实现细节。
- metadata V1/V2 差异只点到 retrieval/export 接缝，不展开协议细节。

## 与其他篇的边界

### 本篇要讲清

- metadata 的几种含义及其层次。
- `MetadataInfo` / `MetadataReport` / `MetadataService` 的角色分工。
- provider 发布和 consumer 拉取链路。
- metadata 与 application-level discovery 的关系。

### 本篇不深讲

- migration 切换细节（已在前文）。
- registry / directory 地址更新主线（已在前文）。
- metadata backend 适配器的 vendor 细节。

## 写作后检查

- [ ] 开篇先抓“metadata 到底是什么”，而不是直接讲 `MetadataInfo` 字段。
- [ ] 至少展开 3 个失败方案，且包含“metadata center=registry”“metadata=service definition”。
- [ ] 明确给出 metadata 三层总图。
- [ ] 不把本文写成 metadata 类清单。
- [ ] 每条发布/拉取链都落到 file:line。
- [ ] 删除代码块后，读者仍能复述 metadata / report / service 三层关系。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。