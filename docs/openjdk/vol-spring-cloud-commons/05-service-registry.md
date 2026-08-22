# 为什么服务一启动就被注册中心发现了：`ServiceRegistry` 如何自动完成服务注册

> 本文基于 Spring Cloud 2025.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-commons` 的第五篇，承接前一篇 `DiscoveryClient`。重点放在 `ServiceRegistry`、`Registration`、`AbstractAutoServiceRegistration`、`ServiceRegistryAutoConfiguration`，以及服务注册的触发时机。下一篇将进入 `@LoadBalanced` / `LoadBalancerClient`。

## 为什么服务根本不需要写“启动后去注册自己”的代码

上一篇讲了：作为消费者，业务代码通过 `DiscoveryClient` 找到别人。

但一个微服务通常同时也是**提供者**：

- 它需要把自己注册到注册中心
- 别的服务才能通过 `DiscoveryClient` 找到它

如果这一步也要业务代码手动做：

```java
// 启动后手动注册
nacosRegistry.register(myServiceInstance);
```

那每个服务都要重复写这段逻辑，而且还要考虑：

- 何时注册
- 何时注销
- 重启时重复注册怎么办
- 优雅关闭时怎么反注册

Spring Cloud 的解法是：`ServiceRegistry` 提供注册契约，`AbstractAutoServiceRegistration` 自动完成注册时机。

**第一层问题是：`ServiceRegistry` 定义“怎么注册/注销”，`Registration` 描述“要注册的实例是谁”。**

**第二层问题是：`AbstractAutoServiceRegistration` 负责“什么时候自动注册”。**

**第三层问题是：注册的触发时机往往和 WebServer 启动事件强相关。**

## 先看失败方案：为什么不能把注册逻辑写在每个服务的启动代码里、不能用静态配置代替注册、也不能乱时机注册

### 失败方案一：每个服务在启动代码里手动调用注册 API

这会：

- 让注册逻辑散落在每个服务
- 忘记注销造成数据残留
- 注册时机不统一
- 重启时重复注册需要额外处理

### 失败方案二：用静态配置文件代替注册中心

这只适合：

- 实例数量很少
- 不动态扩缩容
- 网络拓扑稳定

一旦：

- 实例动态上下线
- 扩容缩容
- 故障摘除

静态配置就完全失效。

### 失败方案三：在任意时机注册，不和 WebServer 生命周期绑定

如果注册时机错了：

- WebServer 还没起来就把自己注册了 → 调用方请求到未就绪实例
- 太晚注册 → 服务已经能接受流量但别人找不到它

所以注册时机必须和“实例真正准备好接流量”对齐。

## `ServiceRegistry` 的最小总图

```text
WebServerInitializedEvent
   -> AbstractAutoServiceRegistration.onApplicationEvent()
   -> ServiceRegistry.register(Registration)
   -> Registration describes this instance
   -> registry centers (Nacos/Consul/Eureka) store it
```

```text
[启动事件]
WebServerInitializedEvent

   ->

[自动注册监听]
AbstractAutoServiceRegistration

   ->

[注册契约]
ServiceRegistry.register()

   ->

[实例描述]
Registration

   ->

