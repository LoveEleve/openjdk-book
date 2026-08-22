# Dubbo：Service Discovery / Migration 机制

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：为什么迁移不会直接替换 proxy

如果你从 Dubbo 2.x 的注册发现模型走过来，最容易把“迁移”理解成一个配置开关：

- 旧模式：接口级地址发现  
- 新模式：应用级服务发现  
- 配置一改，consumer 从旧模式切到新模式

但真正进到 Dubbo 3 的源码里，你会发现完全不是这么回事。

consumer 拿到的业务 proxy 并不会因为切换发现模型就被重新替换。它背后挂着的是一层更隐蔽的壳：`MigrationInvoker`。旧路径和新路径不是二选一地瞬间替换，而是可能在一段时间里同时存在，再由规则和比较器决定“当前更应该走哪一边”。

这就是本文要回答的核心问题：**Dubbo 的迁移为什么不是“换地址源”，而是“在不换业务入口的前提下切换底层 invoker 子树”。**

## 二、前情回顾：上一页讲的是单链更新，这一页讲的是双链切换

在控制面第一篇里，我们已经看过传统 registry 视角下的更新链：`RegistryProtocol.refer()` 创建 Directory，registry notify 分桶，provider/router/configurator 更新最终变成 live invokers。

那一篇默认的前提是：consumer 的地址模型还是“接口级 provider URL 视图”。也就是 `RegistryDirectory` 那条传统链。

这一篇要补的是 Dubbo 3 的另一半：当发现模型变成“先找应用实例，再从 metadata 里还原接口服务”时，consumer runtime 是怎么在新旧两条路径之间切换的。也就是说，上一页讲的是**一条地址更新链怎么工作**，这一页讲的是**两条地址更新链怎么共存和切换**。

所以本篇不是 registry 篇的补丁，而是更高一层的控制面篇：它讨论的不是“新地址怎样流进同一条链”，而是“同一个业务入口下，底层到底该接哪一条链”。

## 三、先走三条失败的路

### 失败方案一：迁移就是启动时选一个模式，后面不再变化

如果迁移只是一个启动期开关，那就不需要 `MigrationRuleListener`、`MigrationRuleHandler`，也不需要 `MigrationInvoker` 这种运行时壳。consumer 在 refer 时选好一种模式，后面一直走下去就够了。

但 Dubbo 的实现不是这样。规则变化可以在运行期再次触发 migration；`APPLICATION_FIRST` 甚至允许旧路径和新路径同时保留，再按比较器结果和流量比例逐步倾斜。

所以迁移不是“启动时拍板”，而是一个控制面持续驱动的运行时切换过程。

### 失败方案二：应用级服务发现只是把 provider URL 换成另一种地址格式

如果只是换一种地址格式，那么 `RegistryDirectory` 和 `ServiceDiscoveryRegistryDirectory` 就没有必要同时存在；也不需要 `InstanceAddressURL`、`ServiceInstancesChangedListener` 这些额外对象。

Dubbo 3 的新路径是：先拿到 app/service instances，再从 metadata 和 `ProtocolServiceKey` 还原出真正可 refer 的服务地址。这意味着新模型改变的不是 URL 字符串，而是：

- 订阅对象变了  
- 地址更新事件源变了  
- invoker 生成方式变了  
- live runtime 的 directory 类型也变了  

所以应用级发现不是“换壳”，而是 consumer 侧控制面主链的一次重新组织。

### 失败方案三：迁移时业务 proxy 会被替换

这也是一个很自然的误解。很多人会想：既然发现模型变了，那 consumer 拿到的代理对象也应该换掉。

但源码没有这么做。业务侧通常继续持有同一个上层 invoker / proxy，真正变化的是 `MigrationInvoker.currentAvailableInvoker` 指向哪一条底层子树——旧的 interface-level invoker，还是新的 service-discovery invoker。

所以迁移是“壳不变，里子换了”。

## 四、最小总图：旧路径、新路径和中间那层壳

先把整篇文章压成一张图：

```text
ReferenceConfig / RegistryProtocol.refer()
    ↓
MigrationInvoker / ServiceDiscoveryMigrationInvoker
    ├─ 旧路径：RegistryDirectory -> provider URLs -> invokers
    └─ 新路径：ServiceDiscoveryRegistryDirectory -> instances -> metadata -> InstanceAddressURL -> invokers
           ↑
MigrationRuleListener / MigrationRuleHandler / Comparator
           ↑
动态规则、地址比较、比例切流
```

这张图里最重要的不是“有两条路径”，而是：**业务调用入口没换，变的是这两条路径在壳内部谁当前生效。**

这里再钉死一个路标：迁移不是“旧链变新链”的一次替换，而是“旧链和新链都存在，壳保持不变，当前请求只选择其中一棵子树”。后面所有迁移规则、比较器和销毁动作，都只是围绕这句话展开。

## 五、两套发现模型：到底差在哪

### 5.1 旧路径：接口级地址发现

传统 Dubbo 的 refer 链会走 `RegistryDirectory`。它面对的是接口级 provider URL 列表，后续 router、loadbalance、cluster 都直接在这份 invoker 视图上工作。

