# Nacos：naming ephemeral path——register / beat / unhealthy / expire / cleanup

> 基于 Nacos 3.0.3 naming v2

## 一、困惑开场：为什么“service 挂 instance + 心跳续租”这个直觉会写歪

如果只从产品视角看注册中心，很多人会自然把 ephemeral 服务实例脑补成这样一条线：

- 调用注册接口
- 一个 `instance` 挂到 `service` 下面
- 后面定时发 beat
- 不发 beat 就被删掉

这个理解不算完全错，但它太粗糙了，粗糙到一旦你要写源码主线，就会把真正的 ownership、读写分离和事件链全写反。

在 Nacos 3.0.3 naming v2 里，更接近真实实现的表述其实是：

- 实例不是直接挂到 `Service` 上
- 实例先挂到某个 `Client` 的 `publishers` 上
- `ClientServiceIndexesManager` 再把 `Service -> clientIds` 的关系建起来
- `ServiceStorage` 再通过 index 反查 client 与 publishInfo，把 service 视图 materialize 出来
- beat 刷新的不是 service 租约，而是某个 `HealthCheckInstancePublishInfo.lastHeartBeatTime`
- 之后 unhealthy、expired、client release 三层清理才逐步把它从系统里收掉

也就是说，这条线的关键不是“有没有心跳”，而是：**ephemeral path 到底怎样把 HTTP/gRPC 请求落到 client-owned publish state、再怎样通过 event/index/read-model 投影成可见 service 视图，并在 beat 缺失时收敛到 unhealthy / expire / client release。**

先把结论放前面：Nacos 3.0.3 的 ephemeral path 不是“把 instance 挂到 service 上然后等心跳续租”，而是**先把实例挂到 client 的 `publishers` 上，再通过 `ClientRegisterServiceEvent -> ClientServiceIndexesManager -> ServiceStorage` 投影出 service 视图；heartbeat 刷新的不是 service TTL，而是 `HealthCheckInstancePublishInfo.lastHeartBeatTime`，随后由 unhealthy checker、expired checker、client manager cleanup 三层机制逐步收敛。**

## 二、先走四条失败的路

### 失败方案一：ephemeral 注册就是“向 service 添加一个 instance”

这是上一篇已经埋过的坑，但到了动态主线篇里，这个坑会再次诱惑你。

真实写路径并不是：

`service.add(instance)`

而是：

- 先确定 client
- 再 canonicalize service
- 再把 `Service -> InstancePublishInfo` 放进 client 的 `publishers`

`AbstractClient` 里明确持有：

- `publishers: Map<Service, InstancePublishInfo>`  
  `naming/core/v2/client/AbstractClient.java:46`

所以实例活跃状态的真正 owning side 是 client，不是 service。

### 失败方案二：heartbeat 只是续租，不会改变注册状态

beat 在很多系统里经常被抽象成“续一口租约”，所以很容易被低估。

但在 Nacos 里：

- beat 丢失会先触发 unhealthy
- 再继续拖下去才会触发 expire/delete
- 某些情况下，一个带完整内容的 beat 还可能触发“补注册”

这就意味着 beat 不只是续命动作，它是会驱动整个实例状态机变化的输入。

### 失败方案三：ephemeral 数据完全不碰 CP/一致性层

这条误解看起来很有道理，因为 ephemeral 主体确实是 AP / client-owned / in-memory 的。

但这只对实例主体成立，对 metadata 不成立。

在 3.0.3 里，instance metadata 更新走的是 `CPProtocol.write(...)` 路径，再由读路径 overlay 回实例视图。  
`naming/core/v2/metadata/NamingMetadataOperateService.java:85`  
`naming/core/v2/index/ServiceStorage.java:155`

所以更精确的说法不是“ephemeral 完全 AP”，而是：

- **instance body**：AP / in-memory / event-driven
- **metadata sidecar**：可以走 CP path

### 失败方案四：client 就等于一个连接

因为 gRPC 路径里经常看到 connectionId，所以很多人会把 client 直接理解成“一个长连接会话”。

