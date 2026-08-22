# 为什么 Sentinel、Resilience4j 都能用同一个 `CircuitBreaker` 抽象：断路器如何被统一

> 本文基于 Spring Cloud 2025.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-commons` 的第十篇，承接前一篇 `ServiceInstanceListSupplier` 扩展策略。重点放在 `CircuitBreaker`、`CircuitBreakerFactory`、`ReactiveCircuitBreaker`、`ReactiveCircuitBreakerFactory`、`AbstractCircuitBreakerFactory`，以及 Spring Cloud CircuitBreaker 如何统一 Sentinel / Resilience4j 等实现。下一篇将进入生产层（RefreshEndpoint）。

## 为什么 Hystrix 之后，Spring Cloud 选择用抽象而不是某个具体框架

早期 Spring Cloud 的熔断方案是 Hystrix。但 Hystrix 逐渐停止演进后，生态转向了：

- Resilience4j
- Sentinel

如果业务代码直接依赖某个具体实现，例如：

```java
// 直接依赖 Sentinel 的 API
Entry entry = SphU.entry("myService");
```

那么换实现时，业务代码要全部重写。

Spring Cloud 的解法是定义一个统一抽象层：

- `CircuitBreaker`
- `CircuitBreakerFactory`

业务代码只依赖 `CircuitBreaker`，具体是 Sentinel 还是 Resilience4j 由实现层决定。

**第一层问题是：`CircuitBreaker` 定义了“保护调用”的统一契约。**

**第二层问题是：`CircuitBreakerFactory` 负责创建具体的 `CircuitBreaker` 实例。**

**第三层问题是：`ReactiveCircuitBreaker` 和 `ReactiveCircuitBreakerFactory` 提供响应式版本。**

## 先看失败方案：为什么不能直接使用某一家 API、也不能一个抽象全包办调度

### 失败方案一：业务代码直接使用 Sentinel / Resilience4j API

这会：

- 让业务代码和具体实现绑死
- 切换实现时业务代码大改
- 测试时无法用 mock CircuitBreaker 替换

### 失败方案二：抽象层连“断路状态机”也一起实现

抽象层只负责契约，不负责具体状态机：

- Hystrix 用线程池/信号量隔离
- Sentinel 用规则判断
- Resilience4j 用滑动窗口

这些细节属于实现层，抽象层不做。

## 断路器最小总图

```text
business call
   -> @CircuitBreaker or CircuitBreakerFactory.create("id")
   -> CircuitBreaker.run(supplier, fallback)
   -> implementation decides open/closed/half-open
   -> on failure, fallback.apply(ex)
```

```text
[业务调用]
需要保护的方法

   ->

[抽象契约]
CircuitBreaker.run()

   ->

[工厂]
CircuitBreakerFactory.create("id")

   ->

[实现]
SentinelCircuitBreaker / Resilience4jCircuitBreaker

   ->

[兜底]
fallback / NoFallbackAvailableException
```

## 一、`CircuitBreaker`：保护调用的统一契约

```java
public interface CircuitBreaker {

    default <T> T run(Supplier<T> toRun) {
        return run(toRun, throwable -> {
            throw new NoFallbackAvailableException("No fallback available.", throwable);
        });
    }

    <T> T run(Supplier<T> toRun, Function<Throwable, T> fallback);
}
```

来源：`spring-cloud-commons/.../circuitbreaker/CircuitBreaker.java:27-36`。

它只定义两个核心能力：

- `run(Supplier)`：只执行受保护调用
- `run(Supplier, Function<Throwable, T>)`：执行 + 指定 fallback

关键边界：`CircuitBreaker` 只定义契约，不实现状态机。开/闭/半开、失败统计这些由具体实现完成。

`run()` 不带 fallback 时，会抛 `NoFallbackAvailableException` 包装原始异常。

## 二、`CircuitBreakerFactory`：按 id 创建实例

```java
public abstract class CircuitBreakerFactory<CONF, CONFB extends ConfigBuilder<CONF>>
        extends AbstractCircuitBreakerFactory<CONF, CONFB> {

    public abstract CircuitBreaker create(String id);
}
```

来源：`spring-cloud-commons/.../circuitbreaker/CircuitBreakerFactory.java:28-36`。

`create(String id)` 按 id（如 `"orderService"`）创建一个 `CircuitBreaker`。

`AbstractCircuitBreakerFactory` 提供：

- 默认配置管理
- 按 id 自定义配置
- `configureDefault(Function)` / `configure(id, Function)`

这样每个 id 可以有自己的配置，例如不同的失败阈值、超时时间。

## 三、`ReactiveCircuitBreaker`：响应式版本

```java
public interface ReactiveCircuitBreaker {

