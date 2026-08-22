# 为什么 Nacos 的负载均衡不是简单轮询：`NacosLoadBalancer` 如何把权重算法接进 Commons 的实例选择主线

> 本文基于 Spring Cloud Alibaba 2025.0.0.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-alibaba` 的第五篇，承接前一篇 Nacos 注册发现。重点放在 `NacosLoadBalancer`、`NacosBalancer`、`LoadBalancerAlgorithm`、`NacosLoadBalancerClientConfiguration`，以及它们如何把 Nacos 的权重选择能力接入 Commons 的 `ReactorServiceInstanceLoadBalancer` 主线。下一篇将进入 Sentinel 三路限流。

## 为什么拿到一组 Nacos 实例之后，Alibaba 还要自己再包一层 `NacosLoadBalancer`

前面两卷已经讲过：

- Commons 的 `DiscoveryClient` / `ServiceRegistry` 负责“发现实例”和“注册实例”
- Commons 的 `ReactorServiceInstanceLoadBalancer` 负责“在实例列表里选一个”

而前一篇已经确认：

- `NacosDiscoveryClient` / `NacosServiceDiscovery` 能把 Nacos 的实例列表转换成 Spring Cloud 的 `ServiceInstance`

到这里很容易产生一个误解：

- 既然实例列表已经有了，那 Commons 的 `RoundRobinLoadBalancer` 直接用就行

这个判断对“一般轮询”来说没问题，但它忽略了 Nacos 的一个非常关键特征：

- **实例权重。**

也就是说，Nacos 的负载均衡默认并不只关心“列表里有哪些实例”，还关心：

- 这些实例的权重是多少
- 哪些实例应该被更高概率选中

这就是为什么 Spring Cloud Alibaba 还要在 Commons 抽象层之上，单独提供：

- `NacosLoadBalancer`

第一层问题是：**`NacosLoadBalancer` 不是在替代 Commons 负载均衡抽象，而是在 Commons 抽象里补上 Nacos 特有的权重选择语义。**

第二层问题是：**`NacosBalancer` 和 `LoadBalancerAlgorithm` 的存在，说明“怎么选实例”在 Alibaba 这里也是可扩展策略，而不只是固定权重函数。**

第三层问题是：**Nacos 的负载均衡路径依然要先复用 Commons 提供的实例供应链，再在“选哪个”这一步插入 Nacos 逻辑。**

因此，本文真正要回答的问题不是“Spring Cloud Alibaba 支持权重负载均衡吗”，而是：

**为什么对 Alibaba 来说，必须先复用 Commons 的 `ServiceInstanceListSupplier` 和 `ReactorServiceInstanceLoadBalancer` 主线，再通过 `NacosLoadBalancer`、`LoadBalancerAlgorithm` 和 `NacosBalancer` 把 Nacos 的实例权重和服务级策略注入到最终选择阶段。**

## 先看失败方案：为什么不能直接继续用 `RoundRobinLoadBalancer`、不能把权重硬编码进 `DiscoveryClient`、也不能把所有服务都绑成同一种策略

### 失败方案一：有了实例列表，继续用 `RoundRobinLoadBalancer` 就够了

这个方案在没有权重时很自然。

但一旦 Nacos 的实例元数据里存在：

- 不同实例不同权重

简单轮询就会忽略这些信息。

结果就是：

- 低权重实例和高权重实例被同等对待

这显然和 Nacos 提供的能力不匹配。

### 失败方案二：把权重逻辑塞进 `NacosDiscoveryClient`

这会把两个层次混在一起：

- 发现：有哪些实例
- 选择：从实例中选谁

一旦把权重选实例逻辑写进 `DiscoveryClient`，后面所有其他负载均衡策略就会被污染。

所以 Alibaba 必须让：

- `NacosDiscoveryClient` 继续只负责发现
- `NacosLoadBalancer` 负责选择

### 失败方案三：所有服务统一使用一套固定权重算法

生产里很常见的需求是：

- 某个服务用默认随机权重
- 某个服务用自定义算法
- 某个服务按请求上下文进一步筛选实例

如果所有服务都被硬绑到同一实现，扩展就会很差。

这也是为什么 Alibaba 引入：

- `LoadBalancerAlgorithm`
- `loadBalancerAlgorithmMap`

让每个 serviceId 都能有不同策略。

## `NacosLoadBalancer` 的最小总图

```text
NacosDiscoveryClient -> List<ServiceInstance>
   -> NacosLoadBalancer.choose(request)
   -> apply ServiceInstanceFilter
   -> choose algorithm from loadBalancerAlgorithmMap
   -> NacosBalancer weight selection
   -> selected ServiceInstance
