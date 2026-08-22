# Nacos：naming domain model——service / client / metadata / indexes — review notes

## 深度 review 结论

本轮按"事实 → 因果 → 结构 → 删码 → 边界"重审后，**当前正文无必须修改的事实性错误**，主线成立，可以收口。

## 第一轮：事实审

### 已复核的关键结论

1. naming v2 的核心对象关系不是 `Service -> [Instance...]`，而是 canonical `Service` + client-owned publish/subscriber state + metadata sidecar + reverse indexes + materialized read model，证据来自 `ServiceManager`、`AbstractClient`、`ClientServiceIndexesManager`、`NamingMetadataManager`、`ServiceStorage` 等核心类。
2. `Service` 的核心字段包括 `namespace`、`group`、`name`、`ephemeral`、revision 与时间戳，但 identity equality 并不包含 `ephemeral`，证据：`naming/core/v2/pojo/Service.java:35`、`:41`、`:43`、`:105`、`:118`。
3. `ServiceManager` 是 canonicalization center：维护 `singletonRepository` 与 `namespaceSingletonMaps`，并在 `getSingleton(...)` 时返回/安装 canonical `Service` 对象，证据：`naming/core/v2/ServiceManager.java:38`、`:40`、`:61`、`:63`。
4. `Client` 是 server-side 状态拥有者，不是 SDK facade；`AbstractClient` 真正持有 `publishers` 与 `subscribers` 两类状态，证据：`naming/core/v2/client/Client.java:28`、`naming/core/v2/client/AbstractClient.java:46`、`:48`。
5. `IpPortBasedClient` 与 `ConnectionBasedClient` 说明 client identity 有不同变体：前者按 `address#ephemeral` 建模，后者按连接建模并天然偏 ephemeral，证据：`naming/core/v2/client/impl/IpPortBasedClient.java:69`、`naming/core/v2/client/impl/ConnectionBasedClient.java:56`。
6. `ClientManagerDelegate` 是 client registry router，而不是简单 façade，证据：`naming/core/v2/client/manager/ClientManagerDelegate.java:42`。
7. `ClientServiceIndexesManager` 提供 service 到 publisher/subscriber clientIds 的反向索引，证据：`naming/core/v2/index/ClientServiceIndexesManager.java:49`、`:51`。
8. `ServiceStorage` 是 read model / assembler，不是 truth store；它通过 indexes、clients、publish info、metadata 组装 `ServiceInfo`，证据：`naming/core/v2/index/ServiceStorage.java:51`、`:77`、`:106`、`:147`、`:155`。
9. `NamingMetadataManager` 维护 `Service -> ServiceMetadata` 与 `Service -> metadataId -> InstanceMetadata` 两类 sidecar metadata，证据：`naming/core/v2/metadata/NamingMetadataManager.java:48`、`:50`。
10. `ServiceMetadata` 中的 `clusters` 说明 cluster 是 service-scoped metadata，不是独立根聚合，证据：`naming/core/v2/metadata/ServiceMetadata.java:53`。
11. `InstancePublishInfo` 是 server 内部 publish payload，它的 metadata identity 是 `ip:port:cluster`，证据：`naming/core/v2/pojo/InstancePublishInfo.java:35`、`:94`、`:126`。
12. `InstanceOperatorClientImpl` 和 `EphemeralClientOperationServiceImpl` 证明 registration path 是“client + canonical service + publish info”，而不是“service 直接挂 instance”，证据：`naming/core/InstanceOperatorClientImpl.java:109`、`:112`、`:113`、`naming/core/v2/service/impl/EphemeralClientOperationServiceImpl.java:59`、`:65`、`:68`、`:71`。
13. `ServiceOperatorV2Impl` 与 `NamingMetadataManager` 说明 service metadata 走的是独立 metadata 路径，而不是直接塞进 service 对象，证据：`naming/core/ServiceOperatorV2Impl.java:92`、`:97`、`naming/core/v2/metadata/NamingMetadataManager.java:190`、`:193`。

### 测试与辅助证据复核

1. `naming/core/ServiceOperatorV2ImplTest.java:72` — 测试显式依赖 `ServiceManager`。
2. `naming/core/InstanceOperatorClientImplTest.java:112` — operator 假定 canonical service 已存在。
3. `naming/core/v2/service/impl/EphemeralClientOperationServiceImplTest.java:113` — client-owned register/deregister 行为。
4. `naming/core/v2/service/impl/PersistentClientOperationServiceImplTest.java:156` — persistent path 同样 canonicalize service。
5. `naming/core/v2/index/ServiceStorageTest.java:156` — `ServiceStorage` merge metadata。
6. `naming/core/v2/index/ClientServiceIndexesManagerTest.java:140` — service->client indexing。

