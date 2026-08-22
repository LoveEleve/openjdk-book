# Spring Cloud OpenFeign：CircuitBreaker、Fallback 与降级保护 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `FeignCircuitBreakerDisabledConditions` 使用 `AnyNestedCondition`：CircuitBreaker 类不在 classpath 上或 `circuitbreaker.enabled` 不是 true 时走默认路径，证据：`FeignCircuitBreakerDisabledConditions.java:23`。
2. `FeignAutoConfiguration.CircuitBreakerPresentFeignTargeterConfiguration` 创建 `FeignCircuitBreakerTargeter`，证据：`FeignAutoConfiguration.java:179`、`:207`。
3. `FeignClientsConfiguration.CircuitBreakerPresentFeignBuilderConfiguration` 创建 `FeignCircuitBreaker.builder()`，证据：`FeignClientsConfiguration.java:216`、`:228`。
4. `FeignCircuitBreakerTargeter.target()` 按优先级检查 fallback、fallbackFactory、无 fallback 三路分支，证据：`FeignCircuitBreakerTargeter.java:46`、`:63`、`:70`。
5. `FeignCircuitBreaker.Builder` 继承 `Feign.Builder`，只重写 `build(FallbackFactory)` 设置 `FeignCircuitBreakerInvocationHandler`，证据：`FeignCircuitBreaker.java:49`、`:92`。
6. `FeignCircuitBreaker.Builder.target(Target, T fallback)` 用 `FallbackFactory.Default` 包装 fallback，`target(Target, FallbackFactory)` 直接使用工厂，`target(Target)` 无 fallback，证据：`FeignCircuitBreaker.java:79`、`:83`、`:88`。
7. `FeignCircuitBreakerInvocationHandler.invoke()` 解析 circuit name、创建 CircuitBreaker、调用 `run(supplier, fallbackFunction)`，证据：`FeignCircuitBreakerInvocationHandler.java:78`、`:98`、`:99`、`:102`、`:115`、`:131`。
8. `asSupplier()` 捕获 `RequestAttributes` 并调用 `dispatch.get(method).invoke(args)`，说明 CircuitBreaker 包住的是整个 method invocation，证据：`FeignCircuitBreakerInvocationHandler.java:131`。
9. `unwrapAndRethrow()` 处理 fallback 自身抛出的异常：`InvocationTargetException` 和 `NoFallbackAvailableException` 会解包，其他异常包装为 `IllegalStateException`，证据：`FeignCircuitBreakerInvocationHandler.java:118`。
10. `FallbackFactory.Default.create(Throwable)` 忽略异常参数，返回常量实例，说明 fallback 不能感知异常；`FallbackFactory` 接口的 `create(Throwable)` 接收异常，证据：`FallbackFactory.java:48`、`:57`。
11. `FeignCircuitBreakerTargeter.target()` 先检查 fallback 后检查 fallbackFactory，两者互斥，fallback 优先，证据：`FeignCircuitBreakerTargeter.java:46`。

### 测试证据已核对

1. `CircuitBreakerTests.java:90` — 有 fallback 的完整路径。
2. `CircuitBreakerTests.java:104` — FallbackFactory 路径。
3. `CircuitBreakerTests.java:118` — 异常 unwrap。
4. `CircuitBreakerWithNoFallbackTests.java:92` — 无 fallback → NoFallbackAvailableException。
5. `CircuitBreakerAutoConfigurationTests.java:49` — 默认 CB name。
6. `FeignAutoConfigurationTests.java:54` — disabled → DefaultTargeter。
7. `FeignAutoConfigurationTests.java:60` — enabled → FeignCircuitBreakerTargeter。

### 深审发现

