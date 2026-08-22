# OpenFeign：runtime spine——从 `Feign.builder()` 到 HTTP 调用

> 基于 OpenFeign 13.14-SNAPSHOT

## 一、困惑开场：为什么 Feign 不是“解析注解然后发个请求”

第一次看 Feign 源码的人，最容易产生的误判就是：这个框架不就是把接口注解解析成 URL，然后每次调用时发个 HTTP 请求吗？

这个印象并不全错，但它会把 Feign 最重要的设计掩盖掉：Feign 并不是一个“注解工具”，而是一个把**接口描述、请求模板、执行策略和 HTTP 客户端**组装成统一运行链的 runtime。

如果它只是“注解解析器”，那就解释不了下面这些问题：

- 为什么 `Feign.builder()` 要先组装 Contract、Encoder、Decoder、Retryer、ErrorDecoder、InvocationHandlerFactory、Client？
- 为什么 `ReflectiveFeign` 在 build 时就把方法映射成 `MethodHandler`，而不是等调用发生时再临时分析？
- 为什么 `RequestTemplate` 要分成 build-time 原型和 invoke-time 实例两种状态？
- 为什么 `Client.execute()` 回来之后，还要经过 `ResponseHandler` 和 `InvocationContext` 再决定最终给业务什么结果？

这说明 Feign 的真正骨架不是“注解 → URL”，而是：

```text
builder -> proxy -> method handler -> request template -> client.execute() -> response handler
```

## 二、前情回顾：这一篇只讲 OpenFeign core，不讲 Spring

本篇刻意只讲 OpenFeign core，不混入 Spring Cloud OpenFeign。

原因很简单：如果一上来就把 `@FeignClient`、named context、LoadBalancer、CircuitBreaker 全塞进来，读者很容易把 Spring 的 bean lifecycle 当成 Feign 自己的 runtime spine。这样后面再回头解释 core 的 builder、proxy、template、client，主线会变得很混。

这里再把边界收紧一句：**这一篇讲的是“注解解析结果最后挂在哪条运行链上”，不是讲“注解语法本身怎么解析”。** Contract / `MethodMetadata` 的语法细节应该留给下一篇专门展开。

所以这篇只解决一个问题：**一个纯 OpenFeign 接口，从 `Feign.builder().target(...)` 到最终 `Client.execute()`，中间到底发生了什么。**

Spring Cloud OpenFeign 应该单独作为下一层“桥接篇”来讲，而不是提前混进来。

## 三、先走三条失败的路

### 失败方案一：接口注解一解析完，就可以直接发请求

这会把 build-time 和 invoke-time 混为一层。

Feign 真正固定在 build 阶段的是：

- 每个方法对应的 `MethodMetadata`
- 每个方法对应的 `MethodHandler`
- 动态代理怎么把方法路由到这些 handler

真正等到每次调用时才发生的是：

- 把这次实参填进 `RequestTemplate`
- 应用 request interceptors
- 用 `Target` 注入 base URL 或其他 target-specific 语义
- `Client.execute()` 发请求
- `ResponseHandler` 决定 decode / error / retry 结果

所以“解析注解”只是 build-time 的一段，离真正发请求还差很多层。

### 失败方案二：`target("https://api")` 只是保存一个 base URL

如果你把 target 理解成一个常量字符串，那就会低估它的职责。

`Target.apply(template)` 是 request 成形前的最后一步之一。`HardCodedTarget` 确实只是把 base URL 注进去，但自定义 `Target` 完全可以继续添加 header、query 参数甚至改 request。

所以 target 是运行时请求塑形器，不只是静态常量。

### 失败方案三：HTTP 返回之后，结果就直接回到业务代码

这会忽略 `ResponseHandler` 和 `InvocationContext` 的作用。

Feign 收到 HTTP response 之后，还要决定：

- 这个返回值是普通对象还是原始 `Response`
- 4xx/5xx 是否交给 `ErrorDecoder`
- `dismiss404` 是否生效
- decoder 抛错后如何包装
- `RetryableException` 是否要再走一轮 retry

所以 HTTP I/O 和“业务最终看到什么”之间，隔着一层响应解释器。

## 四、最小总图：Feign 的 build-time 和 invoke-time

