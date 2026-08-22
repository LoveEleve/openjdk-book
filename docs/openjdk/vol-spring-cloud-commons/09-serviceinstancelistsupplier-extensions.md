# 为什么负载均衡不只是轮询：`ServiceInstanceListSupplier` 如何通过组合实现区域、权重、粘滞会话等扩展策略

> 本文基于 Spring Cloud 2025.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-commons` 的第九篇，承接前一篇 `NamedContextFactory`。重点放在 `ServiceInstanceListSupplier` 的扩展策略实现：`ZonePreferenceServiceInstanceListSupplier`、`WeightedServiceInstanceListSupplier`、`SubsetServiceInstanceListSupplier`、`HintBasedServiceInstanceListSupplier`、`RequestBasedStickySessionServiceInstanceListSupplier`、`SameInstancePreferenceServiceInstanceListSupplier` 及其组合模式。下一篇将进入断路器抽象。

## 为什么负载均衡策略不只是“从列表里选一个”，还包括“选之前先过滤和排序”

前一篇讲到 `RoundRobinLoadBalancer` 从 `ServiceInstanceListSupplier` 拿实例列表，然后用 `AtomicInteger` 取模选一个。

但真实生产环境的需求远不止“取模”。它还包括：

- 优先选择同一区域的实例，减少跨区域延迟
- 按权重分配流量
- 减少实例列表大小，避免每次都在大量实例里选
- 根据请求提示选择实例
- 同一个客户端尽量命中同一实例

这些需求靠“选”解决不了，需要在“选之前”就对实例列表做预处理。

Spring Cloud 的解法是 `ServiceInstanceListSupplier` 链：

- 每个 supplier 只负责一件事
- 多个 supplier 通过装饰器模式组合成一条链
- 链的输出是过滤/排序/子集后的实例列表

**第一层问题是：`ServiceInstanceListSupplier` 扩展策略采用装饰器模式，每个 supplier 包装另一个 supplier。**

**第二层问题是：`WeightedServiceInstanceListSupplier` 和 `ZonePreferenceServiceInstanceListSupplier` 不改变列表，而是改变顺序。**

**第三层问题是：`SubsetServiceInstanceListSupplier` 和 `HintBasedServiceInstanceListSupplier` 减少列表范围。**

## 先看失败方案：为什么不能把区域、权重、粘滞会话都塞进轮询策略里、不能用多个策略硬编码判断

### 失败方案一：把区域、权重、粘滞会话都塞进一个策略类

这会导致：

- 策略类越来越庞大
- 不同需求的组合越来越多
- 无法单独测试某个扩展策略

### 失败方案二：在策略类里硬编码判断

随着需求增加，策略类会变成：

- 大量 if/else
- 职责不清
- 难以扩展新的过滤条件

## 扩展策略的最小总图

```text
DiscoveryClientServiceInstanceListSupplier
   -> CachingServiceInstanceListSupplier
   -> HealthCheckServiceInstanceListSupplier
   -> ZonePreference/Weighted/Subset/Hint/StickySession
   -> RoundRobinLoadBalancer
```

```text
[原始实例列表]
DiscoveryClientServiceInstanceListSupplier

   ->

[缓存]
CachingServiceInstanceListSupplier

   ->

[健康检查]
HealthCheckServiceInstanceListSupplier

   ->

[扩展策略链]
ZonePreference / Weighted / Subset / Hint / StickySession

   ->

