# Spring Cloud OpenFeign：Timeout、Request.Options、Retry 与 Redirect

> 基于 Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1

## 一、困惑开场：retry 到底是谁在循环

在 Spring Cloud OpenFeign 里，最常见的配置往往不是 Contract、Encoder、Decoder，而是这几项：

- `connectTimeout`
- `readTimeout`
- `followRedirects`
- `retryer`

但恰恰是这些最常配的项，最容易把人绕晕。

很多人会自然地把它们理解成：Spring Cloud OpenFeign 负责 timeout，底层 HTTP client 负责 redirect，Spring Cloud 自己再顺便做一次 retry。这样想很顺，但源码并不是这么分层的。

真正要抓住的是两件事：

1. `connectTimeout`、`readTimeout`、`followRedirects` 最终都会先落到 Feign 的 `Request.Options`
2. 真正的 retry loop 不在 Spring Cloud，而在 OpenFeign core 的 `SynchronousMethodHandler.runWithRetry()`

所以这篇的核心问题不是"这些配置项怎么写"，而是：**这些配置值到底在哪一层被装配，又在哪一层被真正消费。**

## 二、前情回顾：前几篇讲的是 Targeter、Capability，这一篇讲的是 Options 与 Retryer

前面几篇已经把几个主要层级拆开了：

- LoadBalancer 篇讲的是 `Client` replacement
- CircuitBreaker 篇讲的是 Builder / Targeter / InvocationHandler
- Micrometer 篇讲的是 `Capability -> BaseBuilder.enrich()`

这一篇又是另一条线：Spring Cloud 通过 `FeignClientProperties`、`FeignClientFactoryBean`、`OptionsFactoryBean` 把配置装进 `Request.Options` 和 `Retryer`；然后 OpenFeign core 在 method handler 执行期真正使用这些对象。

所以这篇最重要的层级区分是：

- Spring Cloud：装配 `Options` 和 `Retryer`
- OpenFeign core：在调用期消费 `Options` 和执行 retry loop

## 三、先走三条失败的路

### 失败方案一：retry 是 Spring Cloud OpenFeign 自己的调用循环

这是一种非常自然的误解，因为属性就写在 Spring Cloud 这一侧。

但 Spring Cloud 真正做的事情很有限：它只是给 builder 选好 `Retryer`。真正的循环在 OpenFeign core 的 `SynchronousMethodHandler.runWithRetry()`，只有当 `executeAndDecode()` 抛出 `RetryableException` 时，才会继续下一轮。

所以 retry runtime 不属于 Spring Cloud，属于 Feign core。

OpenFeign `feign/SynchronousMethodHandler.java:68` 是 retry loop 的入口。  
OpenFeign `feign/SynchronousMethodHandler.java:73` 说明只有 `RetryableException` 进入重试分支。  

### 失败方案二：`followRedirects` 是 Feign 的 retry 开关

`followRedirects` 看起来也会导致"请求再发一次"，所以很多人会把它和 retry 混成一件事。

但 redirect 跟 retry 是两条完全不同的线。

`followRedirects` 是 `Request.Options` 里的一个 HTTP 选项，最终交给底层 client。比如默认 `DefaultClient` 会把它翻译成 `HttpURLConnection.setInstanceFollowRedirects(...)`。它只决定底层 HTTP client 是否跟随 3xx 跳转，不决定 Feign 的 retry loop。

OpenFeign `feign/DefaultClient.java:158`、`feign/DefaultClient.java:161` 说明 redirect 是底层 client 选项。  

### 失败方案三：raw Feign 和 Spring Cloud OpenFeign 的默认 retry 行为一致

如果你直接看 OpenFeign core，会发现 builder 默认就带 `DefaultRetryer`。于是很多人会顺手以为 Spring Cloud OpenFeign 默认也一样。

但 Spring Cloud 专门改掉了这个默认值。它会提供一个 `Retryer.NEVER_RETRY` bean，再在 builder 创建时显式塞进去。

