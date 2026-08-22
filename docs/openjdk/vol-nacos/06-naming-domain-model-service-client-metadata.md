# Nacos：naming domain model——service / client / metadata / indexes

> 基于 Nacos 3.0.3 naming v2

## 一、困惑开场：为什么“service 下面挂很多 instance”这个直觉会误导你

一说注册中心，大多数人脑子里都会自动浮现一个特别顺手的模型：

- 一个 `service`
- 下面挂很多 `instance`
- 实例上下线、心跳、订阅通知，都是围着这棵 service 树打转

这个模型在很多场景下足够用来讲“注册中心是干嘛的”，但一旦你真的走进 Nacos 3.0.3 naming v2 源码，它会很快开始误导你。

因为在 naming v2 里，真正的对象关系并不是：

`Service -> [Instance, Instance, Instance]`

而更接近：

- `ServiceManager` 维护 canonical `Service`
- `Client` 持有 publish/subscriber state
- `ClientServiceIndexesManager` 建反向索引
- `NamingMetadataManager` 挂 metadata sidecar
- `ServiceStorage` 再把这些拼成对外可读的 `ServiceInfo`

也就是说，**service 不是 live instance 容器，client 才是 live publish/subscription state 的拥有者。**

这篇真正要回答的问题不是“有哪些类”，而是：**naming v2 的真实静态对象图到底怎么组织，为什么 `ServiceManager` 是 canonicalization center，service identity 和 instance identity 又分别是什么。**

先把结论放前面：Nacos naming v2 不是“service 直接存 instance”的对象树，而是**canonical `Service` 身份节点 + client-owned 发布/订阅状态 + metadata sidecar + reverse indexes + materialized read model**。`ServiceManager` 负责 canonical service identity，`Client` 负责 live publication/subscription，`ServiceStorage` 负责对外读模型。

## 二、先走四条失败的路

### 失败方案一：service 直接持有 live instances

这是最自然、也最危险的误解。

如果这个模型成立，那么你会期待：

- `Service` 内部直接有 instance 列表
- 注册请求直接把 instance 塞进 service
- 订阅读取直接从 service 身上拿 instance

但 naming v2 真实情况不是这样。

`Client` 抽象自己就把话说得很清楚：它是 server-side 对“谁发布了什么、谁订阅了什么”的抽象。  
`naming/core/v2/client/Client.java:28`

而 `AbstractClient` 里真正持有的是：

- `publishers: Map<Service, InstancePublishInfo>`  
  `naming/core/v2/client/AbstractClient.java:46`
- `subscribers: Map<Service, Subscriber>`  
  `naming/core/v2/client/AbstractClient.java:48`

这意味着 live publication/subscription state 的拥有者是 `Client`，不是 `Service`。

### 失败方案二：`ServiceStorage` 是 source of truth

另一个很容易出现的误解，是把 `ServiceStorage` 看成 naming 的权威存储。

但从名字和实现都能看出来，它更像读模型装配器。

它本身不拥有“真相”，而是把：

- service 相关 client ids
- 每个 client 的 publish info
- metadata

重新组装成 API-facing 的 `ServiceInfo`。  
`naming/core/v2/index/ServiceStorage.java:51`  
`naming/core/v2/index/ServiceStorage.java:106`

所以 `ServiceStorage` 是 materialized read model，不是 truth store。

### 失败方案三：cluster 是一个和 service 并列的顶级聚合

在很多注册中心心智里，cluster 很容易被当成一个顶级业务对象。

但在 Nacos naming v2 里，`cluster` 更像 service-scoped metadata。

`ServiceMetadata` 里直接就有：

- `Map<String, ClusterMetadata> clusters`

`naming/core/v2/metadata/ServiceMetadata.java:53`

这说明 cluster 不是独立根聚合，而是挂在 service metadata 下面的一层作用域。

### 失败方案四：service identity 包含 ephemeral / persistent 维度

`Service` 对象里确实有 `ephemeral` 字段，这特别容易让人误会它属于 service identity 本身。

但 `Service.equals()` / `hashCode()` 真正参与等价判断的只有：

- `namespace`
- `group`
- `name`

