# OpenFeign：Client、Codec、Retry、ErrorDecoder 与 Capability 扩展层

> 基于 OpenFeign 13.14-SNAPSHOT

## 一、困惑开场：这些扩展点为什么不是一排平行插件

前两篇已经把 OpenFeign 的主线打通了：接口经过 Contract 变成 metadata 和 template，动态 proxy 找到 MethodHandler，调用期再构造 Request，最后交给 Client 发 HTTP。

但真正使用 Feign 时，你还会遇到一排扩展点：

- `Client`
- `Encoder`
- `Decoder`
- `Retryer`
- `ErrorDecoder`
- `RequestInterceptor`
- `ResponseInterceptor`
- `MethodInterceptor`
- `Capability`

它们看起来都像“可插拔组件”，但实际粒度完全不同：有的每个 client 一份，有的每次 attempt 执行，有的每次逻辑调用 clone，有的在 build 阶段装饰整套运行链。

如果把它们放进一张平行插件表里，读者会马上迷路。真正应该问的是：**每个扩展点包住了运行链的哪一段，在哪个时机执行，重试时会不会再次执行。**

## 二、前情回顾：前面讲了主链和蓝图，这一篇讲可插拔执行层

第一篇讲的是 OpenFeign runtime spine：`builder -> proxy -> MethodHandler -> Client.execute() -> ResponseHandler`。

第二篇讲的是 build-time blueprint：Contract 把接口压成 `MethodMetadata` 和 `RequestTemplate` 原型，invoke-time 只负责填参数。

这一篇接在两篇之后：既不再讲“代理怎么造”，也不再讲“注解怎么解析”，而是把运行链里的可插拔执行边界拆出来：请求怎么编码，HTTP 谁执行，响应谁解码，错误谁解释，retry 谁决定，Capability 又怎样在 build 阶段把这些组件重新装饰。

这里的视角切换是：前两篇回答“结构挂在哪里”，这一篇回答“每个扩展以什么粒度运行”。同一个 client-side runtime 上，可能同时存在 per-client、per-invocation、per-attempt 和 build-time 四种不同生命周期。

## 三、先走三条失败的路

### 失败方案一：所有扩展点都是平行策略，只是名字不同

这会把 `Client`、`Encoder`、`Retryer`、`Capability` 当成同一种 plugin。

但它们的时机完全不同：

- Encoder 在请求模板构造阶段  
- Client 在真正 HTTP attempt 阶段  
- Decoder/ErrorDecoder 在响应解释阶段  
- Retryer 在 `RetryableException` 产生之后  
- Capability 在 build 阶段装饰其他组件

所以扩展点不能只按“接口列表”理解，必须按它们包住的运行链位置理解。

### 失败方案二：Retryer 自己判断 HTTP status

Retryer 并不直接读取 HTTP response。它接收到的是 `RetryableException`，只决定继续、等待多久，或者把异常继续抛出去。

HTTP status 是否应该转成 `RetryableException`，通常由 ErrorDecoder 决定。

所以 ErrorDecoder 和 Retryer 是前后相接的控制流，不是两个独立的 retry 开关。

### 失败方案三：Capability 只是换一个 Client

Capability 可以同时装饰 Client、Encoder、Decoder、Retryer、Interceptor、InvocationHandlerFactory 等多个组件。

它的职责不是“提供一个替代实现”，而是“在 builder 组装阶段接收已有组件，返回被装饰后的组件”。

所以 Capability 是构建期装饰协议，不是普通单一策略接口。

## 四、最小总图：请求侧、响应侧、Retry、Build Decoration

```text
请求侧
MethodHandler
  → Encoder
  → RequestInterceptor
  → Target
  → Client.execute()

响应侧
Client.execute()
  → ResponseInterceptor
  → Decoder / ErrorDecoder

Retry 控制流
ErrorDecoder / Client / Decoder
  → RetryableException
  → Retryer.continueOrPropagate()
  → 重新执行 executeAndDecode()

构建期装饰
Capability
  → enrich(Client / Encoder / Decoder / Retryer / Interceptor / HandlerFactory)
```

这张图里最关键的不是组件名称，而是执行粒度：