所以 raw Feign 与 Spring Cloud OpenFeign 的默认行为不同：

- raw Feign：默认允许 retry
- Spring Cloud OpenFeign：默认几乎不 retry

OpenFeign `feign/BaseBuilder.java:48` 是 raw Feign 默认 `DefaultRetryer`。  
`FeignClientsConfiguration.java:162` 是 Spring 默认 `Retryer.NEVER_RETRY`。  

## 四、最小总图：properties → options/retryer → method handler

```text
spring.cloud.openfeign.client.config.*
    ↓
FeignClientProperties
    ↓
FeignClientFactoryBean.configureFeign()
    ├─ configureUsingConfiguration()
    ├─ configureUsingProperties()
    └─ (可选) refresh-scoped OptionsFactoryBean
    ↓
builder.options(Request.Options)
builder.retryer(Retryer)
    ↓
OpenFeign SynchronousMethodHandler
    ├─ findOptions()
    ├─ client.execute(request, options)
    └─ runWithRetry(retryer.clone())
```

这张图里最容易被忽略的一跳，是 **Spring Cloud 到此为止只是在 builder 上放对象，真正如何使用它们，要等 OpenFeign core 执行 method handler 时才发生。**

`FeignClientFactoryBean.java:166` 是 `configureFeign()` 入口。  
`FeignClientFactoryBean.java:279` 说明 properties 最终会构造 `Request.Options`。  
`FeignClientFactoryBean.java:289` 说明 properties 也会构造并应用 `Retryer`。  
OpenFeign `feign/SynchronousMethodHandler.java:119` 说明执行期把 `options` 交给 `client.execute(request, options)`。  

## 五、`Request.Options` 的来源：先有 raw Feign 默认值，再被 Spring Cloud 覆盖

### 5.1 raw Feign 默认值是什么

Spring Cloud 这一侧的默认值并不是自己手写一套常量，而是直接从 `new Request.Options()` 起步。

`FeignClientFactoryBean` 的本地字段初始化就是：

- connect timeout：来自 `new Request.Options()`
- read timeout：来自 `new Request.Options()`
- follow redirects：来自 `new Request.Options()`

`FeignClientFactoryBean.java:110`、`FeignClientFactoryBean.java:112`、`FeignClientFactoryBean.java:114` 是这一层起点。  

而 raw Feign `Request.Options` 的默认值是：

- connect timeout：10 秒
- read timeout：60 秒
- follow redirects：true

OpenFeign `feign/Request.java:322` 说明这些值都属于 `Request.Options` 这个模型。  
OpenFeign `feign/Request.java:438` 说明无参构造默认是 `10s / 60s / true`。  
OpenFeign `feign/Request.java:447`、`feign/Request.java:456`、`feign/Request.java:465` 分别给出 connect timeout、read timeout、follow redirects 的访问语义。  

### 5.2 Spring Cloud 在哪建模这些字段

这些项在 Spring Cloud 里并不是散落在某个 client bean 上，而是建模在 `FeignClientProperties.FeignClientConfiguration` 里：

- `connectTimeout`
- `readTimeout`
- `followRedirects`
- `retryer`

`FeignClientProperties.java:131`、`FeignClientProperties.java:135`、`FeignClientProperties.java:137`、`FeignClientProperties.java:139` 是字段证据。  

所以 timeout/redirect/retryer 在 Spring Cloud 世界里先是配置模型，之后才会被转换成 runtime 对象。

## 六、优先级：default、named client、bean、`defaultToProperties`

### 6.1 两段装配：配置 bean 与 properties

`FeignClientFactoryBean.configureFeign()` 不是只走一条路径，而是要在两类来源之间排优先级：

- `configureUsingConfiguration()`：child context 中的 bean 配置
- `configureUsingProperties()`：`FeignClientProperties` 绑定过来的属性配置