但 HTTP 路径的 client 是 `ip:port#true` 这种 `IpPortBasedClient`。  
`naming/core/InstanceOperatorClientImpl.java:110`

gRPC 路径则更自然地走 connection-based client。  
`naming/remote/rpc/handler/InstanceRequestHandler.java:75`

所以“ephemeral”说的是实例/服务语义，不等于“client 必然是 connection-based”。

## 三、总图：register -> client-owned state -> indexes -> read model

先把这篇最关键的总图压出来：

```text
HTTP / gRPC register
    ↓
InstanceOperatorClientImpl / InstanceRequestHandler
    ↓
ClientOperationServiceProxy
    ↓
EphemeralClientOperationServiceImpl
    ↓
client.publishers[service] = InstancePublishInfo
    ↓
ClientRegisterServiceEvent
    ↓
ClientServiceIndexesManager
    ↓
ServiceChangedEvent
    ↓
ServiceStorage materialize ServiceInfo
```

这张图的关键不是“方法调用多”，而是 ownership 和投影关系：

- 写路径先改 client-owned state
- service 视图不是直接写出来的，而是后续投影出来的
- 事件链是把写路径和读路径接起来的桥

也就是说，ephemeral 主线不是“service 被写了一次”，而是“client state 被写入，再被 read model 反投影成 service view”。

## 四、register 入口：HTTP v2/v3 与 gRPC 收敛，但 clientId 来源不同

### 4.1 HTTP v3 register 入口

HTTP v3 的注册入口在 `InstanceControllerV3`。  
`naming/controllers/v3/InstanceControllerV3.java:100`

它最终会走到 `InstanceOperatorClientImpl.registerInstance(...)` 这条 façade。  
`naming/core/InstanceOperatorClientImpl.java:106`
`naming/core/InstanceOperatorClientImpl.java:108` 说明真正进入主线前会先做 `NamingUtils.checkInstanceIsLegal(instance)` 参数合法性校验。  

### 4.2 HTTP register 里的 clientId 是怎么来的

在 HTTP 路径里，`InstanceOperatorClientImpl` 会先按：

- `ip:port#ephemeral`

这种形态生成 `clientId`。  
`naming/core/InstanceOperatorClientImpl.java:109` 说明它会先取 `instance.isEphemeral()`。  
`naming/core/InstanceOperatorClientImpl.java:110` 说明 `clientId` 真正由 `IpPortBasedClient.getClientId(instance.toInetAddr(), ephemeral)` 生成。  

然后必要时创建一个 `IpPortBasedClient`，再继续往下走。  
`naming/core/InstanceOperatorClientImpl.java:111`、`:112`

这再次说明 HTTP 路径里的“发布者”是 server-side 伪造出来的地址型 client，而不是某个真实长连接对象。

### 4.3 gRPC register 入口

gRPC 路径则不同。`InstanceRequestHandler` 直接使用 `meta.getConnectionId()` 作为 clientId，并调用 `registerInstance(...)`。  
`naming/remote/rpc/handler/InstanceRequestHandler.java:58`  
`naming/remote/rpc/handler/InstanceRequestHandler.java:75`

所以两条入口虽然最终都汇入 `ClientOperationService`，但 owning client 的 identity 来源不同：

- HTTP：地址型 `IpPortBasedClient`
- gRPC：连接型 `ConnectionBasedClient`

## 五、真正落点：`ClientOperationServiceProxy` -> `EphemeralClientOperationServiceImpl`

### 5.1 先按 instance.isEphemeral() 分流

`ClientOperationServiceProxy` 的职责非常明确：

- 如果 `instance.isEphemeral()`，走 ephemeral service
- 否则走 persistent service

`naming/core/v2/service/ClientOperationServiceProxy.java:55`  
`naming/core/v2/service/ClientOperationServiceProxy.java:88`

所以 ephemeral path 的真正内核落点，不在 façade，而在 `EphemeralClientOperationServiceImpl`。

### 5.2 `EphemeralClientOperationServiceImpl.registerInstance(...)` 的关键顺序

这里的顺序必须讲清，不然 ownership 会写反。

它会先：

