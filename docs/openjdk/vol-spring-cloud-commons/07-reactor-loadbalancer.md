# 为什么负载均衡不是“轮询”两个字：`ReactorLoadBalancer` 如何把实例列表变成选实例策略

> 本文基于 Spring Cloud 2025.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-commons` 的第七篇，承接前一篇 `@LoadBalanced` / `LoadBalancerClient`。重点放在 `ReactorLoadBalancer`、`RoundRobinLoadBalancer`、`RandomLoadBalancer`、`ServiceInstanceListSupplier` 及其组合链，以及 `LoadBalancerClientFactory`（NamedContextFactory）如何为每个服务创建独立的 LoadBalancer 上下文。下一篇将进入 `NamedContextFactory`。

## 为什么负载均衡不只是“轮询”两个字，而是一整条实例发现链

多数人提到负载均衡，第一反应往往是一个很简单的概念：

- 多个实例轮流选一个

但真实负载均衡器要回答的远不止“选哪个”。它还要回答：

- 实例列表从哪里来
- 要不要缓存
- 要不要健康检查
- 要不要按权重、区域、提示建议选
- 选完后要不要记录指标

`ReactorLoadBalancer` 把这些问题拆成了：

- `ServiceInstanceListSupplier`：负责提供实例列表
- `ReactorLoadBalancer`：负责在列表里选一个

**第一层问题是：`ServiceInstanceListSupplier` 是实例列表的来源，不是策略本身。**

**第二层问题是：`RoundRobinLoadBalancer` 和 `RandomLoadBalancer` 是策略，它们不关心实例从哪里来。**

**第三层问题是：`ServiceInstanceListSupplierBuilder` 可以把多个 supplier 组合成一条链。**

## 先看失败方案：为什么不能每次选实例时都去注册中心查、不能只用一个静态列表、也不能把 supplier 和策略搞混

### 失败方案一：每次选实例时都去注册中心查

这会：

- 每次请求都调用注册中心 API
- 给注册中心巨大压力
- 响应变慢

所以需要 `CachingServiceInstanceListSupplier` 做缓存层。

### 失败方案二：始终只用一个静态列表

静态列表只适合开发环境。

生产环境实例：

- 动态上下线
- 扩缩容
- 健康检查

所以需要 `DiscoveryClientServiceInstanceListSupplier` 从注册中心拉取，并通过 `HealthCheckServiceInstanceListSupplier` 过滤不健康实例。

### 失败方案三：`ServiceInstanceListSupplier` 和 `ReactorLoadBalancer` 混成同一个东西

选实例和准备实例列表是两件事：

- Supplier 确定“有哪些实例可选”
- LoadBalancer 确定“选哪个”

如果合在一起，策略和来源耦合，无法独立替换。Boot 把两者分开，让策略可以复用不同的 supplier 链。

## `ReactorLoadBalancer` 的最小总图

```text
service call
   -> LoadBalancerClientFactory.getLoadBalancer(serviceId)
   -> ReactorLoadBalancer.choose(request)
   -> ServiceInstanceListSupplier.get(request)
   -> DiscoveryClient -> Cache -> HealthCheck ->  filtered instances
   -> RoundRobinLoadBalancer picks one
```

```text
[引用]
LoadBalancerClientFactory 为每个服务创建独立上下文

   ->

[实例来源]
ServiceInstanceListSupplier 链

   ->

[策略选择]
ReactorLoadBalancer.choose()

   ->

