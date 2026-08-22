# Spring Cloud OpenFeign：Micrometer、Observation 与 Capability

> 基于 Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1

## 一、困惑开场：Feign 的 Micrometer 到底挂在哪一层

很多人第一次看 Spring Cloud OpenFeign 的监控集成时，都会把几件事混在一起：

- `MicrometerObservationCapability` 和 `MicrometerCapability` 到底谁生效
- `FeignClientMicrometerEnabledCondition` 是全局开关还是单 client 开关
- Feign 的 metrics 到底是包在 `Client` 上，还是像 CircuitBreaker 一样挂在 InvocationHandler 上
- `Capability` 和 `RequestInterceptor`、LoadBalancer、CircuitBreaker 是不是一类东西

如果这几个问题不先拆开，后面越看越乱，因为它们分属三层：

- Spring Cloud 的 child context 装配层
- Feign core 的 builder enrichment 层
- Micrometer/Observation 的 HTTP 观测层

这篇要回答的核心问题只有一个：**Spring Cloud OpenFeign 到底怎样把 observability 接进 Feign，而且它接入的是哪一层。**

先把答案放在前面：Spring Cloud OpenFeign 并不是直接硬编码一段 metrics 逻辑进 Feign client，而是在每个 Feign client 的 child context 里按条件注册一个 `Capability` bean；随后 `FeignClientFactoryBean` 统一把这些 capability 通过 `builder.addCapability(...)` 塞回 Feign.Builder。于是 observability 在这里不是 Targeter 层，也不是单纯的 Client 替换层，而是 **Feign core 自己的 builder enrichment 扩展点**。

## 二、前情回顾：上一篇是 InvocationHandler 装饰器，这一篇是 Builder enrichment

上一篇 CircuitBreaker 讲的是另一种集成方式：Spring Cloud 替换 `Feign.Builder` 和 `Targeter`，最后由 `FeignCircuitBreakerInvocationHandler` 在 InvocationHandler 层包住每次方法调用。

再往前一篇 LoadBalancer 讲的是 Client 层：`FeignBlockingLoadBalancerClient` 在 `Client.execute()` 位置选实例、重写请求地址。

这一篇的 Micrometer/Observation 又是第三种层级：它不是通过 Targeter 造代理，也不是单独替换一个 `Client` 就结束，而是借助 Feign core 的 `Capability` 机制，在 builder 构建阶段统一增强内部组件。

所以这三篇放在一起看时，分层应该是：

- LoadBalancer：Client replacement 层
- CircuitBreaker：InvocationHandler / Targeter 层
- Micrometer / Observation：Builder enrichment 层

## 三、先走三条失败的路

### 失败方案一：`MicrometerObservationCapability` 和 `MicrometerCapability` 会一起挂上去

直觉上很容易这么想：Observation 负责 trace，MicrometerCapability 负责 metrics，那两个都挂上不是最合理吗？

但 Spring Cloud OpenFeign 的默认策略不是叠加，而是优先级选择。

在 `FeignClientsConfiguration.MicrometerConfiguration` 中，如果存在 `ObservationRegistry`，就注册 `MicrometerObservationCapability`；只有当没有 observation capability、但有 `MeterRegistry` 时，才退回到 `MicrometerCapability`。后者还带着 `@ConditionalOnMissingBean({ MicrometerCapability.class, MicrometerObservationCapability.class })`，这意味着默认不会双挂。

所以默认结论是：**有 ObservationRegistry 时优先 observation，没有时才退回 legacy metrics。**

`FeignClientsConfiguration.java:239` 定义了 micrometer 配置类本身。  
`FeignClientsConfiguration.java:247` 定义 `MicrometerObservationCapability` bean。  
`FeignClientsConfiguration.java:253` 定义 `MicrometerCapability` bean。  

### 失败方案二：`FeignClientMicrometerEnabledCondition` 是全局开关

很多人看到这个名字，会以为它决定整个应用是否开启 Feign Micrometer。

但真正的全局开关是：

`spring.cloud.openfeign.micrometer.enabled`

它控制的是整个 `MicrometerConfiguration` 配置类是否参与装配。只有这个总闸门打开后，`FeignClientMicrometerEnabledCondition` 才有机会继续判断。

而 `FeignClientMicrometerEnabledCondition` 自己只做一件事：读取当前 child context 对应 client 的 `spring.cloud.openfeign.client.config.<clientName>.micrometer.enabled`。如果这个值显式是 `false`，当前 client 就禁用；如果缺省，就视为启用。

