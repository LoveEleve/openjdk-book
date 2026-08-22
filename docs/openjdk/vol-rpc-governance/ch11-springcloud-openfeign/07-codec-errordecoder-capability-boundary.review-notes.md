# Spring Cloud OpenFeign：Codec、ErrorDecoder 与 Capability 边界 — review notes

## 深度 review 结论

本轮按"事实 → 因果 → 结构 → 删码 → 边界"重审后，**当前正文无必须修改的事实性错误**，主线成立，可以收口。

之后已追加一轮深修：把 OpenFeign 上游 `OptionalDecoder`、`BaseBuilder`、`Feign.java` 的更细 `file:line` 锚点补回正文，用来把"默认 decoder 栈里谁是 wrapper、谁是 delegate"、"core builder 默认槽位是什么"、"decoder/errorDecoder 最终怎么进入 runtime"这三处边界压得更实。

## 第一轮：事实审

### 已复核的关键结论

1. `FeignClientFactoryBean` 起手就把 `Logger`、`Encoder`、`Decoder`、`Contract` 从 context 中取出并塞进 builder，证据：`FeignClientFactoryBean.java:140`。
2. Spring Cloud 默认 `Decoder` bean 是 `OptionalDecoder(ResponseEntityDecoder(SpringDecoder(...)))`，证据：`FeignClientsConfiguration.java:104`。
3. Spring Cloud 默认 `Encoder` bean 是 `SpringEncoder`，在特定条件下再包 `PageableSpringEncoder`，证据：`FeignClientsConfiguration.java:109`、`:121`。
4. `OptionalDecoder` 属于 OpenFeign core，不属于 Spring Cloud，证据：OpenFeign `feign/optionals/OptionalDecoder.java:27`。
5. `OptionalDecoder` 对 `404` / `204` 返回 `Optional.empty()`，证据：OpenFeign `feign/optionals/OptionalDecoder.java:36`。
6. `ResponseEntityDecoder` 负责识别 `HttpEntity` / `ResponseEntity` 并在委托解 body 后重建 Spring `ResponseEntity`，证据：`ResponseEntityDecoder.java:41`、`:50`。
7. `SpringDecoder` 通过 `HttpMessageConverterExtractor` 使用 Spring `HttpMessageConverter` 做实际 body decode，证据：`SpringDecoder.java:64`。
8. `SpringEncoder` 对 form/multipart 与常规消息转换器路径做分叉，证据：`SpringEncoder.java:107`、`:173`。
9. Spring Cloud 没有在 `FeignClientsConfiguration` 中提供默认 `ErrorDecoder` bean；`FeignClientFactoryBean` 先查 `ErrorDecoder` bean，再查 `FeignErrorDecoderFactory`，证据：`FeignClientFactoryBean.java:201`、`:206`。
10. property `errorDecoder` 也能覆盖 builder 上的 decoder 选择，证据：`FeignClientFactoryBean.java:294`、`FeignClientProperties.java:141`。
11. 如果 Spring Cloud 这一侧没有设置 `ErrorDecoder`，最终保留的是 OpenFeign core `BaseBuilder` 默认字段里的 `DefaultErrorDecoder`，证据：OpenFeign `feign/BaseBuilder.java:55`；正文现在还补了 `feign/BaseBuilder.java:47`、`:50`、`:51`、`:82`、`:92`、`:97` 来压实 core builder 的默认槽位与写入路径。
12. `Capability` 是 OpenFeign core SPI；Spring Cloud 只是收集 capability beans 后加到 builder 中，证据：OpenFeign `feign/Capability.java:36`、`feign/BaseBuilder.java:265`、`FeignClientFactoryBean.java:247`。
13. decoder / errorDecoder 最终是在 Feign core runtime 中被消费，证据：OpenFeign `feign/Feign.java:218`；正文现在还补了 `feign/Feign.java:222`、`:223`、`:228`、`:238`、`:239` 来压实它们如何进入 `ResponseHandler` 与 method handler factory。
14. `OptionalDecoder` 本身就是一个 delegate wrapper：先判断 `Optional`，再在 `404/204` 与普通路径之间分叉，正文现在已补 `feign/optionals/OptionalDecoder.java:30`、`:36`、`:40`、`:43` 锚点。

### 测试证据复核

1. `EnableFeignClientsTests.java:63` — 默认 decoder bean。
2. `EnableFeignClientsTests.java:68` — 默认 encoder bean。
3. `FeignClientOverrideDefaultsTests.java:81` — 默认 `OptionalDecoder`。
4. `FeignClientOverrideDefaultsTests.java:87` — 默认 `PageableSpringEncoder`。
5. `FeignClientErrorDecoderTests.java:75` — `ErrorDecoder` bean 优先于 factory。
6. `FeignClientErrorDecoderTests.java:80` — factory 在 bean 缺失时生效。
7. `FeignErrorDecoderFactoryTests.java:35` — 无默认 factory bean。
8. `FeignErrorDecoderFactoryTests.java:55` — factory 不覆盖已有 `ErrorDecoder`。
9. `FeignClientOverrideDefaultsTests.java:117` — property override errorDecoder。
10. `SpringDecoderIntegrationTests.java:82`、`:159` — `ResponseEntity` / 空体 / `dismiss404` 等边界。
11. `SpringEncoderTests.java:94` — Spring converter 参与编码。
12. OpenFeign `OptionalDecoderTests.java:39` — `OptionalDecoder` 语义。

