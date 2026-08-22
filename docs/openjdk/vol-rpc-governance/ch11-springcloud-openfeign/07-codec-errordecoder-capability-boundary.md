# Spring Cloud OpenFeign：Codec、ErrorDecoder 与 Capability 边界

> 基于 Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1

## 一、困惑开场：这些 decoder 到底谁是谁

写到 Spring Cloud OpenFeign 这一段，读者最容易被一串类名拖进雾里：

- `SpringEncoder`
- `SpringDecoder`
- `ResponseEntityDecoder`
- `OptionalDecoder`
- `ErrorDecoder`
- `FeignErrorDecoderFactory`
- `Capability`

最常见的混乱不是"它们怎么用"，而是更基础的一层：

- 哪些类是 Spring Cloud OpenFeign 提供的
- 哪些类是 OpenFeign core 提供的
- `ResponseEntityDecoder` 到底是不是实际做 JSON 解码的那个类
- Spring Cloud 到底有没有自己的默认 `ErrorDecoder`
- `Capability` 会不会把 codec 的活又做一遍

如果这些边界不先排清，后面越写越容易把 Spring Cloud 的装配职责和 OpenFeign core 的 SPI/runtime 职责揉成一团。

这篇的核心问题只有一个：**Spring Cloud OpenFeign 到底给 Feign 的 codec / error-decoder 链补了什么，而哪些东西仍然属于 OpenFeign core。**

## 二、前情回顾：前几篇讲的是 client、invocation、capability，这一篇讲的是 codec 与 error 语义的边界

前面几篇已经拆出了几条主线：

- LoadBalancer：`Client` replacement
- CircuitBreaker：Builder / Targeter / InvocationHandler
- Micrometer：`Capability -> BaseBuilder.enrich()`
- Timeout / Retry：`Request.Options` 与 `Retryer`

这一篇要收的是另一块边界：Spring Cloud OpenFeign 负责把 Spring 世界的消息转换器和 `ResponseEntity` 语义接进 Feign 的 `Encoder` / `Decoder` 槽位；OpenFeign core 负责定义这些 SPI、自带默认兜底、并在 builder 构建期和 runtime 执行期真正消费它们。

所以这篇最重要的层级区分是：

- Spring Cloud：装配 Spring-aware encoder / decoder / error decoder 选择
- OpenFeign core：定义 SPI、默认 fallback、能力增强与 runtime 消费

## 三、先走三条失败的路

### 失败方案一：`OptionalDecoder`、`ResponseEntityDecoder`、`SpringDecoder` 都是 Spring Cloud 造的一整套 decoder

这是一种很容易出现的错觉，因为默认 decoder 链是在 Spring Cloud 的配置里拼出来的。

但链条里的类并不都属于 Spring Cloud：

- `OptionalDecoder` 属于 OpenFeign core
- `ResponseEntityDecoder` 属于 Spring Cloud
- `SpringDecoder` 属于 Spring Cloud

所以默认 decoder 栈不是 Spring Cloud 单独造的一整套，而是**Spring Cloud 把 OpenFeign core 的 `OptionalDecoder` 和自己的 Spring 适配 decoder 拼到一起**。

`FeignClientsConfiguration.java:104` 是默认 decoder bean 装配入口。  
OpenFeign `feign/optionals/OptionalDecoder.java:27` 说明 `OptionalDecoder` 属于 core。  
OpenFeign `feign/optionals/OptionalDecoder.java:30` 说明它本身只是包裹一个 delegate decoder。  

### 失败方案二：`ResponseEntityDecoder` 就是真正做 JSON / XML 解码的主 decoder

它名字里有 decoder，很容易让人以为它就是最终的 body 反序列化执行者。

但它的职责其实更窄：它只识别 `HttpEntity` / `ResponseEntity` 这种 Spring 容器类型，然后把真正的 body 解码委托给下层 decoder，最后再把状态码和 headers 重新包回 `ResponseEntity`。

真正把响应体交给 Spring `HttpMessageConverter` 去解析的，是 `SpringDecoder`。

`ResponseEntityDecoder.java:50` 是包装路径。  
`SpringDecoder.java:64` 是 `HttpMessageConverterExtractor` 进入点。  

### 失败方案三：Spring Cloud OpenFeign 自带一个默认 `ErrorDecoder` bean

很多人会顺手这样理解：既然它对 encoder / decoder 都做了 Spring 适配，那错误解码应该也有一套默认 Spring bean。

但事实恰好不是这样。

Spring Cloud 在 `FeignClientsConfiguration` 里并没有提供默认 `ErrorDecoder` bean。`FeignClientFactoryBean` 只会按顺序尝试：

1. 找 `ErrorDecoder` bean
2. 找 `FeignErrorDecoderFactory`
3. 再不行，就什么都不做