所以它是**单 client 级别的 opt-out 条件**，不是全局总开关。

`FeignClientMicrometerEnabledCondition.java:31` 是条件判断入口。  
`FeignClientFactory.java:47` 说明 child context 会放入当前 `clientName`。  
`FeignClientProperties.java:365` 说明 client 级别 `micrometer.enabled` 默认是开启语义。  

### 失败方案三：Capability 和 CircuitBreaker / LoadBalancer 是同一种扩展点

如果把这三种机制都看成"Feign 增强器"，就很容易写混。

但它们根本不是一层：

- LoadBalancer 主要替换 `Client` 实现
- CircuitBreaker 主要替换 Builder 类型与 Targeter，再在 InvocationHandler 层包住调用
- Capability 是 Feign core builder 阶段的统一增强接口，它可以包装 `Client`、`Encoder`、`Decoder`、`InvocationHandlerFactory` 等多个组件

所以 Micrometer 这篇真正要讲清的不是"它也包装了 Client"，而是：**它通过 Capability 进入 Feign.Builder，随后由 Feign core 的 `enrich()` 过程决定增强哪些组件。**

## 四、最小总图：child context → capability bean → builder.addCapability → enrich

```text
FeignAutoConfiguration
    ↓
FeignClientFactory 为每个 client 建 child context
    ↓
FeignClientsConfiguration.MicrometerConfiguration
    ├─ 全局开关允许？
    ├─ 当前 client 没有显式禁用？
    ├─ 有 ObservationRegistry？→ MicrometerObservationCapability
    └─ 否则有 MeterRegistry？→ MicrometerCapability
    ↓
FeignClientFactoryBean.configureFeign()
    ↓
builder.addCapability(capability)
    ↓
OpenFeign BaseBuilder.build()
    ↓
BaseBuilder.enrich()
    ↓
Capability.enrich(Client/Encoder/Decoder/InvocationHandlerFactory/...)
```

这张图里最关键的一跳不是 capability bean 的创建，而是 **`builder.addCapability(...)` 之后真正进入了 Feign core 的 `BaseBuilder.enrich()`**。这说明 Spring Cloud 在这里主要扮演"挑 capability、塞 capability"的角色，真正如何增强组件，是 Feign core 自己的机制。

`FeignClientFactoryBean.java:247` 说明会从 child context 收集 capability beans。  
`FeignClientFactoryBean.java:327` 说明也可从 properties 中声明 capability 类。  
OpenFeign `feign/BaseBuilder.java:259` 是 `addCapability(...)` 入口。  
OpenFeign `feign/BaseBuilder.java:265` 是 `enrich()` 主入口。  
OpenFeign `feign/BaseBuilder.java:385` 说明 `build()` 会先执行 `enrich()` 再 `internalBuild()`。  
OpenFeign `feign/Capability.java:38` 说明多个 capability 会按链式方式逐个 enrich 同一个组件。  

## 五、全局开关与单 client 开关：两级闸门

### 5.1 第一级闸门：全局开关

Micrometer 配置类本身带了全局条件。只要：

`spring.cloud.openfeign.micrometer.enabled=false`

那么整个 `MicrometerConfiguration` 都不会装，所有 client 都失去默认的 micrometer capability。

这是总闸门，它作用在配置类级别，而不是某个具体 bean 上。

`FeignClientsConfiguration.java:239` 是配置类入口。  
`FeignClientDisabledFeaturesTests.java:62` 验证全局禁用后 micrometer capability 不再进入 child context。  

### 5.2 第二级闸门：单 client 开关

如果全局闸门允许，再看单 client 级别的配置：

`spring.cloud.openfeign.client.config.<clientName>.micrometer.enabled=false`

此时只会关闭当前 client 的 capability 注册，不影响其他 client。

这里有个特别关键的细节：`FeignClientMicrometerEnabledCondition` 是在 child context 内运行的，它通过 `spring.cloud.openfeign.client.name` 取到当前 client 名，再去 `FeignClientProperties` 中找对应条目。

所以它不是在全局应用上下文里做一遍全集判断，而是**每个 Feign client 建自己 child context 时，都重新评估一次**。

`FeignClientFactory.java:47` 把当前 clientName 放入环境。  
`FeignClientMicrometerEnabledCondition.java:40` 读取这个 clientName。  
`FeignClientDisabledClientLevelFeaturesTests.java:64` 验证 `foo` 可禁用而 `bar` 保持开启。  

### 5.3 优先级结论