`naming/core/v2/pojo/Service.java:105`  
`naming/core/v2/pojo/Service.java:118`

也就是说，service identity 和 registration path 的语义不是同一回事。这个差别如果不先立住，后面 ephemeral/persistent 两篇会很难写清楚。

## 三、先立 naming v2 总图：canonical service + client-owned state + metadata + indexes + read model

在 naming v2 里，最稳的总图不是“service 树”，而是下面这张：

```text
ServiceManager
    - canonical Service singleton
    ↓
ClientManagerDelegate
    - ConnectionBasedClient / IpPortBasedClient / PersistentIpPortClient
    ↓
Client
    - publishers: Service -> InstancePublishInfo
    - subscribers: Service -> Subscriber
    ↓
ClientServiceIndexesManager
    - Service -> publisher clientIds
    - Service -> subscriber clientIds
    ↓
NamingMetadataManager
    - Service -> ServiceMetadata
    - Service -> metadataId -> InstanceMetadata
    ↓
ServiceStorage
    - materialize ServiceInfo for read side
```

这张图里最关键的，不是“类多”，而是 ownership：

- `Service` 负责逻辑身份
- `Client` 负责运行中的 publish/subscription state
- `metadata` 负责 sidecar 配置与实例附加属性
- `indexes` 负责从 service 反查 client
- `ServiceStorage` 负责把它们拼成最终读模型

一旦这张图立住，后面 heartbeat、ephemeral cleanup、persistent path、push 通知链都会好写很多，因为你知道它们到底作用在什么对象上。

## 四、三层身份：service identity、client identity、instance metadata identity

这一节必须先钉住，否则后面的 register/subscribe 全会写混。

### 4.1 service identity

`Service` 是 naming v2 里的 canonical 逻辑身份对象。

它的核心字段包括：

- `namespace`
- `group`
- `name`
- `ephemeral`
- revision / timestamps

`naming/core/v2/pojo/Service.java:35`  
`naming/core/v2/pojo/Service.java:41`  
`naming/core/v2/pojo/Service.java:43`

但要记住，真正的等价身份并不包含 `ephemeral`。  
`naming/core/v2/pojo/Service.java:105`  
`naming/core/v2/pojo/Service.java:118`

同时，它还有两个很实用的名字拼接辅助：

- grouped name：`group@@service`  
  `naming/core/v2/pojo/Service.java:96`
- namespaced grouped rendering 相关组合  
  `naming/core/v2/pojo/Service.java:100`

所以 service identity 的本质可以压成一句话：**namespace + group + serviceName 的 canonical key。**

### 4.2 client identity

server-side `Client` 不是 SDK client 对象，而是服务端对“发布者/订阅者”会话或来源的抽象。

其具体 identity 又有不同变体。

#### `IpPortBasedClient`

这是基于地址的 client，id 形态接近：

- `address#ephemeral`

`naming/core/v2/client/impl/IpPortBasedClient.java:69`

它更适合 openAPI/beat 这类按地址建模的路径。

#### `ConnectionBasedClient`

这是基于连接的 client，id 直接和 connection 绑定，并且从 naming 模型视角始终是 ephemeral。  
`naming/core/v2/client/impl/ConnectionBasedClient.java:56`

所以 client identity 描述的是“谁拥有这份发布/订阅状态”，不是“这个 service 叫什么”。

### 4.3 instance metadata identity

`InstancePublishInfo` 是 server 内部保存的发布实例载荷，不是最终 API `Instance`。

它的字段里至少有：

- `ip`
- `port`
- `healthy`
- `cluster`
- `extendDatum`

`naming/core/v2/pojo/InstancePublishInfo.java:35`

而它的 metadata identity 由：

- `ip:port:cluster`

形成。  
`naming/core/v2/pojo/InstancePublishInfo.java:94`  
`naming/core/v2/pojo/InstancePublishInfo.java:126`

这一步非常关键，因为它说明 instance identity 也不是单层的：

- 归属关系要看是哪个 client 发布的
- metadata 归档又要看 `ip/port/cluster`

## 五、`ServiceManager`：为什么它是 canonicalization center

### 5.1 它真正管理什么

`ServiceManager` 里最重要的不是方法多，而是两张表：