`FeignClientFactoryBean.java:174` 依据 `defaultToProperties` 决定先后顺序。  

### 6.2 `defaultToProperties=true` 的含义

如果 `defaultToProperties=true`，那么顺序就是：

1. 先应用配置类 / bean
2. 再应用 properties

也就是说，properties 赢。

如果它是 `false`，顺序反过来：

1. 先应用 properties
2. 再应用配置类 / bean

也就是说，bean 赢。

`FeignClientProperties.java:52` 是 `defaultToProperties` 的来源。  
`FeignClientFactoryBean.java:174`、`FeignClientFactoryBean.java:180` 是顺序分叉。  

### 6.3 `default` 配置与 named client 配置

除了"配置类 vs properties"这层顺序，properties 自己内部也有两层：

- `default` 配置
- 当前 client 的具名配置

Spring Cloud 的策略是先吃 `default`，再吃当前 client 的命名配置。这样就能做到：

- 给所有 Feign client 一个全局默认 timeout
- 再给某个特定 client 覆盖成自己的 timeout

`FeignClientFactoryBean.java:176`、`FeignClientFactoryBean.java:177` 说明了这两段 property 的合并顺序。  

### 6.4 为什么说是字段级合并，而不是整块替换

最关键的细节在于：`builder.options(new Request.Options(...))` 并不是直接拿某个完整对象整块覆盖，而是按字段回退。

如果某个 property 没配，就继续沿用当前值；配了哪个字段，就只覆盖哪个字段。这样 partial override 才能成立。

`FeignClientFactoryBean.java:280`、`FeignClientFactoryBean.java:282`、`FeignClientFactoryBean.java:283` 体现了这种字段级回退。  

## 七、refreshable options：`OptionsFactoryBean` 只是重新产出 `Request.Options`

### 7.1 refresh 模式下发生了什么

如果启用了 refresh 相关能力，`FeignClientsRegistrar` 会为每个 Feign client 注册一个 refresh-scoped 的 `Request.Options` bean，这个 bean 由 `OptionsFactoryBean` 生产。

`FeignClientsRegistrar.java:262`、`FeignClientsRegistrar.java:315` 是注册入口。  
`OptionsFactoryBean.java:54` 是生成入口。  

### 7.2 `OptionsFactoryBean` 做的事并不神秘

它本质上还是重复一遍"default 配置 + named client 配置 + 字段级回退"，然后产出一个新的 `Request.Options`。

所以 refreshable options 并不是绕开 `Request.Options` 这条线，而是**把新的属性值重新组装成新的 `Request.Options` 实例**。

`OptionsFactoryBean.java:61`、`OptionsFactoryBean.java:62` 说明它先取 `default` 与当前 client 配置。  
`OptionsFactoryBean.java:76`、`OptionsFactoryBean.java:80` 说明它按字段合并生成新的 options。  

### 7.3 这不等于配置一改就立刻生效

这是另一个很常见的误解。

refreshable options 的重点是：它是 refresh-scoped，可在 refresh 后拿到新值；不是你改完配置文件，已经创建好的运行实例就会立刻神奇换掉参数。

`FeignClientWithRefreshableOptionsTest.java:76` 验证 refresh 前不变。  
`FeignClientWithRefreshableOptionsTest.java:103`、`FeignClientWithRefreshableOptionsTest.java:113` 验证 refresh 后才变化。  

## 八、真正的 retry loop：`runWithRetry()` 与 `RetryableException`

### 8.1 loop 在哪

真正的 retry loop 在 OpenFeign `SynchronousMethodHandler.runWithRetry()`。

它会先 `clone()` 当前的 `Retryer`，然后进入循环；每次执行 `executeAndDecode()`，只有当捕获到 `RetryableException` 时，才会调用 `retryer.continueOrPropagate(e)` 决定下一步。

