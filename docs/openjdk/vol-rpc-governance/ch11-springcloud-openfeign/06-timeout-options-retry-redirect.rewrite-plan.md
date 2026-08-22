# Spring Cloud OpenFeign：Timeout、Request.Options、Retry 与 Redirect — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch11-springcloud-openfeign`
- 篇：`06 Timeout、Request.Options、Retry 与 Redirect`
- 对应主题：`F-SC-6 Options / Retry`
- 文章类型：Spring 基础设施集成篇
- 正文状态：未开始
- 分析对象：`Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`

## 文章定位

- 核心困惑：业务里最常见的 Feign 配置往往不是 Contract，而是 `connectTimeout`、`readTimeout`、`followRedirects` 和 `retryer`。但一旦追源码，很多读者马上会混乱：这些值到底是 Spring Cloud 自己消费，还是最终落到 OpenFeign `Request.Options`？retry 到底在 Spring Cloud 里做，还是在 Feign core 里做？为什么同样是 Feign，原生 Feign 默认会 retry，而 Spring Cloud OpenFeign 默认却几乎不 retry？
- 一句话顿悟：Spring Cloud OpenFeign 把 timeout/redirect 建模在 `FeignClientProperties` 里，最终在 `FeignClientFactoryBean` 中组装成 `Request.Options` 塞给 `Feign.Builder`；而真正的 retry 循环不在 Spring Cloud，而在 OpenFeign core 的 `SynchronousMethodHandler.runWithRetry()`。Spring Cloud 只是在默认装配时把 raw Feign 的 `DefaultRetryer` 换成了 `Retryer.NEVER_RETRY`。所以本篇的主线是：**Spring Cloud 负责把配置值变成 Options 和 Retryer，OpenFeign core 负责在调用期真正消费它们。**
- 文章边界：本篇重点讲 `FeignClientProperties`、`FeignClientFactoryBean`、`OptionsFactoryBean`、`Request.Options`、`Retryer`、`RetryableException`、`SynchronousMethodHandler.runWithRetry()`；不深入讲 Spring Cloud LoadBalancer 的 retry policy，不深入讲 CircuitBreaker 的失败恢复语义。

## 前置依赖

### HARD

- `ch10-openfeign-core/01-runtime-spine-builder-proxy-http.md`
- `ch11-springcloud-openfeign/01-enablefeignclients-registrar-factorybean.md`
- `ch11-springcloud-openfeign/03-loadbalancer-feign-client.md`
- `ch11-springcloud-openfeign/04-circuitbreaker-fallback.md`

### SOFT

- 不要求先懂底层 HTTP client 实现细节。
- 不要求先懂 Spring Cloud RefreshScope 的完整机制。

### NAV

- 后续可接：`Retry 与 LoadBalancer retry 的叠加`
- 后续可接：`Retry 与 CircuitBreaker 的交互边界`

## 一句话困惑

`connectTimeout`、`readTimeout`、`followRedirects`、`retryer` 最后到底落在哪？retry 到底是谁在循环？

## 一句话顿悟

Spring Cloud OpenFeign 负责把属性装配成 `Request.Options` 和 `Retryer`，再交给 Feign core；真正每次请求如何用 timeout、是否 follow redirects、是否循环 retry，都发生在 OpenFeign core 的 method handler 和底层 client 执行链里。

## 读者理解路径

1. 先否定"retry 是 Spring Cloud 帮你做的"这个直觉。
2. 建立总图：`FeignClientProperties -> FeignClientFactoryBean -> builder.options()/retryer() -> SynchronousMethodHandler -> client.execute(request, options)`。
3. 解释 timeout/redirect 怎么从 properties 变成 `Request.Options`。
4. 解释 `default` 配置、named client 配置、bean 配置、`defaultToProperties` 的优先级。
5. 解释 refreshable options 如何通过 `OptionsFactoryBean` 进入这条链。
6. 解释真正的 retry loop 在 `runWithRetry()`，只有 `RetryableException` 才会进入循环。
7. 解释为什么 raw Feign 默认会 retry，而 Spring Cloud 默认是 `NEVER_RETRY`。
8. 收束到：Spring 负责装配，Feign 负责消费与执行。

## 失败方案推演

### 失败方案一：retry 是 Spring Cloud OpenFeign 自己的调用循环

- Spring Cloud 只负责给 builder 装 `Retryer`。
- 真正的 retry loop 在 OpenFeign `SynchronousMethodHandler.runWithRetry()`。
- 所以 retry runtime 属于 Feign core，不属于 Spring Cloud。

### 失败方案二：`followRedirects` 是 Feign 的 retry 开关

- `followRedirects` 只是 `Request.Options` 中的一个 HTTP client 选项。
- 它最终交给底层 client，比如 `DefaultClient` 会调用 `HttpURLConnection.setInstanceFollowRedirects(...)`。
- 所以 redirect 跟 retry 是两条完全不同的线。

### 失败方案三：原生 Feign 和 Spring Cloud OpenFeign 的默认 retry 行为一致

- raw Feign `BaseBuilder` 默认是 `new DefaultRetryer()`。
- Spring Cloud OpenFeign 会注入 `Retryer.NEVER_RETRY` 覆盖这个默认值。
- 所以两个世界的默认行为不同，这是理解线上表现差异的关键。

## 必须澄清的误解

