# Spring Cloud OpenFeign：Timeout、Request.Options、Retry 与 Redirect — review notes

## 深度 review 结论

本轮按"事实 → 因果 → 结构 → 删码 → 边界"重审后，**当前正文无必须修改的事实性错误**，主线成立，可以收口。

之后已追加一轮深修：把 OpenFeign 上游 `Request.Options`、`DefaultRetryer`、`DefaultErrorDecoder` 的更细 `file:line` 锚点补回正文，用来把"Options 是怎么建模的"、"默认退避怎么决定"、"默认什么情况下才会构造 `RetryableException`"这三处关键因果链压得更实。

## 第一轮：事实审

### 已复核的关键结论

1. `FeignClientProperties.FeignClientConfiguration` 建模了 `connectTimeout`、`readTimeout`、`followRedirects`、`retryer`，证据：`FeignClientProperties.java:131`、`:135`、`:137`、`:139`。
2. `FeignClientFactoryBean` 的本地 timeout / redirect 默认值来自 `new Request.Options()`，证据：`FeignClientFactoryBean.java:110`、`:112`、`:114`。
3. `configureFeign()` 会在配置 bean 与 properties 之间按 `defaultToProperties` 决定顺序，证据：`FeignClientFactoryBean.java:166`、`:174`、`:180`、`FeignClientProperties.java:52`。
4. `configureUsingProperties()` 会把 timeout / redirect 组装成新的 `Request.Options`，并把 property 指定的 `Retryer` 应用到 builder，证据：`FeignClientFactoryBean.java:279`、`:289`、`:290`。
5. `default` 配置与 named client 配置会按顺序叠加，证据：`FeignClientFactoryBean.java:176`、`:177`。
6. refresh 模式下，`FeignClientsRegistrar` 注册 refresh-scoped 的 `Request.Options` bean，由 `OptionsFactoryBean` 生产，证据：`FeignClientsRegistrar.java:262`、`:315`、`OptionsFactoryBean.java:54`。
7. `OptionsFactoryBean` 仍然按 `default + named client + 字段级回退` 生成新的 `Request.Options`，证据：`OptionsFactoryBean.java:61`、`:62`、`:76`、`:80`。
8. OpenFeign `SynchronousMethodHandler.runWithRetry()` 才是真正 retry loop，且只对 `RetryableException` 进入循环，证据：OpenFeign `feign/SynchronousMethodHandler.java:68`、`:73`。
9. I/O 异常会被包装为 `RetryableException`，证据：OpenFeign `feign/SynchronousMethodHandler.java:122`、`:132`、`feign/FeignException.java:302`。
10. 默认 `ErrorDecoder` 只在 `Retry-After` 存在时返回 `RetryableException`，证据：OpenFeign `feign/codec/DefaultErrorDecoder.java:45`、`:48`、`:50`。
11. raw Feign `BaseBuilder` 默认 `new DefaultRetryer()`，证据：OpenFeign `feign/BaseBuilder.java:48`；正文现在还补了 `feign/DefaultRetryer.java:28`、`:44`、`:49`、`:58`、`:77`、`:83` 来解释默认退避与 clone 行为。
12. Spring Cloud OpenFeign 默认用 `Retryer.NEVER_RETRY` 覆盖 raw Feign 默认值，证据：`FeignClientsConfiguration.java:160`、`:162`、`:207`、`:210`、`:211`。
13. redirect 只是 `Request.Options` 的一部分，最终由底层 `Client` 消费，证据：OpenFeign `feign/DefaultClient.java:158`、`:161`；正文现在还补了 `feign/Request.java:322`、`:438`、`:447`、`:456`、`:465` 来压实 `Request.Options` 模型与默认值。
14. 默认 `ErrorDecoder` 会先生成 `FeignException`，只有解析到 `Retry-After` 时才返回 `RetryableException`，正文现在已补 `feign/codec/DefaultErrorDecoder.java:45`、`:46`、`:47`、`:48`、`:49`、`:50` 锚点。

### 测试证据复核

1. `FeignClientUsingPropertiesTests.java:225` — property timeout 值进入 handler options。
2. `FeignClientUsingPropertiesTests.java:242` — `followRedirects` 生效。
3. `FeignClientUsingPropertiesTests.java:286` — property 驱动的 retryer / options 行为。
4. `FeignClientWithRefreshableOptionsTest.java:76` — refresh 前不变。
5. `FeignClientWithRefreshableOptionsTest.java:103`、`:113` — refresh 后变化。
6. `FeignClientOverrideDefaultsTests.java:111` — 覆盖 `Retryer`。
7. `FeignClientOverrideDefaultsTests.java:123` — 覆盖 `Request.Options`。
8. OpenFeign `FeignBuilderTest.java:120` — redirect 由 options 控制。
9. OpenFeign `FeignTest.java:691`、`:718`、`:743` — retry loop / clone / exhaustion。

