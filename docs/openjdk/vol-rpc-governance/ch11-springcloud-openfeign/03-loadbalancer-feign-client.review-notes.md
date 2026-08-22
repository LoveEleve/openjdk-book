# Spring Cloud OpenFeign：LoadBalancer 如何接管 Feign Client — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `FeignClientFactoryBean.getTarget()` 在没有 `url` 且配置中也没有 url 时走 loadBalance 路径，证据：`FeignClientFactoryBean.java:469`、`:474`、`:481`。
2. `loadBalance(...)` 从 Feign child context 取 `Client` bean，若没有则抛 "Did you forget to include spring-cloud-starter-loadbalancer?"，证据：`FeignClientFactoryBean.java:427`、`:436`。
3. 有显式 `url` 时，`getTarget()` 通过 `getDelegate()` 解包掉 LB 装饰器，走原始 HTTP client，证据：`FeignClientFactoryBean.java:486`。
4. `FeignBlockingLoadBalancerClient` 从 `request.url()` 的 host 读取 serviceId，证据：`FeignBlockingLoadBalancerClient.java:107`。
5. `FeignBlockingLoadBalancerClient` 按 serviceId 从 LB per-service context 取 `LoadBalancerLifecycle`，然后调用 `loadBalancerClient.choose(serviceId, request)`，证据：`FeignBlockingLoadBalancerClient.java:113`、`:118`。
6. `instance == null` 时构造 503 Feign Response，不真正发 HTTP，证据：`FeignBlockingLoadBalancerClient.java:121`。
7. `loadBalancerClient.reconstructURI(instance, uri)` 把逻辑 URL 重建为真实 host/port，证据：`FeignBlockingLoadBalancerClient.java:135`。
8. `BlockingLoadBalancerClient.choose()` 中 `Mono.from(loadBalancer.choose(request)).block()` 是唯一的 Reactor→阻塞桥，证据：`BlockingLoadBalancerClient.java:158`、`:163`。
9. `LoadBalancerClientFactory.getInstance(serviceId)` 返回对应 LB per-service context 的 `ReactiveLoadBalancer`，默认由 `LoadBalancerClientConfiguration` 提供，证据：`LoadBalancerClientFactory.java:79`、`LoadBalancerClientConfiguration.java:69`。
10. Feign child context 与 LoadBalancer child context 是两个兄弟 NamedContextFactory，不互为父子，证据：`FeignClientFactory.java:39`、`LoadBalancerClientFactory.java:46`。
11. `FeignLoadBalancerAutoConfiguration` 通过 `@AutoConfigureBefore(FeignAutoConfiguration)` / `@AutoConfigureAfter(Blocking/LoadBalancerAutoConfiguration)` 控制装配顺序，`AutoConfiguration.imports:5` 注册，证据：`FeignLoadBalancerAutoConfiguration.java:47`。
12. 具体 HTTP client 选择由 `DefaultFeignLoadBalancerConfiguration` / `OkHttp` / `HttpClient5` / `Http2Client` 等决定，始终落在 feign 的原始 client adapter 上，证据：`DefaultFeignLoadBalancerConfiguration.java:48`。

### 测试证据已核对

1. `FeignLoadBalancerAutoConfigurationTests.java:46` — 单一 LB 装饰器与底层 delegate。
2. `FeignBlockingLoadBalancerClientTests.java:98` — serviceId 提取。
3. `FeignBlockingLoadBalancerClientTests.java:116` — no-instance → 503。
4. `FeignBlockingLoadBalancerClientTests.java:126` — reconstruct + transformers。
5. `FeignBlockingLoadBalancerClientTests.java:151` — lifecycle callback + hint。
6. `FeignClientFactoryBeanIntegrationTests.java:98` — 最小 load-balanced client demo。
7. `FeignHttpClientUrlTests.java:152` — 有 url 时原始 client。

### 深审发现

1. **高风险：容易把 Feign 当成"做负载均衡的一方"。** 当前正文已明确 Feign 只负责把 serviceId 变逻辑 target，真正的 host 解析在 LoadBalancer。  
2. **高风险：容易把 `@LoadBalanced` 混进 Feign 路径。** 当前正文已明确它是 RestTemplate/RestClient/WebClient 的 qualifier。  
3. **中风险：容易误以为每个 Feign client 有独立 LB 配置。** 当前正文已拆到"全局共享装饰器 + 请求时按 serviceId 选 service context"。  
4. **中风险：容易误以为有 url 也走负载均衡。** 当前正文已用 unwrap(`getDelegate()`) 明确相反行为。  
5. **低风险：容易把 Mono/Reactor 误读成异步。** 当前正文已强调唯一阻塞桥是 `block()`。  