## 第二轮：因果审

- Spring Cloud 必须自己提供 `SpringEncoder` / `SpringDecoder` / `ResponseEntityDecoder`，否则 Spring 的 `HttpMessageConverter` 与 `ResponseEntity` 语义接不进 Feign SPI：成立。✅
- `OptionalDecoder` 放在最外层，才能先处理 Java `Optional` 语义，再把内部类型交给下层 decoder：成立。✅
- `ResponseEntityDecoder` 必须位于 `SpringDecoder` 之外，才能在 body 解码后重新带上 headers / status 组装 `ResponseEntity`：成立。✅
- Spring Cloud 不提供默认 `ErrorDecoder` bean，而保留 OpenFeign core 默认兜底，说明它在错误语义上做的是"选择与装配"，不是重写 core default：成立。✅
- `Capability` 必须发生在 builder `enrich()` 阶段，而不是替代 codec 主装配，否则 Spring Cloud 与 OpenFeign core 的分工会重新混在一起：成立。✅

## 第三轮：结构审

### 结构是否跑偏

没有跑偏。正文推进顺序是：

1. 先抓"这些 decoder 到底谁是谁"  
2. 再用总图把 Spring Cloud 装配层与 Feign core SPI 层切开  
3. 先否定三个最常见误解  
4. 再分别解释 decoder 栈、encoder 栈、error decoder 选择链  
5. 最后用 capability 与整体边界收束  

这保证了正文没有退化成类名百科，也没有退化成零散 bean 罗列。✅

### 失败方案是否有效

有效，而且命中了最容易写混的三处：
- 默认 decoder 栈是不是全是 Spring Cloud 的  
- `ResponseEntityDecoder` 是不是实际 body decoder  
- Spring Cloud 有没有默认 `ErrorDecoder` bean  

这三条刚好对应本篇要切开的三层边界：类归属、职责归属、默认兜底归属。✅

## 第四轮：删码测试

删除总图后，正文仍然能复述：

- 默认 decoder 栈是 `OptionalDecoder(ResponseEntityDecoder(SpringDecoder))`  
- `OptionalDecoder` 属于 OpenFeign core  
- 真正做 body decode 的是 `SpringDecoder`  
- Spring Cloud 不提供默认 `ErrorDecoder` bean，兜底仍是 core `DefaultErrorDecoder`  
- `Capability` 是后置 enrich，不替代 codec 主装配  

删码后主线不塌，说明代码块不是叙事骨架。✅

## 第五轮：边界审

### 本篇边界控制

当前正文边界控制是对的：
- 没回头重复 retry / timeout 细节  
- 没重新展开 LoadBalancer / CircuitBreaker  
- 没深讲 `ResponseHandler` 内部执行细节  
- 只讲 Spring Cloud codec / error-decoder / capability 边界的收束  

### 与相邻篇章的边界

- 与 OpenFeign core codec 篇的差异：那篇讲 SPI/runtime，本篇讲 Spring Cloud 如何把 Spring 世界接进这些 SPI。✅
- 与 Micrometer 篇的差异：那篇讲 capability 作为 builder enrichment，这篇只用 capability 做边界对照。✅
- 本篇自身位置：Spring Cloud OpenFeign 章节的收束篇。✅

## 第六轮：风险点

### 已确认不是问题的点

1. 正文没有把整个默认 decoder 栈都写成 Spring Cloud 自己的实现。  
2. 正文没有把 `ResponseEntityDecoder` 写成实际 body decoder。  
3. 正文没有误写 Spring Cloud 提供默认 `ErrorDecoder` bean。  
4. 正文没有把 `Capability` 写成 codec 主装配器。  
5. 正文没有把 `FeignErrorDecoderFactory` 写成 OpenFeign core SPI。  

### 当前仍存在的轻微风险

1. 正文已经补齐关键 OpenFeign 上游锚点，但如果后续做整卷统一抛光，仍可继续把 `ResponseHandler`、`SpringEncoder`/`SpringDecoder` 的更细局部路径压得更密。  
2. 这个问题不影响主线正确性，属于进一步精修项。  

## 机械检查

- 禁用表达已复扫；当前命中为 0。✅
- 正文行数：351。✅
- 二级章节数：11。✅
- 代码块只承担总图，不承担主叙事骨架。✅
- 源码锚点覆盖 Spring Cloud 本地源码与 OpenFeign 上游关键边界点。✅

## 结论

本轮深度 review 后，正文可以认为已经完成收口：

- 事实层面成立  
- 因果链成立  
- 结构推进成立  
- 删码后主线成立  
- 与相邻篇章边界清晰  

如果后续要再提升一档，优先项不是改结构，而是补更细的 OpenFeign 上游 `OptionalDecoder` / `BaseBuilder` / `Feign.java` 锚点。当前版本不改也可以过关。 