1. `ServiceManager.getSingleton(service)` 做 canonicalization  
   `naming/core/v2/service/impl/EphemeralClientOperationServiceImpl.java:59`
2. 校验 service 和 client 都必须是 ephemeral，禁止和 persistent 语义混用  
   `naming/core/v2/service/impl/EphemeralClientOperationServiceImpl.java:61`、`:62`
3. 取 client  
   `naming/core/v2/service/impl/EphemeralClientOperationServiceImpl.java:65`
4. 把 API `Instance` 转成 `InstancePublishInfo` 并挂到 client 的 `publishers` 里  
   `naming/core/v2/service/impl/EphemeralClientOperationServiceImpl.java:68`
5. 刷新 client 的 `lastUpdatedTime` 并重算 revision  
   `naming/core/v2/service/impl/EphemeralClientOperationServiceImpl.java:69`、`:70`
6. 发布关键事件  
   `naming/core/v2/service/impl/EphemeralClientOperationServiceImpl.java:71`

所以真正的 mutation 点不是 service，而是 client。

### 5.3 `AbstractClient.addServiceInstance(...)` 才是实例真正被“挂上去”的地方

client 内部的 `addServiceInstance(...)` 会：

- 更新 `publishers`
- 发 `ClientChangedEvent`

`naming/core/v2/client/AbstractClient.java:72`  
`naming/core/v2/client/AbstractClient.java:81`

这说明实例注册完成的最底层语义，其实是“某个 client 的发布状态表变了”。

## 六、写完 client-owned state 之后，怎样投影成可见 service 视图

### 6.1 `ClientRegisterServiceEvent` 先把索引立起来

`EphemeralClientOperationServiceImpl` 发出的关键事件之一，是 `ClientRegisterServiceEvent`。  
`naming/core/v2/service/impl/EphemeralClientOperationServiceImpl.java:71`

`ClientServiceIndexesManager` 会消费它，把 `service -> publisher clientIds` 的索引建起来。  
`naming/core/v2/index/ClientServiceIndexesManager.java:117`

### 6.2 再发 `ServiceChangedEvent`

索引建立后，它会继续发 `ServiceChangedEvent`：

- 第一次注册该 service：`ADD_SERVICE`
- 后续实例变化：`INSTANCE_CHANGED`

`naming/core/v2/index/ClientServiceIndexesManager.java:131`  
`naming/core/v2/index/ClientServiceIndexesManager.java:137`

所以从 service 视角看，“实例变化”并不是 service 直接被改，而是 event 把 client-side 改动投影成 service-level 变化。

### 6.3 `ServiceStorage` 才把 service 视图真正 materialize 出来

`ServiceStorage.getData(service)` 会：

1. 通过 index 找 publisher clientIds
2. 找到各个 client
3. 取出 `InstancePublishInfo`
4. 转成 API `Instance`
5. 再叠加 metadata
6. 最后拼成 `ServiceInfo`

`naming/core/v2/index/ServiceStorage.java:77`  
`naming/core/v2/index/ServiceStorage.java:106`  
`naming/core/v2/index/ServiceStorage.java:147`  
`naming/core/v2/index/ServiceStorage.java:155`

这一步再次证明：service 视图是反投影出来的，不是 service 对象自己直接持有 hosts 列表。

## 七、beat：不是续租，而是刷新 instance heartbeat time

### 7.1 beat 入口

HTTP beat 入口在 `InstanceControllerV2`。  
`naming/controllers/v2/InstanceControllerV2.java:381`

它最终走到 `InstanceOperatorClientImpl.handleBeat(...)`。  
`naming/core/InstanceOperatorClientImpl.java:231`

### 7.2 带完整 beat 的请求甚至可能触发补注册

这一点特别值得讲，因为它直接打脸“beat 只是续租”的直觉。

如果：

- client 不存在
- 或 client 尚未发布该 service
- 但 beat 请求里带了完整 beat 内容

