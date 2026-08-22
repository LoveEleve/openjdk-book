# OpenFeign：Client、Codec、Retry、ErrorDecoder 与 Capability 扩展层 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch10-openfeign-core`
- 篇：`03 Client、Codec、Retry、ErrorDecoder 与 Capability 扩展层`
- 对应主题：`F-EXT-1 OpenFeign Execution Extensions`
- 文章类型：核心扩展执行层篇
- 正文状态：未开始
- 基于版本：`OpenFeign 13.14-SNAPSHOT`

## 文章定位

- 核心困惑：前两篇已经讲完 OpenFeign 的主链和请求蓝图，但真实运行时还有一组可插拔对象：`Client`、`Encoder`、`Decoder`、`Retryer`、`ErrorDecoder`、`RequestInterceptor`、`ResponseInterceptor`、`MethodInterceptor`、`Capability`。它们看起来都是“扩展点”，但粒度和时机完全不同：有的每个 client 一份，有的每次 attempt 执行，有的每次逻辑调用 clone，有的在 build 阶段装饰整个运行链。读者真正困惑的是：这些扩展分别插在哪里？谁决定重试？谁产生 `RetryableException`？为什么 Capability 不是普通策略接口？
- 一句话顿悟：OpenFeign 的扩展层不是一排平行插件，而是分布在运行链不同位置的执行边界：`Encoder` 参与请求模板构造，`RequestInterceptor` 修改每次 attempt 的模板，`Client` 执行 HTTP，`ResponseInterceptor` 包住响应解释，`Decoder` 处理成功返回，`ErrorDecoder` 将非 2xx 转成异常，`Retryer` 决定 `RetryableException` 是否继续，而 `Capability` 在 build 阶段装饰这些组件。理解它们的生命周期和重试粒度，比记住接口名字更重要。
- 文章边界：本篇重点讲 OpenFeign core 扩展点的插入位置、粒度、retry 交互和 Capability 装饰；不深入 Spring Cloud OpenFeign 的 Bean/child context/LoadBalancer/CircuitBreaker，不展开具体 JSON/Protobuf encoder/decoder 算法。

## 前置依赖

### HARD

- `ch10-openfeign-core/01-runtime-spine-builder-proxy-http.md`
- `ch10-openfeign-core/02-contract-methodmetadata-requesttemplate.md`

### SOFT

- 不要求先懂 Spring Cloud OpenFeign。
- 不要求先懂所有 HTTP client adapter。

### NAV

- 后续可接：Spring Cloud OpenFeign 集成篇。
- 后续可接：Micrometer / caching / reactive / validation Capability 专题。

## 一句话困惑

OpenFeign 的这些扩展点分别在什么时候运行、作用在哪个对象上、重试时会不会再执行？`Retryer`、`ErrorDecoder` 和 `RetryableException` 到底怎样协作？Capability 为什么不是普通的 Client 替换器？

## 一句话顿悟

OpenFeign 扩展点必须按“位置 + 粒度”理解：`Encoder` 构造请求，`RequestInterceptor` 按 attempt 改模板，`Client` 做 HTTP I/O，`ResponseInterceptor` 包响应解释，`Decoder/ErrorDecoder` 决定成功值或异常，`Retryer` 控制 retry loop，而 `Capability` 在 build-time 装饰整套组件；它们不是平行插件，而是插在 runtime spine 不同切口上的执行协议。

## 读者理解路径

1. 先否定“所有扩展都是同一种 plugin”的理解。
2. 建立扩展执行总图：request side / HTTP side / response side / build decoration。
3. 解释 `Client` / `Encoder` / `RequestInterceptor` 的请求侧边界。
4. 解释 `Decoder` / `ErrorDecoder` / `ResponseInterceptor` 的响应侧边界。
5. 解释 `Retryer` 和 `RetryableException` 的控制流。
6. 解释不同扩展点的 per-client / per-call / per-attempt 粒度。
7. 解释 `Capability` 为什么是 build-time decorator，以及 clone/build 顺序。
8. 收束到：扩展点的关键不是“能不能替换”，而是“在哪个时机、包住哪段链”。

## 失败方案推演

### 失败方案一：所有扩展点都是平行策略，只是名字不同

- `Client`、`Encoder`、`Retryer` 和 `Capability` 的时机完全不同。
- 有的直接被 MethodHandler 调用，有的在 response chain 中，有的在 build 阶段装饰 builder。
- 所以不能把它们放进一张“插件列表”里解释。

### 失败方案二：Retryer 自己判断 HTTP 状态码

- Retryer 接收的是 `RetryableException`，它不直接读取 response status。
- 非 2xx 是否产生可重试异常，通常由 ErrorDecoder 决定；Retryer 再决定是否继续和等待多久。
- 所以 ErrorDecoder 和 Retryer 是前后相接的控制流，不是两个独立 retry 开关。

### 失败方案三：Capability 只是替换一个 Client

- Capability 可以同时装饰 Client、Encoder、Decoder、Retryer、Interceptor、InvocationHandlerFactory 等多个组件。
- 它通过 clone builder 和逐字段 enrichment 形成最终运行对象。
- 所以 Capability 是构建期装饰协议，不是普通单一策略接口。

## 必须澄清的误解

