# Spring Cloud OpenFeign：从 `@EnableFeignClients` 到 Feign Proxy

> 基于 Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1

## 一、困惑开场：为什么“加个注解”不等于立刻有代理

在使用 Spring Cloud OpenFeign 时，最容易形成的一种错觉是：

```java
@FeignClient(name = "user-service")
interface UserClient { ... }
```

这个注解一出现，Spring 好像就“自动”把远程代理给你准备好了。

但如果真是这样，下面这些问题就解释不通：

- `@EnableFeignClients` 到底做了什么？  
- `FeignClientsRegistrar` 为什么要注册 BeanDefinition 而不是直接 new 代理？  
- `FeignClientFactoryBean` 为什么还要等到 `getObject()` 时才真正创建 client？  
- 每个 `@FeignClient` 为什么又要有自己的 named child context？

这些问题说明：Spring Cloud OpenFeign 真正做的不是“直接创建代理”，而是搭了一座桥——把 Spring 的扫描、BeanDefinition、配置和生命周期，桥接到 OpenFeign core 的 `Feign.Builder -> ReflectiveFeign -> MethodHandler -> Client` 主线上。

## 二、前情回顾：这篇只讲 Spring 怎么制造 Feign client，不重讲 Feign 自己怎么工作

前面三篇 OpenFeign core 已经形成了一条完整主线：

- 第一篇讲了 runtime spine：`Feign.builder()` 如何组装 `ReflectiveFeign -> MethodHandler -> Client` 这条调用链。  
- 第二篇讲了 blueprint：`Contract` 如何把接口注解生成 `MethodMetadata` 和 `RequestTemplate`，在 build-time 固定结构、invoke-time 填参数。  
- 第三篇讲了扩展层：`Client / Encoder / Decoder / Retryer / ErrorDecoder / Capability` 分别在哪一段运行、重试时会不会重跑。

这一篇不再重复这些，而是换一个视角：**Spring 怎样把 `@FeignClient` 翻译成 OpenFeign core 能消费的 builder 和 proxy。**

所以本篇的边界非常明确：

- 讲 registrar、FactoryBean、named child context、`FeignClientsConfiguration`、`SpringMvcContract` 的位置  
- 不展开 OpenFeign core 的 MethodHandler / Client.execute 内部细节  
- 也不提前展开 LoadBalancer / CircuitBreaker / OAuth2 / Refresh

## 三、先走三条失败的路

### 失败方案一：`@EnableFeignClients` 一打开就直接创建了所有代理

如果真是这样，registrar 阶段就应该直接 new 出每个 Feign client 的 proxy，后面也不需要 `FactoryBean`。

但实际上 `@EnableFeignClients` 只通过 `@Import` 把 `FeignClientsRegistrar` 接进来。Registrar 的工作主要是：

- 扫描或显式收集 `@FeignClient` 接口  
- 注册对应的 BeanDefinition  
- 为每个 client 记录一份 configuration 说明书

真正的代理创建要晚得多，要等到 `FeignClientFactoryBean.getObject()` 被调用时才发生。

### 失败方案二：Spring Cloud OpenFeign 自己实现了一套 Feign runtime

如果这样理解，就会把 `FeignClientFactoryBean`、`FeignClientsConfiguration` 和 `SpringMvcContract` 看成“OpenFeign 的替代实现”。

但真实情况是：Spring Cloud 只负责发现接口、构造 child context、装配 Builder 所需 Bean，最后真正造代理仍然是：

```text
Feign.Builder.target(...) -> OpenFeign core proxy
```

也就是说，Spring Cloud 负责“制造”，OpenFeign core 负责“运行”。

### 失败方案三：每个 `@FeignClient` 都共享同一套 Spring Bean 配置

如果如此，不同 client 就不可能拥有不同的：

- `Contract`
- `Encoder`
- `Decoder`
- `Logger`
- `Retryer`
- `RequestInterceptor`
- `Capability`

