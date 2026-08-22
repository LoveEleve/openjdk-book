# Spring Cloud OpenFeign：SpringMvcContract、配置属性与 per-client 配置

> 基于 Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1

## 一、困惑开场：Spring MVC 注解怎么变成 Feign 请求

在 `@FeignClient` 接口里，你通常不会写 `@RequestLine` 或 `@Param` 这种 Feign 原生注解，而是写我们在 Controller 里常用的：

```java
@FeignClient("user-service")
interface UserClient {
    @GetMapping("/users/{id}")
    User get(@PathVariable("id") String id,
             @RequestParam("verbose") boolean verbose);
}
```

问题是：Feign core 根本不认识 `@GetMapping`、`@PathVariable`、`@RequestParam` 这些 Spring 注解。那它们是怎么被翻译成一次 HTTP 请求的？

如果 OpenFeign 只认 `@RequestLine("GET /users/{id}")`，那 Spring Cloud OpenFeign 就必须在某个地方把 Spring 风格注解转成 Feign 的 `MethodMetadata` 和 `RequestTemplate`。

这篇要回答的核心问题就是：**Spring MVC 注解最终是怎么落进 OpenFeign 那套 metadata/request 模型的，以及配置文件又是怎么决定每个 client 最终用什么配置的。**

## 二、前情回顾：上一卷讲了核心 Execution，这一篇讲 Spring 的注解适配和配置覆盖

在 OpenFeign core 篇里，我们已经知道：

- `Contract` 负责把接口注解解析成 `MethodMetadata` 和 `RequestTemplate`。
- `Feign.Builder` 在 build-time 组装 `Contract / Encoder / Decoder / Client` 等。

在上一篇 Spring Cloud OpenFeign 里，我们又知道：

- `@EnableFeignClients` 导入 registrar。
- `FeignClientFactoryBean` 从 named child context 取 Bean，再调用 `Feign.Builder` 造 proxy。

但上一篇并没有解释两件事：

1. `SpringMvcContract` 到底怎么把 Spring MVC 注解变成 Feign metadata。
2. Spring Cloud 的配置属性（`spring.cloud.openfeign.client.config.*`）为什么能覆盖 Java 配置类中的 Bean。

这一篇就是专门补这两层的。但要注意：这两层不是同一个问题的两面，而是两条独立的桥接入口——`SpringMvcContract` 解决的是"注解怎么被理解"，`FeignClientProperties` 解决的是"配置怎么被覆盖"。不要把两者当成同一条链上的先后步骤。

## 三、先走三条失败的路

### 失败方案一：Spring MVC 注解和 Feign 注解是两套完全独立的体系

如果这么认为，你会觉得 `SpringMvcContract` 是另一个独立的“翻译器”，和 OpenFeign core 的 `Contract` 毫无关系。

但实际上，`SpringMvcContract` 直接继承 `Contract.BaseContract`。它就是 Feign core 定义的 `Contract` 接口在 Spring 环境下的实现。所以表面上是两套注解，底层却是同一条 `Contract -> MethodMetadata -> RequestTemplate` 主线。

### 失败方案二：配置文件里的属性一定比 Java 配置类优先级更高

这取决于 `spring.cloud.openfeign.client.default-to-properties`。

- `true`：配置文件优先，Java 配置类最后才应用。
- `false`：Java 配置类优先，配置文件先应用。

所以不能说“properties 一定覆盖 Java config”。

### 失败方案三：`name` 和 `contextId` 是同一个东西

默认看起来相等，但 `name` 和 `contextId` 语义不同：

- `name` 是 service id，也是 LoadBalancer 用来选实例的标识。
- `contextId` 是 child context 的标识，也是配置覆盖时的 key。

显式指定 `contextId` 后，多个指向同一 service 的 client 就可以拥有各自独立的 child context 和配置空间。

## 四、最小总图：Spring 注解 + 配置属性 怎么变成 Feign client

```text
Spring MVC annotations
    ↓
SpringMvcContract (extends Contract.BaseContract)
    ↓
MethodMetadata + RequestTemplate
    ↓
Feign.Builder
    ↓
Feign proxy

FeignClientProperties
    ↓
default-to-properties 开关
    ↓
default config → client-specific config
    ↓
FeignClientFactoryBean.configureFeign(...)
```

这里有两个核心对象，但需要先钉死一个路标：**它们不是同一条链上的先后步骤，而是两条独立的桥接入口。**

- `SpringMvcContract`：把 Spring MVC 注解翻成 Feign metadata。这条链解决的是"注解怎么被理解"。
- `FeignClientProperties`：把 externalized 配置属性通过覆盖规则喂进 Feign Builder 组装。这条链解决的是"配置怎么被覆盖"。

读者不要把它们当成"先走 SpringMvcContract，再走 FeignClientProperties"的固定流水线。前者发生在 Contract 解析阶段，后者发生在 FeignClientFactoryBean 的 configure 阶段，它们在 Feign.Builder 的组装过程中才交汇。