先把最小总图压出来：

```text
Build time
Feign.builder()
    ↓
internalBuild()
    ↓
Contract.parseAndValidateMetadata()
    ↓
MethodMetadata + RequestTemplate prototype
    ↓
MethodHandler map
    ↓
ReflectiveFeign dynamic proxy

Invoke time
proxy.method(args)
    ↓
InvocationHandler -> MethodHandler.invoke()
    ↓
RequestTemplate.Factory.create(args)
    ↓
RequestTemplate.resolve() / Target.apply()
    ↓
Client.execute(Request)
    ↓
ResponseHandler / InvocationContext
    ↓
返回值 / 错误 / 重试结果
```

这里要先钉死一个边界：**Feign 最重要的设计，不是把所有事都拖到调用期，而是尽量把“不会随每次调用变化的东西”提前固化在 build-time。**

换句话说，build-time 和 invoke-time 不是简单的前后两个步骤，而是两类完全不同的信息层：

- build-time 固定的是接口结构、参数角色、模板骨架、handler 映射  
- invoke-time 填充的是这次调用的实参、target 语义、interceptor 结果和最终 HTTP request

只要把这两层混在一起，就会误以为 Feign 每次调用都在“重新解释接口”。

## 五、`Feign.Builder`：先组策略，不发请求

### 5.1 `Feign.builder()` 只是在造装配器

`Feign.builder()` 只是返回一个新的 `Builder`，并不会解析接口，更不会发请求。

`Feign.java:36` — `Feign.builder()`

Builder 的职责是把这次 client runtime 需要的策略对象先组装好，例如：

- `Contract`
- `Encoder`
- `Decoder`
- `Retryer`
- `ErrorDecoder`
- `InvocationHandlerFactory`
- `Client`
- `RequestInterceptor`
- `ResponseInterceptor`
- `Options`

这些策略大多都有默认值，定义在 `BaseBuilder` 里。

`BaseBuilder.java:43` — 默认策略字段
`BaseBuilder.java:385` — build 相关入口

### 5.2 `target(...)` 不是立即请求，而是 build + newInstance

调用 `builder.target(target)` 时，Builder 实际执行的是：

1. `build()`
2. `newInstance(target)`

也就是说，`target()` 是“完成组装并创建代理”的入口，不是“调用远端”的入口。

`Feign.java:212` — `Builder.target(...)`
`Feign.java:217` — `build().newInstance(target)`

### 5.3 `internalBuild()` 真正拼出 runtime spine

`internalBuild()` 里会组装：

- `ResponseHandler`
- `SynchronousMethodHandler.Factory`
- `RequestTemplateFactoryResolver`
- `ReflectiveFeign`

`Feign.java:218` — `internalBuild()`
`Feign.java:228` — 组装 `ResponseHandler`
`Feign.java:240` — 返回 `ReflectiveFeign`

这说明 Builder 最核心的角色不是“保存配置”，而是“拼出执行链”。

## 六、`ReflectiveFeign`：接口如何变成 `Method -> MethodHandler` 映射

### 6.1 `newInstance(target)` 是真正的 build-time 核心

`ReflectiveFeign.newInstance(target)` 做的是四件事：

1. 校验 target interface
2. 用 `Contract` 解析所有方法，得到 `MethodMetadata`
3. 为每个方法创建 `MethodHandler`
4. 创建 JDK 动态代理

`ReflectiveFeign.java:50` — `newInstance()`
`ReflectiveFeign.java:58` — parse metadata / create handlers
`ReflectiveFeign.java:63` — dynamic proxy 创建

### 6.2 `MethodHandler` 是按方法缓存的可执行对象

这里最关键的一点是：Feign 不会在每次方法调用时重新解析注解，而是在 build-time 就把每个方法对应的执行器固定好。

这个设计的动机要再说硬一点：如果每次调用都重新走 Contract 解析、参数角色判断、模板骨架构造，那 Feign 就会把大量“不随调用变化的结构信息”重复计算一遍。`MethodHandler` 的预建，就是为了把这些固定结构预先压成一张 `Method -> handler` 映射，运行时只做参数填充和执行。