[结果]
ServiceInstance
```

## 一、`ServiceInstanceListSupplier`：实例列表的来源抽象

`ServiceInstanceListSupplier` 是响应式服务实例列表的供应接口：它继承 `Supplier<Flux<List<ServiceInstance>>>`，并提供 `get(Request)` 和 `getServiceId()`：

```java
public interface ServiceInstanceListSupplier extends Supplier<Flux<List<ServiceInstance>>> {
    String getServiceId();
    default Flux<List<ServiceInstance>> get(Request request) {
        return get();
    }
    static ServiceInstanceListSupplierBuilder builder() { ... }
}
```

来源：`spring-cloud-loadbalancer/.../core/ServiceInstanceListSupplier.java:33-43`。

Commons 提供了多种实现，可以组合使用：

- `DiscoveryClientServiceInstanceListSupplier`：从注册中心拉取
- `CachingServiceInstanceListSupplier`：缓存一层
- `HealthCheckServiceInstanceListSupplier`：健康检查过滤
- `ZonePreferenceServiceInstanceListSupplier`：按区域偏好选择
- `WeightedServiceInstanceListSupplier`：按权重过滤
- `SubsetServiceInstanceListSupplier`：子集过滤
- `HintBasedServiceInstanceListSupplier`：按提示建议选择
- `RequestBasedStickySessionServiceInstanceListSupplier`：粘滞会话选择

用户通过 `ServiceInstanceListSupplierBuilder` 按需组装。

## 二、`RoundRobinLoadBalancer`：最简单的轮询策略

`RoundRobinLoadBalancer` 是 `ReactorServiceInstanceLoadBalancer` 的实现：

- 它从 `ServiceInstanceListSupplier` 拿实例列表
- 用 `AtomicInteger position` 递增计数取模（`position.incrementAndGet() & Integer.MAX_VALUE`，然后 `pos % instances.size()`）
- 返回选中的实例

`choose()` 方法返回 `Mono<Response<ServiceInstance>>`，当实例列表为空时返回 `EmptyResponse`，单实例时不移动 position。

来源：`spring-cloud-loadbalancer/.../core/RoundRobinLoadBalancer.java:43,114-116`。

它不关心：

- 实例从哪里来
- 实例是否健康
- 缓存是否过期

这些全部由 supplier 链负责。

## 三、`LoadBalancerClientFactory`：为每个服务创建独立 LoadBalancer 上下文

`LoadBalancerClientFactory` 继承 `NamedContextFactory`，为每个 `serviceId` 创建独立的子上下文。

这意味着：

- 可以为 `order-service` 单独配置负载均衡策略
- 不会影响 `payment-service` 的配置
- 每个服务的 supplier 链和策略可以不一样

`@LoadBalancerClient(name = "order-service", configuration = MyLBConfig.class)` 就是通过 `NamedContextFactory` 实现的。

## 四、为什么这篇必须紧跟 `@LoadBalanced` / `LoadBalancerClient`

前一篇讲了：

- 拦截器 + `LoadBalancerClient` 完成服务名 URI 到真实 IP 的翻译

但“选哪个实例”这部分交给了 `LoadBalancerClient.execute()` 内部的 `ServiceInstanceChooser.choose()`。

这一篇展开的就是 `choose()` 内部的事：

- `ServiceInstanceListSupplier` 提供实例列表
- `ReactorLoadBalancer` 从列表里选一个
- `LoadBalancerClientFactory` 为每个服务隔离配置

所以：

- 前一篇是负载均衡的“入口”
- 这一篇是“内部怎么选”

## 五、几个最容易错的判断

### 1. 轮询就是负载均衡的全部

不成立。

轮询只是策略之一，实例列表来源、缓存、健康检查、指标采集等由 supplier 链完成。

### 2. `ServiceInstanceListSupplier` 只有一个实现

不成立。

Commons 提供了多种 supplier，可以通过 `ServiceInstanceListSupplierBuilder` 组合成链。

### 3. 每个服务的负载均衡配置共享同一个上下文

不成立。

`LoadBalancerClientFactory` 通过 `NamedContextFactory` 为每个服务创建独立子上下文，配置隔离。

### 4. 选实例时每次都去注册中心查

不成立。

`CachingServiceInstanceListSupplier` 缓存实例列表，减少注册中心压力。

### 5. `ReactorLoadBalancer` 只支持轮询

不成立。

还支持随机、加权、区域偏好、粘滞会话等扩展策略，通过不同 supplier 组合实现。

## 收网

现在可以回到开头的问题：为什么负载均衡不只是“轮询”两个字？

因为 `ReactorLoadBalancer` 把“选哪个实例”和“实例从哪里来”拆成了两个独立抽象：

- `ServiceInstanceListSupplier` 链负责实例的来源、缓存、健康检查
- `RoundRobinLoadBalancer` 等策略负责从列表里选一个
- `LoadBalancerClientFactory` 负责为每个服务隔离配置

所以这篇真正该带走的结论不是“轮询是默认策略”，而是：

**`ReactorLoadBalancer` 把实例列表供应和选择策略分离；`ServiceInstanceListSupplier` 链通过组合完成发现、缓存、健康检查，策略只负责选；`LoadBalancerClientFactory` 通过 `NamedContextFactory` 为每个服务隔离配置，让负载均衡成为可组装、可扩展、可隔离的抽象层。**

下一篇进入 `NamedContextFactory`。