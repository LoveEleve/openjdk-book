# 为什么应用不用关心注册中心是谁：`DiscoveryClient` 如何统一服务发现抽象

> 本文基于 Spring Cloud 2025.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-commons` 的第四篇，承接前一篇 `@RefreshScope`。重点放在 `DiscoveryClient`、`CompositeDiscoveryClient`、`ReactiveDiscoveryClient`、`@EnableDiscoveryClient`，以及它如何为 Nacos / Consul / Eureka 提供统一抽象。下一篇将进入 `ServiceRegistry` 服务注册抽象。

## 为什么应用代码不需要告诉它“用 Nacos 还是 Consul”来做服务发现

在一个分布式系统里，服务 A 需要找到服务 B 的地址。

这一步如果直接写在业务代码里，就会出现耦合：

```java
// 面向具体注册中心写
NacosClient.getInstances("order-service");
```

这意味着业务代码一旦换注册中心，全部都要改。

Spring Cloud 的解法是：

- 业务代码只依赖一个接口：`DiscoveryClient`
- `DiscoveryClient` 的 `getInstances(serviceId)` 返回 `List<ServiceInstance>`
- 不管底层是 Nacos、Consul 还是 Eureka，业务代码都不变

**第一层问题是：`DiscoveryClient` 是“服务发现”的稳定契约，业务代码只看到这个接口。**

**第二层问题是：`CompositeDiscoveryClient` 让多个注册中心共存，而不是只支持一个。**

**第三层问题是：`ReactiveDiscoveryClient` 用响应式模型统一了异步服务发现。**

## 先看失败方案：为什么不能直接在业务代码里调用注册中心 API、不能只写死一个实现

### 失败方案一：业务代码直接调用注册中心客户端 API

这会：

- 把业务代码和特定注册中心绑定
- 换注册中心时业务代码大改
- 测试时无法用 mock DiscoveryClient 替换

### 失败方案二：只支持一个注册中心，把它写进框架

这会让整个服务发现体系：

- 丧失可替换性
- 和某个具体中间件绑死
- 无法支持多个注册中心共存

## `DiscoveryClient` 的最小总图

```text
application wants service instances
   -> DiscoveryClient.getInstances(serviceId)
   -> CompositeDiscoveryClient delegates to all DiscoveryClients
   -> each implementation (Nacos/Consul/Eureka) returns List<ServiceInstance>
```

```text
[业务请求]
getInstances("order-service")

   ->

[统一契约]
DiscoveryClient

   ->

[聚合发现]
CompositeDiscoveryClient

   ->