这个执行器就是 `MethodHandler`，通常由 `SynchronousMethodHandler.Factory` 创建。

因此 Feign 的动态代理不是“每次反射分析注解”，而是“按 Method 找到预建 handler 再执行”。

### 6.3 `InvocationHandler` 只是路由，不是 HTTP 客户端

动态代理最终委托给 `InvocationHandlerFactory` 产出的 handler。默认实现是 `ReflectiveFeign.FeignInvocationHandler`。

`DefaultInvocationHandlerFactory.java:25` — invocation handler factory
`ReflectiveFeign.java:75` — invocation handler

所以 `InvocationHandler` 的职责不是发 HTTP，而是：

- 处理 `equals/hashCode/toString`
- 把业务方法路由到预建的 `MethodHandler`

## 七、`MethodMetadata` 与 `RequestTemplate`：哪些东西在 build-time 就固定了

### 7.1 `Contract` 先把接口解析成 `MethodMetadata`

`Contract.parseAndValidateMetadata(target.type())` 会遍历接口方法，生成 `MethodMetadata`。

`Contract.java:49` — parseAndValidateMetadata
`Contract.java:92` — `MethodMetadata` 创建

这里固定下来的包括：

- return type
- `configKey`
- body / url / queryMap / headerMap 参数索引
- 名字绑定
- expander 信息
- request template 原型

`MethodMetadata.java:37` — 核心状态
`MethodMetadata.java:146` — template 原型

### 7.2 `RequestTemplate` 在 build-time 只是原型

这个原型不是最终 `Request`。它只是保存了：

- method
- relative path
- headers 模板
- query 模板
- body 模板
- placeholder

真正的 `Request` 还要等调用时把参数填进去。

`RequestTemplate.java:53` — RequestTemplate 定位

### 7.3 target 和 uri 是两个不同层次

`RequestTemplate.target(String)` 要求的是绝对目标地址，`uri(String)` 则是相对路径。Feign 明确把 base URL 和 path 分开管理，直到最后才合并。

`RequestTemplate.java:447` — target(base URL)
`RequestTemplate.java:500` — uri(relative path)

这正说明 target 不只是一个字符串，而是 request 成形前的最后塑形层。

## 八、每次调用：实参怎样变成最终 Request

### 8.1 `MethodHandler.invoke()` 先从原型克隆模板

`SynchronousMethodHandler.invoke(argv)` 不会修改那份 build-time 原型，而是先让 `RequestTemplate.Factory` 从 `metadata.template()` 克隆出一份新的 template，再用这次的参数填进去。

`SynchronousMethodHandler.java:49` — invoke
`RequestTemplateFactoryResolver.java:40` — 选择模板工厂
`RequestTemplateFactoryResolver.java:85` — 从原型克隆

### 8.2 参数填充和 resolve 发生在调用期

调用期会发生：

- path placeholder 替换
- body 编码
- `@QueryMap` / `@HeaderMap` 附加
- slash encoding
- 选填 `Options`

`RequestTemplateFactoryResolver.java:107` — argv -> resolve

这就是为什么说 Feign 的主链必须切成 build-time 和 invoke-time 两段：模板结构 build 时固定，实参数值调用时才注入。

### 8.3 `Target.apply()` 是最后一层请求塑形器

在真正发请求前，`targetRequest(template)` 会先跑 request interceptors，然后调用 `Target.apply(template)`。

`SynchronousMethodHandler.java:147` — `targetRequest(...)`
`Target.java:97` — `HardCodedTarget.apply()`

对默认 `HardCodedTarget` 来说，这一步主要是把 base URL 注进去；但抽象层面它远不只是“补一个字符串”。`Target` 代表的是“这次请求最终要落到哪个目标，以及在目标边界上还要不要再改一点什么”。所以它是最后一层 request shaper，而不是早在 build-time 就彻底固定死的常量。

## 九、`Client.execute()`：真正的 HTTP 边界

### 9.1 `Client` 是 transport SPI，不关心注解和代理

`Client` 的接口非常窄：

- 输入：一个已经成形的 `Request`
- 输出：一个 `Response`

`Client.java:32` — Client SPI

它不关心 Contract、MethodMetadata、动态代理，也不关心参数怎么解析出来。它只关心一件事：执行 HTTP I/O。