但源码中，`FeignClientFactory` 明确是 `NamedContextFactory` 的子类，每个 `contextId` 都可以拥有自己的 child context。也就是说，Spring Cloud OpenFeign 的核心价值之一，就是为每个客户端制造一块可隔离的配置空间。

## 四、最小总图：Spring 怎么把接口变成 Feign client

```text
@EnableFeignClients
    ↓
FeignClientsRegistrar
    ↓
FeignClientSpecification
    ↓
FeignClientFactoryBean / lazy BeanDefinition
    ↓
FeignClientFactory (NamedContextFactory)
    ↓
child context
    ↓
FeignClientsConfiguration + client-specific config
    ↓
Feign.Builder
    ↓
Targeter.target(...)
    ↓
OpenFeign proxy
```

这里最重要的边界是：

- Spring 负责扫描、注册、分配子上下文、收集 Bean。  
- OpenFeign core 负责 builder、metadata、handler 和最终 HTTP runtime。  

所以 Spring Cloud OpenFeign 不是新的 runtime，而是 Feign client 的制造桥。

这里再给一个更准确的心智模型：registrar、child context、FactoryBean、SpringMvcContract 这四个对象不是一条固定顺序的流水线，而是这条制造桥在不同阶段扮演的不同角色。

- **发现阶段**由 registrar 负责：找到 `@FeignClient` 接口并注册 BeanDefinition。  
- **配置阶段**由 child context 负责：为这个 client 准备独立的 Bean 空间。  
- **组装阶段**由 FactoryBean 负责：从 child context 拿组件，装进 Feign.Builder。  
- **契约适配**由 SpringMvcContract 负责：让 Spring 风格注解也能进入 Feign 的 metadata 模型。

读者不要把这四者当成"第一步 registrar、第二步 child context、第三步 FactoryBean、第四步 SpringMvcContract"的线性流水线，而要理解它们是分居不同阶段的接口。

## 五、`@EnableFeignClients` 与 `FeignClientsRegistrar`

### 5.1 `@EnableFeignClients` 只是导入 registrar

`@EnableFeignClients` 本身不创建 client，它只是：

```java
@Import(FeignClientsRegistrar.class)
```

`EnableFeignClients.java:41` — 导入 Registrar

它提供的只是扫描范围、默认 configuration、显式 clients 列表等入口参数。

### 5.2 registrar 才开始接管接口

`FeignClientsRegistrar.registerBeanDefinitions(...)` 会先注册默认 configuration，再扫描或读取显式声明的 `@FeignClient` 接口。

`FeignClientsRegistrar.java:152` — registerBeanDefinitions
`FeignClientsRegistrar.java:157` — register default configuration
`FeignClientsRegistrar.java:172` — scan / explicit clients path

### 5.3 `FeignClientSpecification`：每个 client 的配置说明书

对每个 `@FeignClient`，registrar 不只注册 FactoryBean，还会单独注册一个 `FeignClientSpecification`，用来保存这个 client 的专属 configuration 信息。

`FeignClientsRegistrar.java:463` — 注册 `FeignClientSpecification`

这一步很重要，因为后面的 named child context 就靠它来知道：

- 当前 client 有哪些专属配置类  
- 还要叠加哪些 default configuration

### 5.4 eager 与 lazy attributes resolution

registrar 有两条注册路径：

- eager：直接把 `FeignClientFactoryBean` 作为 BeanDefinition 类型注册  
- lazy：注册接口类型的 BeanDefinition，并通过 Supplier 延迟调用 `factoryBean.getObject()`

`FeignClientsRegistrar.java:222` — eager register `FeignClientFactoryBean`
`FeignClientsRegistrar.java:266` — lazy attributes resolution path

所以“Spring 容器里看到的是不是 FactoryBean”本身也是配置相关的，不是固定形态。

## 六、`FeignClientFactory`：为什么每个客户端要有 child context

### 6.1 它本质上是 `NamedContextFactory`

`FeignClientFactory` 直接继承 `NamedContextFactory<FeignClientSpecification>`。

