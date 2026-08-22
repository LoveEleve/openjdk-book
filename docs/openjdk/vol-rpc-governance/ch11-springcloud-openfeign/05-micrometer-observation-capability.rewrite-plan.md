# Spring Cloud OpenFeign：Micrometer、Observation 与 Capability — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch11-springcloud-openfeign`
- 篇：`05 Micrometer、Observation 与 Capability`
- 对应主题：`F-SC-5 Observability / Capability`
- 文章类型：Spring 基础设施集成篇
- 正文状态：未开始
- 分析对象：`Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`

## 文章定位

- 核心困惑：很多读者知道 Feign 能接 Micrometer，但一落到 Spring Cloud OpenFeign 就开始混：`MicrometerObservationCapability` 和 `MicrometerCapability` 到底谁生效？两者会不会一起挂上去？`FeignClientMicrometerEnabledCondition` 是全局开关还是单 client 开关？`Capability` 又到底插在 Feign 的哪一层——它和上一篇的 CircuitBreaker、再上一篇的 LoadBalancer 是同一类扩展点吗？
- 一句话顿悟：Spring Cloud OpenFeign 并不是直接在 Feign client 上硬编码指标逻辑，而是在每个 Feign child context 里按条件注册一个 `Capability` bean：有 `ObservationRegistry` 时优先注册 `MicrometerObservationCapability`，否则在有 `MeterRegistry` 时退化到 `MicrometerCapability`；随后 `FeignClientFactoryBean` 把这些 capability 统一塞进 `Feign.Builder.addCapability(...)`。所以 observability 在这里是 **Feign core 的 builder enrichment 扩展点**，不是 Targeter 层，也不是 LoadBalancer 的 Client 替换层。
- 文章边界：本篇重点讲 Spring Cloud OpenFeign 如何决定装哪个 capability、全局/单 client 开关如何生效、`Capability` 在 Feign core 里的挂载点，以及 Observation 与 legacy metrics 覆盖范围差异；不展开具体 Micrometer exporter、OpenTelemetry/Brave bridge、Actuator 暴露细节。

## 前置依赖

### HARD

- `ch10-openfeign-core/01-runtime-spine-builder-proxy-http.md`（Feign.Builder / InvocationHandler / Client 主线）
- `ch11-springcloud-openfeign/01-enablefeignclients-registrar-factorybean.md`（child context / FactoryBean 主线）

### SOFT

- 不要求先懂 Micrometer exporter。
- 不要求先懂 Observation API 下游 bridge。

### NAV

- 后续可接：`Feign + OTel/Brave bridge`
- 后续可接：`Feign retry / CircuitBreaker / metrics 的叠加顺序`

## 一句话困惑

Spring Cloud OpenFeign 到底什么时候装 `MicrometerObservationCapability`，什么时候装 `MicrometerCapability`？`Capability` 插在 Feign 的哪一层？

## 一句话顿悟

Spring Cloud OpenFeign 先在每个 Feign child context 中按条件创建 capability bean，再由 `FeignClientFactoryBean` 统一 `addCapability(...)` 到 `Feign.Builder`；有 `ObservationRegistry` 时优先 observation，没有时才退回 legacy metrics。`Capability` 是 Feign core builder enrichment 扩展点，不是 CircuitBreaker 的 Targeter 层，也不是 LoadBalancer 的 Client 替换层。

## 读者理解路径

1. 先否定"Micrometer 就是包一层 client"的直觉。
2. 建立最小总图：child context → micrometer config → capability bean → `builder.addCapability()` → Feign core `enrich()`。
3. 解释全局开关与单 client 开关的优先级。
4. 解释 ObservationCapability 与 MicrometerCapability 的差异和优先顺序。
5. 解释 `Capability` 在 Feign core 中到底怎么改写 builder 内部组件。
6. 对比 CircuitBreaker / LoadBalancer / Capability 三种扩展层级。
7. 收束到：observability 在 Spring Cloud OpenFeign 里是 builder enrichment，不是 target/proxy replacement。

## 失败方案推演

### 失败方案一：`MicrometerObservationCapability` 和 `MicrometerCapability` 会一起装上去

- 直觉上你可能觉得 observation 是 tracing、metrics 是指标，所以二者会叠加。
- 但 Spring Cloud OpenFeign 在 `ObservationRegistry` 存在时优先注册 `MicrometerObservationCapability`，并通过 `@ConditionalOnMissingBean({ MicrometerCapability.class, MicrometerObservationCapability.class })` 抑制 legacy capability。
- 所以默认不会双挂，优先 observation，缺 observation 才退到 legacy metrics。

### 失败方案二：`FeignClientMicrometerEnabledCondition` 是全局开关

- 全局开关实际上是 `spring.cloud.openfeign.micrometer.enabled`，它决定整个 micrometer 配置类是否参与。
- `FeignClientMicrometerEnabledCondition` 只在 child context 里看当前 client 的 `spring.cloud.openfeign.client.config.<client>.micrometer.enabled`。
- 所以它是单 client 级别的 opt-out，不是全局总开关。

### 失败方案三：Capability 和 CircuitBreaker / LoadBalancer 是同一种扩展点