    default <T> Mono<T> run(Mono<T> toRun) {
        return run(toRun, throwable -> {
            throw new NoFallbackAvailableException("No fallback available.", throwable);
        });
    }

    <T> Mono<T> run(Mono<T> toRun, Function<Throwable, Mono<T>> fallback);

    default <T> Flux<T> run(Flux<T> toRun) {
        return run(toRun, throwable -> {
            throw new NoFallbackAvailableException("No fallback available.", throwable);
        });
    }

    <T> Flux<T> run(Flux<T> toRun, Function<Throwable, Flux<T>> fallback);
}
```

来源：`spring-cloud-commons/.../circuitbreaker/ReactiveCircuitBreaker.java:29-46`。

它对应阻塞版 `CircuitBreaker` 的响应式版本，处理 `Mono` / `Flux`。

`ReactiveCircuitBreakerFactory` 是抽象工厂类，继承 `AbstractCircuitBreakerFactory`，提供响应式工厂能力。

## 四、`@CircuitBreaker` 注解（非 Commons 核心，属于更高层集成）

除直接编码外，Spring Cloud CircuitBreaker 还提供 `@CircuitBreaker(name = "orderService", fallbackMethod = "fallback")` 注解。该注解不在 Commons 核心模块中，而是由更高层的 spring-cloud-circuitbreaker 集成层提供，通过 AOP 拦截方法调用，在方法前创建 `CircuitBreaker`，在方法周围执行 `run()`。

本文只确认它的存在和边界，不再深入展开。

## 五、为什么这篇必须紧跟 LoadBalancer 系列

前几篇讲了 LoadBalancer 如何处理“服务失效/实例变化”。

LoadBalancer 负责：

- 选一个实例

断路器负责：

- 保护 “调用某一个服务” 的整体稳定性

两者经常配合使用：

- LoadBalancer 选实例
- CircuitBreaker 保护远程调用，失败时降级

所以：

- LoadBalancer 系列是调用前
- 断路器是调用中/调用失败后

它们共同构成“调用保护”的两个层次。

## 六、几个最容易错的判断

### 1. `CircuitBreaker` 自己实现了断路状态机

不成立。

它只定义契约，状态机由 Sentinel / Resilience4j 等具体实现完成。

### 2. 换实现时业务代码要改

不成立。

业务代码只依赖 `CircuitBreaker`，换实现只需换依赖和工厂实现。

### 3. `CircuitBreakerFactory.create(id)` 每次都创建新实例

取决于实现。

有些实现按 id 缓存实例，`create("orderService")` 会返回同一实例。

### 4. `run(Supplier)` 不指定 fallback 时，异常会直接暴露

不完整。

默认 `run(Supplier)` 会把原始异常包装进 `NoFallbackAvailableException` 再抛出。

### 5. 响应式应用不能用 CircuitBreaker 抽象

不成立。

`ReactiveCircuitBreaker` / `ReactiveCircuitBreakerFactory` 提供响应式版本。

## 收网

现在可以回到开头的问题：为什么 Hystrix 之后，Spring Cloud 选择用抽象而不是某个具体框架？

因为 `CircuitBreaker` 定义了“保护调用”的统一契约，`CircuitBreakerFactory` 按 id 创建实例，业务代码只依赖抽象。

具体是 Sentinel 还是 Resilience4j，只在实现层发生。

所以这篇真正该带走的结论不是“Spring Cloud 有熔断”，而是：

**Spring Cloud CircuitBreaker 用 `CircuitBreaker` / `CircuitBreakerFactory` 统一了对远程调用的保护契约，把断路状态机、滑动窗口等细节留给实现层；Sentinel、Resilience4j 通过工厂实现接入，业务代码不需要关心底层是哪家。**

下一篇进入生产层（RefreshEndpoint / Discovery 健康检查）。