- build-time：Capability 装饰整个运行对象  
- per-invocation：Retryer clone、MethodInterceptor 包装逻辑调用  
- per-attempt：RequestInterceptor、Client、ResponseInterceptor、Decoder、ErrorDecoder  

这里提前钉死一个容易混淆的差异：`Encoder` 通常发生在逻辑调用构造 RequestTemplate 的阶段，而 `RequestInterceptor`、`Client`、Response 处理链位于 retry loop 内。也就是说，请求侧扩展并不是一个统一的“每次重试都重跑”集合。

## 五、请求侧：Client、Encoder 与 RequestInterceptor

### 5.1 Client：最后一跳 HTTP 边界

`Client` 的接口非常窄：接收一个已经构造完成的 `Request`，返回一个 `Response`。

`Client.java:32` — Client SPI

它不关心：

- Feign Contract
- proxy
- MethodMetadata
- 参数如何绑定
- response 如何 decode

它只关心 HTTP I/O。默认 `DefaultClient` 使用 `HttpURLConnection`，负责写 headers/body、设置 timeout、执行连接并构造 Response。

`DefaultClient.java:88` — execute
`DefaultClient.java:146` — connection/body
`DefaultClient.java:194` — response conversion

`Client` 通常是 per-client 组件，但每个实际 HTTP attempt 都会执行一次；发生 retry 时，它会再次执行。

### 5.2 Encoder：请求构造阶段的编码器

`Encoder` 接口不是返回 byte[]，而是接收对象、类型和 `RequestTemplate`，直接修改模板。

`Encoder.java:69` — Encoder contract

它位于：

```text
方法参数
  → RequestTemplate.Factory
  → Encoder.encode(...)
  → RequestTemplate body
  → RequestInterceptor
  → Target
  → Client
```

Encoder 是 per-client 配置，但实际在每次调用构造 request template 时执行。它不是底层 HTTP attempt 本身。

因此它和 RequestInterceptor 的 retry 粒度不同：Encoder 更靠前，负责把这次调用的 body 写进模板；RequestInterceptor 在 `executeAndDecode()` 内，每次底层 attempt 都会重新执行。这个差异意味着动态签名可以随 attempt 重算，但 body 编码通常不会因为每次 retry 都重新走一遍。

### 5.3 RequestInterceptor：每个 attempt 都可能重新执行

`RequestInterceptor.apply(RequestTemplate)` 是请求拦截器的入口。

`RequestInterceptor.java:52` — apply
`SynchronousMethodHandler.java:147` — interceptor / Target 顺序

它常用于：

- authentication header
- trace id
- tenant header
- dynamic signature

关键粒度是：**它在 `executeAndDecode()` 内部，而 `executeAndDecode()` 在 retry loop 内。** 所以同一个逻辑调用发生 retry 时，RequestInterceptor 会再次执行。

这既是能力，也是风险：如果拦截器有副作用，或者签名逻辑依赖时间戳，就必须明确它是 per-attempt 行为。

## 六、响应侧：ResponseInterceptor、Decoder 与 ErrorDecoder

### 6.1 ResponseInterceptor 包住响应解释链

ResponseHandler 会把 Response 交给 ResponseInterceptor 链，链的末端才是 `InvocationContext.proceed()`。

`ResponseHandler.java:65` — response interceptor chain
`ResponseInterceptor.java:48` — default chain

这意味着 ResponseInterceptor 可以：

- 在 Decoder 前检查或修改 response
- 调用 `chain.next()` 后观察解码结果
- 直接短路，不继续 Decoder

它不是 Decoder 的别名，而是包裹响应解释过程的一层。

### 6.2 Decoder 处理成功响应

`InvocationContext.proceed()` 会先判断 HTTP 状态：

- 2xx 进入 Decoder
- 404 只有 `dismiss404` 且返回类型非 void 时特殊处理
- `Response.class` 直接返回原始 response
- void 返回类型不需要常规 decode

`InvocationContext.java:69` — status / return type 判断
`InvocationContext.java:79` — success / 404 / void 分支
`InvocationContext.java:119` — Decoder 路径

所以 Decoder 是 per-client 策略，但在每个成功响应 attempt 上执行。

### 6.3 ErrorDecoder 处理非 2xx

非 2xx response 进入 `ErrorDecoder.decode(methodKey, response)`。