[策略选择]
RoundRobinLoadBalancer
```

## 一、`DelegatingServiceInstanceListSupplier`：装饰器模式的基础

所有扩展策略 supplier 都继承 `DelegatingServiceInstanceListSupplier`：

```java
public abstract class DelegatingServiceInstanceListSupplier
        implements ServiceInstanceListSupplier, SelectedInstanceCallback, InitializingBean, DisposableBean {

    protected final ServiceInstanceListSupplier delegate;

    public DelegatingServiceInstanceListSupplier(ServiceInstanceListSupplier delegate) {
        Assert.notNull(delegate, "delegate may not be null");
        this.delegate = delegate;
    }
}
```

来源：`spring-cloud-loadbalancer/.../core/DelegatingServiceInstanceListSupplier.java:32-40`。

它持有另一个 `ServiceInstanceListSupplier` 作为 `delegate`，扩展 supplier 在 `get(request)` 里先调用 `delegate.get()`，再对结果进行处理。

这意味着：

- 多个 supplier 可以嵌套组合
- 每个 supplier 只负责自己那一层
- 组合顺序由 `ServiceInstanceListSupplierBuilder` 控制

`ServiceInstanceListSupplierBuilder` 提供了 `withDiscoveryClient()`、`withCaching()`、`withHealthChecks()`、`withWeighted()`、`withZonePreference()`、`withSubset()`、`withHints()`、`withRequestBasedStickySession()`、`withSameInstancePreference()` 等链式方法，按调用顺序自底向上构建 supplier 链。

## 二、`ZonePreferenceServiceInstanceListSupplier`：按区域偏好排序

优先选择与当前实例在同一区域的实例，减少跨区域调用延迟。

它通过 `ZonePreferenceServiceInstanceListSupplier` 读取当前实例的区域配置，然后在 `get(request)` 返回的实例列表里，把同一区域的实例排在前面。

## 三、`WeightedServiceInstanceListSupplier`：按权重分配

根据实例的元数据中的权重值，对实例列表进行加权排序。

权重高的实例被选中的概率更大，适合流量分配不均匀的场景。

## 四、`SubsetServiceInstanceListSupplier`：子集化

当服务实例数量很大时，每次都从全量实例列表中选择：

- 浪费计算
- 增加缓存压力
- 实例列表变化不频繁时，子集更稳定

`SubsetServiceInstanceListSupplier` 从全量实例中取一个子集，减少后续策略的候选数量。

## 五、`HintBasedServiceInstanceListSupplier` 和 `RequestBasedStickySessionServiceInstanceListSupplier`：请求级选择

`HintBasedServiceInstanceListSupplier` 根据请求中的提示信息（如版本号、标签）选择实例。

`RequestBasedStickySessionServiceInstanceListSupplier` 实现粘滞会话，同一个客户端尽量命中同一实例。

两者都依赖 `Request` 上下文，而不是静态配置。

## 六、为什么这篇适合放在 `NamedContextFactory` 之后

前一篇讲到 `NamedContextFactory` 为每个服务创建独立子上下文。

这意味着：

- `order-service` 的 supplier 链可以是：`Discovery -> Cache -> HealthCheck -> ZonePreference -> RoundRobin`
- `payment-service` 的 supplier 链可以是：`Discovery -> Cache -> HealthCheck -> Weighted -> Random`

两个服务的 supplier 链完全独立，互不干扰。

所以：

- `NamedContextFactory` 提供隔离
- 本篇提供隔离后的扩展策略组合

## 七、几个最容易错的判断

### 1. 扩展策略会修改实例列表内容

不成立。

扩展策略只改变实例列表的顺序或子集，不修改实例本身的数据。

### 2. 所有扩展策略都继承同一个基类

成立。

都继承 `DelegatingServiceInstanceListSupplier`，使用装饰器模式。

### 3. 扩展策略越多，每次请求的延迟越高

部分成立。

但通过 `CachingServiceInstanceListSupplier` 和 `SubsetServiceInstanceListSupplier` 可以缓解性能问题。

### 4. 粘滞会话和区域偏好可以同时生效

可以。

通过组合多个 supplier，区域偏好先排序，粘滞会话再过滤，两者互不冲突。

### 5. 扩展策略只能用在 LoadBalancer 里

不成立。

`ServiceInstanceListSupplier` 是通用抽象，任何需要实例列表的地方都可以复用。

## 收网

现在可以回到开头的问题：为什么负载均衡不只是轮询？

因为真实负载均衡需要先通过 `ServiceInstanceListSupplier` 链对实例列表进行区域偏好、权重排序、子集化、提示过滤、粘滞会话等预处理，再交给 `RoundRobinLoadBalancer` 选一个。

每个扩展策略都是一个独立的 `DelegatingServiceInstanceListSupplier`，通过装饰器模式组合成链，互不干扰。

所以这篇真正该带走的结论不是“负载均衡有很多策略”，而是：

**`ServiceInstanceListSupplier` 通过装饰器模式组合多种扩展策略（区域偏好、权重、子集、提示、粘滞会话），每个策略只负责一层过滤或排序，链的最终输出交给 `ReactorLoadBalancer` 选择；`NamedContextFactory` 为每个服务隔离配置，使不同服务的 supplier 链可以独立组装。**

下一篇进入断路器抽象。