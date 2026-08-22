# Spring Cloud OpenFeign：Codec、ErrorDecoder 与 Capability 边界 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch11-springcloud-openfeign`
- 篇：`07 Codec、ErrorDecoder 与 Capability 边界`
- 对应主题：`F-SC-7 Boundary / Codec / ErrorDecoder`
- 文章类型：Spring 基础设施收束篇
- 正文状态：未开始
- 分析对象：`Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`

## 文章定位

- 核心困惑：到这里读者通常已经被一堆类名绕晕：`SpringEncoder`、`SpringDecoder`、`ResponseEntityDecoder`、`OptionalDecoder`、`ErrorDecoder`、`FeignErrorDecoderFactory`、`Capability`。最常见的混乱是：哪些是 Spring Cloud 提供的，哪些是 OpenFeign core 提供的？`ResponseEntityDecoder` 是不是实际 JSON 解码器？Spring Cloud 有没有默认 `ErrorDecoder`？`Capability` 会不会把 codec 的职责再做一遍？
- 一句话顿悟：Spring Cloud OpenFeign 的主要职责不是重新发明 Feign 的 SPI，而是**把 Spring 世界的消息转换器、`ResponseEntity` 语义和按-client 的 error decoder 选择，装配成一套 Feign 可用的 bean 图**；真正的 `Encoder` / `Decoder` / `ErrorDecoder` SPI 定义、builder 槽位、默认 `DefaultErrorDecoder`、`OptionalDecoder` 以及 capability enrichment 机制，仍然属于 OpenFeign core。
- 文章边界：本篇重点讲默认 encoder/decoder 栈、`ErrorDecoder` 选择优先级、`FeignErrorDecoderFactory` 的位置，以及 `Capability` 为什么是后置装饰层而不是 codec 主装配层；不再展开 request 执行、retry loop、CircuitBreaker、LoadBalancer。

## 前置依赖

### HARD

- `ch10-openfeign-core/01-runtime-spine-builder-proxy-http.md`
- `ch10-openfeign-core/03-client-codec-retry-error-capability.md`
- `ch11-springcloud-openfeign/01-enablefeignclients-registrar-factorybean.md`
- `ch11-springcloud-openfeign/05-micrometer-observation-capability.md`
- `ch11-springcloud-openfeign/06-timeout-options-retry-redirect.md`

### SOFT

- 不要求先懂 Spring `HttpMessageConverter` 全部细节。
- 不要求先懂 OpenFeign `ResponseHandler` 的完整实现。

### NAV

- 后续可接：Spring Cloud OpenFeign 小结索引
- 后续可接：回到 OpenFeign core runtime 总结页

## 一句话困惑

Spring Cloud OpenFeign 到底给 Feign 加了哪些 codec / error-decoder 能力，哪些又仍然是 OpenFeign core 自己的职责？

## 一句话顿悟

Spring Cloud OpenFeign 负责把 Spring 的消息转换器和 `ResponseEntity` 语义装进 Feign 的 `Encoder` / `Decoder` 槽位，并按 client 选择 `ErrorDecoder`；OpenFeign core 负责 SPI 定义、默认 fallback、`OptionalDecoder` 与 capability enrichment。Spring Cloud 主要是在**装配 bean 图**，OpenFeign core 主要是在**定义并消费 SPI**。

## 读者理解路径

1. 先否定"所有这些 decoder 都是 Spring Cloud 的"这个直觉。
2. 建立最小总图：`FeignClientsConfiguration` → `SpringEncoder` / `OptionalDecoder(ResponseEntityDecoder(SpringDecoder))` → `FeignClientFactoryBean` → `builder.encoder/decoder/errorDecoder`。
3. 解释 decoder 叠层顺序，明确谁是 wrapper、谁是真正做 body decode 的执行者。
4. 解释 `ErrorDecoder` 的 bean / factory / property / core default 四层优先级。
5. 解释 `Capability` 是 builder post-assembly enrichment，不是 codec 主装配器。
6. 收束到 Spring Cloud 与 OpenFeign core 的职责边界。

## 失败方案推演

### 失败方案一：`OptionalDecoder`、`ResponseEntityDecoder`、`SpringDecoder` 都是 Spring Cloud 提供的一整套 decoder

- `OptionalDecoder` 实际属于 OpenFeign core。
- `ResponseEntityDecoder` 与 `SpringDecoder` 属于 Spring Cloud。
- 所以默认 decoder 栈是跨项目拼出来的，不是 Spring Cloud 单独造的一整套。

### 失败方案二：`ResponseEntityDecoder` 就是真正做 JSON / XML 解码的核心 decoder

- `ResponseEntityDecoder` 只识别 `HttpEntity` / `ResponseEntity` 这类 Spring 容器类型。
- 真正把 body 交给 `HttpMessageConverter` 去反序列化的是 `SpringDecoder`。
- 所以 `ResponseEntityDecoder` 更像 Spring 语义适配层，不是消息体解码器本体。

### 失败方案三：Spring Cloud OpenFeign 自带一个默认 `ErrorDecoder` bean

- Spring Cloud 并没有在 `FeignClientsConfiguration` 里提供默认 `ErrorDecoder` bean。
- 如果上下文中既没有 `ErrorDecoder` bean，也没有 `FeignErrorDecoderFactory`，最终留下的是 OpenFeign core `BaseBuilder` 里的 `DefaultErrorDecoder`。
- 所以默认错误语义的兜底依然属于 OpenFeign core。

## 必须澄清的误解