`FeignClientFactory.java:39` — extends `NamedContextFactory`
`FeignClientFactory.java:47` — 默认配置类型 = `FeignClientsConfiguration`

这意味着每个 named client 都可以有自己的子上下文。

### 6.2 子上下文不是启动时全量创建的

`NamedContextFactory.getContext(name)` 是按需创建的：第一次请求某个 client 对应的 Bean 时，才会创建这个 child context。

`NamedContextFactory.java:119` — lazy create child context

### 6.3 子上下文里注册什么

`NamedContextFactory.registerBeans(...)` 会按顺序注册：

1. 当前 client 自己的 configuration  
2. `@EnableFeignClients.defaultConfiguration`  
3. `FeignClientsConfiguration`

`NamedContextFactory.java:143` — registerBeans
`NamedContextFactory.java:187` — child context parent

这说明 child context 不是“完全隔离”，它仍然可以继承 parent context 的 Bean，但同时又能为每个 client 提供一块独立配置空间。

## 七、`FeignClientsConfiguration`：默认给每个 client 什么

`FeignClientsConfiguration` 是每个 child context 的默认配置底座。它至少提供：

- `Decoder`
- `Encoder`
- `Contract`
- `Retryer`
- prototype `Feign.Builder`

`FeignClientsConfiguration.java:102` — default decoder
`FeignClientsConfiguration.java:108` — default encoder
`FeignClientsConfiguration.java:145` — `SpringMvcContract`
`FeignClientsConfiguration.java:160` — default `Retryer.NEVER_RETRY`
`FeignClientsConfiguration.java:203` — prototype `Feign.Builder`

这里有一个对读者非常重要的事实：**Spring Cloud OpenFeign 的默认 Contract 不是 OpenFeign core 的 DefaultContract，而是 `SpringMvcContract`。**

默认 Retryer 也是一个值得注意的差异：`Retryer.NEVER_RETRY` 意味着 Spring Cloud 环境下默认不开启重试。如果你在 Spring Cloud 中遇到调用失败后没有自动重试，不要先怀疑 OpenFeign core 的 Retryer 配置没生效，而是 Spring Cloud 的默认配置就是不开重试。

## 八、`FeignClientFactoryBean`：真正创建 client proxy 的桥对象

### 8.1 `getObject()` 才是创建时机

`FeignClientFactoryBean` 作为 `FactoryBean`，真正的代理创建发生在 `getObject()`。

`FeignClientFactoryBean.java:454` — `getObject()`
`FeignClientFactoryBean.java:465` — `getTarget()`

这一步才真正把 Spring 世界里的配置和 Bean，喂进 OpenFeign core 的 builder。

### 8.2 `feign(context)`：从 child context 取组件

FactoryBean 会先从 `FeignClientFactory` 对应的 child context 中拿到：

- `Feign.Builder`
- `Logger`
- `Encoder`
- `Decoder`
- `Contract`

`FeignClientFactoryBean.java:135` — `feign(context)`

然后再执行 `configureFeign(...)`，把 properties、configurer、interceptor、capability 等额外组装进去。

`FeignClientFactoryBean.java:166` — `configureFeign(...)`
`FeignClientFactoryBean.java:256` — properties 覆盖顺序

### 8.3 有 URL 和没 URL 是两条路径

- 如果显式配置了 `url`，FactoryBean 会把它组装进 builder，再通过 `Targeter.target(...)` 进入 OpenFeign core。  
- 如果没有 `url`，则会构造逻辑 URL（如 `http://serviceName`），然后走 `loadBalance(...)` 入口。

`FeignClientFactoryBean.java:483` — URL 存在时路径
`FeignClientFactoryBean.java:427` — `loadBalance(...)`

这一步是后续 LoadBalancer 篇的真正接缝，但在本篇里只需要知道：**没有显式 URL 时，Spring Cloud 会把 service name 当成逻辑 target 接进后续负载均衡层。**

## 九、`SpringMvcContract`：它在这条桥里的位置