[注册中心]
Nacos / Consul / Eureka
```

## 一、`ServiceRegistry`：注册/注销的统一契约

```java
public interface ServiceRegistry<R extends Registration> {
    void register(R registration);
    void deregister(R registration);
    void close();
    void setStatus(R registration, String status);
    <T> T getStatus(R registration);
}
```

它定义了一个微服务“作为提供者”需要的能力：

- `register`：把实例注册到注册中心
- `deregister`：注销实例
- `close`：关闭注册中心客户端相关的资源
- `setStatus` / `getStatus`：实例状态管理

Nacos 的 `NacosServiceRegistry`、Consul / Eureka 的实现都实现这套契约。

此外，`ServiceRegistryAutoConfiguration` 还提供了 `ServiceRegistryEndpoint`，把服务注册的状态操作暴露为 Actuator 端点，这与 `vol-spring-boot` 的 Actuator 主线形成一致性。

## 二、`Registration`：描述“要注册的实例是谁”

`ServiceRegistry.register(R registration)` 需要一个 `Registration`，它描述：

- 服务ID
- 主机
- 端口
- 元数据

`Registration` 本身只是一个 marker 接口，直接继承 `ServiceInstance`：

```java
public interface Registration extends ServiceInstance {
}
```

也就是说，`Registration` 没有重新声明 `getServiceId()`、`getHost()`、`getPort()` 等，这些全部继承自 `ServiceInstance`。

因此：

- `ServiceRegistry` 知道“怎么注册”
- `Registration` 告诉它“注册谁”
- `Registration` 的语义就是“一个带 `ServiceInstance` 信息的注册元数据”

## 三、`AbstractAutoServiceRegistration`：真正决定“什么时候注册”

`AbstractAutoServiceRegistration<R extends Registration>` 是 Spring Cloud 自动注册的核心。

它：

- 实现了 `ApplicationListener<WebServerInitializedEvent>`
- 监听 WebServer 启动完成事件
- 在合适时机调用 `ServiceRegistry.register(registration)`
- 在 `@PreDestroy` 阶段调用 `ServiceRegistry.deregister()` 和 `close()`

来源：`spring-cloud-commons/.../serviceregistry/AbstractAutoServiceRegistration.java:49-50,111-120,231-233`。

这意味着：

- 服务不会在 WebServer 还没起来时注册
- 服务关闭时会通过 `@PreDestroy` 反注册

注册时机与 WebServer 生命周期对齐，避免了“注册了但还没准备好”“关了但没反注册”两类问题。

## 四、为什么这篇必须紧跟 `DiscoveryClient`

服务发现与注册是同一枚硬币的两面：

- `DiscoveryClient`：消费者视角，找人
- `ServiceRegistry` / `AbstractAutoServiceRegistration`：提供者视角，被找到

两个接口：

- 都围绕注册中心
- 都通过 `Registration`（`ServiceInstance`）描述实例
- 都由 `AbstractAutoServiceRegistration` 和具体实现协作

调换顺序会让读者没概念：发现时拿到的实例，是注册时谁上报的。

## 五、几个最容易错的判断

### 1. 服务注册必须业务代码手动调用

不成立。

`AbstractAutoServiceRegistration` 监听 `WebServerInitializedEvent` 自动完成注册。

### 2. `ServiceRegistry` 就是注册中心

不成立。

`ServiceRegistry` 是注册/注销的统一契约，注册中心是底层实现。

### 3. `Registration` 和 `ServiceInstance` 没关系

不成立。

`Registration` 继承 `ServiceInstance`，两者共享 host / port / metadata 描述。

### 4. 注册时机无所谓

不成立。

注册必须和 WebServer 启动完成对齐，否则会注册到未就绪实例或造成反注册遗漏。

### 5. 服务关闭时反注册不重要

不成立。

`AbstractAutoServiceRegistration` 会在 `ContextClosedEvent` 时反注册，否则会产生僵尸实例。

## 收网

现在可以回到开头的问题：为什么服务根本不需要写“启动后去注册自己”的代码？

因为 `AbstractAutoServiceRegistration` 监听 `WebServerInitializedEvent`，在 WebServer 启动完成后自动调用 `ServiceRegistry.register(registration)`，并把实例描述交给 `Registration`。

所以这篇真正该带走的结论不是“注册中心的客户端会自动发现我”，而是：

**`ServiceRegistry` 定义了服务注册 / 注销的统一契约，`Registration` 描述实例是谁，`AbstractAutoServiceRegistration` 监听 WebServer 启动事件自动完成注册和关闭时反注册；因此，服务的提供方视角的注册行为被框架标准化接入了。**

下一篇进入 `@LoadBalanced` / `LoadBalancerClient`。