- `singletonRepository: ConcurrentHashMap<Service, Service>`  
  `naming/core/v2/ServiceManager.java:38`
- `namespaceSingletonMaps: ConcurrentHashMap<String, Set<Service>>`  
  `naming/core/v2/ServiceManager.java:40`

这已经明确暴露了它的定位：**service canonicalization hub**。

### 5.2 `getSingleton()` 才是 naming v2 的真正入口动作之一

`ServiceManager.getSingleton(service)` 的意义不是“帮你查一下 service”，而是：

- 如果这个逻辑 service 已经存在，就返回现有 canonical object
- 如果不存在，就把传入对象作为第一个 canonical instance 放进去
- 并触发 service metadata 相关事件

`naming/core/v2/ServiceManager.java:61`  
`naming/core/v2/ServiceManager.java:63`

这一步非常关键，因为 `Service.equals()` 忽略 `ephemeral`，所以“第一个被 canonicalize 的 service 对象”会决定后续统一看到的那份 service 身份对象。

### 5.3 为什么后续一切都要先过 `ServiceManager`

如果没有 canonical service identity：

- client maps 的 key 会散
- metadata maps 的 key 会散
- index 层会散
- event 也会散

所以 naming v2 的第一稳定动作不是“把 instance 注册到 service”，而是**先把 service canonicalize**。

## 六、`Client`：为什么 live publish/subscription state 属于 client

### 6.1 `Client` 的职责声明已经很直白

`Client.java` 自己就说得很清楚：它是服务端对“谁发布了什么、谁订阅了什么”的抽象。  
`naming/core/v2/client/Client.java:28`

所以它不是 SDK facade，而是服务端状态拥有者。

### 6.2 `AbstractClient` 里真正拥有的状态

`AbstractClient` 里两张图最关键：

- `publishers: Service -> InstancePublishInfo`  
  `naming/core/v2/client/AbstractClient.java:46`
- `subscribers: Service -> Subscriber`  
  `naming/core/v2/client/AbstractClient.java:48`

这说明：

- 发布和订阅都首先是 client-owned state
- service 只是这些状态指向的逻辑身份节点

### 6.3 `ClientManagerDelegate` 为什么重要

`ClientManagerDelegate` 不是一个普通 façade，它负责按 client id 形态把请求路由给不同 client manager。  
`naming/core/v2/client/manager/ClientManagerDelegate.java:42`

这一步意味着 naming v2 的 client abstraction 不是单一实现，而是：

- connection-based
- ephemeral ip-port based
- persistent ip-port based

共享一套上层语义，但后端管理策略可以不同。

## 七、`ClientServiceIndexesManager` + `ServiceStorage`：反向索引与读模型装配

### 7.1 为什么需要反向索引

如果 live state 全挂在 client 上，那么读 service 视图时就会遇到一个问题：

- 已知 service
- 但不知道有哪些 client 正在发布它、订阅它

这就是 `ClientServiceIndexesManager` 存在的意义。它维护：

- `Service -> publisher clientIds`
- `Service -> subscriber clientIds`

`naming/core/v2/index/ClientServiceIndexesManager.java:49`  
`naming/core/v2/index/ClientServiceIndexesManager.java:51`

### 7.2 `ServiceStorage` 不是存，而是装

`ServiceStorage` 的真正价值，在于它把：

- service
- publisher client ids
- client objects
- `InstancePublishInfo`
- metadata

装成一个 API-facing `ServiceInfo`。  
`naming/core/v2/index/ServiceStorage.java:77`  
`naming/core/v2/index/ServiceStorage.java:87`

### 7.3 materialize 路径为什么是 naming v2 的关键

真正的 read path 是：

1. 从 service 出发
2. 通过 indexes 找 client ids
3. 拿 client
4. 拿 publish info
5. 转成 API `Instance`
6. 再 merge `InstanceMetadata`
7. 产出 `ServiceInfo`

`naming/core/v2/index/ServiceStorage.java:106`  
`naming/core/v2/index/ServiceStorage.java:147`  
`naming/core/v2/index/ServiceStorage.java:155`

