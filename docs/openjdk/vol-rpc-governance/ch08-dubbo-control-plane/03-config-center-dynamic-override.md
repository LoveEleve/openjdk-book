# Dubbo：Config Center / Dynamic Override

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：为什么地址没变，行为却变了

线上最难解释的一类 Dubbo 问题，不是“provider 下线了”，而是“provider 根本没变，但行为突然变了”。

你查注册中心，地址一条没少；consumer 端目录里 provider 也都还在；但同一个接口的调用结果却变了：

- timeout 突然缩短了  
- 路由规则变了  
- 负载均衡策略换了  
- 某些实例明明还在 registry 里，却不再被当前请求选中  

如果把控制面只理解成“地址发现”，这些现象都很难解释。因为地址没有变，按直觉调用行为也不该变。

Dubbo 实际上有两条控制面：

- 一条管“有哪些目标”——registry / service discovery / migration 这条地址链。  
- 另一条管“这些目标该怎么被看待和使用”——config center / configurator 这条动态覆盖链。  

所以这篇文章解决的不是“地址从哪里来”，而是：**规则怎样在运行时改写既有目标的语义。**

## 二、前情回顾：上一页讲的是地址更新，这一页讲的是参数语义更新

在上一页里，我们已经看过 `RegistryProtocol -> RegistryDirectory.notify() -> refreshInvoker() -> RouterChain.setInvokers()` 这条地址更新主线。那篇文章的重点是：provider 列表怎样安全地变成 live invokers。

这一页讨论的不是“谁在线”，而是“在线的人该怎么被使用”。也就是说：

- 上一页讲的是 **地址控制面**。  
- 这一页讲的是 **治理控制面**。  

两条链会在 `RegistryDirectory` / `ServiceDiscoveryRegistryDirectory` 里交汇：地址变化负责换目标集合，configurator 变化负责改 URL 语义。

## 三、先走三条失败的路

### 失败方案一：config center 只是启动期配置来源

这个误解最常见，因为上一章我们刚讲过 `Environment`、`refresh()` 和静态配置 merge。

但动态 override 讨论的不是“启动前把值刷进 bean”，而是“运行中规则变了，如何让已经在跑的 consumer/provider 看到它”。

也就是说，config center 在这里不是来源层，而是一个 listener 驱动的治理平面。

### 失败方案二：只要地址不变，行为就不该变

这会把 provider 集合和 provider 参数语义混成一层。

地址链只告诉你“有哪些 invoker 存在”；configurator 链告诉你“当前 URL 上的 timeout、loadbalance、tag、路由条件等应该怎样被覆盖”。前者不变，不代表后者不变。

### 失败方案三：configurator 只会影响 consumer

不对。configurator 既可能重新计算 consumer 侧的 `directoryUrl` 和 provider invoker URL，也可能改写 provider export URL，甚至触发 re-export。

所以它不是“consumer 过滤器”，而是一个统一的 URL 语义覆盖抽象。

## 四、最小总图：动态覆盖链路

```text
ConfigCenterConfig
    ↓
DynamicConfiguration
    ↓
Environment / GovernanceRuleRepository
    ↓
AbstractConfiguratorListener
    ↓
ConfigParser.parseConfigurators(rawConfig)
    ↓
List<Configurator>
    ↓
consumer: directoryUrl / provider URL override
provider: export URL override
    ↓
live invokers / routing / timeout / loadbalance / tag / re-export
```

这张图里最关键的一点是：**config center 并不直接修改调用对象，它修改的是 URL 语义，而 Dubbo 的运行时又恰好大量围绕 URL 组织。**

## 五、规则从哪里来：DynamicConfiguration 与 GovernanceRuleRepository

### 5.1 Config center 先进入 `DynamicConfiguration`

`DefaultApplicationDeployer.initialize()` 在应用启动早期就会启动 config center，并把底层动态配置源放进 `Environment`。

`DefaultApplicationDeployer.java:224` — startConfigCenter
`DefaultApplicationDeployer.java:298` — dynamic config composite
`DefaultApplicationDeployer.java:308` — 存入 environment

这一步不是“立刻改变调用行为”，而是把后续动态规则监听的来源挂进运行时。

### 5.2 统一入口：`GovernanceRuleRepository`

治理侧代码不会直接依赖某个 vendor client，而是通过 `GovernanceRuleRepository` 读取规则和监听变化。

`DefaultGovernanceRuleRepositoryImpl.java:32` — addListener
`DefaultGovernanceRuleRepositoryImpl.java:56` — getRule

这让上层 configurator 逻辑根本不需要知道自己现在连的是 Nacos、Zookeeper 还是别的实现。

## 六、`AbstractConfiguratorListener`：规则文本怎样变成 `Configurator`

### 6.1 初始化时先注册 listener，再拉一次当前值

`AbstractConfiguratorListener.initWith(key)` 会做两件事：

1. `addListener(key, this)` 注册动态监听  
2. `getRule(key, group)` 取一次当前规则文本  

`AbstractConfiguratorListener.java:73` — initWith/addListener/getRule

这意味着 configurator 不是纯事件驱动，也会在启动时做一次“现值同步”。

### 6.2 变化时先解析，再通知 override

规则变化进入 `process(...)` 后，listener 会：

- delete 时清空规则  
- add/modify 时重解析原始文本  
- 然后调用 `notifyOverrides()`

`AbstractConfiguratorListener.java:85` — process config changed event
`AbstractConfiguratorListener.java:104` — parseConfigurators
`AbstractConfiguratorListener.java:121` — toConfigurators / notifyOverrides

所以 config center 到 runtime 的关键不是“收到了变化”，而是“把文本翻译成了 Configurator 对象”。