`SpringMvcContract` 是 Spring MVC 风格注解和 OpenFeign `MethodMetadata` 之间的适配器。

`SpringMvcContract.java:98` — 类型定义

它的位置应该这样理解：

- OpenFeign core 只认 `Contract -> MethodMetadata` 这套接口  
- Spring Cloud 不重写 Feign metadata 模型，而是提供一个新的 Contract 实现，让 Spring MVC 注解也能落进同样的 MethodMetadata / RequestTemplate 主线

所以它是“Spring annotations -> Feign metadata”的桥，不是 Spring MVC Controller 机制的一部分。

它与 OpenFeign core 的 `DefaultContract` 最大的区别在于：它把 `@RequestMapping`、`@GetMapping`、`@PostMapping`、`@PathVariable`、`@RequestParam`、`@RequestHeader` 等 Spring 注解分类成对应的 metadata 参数角色，而不是 OpenFeign 原生的 `@RequestLine` / `@Param` / `@Headers`。这意味着你可以在 Feign client 接口上写 Spring MVC 风格的注解，而不用切换到 OpenFeign 自己的注解体系。

## 十、误解澄清

### 误解一：`@EnableFeignClients` 一打开就直接创建代理

不是。它只是导入 registrar，registrar 注册的是 BeanDefinition，不是最终 proxy。

### 误解二：`FeignClientFactoryBean` 是真正的 HTTP client

不是。它只是 FactoryBean，负责从 Spring child context 取组件，再调用 OpenFeign core 去造 proxy。

### 误解三：每个 `@FeignClient` 共用同一套 Bean 配置

不是。每个 contextId 都可以拥有独立的 child context 和专属 configuration。

### 误解四：`SpringMvcContract` 就是 Spring MVC Controller 映射机制

不是。它只是一个 `Contract` 适配器，把 Spring MVC 注解翻成 Feign metadata。

### 误解五：只要 Spring 容器里有 Feign client Bean，就说明 OpenFeign runtime 早就 ready 了

不一定。拿到的是 Spring Cloud 制造出来的 Feign proxy，真正的方法 metadata、template 填充、HTTP 调用、retry/decoder 等 runtime 行为，仍然是调用期才发生的 OpenFeign core 逻辑。

### 误解六：`@FeignClient(name = "foo")` 没配 url，就等于直连

不是。没有显式 `url` 时，Spring Cloud 不会直接拿 `name` 当真实地址，而是把它转成 `http://serviceName` 这个逻辑 URL，再交给 `FeignBlockingLoadBalancerClient` 去解析。所以「不配 url」不是「直连」，而是「让 LoadBalancer 来决定连哪里」。

## 十一、收网总结：Spring Cloud OpenFeign 是 Feign client 的制造桥

回到开头的问题：为什么“加个注解”不等于立刻有代理？

因为 Spring Cloud OpenFeign 的价值不在“直接创造 HTTP 调用”，而在“把 Spring 世界里的接口、BeanDefinition、配置和生命周期，翻译成 OpenFeign core 能消费的 builder 和 proxy”。

这条桥的核心对象是：

- `FeignClientsRegistrar`
- `FeignClientSpecification`
- `FeignClientFactory`
- `FeignClientFactoryBean`
- `FeignClientsConfiguration`
- `SpringMvcContract`

它们共同完成的是：

```text
annotation / configuration
    → bean definition / child context
    → Feign.Builder
    → OpenFeign proxy
```

**三句话总结：**

1. Spring Cloud OpenFeign 不是第二套 Feign runtime，而是 Feign client 的 Spring 制造桥。  
2. 每个 `@FeignClient` 最终依赖的是一个 named child context，而不是一份全局共享 Feign 配置。  
3. `FeignClientFactoryBean.getObject()` 是真正把 Spring 组件接回 OpenFeign core 的时刻。  

**下篇预告：** 下一篇进入 `SpringMvcContract / 配置属性 / per-client configuration`，继续把 Spring 风格注解和 client-specific 配置如何落回 Feign metadata 与 Builder 打透。