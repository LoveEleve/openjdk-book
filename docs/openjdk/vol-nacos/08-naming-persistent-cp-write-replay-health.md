# Nacos：naming persistent path——CP write / replay / health / read model

> 基于 Nacos 3.0.3 naming v2

## 一、困惑开场：为什么“ephemeral 去掉心跳”会把 persistent 写错

如果你已经顺着前面的篇章看过 naming v2 静态模型和 ephemeral 主线，很容易顺手得出一个看起来很自然的结论：

- ephemeral 是会心跳、会过期、偏 AP 的实例
- persistent 只是“没有心跳、不自动删掉”的另一种实例

这个直觉在业务层面勉强能帮助理解使用感受，但在源码层面几乎一定会把 persistent path 写错。

因为 persistent path 的本质差异，不是“少了一条 beat 线”，而是：

- 写路径先进入 `CPProtocol.write(...)`
- 再进入 `JRaftProtocol / JRaftServer / NacosStateMachine`
- 再由 `onApply(...)` 把状态重放回内存
- 而最终运行时仍然是 client-owned publish state + indexes + `ServiceStorage` read model

换句话说，persistent path 不是“ephemeral 去掉心跳”，而是**同一套 naming v2 对象模型上的另一条 mutation path：ownership 相同，mutation 语义完全不同。**

这篇真正要回答的问题是：**persistent path 到底怎样从 HTTP/gRPC 入口一路进入 CP write、再回到运行时 client/index/read model，为什么它和 ephemeral 的差别是 ownership 相同、写入与健康语义完全不同。**

先把结论放前面：Nacos naming persistent path 不是“service 直接住在 Raft 里”，而是**persistent `IpPortBasedClient(false)` 仍然拥有 publish state，但所有 register/deregister/update/health 状态改变都先被序列化成 CP write log，再由 apply/replay 重新落回 client state；读路径仍然通过 indexes 和 `ServiceStorage` 反投影。**

## 二、先走四条失败的路

### 失败方案一：persistent path 就是 ephemeral 去掉心跳

这是最常见的直觉，也是最容易误导后续篇章的直觉。

如果 persistent 只是少了一条心跳线，那么你会自然期待：

- register 主线和 ephemeral 基本一样
- 唯一区别只是没有 beat/expire
- health 状态也应该可以本地直接改

但真实源码里，persistent path 至少多出了一整条 CP mutation chain：

- `PersistentClientOperationServiceImpl`
- `CPProtocol.write(...)`
- `JRaftProtocol`
- `JRaftServer`
- `NacosStateMachine.onApply(...)`

这不是“少一个定时器”能描述的差异。

### 失败方案二：persistent 注册就是把实例直接写进 service

这条误解会让你把 ownership 写反。

真实情况是：就算经过了 Raft，最终 mutate 的对象仍然不是 service，而是 persistent client 的 `publishers`。  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:238`

所以 persistent 也不是“service 直接拥有实例”，它只是通过 CP 写路径把 client-owned state 变更序列化、提交、回放。

### 失败方案三：persistent 读请求会直接从 Raft 读

这也是一种很自然的想象：既然 persistent 写进了 CP，那么读的时候是不是也直接从 Raft/状态机里拿？

但 naming 读路径仍然主要走：

- `ClientServiceIndexesManager`
- `ServiceStorage`
- metadata overlay

`naming/core/v2/index/ServiceStorage.java:109`  
`naming/remote/rpc/handler/ServiceQueryRequestHandler.java:66`

也就是说，Raft 是 mutation / replay authority，不是 naming 查询的直接响应引擎。

### 失败方案四：persistent 健康状态也可以像 ephemeral 一样本地直接改

如果只从“健康检查”直觉出发，很容易以为 persistent 也就是改一下内存里的 healthy 标记。

但 persistent path 并不是这样。

`PersistentHealthStatusSynchronizer` 会把健康变化重新构造成 update 操作，再走 `PersistentClientOperationServiceImpl.updateInstance(...)`，也就是再次走一遍 CP write 路径。  
`naming/healthcheck/v2/PersistentHealthStatusSynchronizer.java:46`

这说明 persistent 的健康语义也属于一致性写路径的一部分。

## 三、总图：entry -> CP write -> apply -> client state -> read model

先把这篇最关键的总图压出来：

```text
HTTP / gRPC persistent register
    ↓
InstanceOperatorClientImpl / PersistentInstanceRequestHandler
    ↓
ClientOperationServiceProxy
    ↓
PersistentClientOperationServiceImpl.register/deregister/update
    ↓
CPProtocol.write(WriteRequest)
    ↓
