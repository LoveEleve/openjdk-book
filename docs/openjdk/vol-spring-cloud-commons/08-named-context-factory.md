# 为什么每个 FeignClient 或 LoadBalancer 服务可以有自己独立的配置：`NamedContextFactory` 如何为每个名字创建子上下文

> 本文基于 Spring Cloud 2025.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-commons` 的第八篇，承接前一篇 `ReactorLoadBalancer`。重点放在 `NamedContextFactory`、`Specification`、子上下文创建与隔离机制，以及它在 `LoadBalancerClientFactory` 和 Feign 中的角色。下一篇将进入 `ServiceInstanceListSupplier` 扩展策略。

## 为什么 Feign 和 LoadBalancer 能为每个服务单独配置，而不会互相影响

在 Spring Cloud 里，这是很常见的配置：

```java
@FeignClient(name = "order-service", configuration = OrderFeignConfig.class)
@FeignClient(name = "payment-service", configuration = PaymentFeignConfig.class)
```

每个 FeignClient 的配置是完全隔离的。`order-service` 的超时设置不会影响 `payment-service`。

同样，在 LoadBalancer 里：

```java
@LoadBalancerClient(name = "order-service", configuration = OrderLBConfig.class)
```

`order-service` 的轮询策略和 `payment-service` 的随机策略也互不干扰。

背后的机制不是简单地把配置放在 Map 里，而是：

- **`NamedContextFactory` 为每个服务创建独立的 ApplicationContext**

**第一层问题是：`NamedContextFactory` 不是配置集合，而是子上下文工厂。**

**第二层问题是：每个子上下文都有自己的 BeanDefinition 和 refresh 生命周期。**

**第三层问题是：子上下文是独立的，但 parent 上下文共享公共 Bean。**

## 先看失败方案：为什么不能用一个 Map 存配置、不能把所有配置放在同一个上下文里

### 失败方案一：用一个 Map 存每个服务的配置

如果只是把配置存成 Map，那么：

- 配置不会自动变成 Bean
- 不会自动创建 `ServiceInstanceListSupplier` 等实例
- 子上下文带来的 Bean 隔离和生命周期管理全部丢失

### 失败方案二：所有服务的配置放在同一个 ApplicationContext 里

这会导致：

- `order-service` 的配置会污染 `payment-service`
- 同名 Bean 冲突
- 无法按服务独立管理生命周期

## `NamedContextFactory` 的最小总图

```text
name = "order-service", configuration = OrderConfig.class
   -> NamedContextFactory.getContext("order-service")
   -> create GenericApplicationContext
   -> register OrderConfig.class + defaultConfigType
   -> context.refresh()
   -> return context
   -> get beans from child context
```

```text
[父上下文]
ApplicationContext

   ->

[NamedContextFactory]
getContext("order-service")

   ->

[子上下文]
GenericApplicationContext（独立）

   ->

[注册配置]
OrderConfig + defaultConfig + PropertyPlaceholderAutoConfiguration

   ->

[refresh]
子上下文刷新

   ->