## 第二轮：因果审

- 如果不先否定“service 挂 instance”这个朴素模型，后续 ephemeral/persistent/push 所有动态篇都会失去正确坐标系：当前正文已先破除，成立。✅
- 如果不把 `ServiceManager` 立成 canonicalization center，后面 service equality、metadata、index、event 都会写散：当前正文已压实，成立。✅
- 如果不把 client 定义成发布/订阅状态拥有者，registration path 会被误写成 service 自己突变：当前正文已纠正，成立。✅
- 如果不把 `ServiceStorage` 定位成 read model，很多读路径会被误写成直接读 service truth：当前正文已切开，成立。✅
- 如果不把 cluster 重新放回 service-scoped metadata 里，后面 cluster 相关分析会错误提升其聚合层级：当前正文已明确，成立。✅

## 第三轮：结构审

### 结构是否跑偏

没有跑偏。正文推进顺序是：

1. 先抓“为什么 `service` 下面挂很多 `instance` 的直觉会误导你”  
2. 再用四个失败方案打掉最常见错误模型  
3. 再建立 naming v2 总图和三层身份  
4. 再切出 `ServiceManager`、`Client`、indexes、metadata、`ServiceStorage` 这几个核心支柱  
5. 最后再用静态对象图收束并给后续动态篇让位  

这保证了正文没有退化成 naming v2 类图目录，也没有提前侵入 heartbeat/push/CP 写路径。✅

### 失败方案是否有效

有效，而且正好命中了这一篇最需要先打掉的四种错觉：
- service 直接持有 live instances  
- `ServiceStorage` 是 source of truth  
- cluster 是顶级根聚合  
- service identity 包含 ephemeral/persistent 维度  

这四条分别对应 ownership、read model、聚合边界、identity 边界四个最关键错位。✅

## 第四轮：删码测试

删除代码块后，正文仍然能复述：
- naming v2 的核心不是 service 树，而是 canonical service + client-owned state + metadata + indexes + read model  
- service identity、client identity、instance metadata identity 不是同一层  
- `ServiceManager` 负责 canonical service identity  
- `Client` 负责 publish/subscriber state  
- `ServiceStorage` 负责 materialize `ServiceInfo`，不是 truth store  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

### 本篇边界控制

当前正文边界控制是对的：
- 没深讲 heartbeat / health / cleanup  
- 没深讲 persistent CP 写路径  
- 没深讲 push / subscriber 通知链  
- 没深讲 distro / raft 细节  
- 重点压在 naming v2 的静态对象图与 ownership 边界上  

### 与后续篇章的边界

- 第 07 篇可自然接 ephemeral path：beat / health / cleanup / client removal。✅
- 第 08 篇可自然接 persistent path：CP register / snapshot / replay。✅
- 第 09 篇可自然接 subscriber/push path：ServiceEvent / ClientOperationEvent 到通知链。✅
- 本篇自身位置：`vol-nacos` 的 naming v2 领域模型总图篇。✅

## 第六轮：风险点

### 已确认不是问题的点

1. 正文没有把 naming v2 写回成“service 直接存 instance”的老心智。  
2. 正文没有把 `ServiceStorage` 写成权威存储。  
3. 正文没有把 cluster 写成和 service 并列的顶级聚合。  
4. 正文没有忽略 service identity 与 instance identity 的层级差异。  
5. 正文没有过早侵入 heartbeat/push/CP 的动态篇。  

### 当前仍存在的轻微风险

1. 正文已经建立了较稳的 naming v2 模型主线，但如果后续做整卷统一抛光，仍可继续补一轮 `ServiceManager.getSingleton()`、`ClientManagerDelegate`、`ServiceStorage` materialize 过程的更细行级锚点密度。  
2. 这个问题不影响主线正确性，属于进一步精修项。  

## 机械检查

- 禁用表达已复扫；当前命中为 0。✅
- 正文行数：455。✅
- 代码块未承担主叙事骨架。✅
- 主要结论均已落到 file:line。✅
- 正文已经达到 naming model 篇所需的长文规模。✅

## 结论

本轮深度 review 后，正文可以认为已经完成收口：

- 事实层面成立  
- 因果链成立  
- 结构推进成立  
- 删码后主线成立  
- 与后续篇章边界清晰  

如果后续要再提升一档，优先项不是改结构，而是补更细的 `ServiceManager.getSingleton()` / `ClientManagerDelegate` / `ServiceStorage` 锚点。当前版本不改也可以过关。 