OpenFeign `feign/SynchronousMethodHandler.java:68` 是循环入口。  
OpenFeign `feign/SynchronousMethodHandler.java:69` 说明会先 clone retryer。  
OpenFeign `feign/SynchronousMethodHandler.java:73` 说明只捕获 `RetryableException`。  

### 8.2 什么会变成 `RetryableException`

不是所有失败都会自动进入 retry loop。

主要有两类来源：

**第一类：I/O 异常**  
底层 client 执行时如果抛 `IOException`，Feign 会把它包装成 `RetryableException`。

OpenFeign `feign/SynchronousMethodHandler.java:122`、`feign/SynchronousMethodHandler.java:132` 是 I/O 异常包装路径。  
OpenFeign `feign/FeignException.java:302` 是 `errorExecuting()` 入口。  

**第二类：ErrorDecoder 主动返回 `RetryableException`**  
默认 `ErrorDecoder` 并不会把所有 5xx 都改成 retryable。它会先把响应解成 `FeignException`，再尝试解析 `Retry-After`；只有 `Retry-After` 存在时，才返回 `RetryableException`。

OpenFeign `feign/codec/DefaultErrorDecoder.java:45` 说明入口在 `decode()`。  
OpenFeign `feign/codec/DefaultErrorDecoder.java:46`、`feign/codec/DefaultErrorDecoder.java:47` 说明默认先生成 `FeignException`。  
OpenFeign `feign/codec/DefaultErrorDecoder.java:48` 说明会尝试解析 `Retry-After`。  
OpenFeign `feign/codec/DefaultErrorDecoder.java:49`、`feign/codec/DefaultErrorDecoder.java:50` 说明只有 `retryAfter != null` 才返回 `RetryableException`。  

这意味着：**一个普通 503 并不天然等于会 retry。**

### 8.3 retryer 决定是否继续

就算已经进入 `RetryableException` 分支，也不代表一定会重试成功或真的继续重试。

最终决定权在 `Retryer.continueOrPropagate()`。`DefaultRetryer` 会根据 attempt 次数、退避时间、`retryAfter` 等规则来决定是 sleep 后继续，还是直接抛出。

OpenFeign `feign/Retryer.java:27` 是接口。  
OpenFeign `feign/DefaultRetryer.java:28` 说明默认构造会创建一套默认重试策略。  
OpenFeign `feign/DefaultRetryer.java:44` 说明 `continueOrPropagate()` 先判断是否超过最大尝试次数。  
OpenFeign `feign/DefaultRetryer.java:49`、`feign/DefaultRetryer.java:50` 说明存在 `retryAfter` 时优先按服务端给定时间处理。  
OpenFeign `feign/DefaultRetryer.java:58`、`feign/DefaultRetryer.java:77` 说明没有 `retryAfter` 时会走指数退避计算。  
OpenFeign `feign/DefaultRetryer.java:83` 说明每次调用前都会 `clone()` 出新的 retryer 实例。  

## 九、为什么 raw Feign 默认会 retry，而 Spring Cloud 默认几乎不 retry

### 9.1 raw Feign 的默认世界

raw Feign 的 `BaseBuilder` 默认字段里直接放的是 `new DefaultRetryer()`。

所以如果你直接用 Feign core，而不经 Spring Cloud，I/O 异常和符合条件的 retryable 响应通常都会进入默认 retry 策略。

OpenFeign `feign/BaseBuilder.java:48` 是默认值来源。  

### 9.2 Spring Cloud 的默认世界

Spring Cloud OpenFeign 故意改掉这个默认值。它在 `FeignClientsConfiguration` 中提供一个 `feignRetryer()` bean，返回的是 `Retryer.NEVER_RETRY`。

接着，prototype 作用域的 `Feign.Builder` bean 在创建时会调用 `Feign.builder().retryer(retryer)`，把这个 bean 显式塞进去。

