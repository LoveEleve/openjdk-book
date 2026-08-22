# Nacos：naming persistent path——CP write / replay / health / read model — review notes

## 第一轮：事实审

### 已核对的核心结论

1. persistent 注册在 HTTP 与 gRPC 两条入口上都存在独立分支，并会显式构造 `clientId = ip:port#false` 与 `Service.newService(..., false)`，证据：`naming/controllers/v3/InstanceControllerV3.java:100`、`naming/core/InstanceOperatorClientImpl.java:109`、`naming/remote/rpc/handler/PersistentInstanceRequestHandler.java:60`、`:77`、`:78`。
2. `ClientOperationServiceProxy` 明确把 persistent 与 ephemeral 分流到不同实现，证据：`naming/core/v2/service/ClientOperationServiceProxy.java:55`、`:88`、`:89`。
3. `PersistentClientOperationServiceImpl` 在构造时就把自己注册成 CP request processor，说明 persistent 主线天然站在 CP mutation path 上，证据：`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:99`、`:101`、`:102`。
4. persistent register/deregister/update 的真正第一步不是改内存，而是构造 `WriteRequest` 并调用 `CPProtocol.write(...)`，证据：`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:106`、`:117`、`:122`、`:159`、`:169`。
5. `JRaftProtocol` / `JRaftServer` / `NacosStateMachine` 说明 persistent 使用 dedicated raft group，并在 committed log apply 后才真正改 runtime state，证据：`core/distributed/raft/JRaftProtocol.java:178`、`core/distributed/raft/JRaftServer.java:230`、`core/distributed/raft/NacosStateMachine.java:121`。
6. apply 后真正的 mutation 点仍然是 persistent client 的 `publishers`，不是 service 树，证据：`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:231`、`:238`、`:245`、`:252`。
7. persistent 的读路径仍然通过 `ServiceStorage` / `ServiceQueryRequestHandler` materialize，不是 direct raft read，证据：`naming/core/v2/index/ServiceStorage.java:77`、`:109`、`:155`、`naming/remote/rpc/handler/ServiceQueryRequestHandler.java:66`。
8. persistent health 变化同样会回到 update -> CP write 路径，典型入口是 `PersistentHealthStatusSynchronizer`，证据：`naming/healthcheck/v2/PersistentHealthStatusSynchronizer.java:46`、`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:143`。
9. persistent 专属健康检查只运行在 non-ephemeral `IpPortBasedClient` 上，说明它不是简单沿用 ephemeral beat-check，证据：`naming/core/v2/client/impl/IpPortBasedClient.java:137`、`naming/healthcheck/v2/HealthCheckTaskV2.java:113`。
10. metadata 仍然是 sidecar，并通过独立 CP group 写入，而不是直接并进 persistent instance 主日志，证据：`naming/core/v2/metadata/NamingMetadataOperateService.java:56`、`:59`、`:85`、`:89`。
11. `InstanceOperatorClientImpl.updateInstance(...)` 改的是 metadata sidecar，再由读路径 overlay 回实例视图，证据：`naming/core/InstanceOperatorClientImpl.java:140`、`:141`、`naming/core/v2/index/ServiceStorage.java:157`。
12. snapshot/replay 在 naming 视角是 persistent state 跨重启恢复的关键，证据：`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:316`。

### 测试与辅助证据已核对

1. `naming/core/v2/service/impl/PersistentClientOperationServiceImplTest.java:114` — register/deregister 经 `cpProtocol.write(...)`。
2. `naming/core/v2/service/impl/PersistentClientOperationServiceImplTest.java:156` — `onApply` 才是真正 mutation 点。
3. `naming/core/v2/service/ClientOperationServiceProxyTest.java:95` — persistent/ephemeral split。
4. `naming/remote/rpc/handler/PersistentInstanceRequestHandlerTest.java:50` — gRPC persistent entry。
5. `naming/healthcheck/v2/PersistentHealthStatusSynchronizerTest.java:42` — persistent health update 回到 update path。
6. `naming/core/ServiceOperatorV2ImplTest.java:107` — service lifecycle 相关支撑。
7. `naming/core/InstanceOperatorClientImplTest.java:159` — metadata update path。

