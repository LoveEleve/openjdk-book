# Spring Cloud OpenFeign：LoadBalancer 如何接管 Feign Client — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch11-springcloud-openfeign`
- 篇：`03 LoadBalancer 如何接管 Feign Client`
- 对应主题：`F-SC-3 LoadBalancer Overlay`
- 文章类型：Spring 基础设施集成篇
- 正文状态：未开始
- 分析对象：`Spring Cloud OpenFeign 4.3.2 + Spring Cloud LoadBalancer + OpenFeign 13.6.1`

## 文章定位

- 核心困惑：上一篇已经讲清了 `name` 和 `contextId` 的区别，但没有深入解释：当 `@FeignClient(name = "orders")` 没有配置 `url` 时，Feign 到底是怎么把 `http://orders` 这个逻辑地址变成真实实例请求的。读者最困惑的是：LoadBalancer 到底在哪一层接管了 Feign？「按名字选实例」是在创建 client 时发生的，还是在每次请求时才发生的？
- 一句话顿悟：Spring Cloud OpenFeign 在读到一个没有 `url` 的 `@FeignClient` 时，并不会自己去做负载均衡。它只是把 service name 包装成一个逻辑 target（`http://orders`），并把 `Feign.Client` 替换成 `FeignBlockingLoadBalancerClient`。真正发生负载均衡的时刻是每次方法调用时：`FeignBlockingLoadBalancerClient` 从 request URL 的 host 拿来 service id，调用 `BlockingLoadBalancerClient.choose()` 选定实例，再把逻辑 URL 重建为真实 host，最后交给底层 HTTP client 发出。也就是说，Feign 与 LoadBalancer 的桥是**请求时按 serviceId 动态选路的装饰器**，而不是 client 创建时的固定装配。
- 文章边界：本篇重点讲 Feign 与 LoadBalancer 的集成层：`getTarget()` 的 url 决策、`FeignBlockingLoadBalancerClient` 包装、`BlockingLoadBalancerClient.choose()`、`reconstructURI`、阻塞桥 `Mono.from(...).block()`、以及 Feign child context 与 LoadBalancer child context 的关系；不展开 `RoundRobinLoadBalancer` 选举算法、`ServiceInstanceListSupplier` 组合、LB retry policy、CircuitBreaker 集成。

## 前置依赖

### HARD

- `ch10-openfeign-core/03-client-codec-retry-error-capability.md`（Feign 的 Client / Target / ResponseHandler 执行链）
- `ch11-springcloud-openfeign/01-enablefeignclients-registrar-factorybean.md`（FeignClientFactoryBean / named context）
- `ch11-springcloud-openfeign/02-springmvccontract-configuration-properties.md`（name / contextId / loader 决策）

### SOFT

- 不要求先懂 Spring Cloud LoadBalancer 的算法细节
- 不要求先懂 Reactor 的完整操作符语义

### NAV

- 后续可接：LB retry / CircuitBreaker / observability 专题
- 后续可接：Spring Cloud LoadBalancer 专门深究篇

## 一句话困惑

没有 `url` 的 `@FeignClient(name = "orders")`，到底是怎么把 `http://orders` 变成真实实例请求的？负载均衡是发生在 client 创建时，还是每次请求时？

## 一句话顿悟

Feign 与 LoadBalancer 的桥是一个**请求时按 serviceId 动态选路的装饰器**：Feign 只负责把 service name 换成逻辑 target 并挂上 `FeignBlockingLoadBalancerClient`；每次调用时该装饰器从 `request.url().getHost()` 读 serviceId，调用 `BlockingLoadBalancerClient.choose()` 选实例，再把逻辑 URL 重建为真实 host，最后交给底层 HTTP client。这个 client 是全局单例，没有在创建每个 Feign client 时固定。

## 读者理解路径

