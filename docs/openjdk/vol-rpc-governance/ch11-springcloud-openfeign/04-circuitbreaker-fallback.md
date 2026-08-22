# Spring Cloud OpenFeign：CircuitBreaker、Fallback 与降级保护

> 基于 Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1

## 一、困惑开场：CircuitBreaker 到底包住 Feign 的哪一层

假设你有一个 `@FeignClient` 接口，配了 `fallback`：

```java
@FeignClient(name = "orders", fallback = OrderFallback.class)
interface OrderClient {
    @GetMapping("/api/orders/{id}")
    Order get(@PathVariable("id") Long id);
}
```

当调用失败时，你知道 fallback 会被触发。但关键问题是：**CircuitBreaker 到底包住的是 Feign 的哪一层？**

直觉上你可能会想：CircuitBreaker 包住的是 Feign 的 `Client.execute()`——也就是 HTTP 请求本身。如果请求失败了，就触发熔断并返回 fallback。

但如果真是这样，CircuitBreaker 就只能覆盖 HTTP 请求本身，覆盖不了编码、解码、重定向和拦截器链中发生的异常。而且 `FeignCircuitBreakerInvocationHandler` 的源码也证明它包住的不是 `Client.execute()`，而是 `dispatch.get(method).invoke(args)`——也就是整个 method invocation，包括 RequestTemplate 构造、Encoder、Client 执行、ResponseHandler、Decoder 全部在内。

所以这篇文章要回答的核心问题是：**CircuitBreaker 在 Feign 里到底在哪一层工作，它是怎么替换 `Feign.Builder` 和 `Targeter`，最终把每次方法调用包进 `CircuitBreaker.run(supplier, fallback)` 的。**

## 二、前情回顾：上一篇讲的是 Client 层的装饰器，这一篇讲的是 InvocationHandler 层的装饰器

在 LoadBalancer 篇里，我们已经知道：`FeignBlockingLoadBalancerClient` 在 `Client` 层装饰 Feign 的 HTTP 执行，在每次请求时按 serviceId 选路。

这一篇的 CircuitBreaker 不在 Client 层，而在 InvocationHandler 层。它替换的不是 `Client`，而是 `Feign.Builder` 和 `Targeter`，最终让 `FeignCircuitBreakerInvocationHandler` 把整个 method dispatch 包进 `CircuitBreaker.run()`。

所以这两篇的分工很清楚：

- LoadBalancer 在底层 Client 层：负责"把请求发给哪个实例"
- CircuitBreaker 在上层 InvocationHandler 层：负责"如果失败了，要不要降级"

## 三、先走三条失败的路

### 失败方案一：CircuitBreaker 包住的是 Feign 的 Client 执行

如果包住的是 `Client.execute()`，那 CircuitBreaker 只能覆盖 HTTP I/O 本身，不能覆盖编码、解码、interceptor 中发生的异常。

但 `FeignCircuitBreakerInvocationHandler` 包住的是 `dispatch.get(method).invoke(args)`，也就是整个 Feign 方法调用链，包括 RequestTemplate 构造、Encoder、Client 执行、ResponseHandler、Decoder 全部在内。

所以 CircuitBreaker 在 Feign 里是 InvocationHandler 级别的，不是 Client 级别的。

### 失败方案二：`fallback` 和 `fallbackFactory` 都能拿到异常

`fallback` 产生的是 `FallbackFactory.Default` 包装，它的 `create(Throwable)` 忽略异常，返回常量降级实例。

只有 `fallbackFactory` 会让自定义的 `FallbackFactory.create(Throwable)` 被调用，从而拿到异常上下文。

所以如果你需要降级方法根据异常类型做不同处理，必须用 `fallbackFactory`。

### 失败方案三：CircuitBreaker 和 LoadBalancer 在同一层运行

LoadBalancer 在 `Client` 层，CircuitBreaker 在 `InvocationHandler` 层。

LoadBalancer 负责的是"把请求发给哪个实例"，CircuitBreaker 负责的是"如果失败了，要不要降级"。两者在调用栈上处于不同层级，CircuitBreaker 包住的是已经经过 LoadBalancer 处理的完整请求。

## 四、最小总图：Builder → Targeter → InvocationHandler → CircuitBreaker.run

```text
circuitbreaker.enabled=true
    ↓
FeignAutoConfiguration / FeignClientsConfiguration
    ↓
builder: FeignCircuitBreaker.Builder (替换 Feign.Builder)
targeter: FeignCircuitBreakerTargeter (替换 DefaultTargeter)
    ↓
FeignCircuitBreakerTargeter.target()
    ├─ fallback → targetWithFallback
    ├─ fallbackFactory → targetWithFallbackFactory
    └─ 无 fallback → target
    ↓
FeignCircuitBreaker.Builder.build()
    ↓
FeignCircuitBreakerInvocationHandler
    ↓ 每次方法调用
CircuitBreaker.run(supplier, fallbackFunction)
    ├─ supplier = dispatch.get(method).invoke(args)
    └─ fallbackFunction = nullableFallbackFactory.create(throwable)
```