`ErrorDecoder.java:46` — ErrorDecoder contract
`InvocationContext.java:131` — error decode

ErrorDecoder 的职责是把协议错误转成应用异常。它还可以把某些错误转成 `RetryableException`，把控制权交给 Retryer。

它不负责：

- sleep
- 重试次数
- backoff
- 最终是否继续

## 七、Retryer 与 RetryableException：谁决定是否再来一次

### 7.1 Retryer 是 per-invocation clone

`Retryer` 的接口只有两个核心方法：

- `continueOrPropagate(RetryableException e)`
- `clone()`

`Retryer.java:22` — Retryer contract

Feign 不会把一个 Retryer 状态对象跨多个业务调用共享，而是在每次逻辑调用开始时 clone 一个。

### 7.2 Retry loop 包住什么

`SynchronousMethodHandler.runWithRetry()` 的结构是：

```text
clone Retryer
  ↓
executeAndDecode()
  ↓
catch RetryableException
  ↓
Retryer.continueOrPropagate()
  ↓
继续或抛出
```

`SynchronousMethodHandler.java:68` — retry loop
`SynchronousMethodHandler.java:72` — RetryableException catch

而 `executeAndDecode()` 内部包含：

- Request 构造
- RequestInterceptor
- Target
- Client.execute
- ResponseHandler
- ResponseInterceptor
- Decoder / ErrorDecoder

因此 Retryer 包住的不是纯网络执行，而是完整的 execute + response interpretation。

### 7.3 ErrorDecoder 如何把错误转成 retry signal

典型流程是：

```text
Client 返回 503
  ↓
InvocationContext.proceed()
  ↓
ErrorDecoder.decode()
  ↓
RetryableException
  ↓
Retryer.continueOrPropagate()
```

`RetryableException` 是控制流信号，不只是普通异常。`Retry-After` 也只是给 retryer 提供等待建议，不能直接等价于“一定重试”。

`RetryableException.java:23` — retryable signal
`ErrorDecoder.java:93` — Retry-After

### 7.4 网络 IOException 不一定自动重试

`Client.execute()` 的 IOException 在同步处理器中会被包装成 Feign 执行异常；只有最终形成 `RetryableException`，才会进入当前 retry catch 分支。

所以不要简单说“网络异常 Feign 自动重试”。是否重试，取决于异常是否进入 RetryableException 控制流，以及 Retryer 如何处理。

### 7.5 默认 Retryer 与 NEVER_RETRY

`Retryer.NEVER_RETRY` 会直接传播异常，不进行等待和重试。

`Retryer.java:46` — NEVER_RETRY

默认实现则可以按照指数退避、最大尝试次数和 Retry-After 进行控制。

## 八、Capability：为什么它不是普通策略接口

### 8.1 Strategy 与 Capability 的区别

普通策略接口通常意味着：

```text
选择一个 Client
选择一个 Encoder
选择一个 Decoder
选择一个 Retryer
```

Capability 的意思则是：

```text
拿到已有 Client
  ↓
返回装饰后的 Client
```

`Capability.java:27` — decorator contract

### 8.2 一个 Capability 可以装饰多个组件

Capability 提供多个 `enrich(...)` 重载，可以装饰：

- Client
- AsyncClient
- Encoder
- Decoder
- Retryer
- RequestInterceptor
- ResponseInterceptor
- InvocationHandlerFactory

`Capability.java:76` — Client enrich
`Capability.java:116` — Encoder enrich
`Capability.java:120` — Decoder enrich
`Capability.java:128` — InvocationHandlerFactory enrich

例如 Micrometer Capability 可以同时包裹 Client、Encoder、Decoder 和 InvocationHandlerFactory，而不是只替换一个 Client。

### 8.3 Capability 在 build 阶段生效

Builder 的 enrichment 流程大致是：

1. clone builder
2. 遍历需要 enrichment 的字段
3. 按顺序应用 capability
4. 装饰 interceptor 元素和列表
5. `internalBuild()`

`BaseBuilder.java:264` — clone/enrich
`BaseBuilder.java:302` — fields/interceptors enrichment
`BaseBuilder.java:385` — enrich().internalBuild()

这样做的好处是：

- 不修改用户原始 builder
- 同一个 builder 多次 build 不会重复污染
- Capability 组合顺序可控

