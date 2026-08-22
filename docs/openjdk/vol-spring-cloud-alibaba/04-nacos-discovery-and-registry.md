# 为什么服务一启动就既能被发现、又会自动注册：Nacos 如何把 Commons 的发现与注册抽象一起落地

> 本文基于 Spring Cloud Alibaba 2025.0.0.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-alibaba` 的第四篇，承接前一篇 Nacos 配置动态刷新。重点放在 `NacosDiscoveryClient`、`NacosServiceDiscovery`、`NacosServiceRegistry`、`NacosAutoServiceRegistration`、`ServiceCache`，以及它们怎样一起兑现 Commons 的 `DiscoveryClient` / `ServiceRegistry` 抽象。下一篇将进入 Sentinel 三路限流。

## 为什么一个服务既能主动把自己报上去，又能主动把别人找出来

前面在 Commons 卷里已经分别讲过：

- `DiscoveryClient`：消费者如何找到别的服务
- `ServiceRegistry`：提供者如何把自己注册到注册中心

但在真实的 Spring Cloud Alibaba 应用里，这两条路径并不是孤立存在的。

同一个服务实例通常同时承担两种角色：

- 作为服务提供者，它要把自己注册到 Nacos
- 作为服务消费者，它又要从 Nacos 查询其他服务实例

也就是说，一个实例既会：

- 调 `register()` 把自己上报
- 也会调 `getInstances(serviceId)` 去拉别人的地址

Spring Cloud Alibaba 并不是把这两件事拆给业务代码，而是通过：

- `NacosServiceRegistry`
- `NacosAutoServiceRegistration`
- `NacosDiscoveryClient`
- `NacosServiceDiscovery`

把它们一起接到了 Boot / Commons 主线里。

第一层问题是：**Nacos 不是同时给了两个完全独立的世界，而是在同一个注册中心协议下，实现了“自注册”和“他发现”两条互补路径。**

第二层问题是：**`NacosAutoServiceRegistration` 不是简单包装 `NacosServiceRegistry`，它真正决定的是“什么时候去注册”。**

第三层问题是：**`NacosDiscoveryClient` 并不是直接调用 Nacos SDK 然后返回结果，它通过 `NacosServiceDiscovery` 和 `ServiceCache` 把实例查询、转换与容错组织起来。**

因此，本文真正要回答的问题不是“Spring Cloud Alibaba 支持 Nacos 注册发现吗”，而是：

**为什么对 Spring Cloud Alibaba 来说，必须用 `NacosServiceRegistry` / `NacosAutoServiceRegistration` 兑现注册路径，再用 `NacosDiscoveryClient` / `NacosServiceDiscovery` 兑现发现路径，并让两条路径共享实例模型、缓存与生命周期边界，Nacos 才能真正成为 Spring Cloud 里的注册发现基础设施。**

## 先看失败方案：为什么不能让业务代码手动注册、不能让服务发现直接暴露 Nacos SDK、也不能让注册和发现完全互相独立

### 失败方案一：业务代码自己在启动后手工调用注册 API

这会让每个服务都重复承担：

- 何时注册
- 注册失败怎么处理
- 何时反注册
- 优雅关闭如何摘除实例

这正是 Commons 卷里已经说明应由 `AbstractAutoServiceRegistration` 统一承担的部分。

### 失败方案二：服务发现直接返回 Nacos SDK 的原始实例对象

这样会导致：

- 业务代码绑定 Nacos SDK
- `DiscoveryClient` 抽象失去意义
- 切换实现时高层代码受污染

所以 `NacosDiscoveryClient` 必须把底层实例转为 Spring Cloud 的 `ServiceInstance` 语义。

### 失败方案三：注册和发现各做各的，不共享缓存和实例模型

这会导致：

- 发现结果和注册状态语义不一致
- 容错和缓存逻辑分散
- 同一个服务实例在不同路径里被表示成不同对象

所以 Alibaba 必须把“注册”和“发现”都收敛到共同的注册中心模型里。

## Nacos 注册发现的最小总图

```text
service startup
   -> NacosAutoServiceRegistration
   -> NacosServiceRegistry.register()
   -> Nacos registers this instance

service call
   -> NacosDiscoveryClient.getInstances(serviceId)
   -> NacosServiceDiscovery.getInstances()
   -> ServiceCache / transform to ServiceInstance
   -> caller gets discovered instances
