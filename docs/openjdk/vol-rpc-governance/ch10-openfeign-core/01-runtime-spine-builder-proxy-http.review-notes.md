# OpenFeign：runtime spine——从 `Feign.builder()` 到 HTTP 调用 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `Feign.builder()` 只是返回 `Builder`，`target(...)` 通过 `build().newInstance(target)` 进入真正组装，不会立刻发请求，证据：`core/src/main/java/feign/Feign.java:36`、`:212`、`:217`。
2. `Builder.internalBuild()` 会组装 `ResponseHandler`、`SynchronousMethodHandler.Factory`、`RequestTemplateFactoryResolver`，最终返回 `ReflectiveFeign`，证据：`Feign.java:218`、`:228`、`:240`。
3. `ReflectiveFeign.newInstance(target)` 会解析 metadata、创建 `Method -> MethodHandler` 映射并生成 JDK 动态代理，证据：`core/src/main/java/feign/ReflectiveFeign.java:50`、`:58`、`:63`。
4. `Contract.parseAndValidateMetadata(...)` 在 build-time 生成 `MethodMetadata`，其中包含 `RequestTemplate` 原型，证据：`core/src/main/java/feign/Contract.java:49`、`:92`、`core/src/main/java/feign/MethodMetadata.java:37`、`:146`。
5. 每次方法调用时，`SynchronousMethodHandler.invoke(argv)` 会通过 `RequestTemplate.Factory` 从原型克隆模板，再用 `argv` 填充并 resolve，证据：`core/src/main/java/feign/SynchronousMethodHandler.java:49`、`core/src/main/java/feign/RequestTemplateFactoryResolver.java:40`、`:85`、`:107`。
6. `targetRequest(template)` 会在真正发请求前先跑 request interceptors，再调用 `Target.apply(template)`，说明 target 是 request-shaping hook 而不只是常量 URL，证据：`SynchronousMethodHandler.java:147`、`core/src/main/java/feign/Target.java:97`。
7. `Client.execute(request, options)` 是 HTTP I/O 的真正边界，默认 `DefaultClient` 基于 `HttpURLConnection` 执行，证据：`core/src/main/java/feign/Client.java:32`、`core/src/main/java/feign/DefaultClient.java:88`、`:146`、`:194`。
8. `ResponseHandler` 只是统一入口，真正决定 decode / error / raw response / dismiss404 的是 `InvocationContext.proceed()`，证据：`core/src/main/java/feign/ResponseHandler.java:65`、`core/src/main/java/feign/InvocationContext.java:69`、`:79`、`:119`。
9. retry 包裹的是 execute + response interpretation 的整体，而不只是 `Client.execute()` 本身，证据：`SynchronousMethodHandler.java:71`。
10. `DefaultInvocationHandlerFactory` 只负责创建默认 invocation handler；运行时方法分发仍然依赖预建好的 `MethodHandler` map，证据：`core/src/main/java/feign/DefaultInvocationHandlerFactory.java:25`、`ReflectiveFeign.java:75`。

### 测试证据已核对

1. `FeignBuilderTest.java:52` — builder/defaults 基本路径。
2. `FeignBuilderTest.java:255` — request interceptor 会影响最终 request。
3. `FeignBuilderTest.java:274` — 自定义 invocation handler factory 发生在代理创建阶段。
4. `FeignBuilderTest.java:313` — default method 处理。
5. `FeignTest.java:122`、`:136`、`:149` — body/template 解析路径。
6. `FeignTest.java:405` — `@QueryMap` 的 invoke-time 填充。
7. `FeignTest.java:547` — retryable exception 路径。
8. `FeignTest.java:768` — 原始 `Response` 返回特例。
9. `FeignTest.java:1119` — `decodeVoid` 路径。
10. `RequestTemplateTest.java:106`、`:348`、`:460` — template/target/resolve 相关行为。

### 深审发现