这里最核心的是：CircuitBreaker 在 Feign 里替换的是 Builder 和 Targeter，最终在 InvocationHandler 层把整个方法调用包进 `CircuitBreaker.run()`。

## 五、装配条件：`circuitbreaker.enabled=true` 只是必要条件

### 5.1 两个开关决定是否启用

Spring Cloud OpenFeign 的 CircuitBreaker 集成受两个条件控制：

1. `spring.cloud.openfeign.circuitbreaker.enabled=true`
2. classpath 上存在 `CircuitBreakerFactory` 的实现

`FeignCircuitBreakerDisabledConditions` 使用 `AnyNestedCondition`：如果 CircuitBreaker 类不在 classpath 上，或者 `circuitbreaker.enabled` 不是 true，就走默认路径。

`FeignCircuitBreakerDisabledConditions.java:23` — AnyNestedCondition 条件

这意味着 CircuitBreaker 是 opt-in 的。你必须显式配置 `enabled=true`，并且引入一个具体的 CircuitBreaker 实现（如 Resilience4J）。

### 5.2 两个组件同时被替换

启用后，Feign 会同时替换两个组件：

**Targeter 层**：`FeignAutoConfiguration` 中，`CircuitBreakerPresentFeignTargeterConfiguration` 创建 `FeignCircuitBreakerTargeter` 而不是 `DefaultTargeter`。

`FeignAutoConfiguration.java:179` — `FeignCircuitBreakerTargeter` 配置
`FeignAutoConfiguration.java:207` — targeter bean

**Builder 层**：`FeignClientsConfiguration` 中，`CircuitBreakerPresentFeignBuilderConfiguration` 创建 `FeignCircuitBreaker.builder()` 而不是默认的 `Feign.Builder`。

`FeignClientsConfiguration.java:216` — CircuitBreakerPresentFeignBuilderConfiguration
`FeignClientsConfiguration.java:228` — `FeignCircuitBreaker.builder()`

所以 CircuitBreaker 的集成不是"给 Feign 加一个 Plugin"，而是同时替换了两个核心构建对象。

## 六、`FeignCircuitBreakerTargeter`：三路 fallback 解析

### 6.1 三路分支

`FeignCircuitBreakerTargeter.target()` 会按优先级检查三个来源：

1. `fallback` 类 → `targetWithFallback()`
2. `fallbackFactory` 类 → `targetWithFallbackFactory()`
3. 都没有 → 普通 target（无降级）

`FeignCircuitBreakerTargeter.java:46` — target() 三路分支

### 6.2 fallback 路径

`targetWithFallback()` 从 child context 取出 fallback bean，用 `FallbackFactory.Default` 包装，再交给 `FeignCircuitBreaker.Builder.target(target, fallbackInstance)`。

`FeignCircuitBreakerTargeter.java:70` — targetWithFallback
`FeignCircuitBreaker.java:79` — target(Target, T fallback)

### 6.3 fallbackFactory 路径

`targetWithFallbackFactory()` 从 child context 取出 `FallbackFactory` bean，直接交给 `FeignCircuitBreaker.Builder.target(target, fallbackFactory)`。

`FeignCircuitBreakerTargeter.java:63` — targetWithFallbackFactory
`FeignCircuitBreaker.java:83` — target(Target, FallbackFactory)

### 6.4 无 fallback 路径

如果没有 fallback 也没有 fallbackFactory，走普通 target，Feign 的 `CircuitBreaker.run(supplier)` 在失败时会抛出 `NoFallbackAvailableException`。

`FeignCircuitBreaker.java:88` — target(Target)

## 七、`FeignCircuitBreaker.Builder`：只重写 `build()`

`FeignCircuitBreaker.Builder` 继承 `Feign.Builder`，它的核心改动只有一处：重写 `build(FallbackFactory)` 方法，设置 `FeignCircuitBreakerInvocationHandler` 作为 invocation handler。

`FeignCircuitBreaker.java:49` — Builder 类定义
`FeignCircuitBreaker.java:92` — build(FallbackFactory) 设置 InvocationHandler

其他所有能力（Contract、Encoder、Decoder、Client、Retryer、Logger、Interceptor 等）全部继承自 `Feign.Builder`。所以 CircuitBreaker 的集成不是重写 Feign core，而是只替换了 invocation handler 的实现。

## 八、`FeignCircuitBreakerInvocationHandler`：invocation 级别的装饰器

### 8.1 每次方法调用都包进 CircuitBreaker.run

`invoke()` 是核心入口。它做三件事：

1. 解析 circuit name
2. 创建 CircuitBreaker
3. 调用 `CircuitBreaker.run(supplier, fallbackFunction)`

`FeignCircuitBreakerInvocationHandler.java:78` — invoke() 主方法
`FeignCircuitBreakerInvocationHandler.java:98` — circuit name 解析
`FeignCircuitBreakerInvocationHandler.java:99` — CircuitBreaker 创建

