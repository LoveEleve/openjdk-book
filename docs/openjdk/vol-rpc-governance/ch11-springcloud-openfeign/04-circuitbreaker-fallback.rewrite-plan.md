# Spring Cloud OpenFeign：CircuitBreaker、Fallback 与降级保护 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch11-springcloud-openfeign`
- 篇：`04 CircuitBreaker、Fallback 与降级保护`
- 对应主题：`F-SC-4 CircuitBreaker / Fallback`
- 文章类型：Spring 基础设施集成篇
- 正文状态：未开始
- 分析对象：`Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`

## 文章定位

- 核心困惑：前一篇 LoadBalancer 讲的是"没有可用实例时返回 503"，但线上还有一个更常见的场景：请求已经发出，但失败了（超时、500、熔断），这时怎么办？`@FeignClient(fallback = ...)` 和 `fallbackFactory = ...` 到底谁在什么时候被调用？CircuitBreaker 到底挂在 Feign 的哪一层——是 Client 层、InvocationHandler 层，还是 Targeter 层？
- 一句话顿悟：Spring Cloud OpenFeign 的 CircuitBreaker 集成不是替换 Feign 的 Client 或 Contract，而是替换了两个关键对象：`Feign.Builder` 换成 `FeignCircuitBreaker.Builder`，`Targeter` 换成 `FeignCircuitBreakerTargeter`；最终由 `FeignCircuitBreakerInvocationHandler` 把每次 Feign 方法调用包装成 `CircuitBreaker.run(supplier, fallback)`——其中 supplier 是真实的 HTTP 调用，fallback 是降级方法。所以 CircuitBreaker 在 Feign 里是一个**InvocationHandler 级别的装饰器**，它包住的是整个 HTTP 调用链（包括编码、Client 执行、解码），而不仅仅是 Client 执行。
- 文章边界：本篇重点讲 `FeignCircuitBreaker.Builder`、`FeignCircuitBreakerTargeter`、`FeignCircuitBreakerInvocationHandler`、`fallback` vs `fallbackFactory` 的解析和调用时机，以及 auto-config 条件；不展开具体 CircuitBreaker 实现（Resilience4J / Sentinel），不展开 LoadBalancer 层的 retry 交互，不展开 observability 集成。

## 前置依赖

### HARD

- `ch10-openfeign-core/01-runtime-spine-builder-proxy-http.md`（Feign 的 InvocationHandler / MethodHandler / Client 执行链）
- `ch11-springcloud-openfeign/01-enablefeignclients-registrar-factorybean.md`（FactoryBean / Targeter）

### SOFT

- 不要求先懂 Resilience4J 或 Sentinel 的具体算法。
- 不要求先懂 CircuitBreaker 状态机细节。

### NAV

- 后续可接：`CircuitBreaker 与 LoadBalancer retry 的交互`
- 后续可接：`Micrometer / observability 集成`

## 一句话困惑

`@FeignClient(fallback = ...)` 的降级到底是在哪一层发生的？CircuitBreaker 包住的是 Feign 的 Client 还是 InvocationHandler？`fallback` 和 `fallbackFactory` 有什么区别？

## 一句话顿悟

Spring Cloud OpenFeign 的 CircuitBreaker 集成替换了 `Feign.Builder` 和 `Targeter`，最终由 `FeignCircuitBreakerInvocationHandler` 在 InvocationHandler 层把每次方法调用包装成 `CircuitBreaker.run(supplier, fallback)`。`fallback` 是常量降级实例（不接收异常），`fallbackFactory` 是工厂（接收异常后可返回上下文降级实例）。

## 读者理解路径