1. 先否定"客户端创建时就选好实例"的理解。
2. 建立最小总图：no-url → FeignClientFactoryBean.getTarget() → 逻辑 target + 挂 LB client → 每次请求 choose → reconstructURI → delegate HTTP。
3. 解释 `FeignClientFactoryBean.getTarget()` 的 url 决策分叉。
4. 解释 `FeignBlockingLoadBalancerClient` 的包装职责。
5. 解释 `BlockingLoadBalancerClient.choose()` / `reconstructURI()`。
6. 解释唯一的 Reactor→阻塞桥：`Mono.from(...).block()`。
7. 解释 Feign child context 与 LoadBalancer child context 是兄弟关系。
8. 解释有 url 时如何 unwrap 掉 LB 装饰器。
9. 收束到：Feign 与 LB 的边界在 "谁负责把逻辑 serviceId 变真实 host"。

## 失败方案推演

### 失败方案一：Feign 使用了 `@LoadBalanced`

- `@LoadBalanced` 是 Spring Cloud Commons 的一个 qualifier，只有 `LoadBalancerAutoConfiguration` 会识别它，作用对象是 `RestTemplate` / `RestClient` / `WebClient`。
- Feign 完全不会读取 `@LoadBalanced`；Feign 的触发点是 "没有 url"。
- 所以这两条路最终都汇到同一个 `BlockingLoadBalancerClient`，但 Feign 路径不经过 `@LoadBalanced`。

### 失败方案二：每个 Feign client 有自己独立的 LoadBalancer 配置

- Feign 的 per-client context（`FeignClientFactory`）和 LoadBalancer 的 per-service context（`LoadBalancerClientFactory`）是兄弟 context，不是 inherit 关系。
- `FeignBlockingLoadBalancerClient` 是根上下文里的全局单例，由所有 Feign client 共享。
- 真正的 per-service 选择发生在请求时，从 `request.url().getHost()` 读 serviceId，再从 `LoadBalancerClientFactory.getInstance(serviceId)` 取对应 LB 配置。

### 失败方案三：有显式 url 时也会走负载均衡

- 有 url 时，`FeignClientFactoryBean.getTarget()` 会通过 `getDelegate()` unwrap 掉 `FeignBlockingLoadBalancerClient`，让 Feign 直接使用原始 HTTP client。
- 测试证明有 url 的 builder 里是原始 `ApacheHttp5Client` 等，而不是 LB client。
- 所以显式 url = 直连；没有 url = LoadBalancer。

## 必须澄清的误解

1. `@LoadBalanced` 不在 Feign 路径上，它只是 RestTemplate/RestClient/WebClient 的 qualifier。
2. `FeignBlockingLoadBalancerClient` 是全局单例，由所有 Feign client 共享；per-service 选择发生在请求时。
3. 有显式 `url` 时，Feign 会 unwrap 掉 LB 装饰器，走原始 HTTP 直连。
4. no-url 的 `@FeignClient` 必须依赖 loadbalancer starter，否则会抛 "Did you forget to include spring-cloud-starter-loadbalancer?"。
5. 虽然内部使用 `ReactorLoadBalancer` 和 `Mono`，但 Feign 路径是同步阻塞的——唯一的阻塞桥是 `Mono.from(...).block()`。

## 文章结构与字数预算

1. 困惑开场：`http://orders` 是怎么变成真实请求的（800-1000 字）
2. 最小总图：Feign → LB 装饰器 → choose → reconstructURI → delegate HTTP（1000-1400 字）
3. `FeignClientFactoryBean.getTarget()`：url 决策分叉（1400-1800 字）
4. `FeignBlockingLoadBalancerClient`：请求时选路的装饰器（1400-2000 字）
5. `BlockingLoadBalancerClient.choose()` 与唯一的 Reactor→阻塞桥（1400-1800 字）
6. 兄弟 context：Feign child context vs LoadBalancer child context（1200-1600 字）
7. Auto-config 顺序与具体 client 选择（1000-1400 字）
8. no-instance → 503 与错误诊断（1000-1200 字）
9. 收网总结（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### no-url 决策与装配
- `FeignClientFactoryBean.java:469` — 无 url → loadBalance 路径
- `FeignClientFactoryBean.java:474` — 逻辑 URL 合成
- `FeignClientFactoryBean.java:481` — `loadBalance(...)`
- `FeignClientFactoryBean.java:427` — loadBalance 从 Feign child context 取 Client
- `FeignClientFactoryBean.java:436` — 无 Client 时抛 starter 缺失错误
- `FeignClientFactoryBean.java:486` — 有 url 时 unwrap 装饰器