### 8.4 Capability 顺序本身有语义

如果先应用 capability A，再应用 capability B，最终可能是：

```text
B(A(original))
```

后来的 capability 包住前面的 capability。这个顺序会影响 metrics、cache、logging 和 error handling 的观测边界。

`Capability.java:38` — capability order
`CapabilityTest.java:25` — 装饰顺序测试

## 九、扩展点的粒度总表

| 扩展点 | 配置粒度 | 运行时粒度 | retry 时行为 |
|---|---|---|---|
| `Client` | per-client | per-attempt | 再执行 |
| `Encoder` | per-client | 请求构造阶段 | 通常不重新编码 |
| `Decoder` | per-client | per-response attempt | 可再次执行 |
| `ErrorDecoder` | per-client | 每个错误响应 attempt | 可产生 RetryableException |
| `Retryer` | per-client 原型 | per-invocation clone | 每次 retryable failure 调用 |
| `RequestInterceptor` | per-client 列表 | per-request / per-attempt | 再执行 |
| `ResponseInterceptor` | per-client 链 | per-response attempt | 再执行 |
| `Capability` | per-builder | build-time decorator | 不直接参与 retry |

这张表的核心不是记参数，而是建立时序：

- `Encoder` 更靠前  
- `Client` 在中间  
- `Decoder/ErrorDecoder` 在后面  
- `Retryer` 包住整个 attempt 解释过程  
- Capability 在更早的 build 阶段改写组件

## 十、误解澄清

### 误解一：Retryer 自己判断 HTTP status

不是。ErrorDecoder 通常负责把非 2xx 转成异常，Retryer 只处理 `RetryableException` 的继续/传播。

### 误解二：RequestInterceptor 每个逻辑调用只执行一次

不是。它在 retry loop 内，因此每次 attempt 都可能重新执行。

### 误解三：Encoder retry 时一定重新执行

通常不是。Encoder 属于 request template 构造阶段，而 retry 复用已经构造的调用上下文。RequestInterceptor、Target 和 Client 则会随 attempt 再执行。

### 误解四：Capability 只是换一个 Client

不是。它可以装饰多个 runtime component，是 build-time 的多目标装饰协议。

### 误解五：ResponseInterceptor 在 Decoder 之后

不准确。它包住 Decoder，但入口发生在 Decoder 前；它既可以观察解码前 response，也可以通过 `chain.next()` 包住后续 decode。

### 误解六：出现 `RetryableException` 就一定会重试

不一定。`RetryableException` 只是把控制流交给 Retryer；`NEVER_RETRY`、最大次数、退避策略或自定义 Retryer 都可能立即把它继续抛出。真正的语义是“具备进入重试裁决的资格”，不是“已经决定重试”。

### 误解七：Capability 是每次调用时临时插入的 wrapper

不是。Capability 在 build 阶段 clone builder 并装饰 runtime components，之后每次调用只是使用已经装饰好的对象。它不是 per-attempt 插件。

## 十一、收网总结：扩展点的关键是插入位置和执行粒度

回到开头的问题：为什么 OpenFeign 这些扩展点不能放进一张平行插件表？

因为它们分别站在不同的运行链边界：

- `Encoder` 负责请求构造  
- `RequestInterceptor` 负责每次 attempt 的模板修改  
- `Client` 负责 HTTP I/O  
- `ResponseInterceptor` 负责包响应解释  
- `Decoder/ErrorDecoder` 负责成功值和异常  
- `Retryer` 负责控制 RetryableException 是否继续  
- `Capability` 负责 build-time 装饰整套组件

**三句话总结：**

1. OpenFeign 扩展点不是一排平行插件，而是分布在请求、HTTP、响应、retry 和 build decoration 不同边界上的执行协议。
2. `ErrorDecoder` 产生可重试信号，`Retryer` 决定是否继续；`RequestInterceptor` 和 Client 则会在每次 attempt 重新执行。
3. `Capability` 不是普通策略替换器，而是构建阶段装饰多个 runtime component 的组合机制。

**下篇预告：** 下一篇进入 Spring Cloud OpenFeign，讲 `@FeignClient`、registrar、factory bean、named context 和 Spring Contract 如何把 OpenFeign core 装进 Spring。