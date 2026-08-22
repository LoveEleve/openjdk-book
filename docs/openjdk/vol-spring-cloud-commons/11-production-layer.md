# 为什么配置刷新和服务发现健康需要接入 Actuator：生产层如何把 Commons 能力暴露给运维系统

> 本文基于 Spring Cloud 2025.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-commons` 的第十一篇，承接前一篇断路器抽象。重点放在 `RefreshEndpoint`、`RefreshAutoConfiguration`、`DiscoveryClientHealthIndicator`、`DiscoveryHealthIndicator`，以及它们如何把 Commons 的配置刷新和服务发现能力接入 Boot 的 Actuator 运维主线。下一篇将进入可观测性接线。

## 为什么 Commons 的配置刷新和服务发现，需要向 Actuator 暴露 Endpoint

前几篇已经讲了 Bootstrap 上下文、`@RefreshScope`、`DiscoveryClient`、`ServiceRegistry`。

但如果这些能力只存在于应用内部，运维系统无法感知：

- 配置是否刷新成功
- 注册中心是否可达
- 服务实例是否健康

Boot 的 Actuator 已经提供了端点模型和健康检查能力。Commons 需要把它的能力也接入这套体系。

**第一层问题是：`RefreshEndpoint` 把 `ContextRefresher.refresh()` 暴露成 Actuator 端点，让运维系统可以触发配置刷新。**

**第二层问题是：`DiscoveryClientHealthIndicator` 把注册中心是否可用接入 Actuator health。**

**第三层问题是：`DiscoveryHealthIndicator` 让更细粒度的服务发现健康检查成为可能。**

## 先看失败方案：为什么不能只靠 `ContextRefresher.refresh()`，也不用手工写健康检查

### 失败方案一：配置刷新只能通过 `ContextRefresher.refresh()` 编程式触发

这会：

- 每次刷新都要手动实现调用入口
- 无法通过外部系统触发
- 刷新结果无法被运维系统消费

### 失败方案二：通过手工写一个 `/health` 接口检查注册中心

这会：

- 与 Actuator 的健康检查体系不一致
- 无法被 `health` 端点统一聚合
- 每个团队实现方式不同，缺乏统一标准

## 生产层最小总图

```text
Common 能力
   -> RefreshEndpoint -> /actuator/refresh
   -> DiscoveryClientHealthIndicator -> /actuator/health
   -> DiscoveryHealthIndicator -> /actuator/health
```

```text
[Commons 能力]
配置刷新 / 服务发现

   ->

[Actuator 接入]
RefreshEndpoint / DiscoveryClientHealthIndicator

   ->

[运维效果]
通过 /actuator/refresh 触发刷新，通过 /actuator/health 看到注册中心可达性
```

## 一、`RefreshEndpoint`：把配置刷新暴露为 Actuator 端点

`RefreshEndpoint` 在 Commons 中通过 `RefreshEndpointAutoConfiguration` 自动装配：

```java
@Endpoint(id = "refresh")
public class RefreshEndpoint {

    private final ContextRefresher contextRefresher;