### 请求时选路
- `FeignBlockingLoadBalancerClient.java:107` — serviceId 从 host 提取
- `FeignBlockingLoadBalancerClient.java:113` — LoadBalancerLifecycle 从 LB service context 取
- `FeignBlockingLoadBalancerClient.java:118` — `loadBalancerClient.choose(...)`
- `FeignBlockingLoadBalancerClient.java:121` — instance 为 null → 503
- `FeignBlockingLoadBalancerClient.java:135` — `reconstructURI(...)` 重建 host
- `FeignBlockingLoadBalancerClient.java:146` — buildRequest + transformers

### 阻塞桥
- `BlockingLoadBalancerClient.java:158` — choose
- `BlockingLoadBalancerClient.java:163` — `Mono.from(...).block()`
- `LoadBalancerClientFactory.java:79` — `getInstance(serviceId)`
- `LoadBalancerClientConfiguration.java:69` — ReactorLoadBalancer bean
- `LoadBalancerClientConfiguration.java:178` — 默认 ServiceInstanceListSupplier

### Auto-config
- `FeignLoadBalancerAutoConfiguration.java:47` — 条件与顺序
- `AutoConfiguration.imports:5` — 自动配置注册
- `DefaultFeignLoadBalancerConfiguration.java:48` — 默认 Client bean
- `OnRetryNotEnabledCondition.java:34` — retry 开关
- `FeignAutoConfiguration.java:121` — `FeignClientFactory` bean

## 测试证据清单

- `FeignLoadBalancerAutoConfigurationTests.java:46` — 单一 LB 装饰器与底层 delegate
- `FeignBlockingLoadBalancerClientTests.java:98` — serviceId 提取
- `FeignBlockingLoadBalancerClientTests.java:116` — no-instance → 503
- `FeignBlockingLoadBalancerClientTests.java:126` — reconstruct + transformers
- `FeignBlockingLoadBalancerClientTests.java:151` — lifecycle callback + hint
- `FeignClientFactoryBeanIntegrationTests.java:98` — 最小 load-balanced client demo
- `FeignHttpClientUrlTests.java:152` — 有 url 时原始 client

## 版本边界

- 当前分析对象固定为 `Spring Cloud OpenFeign 4.3.2 + Spring Cloud LoadBalancer + OpenFeign 13.6.1`。
- 本篇只讲 Feign 与 LoadBalancer 的集成层，不展开 LoadBalancer 算法和 supplier 组合。
- LB retry policy 与 CircuitBreaker 只作为"后续接缝"提及。

## 与其他篇的边界

### 本篇要讲清

- `FeignClientFactoryBean.getTarget()` 的 url 决策分叉。
- `FeignBlockingLoadBalancerClient` 的请求时选路职责。
- `BlockingLoadBalancerClient.choose()` / `reconstructURI()` / `Mono.block()`。
- Feign child context 与 LB child context 的关系。
- no-url 时为何必须依赖 loadbalancer starter。
- 有 url 时为何会 unwrap 掉 LB 装饰器。

### 本篇不深讲

- `RoundRobinLoadBalancer` 选举算法。
- `ServiceInstanceListSupplier` 各组合实现。
- LB retry policy 细节。
- CircuitBreaker 集成。
- Reactor/WebClient 的 LB client 自动配置。

## 写作后检查

- [ ] 开篇先抓"http://orders 怎么变成真实请求"，而不是直接讲 LoadBalancer 算法。
- [ ] 至少展开 3 个失败方案，且包含"Feign 使用 @LoadBalanced""有 url 也走负载均衡"。
- [ ] 明确给出 Feign → LB 装饰器 → choose → reconstruct → delegate 主链。
- [ ] 不把本篇写成 LoadBalancer 百科。
- [ ] 每个集成结论都落到 file:line 和测试。
- [ ] 删除代码块后，读者仍能复述"请求时按 serviceId 选路"的心智模型。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。