把两级闸门串起来，优先级就是：

1. 全局 `micrometer.enabled=false`：全部关闭
2. 全局打开或缺省：进入单 client 判断
3. 单 client 显式 `false`：只关闭当前 client
4. 单 client 未配置：默认开启

所以单 client 的 `true` 大多数时候只是重复默认值，真正有意义的是单 client `false`。

## 六、Observation 优先，legacy metrics 兜底

### 6.1 为什么会有两套 capability

这是 Spring Cloud OpenFeign 与 OpenFeign micrometer 模块演进叠加的结果。

- `MicrometerObservationCapability` 走新的 Micrometer Observation 路径
- `MicrometerCapability` 走旧的 pure metrics 路径

前者更贴近统一的 observation/tracing/metrics 语义，后者更像传统的指标包装器。

### 6.2 ObservationCapability 覆盖什么

`MicrometerObservationCapability` 的核心是 enrich Feign 的 `Client` / `AsyncClient`，在 HTTP client 执行前后开启 observation、记录错误、写入 response，再结束 observation。

所以它主要覆盖的是 **HTTP exchange 这一层**，不是 builder 创建时机，也不是 Java 接口方法本身的调用计时。

OpenFeign `feign/micrometer/MicrometerObservationCapability.java:45` 是同步 `Client` 的核心入口。  
OpenFeign `feign/micrometer/MicrometerObservationCapability.java:72` 是 `AsyncClient` 的对应路径。  
OpenFeign `feign/micrometer/DefaultFeignObservationConvention.java:41` 定义默认 observation name 为 `http.client.requests`。  
OpenFeign `feign/micrometer/DefaultFeignObservationConvention.java:46` 定义 contextual name。  
OpenFeign `feign/micrometer/DefaultFeignObservationConvention.java:51` 定义默认低基数 tags。  

默认语义大致是：

- observation name：`http.client.requests`
- contextual name：`HTTP GET` 之类
- 低基数标签：方法、模板 URL、状态码、client 名称等

所以 observation 路径更像是把 Feign 请求接进 Micrometer Observation 生态，而不是对每个 Feign 组件都打点。

### 6.3 MicrometerCapability 覆盖什么

`MicrometerCapability` 的覆盖面反而更广。

OpenFeign `feign/micrometer/MicrometerCapability.java:59` 说明它会包装 `Client`。  
OpenFeign `feign/micrometer/MicrometerCapability.java:64` 说明它会包装 `AsyncClient`。  
OpenFeign `feign/micrometer/MicrometerCapability.java:69`、`feign/micrometer/MicrometerCapability.java:74`、`feign/micrometer/MicrometerCapability.java:79` 说明它还能包装 `Encoder`、`Decoder`、`InvocationHandlerFactory`。  

它不仅能 enrich `Client` / `AsyncClient`，还能 enrich：

- `Encoder`
- `Decoder`
- `InvocationHandlerFactory`

这意味着 legacy metrics 路径不只计 HTTP 请求本身，还可能计：

- 编码耗时
- 解码耗时
- Feign Java 方法调用计时/错误数
- 响应体大小等

所以不要简单把 `MicrometerCapability` 看成"旧版 Observation"。两者不是只差接口名，而是**覆盖范围和语义模型都不同**。

### 6.4 为什么 Observation 优先

Spring Cloud 的选择很明确：如果 observation 能用，就先用 observation。只有 observation 不可用时，才回退到旧的 metrics capability。

因此默认世界观是：**Observation 是主路径，MicrometerCapability 是兼容兜底路径。**

`FeignClientsMicrometerAutoConfigurationTests.java:44` 验证 observation 优先。  
`FeignClientsMicrometerAutoConfigurationTests.java:57` 验证只有 `MeterRegistry` 时退回 legacy metrics。  
`FeignClientsMicrometerAutoConfigurationTests.java:66` 验证禁用或缺条件时不装 capability。  

## 七、`Capability` 在 Feign core 里到底挂在哪

### 7.1 Spring Cloud 只负责把 capability 放进去

Spring Cloud OpenFeign 这一侧最重要的动作，其实很克制：

- 在 child context 中注册 capability bean
- 在 `FeignClientFactoryBean` 中收集它们
- 统一调用 `builder.addCapability(...)`

也就是说，Spring Cloud 并不亲自决定怎么包装 `Client`、怎么包装 `Decoder`，它只负责把 capability 塞进 builder。

### 7.2 真正生效的是 `BaseBuilder.enrich()`

