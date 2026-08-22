# Dubbo：Metadata、MetadataReport 与元数据服务

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：Dubbo 里的 metadata 到底是什么

如果你第一次顺着 Dubbo 3 的控制面往下读，很容易被 `metadata` 这个词弄糊涂。

有时候它指的是服务定义：接口、方法、参数。  
有时候它指的是应用级快照：这个应用当前暴露了哪些服务。  
有时候它又指 service instance 上的 revision、storage type。  
还有时候，它甚至是在做 interface -> application 的映射。

这就带来一个最直接的困惑：Dubbo 里的 metadata 到底是一个对象、一个中心、一个服务，还是一整套基础设施？

如果你只把它理解成“服务描述文档”，那会解释不了为什么 application-level discovery、migration、metadata service RPC、metadata center 这些完全不同的功能，最后都绕到 metadata 上来。

更准确的说法是：**Dubbo metadata 不是一个点，而是一条链。** 它把 provider 已暴露的服务折叠成应用级快照，再决定这份快照往哪里存、怎么被取回，以及如何反哺服务发现和治理平面。

## 二、前情回顾：前面几篇已经讲了控制面，这一篇讲它们共享的基础设施

在 `RegistryDirectory` 那篇里，我们已经知道地址变化怎样进入 live invoker。  
在 migration 那篇里，我们也看过 application-level discovery 如何通过 metadata 和 mapping 把 app instance 重新翻译回接口服务。  
在 config center 那篇里，我们则看过 configurator 如何在地址不变时改写 URL 语义。

这几篇都在“用” metadata，但还没有把 metadata 自己当主角拉出来。

这一篇不再重讲发现模型和地址更新，而是问：**为什么这些控制面机制最后都要依赖 metadata 这块基础设施。**

## 三、先走三条失败的路

### 失败方案一：metadata 就是一份服务定义文档

如果只这么理解，那 metadata 最多只能解释 provider 的接口描述是怎么存的，解释不了：

- application-level discovery 为什么要用它  
- service instance 为什么要带 metadata revision  
- consumer 为什么有时通过 metadata center 拉 metadata，有时又通过 metadata service RPC 去取

这说明 metadata 不是一份静态文档，而是 Dubbo 控制面的一块共享运行时基础设施。

### 失败方案二：有了 metadata center，就不需要 metadata service RPC

这也不对。

Dubbo 的 consumer 获取远端 metadata 时，不是永远走一个 backend。它会根据 metadata storage type、当前路径和能力选择：

- 直接从 metadata center 取  
- 或 refer 远端的 metadata service，再走 RPC 拿

所以 metadata center 和 metadata service 不是重复建设，而是两种 retrieval 策略。

### 失败方案三：metadata 更新后，consumer 立刻就会像新模型一样工作

这和 migration 那篇里的误判是同构的。metadata 变化只是新路径的输入之一，后面还要经过 service-name mapping、instance listener、`serviceUrls` 重建、directory notify 和 migration 当前生效子树选择。

所以 metadata 变化是必要条件，不是立刻生效的充分条件。

## 四、最小总图：metadata 的三层关系

```text
provider export / registry register
    ↓
MetadataInfo（应用级服务快照 + revision）
    ↓
MetadataReport / MetadataService
    ↓
consumer retrieval
    ↓
service discovery / migration / introspection / governance
```

这里有三个层次必须切开：

- **MetadataInfo**：存什么  
- **MetadataReport**：往哪里存、怎么取  
- **MetadataService**：如果不走中心存储，provider 自己怎么把 metadata 暴露出去  

后面所有代码都可以按这三层去归位。

## 五、`MetadataInfo`：为什么它是应用级快照，而不是一条条服务记录

### 5.1 `MetadataInfo` 的核心不是“描述一个服务”

`MetadataInfo` 维护的是应用级元数据快照。它内部核心状态包括应用名、revision、serviceInfos 等，不是单条服务记录。

`MetadataInfo.java:62` — MetadataInfo 核心状态

provider 暴露每个服务时，不是立刻向外发布一条离散 metadata 记录，而是先把服务折到这个应用级快照里。

`MetadataInfo.java:146` — `addService(...)`

### 5.2 为什么要做 revision

当服务快照发生变化时，Dubbo 会重新计算 revision。这个 revision 再被挂到 service instance metadata 上，供 consumer 判断“现在看到的是哪一版应用快照”。

`MetadataInfo.java:186` — revision 计算

这一层很重要，因为 application-level discovery 不会按接口逐条推送变化，它更像是“这个应用的服务快照现在变到第几版了”。

## 六、`MetadataReport`：metadata 存哪里、怎么被取回

### 6.1 `MetadataReport` 不是 registry

`MetadataReport` 是一个 SPI，它同时承载三类事情：

- service definition 存储  
- app metadata（`MetadataInfo`）发布 / 读取  
- interface -> application mapping

`MetadataReport.java:33` — MetadataReport SPI

它和 registry 的区别在于：registry 负责 provider 地址通知，metadata report 负责描述性信息和映射，不直接承载 live 地址通知。

### 6.2 `AbstractMetadataReport`：通用存取语义

`AbstractMetadataReport` 里已经把大量共性逻辑收了：

- cache  
- retry  
- report 行为开关  
- provider/service definition 存储  
- app metadata 保存

`AbstractMetadataReport.java:84` — 通用 report 逻辑
`AbstractMetadataReport.java:289` — service definition store
`AbstractMetadataReport.java:388` — service metadata save

这说明 metadata center backend 的差异更多是在“怎么存”，不是在“存什么”。

## 七、provider 侧：metadata 是什么时候被聚合和发布的