### 8.2 supplier 是什么

`asSupplier()` 把真实的 Feign 方法调用包装成一个 `Supplier<Object>`。这个 supplier 捕获了 `RequestAttributes`（用于线程上下文传播），然后调用 `dispatch.get(method).invoke(args)`。

`FeignCircuitBreakerInvocationHandler.java:131` — asSupplier

所以 CircuitBreaker 包住的是 `dispatch.get(method).invoke(args)`，包括：

- RequestTemplate 构造
- Encoder
- Client.execute
- ResponseHandler
- Decoder
- ErrorDecoder

### 8.3 有 fallback 时

`CircuitBreaker.run(supplier, fallbackFunction)` 中，fallbackFunction 会调用 `nullableFallbackFactory.create(throwable)`，返回降级实例，再通过反射调用对应的方法。

`FeignCircuitBreakerInvocationHandler.java:102` — 有 fallback 时 run

### 8.4 无 fallback 时

`CircuitBreaker.run(supplier)` 失败时会抛出 `NoFallbackAvailableException`。

`FeignCircuitBreakerInvocationHandler.java:115` — 无 fallback 时 run

### 8.5 异常 unwrap

`unwrapAndRethrow()` 负责处理 fallback 自身抛出的异常。如果 fallback 方法抛出 `InvocationTargetException` 或 `NoFallbackAvailableException`，它会解包并抛出原始异常。

`FeignCircuitBreakerInvocationHandler.java:118` — unwrapAndRethrow

## 九、`fallback` vs `fallbackFactory`：调用时机与异常可见性

### 9.1 `fallback`

`@FeignClient(fallback = MyFallback.class)` 的 fallback 实例会被 `FallbackFactory.Default` 包装。

`FallbackFactory.java:57` — FallbackFactory.Default 常量降级

`FallbackFactory.Default.create(Throwable)` 忽略异常参数，返回常量实例。所以 fallback 方法无法知道"为什么被降级了"。

### 9.2 `fallbackFactory`

`@FeignClient(fallbackFactory = MyFallbackFactory.class)` 的 `FallbackFactory.create(Throwable)` 会被调用，拿到异常上下文。

`FallbackFactory.java:48` — FallbackFactory 接口

所以如果 fallback 需要根据异常类型做不同处理（比如 403 返回空值、500 返回缓存），必须用 `fallbackFactory`。

### 9.3 两者互斥，fallback 优先

`FeignCircuitBreakerTargeter.target()` 先检查 `fallback`，后检查 `fallbackFactory`。如果两者都配了，只有 `fallback` 生效。

## 十、误解澄清

### 误解一：CircuitBreaker 包住的是 Feign 的 Client 执行

不是。它包住的是整个 method invocation，包括 Encoder、Client、ResponseHandler、Decoder 全部在内。

### 误解二：`fallback` 和 `fallbackFactory` 都能拿到异常

不是。`fallback` 产生 `FallbackFactory.Default`，忽略异常。只有 `fallbackFactory` 能拿到异常上下文。

### 误解三：CircuitBreaker 和 LoadBalancer 在同一层

不是。LoadBalancer 在 Client 层，CircuitBreaker 在 InvocationHandler 层。

### 误解四：`circuitbreaker.enabled=true` 就足够开启 CircuitBreaker

不是。还需要 classpath 上有 `CircuitBreakerFactory` 的实现。

### 误解五：FeignCircuitBreaker.Builder 重写了 Feign.Builder 的大部分逻辑

不是。它只重写了 `build()` 方法，设置 invocation handler。其他能力全部继承自 Feign.Builder。

## 十一、收网总结：CircuitBreaker 是 InvocationHandler 级别的装饰器

回到开头的问题：CircuitBreaker 到底包住 Feign 的哪一层？

答案是 InvocationHandler 层。它替换的是 `Feign.Builder` 和 `Targeter`，最终让 `FeignCircuitBreakerInvocationHandler` 把每次方法调用包装成 `CircuitBreaker.run(supplier, fallbackFunction)`。

所以 CircuitBreaker 在 Feign 里不是 Client 级别的装饰器，不是 Contract 适配器，而是 InvocationHandler 级别的装饰器。它包住的是整个 HTTP 调用链，从 RequestTemplate 构造到 Decoder 和 ErrorDecoder。

**三句话总结：**

1. CircuitBreaker 在 Feign 里替换的是 `Feign.Builder` 和 `Targeter`，最终在 `FeignCircuitBreakerInvocationHandler` 中把整个 method dispatch 包进 `CircuitBreaker.run()`。
2. `fallback` 产生常量降级实例（不接收异常），`fallbackFactory` 接收异常并返回上下文降级实例；两者互斥，fallback 优先。
3. 启用 CircuitBreaker 需要同时满足 `circuitbreaker.enabled=true` 和 `CircuitBreakerFactory` 在 classpath 上。

**下篇预告：** 下一篇可以进入 Micrometer / observability 集成，或 CircuitBreaker 与 LoadBalancer retry 的交互分析。