进入 OpenFeign core 后，`BaseBuilder.build()` 会进入 `enrich()` 流程。这里 builder 会遍历自己的组件字段，再让 capability 逐个判断能不能 enrich 这些组件。

所以 `Capability` 的本质不是"请求拦截器"，而是 **builder 内部组件替换/包装协议**。

只要某个 capability 实现了对某种组件类型的 enrich，它就能在构建期把原组件换成包装后的组件。

这就是为什么：

- 有的 capability 只包 `Client`
- 有的 capability 能连 `Encoder` / `Decoder` / `InvocationHandlerFactory` 一起包

### 7.3 这和 RequestInterceptor 不一样

`RequestInterceptor` 只对请求模板生效，本质上改的是发请求前的模板内容。

`Capability` 不只碰请求模板，它可以改造 builder 内部核心部件，因此层级更低、更靠近 Feign runtime spine。

所以如果把 capability 理解成"高级一点的 interceptor"，就会低估它的作用范围。

## 八、和 CircuitBreaker、LoadBalancer 的层级对比

现在把最近三篇并起来看，层级终于能排清楚了。

### 8.1 LoadBalancer：transport routing 层

LoadBalancer 主要是提供不同的 `Client` 实现，比如 `FeignBlockingLoadBalancerClient`。它负责在请求发出前按 serviceId 选实例、重建 URI。

所以它主要是 transport routing 层。

### 8.2 CircuitBreaker：proxy invocation 层

CircuitBreaker 通过替换 Builder 与 Targeter，最终由 `FeignCircuitBreakerInvocationHandler` 包住每次方法调用。

所以它主要是 proxy invocation 层。

### 8.3 Capability：builder enrichment 层

Micrometer/Observation 这一篇讲的 capability，则是在 Feign builder 构建期统一增强内部组件。

所以它主要是 builder enrichment 层。

### 8.4 为什么这个对读者重要

因为一旦层级搞清楚，很多误解自然消失：

- 你不会再问"CircuitBreaker 为什么不写成 capability"
- 你不会再问"LoadBalancer 为什么不是 Targeter"
- 你也不会把 `FeignClientMicrometerEnabledCondition` 当成 InvocationHandler 的开关

它们根本工作在不同层。

## 九、误解澄清

### 误解一：Observation 和 legacy metrics 默认会双挂

不是。默认是 observation 优先，legacy metrics 兜底，二者默认二选一。

### 误解二：`FeignClientMicrometerEnabledCondition` 是全局开关

不是。它是 child context 内对当前 client 的单独判断。

### 误解三：Capability 就是 RequestInterceptor

不是。Capability 是 Feign core builder 阶段的组件增强点，层级更低。

### 误解四：Micrometer 这篇和上一篇 CircuitBreaker 是同一种接入方式

不是。CircuitBreaker 走 Builder/Targeter/InvocationHandler 线，Micrometer 走 builder enrichment capability 线。

### 误解五：Observation 路径和 legacy metrics 路径只是命名不同

不是。Observation 主要围绕 HTTP exchange，legacy metrics 的覆盖面通常更广，可触达 `Encoder`、`Decoder`、`InvocationHandlerFactory`。

## 十、收网总结：observability 在这里是 Feign core 的 Capability 扩展点

回到开头的问题：Spring Cloud OpenFeign 的 observability 到底挂在哪一层？

答案是：它先在 Spring Cloud 的 child context 装配层挑选 capability，再通过 `FeignClientFactoryBean` 进入 Feign core 的 `builder.addCapability(...)`，最终在 `BaseBuilder.enrich()` 里真正生效。

所以这篇最重要的结论不是"Feign 支持 Micrometer"，而是：**Spring Cloud OpenFeign 通过 Capability 把 observability 接进 Feign core，而 Capability 本质上是 builder enrichment 扩展点。**

再压缩成三句话：

1. 全局 `spring.cloud.openfeign.micrometer.enabled` 决定 micrometer 配置类是否参与；单 client `spring.cloud.openfeign.client.config.<name>.micrometer.enabled=false` 只关闭当前 client。  
2. 有 `ObservationRegistry` 时优先注册 `MicrometerObservationCapability`，否则在有 `MeterRegistry` 时退到 `MicrometerCapability`；默认不会双挂。  
3. Micrometer 这条线走的是 `Capability -> builder.addCapability -> BaseBuilder.enrich()`，它和 LoadBalancer 的 Client replacement、CircuitBreaker 的 InvocationHandler/Targeter 是三种不同层级的扩展方式。