## 第二轮：因果审

- 没有 url 时 Feign 必须把 service name 变成逻辑 target，否则底层 HTTP client 无从解析 serviceId：✅
- `FeignBlockingLoadBalancerClient` 必须在每次请求时从 host 读 serviceId，否则全局单例无法服务多个不同 service：✅
- `choose()` 必须通过 `loadBalancerClient.choose(...)`，Feign 不能自己选实例，否则会绕过 LoadBalancer 的算法和生命感知：✅
- 用 `reconstructURI` 把逻辑 URL 重建为真实 host，底层 delegate client 才能正确发出请求：✅
- 有 url 必须 unwrap LB 装饰器，否则显式直连会被误包成负载均衡：✅
- Feign child context 与 LoadBalancer child context 必须分属两个 NamedContextFactory，否则彼此配置会泄漏串扰：✅

## 第三轮：结构审

正文结构按"困惑开场 → 前情回顾 → 失败方案(3个) → 五跳总图 → getTarget 分叉 → FeignBlockingLoadBalancerClient → BlockingLoadBalancerClient/Mono.block → 兄弟 context → Auto-config → 503 诊断 → 误解澄清 → 收网总结"推进，没有退化成 LoadBalancer 百科，也没有重复 Feign core 的执行链。

失败方案已覆盖：
- Feign 使用 `@LoadBalanced`  
- 每个 Feign client 有独立 LB 配置  
- 有显式 url 也走负载均衡  

每一层拆解均围绕"谁在什么时候把 serviceId 变成真实 host"这条主线展开，符合基础设施集成篇定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- no-url 的逻辑 target 与挂 LB client 的阶段  
- 请求时按 serviceId 选路的心智模型  
- `Mono.block()` 是唯一阻塞桥  
- Feign child context 与 LB child context 是兄弟  
- 有 url 会 unwrap 掉 LB 装饰器  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开 RoundRobin 算法和 supplier 组合细节。✅
- 未展开 LB retry policy 和 CircuitBreaker 集成。✅
- 未展开 Reactor/WebClient 的 LB client 自动配置。✅
- 重点仍压在 Feign-LoadBalancer 集成桥与本篇的"请求时选路"结论，边界收得住。✅

## 第六轮：依赖审

- 已承接 Spring Cloud OpenFeign 补深篇：`FeignClientFactoryBean` 与 named context 已知，本篇解释它们如何把 serviceId 交给 LoadBalancer。✅
- 已承接 OpenFeign core 篇：Feign 的 `Client` 接口和 `Targeter` 已知，本篇只补 LoadBalancer 如何在 `Client` 处装饰。✅
- `FeignBlockingLoadBalancerClientTests`、`FeignClientFactoryBeanIntegrationTests`、`FeignLoadBalancerAutoConfigurationTests` 足以支撑"请求时按 serviceId 选路"的结论。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅
- 代码块：使用少量总图和带注释的 Java 片段；不承担主叙事骨架。✅
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `FeignClientFactoryBean`、`FeignBlockingLoadBalancerClient`、`BlockingLoadBalancerClient`、`LoadBalancerClientFactory`、`FeignLoadBalancerAutoConfiguration`、`DefaultFeignLoadBalancerConfiguration`。✅
- 去掉代码块后正文仍成立：是。
- 叙述性正文字符数（不含代码块与空白行）：约 `15,041`。
- 目标定位：Spring Cloud OpenFeign 基础设施集成篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 Feign 与 LoadBalancer 的关系从"Feign 做负载均衡"提升到"请求时按 serviceId 选路的装饰链"，讲清 `FeignClientFactoryBean` 的 url 决策分叉、`FeignBlockingLoadBalancerClient` 的全局共享装饰器、`BlockingLoadBalancerClient.choose()` 与 `reconstructURI()`，以及 Feign/LoadBalancer 两套兄弟 child context 的正确边界。