1. **高风险：容易把 Feign 写成注解解析器。** 当前正文已把主线压在 runtime spine，而不是 Contract 细节上。  
2. **高风险：容易把 build-time 与 invoke-time 混成一层。** 当前正文已明确区分 metadata/template 固定与 argv 填充。  
3. **中风险：容易把 target 当成静态 base URL。** 当前正文已把它提升为 request-shaping hook。  
4. **中风险：容易把 `Client.execute()` 误解成“业务结果已定”。** 当前正文已强调 ResponseHandler / InvocationContext 还要继续解释结果。  
5. **低风险：容易忽略 retry 包裹范围。** 当前正文已指出它包的是 execute + decode/error 流程。  

## 第二轮：因果审

- Builder 必须先组装策略对象，否则后续 `ReflectiveFeign` 无法构造稳定的 MethodHandler 链：✅
- `MethodMetadata` 和 `RequestTemplate` 必须在 build-time 固定原型，否则每次调用都要重新解析注解，成本和一致性都不可接受：✅
- `Target.apply()` 必须晚于参数填充，否则 base URL / target-specific 语义无法在最终 request 上生效：✅
- `Client.execute()` 必须和 `ResponseHandler` 分层，否则 HTTP I/O 和业务返回值/错误语义会耦合在一起：✅
- retry 必须包住 response interpretation，否则 decode/error-decoder 产出的可重试异常无法被统一处理：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → build-time/invoke-time 总图 → Builder → ReflectiveFeign → MethodMetadata/RequestTemplate → invoke-time request 生成 → Client.execute() → ResponseHandler → 误解澄清 → 收网总结”推进，没有退化成类清单。

失败方案已覆盖：
- 注解解析完就立刻发请求  
- target 只是 base URL 字符串  
- HTTP 返回后结果就直接给业务代码  

每一层拆解均围绕“哪个阶段固定结构、哪个阶段填充参数、哪个阶段真正做 I/O、哪个阶段解释结果”，符合 OpenFeign baseline 主线篇定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- `builder -> ReflectiveFeign -> MethodHandler -> Client.execute()` 主链  
- build-time 与 invoke-time 的明确分层  
- `MethodMetadata` / `RequestTemplate` / `Target` / `Client` / `ResponseHandler` 的职责边界  
- 为什么 Feign 不是“注解工具”，而是 client-side runtime spine  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开具体注解规则和 Contract 解析细节（留给下一篇）。✅
- 未展开 Encoder/Decoder/Retryer/ErrorDecoder 具体算法（后续篇）。✅
- 未混入 Spring Cloud OpenFeign bean lifecycle / named context / LB / circuit breaker。✅
- 重点仍压在 OpenFeign core runtime spine，边界收得住。✅

## 第六轮：依赖审

- 作为 OpenFeign 第一篇，不依赖前文即可成立。✅
- 与下一篇 Contract/MethodMetadata/RequestTemplate 专题形成清晰边界：本篇只用这些对象解释运行链，不深入注解解析语法。✅
- `FeignBuilderTest`、`FeignTest`、`RequestTemplateTest` 足以支撑主运行链与 build-time/invoke-time 分层。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅
- 代码块：使用少量 build-time / invoke-time 总图，不承担主叙事骨架。✅
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `Feign`、`ReflectiveFeign`、`Contract`、`MethodMetadata`、`RequestTemplate`、`RequestTemplateFactoryResolver`、`SynchronousMethodHandler`、`Target`、`Client`、`DefaultClient`、`ResponseHandler`、`InvocationContext`。✅
- 去掉代码块后正文仍成立：是。✅
- 叙述性正文字符数（不含代码块与空白行）：约 `15,xxx`。  
- 目标定位：OpenFeign baseline 第一篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 OpenFeign 从“声明式 HTTP 注解工具”提升到“client-side runtime spine”，讲清为什么 build-time 要先固化 metadata/template/handler，为什么 invoke-time 才做参数填充和目标注入，以及为什么 HTTP 返回后还要经过 response interpretation 才能真正交给业务代码。