1. 先否定"CircuitBreaker 包住的是 Client 执行"的直觉。
2. 建立最小总图：`circuitbreaker.enabled=true` → `FeignCircuitBreaker.Builder` → `FeignCircuitBreakerTargeter` → `FeignCircuitBreakerInvocationHandler` → `CircuitBreaker.run(supplier, fallback)`。
3. 解释 FeignCircuitBreaker 为什么替换 Builder 而不是替换 Client。
4. 解释 `FeignCircuitBreakerTargeter` 的三路 fallback 解析。
5. 解释 `FeignCircuitBreakerInvocationHandler` 如何包装 invocation。
6. 解释 `fallback` vs `fallbackFactory` 的差异与调用时机。
7. 解释 CircuitBreaker 异常 → fallback 的传播路径。
8. 收束到：CircuitBreaker 是 InvocationHandler 级别的装饰器，不是 Client 级别的。

## 失败方案推演

### 失败方案一：CircuitBreaker 包住的是 Feign 的 Client 执行

- 如果包住的是 Client，那 CircuitBreaker 只能覆盖 HTTP 请求本身，不能覆盖编码/解码、重定向、拦截器链。
- 但 `FeignCircuitBreakerInvocationHandler` 包住的是 `dispatch.get(method).invoke(args)`，它是整个 method invocation，包括 RequestTemplate 构造、Encoder、Client 执行、ResponseHandler、Decoder。
- 所以 CircuitBreaker 在 Feign 里是 InvocationHandler 级别的。

### 失败方案二：`fallback` 和 `fallbackFactory` 都能拿到异常

- `fallback` 会产生一个 `FallbackFactory.Default`，它的 `create(Throwable)` 忽略异常，返回常量实例。
- 只有 `fallbackFactory` 会让自定义 `FallbackFactory.create(Throwable)` 被调用，拿到异常。
- 所以如果 fallback 需要根据异常类型做不同处理，必须用 `fallbackFactory`。

### 失败方案三：CircuitBreaker 和 LoadBalancer 在同一层运行

- LoadBalancer 在 `Client` 层，`FeignBlockingLoadBalancerClient` 包装 `Client.execute()`。
- CircuitBreaker 在 `InvocationHandler` 层，`FeignCircuitBreakerInvocationHandler` 包装整个 method dispatch。
- 所以 LoadBalancer 在低层，CircuitBreaker 在上层。CircuitBreaker 包住的是已经经过 LoadBalancer 处理的完整请求。

## 必须澄清的误解

1. `FeignCircuitBreaker.Builder` 继承 `Feign.Builder`，只重写 `build()` 方法设置 invocation handler。
2. `FeignCircuitBreakerTargeter` 的三路优先顺序：fallback > fallbackFactory > 无回退。
3. `fallback` 的降级实例不接收异常，`fallbackFactory` 的 `create(Throwable)` 接收异常。
4. CircuitBreaker 在 Feign 里是 `InvocationHandler` 级别的装饰器，不是 Client 级别的。
5. `circuitbreaker.enabled=true` 只是必要条件，还需要 `CircuitBreakerFactory` bean 存在。

## 文章结构与字数预算