`FeignClientsConfiguration.java:160`、`FeignClientsConfiguration.java:162` 是默认 retryer bean。  
`FeignClientsConfiguration.java:207`、`FeignClientsConfiguration.java:210`、`FeignClientsConfiguration.java:211` 是 builder 应用路径。  

### 9.3 这会带来什么直观现象

这就是为什么很多人第一次把 raw Feign 示例搬到 Spring Cloud OpenFeign 里时，会觉得"怎么不重试了"。

不是 Feign core 失去了 retry loop，而是 Spring Cloud 在装配期就把 loop 的策略对象换成了 `NEVER_RETRY`。

所以 I/O 异常即便被包装成 `RetryableException`，通常也会马上被传播出去。

OpenFeign `feign/Retryer.java:46`、`feign/Retryer.java:51` 是 `NEVER_RETRY` 的传播语义。  

### 9.4 怎么恢复 retry

要恢复 retry，有两条常见路：

- 在 client configuration 中声明自己的 `Retryer` bean
- 在 properties 中指定 `spring.cloud.openfeign.client.config.<client>.retryer=...`

Spring Cloud 最终都会把它变成 `builder.retryer(...)`。

`FeignClientFactoryBean.java:197` 是从 child context 取 `Retryer` bean。  
`FeignClientFactoryBean.java:289`、`FeignClientFactoryBean.java:290` 是 property 指定 retryer 的应用路径。  

## 十、redirect 只是 options，不是 retry

再把最容易混的一点单独拎出来说一次。

`followRedirects` 这条线属于：

`properties -> Request.Options -> client.execute(request, options) -> 底层 HTTP client`

retry 这条线属于：

`builder.retryer(...) -> runWithRetry() -> RetryableException -> continueOrPropagate()`

它们都可能让你看到"请求好像又发了一次"，但根本不是同一种机制。

- redirect：底层 HTTP 协议层跟随 3xx
- retry：Feign method handler 层重新执行一轮调用

所以把 `followRedirects=false` 并不会关掉 retry；把 `Retryer.NEVER_RETRY` 也不会阻止底层 client 跟随 redirect。

OpenFeign `FeignBuilderTest.java:120` 证明 redirect 由 options 控制。  

## 十一、误解澄清

### 误解一：retry 是 Spring Cloud OpenFeign 自己做的

不是。Spring Cloud 负责装配 `Retryer`，真正循环在 Feign core 的 `runWithRetry()`。

### 误解二：`followRedirects` 是 retry 开关

不是。它是底层 HTTP client 的 redirect 选项。

### 误解三：所有 5xx 默认都会 retry

不是。默认只有符合 `RetryableException` 条件的失败才会进入 loop，普通 5xx 不自动等于 retry。

### 误解四：raw Feign 与 Spring Cloud OpenFeign 默认 retry 行为一致

不是。raw Feign 默认 `DefaultRetryer`，Spring 默认 `Retryer.NEVER_RETRY`。

### 误解五：refreshable options 会在配置改动后立刻自动生效

不是。要在 refresh 后才会换新值。

## 十二、收网总结：Spring 负责装配，Feign 负责消费与执行

回到开头的问题：timeout、redirect、retry 到底分别落在哪？

答案是：Spring Cloud OpenFeign 负责把属性装配成 `Request.Options` 和 `Retryer`，然后交给 Feign core；OpenFeign core 再在 method handler 和底层 client 执行链中真正消费它们。

把整篇压成三句话：

1. `connectTimeout`、`readTimeout`、`followRedirects` 先进入 `Request.Options`，再由 `client.execute(request, options)` 交给底层 client。  
2. 真正的 retry loop 在 OpenFeign `SynchronousMethodHandler.runWithRetry()`，只有 `RetryableException` 才会进入循环。  
3. raw Feign 默认 `DefaultRetryer`，Spring Cloud OpenFeign 默认 `Retryer.NEVER_RETRY`，这是两者线上行为差异的关键。  