1. `RequestInterceptor` 是 per-attempt，不是每个逻辑调用只执行一次。
2. `Encoder` 通常在模板构造阶段执行，不等于每次 retry 都重新编码。
3. `ErrorDecoder` 只处理非 2xx，不自动处理 200 body 里的业务错误。
4. `RetryableException` 只是控制流信号，是否继续由 Retryer 决定。
5. `ResponseInterceptor` 位于 Decoder 外层，可以短路或包裹整个响应解释过程。
6. Capability 在 build-time 装饰组件，不是运行时临时替换一个 Client。

## 文章结构与字数预算

1. 困惑开场：扩展点为什么不是一排平行插件（800-1000 字）
2. 最小总图：请求侧/响应侧/retry/build decoration（1000-1400 字）
3. 请求侧：Client / Encoder / RequestInterceptor（1600-2200 字）
4. 响应侧：ResponseInterceptor / Decoder / ErrorDecoder（1800-2400 字）
5. Retryer / RetryableException 控制流（1600-2200 字）
6. 粒度总表：per-client / per-invocation / per-attempt（1000-1400 字）
7. Capability：build-time 多组件装饰（1800-2400 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

### 请求侧
- `core/src/main/java/feign/Client.java:32` — Client SPI
- `core/src/main/java/feign/Encoder.java:69` — Encoder
- `core/src/main/java/feign/SynchronousMethodHandler.java:103` — executeAndDecode
- `SynchronousMethodHandler.java:147` — RequestInterceptor / Target 顺序
- `core/src/main/java/feign/RequestTemplateFactoryResolver.java:31` — Encoder 接入

### 响应侧
- `core/src/main/java/feign/ResponseHandler.java:65` — response interceptor chain
- `core/src/main/java/feign/InvocationContext.java:69` — proceed
- `InvocationContext.java:119` — Decoder / ErrorDecoder
- `core/src/main/java/feign/Decoder.java:24` — Decoder contract
- `core/src/main/java/feign/ErrorDecoder.java:46` — ErrorDecoder contract
- `core/src/main/java/feign/ResponseInterceptor.java:24` — ResponseInterceptor

### Retry
- `core/src/main/java/feign/Retryer.java:22` — Retryer contract
- `Retryer.java:46` — NEVER_RETRY
- `core/src/main/java/feign/SynchronousMethodHandler.java:68` — retry loop
- `SynchronousMethodHandler.java:72` — RetryableException catch
- `core/src/main/java/feign/RetryableException.java:23` — retryable signal
- `core/src/main/java/feign/ErrorDecoder.java:93` — Retry-After

### Capability
- `core/src/main/java/feign/Capability.java:27` — decorator contract
- `Capability.java:76` — Client enrich
- `Capability.java:116` — Encoder enrich
- `Capability.java:120` — Decoder enrich
- `Capability.java:128` — InvocationHandlerFactory enrich
- `core/src/main/java/feign/BaseBuilder.java:264` — clone/enrich
- `BaseBuilder.java:302` — fields and interceptors enrichment
- `BaseBuilder.java:385` — enrich().internalBuild()
- `core/src/main/java/feign/Capability.java:38` — capability order
- `micrometer/src/main/java/feign/micrometer/MicrometerCapability.java:58` — client decoration
- `MicrometerCapability.java:69` — encoder decoration

## 测试证据清单

- `core/src/test/java/feign/RetryerTest.java:31`
- `RetryerTest.java:57`
- `RetryerTest.java:72`
- `core/src/test/java/feign/codec/DefaultErrorDecoderTest.java:43`
- `DefaultErrorDecoderTest.java:133`
- `core/src/test/java/feign/codec/DefaultDecoderTest.java:41`
- `core/src/test/java/feign/CapabilityTest.java:25`
- `core/src/test/java/feign/BaseBuilderTest.java:1`
- `core/src/test/java/feign/interceptor/MethodInterceptorTest.java:53`
- `core/src/test/java/feign/FeignTest.java:1140`

## 版本边界

- 当前分析对象固定为 `OpenFeign 13.14-SNAPSHOT`。
- 本篇只讲 OpenFeign core 扩展执行层，不混入 Spring Cloud OpenFeign。
- 具体 HTTP client、JSON codec、Micrometer 实现只做示例，不展开完整模块。

## 与其他篇的边界

### 本篇要讲清

- Client/Encoder/Interceptor/Decoder/ErrorDecoder/Retryer 的插入位置和粒度。
- RetryableException 与 Retryer 的协作。
- ResponseInterceptor 与 Decoder/ErrorDecoder 的边界。
- Capability 的 build-time 多组件装饰。

### 本篇不深讲

- Contract / MethodMetadata / RequestTemplate 解析细节（上一篇）。
- Spring Cloud OpenFeign Bean/child context/LoadBalancer/CircuitBreaker。
- 具体 JSON/XML/Protobuf encoder/decoder 算法。

## 写作后检查

- [ ] 开篇先抓“扩展点为什么不是平行插件”，而不是直接列接口。
- [ ] 至少展开 3 个失败方案，且包含“Retryer 自己判断状态码”“Capability 只是 Client 替换器”。
- [ ] 明确给出请求侧/响应侧/retry/build decoration 总图。
- [ ] 不把本文写成扩展接口清单。
- [ ] 每个扩展点都标清 per-client / per-invocation / per-attempt 粒度。
- [ ] 删除代码块后，读者仍能复述扩展插入位置和重试控制流。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。