- LoadBalancer 主要是替换 `Client` 实现。
- CircuitBreaker 主要是替换 Builder 类型和 Targeter，并在 InvocationHandler 层包装调用。
- Capability 则是 Feign core 自己的 builder enrichment 机制，可以包装 `Client`、`Encoder`、`Decoder`、`InvocationHandlerFactory` 等组件。
- 所以三者层级不同，不能混成一件事。

## 必须澄清的误解

1. 全局 `micrometer.enabled=false` 会直接让整个 micrometer 配置类失效。
2. 单 client 的 `micrometer.enabled=false` 只影响当前 client，不影响其他 client。
3. ObservationCapability 与 MicrometerCapability 默认二选一，Observation 优先。
4. `Capability` 不是 RequestInterceptor，而是 Feign core 的组件增强点。
5. Observation 路径主要围绕 HTTP client exchange，legacy MicrometerCapability 覆盖面更广，可包 `Encoder`、`Decoder`、`InvocationHandlerFactory`。

## 文章结构与字数预算

1. 困惑开场：为什么 Feign 的 micrometer 看起来像一团雾（800-1000 字）
2. 最小总图：child context → capability bean → builder.addCapability → enrich（1000-1400 字）
3. 全局开关与单 client 开关（1200-1600 字）
4. ObservationCapability vs MicrometerCapability（1600-2200 字）
5. `Capability` 在 Feign core 的挂载点（1600-2200 字）
6. 与 CircuitBreaker / LoadBalancer 的层级对比（1200-1600 字）
7. 误解澄清与收网总结（800-1200 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `FeignAutoConfiguration.java:121` — `FeignClientFactory` child context 建立
- `FeignClientFactory.java:47` — 当前 clientName 放入 child context 环境
- `FeignClientsConfiguration.java:239` — micrometer 配置类条件
- `FeignClientsConfiguration.java:247` — `MicrometerObservationCapability` bean
- `FeignClientsConfiguration.java:253` — `MicrometerCapability` bean
- `FeignClientMicrometerEnabledCondition.java:31` — 单 client 条件判断
- `FeignClientProperties.java:165` — client config 结构
- `FeignClientProperties.java:365` — micrometer.enabled 默认值
- `FeignClientFactoryBean.java:247` — 从 bean 收集 capabilities
- `FeignClientFactoryBean.java:327` — 从 properties 收集 capabilities
- OpenFeign `BaseBuilder.addCapability` — capability 挂载入口
- OpenFeign `BaseBuilder.build` / `enrich` — capability 生效主线
- OpenFeign `MicrometerObservationCapability.enrich(Client)` — observation 覆盖范围
- OpenFeign `MicrometerCapability.enrich(...)` — legacy metrics 覆盖范围
- OpenFeign `DefaultFeignObservationConvention` — 默认 observation name/tags

## 测试证据清单

- `FeignClientsMicrometerAutoConfigurationTests.java:44` — observation 优先矩阵
- `FeignClientsMicrometerAutoConfigurationTests.java:57` — 仅 MeterRegistry 时走 legacy metrics
- `FeignClientsMicrometerAutoConfigurationTests.java:66` — 禁用/缺失时不装 capability
- `FeignClientMicrometerEnabledConditionTests.java:77` — 默认开启语义
- `FeignClientMicrometerEnabledConditionTests.java:208` — 显式 false 才关闭
- `FeignClientDisabledFeaturesTests.java:62` — 全局禁用
- `FeignClientDisabledClientLevelFeaturesTests.java:64` — 单 client 禁用，其他 client 保持开启
- `FeignClientOverrideDefaultsTests.java:152` — 用户自定义 capability 覆盖默认能力
- `FeignClientUsingPropertiesTests.java:257` — capability 最终进入 builder.capabilities

## 版本边界

- 当前分析对象固定为 `Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`。
- 不展开 exporter / scrape / actuator endpoint。
- 不展开 OTel / Brave bridge 的下游链路。
- 不展开业务侧 tag 定制策略。

## 与其他篇的边界

### 本篇要讲清

- Spring Cloud OpenFeign 怎样在 child context 中挑选并注册 micrometer capability。
- `FeignClientMicrometerEnabledCondition` 的全局/单 client 边界。
- `Capability` 如何进入 Feign.Builder 并通过 `enrich()` 改写组件。
- Observation 与 legacy metrics 的覆盖范围差异。

### 本篇不深讲

- 下游 tracing exporter。
- 指标平台接入与 dashboard。
- Retry / CircuitBreaker / metrics 的时序耦合细节。

## 写作后检查

- [ ] 开篇先抓"Micrometer 到底挂在哪一层"，而不是直接讲配置项。
- [ ] 至少展开 3 个失败方案，且包含"Observation 与 metrics 会双挂"和"FeignClientMicrometerEnabledCondition 是全局开关"。
- [ ] 明确给出 child context → capability bean → builder.addCapability → enrich 总图。
- [ ] 明确区分 Capability、CircuitBreaker、LoadBalancer 三种层级。
- [ ] 每个装配结论都落到 file:line 和测试。
- [ ] 删除代码块后，读者仍能复述 observation 优先、单 client opt-out、capability 的挂载位置。
- [ ] 通过一次性深审收口。
