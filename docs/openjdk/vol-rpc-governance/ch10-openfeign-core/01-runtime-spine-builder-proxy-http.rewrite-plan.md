# OpenFeign：runtime spine——从 Feign.builder() 到 HTTP 调用 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch10-openfeign-core`
- 篇：`01 runtime spine——从 Feign.builder() 到 HTTP 调用`
- 对应主题：`F-MAIN-1 OpenFeign Runtime Spine`
- 文章类型：新框架 baseline 主线篇
- 正文状态：未开始
- 基于版本：`OpenFeign 13.14-SNAPSHOT`

## 文章定位

- 核心困惑：对于第一次看 Feign 源码的人来说，最容易产生的错觉是：Feign 不就是“把注解解析一下，然后发个 HTTP 请求”吗？但真正的运行链比这复杂得多：`Feign.builder()` 组装一堆策略对象，`ReflectiveFeign` 解析接口方法并预生成 `MethodHandler`，每次方法调用再从 `MethodMetadata.template()` 克隆出 `RequestTemplate`，填入参数、套上 target、请求拦截器、retry 和 response 处理链，最后才交给 `Client.execute()`。读者真正困惑的是：哪些东西在 build 时就固定了，哪些又是在每次调用时才被填进去？
- 一句话顿悟：OpenFeign 的核心不是“注解解析器”，而是一条清晰的 client-side runtime spine：`Feign.builder()` 先把 Contract、Encoder、Decoder、Retryer、ErrorDecoder、InvocationHandlerFactory、Client 等策略组好；`ReflectiveFeign` 再把接口解析成 `MethodMetadata` 和 `MethodHandler`；运行时每次方法调用都先通过 `RequestTemplate.Factory` 从模板和参数造出最终 `Request`，最后由 `Client.execute()` 发 HTTP，再经 `ResponseHandler`/`InvocationContext` 决定解码、重试或错误。它是一个“接口 -> metadata -> template -> handler -> http” 的组装器，不是简单的注解工具。
- 文章边界：本篇重点讲 OpenFeign core 的主运行链：builder、ReflectiveFeign、MethodMetadata、RequestTemplate、MethodHandler、InvocationHandler、Client、ResponseHandler；不深入 Spring Cloud OpenFeign、SpringMvcContract，也不展开 Encoder/Decoder/Retryer/ErrorDecoder 的各自算法细节。

## 前置依赖

### HARD

- 无。作为 OpenFeign 第一篇，应独立建立读者的第一心智图。

### SOFT

- 读者知道 Java 动态代理、HTTP 请求和注解大致作用即可。

### NAV

- 后续可接：`Contract / MethodMetadata / RequestTemplate` 专题
- 后续可接：`Encoder / Decoder / ErrorDecoder / Retryer / Capability` 专题
- 后续可接：Spring Cloud OpenFeign 集成篇

## 一句话困惑

一个 Feign 接口是怎么从 `Feign.builder().target(...)` 变成一个真正能发 HTTP 的运行时对象的？哪些工作在 build 时完成，哪些工作每次调用时才发生？

## 一句话顿悟

OpenFeign 把一次声明式 HTTP 调用拆成两段：**build 时**把接口解析成 `MethodMetadata`、`RequestTemplate` 原型和 `MethodHandler` 映射，**invoke 时**再把实参填进模板、套上 target 和 interceptors、交给 `Client.execute()` 发出去，然后由 `ResponseHandler` 决定 decode/error/retry 结果。

## 读者理解路径

1. 先否定“Feign 就是注解解析 + 发请求”的粗糙理解。
2. 建立最小总图：builder -> ReflectiveFeign -> MethodMetadata -> MethodHandler -> RequestTemplate -> Client -> ResponseHandler。
3. 解释 `Feign.Builder` 组装了哪些策略，以及为什么它不是立即发请求。
4. 解释 `ReflectiveFeign.newInstance()` 如何把接口解析成 `Method -> MethodHandler` 映射和动态代理。
5. 解释 `MethodMetadata` 和 `RequestTemplate` 原型在 build 时固定了什么。
6. 解释 `RequestTemplate.Factory` 在每次调用时如何把 `argv` 变成最终 Request。
7. 解释 `Target.apply()` 的作用：为什么 base URL 注入是最后一步之一。
8. 解释 `Client.execute()` 与 `ResponseHandler` 的分工。
9. 收束到：OpenFeign 是 client-side runtime spine，不是单纯注解解析器。

## 失败方案推演

### 失败方案一：Feign 只是把注解解析成 URL，然后立刻发请求

- 这会漏掉 build-time 和 invoke-time 的明确分层。
- build 时真正固定的是 `MethodMetadata` 和 `MethodHandler`，不是最终 Request；每次调用时才用实参填模板。
- 所以注解解析只是开始，不是最终调用本身。

### 失败方案二：`target("https://api")` 只是一个 base URL 字符串

- 这会低估 `Target.apply()` 的角色。
- target 不是简单字符串，它是最后一层 request-shaping hook，可以注入 base URL，也可以继续追加 header/query 等信息。
- 所以 target 属于运行时对象，不只是常量。

### 失败方案三：`Client.execute()` 一返回，结果就直接给业务代码

- 这会漏掉 `ResponseHandler` 和 `InvocationContext`。
- 返回后还要决定：是 decode 成返回值、走 `ErrorDecoder`、触发 retry，还是直接返回原始 `Response`。
- 所以 HTTP 执行和业务返回值之间还有一层响应解释器。