[具体实现]
Nacos / Consul / Eureka
```

## 一、`DiscoveryClient`：服务发现的稳定契约

源码里 `DiscoveryClient` 的核心方法：

```java
public interface DiscoveryClient extends Ordered {
    String description();
    List<ServiceInstance> getInstances(String serviceId);
    List<String> getServices();
}
```

`DiscoveryClient` 接口继承 `Ordered`，说明多个 `DiscoveryClient` 是有顺序的。`CompositeDiscoveryClient` 会按顺序遍历所有实现，第一个返回非空结果的会被优先使用。

除了 Nacos / Consul / Eureka 等具体实现外，Commons 还自带一个默认实现：

- `SimpleDiscoveryClient`

它从 `SimpleDiscoveryProperties` 读取静态配置的服务实例列表，适用于没有注册中心的开发环境。

`.getInstances(serviceId)` 返回该服务的所有实例，`.getServices()` 返回当前注册中心已知的所有服务名。

## 二、`CompositeDiscoveryClient`：让多个注册中心共存

如果应用同时注册到 Nacos 和 Consul，需要同时从两边拿实例。

`CompositeDiscoveryClient` 会：

- 持有多个 `DiscoveryClient`
- 遍历每个 client
- 收集所有实例并合并

所以 `CompositeDiscoveryClient` 不是一个新的注册中心，而是：

- 所有注册中心实现的聚合入口

## 三、`ReactiveDiscoveryClient`：响应式统一服务发现

云原生应用越来越多使用响应式编程。

`DiscoveryClient` 的调用是阻塞式的 `List<ServiceInstance>`，而响应式应用中不希望阻塞。

`ReactiveDiscoveryClient` 用响应式模型：

```java
public interface ReactiveDiscoveryClient extends Ordered {
    Flux<ServiceInstance> getInstances(String serviceId);
    Flux<String> getServices();
}
```

它对应 `DiscoveryClient` 的响应式版本。

使用时注意：

- 响应式应用用 `ReactiveDiscoveryClient`
- 阻塞式应用用 `DiscoveryClient`
- `ReactiveCompositeDiscoveryClient` 是响应式版本的聚合实现

## 四、`@EnableDiscoveryClient`：选择性开启服务发现

`@EnableDiscoveryClient` 通过 `@Import(EnableDiscoveryClientImportSelector.class)` 触发一种注册中心实现。

`EnableDiscoveryClientImportSelector` 继承 `SpringFactoryImportSelector<EnableDiscoveryClient>`，它通过 `SpringFactoriesLoader` 加载 `EnableAutoConfiguration` 类型下的相关配置类，从而让某一套注册中心自动配置生效。

不过，在 Spring Cloud Commons 里：

- 如果 classpath 上只有一个 `DiscoveryClient` 实现
- 自动配置通常足以让 `DiscoveryClient` 进入容器
- 显式写 `@EnableDiscoveryClient` 更多用于明确语义或在多实现共存时选择要启用的配置

所以:

- `@EnableDiscoveryClient` 的作用是“选择哪套 discovery 配置”
- 而不是“唯一的开启开关”

## 五、Discovery 健康接线：把注册中心接入 Actuator

这部分原规划归入 Commons D-2 生产层。

`DiscoveryClientHealthIndicator` / `DiscoveryHealthIndicator` 会检查各个 `DiscoveryClient` 是否可用，并把结果接入 Actuator health：

- 如果注册中心不可达，`DiscoveryClient` 可能抛异常或返回空列表
- `DiscoveryClientHealthIndicator` 通过 `DiscoveryHealthIndicatorProperties` 判断哪些 serviceId 要检查、超时和顺序

这也为 Alibaba 卷的 `NacosDiscoveryHealthIndicator` 提供了回链点。

## 六、为什么这篇必须先于 `ServiceRegistry`

同一个微服务同时承担两种角色：

- 作为提供者，把自己注册到注册中心 → `ServiceRegistry`
- 作为消费者，找到别的服务 → `DiscoveryClient`

这是两个方向、两个接口，但都围绕同一个注册中心。

必须先理解“服务是如何被发现的”，接下来才能理解“服务是如何被注册的”：

- 发现关注“调用方从哪拿实例列表”
- 注册关注“自己实例何时、如何上报”

两者在 `AbstractAutoServiceRegistration` 里的联动是后一篇的关键。

## 七、几个最容易错的判断

### 1. 应用代码应该直接调用 Nacos / Consul 的客户端

不成立。

业务代码应依赖 `DiscoveryClient`，否则换注册中心就要改业务代码。

### 2. `CompositeDiscoveryClient` 是一个新注册中心

不成立。

它是所有 `DiscoveryClient` 的聚合入口，本身不实现注册中心逻辑。

### 3. 响应式应用也必须用 `DiscoveryClient`

不成立。

响应式应用应使用 `ReactiveDiscoveryClient`，阻塞式应用用 `DiscoveryClient`。

### 4. `@EnableDiscoveryClient` 必须有

不总是。

当 classpath 只有一个实现时，通常不需要显式写。

### 5. 服务发现不用区分方向

不成立。

`DiscoveryClient` 是消费者视角，`ServiceRegistry` 是服务提供者视角，方向不同。

## 收网

现在可以回到开头的问题：为什么应用代码不需要告诉它“用 Nacos 还是 Consul”来做服务发现？

因为服务发现被抽象成了 `DiscoveryClient`：

- 业务代码依赖 `DiscoveryClient`
- `CompositeDiscoveryClient` 聚合多个实现
- `ReactiveDiscoveryClient` 处理响应式场景

所以这篇真正该带走的结论不是“Nacos 提供了服务发现”，而是：

**`DiscoveryClient` 是服务是否能被找到的统一契约，业务代码只依赖它；`CompositeDiscoveryClient` 让多个注册中心共存，`ReactiveDiscoveryClient` 让异步应用接入；具体是 Nacos、Consul 还是 Eureka，只在实现层发生。**

下一篇进入 `ServiceRegistry` 服务注册抽象。