## 第二轮：因果审

- timeout / redirect 必须先变成 `Request.Options`，否则 Spring Cloud 无法在统一 builder 路径上把这些配置交给不同底层 client：成立。✅
- retry loop 必须位于 OpenFeign `SynchronousMethodHandler`，否则 `Retryer` 无法和 method handler 的执行模型绑定：成立。✅
- Spring Cloud 必须显式把默认 retryer 改成 `NEVER_RETRY`，否则它的默认行为就会退回 raw Feign：成立。✅
- refreshable options 必须重新生成新的 `Request.Options`，而不是原地修改旧对象，才能契合 refresh-scope 模型：成立。✅
- redirect 由底层 client 消费而不是由 Feign retry loop 消费，这样它才是 HTTP transport 语义而不是方法级 retry 语义：成立。✅

## 第三轮：结构审

### 结构是否跑偏

没有跑偏。正文推进顺序是：

1. 先抓"retry 到底是谁在循环"  
2. 再把 `Request.Options` 与 `Retryer` 放进同一条总图  
3. 先否定三个最常见误解  
4. 再解释 options 来源、优先级、refresh  
5. 最后才落到 retry loop 和默认差异  

这保证了正文没有退化成配置项罗列，而是始终围绕"Spring 装配 / Feign 消费"主线推进。✅

### 失败方案是否有效

有效，而且正好命中高频误解：
- retry 是 Spring Cloud 自己做的  
- `followRedirects` 是 retry 开关  
- raw Feign 与 Spring Cloud 默认 retry 行为一致  

这三条分别对应 runtime 所属、redirect/retry 边界、默认策略差异，是本篇最需要先打掉的错觉。✅

## 第四轮：删码测试

删除总图后，正文仍然能复述：

- `connectTimeout` / `readTimeout` / `followRedirects` 先进入 `Request.Options`  
- refreshable options 只是重新生成新的 `Request.Options`  
- 真正 retry loop 在 `SynchronousMethodHandler.runWithRetry()`  
- 只有 `RetryableException` 才能进入 loop  
- raw Feign 默认 `DefaultRetryer`，Spring 默认 `NEVER_RETRY`  

删码后主线不塌，说明代码块不是叙事骨架。✅

## 第五轮：边界审

### 本篇边界控制

当前正文边界控制是对的：
- 没把篇幅拉去讲 Spring Cloud LoadBalancer retry policy  
- 没把篇幅拉去讲 CircuitBreaker fallback 语义  
- 没把篇幅拉去讲每个底层 HTTP client 的全部 timeout 实现差异  
- 只讲 Spring 如何产出 `Options` / `Retryer`，以及 Feign core 如何消费它们  

### 与相邻篇章的边界

- 与 LoadBalancer 篇的差异：LoadBalancer 是 `Client` replacement。✅
- 与 CircuitBreaker 篇的差异：CircuitBreaker 是 Builder/Targeter/InvocationHandler 线。✅
- 本篇自身位置：`Request.Options` / `Retryer` 的配置到执行链。✅

## 第六轮：风险点

### 已确认不是问题的点

1. 正文没有把 retry loop 写成 Spring Cloud runtime。  
2. 正文没有把 redirect 与 retry 混成同一个机制。  
3. 正文没有把 503 自动等同于 retry。  
4. 正文没有忽略 raw Feign 与 Spring 默认 retryer 的分叉。  
5. 正文没有把 refreshable options 写成即时生效。  

### 当前仍存在的轻微风险

1. 正文已经补齐关键 OpenFeign 上游锚点，但如果后续做整卷统一抛光，仍可继续把 `SynchronousMethodHandler.findOptions()`、更多 retry 测试锚点压得更细。  
2. 这个问题不影响主线正确性，属于进一步精修项。  

## 机械检查

- 禁用表达已复扫；当前命中为 0。✅
- 正文行数：353。✅
- 二级章节数：12。✅
- 代码块只承担总图，不承担主叙事骨架。✅
- 源码锚点覆盖 Spring Cloud 本地源码与 OpenFeign 上游关键执行点。✅

## 结论

本轮深度 review 后，正文可以认为已经完成收口：

- 事实层面成立  
- 因果链成立  
- 结构推进成立  
- 删码后主线成立  
- 与相邻篇章边界清晰  

如果后续要再提升一档，优先项不是改结构，而是补更细的 OpenFeign 上游 `Request.Options` / `DefaultRetryer` / `DefaultErrorDecoder` 锚点。当前版本不改也可以过关。 