服务端会先按 beat 内容补注册实例，再继续处理心跳。  
`naming/core/InstanceOperatorClientImpl.java:233`、`:234` 说明它会先按 namespace/group/serviceName 构造 canonical `Service` 和 `clientId`。  
`naming/core/InstanceOperatorClientImpl.java:237`、`:238` 说明它先判断 client 是否不存在或尚未发布该 service。  
`naming/core/InstanceOperatorClientImpl.java:241`、`:242` 说明它会用 beat 内容反建 `Instance` 并立刻走一次 `registerInstance(...)`。  

所以 beat 在某些边界场景下，不只是保活输入，还是“恢复注册状态”的触发器。

### 7.3 真正被刷新的是什么

heartbeat 最终不是在刷新 service TTL，而是通过 `ClientBeatProcessorV2` 去更新：

- `HealthCheckInstancePublishInfo.lastHeartBeatTime`

并在必要时把 `healthy` 改回 true。  
`naming/healthcheck/heartbeat/ClientBeatProcessorV2.java:56`、`:57`、`:58`、`:59`、`:60` 说明它会先从 beat 中拆出 ip/port/service/group，再重建 canonical `Service`。  
`naming/healthcheck/heartbeat/ClientBeatProcessorV2.java:61`、`:62` 说明它按 service 从 client 的 publish state 里找目标实例。  
`naming/healthcheck/heartbeat/ClientBeatProcessorV2.java:66` 说明 heartbeat 真正刷新的就是 `lastHeartBeatTime`。  
`naming/healthcheck/heartbeat/ClientBeatProcessorV2.java:67`、`:68`、`:71`、`:72`、`:73` 说明只有实例此前 unhealthy 时，它才会把健康状态拉回并补发 service/client/trace 事件。  

这就是为什么我前面一直强调：ephemeral 主线必须按 instance publish state 去理解，而不是按 service 租约去理解。

## 八、三层收敛链：unhealthy -> expired -> client release

### 8.1 第一层：unhealthy

`ClientBeatCheckTaskV2` 会周期性遍历 client 发布的所有实例。  
`naming/healthcheck/heartbeat/ClientBeatCheckTaskV2.java:44`、`:45`、`:46` 说明 task 本身先绑定到一个具体 `IpPortBasedClient` 及其 `responsibleId`。  
`naming/healthcheck/heartbeat/ClientBeatCheckTaskV2.java:55`、`:56` 说明 task key 也是基于 client 维度生成的，而不是 service 维度。  
`naming/healthcheck/heartbeat/ClientBeatCheckTaskV2.java:67`、`:68`、`:69`、`:71` 说明它遍历的是这个 client 已发布的全部 service/instance，并把每个实例包装成 `InstanceBeatCheckTask` 交给 interceptor chain。  

其中 `UnhealthyInstanceChecker` 会根据 `HEART_BEAT_TIMEOUT` 判断实例是不是应该先变成 unhealthy。这个超时阈值还支持：

- metadata 覆盖
- publishInfo.extendDatum 覆盖
- 最后再退回默认值

`naming/healthcheck/heartbeat/UnhealthyInstanceChecker.java:49`  
`naming/healthcheck/heartbeat/UnhealthyInstanceChecker.java:60`  
`naming/healthcheck/heartbeat/UnhealthyInstanceChecker.java:79`

所以第一层收敛不是删掉实例，而是先把它从“可用实例”降成“不健康实例”。

### 8.2 第二层：expired

`ExpiredInstanceChecker` 则更进一步：如果超过 `IP_DELETE_TIMEOUT`，就直接删掉这个实例。  
`naming/healthcheck/heartbeat/ExpiredInstanceChecker.java:52`

真正的删除动作不是改 service，而是：

- `client.removeServiceInstance(service)`

然后再发：

- `ClientDeregisterServiceEvent`
- `InstanceMetadataEvent(..., expired=true)`
- `DeregisterInstanceTraceEvent(reason=HEARTBEAT_EXPIRE)`

`naming/healthcheck/heartbeat/ExpiredInstanceChecker.java:78`  
`naming/healthcheck/heartbeat/ExpiredInstanceChecker.java:79`

这说明“实例过期”仍然是沿着 client-owned state 这条线在删，而不是从 service 树上摘下来。