如果它什么都没做，最后留下来的就是 OpenFeign core `BaseBuilder` 自带的 `DefaultErrorDecoder`。

`FeignClientFactoryBean.java:201` 是 `ErrorDecoder` bean 检查。  
`FeignClientFactoryBean.java:206` 是 `FeignErrorDecoderFactory` 检查。  
OpenFeign `feign/BaseBuilder.java:55` 是 core 默认 `DefaultErrorDecoder`。  

## 四、最小总图：Spring Cloud 拼 bean 图，Feign builder 接收 SPI 实例

```text
FeignClientsConfiguration
    ├─ Encoder: SpringEncoder / PageableSpringEncoder
    ├─ Decoder: OptionalDecoder(ResponseEntityDecoder(SpringDecoder))
    └─ (no default ErrorDecoder bean)
    ↓
FeignClientFactoryBean
    ├─ builder.encoder(encoder)
    ├─ builder.decoder(decoder)
    ├─ builder.errorDecoder(errorDecoder?)
    └─ builder.addCapability(capability...)
    ↓
OpenFeign BaseBuilder / Feign.Builder
    ├─ 保存 SPI 实例
    ├─ enrich() 让 capability 后置装饰
    └─ build() 后进入 runtime
```

这张图里最关键的不是"有哪些类"，而是两件事：

1. Spring Cloud 负责把 Spring-aware bean 图拼好
2. OpenFeign core 负责提供 SPI 槽位、默认兜底和后续运行时消费

`FeignClientFactoryBean.java:140` 说明 builder 起手就会把 logger / encoder / decoder / contract 从 context 里拿出来。  
OpenFeign `feign/BaseBuilder.java:47`、`feign/BaseBuilder.java:50`、`feign/BaseBuilder.java:51`、`feign/BaseBuilder.java:55` 说明 contract、encoder、decoder、errorDecoder 这些 SPI 槽位本来就属于 Feign core builder，并且自带 core 默认值。  
OpenFeign `feign/BaseBuilder.java:82`、`feign/BaseBuilder.java:92`、`feign/BaseBuilder.java:97` 说明 builder 只是把选好的 SPI 实例塞进对应槽位。  

## 五、默认 decoder 栈：`OptionalDecoder(ResponseEntityDecoder(SpringDecoder))`

### 5.1 谁在最外层

Spring Cloud 提供的默认 decoder bean 是：

`OptionalDecoder(new ResponseEntityDecoder(new SpringDecoder(...)))`

也就是说，从外到内的层次是：

1. `OptionalDecoder`
2. `ResponseEntityDecoder`
3. `SpringDecoder`

`FeignClientsConfiguration.java:104` 是完整装配入口。  

### 5.2 `OptionalDecoder` 做什么

`OptionalDecoder` 属于 OpenFeign core。它只负责一个非常明确的语义：当返回类型是 `Optional<T>` 时，处理 `Optional` 的外壳。

它尤其处理两类边界：

- `404`
- `204`

在这些情况下，它会返回 `Optional.empty()`；否则就把内部泛型类型交给下层 decoder 去真正解码。

OpenFeign `feign/optionals/OptionalDecoder.java:36` 说明它先判断是否为 `Optional` 返回值。  
OpenFeign `feign/optionals/OptionalDecoder.java:40`、`feign/optionals/OptionalDecoder.java:43` 说明 `404` / `204` 返回 `Optional.empty()`，其他情况再把内部类型交给 delegate。  

所以 `OptionalDecoder` 不是 Spring 的消息转换器适配器，而是 Feign core 对 Java `Optional` 返回值语义的一个 wrapper。

### 5.3 `ResponseEntityDecoder` 做什么

`ResponseEntityDecoder` 是 Spring Cloud 的一层适配器。它先看目标返回类型是不是 `HttpEntity` / `ResponseEntity`；如果不是，就直接委托；如果是，就取出泛型 body 类型，把 body 解出来，再重新组装 Spring `ResponseEntity`。

所以它处理的是：

- Spring 风格的容器返回类型
- 响应头和状态码如何保留

它不直接负责 JSON、XML、表单、字节流这些 body 的实际解码。

`ResponseEntityDecoder.java:41` 是类型识别入口。  
`ResponseEntityDecoder.java:50` 是委托 body decode 后重组 `ResponseEntity` 的路径。  

### 5.4 `SpringDecoder` 做什么

真正把响应体交给 Spring `HttpMessageConverter` 系统去做反序列化的，是 `SpringDecoder`。

它会把 Feign 的 `Response` 适配成 Spring 侧可消费的响应对象，再用 `HttpMessageConverterExtractor` 去按目标类型提取结果。

所以如果你问"真正做 JSON/XML body decode 的是谁"，答案是 `SpringDecoder`，不是 `ResponseEntityDecoder`。