[获取 Bean]
getBean(serviceName, type)
```

## 一、`NamedContextFactory` 的核心：`getContext(name)` 创建或复用子上下文

`NamedContextFactory` 的核心模式是：

```java
protected GenericApplicationContext getContext(String name) {
    if (!this.contexts.containsKey(name)) {
        synchronized (this.contexts) {
            if (!this.contexts.containsKey(name)) {
                this.contexts.put(name, createContext(name));
            }
        }
    }
    return this.contexts.get(name);
}
```

来源：`spring-cloud-context/.../named/NamedContextFactory.java:119-128`。

它使用 `ConcurrentHashMap` 缓存子上下文，通过双重检查锁确保只创建一次。

`createContext(name)` 进一步：

- `buildContext(name)` 创建 `GenericApplicationContext` 实例
- `registerBeans(name, context)` 注册配置类 + `PropertyPlaceholderAutoConfiguration` + `defaultConfigType`
- `context.refresh()` 刷新子上下文

`registerBeans` 的关键源码：

```java
public void registerBeans(String name, GenericApplicationContext context) {
    AnnotationConfigRegistry registry = (AnnotationConfigRegistry) context;
    if (this.configurations.containsKey(name)) {
        for (Class<?> configuration : this.configurations.get(name).getConfiguration()) {
            registry.register(configuration);
        }
    }
    for (Map.Entry<String, C> entry : this.configurations.entrySet()) {
        if (entry.getKey().startsWith("default.")) {
            for (Class<?> configuration : entry.getValue().getConfiguration()) {
                registry.register(configuration);
            }
        }
    }
    registry.register(PropertyPlaceholderAutoConfiguration.class, this.defaultConfigType);
}
```

来源：`spring-cloud-context/.../named/NamedContextFactory.java:143-159`。

这里有一个关键细节：命名为 `default.` 前缀的配置会被注册到所有子上下文，相当于“全部服务共享的默认配置”；而具体名称（如 `order-service`）的配置只注册到对应子上下文。

## 二、子上下文的独立性：它有自己的 Bean 生命周期

每个子上下文都是独立的 `GenericApplicationContext`：

- 有自己的 `BeanFactory`
- 有自己的 `BeanDefinition`
- 有自己的 `refresh()` / `close()` 生命周期
- 父上下文中的 Bean 可以访问，但子上下文的 Bean 不会污染父上下文

这意味着：

- `order-service` 的 `RoundRobinLoadBalancer` Bean
- 和 `payment-service` 的 `RandomLoadBalancer` Bean
- 完全独立，互不干扰

## 三、`Specification`：描述“为这个名称创建什么配置”

`NamedContextFactory.Specification` 是描述子上下文配置的契约：

```java
public interface Specification {
    String getName();
    Class<?>[] getConfiguration();
}
```

`getName()` 返回名称（如 `order-service`），`getConfiguration()` 返回要注册的配置类。

`LoadBalancerClientSpecification` 和 `FeignClientSpecification` 都实现了这个接口。

来源：`spring-cloud-context/.../named/NamedContextFactory.java:266-272`；`LoadBalancerClientSpecification` 在 loadbalancer 模块，`FeignClientSpecification` 在 openfeign 模块。

## 四、`LoadBalancerClientFactory` 和 `NamedContextFactory` 的关系

`LoadBalancerClientFactory` 继承 `NamedContextFactory<LoadBalancerClientSpecification>`：

```java
public class LoadBalancerClientFactory
    extends NamedContextFactory<LoadBalancerClientSpecification> {
    // ...
}
```

这意味着：

- `getContext("order-service")` 为 `order-service` 创建子上下文
- 子上下文里注册了 `OrderLBConfig.class` 中定义的 `ServiceInstanceListSupplier`、`RoundRobinLoadBalancer` 等 Bean
- 另一个服务 `payment-service` 的子上下文里注册的是完全不同的 Bean

`@LoadBalancerClient(name = "order-service", configuration = OrderLBConfig.class)` 的配置就是通过 `NamedContextFactory` 这种机制隔离的。

## 五、为什么这篇必须放在 `ReactorLoadBalancer` 之后

前一篇提到了 `LoadBalancerClientFactory` 为每个服务创建独立上下文。

这一篇展开的就是 `NamedContextFactory` 本身：

- 它不关心是给 LoadBalancer 用还是给 Feign 用
- 它是一个通用的“为每个名称创建子上下文”的抽象

如果不先理解 LoadBalancer 对独立配置的需求，就很难理解 `NamedContextFactory` 为什么要存在。

## 六、几个最容易错的判断

### 1. `NamedContextFactory` 只是一个配置 Map

不成立。

它为每个名称创建独立的子 `ApplicationContext`，有自己的 Bean 生命周期。

### 2. 子上下文和父上下文是同一个

不成立。

子上下文是独立的 `GenericApplicationContext`，父上下文中的 Bean 可访问，但子上下文的 Bean 不会污染父上下文。

### 3. `Specification` 只是存一个名字

不完整。

`getConfiguration()` 返回的配置类会被注册到子上下文中，定义为 Bean。

### 4. `NamedContextFactory` 只在 LoadBalancer 里有用

不成立。

Feign 的 `FeignClientFactory` 也继承 `NamedContextFactory`，为每个 FeignClient 创建独立上下文。

### 5. 子上下文创建后不会关闭

不成立。

`NamedContextFactory` 实现 `DisposableBean`，在父上下文关闭时会销毁所有子上下文。

## 收网

现在可以回到开头的问题：为什么每个 FeignClient 或 LoadBalancer 服务可以有自己独立的配置，而不会互相影响？

因为 `NamedContextFactory` 为每个名称创建独立的子 `ApplicationContext`，每个子上下文有自己的 `BeanFactory`、`BeanDefinition` 和 `refresh()` / `close()` 生命周期；`Specification` 描述要注册的配置类，`getContext(name)` 按需创建或复用子上下文。

所以这篇真正该带走的结论不是“有一个配置存储器”，而是：

**`NamedContextFactory` 通过为每个名称创建独立的子 ApplicationContext，实现了配置隔离和 Bean 生命周期独立管理；`LoadBalancerClientFactory` 和 Feign 都继承它，让每个 LoadBalancer 和 FeignClient 拥有自己的配置世界。**

下一篇进入 `ServiceInstanceListSupplier` 扩展策略。