1. 困惑开场：`@FeignClient(fallback = ...)` 到底在哪一层工作（800-1000 字）
2. 最小总图：Builder → Targeter → InvocationHandler → CircuitBreaker.run（1000-1400 字）
3. 装配条件：`circuitbreaker.enabled=true` + `CircuitBreakerFactory`（1200-1600 字）
4. `FeignCircuitBreakerTargeter`：三路 fallback 解析（1400-2000 字）
5. `FeignCircuitBreaker.Builder` 与 `build()`（1200-1600 字）
6. `FeignCircuitBreakerInvocationHandler`：invocation 级别的装饰器（1800-2400 字）
7. `fallback` vs `fallbackFactory`：调用时机与异常可见性（1200-1600 字）
8. 收网总结（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `FeignAutoConfiguration.java:167` — DefaultTargeter 条件
- `FeignAutoConfiguration.java:179` — `FeignCircuitBreakerTargeter` 配置
- `FeignAutoConfiguration.java:207` — targeter bean
- `FeignAutoConfiguration.java:217` — 默认 CB name resolver
- `FeignAutoConfiguration.java:226` — alphanumeric CB name resolver
- `FeignClientsConfiguration.java:203` — 默认 Feign.Builder
- `FeignClientsConfiguration.java:216` — CircuitBreakerPresentFeignBuilderConfiguration
- `FeignClientsConfiguration.java:228` — `FeignCircuitBreaker.builder()` 声明
- `FeignCircuitBreaker.java:49` — Builder 类定义
- `FeignCircuitBreaker.java:79` — target(Target, T fallback)
- `FeignCircuitBreaker.java:83` — target(Target, FallbackFactory)
- `FeignCircuitBreaker.java:88` — target(Target) 无 fallback
- `FeignCircuitBreaker.java:92` — build(FallbackFactory) 设置 InvocationHandler
- `FeignCircuitBreakerTargeter.java:46` — target() 三路分支
- `FeignCircuitBreakerTargeter.java:63` — targetWithFallbackFactory
- `FeignCircuitBreakerTargeter.java:70` — targetWithFallback
- `FeignCircuitBreakerInvocationHandler.java:78` — invoke() 主方法
- `FeignCircuitBreakerInvocationHandler.java:98` — circuit name 解析
- `FeignCircuitBreakerInvocationHandler.java:99` — CircuitBreaker 创建
- `FeignCircuitBreakerInvocationHandler.java:102` — 有 fallback 时 run
- `FeignCircuitBreakerInvocationHandler.java:115` — 无 fallback 时 run
- `FeignCircuitBreakerInvocationHandler.java:118` — unwrapAndRethrow
- `FeignCircuitBreakerInvocationHandler.java:131` — asSupplier
- `FallbackFactory.java:48` — FallbackFactory 接口
- `FallbackFactory.java:57` — FallbackFactory.Default 常量降级
- `FeignCircuitBreakerDisabledConditions.java:23` — AnyNestedCondition 条件

## 测试证据清单

- `CircuitBreakerTests.java:90` — 有 fallback 的完整路径
- `CircuitBreakerTests.java:104` — FallbackFactory 路径
- `CircuitBreakerTests.java:118` — 异常 unwrap
- `CircuitBreakerWithNoFallbackTests.java:92` — 无 fallback → NoFallbackAvailableException
- `CircuitBreakerAutoConfigurationTests.java:49` — 默认 CB name
- `CircuitBreakerAutoConfigurationTests.java:71` — alphanumeric CB name
- `FeignAutoConfigurationTests.java:54` — disabled → DefaultTargeter
- `FeignAutoConfigurationTests.java:60` — enabled → FeignCircuitBreakerTargeter

## 版本边界

- 当前分析对象固定为 `Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`。
- 本篇不展开具体 CircuitBreaker 实现（Resilience4J / Sentinel）。
- 不展开 LoadBalancer retry 与 CircuitBreaker 的交互（后续篇）。
- 不展开 Micrometer 集成。

## 与其他篇的边界

### 本篇要讲清

- FeignCircuitBreaker 如何替换 Builder 和 Targeter。
- FeignCircuitBreakerInvocationHandler 如何包装 invocation。
- fallback vs fallbackFactory 的差异。
- 异常 → CircuitBreaker → fallback 的传播路径。

### 本篇不深讲

- LoadBalancer retry 与 CircuitBreaker 的交互。
- 具体 CB 实现（Resilience4J / Sentinel）的状态机。
- Micrometer / observability 集成。

## 写作后检查

- [ ] 开篇先抓 "CircuitBreaker 到底包住 Feign 的哪一层"，而不是直接讲 Builder。
- [ ] 至少展开 3 个失败方案，且包含 "CircuitBreaker 包住的是 Client""fallback 能拿到异常"。
- [ ] 明确给出 Builder → Targeter → InvocationHandler → CircuitBreaker.run 总图。
- [ ] 不把本篇写成 CircuitBreaker 配置选项说明书。
- [ ] 每个装配结论都落到 file:line 和测试。
- [ ] 删除代码块后，读者仍能复述 CircuitBreaker 在 Feign 里的层级和 fallback 的两种模式。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。