```

```text
[实例来源]
DiscoveryClientServiceInstanceListSupplier / Nacos discovery path

   ->

[Alibaba 选择入口]
NacosLoadBalancer

   ->

[过滤]
ServiceInstanceFilter

   ->

[算法分派]
LoadBalancerAlgorithm map

   ->

[默认权重算法]
NacosBalancer.getHostByRandomWeight*
```

## 一、`NacosLoadBalancer`：在 Commons 抽象上实现 Nacos 选择语义

`NacosLoadBalancer` 实现的是：

- `ReactorServiceInstanceLoadBalancer`

也就是说，它并没有跳出 Commons 负载均衡主线，而是：

- 在同一抽象上提供自己的实例选择实现

本地 `NacosLoadBalancerClientConfiguration` 里真正暴露给容器的是：

```java
@Bean
@ConditionalOnMissingBean
public ReactorLoadBalancer<ServiceInstance> nacosLoadBalancer(Environment environment,
        LoadBalancerClientFactory loadBalancerClientFactory,
        NacosDiscoveryProperties nacosDiscoveryProperties,
        InetIPv6Utils inetIPv6Utils,
        List<ServiceInstanceFilter> serviceInstanceFilters,
        List<LoadBalancerAlgorithm> loadBalancerAlgorithms) {
```

它接收的前置条件仍然是：

- `LoadBalancerClientFactory.getLazyProvider(name, ServiceInstanceListSupplier.class)` 提供实例列表
- `NacosDiscoveryProperties` 提供集群/IPv6等规则
- `LoadBalancerAlgorithm` 与 `ServiceInstanceFilter` 提供策略和过滤

## 二、`LoadBalancerAlgorithm`：Nacos 不把“选谁”写死在一个类里

从本地源码可以看到，Reactive supplier 的组装本身就是由 `NacosLoadBalancerClientConfiguration` 控制的：

- 当 `spring.cloud.loadbalancer.configurations=default`（默认）时，使用 `ServiceInstanceListSupplier.builder().withDiscoveryClient().build(context)`
- 当该属性为 `zone-preference` 时，使用 `ServiceInstanceListSupplier.builder().withDiscoveryClient().withZonePreference().build(context)`

也就是说，Alibaba 这里不是手工拼链，而是复用了 Commons 的 supplier builder，再通过配置值选择默认链形态。

- `LoadBalancerAlgorithm` 抽象了“给某个 serviceId 选实例”的策略
- `NacosLoadBalancerClientConfiguration` 会收集所有 `LoadBalancerAlgorithm` Bean，放进 `loadBalancerAlgorithmMap`
- 不同服务可以用不同策略

这意味着：

- 默认权重随机只是一个缺省算法
- 业务可以按 serviceId 替换或扩展策略

也就是说，Alibaba 不只是“支持权重”，而是：

- **把权重负载均衡本身也做成可扩展策略。**

## 三、`NacosBalancer`：默认权重随机的真实落点

在没有显式自定义算法时，Alibaba 的默认路径会落到：

- `NacosBalancer`

它会读取：

- `ServiceInstance` 上的权重信息

再按权重做随机选择。

这一步最重要的不是算法细节，而是它解释了：

- 为什么前面 `NacosServiceDiscovery` 要把权重元数据塞进 `ServiceInstance`

因为如果没有这些元数据，后面的权重选择根本无法发生。

也就是说，前一篇的“实例发现转换层”和这一篇的“实例选择层”在权重字段上是直接闭环的。

## 四、为什么 `ServiceInstanceFilter` 是 Alibaba 负载均衡的前置协作者

真正进入选择前，`NacosLoadBalancer.getInstanceResponse(...)` 还会做两层预处理：

- 如果配置了 `nacosDiscoveryProperties.getClusterName()`，优先筛出同 cluster 的实例
- 再执行 `filterInstanceByIpType(instancesToChoose)` 以及所有 `ServiceInstanceFilter`

然后才按 serviceId 从 `loadBalancerAlgorithmMap` 选算法，最后得到默认或自定义的目标实例。

- `ServiceInstanceFilter`

它的作用是：

- 对实例列表做前置过滤
- 再把过滤后的实例列表交给算法选取

也就是说，最终的实例选择不一定是：

- 全量实例 -> 算法

而可能是：

- 全量实例 -> filter -> 算法

这让 Nacos 的选择链更适合接业务标签、区域、灰度等前置约束。

## 五、为什么这篇必须放在 Nacos 注册发现之后

没有前一篇，就无法回答：

- 这些实例从哪里来
- 权重信息是谁塞进 `ServiceInstance` 的
- 不健康实例为什么已经被过滤掉了

也就是说：

- 前一篇是“实例来源和模型转换”
- 当前篇是“在这些实例里按 Nacos 规则选一个”

顺序不能反。

## 六、最小源码证据：这条链确实是“Commons 供实例列表 -> Alibaba 供选择策略”

从本地源码看，关键事实已经非常明确：

- `NacosLoadBalancer` 实现 `ReactorServiceInstanceLoadBalancer`
- `choose(request)` 先从 supplier 拿实例列表，再进 `getInstanceResponse(...)`
- `NacosLoadBalancerClientConfiguration` 负责收集 `LoadBalancerAlgorithm` Bean 形成 `loadBalancerAlgorithmMap`
- 默认 `DefaultLoadBalancerAlgorithm` 最终会调用 `NacosBalancer.getHostByRandomWeight3(...)`

这证明：

- Alibaba 没有重写 Commons 的整个负载均衡框架
- 它只是在“实例选择”这一层插入自己的算法与过滤链

## 七、几个最容易错的判断

### 1. `NacosLoadBalancer` 就是 Commons 轮询负载均衡的别名

不成立。

它实现同一抽象，但插入的是 Nacos 权重与服务级算法选择语义。

### 2. 权重逻辑应该放在 `NacosDiscoveryClient` 里

不成立。

服务发现负责实例列表来源，负载均衡负责实例选择，层次必须分开。

### 3. `NacosBalancer` 已经够了，不需要 `LoadBalancerAlgorithm`

不完整。

`NacosBalancer` 只是默认权重随机能力，`LoadBalancerAlgorithm` 才让不同服务拥有不同策略。

### 4. 只要有权重，所有服务都必须用同一套选择算法

不成立。

`loadBalancerAlgorithmMap` 允许不同 serviceId 绑定不同算法。

### 5. 这一篇只是在讲权重细节，不是 Boot / Cloud 主线的一部分

不成立。

它正是 Commons 负载均衡主线在 Alibaba 里的具体实现分叉。

## 收网

现在可以回到开头的问题：为什么 Nacos 的负载均衡不是简单轮询？

因为 Alibaba 并不是自己从头重写负载均衡，而是：

- 继续复用 Commons 提供的实例列表供应链
- 在选择阶段引入 `NacosLoadBalancer`
- 用 `ServiceInstanceFilter` 做前置过滤
- 用 `LoadBalancerAlgorithm` 做 serviceId 级策略分派
- 默认落到 `NacosBalancer` 的权重随机算法

所以这篇真正该带走的结论不是“Nacos 支持权重”，而是：

**Spring Cloud Alibaba 把 Commons 的负载均衡抽象保持不变，只在实例选择这一层注入了 Nacos 权重、过滤和可扩展算法；因此，NacosLoadBalancer 不是一个独立系统，而是 Commons 实例供应链之上的 Alibaba 实现分支。**

下一篇进入 Sentinel 三路限流。