1. **高风险：容易把 CircuitBreaker 写成 Client 级别的装饰器。** 当前正文已明确它是 InvocationHandler 级别的，包住的是整个 method dispatch。  
2. **高风险：容易把 fallback 和 fallbackFactory 的异常可见性写混。** 当前正文已明确 `FallbackFactory.Default.create()` 忽略异常。  
3. **中风险：容易忽略 `circuitbreaker.enabled=true` 只是必要条件。** 当前正文已明确 `CircuitBreakerFactory` bean 也必须存在。  
4. **中风险：容易把 `FeignCircuitBreaker.Builder` 当成重写了大部分 Feign 逻辑。** 当前正文已说明它只重写 `build()`。  
5. **低风险：容易把 CircuitBreaker 和 LoadBalancer 放在同一层。** 当前正文已明确调用栈层级差异。  

## 第二轮：因果审

- CircuitBreaker 必须包住整个 method invocation 而不是只包 Client，否则编码/解码/拦截器中的异常会绕过熔断：✅
- FeignCircuitBreaker.Builder 必须只重写 `build()`，否则所有 Builder 能力（Contract/Encoder/Decoder/Client 等）都需要重新实现：✅
- fallback 必须用 `FallbackFactory.Default` 包装，否则 fallback 实例无法适配 FallbackFactory 接口：✅
- fallback 和 fallbackFactory 必须互斥且 fallback 优先，否则同一 @FeignClient 上可能产生歧义：✅
- `circuitbreaker.enabled=true` 必须配合 `CircuitBreakerFactory` bean 存在才能生效，否则没有具体的 CB 实现：✅

## 第三轮：结构审

正文结构按"困惑开场 → 前情回顾 → 失败方案(3个) → Builder → Targeter → InvocationHandler → fallback vs fallbackFactory → 误解澄清 → 收网总结"推进，没有退化成 CB 配置选项说明书。

失败方案已覆盖：
- CircuitBreaker 包住的是 Feign 的 Client 执行  
- fallback 和 fallbackFactory 都能拿到异常  
- CircuitBreaker 和 LoadBalancer 在同一层  

每一层拆解均围绕"Builder/Targeter 替换 → InvocationHandler 装饰 → fallback 解析"这条主线展开，符合基础设施集成篇定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- CircuitBreaker 在 Feign 里是 InvocationHandler 级别的装饰器  
- FeignCircuitBreaker.Builder 只重写 build()  
- FeignCircuitBreakerTargeter 的三路 fallback 解析  
- fallback vs fallbackFactory 的调用时机与异常可见性  
- circuitbreaker.enabled=true 只是必要条件  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开具体 CircuitBreaker 实现（Resilience4J / Sentinel）。✅
- 未展开 LoadBalancer retry 与 CircuitBreaker 的交互。✅
- 未展开 Micrometer / observability 集成。✅
- 重点仍压在 Feign 侧的 Builder/Targeter/InvocationHandler 替换与 fallback 解析，边界收得住。✅

## 第六轮：依赖审

- 已承接 Spring Cloud OpenFeign 第一篇的 FactoryBean/Targeter 主线。✅
- 已承接 OpenFeign core 第一篇的 InvocationHandler 概念。✅
- `CircuitBreakerTests`、`CircuitBreakerAutoConfigurationTests`、`FeignAutoConfigurationTests` 足以支撑 CB 集成链的结论。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅
- 代码块：使用少量总图和代码片段，不承担主叙事骨架。✅
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `FeignAutoConfiguration`、`FeignClientsConfiguration`、`FeignCircuitBreaker`、`FeignCircuitBreakerTargeter`、`FeignCircuitBreakerInvocationHandler`、`FallbackFactory`、`FeignCircuitBreakerDisabledConditions`。✅
- 去掉代码块后正文仍成立：是。✅
- 叙述性正文字符数（不含代码块与空白行）：约 `12,846`。  
- 目标定位：Spring Cloud OpenFeign 基础设施集成篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 Spring Cloud OpenFeign 的 CircuitBreaker 集成从"加了 fallback 就能降级"提升到"Builder/Targeter 替换 → InvocationHandler 级别的装饰器 → fallback vs fallbackFactory 的异常可见性差异"，讲清 FeignCircuitBreaker 到底在 Feign 的哪一层工作，以及怎么把每次方法调用包装进 `CircuitBreaker.run(supplier, fallbackFunction)`。