所以 `ServiceStorage` 是 materialized read model，这一点如果不先立住，后面很多读路径分析都会写歪。

## 八、`NamingMetadataManager`：service metadata 与 instance metadata 都是 sidecar

### 8.1 metadata 不是 service 自带字段的大杂烩

`NamingMetadataManager` 管的是两类 sidecar：

- `Service -> ServiceMetadata`
- `Service -> metadataId -> InstanceMetadata`

`naming/core/v2/metadata/NamingMetadataManager.java:48`  
`naming/core/v2/metadata/NamingMetadataManager.java:50`

这说明 metadata 不是直接塞在 service 对象里一把梭，而是独立侧挂层。

### 8.2 `ServiceMetadata` 说明 cluster 只是 service-scoped metadata

`ServiceMetadata` 里有：

- service-level config
- selector
- threshold
- `clusters`

`naming/core/v2/metadata/ServiceMetadata.java:36`  
`naming/core/v2/metadata/ServiceMetadata.java:44`  
`naming/core/v2/metadata/ServiceMetadata.java:49`  
`naming/core/v2/metadata/ServiceMetadata.java:53`

这里最值得强调的就是：cluster 是 service-scoped metadata，不是独立顶级聚合。

### 8.3 `InstanceMetadata` 是实例附加侧写

`InstanceMetadata` 则保存：

- weight
- enabled
- extendData

`naming/core/v2/metadata/InstanceMetadata.java:35`

所以真正对外看到的 API `Instance`，其实是：

- `Service` 的逻辑身份
- `InstancePublishInfo` 的运行态字段
- `InstanceMetadata` 的附加侧写

三者拼出来的。

## 九、静态对象图收束：先有 canonical service，再有 live state，再有读模型

到这里，可以把 naming v2 的静态对象图压成一句稳定的人话：

- `ServiceManager` 管 canonical `Service`
- `ClientManagerDelegate` 管各种 `Client`
- `Client` 管发布/订阅状态
- `ClientServiceIndexesManager` 做 `Service -> clients` 反查
- `NamingMetadataManager` 管 metadata sidecar
- `ServiceStorage` 最终把这些 materialize 成 `ServiceInfo`

所以 naming v2 真正的静态对象图不是“service 树”，而是：

**canonical identity + ownership state + sidecar metadata + reverse indexes + read model**

这也是为什么后续几篇必须分开写：

- ephemeral 篇：讲这些对象怎么随着心跳/清理变化
- persistent 篇：讲这些对象怎么通过 CP 路径落盘/回放
- push 篇：讲这些对象变化后怎么推到订阅者视图

## 十、误解澄清

### 误解一：service 直接持有 live instances

不是。live publish state 挂在 `Client.publishers` 上。

### 误解二：`Client` 是 SDK 客户端对象

不是。这里的 `Client` 是 server-side 状态拥有者。

### 误解三：`ServiceStorage` 是 source of truth

不是。它是 materialized read model。

### 误解四：cluster 是和 service 并列的顶级聚合

不是。cluster 落在 `ServiceMetadata.clusters` 中。

### 误解五：service identity 包含 ephemeral/persistent

不是。`Service.equals/hashCode` 只看 `namespace/group/name`。

## 十一、收网总结：naming v2 的核心不是“service 存 instance”，而是“service 定身份，client 持状态，storage 出读模型”

回到开头的问题：Nacos naming v2 的真实对象图到底是什么？

答案不是“一个 service 下面挂很多 instance”，而是：

- `ServiceManager` 维护 canonical `Service`
- `Client` 维护 live publish/subscription state
- `NamingMetadataManager` 提供 metadata sidecar
- `ClientServiceIndexesManager` 建 service 到 client 的反向索引
- `ServiceStorage` 再把这一切装成对外可读的 `ServiceInfo`

把整篇压成三句话：

1. naming v2 里，`Service` 负责逻辑身份，`Client` 负责 live state，两者不是同一个层面的对象。  
2. `ServiceStorage` 不是 truth store，而是把 indexes、clients、publish info、metadata 拼成 `ServiceInfo` 的 materialized read model。  
3. 后续 ephemeral / persistent / push 篇，本质上都是在这张静态对象图上解释动态变化链。  
