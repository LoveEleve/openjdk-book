# Spring Cloud OpenFeign：Micrometer、Observation 与 Capability — review notes

## 深度 review 结论

本轮按"事实 → 因果 → 结构 → 删码 → 边界"重审后，**当前正文无必须修改的事实性错误**，主线成立，可以收口。

之后已追加一轮深修：把 OpenFeign 上游 `BaseBuilder`、`Capability`、`MicrometerObservationCapability`、`MicrometerCapability`、`DefaultFeignObservationConvention` 的更细 `file:line` 锚点补回正文，用来把"Spring Cloud 只负责塞 capability，Feign core 负责真正 enrich"这条链压得更实。

## 第一轮：事实审

### 已复核的关键结论

1. `FeignClientFactory` 为每个 Feign client 建 child context，证据：`FeignAutoConfiguration.java:121`、`FeignClientFactory.java:47`。
2. `MicrometerConfiguration` 受全局属性、classpath 和 `FeignClientMicrometerEnabledCondition` 共同控制，证据：`FeignClientsConfiguration.java:239`。
3. 存在 `ObservationRegistry` 时优先注册 `MicrometerObservationCapability`，证据：`FeignClientsConfiguration.java:247`。
4. 仅在存在 `MeterRegistry` 且 observation capability 不存在时退回注册 `MicrometerCapability`，证据：`FeignClientsConfiguration.java:253`。
5. `FeignClientMicrometerEnabledCondition` 只检查当前 client 的 `spring.cloud.openfeign.client.config.<client>.micrometer.enabled`，缺省视为开启，证据：`FeignClientMicrometerEnabledCondition.java:31`、`FeignClientMicrometerEnabledCondition.java:40`。
6. `FeignClientFactoryBean` 会从 child context 收集 capability beans，并通过 `builder.addCapability(...)` 挂入 builder，证据：`FeignClientFactoryBean.java:247`。
7. `FeignClientFactoryBean` 也支持从 properties 中声明 capability 类并加入 builder，证据：`FeignClientFactoryBean.java:327`。
8. 正文关于 `Capability -> BaseBuilder.enrich()` 的定位，与 OpenFeign core 的 builder enrichment 机制一致，且现在已补 `feign/BaseBuilder.java:259`、`feign/BaseBuilder.java:265`、`feign/BaseBuilder.java:385`、`feign/Capability.java:38` 等锚点。
9. 正文关于 `MicrometerObservationCapability` 主要包 `Client` / `AsyncClient`，以及 `MicrometerCapability` 可扩展到 `Encoder` / `Decoder` / `InvocationHandlerFactory` 的结论，与上游 OpenFeign micrometer 模块实现一致，且现在已补 `feign/micrometer/MicrometerObservationCapability.java:45`、`feign/micrometer/MicrometerObservationCapability.java:72`、`feign/micrometer/MicrometerCapability.java:59`、`:64`、`:69`、`:74`、`:79` 等锚点。

### 测试证据复核

1. `FeignClientsMicrometerAutoConfigurationTests.java:44` — observation 优先矩阵。
2. `FeignClientsMicrometerAutoConfigurationTests.java:57` — 仅 `MeterRegistry` 时退回 legacy metrics。
3. `FeignClientsMicrometerAutoConfigurationTests.java:66` — 禁用/缺条件时不装 capability。
4. `FeignClientMicrometerEnabledConditionTests.java:77` — 默认开启语义。
5. `FeignClientMicrometerEnabledConditionTests.java:208` — 显式 false 才关闭。
6. `FeignClientDisabledFeaturesTests.java:62` — 全局禁用。
7. `FeignClientDisabledClientLevelFeaturesTests.java:64` — 单 client 禁用，其他 client 保持开启。
8. `FeignClientOverrideDefaultsTests.java:152` — 用户自定义 capability 覆盖默认能力。
9. `FeignClientUsingPropertiesTests.java:257` — capability 最终进入 builder.capabilities。

## 第二轮：因果审