## 五、`SpringMvcContract`：Spring 注解适配器

### 5.1 它真的只是 Feign `Contract` 的一个实现

`SpringMvcContract` 直接继承 `Contract.BaseContract`。

`SpringMvcContract.java:98` — 类型定义

这说明它不是一个平行于 Feign core 的“Spring HTTP 框架”，而是把自己挂进 Feign core 的 contract 接口上。

### 5.2 类级别：`@RequestMapping` 不允许出现在 `@FeignClient` 接口上

`SpringMvcContract` 会在类级别处理时拒绝 `@RequestMapping`。

`SpringMvcContract.java:226` — 类级 `@RequestMapping` 拒绝

这很容易被误解：很多读者以为 Controller 能在类上写 `@RequestMapping("/api")`，Feign client 接口也可以。但实现上明确禁止这一点。

### 5.3 方法级别：HTTP method / path / produces / consumes 怎么落进模板

`SpringMvcContract.parseAndValidateMetadata(...)` 会调用 core 的 `parseAndValidateMetadata` 后，再处理 Spring 注解。

`SpringMvcContract.java:240` — 解析入口

HTTP method 的处理逻辑：先看 `@RequestMapping` 的 `method()` 数组，如果没有则默认 `GET`，再写到 template。

`SpringMvcContract.java:298` — HTTP method 解析

path 会变成 `RequestTemplate.uri(...)`。

`SpringMvcContract.java:307` — path 解析

`produces` 会变成 `Accept` header，`consumes` 会变成 `Content-Type` header。

`SpringMvcContract.java:327` — produces / consumes

### 5.4 参数级别：`@PathVariable` / `@RequestParam` / `@RequestHeader` 怎么分类

参数由一组 `AnnotatedParameterProcessor` 处理。

`SpringMvcContract.java:360` — 参数处理器入口
`SpringMvcContract.java:479` — 内置处理器注册

内置支持：

- `@PathVariable` → URI variable
- `@RequestParam` → query parameter
- `@RequestHeader` → header template
- `@RequestPart` → form / multipart
- `@SpringQueryMap` → query map
- `@CookieValue` → cookie 相关参数

所以：

```java
@GetMapping("/users/{id}")
User get(
    @PathVariable("id") String id,
    @RequestParam("verbose") boolean verbose,
    @RequestHeader("X-Token") String token
);
```

会被 `SpringMvcContract` 翻译成：

- URI template 变量：id
- query 参数：verbose
- header 模板：X-Token

### 5.5 `MethodMetadata` 还要继续被 Feign core 消费

`SpringMvcContract` 最终产出的是标准 `MethodMetadata`，和 OpenFeign 原生 `@RequestLine` 解析出来的是同一个结构。这篇只需要知道它“挂进同一主线”，不需要重复讲 core 内部怎么用这份 metadata。

这些 metadata 最终会被 `SynchronousMethodHandler` 消费，在调用期生成 `RequestTemplate`，再通过 `Client.execute()` 发出 HTTP 请求——也就是第一篇 OpenFeign core 讲过的 runtime spine。

## 六、`FeignClientProperties`：配置覆盖规则

### 6.1 配置来源不是一个扁平表

Spring Cloud OpenFeign 的 per-client 配置至少有三层来源：

1. `@FeignClient(configuration = ...)` 直接提供的 Java 配置类
2. 默认 properties：`spring.cloud.openfeign.client.config.default.*`
3. client-specific properties：`spring.cloud.openfeign.client.config.<contextId>.*`

它们最终在 `FeignClientFactoryBean.configureFeign(...)` 里合并。

`FeignClientFactoryBean.java:166` — `configureFeign(...)`

### 6.2 `default-to-properties` 决定覆盖方向

`FeignClientFactoryBean.configureFeign(...)` 会先读 `default-to-properties`，再决定 Java configuration 和 properties 的先后顺序。

`FeignClientFactoryBean.java:173` — `default-to-properties` 分支

- 默认 `true`：先 Java configuration，再 properties，因此最终 properties 覆盖 Java config。
- `false`：先 properties，再 Java configuration，因此最终 Java config 覆盖 properties。

所以“properties 一定覆盖 Java config”是不成立的。

### 6.3 默认配置 → client-specific 配置

在 properties 内部，顺序是：

```text
default config
    → client-specific config
```

`FeignClientFactoryBean.java:256` — `configureUsingProperties(...)` 应用顺序

client-specific 配置会覆盖 default 配置。

### 6.4 典型可覆盖项

支持通过 properties 覆盖的项包括：

- `logger-level`
- `connect-timeout` / `read-timeout`
- `follow-redirects`
- `retryer`
- `error-decoder`
- `request-interceptors`
- `encoder` / `decoder`
- `contract`
- `capabilities`
- `default-request-headers`
- `default-query-parameters`

`FeignClientFactoryBean.java:269` — properties 应用顺序细节

