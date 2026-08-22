# Nacos：naming ephemeral path——register / beat / unhealthy / expire / cleanup — review notes

## 深度 review 结论

本轮按"事实 → 因果 → 结构 → 删码 → 边界"重审后，**当前正文无必须修改的事实性错误**，主线成立，可以收口。

之后已追加一轮深修：把 `InstanceOperatorClientImpl`、`ClientBeatProcessorV2`、`ClientBeatCheckTaskV2` 的更细 `file:line` 锚点补回正文，用来把“HTTP 注册到底怎样生成 clientId 并进入 canonical service”“beat 补注册与心跳恢复到底在哪几步发生”“beat-check 任务为什么是 client 维度而不是 service 维度”这三条因果链压得更实。

## 第一轮：事实审

### 已核对的核心结论

1. HTTP v3/v2 与 gRPC 的 ephemeral 注册虽然入口不同，但都收敛到 `ClientOperationService` 这条 server-side 主线，证据：`naming/controllers/v3/InstanceControllerV3.java:100`、`naming/controllers/v2/InstanceControllerV2.java:381`、`naming/remote/rpc/handler/InstanceRequestHandler.java:58`。
2. HTTP 路径会按 `ip:port#ephemeral` 生成 `clientId`，gRPC 路径会用 `connectionId` 作为 clientId，说明“ephemeral”不等于“client 必然是 connection-based”，证据：`naming/core/InstanceOperatorClientImpl.java:110`、`naming/remote/rpc/handler/InstanceRequestHandler.java:75`；正文现在还补了 `InstanceOperatorClientImpl.java:108`、`:109`、`:111`、`:112`，把参数合法性校验、ephemeral 提取、`IpPortBasedClient` 生成路径压得更细。
3. `ClientOperationServiceProxy` 按 `instance.isEphemeral()` 分流，ephemeral 主体进入 `EphemeralClientOperationServiceImpl`，证据：`naming/core/v2/service/ClientOperationServiceProxy.java:55`、`:88`。
4. `EphemeralClientOperationServiceImpl.registerInstance(...)` 会先 canonicalize service，再把 `InstancePublishInfo` 挂到 client 的 `publishers` 上，并发布 `ClientRegisterServiceEvent` 与 `InstanceMetadataEvent`，证据：`naming/core/v2/service/impl/EphemeralClientOperationServiceImpl.java:56`、`:59`、`:65`、`:68`、`:71`；正文现在还补了 `:61`、`:62`、`:69`、`:70`，把 service/client 类型校验、`lastUpdatedTime`、revision 更新顺序压得更细。
5. `AbstractClient.publishers` 才是 live publish state 真正所在位置，说明实例不是直接挂在 service 下，证据：`naming/core/v2/client/AbstractClient.java:46`、`:72`、`:81`。
6. `ClientServiceIndexesManager` 消费注册事件，建立 `service -> publisher clientIds` 索引并进一步触发 `ServiceChangedEvent`，证据：`naming/core/v2/index/ClientServiceIndexesManager.java:117`、`:131`、`:137`。
7. `ServiceStorage` 不是 truth store，而是通过 indexes、clients、`InstancePublishInfo` 与 metadata 反投影出 `ServiceInfo` 的 read model，证据：`naming/core/v2/index/ServiceStorage.java:77`、`:106`、`:147`、`:155`。
8. beat 入口在 `InstanceOperatorClientImpl.handleBeat(...)`，某些条件下会基于 beat 内容补注册实例，证据：`naming/core/InstanceOperatorClientImpl.java:231`、`:237`、`:241`；正文现在还补了 `:233`、`:234`、`:238`、`:242`，把 service/clientId 生成、未注册判定、补注册路径压得更细。
9. `ClientBeatProcessorV2` 刷新的不是 service TTL，而是 `HealthCheckInstancePublishInfo.lastHeartBeatTime`，必要时还会把实例从 unhealthy 改回 healthy，证据：`naming/healthcheck/heartbeat/ClientBeatProcessorV2.java:60`、`:66`、`:71`；正文现在还补了 `:56`、`:57`、`:58`、`:59`、`:61`、`:62`、`:67`、`:68`、`:72`、`:73`，把 beat 拆 service、定位 publishInfo、恢复健康并补发事件的链压得更细。
10. `UnhealthyInstanceChecker` 与 `ExpiredInstanceChecker` 分别承担“不健康标记”和“真正删除”两阶段，证据：`naming/healthcheck/heartbeat/UnhealthyInstanceChecker.java:49`、`:60`、`:79`、`naming/healthcheck/heartbeat/ExpiredInstanceChecker.java:52`、`:78`、`:79`。
11. client 级清理由 `EphemeralIpPortClientManager` 负责，说明 instance expiry 与 client release 不是同一条清理线，证据：`naming/core/v2/client/manager/impl/EphemeralIpPortClientManager.java:63`、`:90`、`:97`、`naming/core/v2/client/impl/IpPortBasedClient.java:103`；正文现在还补了 `ClientBeatCheckTaskV2.java:44`、`:45`、`:46`、`:55`、`:56`、`:67`、`:68`、`:69`、`:71`，把 beat-check task 是 client 维度 task 而不是 service 维度 task 的事实压得更细。
12. ephemeral 主体虽然是 AP / in-memory / client-owned，但 metadata sidecar 更新会走 `CPProtocol.write(...)`，再由 `ServiceStorage` 在读路径 overlay 回来，证据：`naming/core/v2/metadata/NamingMetadataOperateService.java:85`、`naming/core/v2/metadata/InstanceMetadataProcessor.java:107`、`naming/core/v2/index/ServiceStorage.java:155`。

