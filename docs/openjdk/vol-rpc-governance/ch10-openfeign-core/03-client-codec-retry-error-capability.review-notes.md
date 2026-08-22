# OpenFeign：Client、Codec、Retry、ErrorDecoder 与 Capability 扩展层 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `Client.execute(Request, Options)` 是 HTTP I/O 边界，接收已成形 Request，返回 Response，不负责 contract/proxy/decoder，证据：`core/src/main/java/feign/Client.java:32`、`:43`。
2. `Encoder.encode(...)` 在 RequestTemplate 构造阶段修改 template body，证据：`core/src/main/java/feign/Encoder.java:69`、`core/src/main/java/feign/RequestTemplateFactoryResolver.java:31`、`:43`。
3. `RequestInterceptor.apply(template)` 在 `targetRequest()` 中运行，之后才调用 `Target.apply()` 和 `Client`，证据：`core/src/main/java/feign/SynchronousMethodHandler.java:147`。
4. `ResponseHandler` 进入 `ResponseInterceptor` chain，末端才是 `InvocationContext.proceed()`，证据：`core/src/main/java/feign/ResponseHandler.java:65`、`core/src/main/java/feign/ResponseInterceptor.java:48`。
5. `InvocationContext.proceed()` 根据 status / return type 决定 raw Response、Decoder、dismiss404、void 或 ErrorDecoder，证据：`core/src/main/java/feign/InvocationContext.java:69`、`:79`、`:119`。
6. `Retryer` 的核心是 `continueOrPropagate(RetryableException)` 和 `clone()`，每次逻辑调用 clone 一个实例，证据：`core/src/main/java/feign/Retryer.java:22`、`:46`、`core/src/main/java/feign/SynchronousMethodHandler.java:68`。
7. retry loop 捕获的是 `RetryableException`，而不是所有 IOException 或普通异常，证据：`SynchronousMethodHandler.java:72`。
8. `ErrorDecoder` 负责把非 2xx response 转成异常，可以产生 `RetryableException`，证据：`core/src/main/java/feign/ErrorDecoder.java:46`、`:93`、`InvocationContext.java:131`。
9. `Capability` 是 build-time 多目标装饰器，提供 Client/Encoder/Decoder/Retryer/Interceptor/InvocationHandlerFactory 等多个 `enrich()`，证据：`core/src/main/java/feign/Capability.java:27`、`:76`、`:116`、`:128`。
10. `BaseBuilder.enrich()` 会 clone builder，按顺序应用 capability，再 `internalBuild()`，避免污染原始 builder，证据：`core/src/main/java/feign/BaseBuilder.java:264`、`:302`、`:385`。
11. Capability 的组合顺序是嵌套顺序，后应用的 capability 包住先应用的对象，证据：`core/src/main/java/feign/Capability.java:38`、`core/src/test/java/feign/CapabilityTest.java:25`。
12. MethodInterceptor 包裹整个 HTTP exchange；RequestInterceptor/ResponseInterceptor 的粒度不同，证据：`BaseBuilder.java:227`、`SynchronousMethodHandler.java:59`。

### 测试证据已核对

1. `RetryerTest.java:31` — 指数退避 / 最大尝试。
2. `RetryerTest.java:57` — Retry-After。
3. `RetryerTest.java:72` — NEVER_RETRY。
4. `DefaultErrorDecoderTest.java:43` — 普通非 2xx 错误。
5. `DefaultErrorDecoderTest.java:133` — Retry-After / 503。
6. `DefaultDecoderTest.java:41` — Decoder 基础行为。
7. `CapabilityTest.java:25` — capability 装饰顺序。
8. `BaseBuilderTest.java:1` — builder/component enrichment。
9. `MethodInterceptorTest.java:53` — method interceptor 顺序。
10. `FeignTest.java:1140` — response interceptor 链。

### 深审发现

1. **高风险：容易把所有扩展点写成平行策略清单。** 当前正文已按请求/响应/retry/build decoration 四条边界组织。
2. **高风险：容易把 ErrorDecoder 和 Retryer 说成同一个 retry 开关。** 当前正文已拆为“ErrorDecoder 产生信号，Retryer 做控制”。
3. **中风险：容易把 RequestInterceptor 写成 per-invocation。** 当前正文已明确它位于 retry loop 内，是 per-attempt。
4. **中风险：容易把 Capability 写成 Client 替换器。** 当前正文已说明多组件 build-time enrichment。
5. **低风险：容易忽略 ResponseInterceptor 可以短路 Decoder。** 当前正文已把它放在 InvocationContext 外层解释。

## 第二轮：因果审

- Client 必须只接收最终 Request，否则 HTTP transport 会污染模板和 metadata 语义：✅
- Encoder 必须位于请求构造阶段，否则 body 无法进入最终 Request：✅
- RequestInterceptor 必须在 retry loop 内，动态 header/token/signature 才能随 attempt 重算：✅
- ErrorDecoder 必须先把非 2xx 转换成异常，Retryer 才能决定是否继续：✅
- Retryer 必须 clone per invocation，否则多个业务调用会共享退避和次数状态：✅
- Capability 必须在 build-time 装饰多个组件，否则 metrics/cache 等横切能力只能侵入具体实现：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → 扩展执行总图 → 请求侧 → 响应侧 → Retryer/ErrorDecoder → Capability → 粒度总表 → 误解澄清 → 收网总结”推进，没有退化成接口清单。

失败方案已覆盖：
- 所有扩展点都是平行策略
- Retryer 自己判断 HTTP status
- Capability 只是替换 Client

每一层拆解均包含：扩展位置 → 执行时机 → 重试粒度 → 证据位，符合 OpenFeign 扩展执行篇定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- Client/Encoder/RequestInterceptor 请求侧边界
- ResponseInterceptor/Decoder/ErrorDecoder 响应侧边界
- RetryableException -> Retryer 控制流
- Capability 多组件 build-time 装饰
- per-client / per-invocation / per-attempt 粒度差异

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重讲 Contract/MethodMetadata/RequestTemplate（前篇已覆盖）。✅
- 未混入 Spring Cloud OpenFeign Bean/child context/LoadBalancer/CircuitBreaker。✅
- 未展开具体 JSON/XML/Protobuf encoder/decoder 算法。✅
- 重点仍压在 OpenFeign core 扩展执行层与 Capability 装配，边界收得住。✅

## 第六轮：依赖审

- 已承接第一篇 runtime spine：扩展点都落回 `SynchronousMethodHandler` / `ResponseHandler` 主链。
- 已承接第二篇 blueprint：Encoder 使用 method metadata 选择的模板工厂，RequestInterceptor 作用于调用期 template。
- 后续 Spring Cloud 篇可以自然接这些 core 扩展如何变成 Spring Bean / child context 配置。

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。
- 代码块：使用少量执行链图和粒度表，不承担主叙事骨架。
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `Client`、`Encoder`、`Retryer`、`ErrorDecoder`、`ResponseInterceptor`、`InvocationContext`、`Capability`、`BaseBuilder`、`SynchronousMethodHandler`。
- 去掉代码块后正文仍成立：是。
- 叙述性正文字符数（不含代码块与空白行）：约 `14,211`。
- 目标定位：OpenFeign core 扩展执行层篇，篇幅与结构满足要求。

## 结论

本篇的目标是把 OpenFeign 的扩展点从“可替换接口列表”提升到“分布在请求、HTTP、响应、retry 和 build decoration 不同边界上的执行协议”，讲清 `ErrorDecoder -> RetryableException -> Retryer` 控制流，以及 Capability 如何在构建阶段装饰多个 runtime component。