    @WriteOperation
    public Collection<String> refresh() {
        Set<String> keys = this.contextRefresher.refresh();
        LOG.info("Refreshed keys : " + keys);
        return keys;
    }
}
```

来源：`spring-cloud-context/.../endpoint/RefreshEndpoint.java:33-49`。

注意返回值是 `Collection<String>`（内部从 `Set` 转换而来），不是 `Set`。

- `@Endpoint(id = "refresh")` 标记为 Actuator 端点
- `@WriteOperation` 标注为 POST 操作
- 调用 `ContextRefresher.refresh()` 触发配置刷新
- 返回变更的配置键列表

当配置中心推送变更后，外部系统可以通过 `POST /actuator/refresh` 触发刷新，而不需要进容器或调用 Spring 内部 API。

## 二、`RefreshAutoConfiguration`：自动装配刷新端点

`RefreshAutoConfiguration` 负责：

- 创建 `RefreshScope` Bean
- 创建 `ContextRefresher` Bean
- 创建 `RefreshEndpoint` Bean
- 注册 `RefreshScopeBeanDefinitionEnhancer`
- 处理 `@RefreshScope` 注解的 Bean 定义

也就是说，`refresh` 端点的自动装配和 `@RefreshScope` 的 Bean 定义增强是同一个配置类完成的。

## 三、`DiscoveryClientHealthIndicator`：把注册中心可用性接入 Actuator health

`DiscoveryClientHealthIndicator` 实现 `DiscoveryHealthIndicator`，并发 `InstanceRegisteredEvent`：

```java
public class DiscoveryClientHealthIndicator
        implements DiscoveryHealthIndicator, Ordered, ApplicationListener<InstanceRegisteredEvent<?>> {

    private final ObjectProvider<DiscoveryClient> discoveryClient;
    private final DiscoveryClientHealthIndicatorProperties properties;
    private AtomicBoolean discoveryInitialized = new AtomicBoolean(false);

    @Override
    public void onApplicationEvent(InstanceRegisteredEvent<?> event) {
        if (this.discoveryInitialized.compareAndSet(false, true)) {
            this.log.debug("Discovery Client has been initialized");
        }
    }

    @Override
    public Health health() {
        Health.Builder builder = new Health.Builder();
        if (this.discoveryInitialized.get()) {
            DiscoveryClient client = this.discoveryClient.getIfAvailable();
            if (properties.isUseServicesQuery()) {
                List<String> services = client.getServices();
                builder.status(new Status("UP", description)).withDetail("services", services);
            } else {
                client.probe();
                builder.status(new Status("UP", description));
            }
        }
        // ...
    }
}
```

来源：`spring-cloud-commons/.../discovery/health/DiscoveryClientHealthIndicator.java:37-80`。

它比“简单调用一次 getServices”要细致：

- 只有 `InstanceRegisteredEvent` 触发后（`discoveryInitialized` 为 true）才判定健康
- 通过 `useServicesQuery` 属性决定用 `getServices()` 查询还是 `probe()` 探活
- 通过 `DiscoveryClientHealthIndicatorProperties` 控制 includeDescription / useServicesQuery

## 四、`DiscoveryHealthIndicator` 和 `DiscoveryClientHealthIndicatorProperties`

`DiscoveryHealthIndicator` 是更细粒度的健康检查接口：

- 可以按 serviceId 检查
- 可以配置超时

`DiscoveryClientHealthIndicatorProperties` 控制哪些 serviceId 需要检查，以及健康检查的超时和顺序。

这为 Alibaba 卷的 `NacosDiscoveryHealthIndicator` 提供了回链点。

## 五、为什么这篇必须放在所有主干层之后

主干层已经讲完了：

- Bootstrap 上下文
- `@RefreshScope`
- `DiscoveryClient`
- `ServiceRegistry`
- `@LoadBalanced` / `LoadBalancerClient`
- `ReactorLoadBalancer`
- `NamedContextFactory`
- 断路器

生产层负责把这些能力接进 Boot 的 Actuator 主线。

如果不先理解这些能力本身，就无法理解“为什么需要暴露和怎么暴露”。

## 六、几个最容易错的判断

### 1. `RefreshEndpoint` 是 `@RefreshScope` 的一部分

不成立。

`RefreshEndpoint` 是独立的 Actuator 端点，它调用 `ContextRefresher.refresh()` 触发刷新。

### 2. 注册中心健康检查只能通过外部系统做

不成立。

`DiscoveryClientHealthIndicator` 在应用内部检查注册中心，结果接入 Actuator health。

### 3. `DiscoveryClientHealthIndicator` 只检查 `DiscoveryClient` 是否可达

不完整。

它还可用 `DiscoveryClientHealthIndicatorProperties` 配置按 serviceId 维度的健康检查。

### 4. Commons 的生产层和 Boot 的 Actuator 没有关系

不成立。

Commons 的生产层正是通过 Actuator 端点模型和健康检查模型把能力暴露给运维系统。

### 5. 配置刷新不需要暴露端点

不成立。

不暴露端点，配置中心推送变更后应用无法被外部系统触发刷新。

## 收网

现在可以回到开头的问题：为什么 Commons 的配置刷新和服务发现，需要向 Actuator 暴露 Endpoint？

因为 `RefreshEndpoint` 把 `ContextRefresher.refresh()` 暴露为 Actuator 端点，`DiscoveryClientHealthIndicator` 把注册中心可用性接入 Actuator health；两者都通过 Boot 的 Actuator 主线把 Commons 能力变成运维系统可消费的入口。

所以这篇真正该带走的结论不是“Commons 有生产层”，而是：

**Commons 通过 `RefreshEndpoint` 和 `DiscoveryClientHealthIndicator` 把配置刷新和服务发现能力接入 Boot 的 Actuator 体系，让运维系统可以通过 `/actuator/refresh` 触发刷新、通过 `/actuator/health` 感知注册中心可用性。**

下一篇进入可观测性接线。