```

```text
[提供者路径]
WebServerInitializedEvent -> auto registration -> registry

   ->

[注册中心]
Nacos naming service

   ->

[消费者路径]
DiscoveryClient -> service discovery -> cache / convert -> ServiceInstance list
```

## 一、`NacosServiceRegistry`：把 Commons 的注册契约落到 Nacos naming service

Commons 卷里讲过：

- `ServiceRegistry` 负责 register / deregister / status

Alibaba 这里的实现就是：

- `NacosServiceRegistry`

本地源码里的关键路径非常直接：

- 从 `Registration` 取出 `serviceId`
- 读取 `nacosDiscoveryProperties.getGroup()`
- 把 `Registration` 转成 Nacos `Instance`
- 调用 `namingService.registerInstance(serviceId, group, instance)`
- 如果失败且 `failFast=true`，则直接抛出异常，否则只告警

也就是说，Alibaba 在这里最重要的不是“能注册”，而是：

- **注册动作仍然保持 Spring Cloud 契约一致性，同时把 group、failFast 和 Nacos Instance 细节收进实现层。**

## 二、`NacosAutoServiceRegistration`：真正关键的是注册时机

如果只有 `NacosServiceRegistry`，还不够。

因为它只告诉我们：

- 怎么注册

却没有回答：

- 什么时候注册

这正是：

- `NacosAutoServiceRegistration`

存在的理由。

它继承自 Commons 的 `AbstractAutoServiceRegistration`，也就是说：

- 依旧监听 `WebServerInitializedEvent`
- 依旧在 WebServer 启动完成后开始注册
- 依旧在生命周期结束时走反注册路径

但本地源码还说明它补了 Nacos 特有的三层逻辑：

- 注册前先检查 `registration.getNacosDiscoveryProperties().isRegisterEnabled()`
- 如果端口还没写入，就把 `getPort().get()` 回填进 `NacosRegistration`
- 收到 `NacosDiscoveryInfoChangedEvent` 时会 `stop()` 再 `start()`，重新注册

所以 Alibaba 在这里不是绕开 Commons 重造一套，而是：

- **把 Nacos 具体实现接入 Commons 已经定义好的自动注册时序，并补上 Nacos 自身的开关与重注册逻辑。**

## 三、`NacosDiscoveryClient`：服务发现的真正入口

从调用方角度看，最常见的入口仍然是：

- `DiscoveryClient.getInstances(serviceId)`

Alibaba 在这里提供的实现就是：

- `NacosDiscoveryClient`

这一步的关键价值不是“又多一个 client 类”，而是：

- 让所有业务代码继续停留在 Commons 抽象层
- 底下由 Nacos 具体实现去取实例

本地源码里 `getInstances(serviceId)` 的真实链路是：

- `NacosDiscoveryClient.getInstances(serviceId)`
- 调 `serviceDiscovery.getInstances(serviceId)`
- 成功时把结果写入 `ServiceCache.setInstances(serviceId, instances)`
- 失败时如果 `failureToleranceEnabled=true`，则回退到 `ServiceCache.getInstances(serviceId)`
- 否则抛出运行时异常

所以：

- 业务看到的是 `DiscoveryClient`
- Alibaba 提供的是 `NacosDiscoveryClient`
- 中间还夹着 discovery 实现层与缓存容错层

这层隔离保证了：

- 切实现时，高层代码不需要重写

## 四、`NacosServiceDiscovery`：把底层查询、实例转换与容错缓存拆出来

真正去跟 Nacos naming service 对话的，并不是 `NacosDiscoveryClient` 自己完成所有细节。

更关键的协作者是：

- `NacosServiceDiscovery`

它负责：

- 调用 Nacos naming service 查询实例
- 把 Nacos 的 `Instance` 转成 Spring Cloud 的 `ServiceInstance`
- 配合 `ServiceCache` 做一定程度的容错缓存

本地源码里 `getInstances(serviceId)` 会调用：

- `namingService().selectInstances(serviceId, group, true)`
- 再交给 `hostToServiceInstanceList(instances, serviceId)` 转换

而 `hostToServiceInstance(...)` 又会过滤：

- `instance == null`
- `!instance.isEnabled()`
- `!instance.isHealthy()`

只有健康且启用的实例才会进入最终 `ServiceInstance` 列表。

这一步特别重要，因为它说明 Alibaba 并没有把：

- SDK 调用
- 实例模型转换
- 缓存容错

全都揉进 `NacosDiscoveryClient` 里，而是把它们拆成：

- client 入口层
- discovery 实现层
- cache 容错层

## 五、`ServiceCache`：为什么容错缓存是注册发现路径的一部分

注册中心在生产环境里不是百分之百稳定的。

一旦短暂不可达，如果每次发现都直接失败，整个服务调用链会立刻受到影响。

所以 Alibaba 在发现路径里加了：

- `ServiceCache`

它的作用不是替代注册中心，而是：

- 在注册中心短暂不可达时，尽量保留最近一次有效实例列表
- 作为容错回退数据源

也就是说，`ServiceCache` 不是额外优化，而是：

- **注册发现稳定性的一部分。**

但这里也要把话说准：`ServiceCache` 不是“任何错误都能兜底”，它只在 `failureToleranceEnabled=true` 时为发现路径提供最近一次有效实例列表回退；如果没有开启该容错开关，异常仍会直接抛出。

## 六、为什么这篇必须放在 Nacos LoadBalancer 之前

Nacos LoadBalancer 解决的是：

- 已经拿到一组实例后，按什么策略选一个

而当前这篇解决的是：

- 这组实例从哪里来
- 它们怎么注册进去
- 如何从 Nacos 转成 `ServiceInstance`
- 注册中心不可达时怎样容错

也就是说：

- 当前篇是“实例生命周期与发现来源”
- 下一篇才是“在这些实例里如何选一个”

顺序不能反。

## 七、最小源码证据：这两条链确实是“自动注册 + 发现查询 + 缓存容错”协同成立

从本地源码结构看，关键类已经非常清楚：

- `NacosServiceRegistry`
- `NacosAutoServiceRegistration`
- `NacosDiscoveryClient`
- `NacosServiceDiscovery`
- `ServiceCache`

它们分别对应：

- 注册契约实现
- 注册时机
- 发现抽象入口
- Nacos 查询与转换
- 容错缓存

也就是说，Alibaba 的 Nacos 注册发现主线并不是：

- 一个大类里完成所有事

而是：

- **把注册、时机、发现、转换、缓存拆成协作链。**

## 八、几个最容易错的判断

### 1. `NacosAutoServiceRegistration` 和 `NacosServiceRegistry` 是同一个东西

不成立。

前者解决注册时机，后者解决注册动作。

### 2. `NacosDiscoveryClient` 就是直接调用 Nacos SDK

不完整。

它还依赖 `NacosServiceDiscovery` 做查询、模型转换与缓存容错组织。

### 3. 注册和发现是两套互不相关的机制

不成立。

它们是同一个注册中心模型在提供者和消费者两个方向上的实现。

### 4. 注册中心不可达时，只能全部失败

不成立。

发现路径上还存在 `ServiceCache` 这种容错缓存层。

### 5. 这一篇讲完就等于负载均衡也讲完了

不成立。

当前篇只解决实例来源与注册发现，负载均衡选实例策略是下一篇 `NacosLoadBalancer` 的主题。

## 收网

现在可以回到开头的问题：为什么服务一启动就既能被发现、又会自动注册？

因为 Alibaba 把 Commons 的两条主线同时落地：

- 通过 `NacosServiceRegistry` + `NacosAutoServiceRegistration` 完成“把自己注册上去”
- 通过 `NacosDiscoveryClient` + `NacosServiceDiscovery` + `ServiceCache` 完成“把别人找出来”

所以这篇真正该带走的结论不是“Nacos 提供了注册发现”，而是：

**Spring Cloud Alibaba 通过 `NacosServiceRegistry` 兑现注册契约，通过 `NacosAutoServiceRegistration` 接入自动注册时机，再用 `NacosDiscoveryClient`、`NacosServiceDiscovery` 和 `ServiceCache` 兑现发现抽象与容错缓存；因此，Nacos 在 Spring Cloud 里不是一个 SDK，而是一条标准化的注册发现基础设施链。**

下一篇进入 `NacosLoadBalancer` 权重负载均衡。