`SpringDecoder.java:64` 是 `HttpMessageConverterExtractor` 的核心入口。  

### 5.5 为什么这个顺序不能反过来

这个顺序本身就在表达职责分层：

- 最外层 `OptionalDecoder` 先处理 Java 语义容器 `Optional`
- 中间层 `ResponseEntityDecoder` 再处理 Spring 语义容器 `ResponseEntity`
- 最内层 `SpringDecoder` 最后处理消息体本身

如果把这三层混成一层去理解，就会既看不清谁在解包容器，谁在解 body，也看不清哪一层属于 Spring Cloud，哪一层属于 Feign core。

## 六、默认 encoder 栈：`SpringEncoder`，必要时再包 `PageableSpringEncoder`

### 6.1 默认路径

默认 encoder bean 是 `SpringEncoder`。如果 classpath 上存在 Spring Data `Pageable` 相关条件，Spring Cloud 会再用 `PageableSpringEncoder` 包一层。

`FeignClientsConfiguration.java:109` 是默认 encoder bean。  
`FeignClientsConfiguration.java:121` 是 `PageableSpringEncoder` 包装路径。  

### 6.2 `SpringEncoder` 的职责

`SpringEncoder` 的核心职责是：把 Feign 请求体编码这件事接到 Spring `HttpMessageConverter` 体系上。

但它内部也不是一刀切。它会先判断是不是表单 / multipart 等特殊分支；如果是，就走 form encoder；否则才走消息转换器路径。

`SpringEncoder.java:107` 是 form / message converter 分叉。  
`SpringEncoder.java:173` 是消息转换器编码路径。  

所以 `SpringEncoder` 做的是 Spring 消息转换体系接入，不是重新定义 Feign 的 `Encoder` SPI。SPI 本身还是 OpenFeign core 的。

## 七、`ErrorDecoder` 选择优先级：bean → factory → property 顺序叠加后再落到 core default

### 7.1 第一层：直接 `ErrorDecoder` bean

`FeignClientFactoryBean` 会先找上下文里的 `ErrorDecoder` bean。如果找到了，就直接 `builder.errorDecoder(errorDecoder)`。

`FeignClientFactoryBean.java:201` 是第一优先级。  

### 7.2 第二层：`FeignErrorDecoderFactory`

如果没找到 `ErrorDecoder` bean，Spring Cloud 才会看有没有 `FeignErrorDecoderFactory`。如果有，就调用 `create(type)`，给当前 Feign 接口类型产出一个 decoder。

这一步是 Spring Cloud 额外补出来的按-client factory hook，OpenFeign core 本身没有这层 abstraction。

`FeignClientFactoryBean.java:206` 是 factory 路径。  
`FeignErrorDecoderFactory.java:26` 是 factory SPI 定义。  

### 7.3 第三层：property override

除了 bean/factory 路径，Spring Cloud 还允许通过 properties 指定 `errorDecoder` 类。它会把这个类实例化后再 `builder.errorDecoder(...)`。

这里要注意一件事：它不是独立于 bean 配置系统之外的终极路径，它仍然受 `defaultToProperties` 顺序影响。

`FeignClientProperties.java:141` 是 property 模型。  
`FeignClientFactoryBean.java:294` 是 property 应用路径。  
`FeignClientFactoryBean.java:173` 是 properties 与 bean 先后顺序的总开关。  

### 7.4 最终兜底：OpenFeign core `DefaultErrorDecoder`

如果 Spring Cloud 这一侧：

- 没有 `ErrorDecoder` bean
- 没有 `FeignErrorDecoderFactory`
- properties 里也没有指定 `errorDecoder`

那么 Spring Cloud 不会再补一个默认 bean。builder 里保留下来的，就是 OpenFeign core `BaseBuilder` 默认字段里的 `DefaultErrorDecoder`。

OpenFeign `feign/BaseBuilder.java:55` 是默认兜底。  
OpenFeign `feign/Feign.java:218`、`feign/Feign.java:222`、`feign/Feign.java:223` 说明 build 时会把 decoder 与 errorDecoder 一起塞进 `ResponseHandler`。  
OpenFeign `feign/Feign.java:228`、`feign/Feign.java:238`、`feign/Feign.java:239` 说明这些对象之后再和 client、retryer、request template factory、options 一起进入真正的 method handler factory。  

## 八、`Capability` 在这里的位置：后置装饰层，不重复 codec 主装配职责

### 8.1 为什么它不等于 codec 装配器

看到 `Capability` 可以 enrich `Encoder`、`Decoder`、`ErrorDecoder`，很容易以为它和 `FeignClientsConfiguration` 在做同一类事。

但两者所处时机完全不同。

Spring Cloud 的 codec 装配发生在：

- 先选出哪个 encoder/decoder/error decoder bean 进入 builder