1. `OptionalDecoder` 不是 Spring Cloud 类，而是 OpenFeign core 类。
2. `ResponseEntityDecoder` 不是实际 body decoder，而是 `ResponseEntity` 包装层。
3. Spring Cloud 默认提供 encoder/decoder 栈，但不提供默认 `ErrorDecoder` bean。
4. `FeignErrorDecoderFactory` 是 Spring Cloud 额外增加的按-client factory hook。
5. `Capability` 是 Feign core 的后置 enrich 机制，不是 codec 主装配层。

## 文章结构与字数预算

1. 困惑开场：一堆 codec / decoder 类名为什么最容易写混（800-1000 字）
2. 最小总图：bean 图如何进入 builder（1000-1400 字）
3. 默认 decoder 栈：`OptionalDecoder(ResponseEntityDecoder(SpringDecoder))`（1600-2200 字）
4. 默认 encoder 栈：`SpringEncoder` / `PageableSpringEncoder`（1200-1600 字）
5. `ErrorDecoder` 选择优先级（1600-2200 字）
6. `Capability` 的位置：后置 enrich，不重复 codec 职责（1200-1800 字）
7. Spring Cloud vs OpenFeign core 边界收束（1000-1400 字）
8. 误解澄清与总结（600-900 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `FeignClientFactoryBean.java:140` — builder 注入 logger/encoder/decoder/contract
- `FeignClientsConfiguration.java:104` — 默认 decoder bean
- `FeignClientsConfiguration.java:109` — 默认 encoder bean
- `FeignClientsConfiguration.java:121` — `PageableSpringEncoder`
- `SpringDecoder.java:64` — `HttpMessageConverterExtractor`
- `ResponseEntityDecoder.java:50` — 识别并包装 `ResponseEntity`
- `SpringEncoder.java:107` — form 与消息转换器分叉
- `SpringEncoder.java:173` — 消息转换器编码路径
- OpenFeign `feign/optionals/OptionalDecoder.java:27` — `OptionalDecoder` 所属与语义
- `FeignClientFactoryBean.java:201` — `ErrorDecoder` bean 优先
- `FeignClientFactoryBean.java:206` — `FeignErrorDecoderFactory`
- `FeignClientFactoryBean.java:294` — property `errorDecoder` 应用路径
- `FeignClientProperties.java:141` — `errorDecoder` property 模型
- `FeignClientFactoryBean.java:173` — properties vs bean 顺序
- `FeignErrorDecoderFactory.java:26` — factory SPI
- OpenFeign `feign/BaseBuilder.java:50` — core 默认 builder 字段
- OpenFeign `feign/BaseBuilder.java:55` — core 默认 `DefaultErrorDecoder`
- OpenFeign `feign/Capability.java:36` — capability SPI
- OpenFeign `feign/BaseBuilder.java:265` — `enrich()`
- OpenFeign `feign/Feign.java:218` — decoder/errorDecoder 进入 runtime

## 测试证据清单

- `EnableFeignClientsTests.java:63` — 默认 decoder bean
- `EnableFeignClientsTests.java:68` — 默认 encoder bean
- `FeignClientOverrideDefaultsTests.java:81` — 默认 `OptionalDecoder`
- `FeignClientOverrideDefaultsTests.java:87` — 默认 `PageableSpringEncoder`
- `FeignClientErrorDecoderTests.java:75` — `ErrorDecoder` bean 优先于 factory
- `FeignClientErrorDecoderTests.java:80` — factory 在 bean 缺失时生效
- `FeignErrorDecoderFactoryTests.java:35` — 无默认 factory bean
- `FeignErrorDecoderFactoryTests.java:55` — factory 不覆盖已有 `ErrorDecoder`
- `FeignClientOverrideDefaultsTests.java:117` — property override errorDecoder
- `SpringDecoderIntegrationTests.java:82` — `ResponseEntity` decode
- `SpringDecoderIntegrationTests.java:159` — `dismiss404` / 空体等边界
- `SpringEncoderTests.java:94` — converter 参与编码
- OpenFeign `OptionalDecoderTests.java:39` — `OptionalDecoder` 语义

## 版本边界

- 当前分析对象固定为 `Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`。
- 不展开全部 `HttpMessageConverter` 细节。
- 不展开 `ResponseHandler` 内部执行流程。
- 不回头重复 retry / timeout / circuit breaker。

## 与其他篇的边界

### 本篇要讲清

- Spring Cloud 默认 encoder/decoder 栈是如何拼起来的。
- `ErrorDecoder` 的选择优先级。
- `FeignErrorDecoderFactory` 在 Spring Cloud 里补了什么。
- `Capability` 为什么不取代 codec 主装配职责。
- Spring Cloud 与 OpenFeign core 的最终边界。

### 本篇不深讲

- 请求执行期状态码处理细节。
- RetryableException / retry loop。
- LoadBalancer / CircuitBreaker。

## 写作后检查

- [ ] 开篇先抓"这些 decoder 到底谁是谁"，而不是直接罗列 bean。
- [ ] 至少展开 3 个失败方案，且包含"Spring Cloud 有默认 ErrorDecoder bean"和"ResponseEntityDecoder 就是 body decoder"。
- [ ] 明确给出 encoder/decoder/errorDecoder 的装配总图。
- [ ] 明确区分 Spring Cloud 装配职责与 OpenFeign core SPI/runtime 职责。
- [ ] 每个装配结论都落到 file:line 和测试。
- [ ] 删除代码块后，读者仍能复述默认 decoder 栈和 error decoder 兜底归属。
- [ ] 通过一次性深审收口。