这意味着很多你以前可能写在 `@FeignClient(configuration = ...)` 里的定制，其实可以直接写在 `spring.cloud.openfeign.client.config.<name>.*` 属性里。

这条对线上排障也很直接：如果你发现某个 client 的 timeout 配置没生效，不要只盯着 `@FeignClient(configuration = ...)` 里的 Java 配置类。先查 `spring.cloud.openfeign.client.config.<contextId>.*` 是否已经写入了正确的值，以及 `default-to-properties` 当前是 true 还是 false。

## 七、`name`、`contextId`、Bean name 到底有什么区别

这是 Spring Cloud OpenFeign 里最容易混淆的一组概念。

### 7.1 `name`：service id

`@FeignClient(name = "foo")` 的 `name` 在 LoadBalancer 场景下是 service id。

### 7.2 `contextId`：child context 标识

`contextId` 决定这个 client 使用哪个 child context，以及 `spring.cloud.openfeign.client.config.<contextId>.*` 这段配置。

Registrar 里，`getContextId(...)` 负责解析它。

`FeignClientsRegistrar.java:339` — `getContextId(...)`

### 7.3 Bean name：Spring 容器里的 Bean 名

在实际 Spring 容器中，Feign client 接口本身还会被注册成一个 Bean，Bean name 通常就是接口类名或携带 qualifier。

### 7.4 三者默认相等但不互锁

默认情况下 `name == contextId == Bean name`，看起来像一回事。但显式指定 `contextId` 后就会分离：多个 client 可以指向同一个 `name`（同一个服务），使用不同 `contextId`（不同 child context / 不同配置）。

## 八、`FeignBuilderCustomizer` 与 `Capability`：per-client 定制的另外两条入口

### 8.1 `FeignBuilderCustomizer`

这是 Spring Cloud OpenFeign 提供的 per-client builder 定制入口。它可以在 `FeignClientFactoryBean` 最终调用 builder.target 之前，对 `Feign.Builder` 做额外修改。

它和 properties 的区别在于：properties 按 key 覆盖，`FeignBuilderCustomizer` 是代码级的 builder 定制。

### 8.2 `Capability`

`Capability` 是 OpenFeign core 的 build-time decorator 协议。Spring Cloud OpenFeign 里可以通过 properties 或 configuration 注入 Capability，让同一份 capability 装饰多个 client 的多个组件。

它和 `FeignBuilderCustomizer` 的边界是：Capability 更偏“声明哪些横切能力要开”，`FeignBuilderCustomizer` 更偏“某个 builder 还需要哪种定制”。

## 九、误解澄清

### 误解一：`SpringMvcContract` 只是把 Spring 注解翻译成 OpenFeign 请求

部分对，但它本质上是 OpenFeign `Contract` 接口的一个实现，最终产出的是标准 `MethodMetadata`，不走第二套请求构造体系。

### 误解二：properties 一定覆盖 Java config

不一定。这取决于 `default-to-properties`。

### 误解三：`name` 和 `contextId` 可以随便互换

不能。`name` 是 service id，`contextId` 是 child context key。

### 误解四：Feign client 接口可以在类上写 `@RequestMapping`

不能。`SpringMvcContract` 明确拒绝类级 `@RequestMapping`。

### 误解五：配置只能写在 `@FeignClient(configuration = ...)` 里

不是。`spring.cloud.openfeign.client.config.*` properties 和 `FeignBuilderCustomizer` / `Capability` 都是另一类配置入口。

### 误解六：我在 Java 配置类和 properties 里都配了同一项，最终生效的一定是我预期的那一个

不一定。如果 `default-to-properties` 为 true，properties 会覆盖 Java 配置类；如果为 false，Java 配置类会覆盖 properties。所以“预期”不一定等于“实际生效顺序”。

## 十、收网总结：Spring 注解和配置，都是通过同一条 Feign 主线生效的

回到开头的问题：Spring MVC 注解为什么能被 Feign 理解？

因为 `SpringMvcContract` 是 Feign `Contract` 的实现，它把 Spring 注解落进标准 `MethodMetadata`，而不是绕开 Feign 主线。配置文件则通过 `FeignClientProperties` 的覆盖规则进入 builder 组装，和 Java 配置类共同决定最终 Feign 行为。

**三句话总结：**

1. `SpringMvcContract` 是 Spring MVC 注解和 Feign `MethodMetadata` 之间的契约桥，本质上仍是 OpenFeign `Contract` 的实现。
2. `FeignClientProperties` 通过 `default-to-properties` 和 `default -> client-specific` 的规则，决定配置属性与 Java 配置类的先后顺序。
3. `name` 是 service id、`contextId` 是 child context key、Bean name 是 Spring Bean 名，默认相等但不互锁。

**下篇预告：** 下一篇进入 LoadBalancer 如何接管 Feign Client，看没有显式 url 时 service name 是怎样被转成逻辑 target、再被负载均衡解析的。