`Capability` 的发生时机是：

- builder 已经拿到这些对象之后
- 在 `build()` 前的 `enrich()` 阶段，再决定是否对这些对象做后置装饰

OpenFeign `feign/Capability.java:36` 是 capability SPI。  
OpenFeign `feign/BaseBuilder.java:265` 是 `enrich()` 入口。  

### 8.2 它和 codec 主装配的关系

所以关系应该这样理解：

- Spring Cloud 先决定"装谁"
- Capability 再决定"要不要在这个基础上再包一层"

这就是为什么 Micrometer 这种能力不会取代 `SpringDecoder` / `SpringEncoder` 本身。它只是可能在这些已经选好的组件外面再做观测、缓存或其他横切增强。

### 8.3 为什么这点对收束篇重要

因为一旦把 `Capability` 当成"另一套 codec 装配器"，你就会把：

- Spring Cloud 的 bean 图装配职责
- OpenFeign core 的 SPI/enrich 职责

重新揉回一起。

而这一篇的目标，恰恰就是把这两层重新切开。

## 九、最终边界：Spring Cloud 负责把 Spring 世界接进来，OpenFeign core 负责定义和消费 SPI

把整条线压缩后，边界就很清楚了。

### 9.1 Spring Cloud OpenFeign 做的事

- 提供 `SpringEncoder`
- 提供 `SpringDecoder`
- 提供 `ResponseEntityDecoder`
- 在需要时提供 `PageableSpringEncoder`
- 在 `FeignClientsConfiguration` 中拼默认 encoder/decoder 栈
- 在 `FeignClientFactoryBean` 中按 client 选择 `ErrorDecoder` bean / factory / property override

### 9.2 OpenFeign core 做的事

- 定义 `Encoder` / `Decoder` / `ErrorDecoder` / `Capability` SPI
- 提供 `OptionalDecoder`
- 提供 builder 槽位与默认 `DefaultErrorDecoder`
- 在 `build()` 时执行 `enrich()`
- 在 runtime 中真正消费 decoder / errorDecoder

### 9.3 为什么这就是 Spring Cloud OpenFeign 章节的收束点

因为到这里，Spring Cloud 这边最核心的工作已经全讲完了：

- client 怎么造
- builder 怎么装
- load balancer 怎么挂
- circuit breaker 怎么挂
- capability 怎么挂
- options / retryer 怎么挂
- spring-aware codec / error decoder 怎么挂

再往后如果继续深挖，就更像是在回到 OpenFeign core runtime 本身，而不是继续讲 Spring Cloud OpenFeign 的集成边界。

## 十、误解澄清

### 误解一：`OptionalDecoder` 是 Spring Cloud 类

不是。它是 OpenFeign core 类，Spring Cloud 只是把它装到默认 decoder 栈最外层。

### 误解二：`ResponseEntityDecoder` 就是实际 body decoder

不是。它处理的是 `ResponseEntity` 语义，真正做 body 反序列化的是 `SpringDecoder`。

### 误解三：Spring Cloud 提供默认 `ErrorDecoder` bean

不是。Spring Cloud 提供的是选择逻辑，不是默认 `ErrorDecoder` bean；兜底仍是 OpenFeign core `DefaultErrorDecoder`。

### 误解四：`FeignErrorDecoderFactory` 是 OpenFeign core SPI

不是。它是 Spring Cloud 额外补出来的按-client factory hook。

### 误解五：`Capability` 会取代 codec 装配职责

不是。它发生在 builder 后置 enrich 阶段，是装配后的横切装饰层。

## 十一、收网总结：Spring Cloud 在拼 bean 图，OpenFeign core 在定义并消费 SPI

回到开头的问题：这些 encoder / decoder / error decoder / capability 到底谁是谁？

答案是：Spring Cloud OpenFeign 的主要工作不是重新发明 Feign 的 codec SPI，而是把 Spring 世界的消息转换器、`ResponseEntity` 语义和按-client 的 error decoder 选择，拼成一套 Feign 可消费的 bean 图；真正的 SPI 定义、默认 `DefaultErrorDecoder`、`OptionalDecoder` 和 capability enrichment 机制，仍然属于 OpenFeign core。

把整篇压成三句话：

1. Spring Cloud 默认 decoder 栈是 `OptionalDecoder(ResponseEntityDecoder(SpringDecoder))`：最外层 `OptionalDecoder` 属于 OpenFeign core，中间和最内层属于 Spring Cloud。  
2. Spring Cloud 并不提供默认 `ErrorDecoder` bean；它只负责按 bean / factory / property 选择，最终兜底仍是 OpenFeign core `DefaultErrorDecoder`。  
3. `Capability` 是 Feign core 的后置 enrich 机制，不取代 Spring Cloud 对 encoder/decoder/error decoder 的主装配职责。  