JRaftProtocol -> JRaftServer -> NacosStateMachine.onApply
    ↓
PersistentClientOperationServiceImpl.onApply(...)
    ↓
persistent client.publishers
    ↓
ClientRegisterServiceEvent / ClientDeregisterServiceEvent
    ↓
ClientServiceIndexesManager
    ↓
ServiceStorage materialize ServiceInfo
```

这张图里最重要的不是“CP 很复杂”，而是 ownership 没有变：

- 写入 authority 变了
- 运行时对象模型没变
- 读路径没变

所以 persistent path 应该被理解成：**同一 naming v2 对象图上的 CP mutation path**。

## 四、persistent register / deregister 入口：HTTP 与 gRPC 都会先走 façade，再进 persistent service impl

### 4.1 HTTP 入口

HTTP 管理注册/注销入口仍然是 `InstanceControllerV3.register/deregister`。  
`naming/controllers/v3/InstanceControllerV3.java:100`

它会进入 `InstanceOperatorClientImpl.registerInstance/removeInstance(...)`。  
`naming/core/InstanceOperatorClientImpl.java:109`

这里对 persistent 来说，关键有两件事：

- `clientId = ip:port#false`
- `Service.newService(..., false)`

这说明 persistent 路径从最外层开始，就已经把“这是一个 non-ephemeral service/client”钉住了。

### 4.2 gRPC 入口

gRPC persistent 注册并不复用 ephemeral handler，而是走独立的 `PersistentInstanceRequestHandler`。  
`naming/remote/rpc/handler/PersistentInstanceRequestHandler.java:60`

它同样会：

- 构造 `Service.newService(..., false)`
- 推导 `ip:port#false`
- 调 `PersistentClientOperationServiceImpl`

`naming/remote/rpc/handler/PersistentInstanceRequestHandler.java:61`  
`naming/remote/rpc/handler/PersistentInstanceRequestHandler.java:77`  
`naming/remote/rpc/handler/PersistentInstanceRequestHandler.java:78`

所以 persistent path 在入口层就已经是一个真正独立的主线，而不是 ephemeral handler 里多一个 if/else。

### 4.3 `ClientOperationServiceProxy` 的分流

不论入口是 HTTP 还是 gRPC，最后都先经过 `ClientOperationServiceProxy`。  
`naming/core/v2/service/ClientOperationServiceProxy.java:55`

它明确按 `instance.isEphemeral()` 分流：

- ephemeral -> `EphemeralClientOperationServiceImpl`
- persistent -> `PersistentClientOperationServiceImpl`

`naming/core/v2/service/ClientOperationServiceProxy.java:88`  
`naming/core/v2/service/ClientOperationServiceProxy.java:89`

这就是 persistent 主线真正的收束点。

## 五、真正的写路径：`PersistentClientOperationServiceImpl` 不是直接改内存，而是先做 CP write

### 5.1 它先把自己注册成 CP processor

`PersistentClientOperationServiceImpl` 不是一个普通 service，它在构造时就会：

- 取 `ProtocolManager.getCpProtocol()`
- `addRequestProcessors(Collections.singletonList(this))`

`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:99`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:101`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:102`

这说明 persistent path 从一开始就明确把自己挂到了 CP 协议处理器体系里。

### 5.2 register 不直接改 client，而是先写日志

`registerInstance(...)` 的关键顺序是：

1. 先 `ServiceManager.getSingleton(service)` 做 canonicalization  
   `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:106`
2. 拒绝 accidental ephemeral service 进入这条线  
   `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:107`  
   `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:108`
3. 把 `InstanceStoreRequest` 包到 `WriteRequest` 里，group 是 `naming_persistent_service_v2`，operation 是 `ADD`  
   `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:117`  
   `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:118`
4. 然后调用 `CPProtocol.write(...)`  
   `naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:122`

所以 persistent register 的本质不是“马上把状态塞进 client”，而是“先提交一条 CP 写日志”。

### 5.3 deregister 也是对称的 CP 写路径

deregister 并不是本地 remove，然后同步给别人；它也会先构造：

- 同一个 CP group
- operation = `DELETE`

再调用 `protocol.write(...)`。  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:159`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:164`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:165`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:169`

所以 persistent register/deregister 的对称性非常强：都必须先过 CP write。

## 六、CP write 如何真正落回 naming 运行时对象：apply/replay 才是 mutation 点

### 6.1 `ProtocolManager` 与 `JRaftProtocol`

Persistent path 并不是直接跳到某个 Raft 类里。中间先经过 shared kernel 的 `ProtocolManager` 和 `CPProtocol` 接线。