`RegistryProtocol.java:641` — interface-level invoker path 创建 `RegistryDirectory`

这条路径的优点是直观：registry 推什么 provider URL，consumer 就围绕这些 URL 生成 invokers。

### 5.2 新路径：应用级服务发现

新路径不是直接拿接口级 provider URL，而是先拿应用实例，再通过 metadata 还原接口服务。

`RegistryProtocol.java:635` — service-discovery invoker path 创建 `ServiceDiscoveryRegistryDirectory`
`ServiceDiscoveryRegistry.java:63` — 从旧接口级发现桥到新服务发现模型

这里最该记住的一句钉子话是：**旧路径的单位是 provider URL，新路径的单位是 service instance + metadata。**

这意味着 consumer 不再直接订阅“某接口有哪些 provider URL”，而是订阅“哪些应用实例存在”，再用 metadata 找这些实例上有哪些 `ProtocolServiceKey` 可提供当前接口。

### 5.3 `InstanceAddressURL`：新模型的地址对象

新路径里进入 Directory 的不是普通 provider URL，而是 `InstanceAddressURL`。这个对象通过 metadata 和 consumer 侧上下文，重新恢复接口、group、version 等必要信息。

`InstanceAddressURL.java:48` — instance-derived address model

所以应用级发现改变的不是“provider 地址长什么样”，而是“地址先作为实例存在，再被翻译成服务地址”。

## 六、`RegistryProtocol`：migration 壳是在哪里接进来的

### 6.1 `doRefer()` 先造 consumerUrl，再造 migration invoker

`RegistryProtocol.doRefer()` 的关键不是马上进 Directory，而是先构造 `consumerUrl`，再调用 `getMigrationInvoker(...)`。

`RegistryProtocol.java:578` — doRefer
`RegistryProtocol.java:592` — `CONSUMER_URL_KEY`
`RegistryProtocol.java:601` — 默认返回 `ServiceDiscoveryMigrationInvoker`

这里要特别提醒一个容易漏掉的点：**默认 `RegistryProtocol` 当前更偏向 service-discovery 路径。** 如果你想从源码里把“旧链和新链完全对称共存”的图看得更清楚，plain `MigrationInvoker` 本身反而更适合作为解释模型；而默认实现 `ServiceDiscoveryMigrationInvoker` 在当前版本上更强地偏向新路径。

这说明 migration 不是 registry 外部的“额外逻辑”，而是 refer 主线的一部分。

### 6.2 上层拿到的不是 Directory，而是 migration 壳

无论下面最终是 `RegistryDirectory` 还是 `ServiceDiscoveryRegistryDirectory`，上层拿到的都是一个 migration invoker。它在最外层保持了调用入口稳定。

`MigrationInvoker.java:64` — old/new/current invoker fields

这也解释了为什么切换发现模型时不需要替换业务 proxy：proxy 看到的仍然是同一个最外层 invoker。

## 七、`MigrationRuleListener` / `MigrationRuleHandler`：规则如何驱动切换

### 7.1 `MigrationRuleListener` 不是旁路 listener

`RegistryProtocol.interceptInvoker(...)` 会加载 `RegistryProtocolListener`，其中最关键的就是 `MigrationRuleListener`。它在 refer 时把 handler 挂到 migration invoker 上，并立即执行一次迁移逻辑。

`MigrationRuleListener.java:277` — onRefer attach handler

所以迁移从 refer 一开始就已经接管了后续行为，而不是等到“有人手动触发切换”才介入。

### 7.2 `MigrationRuleHandler` 把 rule 变成动作

真正把 rule 变成运行时动作的是 `MigrationRuleHandler.doMigrate(...)`。它解析当前 `MigrationStep` 和阈值，然后决定调用：

- `migrateToApplicationFirstInvoker(...)`
- `migrateToForceApplicationInvoker(...)`
- `migrateToForceInterfaceInvoker(...)`

`MigrationRuleHandler.java:47` — rule -> step dispatch

这条链把抽象的 migration rule 变成了具体的 invoker 子树切换动作。

### 7.3 规则变化是持续的

当规则后来变化时，`MigrationRuleListener.process(...)` 会把新的 rule fan-out 给所有已注册 handler，再次调用 `doMigrate(...)`。

`MigrationRuleListener.java:160` — rule change fan-out

所以 migration 不是 refer 时只算一次，而是运行中的持续控制面行为。

## 八、`MigrationInvoker`：两棵子树如何并存

### 8.1 old / new / current 三个引用

`MigrationInvoker` 最关键的三个字段是：

- `invoker`：旧的 interface-level 路径
- `serviceDiscoveryInvoker`：新的 application-level 路径
- `currentAvailableInvoker`：当前真正被业务调用使用的那棵子树

`MigrationInvoker.java:64` — old/new/current invoker fields

这三个字段说明：迁移的关键不是“把旧 invoker 变成新 invoker”，而是“在壳内部维护两个候选子树，并动态选择一个作为当前可用路径”。

### 8.2 `APPLICATION_FIRST`：不是简单偏向，而是比较后再选