### 深审发现

1. **高风险：容易把 persistent 写成“ephemeral 去掉心跳”。** 当前正文已明确 persistent 多出完整的 CP write/apply/replay 链。  
2. **高风险：容易把 persistent 误写成“service 直接住进 Raft”。** 当前正文已明确 apply 后最终仍然改的是 client-owned publish state。  
3. **中风险：容易把 persistent 读路径误写成 direct raft read。** 当前正文已明确 query 仍然走 `ServiceStorage` materialize。  
4. **中风险：容易把 persistent health 状态变化写成本地直接 flip healthy。** 当前正文已明确健康变化也会回到 CP update。  
5. **低风险：容易忽略 metadata sidecar 在 persistent 路径里仍然独立存在。** 当前正文已单列 metadata 边界。  

## 第二轮：因果审

- 如果不先否定“persistent = ephemeral minus heartbeat”，后续 CP 路径和 replay 语义都会被低估：当前正文已先破除，成立。✅
- 如果不把 apply 才是真 mutation 点讲清，读者会误把 `registerInstance()` 当作本地突变：当前正文已纠正，成立。✅
- 如果不说明 persistent 仍然回到 client-owned state，naming v2 统一对象图就会被打碎：当前正文已压实，成立。✅
- 如果不把读路径仍然走 `ServiceStorage` 讲清，persistent 会被误写成 direct raft read 系统：当前正文已切开，成立。✅
- 如果不把 metadata sidecar 的 CP group 独立性讲清，persistent 会被误写成“所有状态都并进同一条日志”：当前正文已明确，成立。✅

## 第三轮：结构审

正文结构按"困惑开场 → 四个失败方案 → 总图 → HTTP/gRPC 入口 → persistent service impl 写路径 → CP write/apply/replay → apply 后的 client-owned state → 读路径 -> persistent health update -> metadata sidecar -> snapshot/replay -> 误解澄清 -> 收网总结"推进，没有退化成 Raft 类名词典。

失败方案已覆盖：
- persistent path 就是 ephemeral 去掉心跳  
- persistent 注册就是把实例直接写进 service  
- persistent 读请求直接从 Raft 读  
- persistent 健康状态也可以像 ephemeral 一样本地直接改  

结构推进符合 persistent 主线篇要求：先立 mutation 差异，再立 apply/replay，再回到同一对象模型和读路径。✅

## 第四轮：读者审（删码测试）

删除代码块后，正文仍应能复述：
- persistent 不是另一套对象模型，而是同一 naming v2 对象图上的 CP mutation path  
- register/deregister/update/health 先写 CP log，再 apply/replay 回 client state  
- 读路径仍然是 `ServiceStorage` materialize，不是 direct raft read  
- metadata sidecar 仍然独立存在，并走自己的 CP group  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未深讲完整 JRaft transport / leader election / route table。✅
- 未深讲 push/subscriber delivery。✅
- 未把 general AP/CP theory 展开成通用一致性课。✅
- 重点压在 persistent naming path 的 CP mutation / replay / read-model 边界上，边界收得住。✅

## 第六轮：依赖审

- 已承接第 06 篇 naming v2 静态对象图。✅
- 已承接第 07 篇 ephemeral path，形成 ownership 相同、mutation 语义不同的对照。✅
- 已为后续 consistency deep-dive、push/subscriber、diagnostics 篇提供 persistent 主线坐标。✅

## 机械检查

- 禁用表达已复扫；当前命中为 0。✅
- 正文行数：451。✅
- 代码块未承担主叙事骨架。✅
- 主要结论均已落到 file:line。✅
- 正文已经达到 persistent 主线篇所需的长文规模。✅

## 结论

本篇的目标不是讲 JRaft 实现，而是把 naming persistent path 讲清：**persistent 不是另一套对象模型，而是同一 naming v2 对象图上的 CP mutation path；写入先走 CP log，apply/replay 后再回到 client-owned state，读路径则继续通过 `ServiceStorage` materialize。** 当前正文已经达成这个目标。 