### 9.2 默认 `Client` 如何执行请求

默认 `DefaultClient` 会把 `Request` 转成 `HttpURLConnection`，写 header/body、设置 timeout/redirect，然后再把结果转回 `Response`。

`DefaultClient.java:88` — execute
`DefaultClient.java:146` — body / connection handling
`DefaultClient.java:194` — response conversion

这就是 OpenFeign core 的 transport 边界：前面所有复杂组装，最后都收束到一次简单的 `Client.execute(request, options)`。

## 十、`ResponseHandler`：HTTP 回来后，业务到底拿到什么

### 10.1 `ResponseHandler` 不是可有可无的装饰

HTTP response 回来之后，不是直接丢给业务调用者，而是先经过 `ResponseHandler`。它会处理：

- logging / rebuffer
- response interceptor
- 调用 `InvocationContext.proceed()`

`ResponseHandler.java:65` — response handling

### 10.2 `InvocationContext` 才真正决定 decode / error / retry 语义

`InvocationContext.proceed()` 会根据返回类型和 HTTP 状态决定：

- 直接返回原始 `Response`
- 正常 decode
- `dismiss404`
- `decodeVoid`
- 走 `ErrorDecoder`
- 抛出或包装 `FeignException`

`InvocationContext.java:69` — proceed
`InvocationContext.java:79` — success / 404 / void 分支
`InvocationContext.java:119` — ErrorDecoder / exception path

### 10.3 retry 包裹的是 execute + decode 整体

`SynchronousMethodHandler` 的 retry 不是只包住 `client.execute()`。它包的是“请求构造之后，从执行到响应解释”的整个阶段。

`SynchronousMethodHandler.java:71` — retry loop

所以 `RetryableException` 不一定只来自 socket 或 HTTP client，也可能来自后面的 decode / error-decoder 路径。

## 十一、误解澄清

### 误解一：`ReflectiveFeign` 负责真正发 HTTP

不是。它只负责 build-time 的 metadata/handler/proxy 组装。

### 误解二：`MethodMetadata.template()` 就是最终请求

不是。它只是 build-time 的请求模板原型。

### 误解三：`target()` 只是一个 base URL 字符串

不是。target 是最后一层请求塑形器，默认实现只是最简单的一种。

### 误解四：HTTP 返回以后，结果就直接给业务代码

不是。`ResponseHandler` / `InvocationContext` 还要继续决定 decode / error / retry 路径。

### 误解五：retry 只包住网络执行

也不是。它包的是 execute + response interpretation 的整段流程。

### 误解六：拿到 proxy，就等于和远端的运行时关系都已经 ready 了

也不是。拿到 proxy 只说明 build-time 组装已经完成：MethodMetadata、MethodHandler 和 InvocationHandler 都准备好了。真正的请求模板填充、target 处理、interceptor 应用、HTTP 发送和 response 解释，仍然要等到每次方法调用时才发生。

## 十二、收网总结：OpenFeign 的主线不是注解，而是组装链

回到开头的问题：为什么 Feign 不是“解析注解然后发个请求”这么简单？

因为它真正搭起来的是一条完整的 client-side runtime spine：

- builder 先把策略对象装好
- `ReflectiveFeign` 在 build-time 把接口变成 `MethodHandler`
- `MethodMetadata` 和 `RequestTemplate` 先固定请求骨架
- 每次调用再由 `RequestTemplate.Factory` 把参数填进去
- `Target` 和 interceptors 再做最后塑形
- `Client.execute()` 真正发 HTTP
- `ResponseHandler` 决定业务最终看到什么

**三句话总结：**

1. OpenFeign 的核心不是注解解析器，而是 `builder -> proxy -> handler -> template -> client.execute()` 这条运行链。  
2. build-time 和 invoke-time 是两段明确分层：前者固定结构，后者填充参数并发请求。  
3. HTTP I/O 只是主线中间的一步，最终业务结果还要经过 `ResponseHandler` 和 `InvocationContext` 再解释。  

**下篇预告：** 下一篇进入 OpenFeign 的 Contract / MethodMetadata / RequestTemplate 专题，继续把“注解如何变成请求模板”单独打透。