## 七、`Configurator`：不是配置 bean，而是 URL 覆盖器

### 7.1 `Configurator` 的唯一职责

`Configurator` 的核心接口非常简单：

```java
URL configure(URL url)
```

`Configurator.java:70` — toConfigurators
`Configurator.java:99` — sort / factory use

它不持有业务状态，不直接改 invoker，也不直接调 registry。它只负责：**拿一份 URL，按规则覆盖后返回另一份 URL。**

### 7.2 为什么旧 registry configurators 和新 config-center 规则能汇合

不管规则来自：

- registry `configurators` category  
- 还是 config center 动态规则  

最后都会落到同一个 `Configurator` 抽象上。也就是说，两条来源不同，但运行时应用方式是统一的。

这正是 Dubbo 的控制面设计精华：**不同来源的治理规则，用同一层运行时语义来落地。**

### 7.3 Override vs Absent

典型实现里：

- `OverrideConfigurator` 会覆盖已有参数。  
- `AbsentConfigurator` 只补没有的值。  

`OverrideConfigurator.java:34` — override semantics

这说明 configurator 不只是“把 key=value 塞进去”，而是有明确覆盖语义。

## 八、consumer 侧：directoryUrl 和 invoker URL 如何被动态改写

### 8.1 `directoryUrl` 会先被 override

在传统 `RegistryDirectory` 路径里，每次 refresh 前都会先：

```java
this.directoryUrl = overrideWithConfigurator(getOriginalConsumerUrl())
```

`RegistryDirectory.java:257` — refreshOverrideAndInvoker
`RegistryDirectory.java:652` — overrideWithConfigurator

这意味着 consumer 侧不是拿最原始的 `consumerUrl` 去跑 router / cluster，而是拿一份已经被 configurator 改写过的 `directoryUrl`。

### 8.2 provider URL 也会被 override

仅仅改 `directoryUrl` 还不够。provider URL 在生成 invoker 之前，也会被 configurator 改写。

所以一条动态规则既可能改变：

- consumer 自己怎么看待当前调用  
- 也可能改变 consumer 怎么看待 provider  

### 8.3 Service Discovery 路径也一样，只是对象不同

在 `ServiceDiscoveryRegistryDirectory` 里，逻辑类似，只是 provider URL 被包成 `OverrideInstanceAddressURL`。

`ServiceDiscoveryRegistryDirectory.java:220` — overrideDirectoryWithConfigurator
`ServiceDiscoveryRegistryDirectory.java:270` — override provider URL via `OverrideInstanceAddressURL`
`OverrideInstanceAddressURL.java:117` — getParameter override
`OverrideInstanceAddressURL.java:166` — parameter map merge

这里最关键的一点是：应用级发现路径里，configurator 改写的不是“纯 provider URL”，而是“instance-derived address model”。但本质上依然是在改 URL 语义。

## 九、provider 侧：什么时候会触发 re-export

### 9.1 provider export URL 也会被 configurator 覆盖

`RegistryProtocol.OverrideListener.doOverrideIfNecessary()` 会把 configurator 规则按层叠顺序应用到 provider export URL 上。

`RegistryProtocol.java:895` — provider-side doOverrideIfNecessary

### 9.2 URL 真变了，就可能 re-export

如果 override 后的 export URL 确实变化了，而且当前规则要求重导出，Dubbo 会触发 `reExport(...)`。

`RegistryProtocol.java:900` — reExport trigger

这解释了一个非常常见的线上现象：provider 地址没变，端口也没变，但新请求的超时、路由、治理行为已经变了——因为服务其实在控制面意义上重新导出了一次。

## 十、误解澄清

### 误解一：config center 只是启动期配置来源

不是。这里的 config center 讨论的是 listener 驱动的动态治理平面，不是上一章的静态 merge 来源。

### 误解二：只要地址没变，行为就不该变

不是。地址链解决“谁存在”，configurator 链解决“怎么使用”。两者可以独立变化。

### 误解三：configurator 只影响 consumer

不是。provider export URL 也可能被 override，并触发 re-export。

### 误解四：旧 registry `configurators` 和新 config-center 规则是两套完全不同系统

来源不同，但最终都会落到同一个 `Configurator` 抽象上。

### 误解五：配置中心改了值，行为没立刻变，就说明没生效

不一定。规则可能已经进入治理平面，但还要看当前 directory/invoker/export URL 是在什么时机被重新计算和替换。控制面规则进入，不等于每个运行时对象瞬时切换完成。

## 十一、收网总结：Dubbo 有一条独立于地址发现的治理平面

回到开头的问题：为什么地址没变，行为却变了？

因为 Dubbo 里除了“地址控制面”，还有一条独立的“治理控制面”。

- registry / service discovery 负责告诉 runtime：有哪些目标存在。  
- config center / configurator 负责告诉 runtime：这些目标应该怎么被看待、怎么被覆盖、怎么被重新导出。  

所以 runtime 里真正发生的是：

```text
地址变化 -> live invokers 更新
参数覆盖 -> directoryUrl / invoker URL / export URL 语义更新
```

**三句话总结：**

1. Config center 不是静态配置 merge 的延伸，而是 Dubbo 运行中的治理平面。  
2. `Configurator` 是统一的 URL 覆盖抽象，registry configurators 和 config-center 规则都会在这一层汇合。  
3. 地址不变但行为变，是 Dubbo 控制面设计的正常结果，不是“配置没生效”或“registry 异常”的直接证据。  

**下篇预告：** 如果继续扩控制面，可以进入 metadata / governance 更深处；如果转向生产排障，也可以直接写“registry / config / metadata 失配问题分析”。