然后在具体实现里，`JRaftProtocol.write(...)` 会把请求交给 `JRaftServer.commit(...)`。  
`core/distributed/raft/JRaftProtocol.java:178`

### 6.2 `JRaftServer` 证明 persistent 是一条真实独立的 CP 轨

`JRaftServer.createMultiRaftGroup(...)` 会为不同 processor group 建独立 raft group / state machine。  
`core/distributed/raft/JRaftServer.java:230`

而 `naming_persistent_service_v2` 就是 persistent naming 的专属 group。  
`naming/constants/Constants.java:34`

这说明 persistent path 不是“顺便借用一下 CP”，而是一条真实独立的 CP mutation lane。

### 6.3 `NacosStateMachine.onApply(...)` 之后才真正改内存

真正的内存 mutation 点不在 `registerInstance(...)`，而在 apply 之后。

`NacosStateMachine.onApply(...)` 会把 committed log 回调给 processor 的 `onApply(WriteRequest)`。  
`core/distributed/raft/NacosStateMachine.java:121`

而 `PersistentClientOperationServiceImpl.onApply(...)` 会：

- 反序列化 `InstanceStoreRequest`
- 按 `ADD / DELETE / CHANGE` 分支
- 再走真正的 `onInstanceRegister / onInstanceDeregister / onInstanceUpdate`

`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:192`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:196`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:199`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:203`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:206`

所以 persistent 路径的真正顿悟是：**提交不是 mutation，apply 才是 mutation。**

## 七、apply 之后，为什么仍然是 client-owned state

### 7.1 `onInstanceRegister(...)` 最终还是写 client.publishers

在 apply 后，`onInstanceRegister(...)` 会：

- 确保 persistent client 存在
- 把 API `Instance` 转成 `InstancePublishInfo`
- `client.addServiceInstance(service, publishInfo)`
- 更新时间与 revision
- 发注册与 metadata 事件

`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:231`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:233`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:238`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:240`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:241`

所以就算是 persistent，最终运行时对象图仍然没变：**client 是 live state owner。**

### 7.2 deregister 也不是改 service，而是从 client 撤掉 publish state

`onInstanceDeregister(...)` 会：

- 从 client 里移除该 service instance
- 如果这个 client 已经不再发布任何东西，就断开并清掉它
- 然后再发注销与 metadata 失效事件