## 必须澄清的误解

1. `ReflectiveFeign` 不负责真正发 HTTP，它只负责 build-time 代理组装。
2. `MethodMetadata.template()` 不是最终请求，只是请求模板原型。
3. `RequestTemplate` 在 build 时和 invoke 时是两种状态：先是原型，后是填充后的实际请求。
4. `Target` 不只是 base URL 常量，而是最后一层请求塑形器。
5. `ResponseHandler` 不是可选装饰，它是“HTTP 响应 -> 业务返回值/异常”的关键边界。

## 文章结构与字数预算

1. 困惑开场：Feign 为什么不是“注解 + 发请求”这么简单（800-1000 字）
2. 最小总图：builder / proxy / method handler / request / client / response（1000-1400 字）
3. `Feign.Builder`：先组策略，不发请求（1200-1800 字）
4. `ReflectiveFeign`：接口 -> `MethodHandler` 映射 -> 动态代理（1600-2200 字）
5. `MethodMetadata` / `RequestTemplate`：build-time 固定了什么（1600-2200 字）
6. 每次调用：`RequestTemplate.Factory` / `Target` / `Client.execute()`（1800-2400 字）
7. `ResponseHandler`：返回值、错误、重试的边界（1400-1800 字）
8. 收网总结（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `core/src/main/java/feign/Feign.java:36` — `Feign.builder()`
- `Feign.java:212` — `Builder.target(...)`
- `Feign.java:218` — `internalBuild()`
- `Feign.java:228` — 组装 `ResponseHandler`
- `Feign.java:240` — 返回 `ReflectiveFeign`
- `core/src/main/java/feign/ReflectiveFeign.java:50` — `newInstance()`
- `ReflectiveFeign.java:58` — parse metadata / create handlers
- `ReflectiveFeign.java:63` — dynamic proxy 创建
- `core/src/main/java/feign/Contract.java:49` — parseAndValidateMetadata
- `Contract.java:92` — `MethodMetadata` 创建
- `core/src/main/java/feign/MethodMetadata.java:37` — method metadata state
- `MethodMetadata.java:146` — template 原型
- `core/src/main/java/feign/RequestTemplate.java:53` — RequestTemplate 定位
- `RequestTemplate.java:447` — target(base URL) 注入
- `RequestTemplate.java:500` — uri(relative path)
- `core/src/main/java/feign/RequestTemplateFactoryResolver.java:40` — 选择模板工厂
- `RequestTemplateFactoryResolver.java:85` — 从 metadata.template() 克隆原型
- `RequestTemplateFactoryResolver.java:107` — 解析 argv / resolve
- `core/src/main/java/feign/SynchronousMethodHandler.java:49` — invoke
- `SynchronousMethodHandler.java:71` — retry loop
- `SynchronousMethodHandler.java:147` — `targetRequest(...)`
- `SynchronousMethodHandler.java:119` — `client.execute()`
- `core/src/main/java/feign/Target.java:97` — `HardCodedTarget.apply()`
- `core/src/main/java/feign/Client.java:32` — Client SPI
- `core/src/main/java/feign/DefaultClient.java:88` — execute
- `core/src/main/java/feign/ResponseHandler.java:65` — response handling
- `core/src/main/java/feign/InvocationContext.java:69` — proceed / decode / error path
- `core/src/main/java/feign/DefaultInvocationHandlerFactory.java:25` — invocation handler factory

## 测试证据清单

- `FeignBuilderTest.java:52`
- `FeignBuilderTest.java:255`
- `FeignBuilderTest.java:274`
- `FeignBuilderTest.java:313`
- `FeignTest.java:122`
- `FeignTest.java:405`
- `FeignTest.java:547`
- `FeignTest.java:768`
- `FeignTest.java:1119`
- `RequestTemplateTest.java:106`
- `RequestTemplateTest.java:348`
- `RequestTemplateTest.java:460`

## 版本边界

- 当前分析对象固定为 `OpenFeign 13.14-SNAPSHOT`。
- 本篇只讲 OpenFeign core，不混入 Spring Cloud OpenFeign。
- 暂不展开具体 Encoder/Decoder/Retryer/ErrorDecoder/Capability 算法，只标记它们在主链上的位置。

## 与其他篇的边界

### 本篇要讲清

- `Feign.builder().target(...)` 到 HTTP 请求发出的完整运行链。
- build-time 与 invoke-time 的清晰分层。
- `MethodMetadata` / `RequestTemplate` / `MethodHandler` / `Client` / `ResponseHandler` 的边界。

### 本篇不深讲

- 具体注解规则和 Contract 细节。
- 具体 Encoder/Decoder/Retryer/ErrorDecoder 实现。
- Spring Cloud OpenFeign bean lifecycle / named context / loadbalancer / circuit breaker。

## 写作后检查

- [ ] 开篇先抓“为什么不是注解解析后立刻发请求”，而不是直接讲 builder。
- [ ] 至少展开 3 个失败方案，且包含“target 只是 base URL”“HTTP 返回即业务返回”。
- [ ] 明确给出 build-time 与 invoke-time 总图。
- [ ] 不把本文写成 Feign 类清单。
- [ ] 每个阶段先讲职责，再给 file:line。
- [ ] 删除代码块后，读者仍能复述 `builder -> proxy -> handler -> client.execute()` 主链。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。