### 7.1 服务暴露后，先更新应用快照

provider 侧的 `AbstractServiceDiscovery.register(URL)` 会把导出的服务 URL 聚合进当前 `MetadataInfo`。随后更新 revision，再决定是否把 app metadata 上报到 metadata report。

`AbstractServiceDiscovery.java:155` — register service instance
`AbstractServiceDiscovery.java:379` — revision 更新
`AbstractServiceDiscovery.java:390` — publish app metadata

这里最关键的一点是：metadata 发布不是独立于 export 主线存在的，它依赖 provider 已经暴露的服务结果，再把这些结果折叠成应用级快照。

### 7.2 服务定义发布是另一条平行链

除了 app metadata，Dubbo 还会单独发布 service definition。它更多服务于 introspection 和治理侧理解“这个接口是什么”，而不是直接服务于 live 地址更新。

`MetadataUtils.java:77` — publish service definition

所以 provider 侧 metadata 至少有两条发布链：

- 面向应用级发现的 app metadata  
- 面向描述与治理的 service definition

### 7.3 metadata service RPC 也可能被 export

如果当前模式需要，provider 还会导出 metadata service。本质上这是另一种“让别人来取 metadata”的通道。

`ExporterDeployListener.java:80` — metadata service export 触发
`ConfigurableMetadataServiceExporter.java:113` — export V1
`ConfigurableMetadataServiceExporter.java:138` — export V2

所以 provider 对 metadata 的工作并不只是一句“发给中心”，还可能包含“把元数据服务暴露成 RPC 接口”。

## 八、consumer 侧：metadata 是怎么被取回来的

### 8.1 统一入口：`MetadataUtils.getRemoteMetadata(...)`

consumer 侧最终取 metadata 的统一入口在 `MetadataUtils.getRemoteMetadata(...)`。

`MetadataUtils.java:242` — getRemoteMetadata

但它不会永远走同一条路径。

### 8.2 两条 retrieval 策略

如果 metadata storage type 是 remote，consumer 可以直接从 metadata report 取 app metadata：

`MetadataUtils.java:287` — metadata center retrieval

如果不是 remote，或者当前路径需要走 provider 侧的 metadata service，则会 refer 对方的 metadata service，再通过 RPC 拉取：

`MetadataUtils.java:134` — metadata service refer

所以 metadata retrieval 的真正结构是：

```text
consumer
  ├─ metadata center 取
  └─ metadata service RPC 取
```

### 8.3 为什么需要两条 retrieval 链

因为 Dubbo 既要支持“有独立 metadata center”的部署，也要支持“没有中心时，直接问 provider 要 metadata”的部署。

这不是重复实现，而是为了让 metadata 既能成为控制面的中心化支撑，也能在没有中心时仍然可达。

## 九、metadata 为什么会反哺 application-level discovery

### 9.1 `ServiceDiscoveryRegistry` 依赖 metadata

`ServiceDiscoveryRegistry` 的类注释已经很明确：它要把旧的接口级服务发现桥接到新的 service-discovery 模型，而这个桥接依赖 `ServiceNameMapping` 和 metadata。

`ServiceDiscoveryRegistry.java:63` — old/new model bridge

### 9.2 mapping 和 instance metadata 是两块拼图

一边是 `MetadataServiceNameMapping` 把接口映射到 application；另一边是 service instance 上的 metadata revision 和 app metadata 快照。两块拼起来，consumer 才能从“某接口”一路找到“哪些 app 实例能提供它”。

`MetadataServiceNameMapping.java:79` — publish mapping
`MetadataServiceNameMapping.java:171` — subscribe mapping

这说明 metadata 在 Dubbo 里不只是“描述”，而是 discovery 能否成立的一块基础设施。

## 十、误解澄清

### 误解一：metadata 就是一份服务定义文档

不是。它至少同时承担服务定义、应用快照、instance metadata、interface->application mapping 四类角色。

### 误解二：metadata center 就等于 registry

不是。registry 管地址，metadata center 管描述和映射。

### 误解三：有了 metadata center，就不会再走 metadata service RPC

不一定。consumer retrieval 仍可能走 provider 侧 metadata service。

### 误解四：metadata 更新后，service discovery 就会立刻像新模型一样工作

不是。它还要经过 mapping、instance listener、`serviceUrls` 重建和 migration 当前生效子树选择。

### 误解五：metadata 只是治理层附属件，不影响运行时

不对。application-level discovery、migration 和 service instance 视图都直接依赖它。

## 十一、收网总结：metadata 是 Dubbo 控制面的共享基础设施

回到开头的问题：Dubbo 里的 metadata 到底是什么？

最准确的答案不是“一个对象”，而是“一块共享基础设施”。它把 provider 侧已经暴露的服务折叠成应用级快照，再通过 metadata center 或 metadata service RPC 让 consumer 和控制面把这些描述重新取回来。

所以 Dubbo metadata 真正的三层关系是：

- `MetadataInfo`：存什么  
- `MetadataReport`：往哪存、从哪取  
- `MetadataService`：没有中心时怎样用 RPC 取  

**三句话总结：**

1. metadata 在 Dubbo 里不只是服务定义文档，而是 app-level discovery、migration 和治理平面的共同基础设施。  
2. provider 侧先把已暴露服务折叠成 `MetadataInfo` 快照，再决定是上报到 metadata center，还是通过 metadata service 对外暴露。  
3. consumer 侧取到 metadata，只说明输入更新了；真正要影响运行时，还要继续经过 mapping、directory、migration 这些链条。  

**下篇说明：** 到这里，Dubbo 控制面已经有 registry、migration、dynamic override、metadata 四篇，可以作为一组完整闭环使用。