- 全局 `micrometer.enabled=false` 先拦掉整个配置类，单 client 条件才有意义：成立。✅
- 单 client 条件必须运行在 child context 内，并依赖当前 `clientName`，否则无法实现 `foo` 关、`bar` 开：成立。✅
- observation capability 必须优先于 legacy metrics，否则会出现默认双挂或重复观测：成立。✅
- Spring Cloud 只负责挑选并注册 capability，而不是自己实现一套 metrics runtime，这样才能复用 Feign core 的 capability 扩展点：成立。✅
- `Capability` 放在 builder enrichment 层，才能同时覆盖 `Client`、`Encoder`、`Decoder`、`InvocationHandlerFactory` 等不同组件；如果只是 interceptor，就做不到：成立。✅

## 第三轮：结构审

### 结构是否跑偏

没有跑偏。正文的叙述顺序是：

1. 先抓住"Micrometer 到底挂在哪一层"  
2. 再用前三篇建立层级对照  
3. 先否定三种错误理解  
4. 再给总图  
5. 然后分别解释双开关、双 capability、builder enrichment 挂点  
6. 最后用 LoadBalancer / CircuitBreaker 对比收口  

这保证了正文没有退化成配置项说明书，也没有退化成 OpenFeign micrometer 模块 API 罗列。✅

### 失败方案是否有效

有效，且都命中了高频误解：
- observation 与 legacy metrics 会双挂  
- `FeignClientMicrometerEnabledCondition` 是全局开关  
- capability 与 LoadBalancer / CircuitBreaker 是同一种扩展点  

这三条刚好对应读者最容易混淆的三个层级。✅

## 第四轮：删码测试

把唯一一张总图删掉后，正文仍然能复述这条主线：

- 先在 child context 内挑 capability  
- 再通过 `FeignClientFactoryBean` 执行 `builder.addCapability(...)`  
- 再进入 OpenFeign core 的 `BaseBuilder.enrich()`  
- observation 与 legacy metrics 默认二选一  
- 单 client 开关是 opt-out，不是全局开关  

删码后主线不塌，说明代码块不是叙事骨架。✅

## 第五轮：边界审

### 本篇边界控制

当前正文边界控制是对的：
- 没把篇幅拉去讲 exporter / Actuator / scrape  
- 没把篇幅拉去讲 OTel / Brave bridge  
- 没把篇幅拉去讲 dashboard / tag 设计  
- 只讲到 Spring Cloud 如何选 capability，以及 Feign core 如何消费 capability  

### 与相邻篇章的边界

- 与 LoadBalancer 篇的差异：LoadBalancer 是 `Client` replacement。✅
- 与 CircuitBreaker 篇的差异：CircuitBreaker 是 Builder/Targeter/InvocationHandler 线。✅
- 本篇自身位置：Capability / builder enrichment 线。✅

这一点在正文第八节已经讲清，收束效果好。✅

## 第六轮：风险点

### 已确认不是问题的点

1. **正文没有把 `FeignClientMicrometerEnabledCondition` 写成总开关。**  
2. **正文没有把 observation 与 legacy metrics 写成默认双挂。**  
3. **正文没有把 capability 写成 interceptor。**  
4. **正文没有把本篇和 CircuitBreaker / LoadBalancer 混层。**  

### 当前仍存在的轻微风险

1. 正文已经补齐关键 OpenFeign 上游锚点，但如果后续要做整卷统一抛光，仍可继续把 observation tags 文档枚举、更多测试锚点压得更细。  
2. 这个问题不影响主线正确性，属于进一步精修项。  

## 机械检查

- 正文行数：311。✅
- 二级章节数：10。✅
- 禁用词命中：0。✅
- 叙述骨架未依赖代码块：是。✅
- 与 rewrite-plan 的主题、失败方案、总图、边界一致：是。✅

## 结论

本轮深度 review 后，正文可以认为已经完成收口：

- 事实层面成立  
- 因果链成立  
- 结构推进成立  
- 删码后主线成立  
- 与相邻篇章边界清晰  

如果后续要再提升一档，优先项不是改结构，而是**补 OpenFeign 上游 `BaseBuilder` / micrometer capability 的更细 `file:line` 锚点**。当前版本不改也可以过关。 