### 测试与辅助证据已核对

1. `naming/core/InstanceOperatorClientImplTest.java:128` — register / beat façade 行为。
2. `naming/core/v2/service/impl/EphemeralClientOperationServiceImplTest.java:113` — client-owned register/deregister。
3. `naming/healthcheck/heartbeat/ClientBeatCheckTaskV2Test.java:99` — unhealthy / expire 两阶段与 metadata timeout。
4. `naming/core/v2/client/manager/impl/EphemeralIpPortClientManagerTest.java:105` — client verify/revision 语义。
5. `test/naming-test/.../ClientBeatNamingITCase.java:67` — light beat 集成行为。

## 第二轮：因果审

- 如果不先否定“service 挂 instance”这个直觉，后续所有 ephemeral 动态行为都会落错对象：当前正文已先破除，成立。✅
- 如果不把 event/index/read-model 链讲清，读者会误以为 service 视图是原地更新出来的：当前正文已拉直，成立。✅
- 如果不把 beat 与 unhealthy/expire/client release 三层关系切开，读者会把所有超时语义压成一个“续租失败”故事：当前正文已切开，成立。✅
- 如果不说明 metadata sidecar 走 CP，ephemeral 主线会被误写成纯 AP 内存链：当前正文已纠正，成立。✅
- 如果不区分 HTTP 地址型 client 和 gRPC 连接型 client，client ownership 模型会被写歪：当前正文已说明，成立。✅

## 第三轮：结构审

### 结构是否跑偏

没有跑偏。正文推进顺序是：

1. 先抓“为什么 service 挂 instance + 心跳续租的直觉会写歪”  
2. 再用四个失败方案打掉错误模型  
3. 再建立 register -> client-owned state -> indexes -> read model 总图  
4. 再走 HTTP/gRPC register、ephemeral service mutation、event/index 投影  
5. 再讲 beat、unhealthy、expired、client release  
6. 最后补 metadata sidecar 与后续边界  

这保证了正文没有退化成 healthcheck 类名目录，也没有把 persistent/push/Distro 细节提前吞进来。✅

### 失败方案是否有效

有效，而且正好命中了这一篇最需要先打掉的四种错觉：
- ephemeral 注册就是向 service 添加 instance  
- heartbeat 只是续租，不会改变注册状态  
- ephemeral 数据完全不碰 CP  
- client 就等于一个连接  

这四条分别对应 ownership、状态机、consistency sidecar、client identity 四个关键错位。✅

## 第四轮：删码测试

删除代码块后，正文仍然能复述：
- ephemeral 实例先住在 client 的 `publishers` 里，而不是 service 下  
- service 视图通过 event/index/`ServiceStorage` 反投影出来  
- beat 刷新的是 instance heartbeat time，不是 service TTL  
- 状态收敛链是 `unhealthy -> expired -> client release`  
- metadata sidecar 是独立 CP 通道，再 overlay 回读路径  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未深讲 persistent client operation。✅
- 未深讲 push/subscriber delivery。✅
- 未深讲 Distro / verify / revision 跨节点同步。✅
- 重点压在 ephemeral register/beat/cleanup 主线与 AP+CP sidecar 边界上，边界收得住。✅

## 第六轮：依赖审

- 已承接第 06 篇 naming v2 静态对象图。✅
- 已为第 08 篇 persistent path、第 09 篇 push/subscriber path、后续 Distro 篇提供动态主线坐标。✅
- 与 cluster/consistency 线保持边界，只在需要时提到 metadata sidecar 的 CP 路径。✅

## 机械检查

- 禁用表达已复扫；当前命中为 0。✅
- 正文行数：418。✅
- 代码块未承担主叙事骨架。✅
- 主要结论均已落到 file:line。✅
- 正文已经达到 ephemeral 主线篇所需的长文规模。✅

## 结论

本轮深度 review 后，正文可以认为已经完成收口：

- 事实层面成立  
- 因果链成立  
- 结构推进成立  
- 删码后主线成立  
- 与后续篇章边界清晰  

如果后续要再提升一档，优先项不是改结构，而是补更细的 `UnhealthyInstanceChecker`、`ExpiredInstanceChecker`、`EphemeralIpPortClientManager` 锚点。当前版本不改也可以过关。 