默认规则通常不是强制旧、也不是强制新，而是 `APPLICATION_FIRST`。这时 migration invoker 会：

1. 刷新两边路径  
2. 通过比较器决定哪边更优  
3. 还可能按比例把一部分流量留给旧路径

`MigrationInvoker.java:253` — calculate preferred invoker
`MigrationInvoker.java:285` — APPLICATION_FIRST invoke path
`DefaultMigrationAddressComparator.java:49` — 地址数比值与阈值

所以 `APPLICATION_FIRST` 不是一句“优先新路径”就能概括的，它本质上是一个带比较和比例控制的过渡态。

### 8.3 force 场景：成功后销毁另一侧

当迁移明确切换到某一侧后，另一侧 invoker 子树会被主动销毁。

`MigrationInvoker.java:433` — destroy interface invoker
`MigrationInvoker.java:520` — destroy service-discovery invoker

这说明迁移不是永远保留双写/双读，而是在达到条件后缩回到单路径。

## 九、新路径里的地址如何变成 live invokers

### 9.1 `ServiceDiscoveryRegistry`：先订阅实例，再映射服务

新路径里，`ServiceDiscoveryRegistry` 不是直接向外暴露 provider URL 列表。它先订阅 service instances，再通过 `ServiceNameMapping` 和 metadata 组织出真正可供 consumer 使用的地址。

`ServiceDiscoveryRegistry.java:199` — subscribe path
`ServiceDiscoveryRegistry.java:341` — subscribeURLs / shared listener

### 9.2 `ServiceInstancesChangedListener`：实例变化变成地址变化

实例变化到来后，`ServiceInstancesChangedListener` 会按 metadata revision 分组，获取 `MetadataInfo`，构造 `serviceUrls`，最后通知 address changed。

`ServiceInstancesChangedListener.java:143` — instance change handling
`ServiceInstancesChangedListener.java:460` — notifyAddressChanged

也就是说，新路径里的“地址变化”并不是 registry 直接推来的 provider URL，而是实例变化在本地被重新翻译出来的地址视图。

### 9.3 `ServiceDiscoveryRegistryDirectory`：再 refer 成真正 invoker

`ServiceDiscoveryRegistryDirectory` 收到这些 instance-derived URLs 后，还要继续把它们 refer 成真实 invoker。

`ServiceDiscoveryRegistryDirectory.java:197` — notify
`ServiceDiscoveryRegistryDirectory.java:463` — instance URL -> protocol invoker

这说明新路径并没有绕开 Dubbo runtime 主线，而只是把“地址从哪里来”这一步换了。

## 十、误解澄清

### 误解一：application-level discovery 就是直接按 app 调用

不是。它仍然要回到接口、group、version 和 `ProtocolServiceKey`，只是地址来源先变成了应用实例。

### 误解二：`MigrationInvoker` 是 cluster 策略的一部分

不是。它是发现模型切换壳，不负责重试或负载均衡算法本身。

### 误解三：`APPLICATION_FIRST` 就是永远走新路径

不是。它还会比较两边地址视图，并可能按比例保留流量在旧路径上。

### 误解四：迁移时业务 proxy 会被替换

不是。变化的是 migration 壳内部 `currentAvailableInvoker` 指向哪棵子树，业务入口对象通常不变。

### 误解五：应用级发现只是把 provider URL 换一种格式

不是。它连订阅对象、地址来源和 invoker 生成路径都换了。

### 误解六：规则已经切到新模型，当前请求就应该立刻表现成新模型

不一定。规则变化先改变的是 migration 壳的决策方向，但真正体现在请求上，还要看当前 `currentAvailableInvoker` 是否已经切到新子树、旧子树是否已经退场，以及新的实例地址是否已经通过 metadata 和 `protocol.refer()` 变成 live invokers。也就是说，“规则已切换”不等于“这一瞬间已经没有请求会继续走旧路径”。

## 十一、收网总结：迁移不是换地址，而是切子树

回到开头的问题：为什么迁移不会直接替换 proxy？

因为 Dubbo 的迁移做法不是“把旧路径拔掉、把新路径插上”，而是在业务入口下面包了一层 migration 壳。旧路径和新路径可以同时存在，规则和比较器决定当前使用哪边，切换成功后再回收另一侧。

所以这篇真正要记住的不是几种 `MigrationStep` 名字，而是这条关系：

- 业务入口对象尽量保持不变  
- 变化的是 migration 壳内部指向的 invoker 子树  
- 旧路径是 `RegistryDirectory`，新路径是 `ServiceDiscoveryRegistryDirectory`  
- 实例变化先经过 metadata 翻译，再重新 refer 成真实 invoker  

**三句话总结：**

1. Dubbo 的迁移不是“启动时选一个发现模型”，而是规则驱动的运行时切换。  
2. 切换的不是 proxy，而是 `MigrationInvoker` 内部当前使用的 invoker 子树。  
3. application-level discovery 改变的不是地址字符串，而是地址来源、订阅对象和 invoker 生成路径。  

**下篇预告：** 下一篇如果继续控制面，可进入 Config Center / Dynamic Override，补上配置覆盖如何与 registry/service discovery 一起改写 live runtime。