1. timeout/redirect 并不是底层 HTTP client 私有配置，而是先进入 Feign `Request.Options`。
2. retry loop 不在 Spring Cloud，而在 Feign core 的 `SynchronousMethodHandler`。
3. 不是所有异常和 HTTP 状态码都会 retry，必须转成 `RetryableException`。
4. Spring Cloud 默认会禁用 raw Feign 的默认 retry。
5. refreshable options 不会自动即时生效，要等 refresh 触发后才会换新值。

## 文章结构与字数预算

1. 困惑开场：最常配的 timeout/retry 为什么最容易写混（800-1000 字）
2. 最小总图：properties → factory bean → options/retryer → method handler（1000-1400 字）
3. `Request.Options` 的来源与默认值（1400-2000 字）
4. `default` / named client / bean / `defaultToProperties` 优先级（1400-2200 字）
5. refreshable options：`OptionsFactoryBean`（1000-1600 字）
6. retry loop：`runWithRetry()` 与 `RetryableException`（1800-2400 字）
7. raw Feign vs Spring Cloud 默认 retry 差异（1200-1600 字）
8. redirect 只是 options，不是 retry（800-1200 字）
9. 收网总结（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `FeignClientProperties.java:131` — `connectTimeout`
- `FeignClientProperties.java:135` — `readTimeout`
- `FeignClientProperties.java:137` — `followRedirects`
- `FeignClientProperties.java:139` — `retryer`
- `FeignClientProperties.java:52` — `defaultToProperties`
- `FeignClientFactoryBean.java:110` — 默认 connect timeout 来源于 `new Request.Options()`
- `FeignClientFactoryBean.java:166` — `configureFeign()`
- `FeignClientFactoryBean.java:174` — `defaultToProperties` 顺序分叉
- `FeignClientFactoryBean.java:212` — 从 context 取 `Request.Options` bean
- `FeignClientFactoryBean.java:279` — properties → `builder.options(...)`
- `FeignClientFactoryBean.java:289` — properties → `builder.retryer(...)`
- `FeignClientsRegistrar.java:262` — refreshable options bean 注册
- `OptionsFactoryBean.java:54` — refreshable options 生成入口
- `OptionsFactoryBean.java:76` — default / named config 合并
- OpenFeign `Request.java:429` — 默认 connect timeout
- OpenFeign `Request.java:447` — 默认 read timeout
- OpenFeign `Request.java:465` — 默认 `followRedirects`
- OpenFeign `BaseBuilder.java:48` — raw Feign 默认 `DefaultRetryer`
- OpenFeign `BaseBuilder.java:56` — `options` 字段
- OpenFeign `SynchronousMethodHandler.java:68` — `runWithRetry()`
- OpenFeign `SynchronousMethodHandler.java:119` — `client.execute(request, options)`
- OpenFeign `FeignException.java:302` — IO 异常转 `RetryableException`
- OpenFeign `codec/DefaultErrorDecoder.java:48` — `Retry-After` → `RetryableException`
- OpenFeign `DefaultRetryer.java:44` — `continueOrPropagate()`
- OpenFeign `DefaultClient.java:158` — `followRedirects` 交给底层 client
- `FeignClientsConfiguration.java:162` — Spring 默认 `Retryer.NEVER_RETRY`
- `FeignClientsConfiguration.java:207` — builder 应用 retryer bean

## 测试证据清单

- `FeignClientUsingPropertiesTests.java:225` — property timeout 值进入 handler options
- `FeignClientUsingPropertiesTests.java:242` — `followRedirects`
- `FeignClientUsingPropertiesTests.java:286` — property retryer / options 行为
- `FeignClientWithRefreshableOptionsTest.java:76` — refresh 前不变
- `FeignClientWithRefreshableOptionsTest.java:103` — refresh 后变化
- `FeignClientOverrideDefaultsTests.java:111` — 覆盖 `Retryer`
- `FeignClientOverrideDefaultsTests.java:123` — 覆盖 `Request.Options`
- OpenFeign `FeignBuilderTest.java:120` — redirect 由 options 控制
- OpenFeign `FeignTest.java:691` — retry loop
- OpenFeign `FeignTest.java:718` — retryer clone / propagate
- OpenFeign `FeignTest.java:743` — retry exhaustion

## 版本边界

- 当前分析对象固定为 `Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`。
- 不展开具体 HTTP client 实现（OkHttp / HC5）各自的 timeout 细节。
- 不展开 Spring Cloud LoadBalancer retry policy。
- 不展开 CircuitBreaker 失败恢复语义。

## 与其他篇的边界

### 本篇要讲清

- properties 如何变成 `Request.Options` 和 `Retryer`。
- Feign core 如何消费 `Request.Options`。
- 真正 retry loop 在哪，触发条件是什么。
- raw Feign 与 Spring Cloud 默认 retry 差异。

### 本篇不深讲

- LoadBalancer retry。
- CircuitBreaker fallback。
- 下游 HTTP client 的全部实现差异。

## 写作后检查

- [ ] 开篇先抓"retry 到底是谁在循环"，而不是直接列配置项。
- [ ] 至少展开 3 个失败方案，且包含"retry 是 Spring Cloud 做的"和"followRedirects 是 retry 开关"。
- [ ] 明确给出 properties → options/retryer → method handler 总图。
- [ ] 清楚对比 raw Feign 默认 retry 与 Spring 默认 `NEVER_RETRY`。
- [ ] 每个装配结论都落到 file:line 和测试。
- [ ] 删除代码块后，读者仍能复述 timeout/redirect 是 options，retry loop 在 Feign core。
- [ ] 通过一次性深审收口。