### 8.3 第三层：client release

还有第三层更上游的清理：`EphemeralIpPortClientManager` 自己也会周期性扫描 client，如果某个 client 整体太久没更新，就直接 `clientDisconnected(clientId)`。  
`naming/core/v2/client/manager/impl/EphemeralIpPortClientManager.java:63`  
`naming/core/v2/client/manager/impl/EphemeralIpPortClientManager.java:90`

之后它会：

- 发布 `ClientDisconnectEvent`
- 发布 `ClientReleaseEvent`
- `client.release()` 取消 beat-check task

`naming/core/v2/client/manager/impl/EphemeralIpPortClientManager.java:97`  
`naming/core/v2/client/impl/IpPortBasedClient.java:103`

所以完整收敛链是：

- **实例层**：unhealthy
- **实例层**：expired / deregister
- **client 层**：client release

三层不是一回事。

## 九、metadata sidecar：为什么 ephemeral 主体是 AP，但 metadata 还能走 CP

### 9.1 publishInfo 本身就带一部分内嵌元信息

`ClientOperationService.getPublishInfo(...)` 在把 API `Instance` 转成 `InstancePublishInfo` 时，就会把：

- metadata
- custom instanceId
- weight
- enabled
- cluster

这些东西写进 `extendDatum`。  
`naming/core/v2/service/ClientOperationService.java:96`

这部分可以理解成“实例发布时自带的内嵌元信息”。

### 9.2 但 `/instance/update` 改的不是这一块对象本身

后续管理操作走的是另一条线：

- `NamingMetadataOperateService`
- `CPProtocol.write(...)`
- `InstanceMetadataProcessor`
- `NamingMetadataManager`

`naming/core/v2/metadata/NamingMetadataOperateService.java:85`  
`naming/core/v2/metadata/InstanceMetadataProcessor.java:107`

所以 metadata 不是一直原地改 `publishers` 里的对象，而是走独立 sidecar 存储与一致性路径。

### 9.3 读路径再 overlay 回来

`ServiceStorage.parseInstance(...)` 会先从 publishInfo 还原实例，再通过 `NamingMetadataManager.getInstanceMetadata(...)` 做 overlay。  
`naming/core/v2/index/ServiceStorage.java:155`

这就是为什么我前面说：ephemeral path 是 **AP instance body + CP metadata sidecar** 的混合模型。

## 十、误解澄清

### 误解一：ephemeral 注册就是 service 挂一个 instance

不是。真正的 mutation 点在 client 的 `publishers`。

### 误解二：heartbeat 只是续租，不改变状态

不是。beat 缺失会先 unhealthy，再 expired；某些 beat 还可能触发补注册。

### 误解三：ephemeral 完全不碰 CP

不是。实例主体是 AP，但 metadata sidecar 可以走 CP。

### 误解四：client 就等于连接

不是。HTTP 侧可以是 `IpPortBasedClient`，gRPC 侧可以是 `ConnectionBasedClient`。

### 误解五：实例消失就是一个 delete 动作

不是。至少有 unhealthy、expired、client release 三层收敛链。

## 十一、收网总结：ephemeral 主线不是“service 续租”，而是“client 持状态，event 投影服务视图，heartbeat 驱动三层收敛”

回到开头的问题：Nacos ephemeral path 到底怎样工作？

答案不是“向 service 注册 instance，再不断续租”，而是：

- 先把实例挂到 client 的 `publishers` 上
- 再通过 `ClientRegisterServiceEvent -> ClientServiceIndexesManager -> ServiceStorage` 投影成 service 视图
- beat 刷新的是 instance heartbeat time
- unhealthy、expired、client release 再逐层把它收走
- metadata 则通过独立 sidecar 通道叠回读路径

把整篇压成三句话：

1. ephemeral 实例不是直接住在 service 下，而是先住在 client 的 `publishers` 里。  
2. service 可见视图是通过 index 和 `ServiceStorage` 反投影出来的，不是原地持有。  
3. heartbeat 驱动的是 `unhealthy -> expired -> client release` 三层收敛，而 metadata 则走独立 sidecar 路径。  
