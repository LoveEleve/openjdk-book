# Dubbo：Metadata、MetadataReport 与元数据服务 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `MetadataInfo` 是应用级服务快照，不是单条服务定义；它持有核心状态并通过 `addService()` 聚合服务，最后计算 revision，证据：`dubbo-metadata/dubbo-metadata-api/src/main/java/org/apache/dubbo/metadata/MetadataInfo.java:62`、`:146`、`:186`。
2. `MetadataReport` 是统一 SPI，既负责 service definition、也负责 app metadata 和 interface->application mapping 的存取，证据：`dubbo-metadata/dubbo-metadata-api/src/main/java/org/apache/dubbo/metadata/report/MetadataReport.java:33`。
3. `AbstractMetadataReport` 已经封装了 cache/retry/report 通用逻辑，并分别处理 service definition 与 app metadata 的持久化，证据：`dubbo-metadata/dubbo-metadata-api/src/main/java/org/apache/dubbo/metadata/report/support/AbstractMetadataReport.java:84`、`:289`、`:388`。
4. provider 侧 `AbstractServiceDiscovery.register(URL)` 会把导出服务折进 metadata 快照，更新 revision，并在合适条件下调用 metadata report 发布 app metadata，证据：`dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/AbstractServiceDiscovery.java:155`、`:379`、`:390`。
5. provider 侧 service definition 发布通过 `MetadataUtils.publishServiceDefinition(...)` 走单独链路，不等同于 app metadata 发布，证据：`dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/metadata/MetadataUtils.java:77`。
6. consumer 侧统一通过 `MetadataUtils.getRemoteMetadata(...)` 拉取 metadata，但会根据 storage type 选择 metadata center 或 metadata service RPC，证据：`MetadataUtils.java:242`、`:287`、`:134`。
7. `ExporterDeployListener` 和 `ConfigurableMetadataServiceExporter` 负责在 provider 侧导出 metadata service V1/V2，证据：`dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/metadata/ExporterDeployListener.java:80`、`ConfigurableMetadataServiceExporter.java:113`、`:138`。
8. `ServiceDiscoveryRegistry` 明确是“旧接口级发现桥接到新服务发现模型”的入口，依赖 mapping 与 metadata，证据：`dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/ServiceDiscoveryRegistry.java:63`。
9. `MetadataServiceNameMapping` 负责 interface->application mapping 的发布与订阅，说明 metadata 还承担 discovery 控制面的映射职责，证据：`dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/metadata/MetadataServiceNameMapping.java:79`、`:171`。
10. service instance 上的 `metadata.revision` / storage type 等元信息决定 consumer 如何沿 application-level discovery 路径继续走，证据：`ServiceDiscoveryRegistry.java:199`、`ServiceInstancesChangedListener.java:143`。

### 测试证据已核对

1. `ServiceDiscoveryRegistryTest.java:184` — service-discovery subscribe path。
2. `ServiceInstancesChangedListenerTest.java:228` — instance URL / metadata 通知链。
3. `ZookeeperMetadataReport` / `NacosMetadataReport` tests — metadata report backend 行为。
4. `MetadataServiceNameMapping` tests — interface->application mapping。

### 深审发现

1. **高风险：容易把 metadata 写成“服务文档系统”。** 当前正文已明确它是 app-level discovery、migration 和治理平面的共享基础设施。  
2. **高风险：容易把 metadata center 和 metadata service RPC 写成重复实现。** 当前正文已拆成两条 retrieval 策略。  
3. **中风险：容易把 metadata 更新误写成立即影响 runtime。** 当前正文已强调 metadata 只是 discovery/migration 链上的输入之一。  
4. **中风险：容易忽略 mapping 的控制面角色。** 当前正文已把 `MetadataServiceNameMapping` 单列。  
5. **低风险：容易混淆 service definition、MetadataInfo、instance metadata。** 当前正文已按三层结构拆开。  

## 第二轮：因果审

- provider 必须先把已导出服务折叠成 `MetadataInfo` 快照，否则 application-level discovery 没有统一的应用描述源：✅
- `MetadataReport` 必须同时承担 app metadata 和 mapping 存储，否则 discovery 和治理无法共享同一控制面基础设施：✅
- consumer 必须支持 metadata center 与 metadata service RPC 两条 retrieval 路径，否则不同存储模式下无法统一取回 metadata：✅
- application-level discovery 必须依赖 metadata，而不是只依赖 instance address，否则无法从 app instance 回到接口服务：✅
- metadata 更新不能等同于 runtime 立即切换，因为它只是 discovery/migration/object graph 的输入之一：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → metadata 三层总图 → MetadataInfo → MetadataReport → provider 发布 → consumer 拉取 → metadata 对 application-level discovery 的支撑 → 误解澄清 → 收网总结”推进，没有退化成 metadata 类清单。

失败方案已覆盖：
- metadata 只是一份服务定义文档  
- 有 metadata center 就不需要 metadata service RPC  
- metadata 更新后 consumer 会立刻像新模型一样工作  

每一层拆解均围绕“存什么 / 往哪存 / 从哪取 / 如何反哺 discovery”展开，符合控制面支撑设施篇定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- metadata 的几种含义和三层结构  
- provider 侧如何聚合、发布 metadata  
- consumer 侧如何按两条路径拉取 metadata  
- metadata 为什么会反哺 application-level discovery  
- 为什么 metadata 更新不等于 runtime 立刻切换  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开具体 vendor backend 细节。✅
- 未展开 migration / registry 主线本身（前文已覆盖）。✅
- 未展开 metadata publish 低层协议细节。✅
- 重点仍压在 metadata 作为控制面基础设施的三层关系，边界收得住。✅

## 第六轮：依赖审

- 已承接 Dubbo export/refer 与控制面篇：metadata 如何从 provider export 结果聚合出来，又如何进入 discovery/migration 链。✅
- 已承接 service-discovery migration 篇：metadata 在这里不再讲切换策略，而是讲它作为输入和共享基础设施的角色。✅
- `ServiceDiscoveryRegistryTest`、`ServiceInstancesChangedListenerTest`、metadata report/backend tests 足以支撑本文主结论。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。
- 代码块：使用少量三层总图，不承担主叙事骨架。
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `MetadataInfo`、`MetadataReport`、`AbstractMetadataReport`、`AbstractServiceDiscovery`、`MetadataUtils`、`ExporterDeployListener`、`ConfigurableMetadataServiceExporter`、`ServiceDiscoveryRegistry`、`MetadataServiceNameMapping`。
- 去掉代码块后正文仍成立：是。
- 叙述性正文字符数（不含代码块与空白行）：约 `11,519`。
- 目标定位：Dubbo metadata 控制面支撑设施篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 Dubbo metadata 从“一个术语”提升到“应用级服务描述与检索基础设施”：`MetadataInfo` 负责聚合和 revision，`MetadataReport` 负责存取与映射，`MetadataService` 负责在无中心或特定模式下的 RPC retrieval，而 application-level discovery 则把这一整套基础设施当作自己的输入。