`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:245`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:252`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:254`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:257`  
`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:259`

这再次说明：persistent path 不是“service 直接住在 Raft 里”，而是“Raft 驱动 client state 回放”。

## 八、读路径为什么仍然是 `ServiceStorage`

### 8.1 persistent 不等于 direct raft read

即使写路径走了 CP，naming 的查询仍然不是“直接从 Raft 读出实例列表”。

`ServiceStorage.getData(service)` 仍然是读路径核心。  
`naming/core/v2/index/ServiceStorage.java:77`

### 8.2 gRPC query 也证明了这一点

`ServiceQueryRequestHandler` 会：

- 构造 `Service`
- 调 `serviceStorage.getData(service)`
- 取 `ServiceMetadata`
- 再做健康保护过滤

`naming/remote/rpc/handler/ServiceQueryRequestHandler.java:63`  
`naming/remote/rpc/handler/ServiceQueryRequestHandler.java:66`  
`naming/remote/rpc/handler/ServiceQueryRequestHandler.java:67`  
`naming/remote/rpc/handler/ServiceQueryRequestHandler.java:68`

这说明 persistent path 的“权威性”体现在 mutation / replay，不体现在 query engine 形态。

### 8.3 这和 ephemeral 的读路径在结构上其实是一样的

persistent 与 ephemeral 的读路径都还是：

- indexes
- client-owned publish state
- metadata overlay
- `ServiceStorage` materialize `ServiceInfo`

真正不同的是“这些内存对象是怎么被写进去的”。

## 九、persistent 健康变化为什么也要回到 CP 路径

### 9.1 persistent health 不是本地直接 flip 标记

ephemeral path 里，`ClientBeatProcessorV2` 可以本地直接把实例从 unhealthy 拉回 healthy。

但 persistent path 不是这样。

`PersistentHealthStatusSynchronizer` 会把健康变化重新构造成 update 操作，再调用 `persistentClientOperationService.updateInstance(...)`。  
`naming/healthcheck/v2/PersistentHealthStatusSynchronizer.java:46`

这意味着健康变化也属于 CP 管控的状态修改。

### 9.2 `HealthCheckTaskV2` 只跑在 non-ephemeral `IpPortBasedClient` 上

在 `IpPortBasedClient.init(...)` 里，非 ephemeral 才会注册 `HealthCheckTaskV2`。  
`naming/core/v2/client/impl/IpPortBasedClient.java:137`

所以 persistent 健康检查本身就是另一条不同于 beat-check 的运行时链。

### 9.3 管理面手工改健康状态也要绕回这条线

`HealthOperatorV2Impl.updateHealthStatusForPersistentInstance(...)` 只在 checker type 为 `NONE` 时允许手工更新，并最终回到 register/update machinery。  
`naming/core/HealthOperatorV2Impl.java:66`  
`naming/core/HealthOperatorV2Impl.java:74`  
`naming/core/HealthOperatorV2Impl.java:88`

这再次说明 persistent health 语义不是本地小修小补，而是受一致性写路径约束的状态变更。

## 十、metadata sidecar 在 persistent path 里仍然独立存在

### 10.1 persistent 并没有把 metadata 合并进实例主日志

这是一个很容易被忽略的点。

`NamingMetadataOperateService` 仍然会把：

- service metadata
- instance metadata

分别写进自己的 CP group，而不是合并到 `naming_persistent_service_v2` 的 instance 主日志里。  
`naming/core/v2/metadata/NamingMetadataOperateService.java:56`  
`naming/core/v2/metadata/NamingMetadataOperateService.java:59`  
`naming/core/v2/metadata/NamingMetadataOperateService.java:85`  
`naming/core/v2/metadata/NamingMetadataOperateService.java:89`

所以 persistent 也不是“所有状态都塞到同一条日志对象里”，而是 instance body 与 metadata sidecar 继续分离。

### 10.2 管理面 update 的对象也是 metadata sidecar

`InstanceOperatorClientImpl.updateInstance(...)` 改的是 metadata sidecar，而不是直接重写 persistent publish body。  
`naming/core/InstanceOperatorClientImpl.java:140`  
`naming/core/InstanceOperatorClientImpl.java:141`

### 10.3 读路径再 overlay 回来

最终 `ServiceStorage.parseInstance(...)` 仍会在读取时把 metadata overlay 回实例视图。  
`naming/core/v2/index/ServiceStorage.java:157`

这说明 persistent path 在 metadata 这一层和 ephemeral 一样，仍然保持 sidecar 设计。

## 十一、snapshot / replay 在 naming 视角意味着什么

### 11.1 为什么 persistent 能跨重启保留

因为 persistent path 不只写了日志，还提供 snapshot/replay。

`PersistentClientOperationServiceImpl` 里有 dedicated snapshot archive，例如：

- `persistent_instance.zip`

`naming/core/v2/service/impl/PersistentClientOperationServiceImpl.java:316`

这说明 persistent path 的目标不是“让本次写操作一致”，而是“让 naming 的持久实例状态在重启/恢复后能被重建”。

### 11.2 这篇不展开 JRaft internals，但要立住 naming 视角

本篇不需要深入到 JRaft transport、leader election、ReadIndex。

但必须让读者记住：

- persistent naming state 的恢复不是靠再次注册
- 而是靠 CP log + snapshot replay

这就是 persistent path 在 naming 视角最该记住的意义。

## 十二、误解澄清

### 误解一：persistent 就是 ephemeral 去掉心跳

不是。persistent 多的是一整条 CP write / apply / replay 主线。

### 误解二：persistent 注册就是把实例直接写进 service

不是。最终 mutation 点仍然是 persistent client 的 `publishers`。

### 误解三：persistent 读请求直接从 Raft 读

不是。读路径仍然主要走 `ServiceStorage` materialize。

### 误解四：persistent 健康变化可以本地直接改

不是。persistent health 变化也要回到 CP update 路径。

### 误解五：persistent 就把 metadata 合并进主日志了

不是。metadata 仍然是 sidecar，并走独立 CP group。

## 十三、收网总结：persistent 的核心不是“住进 Raft”，而是“先写 CP，再回放到同一套 naming 对象模型”

回到开头的问题：Nacos persistent path 到底是什么？

答案不是“ephemeral 去掉心跳”，也不是“service 直接住进 Raft”，而是：

- register/deregister/update/health 先走 CP write
- committed log 再通过 apply/replay 落回 persistent client 的 publish state
- indexes 与 `ServiceStorage` 继续负责对外读模型
- metadata sidecar 仍然独立存在并在读路径 overlay 回来

把整篇压成三句话：

1. persistent path 不是另一套对象模型，而是 naming v2 同一对象图上的 CP mutation path。  
2. apply/replay 之后真正被改的仍然是 client-owned publish state，而不是 service 树。  
3. 读路径仍然依赖 `ServiceStorage` materialize，持久化与一致性 authority 体现在写入和恢复，而不是 direct raft read。  
