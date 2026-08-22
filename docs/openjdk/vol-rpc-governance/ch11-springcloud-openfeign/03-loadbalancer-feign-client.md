# Spring Cloud OpenFeign：LoadBalancer 如何接管 Feign Client

> 基于 Spring Cloud OpenFeign 4.3.2 + Spring Cloud LoadBalancer + OpenFeign 13.6.1

## 一、困惑开场：`http://orders` 是怎么变成真实请求的

假设你有这样一段代码：

```java
@FeignClient(name = "orders")
interface OrderClient {
    @GetMapping("/api/orders/{id}")
    Order get(@PathVariable("id") Long id);
}
```

注意，这里没有 `url`，只有 `name = "orders"`。直觉上你会以为：Feign 拿到了 service name `orders`，于是去服务注册中心里找 `orders` 的实例，然后选择一个发请求。

这个直觉基本对，但容易让人误以为"负载均衡发生在创建 client 的时候"。

实际上，Feign 本身完全不做负载均衡。它只做两件事：

1. 把 `name` 包装成一个逻辑 target（`http://orders`）
2. 把 Feign 的 `Client` 替换成 `FeignBlockingLoadBalancerClient`

真正的 `choose()` 发生在**每次请求时**：从 `request.url()` 的 host 里读出 `orders`，调用 LoadBalancer 选一个真实实例，再把逻辑 URL 重建为真实 host，最后交给底层 HTTP client 发出。

所以这篇文章要回答的核心问题是：**Feign 和 LoadBalancer 的桥到底是什么，谁在什么时候把 serviceId 变成真实 host。**

## 二、前情回顾：前几篇讲的是 Feign 的制造桥与配置桥

在 Spring Cloud OpenFeign 第一篇里，我们已经知道：

- `FeignClientsRegistrar` 把 `@FeignClient` 接口注册成 `FeignClientFactoryBean`
- `FeignClientFactory` 为每个 `contextId` 创建 child context

在第二篇里，我们又知道：

- `SpringMvcContract` 处理 Spring MVC 注解
- `FeignClientProperties` 决定 Java 配置和 properties 的覆盖顺序

但这两篇都没有深入一个问题：当接口没有 `url` 时，那个逻辑 target `http://orders` 是怎么在运行时变成真实 host 的。

换句话说，如果前两篇讲的是"制造桥"和"配置桥"，这一篇要讲的是第三座桥：**serviceId 桥——从逻辑 target 变成真实 host/port 的桥。**

所以这一篇专讲这一点，边界非常明确：只讲 Feign 与 LoadBalancer 的集成链路，不展开 RoundRobin 算法和 supplier 组合细节。

## 三、先走三条失败的路

### 失败方案一：Feign 使用了 `@LoadBalanced`

`@LoadBalanced` 是 Spring Cloud Commons 里的一个 qualifier，只有 `LoadBalancerAutoConfiguration` 会读取它，用来标记 `RestTemplate` / `RestClient` / `WebClient` 需要被 LoadBalancer 包装。

Feign 完全不会读取 `@LoadBalanced`。Feign 的触发点是"没有 `url`"。所以如果你在 Feign client 上同时写 `@LoadBalanced`，它其实是无效的——Feign 走的是自己的那条 loadBalance 路径。

### 失败方案二：每个 Feign client 都有自己独立的 LoadBalancer 配置

这有两个层面要拆开。

Feign 的 per-client context（`FeignClientFactory`）和 LoadBalancer 的 per-service context（`LoadBalancerClientFactory`）是两个**兄弟 context**，它们之间不是继承关系。

更重要的是，`FeignBlockingLoadBalancerClient` 本身是根上下文里的一个全局单例，由所有 Feign client 共享。它没有在创建时固定某个 serviceId，而是在每次请求时从 `request.url().getHost()` 动态读取。

所以"每个 Feign client 有独立的 LB 配置"不对，更准确的是：每个 Feign client 共享同一个 LB 装饰器，但每次请求会动态选择对应 service 的 LB 配置。

### 失败方案三：有显式 url 时也会走负载均衡

正好相反。当 `@FeignClient` 提供了显式 `url` 时，`FeignClientFactoryBean.getTarget()` 会通过 `getDelegate()` 把 `FeignBlockingLoadBalancerClient` 解包掉，让 Feign 直接使用原始 HTTP client。

测试证明：有 url 的 builder 里设置的 Client 是原始 `ApacheHttp5Client`、`OkHttpClient` 等，而不是 LB 装饰器。

所以：

- 有 `url` = 直连，不走负载均衡
- 没有 `url` = LoadBalancer 接管

## 四、最小总图：Feign 到 LoadBalancer 的五跳

```text
@FeignClient(name = "orders")  // 无 url
    ↓
FeignClientFactoryBean.getTarget()
    ↓
逻辑 URL: http://orders
    ↓
builder.client(FeignBlockingLoadBalancerClient)
    ↓ 每次方法调用
FeignBlockingLoadBalancerClient.execute(Request)
    ↓ host 提取 serviceId = "orders"
LoadBalancerClient.choose("orders", request)
    ↓ Mono.from(...).block()
RoundRobinLoadBalancer / ServiceInstanceListSupplier
    ↓
reconstructURI(instance, uri)  // serviceId → 真实 host/port
    ↓
delegate.execute(Request)  // 真实 HTTP
```

这张图最核心的是：Feign 和 LoadBalancer 之间隔着一个**请求时按 serviceId 动态选路的装饰器**，而不是 client 创建时的固定装配。

## 五、`FeignClientFactoryBean.getTarget()`：url 决策分叉

这里先做一个路标。下面这一节讲的是"client 创建阶段的决策分叉"——到底走直连还是走 LoadBalancer；从第六节开始，才进入"真正的 LoadBalancer 运行时选路"。也就是说，第五节是装配期，第六节之后才是每一次请求时都会重复发生的事。

### 5.1 没有 url 时的逻辑 target

`getTarget()` 里有一个判断：

```java
if (!StringUtils.hasText(url) && !isUrlAvailableInConfig(contextId)) {
    // 走 loadBalance 路径
}
```

`FeignClientFactoryBean.java:469` — 无 url → loadBalance 路径

接下来它合成逻辑 URL：如果 `name` 不是以 `http(s)://` 开头就补上，然后追加 cleanPath。

`FeignClientFactoryBean.java:474` — 逻辑 URL 合成
`FeignClientFactoryBean.java:481` — `loadBalance(...)`

所以 `@FeignClient(name = "orders")` 最终生成的是 `http://orders`，其中 host 就是 service id。

### 5.2 从 Feign child context 取 Client，再交给 Targeter

`loadBalance(...)` 从 Feign child context 里取 `Client`，设置到 `Feign.Builder`，再交给 `Targeter.target(...)`。

`FeignClientFactoryBean.java:427` — loadBalance 从 Feign child context 取 Client

如果 child context 里没有任何 `Client` bean，会抛出：

```
No Feign Client for loadBalancing defined. Did you forget to include spring-cloud-starter-loadbalancer?
```

`FeignClientFactoryBean.java:436` — 无 Client 时抛 starter 缺失错误

这就是为什么 no-url 的 Feign 必须依赖 loadbalancer starter：Feign 自己不会提供 LB client。

### 5.3 有 url 时：unwrap 掉 LB 装饰器

`getTarget()` 里，有 url 时会通过 `getDelegate()` 解包掉 Feign 的 LB 包装：

`FeignClientFactoryBean.java:486` — 有 url 时 unwrap 装饰器

所以显式 url 的场景不会被误包成负载均衡。

## 六、`FeignBlockingLoadBalancerClient`：请求时选路的装饰器

### 6.1 它是全局单例

`FeignBlockingLoadBalancerClient` 实现 `feign.Client`。它在根上下文里只创建一个实例，所有 Feign client 共享它。

它没有在创建时记下任何 serviceId，因为它要服务所有 Feign client。serviceId 是每次请求时才知道的。

### 6.2 从 request URL 的 host 读取 serviceId

`execute()` 的第一步：

```java
String serviceId = URI.create(request.url()).getHost();
```

`FeignBlockingLoadBalancerClient.java:107` — serviceId 从 host 提取

对于 `http://orders/api/orders/1`，host 是 `orders`，也就是 serviceId。

### 6.3 拿 LoadBalancerLifecycle 并 choose

它先按 serviceId 从 LB 的 per-service context 取出 `LoadBalancerLifecycle` bean：

`FeignBlockingLoadBalancerClient.java:113` — LoadBalancerLifecycle 从 LB service context 取

然后调用：

```java
ServiceInstance instance = loadBalancerClient.choose(serviceId, lbRequest);
```

`FeignBlockingLoadBalancerClient.java:118` — `loadBalancerClient.choose(...)`

这里的 `loadBalancerClient` 是 Spring Cloud LoadBalancer 的 `BlockingLoadBalancerClient`，也就是真正干选择活的组件。

### 6.4 没有实例时返回 503

如果 `instance == null`，说明当前没有可用实例，Feign 会直接构造一个 503 的 Feign Response：

`FeignBlockingLoadBalancerClient.java:121` — instance 为 null → 503

这个 503 是 Feign 层的模拟响应，不会真发 HTTP。

### 6.5 reconstructURI：把逻辑 URL 变成真实 host

选到实例后，调用：

```java
loadBalancerClient.reconstructURI(instance, originalUri);
```

`FeignBlockingLoadBalancerClient.java:135` — `reconstructURI(...)` 重建 host

这一步把 `http://orders/...` 中的 `orders` 替换成实例的真实 `host:port`。

### 6.6 buildRequest 与 transformers

重建请求时，还会应用 `LoadBalancerFeignRequestTransformer` bean（比如 Feign 侧的 `XForwardedHeadersTransformer`），把转发头写进新请求。

`FeignBlockingLoadBalancerClient.java:146` — buildRequest + transformers

最终用真实 URL 构造一个全新 `Request`，交给底层 delegate client 执行。

## 七、`BlockingLoadBalancerClient.choose()`：唯一的 Reactor→阻塞桥

### 7.1 走到这一步已经不是 Feign 的事了

`BlockingLoadBalancerClient` 来自 Spring Cloud LoadBalancer，不来自 Spring Cloud OpenFeign。Feign 只是调用了它的 `choose()`。

`BlockingLoadBalancerClient.java:158` — choose

### 7.2 关键在 block

`choose()` 的做法是：

```java
ReactiveLoadBalancer<ServiceInstance> loadBalancer =
    loadBalancerClientFactory.getInstance(serviceId);
return Mono.from(loadBalancer.choose(request)).block();
```

`BlockingLoadBalancerClient.java:163` — `Mono.from(...).block()`

这就是整条链上唯一从 reactive 世界回到阻塞世界的地方。

`ReactiveLoadBalancer`、`ReactorServiceInstanceLoadBalancer` 这些名字很容易让人误以为"LoadBalancer 是异步的"。实际上在 Feign 的路径里：

- 上游 Feign 是同步的
- `choose()` 自己也被一个 `block()` 拉回同步
- 下游 delegate HTTP 是同步的

所以唯一需要记住的桥点是：`Mono.from(...).block()`。

### 7.3 按 serviceId 选对应的 LoadBalancer

`loadBalancerClientFactory.getInstance(serviceId)` 会从 LB 的 per-service context 取得对应的 `ReactiveLoadBalancer`：

`LoadBalancerClientFactory.java:79` — `getInstance(serviceId)`
`LoadBalancerClientConfiguration.java:69` — ReactorLoadBalancer bean

默认实现通常是 `RoundRobinLoadBalancer`，它再通过 `ServiceInstanceListSupplier` 拿候选实例。

## 八、兄弟 context：Feign child context vs LoadBalancer child context

### 8.1 两个 NamedContextFactory

Feign 有一个 `NamedContextFactory`（`FeignClientFactory`），LoadBalancer 也有一个（`LoadBalancerClientFactory`）。它们各自负责：

- Feign 的 child context：`Decoder`、`Encoder`、`Contract`、`Feign.Builder`、`Retryer`、interceptors、Capability
- LoadBalancer 的 child context：`ReactorLoadBalancer`、`ServiceInstanceListSupplier`、`LoadBalancerLifecycle`、per-service properties

### 8.2 它们是兄弟，不是父子

Feign child context 和 LoadBalancer child context 是**分离的兄弟 context**，不是一方的 parent/child。

它们唯一的交汇点是 `FeignBlockingLoadBalancerClient`：它持有根上下文里的 `LoadBalancerClient` 和 `LoadBalancerClientFactory`。

所以你在 Feign 端配的 `Decoder`、`Contract`，不会跑到 LoadBalancer 那边去；反之 LoadBalancer 端的 supplier、round-robin 算法也不会污染 Feign 的编解码配置。

## 九、Auto-config 顺序与具体 client 选择

### 9.1 装配顺序

`FeignLoadBalancerAutoConfiguration` 的声明：

`FeignLoadBalancerAutoConfiguration.java:47` — 条件与顺序

它会：

- 在存在 `Feign.class`、`LoadBalancerClient.class`、`LoadBalancerClientFactory.class` 时生效
- `@AutoConfigureBefore(FeignAutoConfiguration.class)`
- `@AutoConfigureAfter(BlockingLoadBalancerClientAutoConfiguration)` 和 `LoadBalancerAutoConfiguration`

自动配置注册表里也有它：

`AutoConfiguration.imports:5` — 自动配置注册

### 9.2 具体 HTTP client 的选择

Feign 的 LB 装饰器下面，具体挂的是哪种 HTTP client，取决于用了哪个 `*FeignLoadBalancerConfiguration`：

`DefaultFeignLoadBalancerConfiguration.java:48` — 默认 Client bean

- `DefaultFeignLoadBalancerConfiguration` → `feign.Client.Default`（JDK HttpURLConnection）
- `OkHttpFeignLoadBalancerConfiguration` → OkHttp
- `HttpClient5FeignLoadBalancerConfiguration` → Apache HC5
- `Http2ClientFeignLoadBalancerConfiguration` → Java Http2

无论挂的是哪种 delegate，Feign 的 LB 装饰器链始终是 `FeignBlockingLoadBalancerClient → delegate`。delegate 的具体类型只影响真实的 HTTP 执行方式，不影响 serviceId 的提取和 reconstructURI 逻辑——这些都在 `FeignBlockingLoadBalancerClient` 里完成。这也正好证明：真正发 HTTP 的始终是 feign 的原始 client adapter。

## 十、no-instance → 503 与错误诊断

### 10.1 没有实例时的用户可见行为

选不到实例时，`FeignBlockingLoadBalancerClient` 不会真的走网络，而是直接构造一个 503 Feign Response：

`FeignBlockingLoadBalancerClient.java:121` — 503 模拟响应

这个消息通常包含类似："Load balancer does not contain an instance for the service ..." 这样的描述。

要注意：这个 503 是从 Feign 层模拟出来的响应，不是真的飞过网络回来的。所以它依然会走正常的 Feign 响应处理链——`ResponseHandler`、`ErrorDecoder` 都会照常处理它。也就是说，哪怕服务端完全无响应，这个 503 对调用方来说也是一个可以被熔断、被 fallback 拦截的响应。

### 10.2 排障提示

如果线上遇到这种 503，先不要怀疑 Feign 自身网络，先看：

- 服务注册中心里有没有 `orders` 实例
- LoadBalancer 的 service context 里 `ServiceInstanceListSupplier` 是否真的从注册中心拿到了实例
- `request.url().getHost()` 是否真的是你要的 serviceId

因为 Feign 到这一步只负责把 serviceId 交给 LoadBalancer，选不到实例是 LoadBalancer 侧的结果。

## 十一、误解澄清

### 误解一：Feign 使用 `@LoadBalanced`

不是。`@LoadBalanced` 是 RestTemplate/RestClient/WebClient 的 qualifier，Feign 不读取它。Feign 的触发点是"没有 url"。

### 误解二：每个 Feign client 有独立的 LoadBalancer 配置

不准确。`FeignBlockingLoadBalancerClient` 是全局单例，所有 Feign client 共享它；per-service 选择发生在请求时。

### 误解三：有显式 url 也走负载均衡

不对。有 url 时 `getTarget()` 会 unwrap 掉 LB 装饰器，走原始 HTTP 直连。

### 误解四：LoadBalancer 是异步的，因为用了 Mono/Reactor

不是。Feign 路径全程同步，唯一的 Reactor→阻塞桥是 `Mono.from(...).block()`。

### 误解五：没有 url 的 Feign client 不需要 LoadBalancer

不行。没有 url 时 `loadBalance()` 必须在 child context 里找到 `Client` bean，否则会抛 "Did you forget to include spring-cloud-starter-loadbalancer?"。

### 误解六：逻辑 target `http://orders` 就是一个真实地址

不是。它只是占位。在请求真正发出之前，`FeignBlockingLoadBalancerClient` 会通过 `reconstructURI` 把 host 替换成选中的真实实例的 `host:port`。所以 `http://orders` 不存在于真实的 HTTP 请求里，它只是 Feign 用来向 LoadBalancer 传递 serviceId 的临时逻辑 URL。

## 十二、收网总结：Feign 把 serviceId 变成逻辑 target，LoadBalancer 把它变成真实 host

回到开头的问题：`http://orders` 是怎么变成真实请求的？

因为 Feign 与 LoadBalancer 的关系是一条**请求时按 serviceId 选路的装饰链**：

- Feign 把 `name` 变成逻辑 target，并在 client 上挂 `FeignBlockingLoadBalancerClient`
- 每次请求，这个装饰器从 host 读 serviceId
- 调用 `BlockingLoadBalancerClient.choose()` 选实例
- 用 `reconstructURI` 把 serviceId 换成真实 host:port
- 最后交给底层 HTTP client

这条链的分工非常清楚：

- Feign 负责"把 serviceId 变成逻辑 URL"
- LoadBalancer 负责"把 serviceId 变成真实 host"
- 两者在 `FeignBlockingLoadBalancerClient` 处桥接

**三句话总结：**

1. 没有 `url` 的 `@FeignClient` 走的是"逻辑 target + 请求时按 serviceId 选路"的路径，不是创建时固定选路。
2. `FeignBlockingLoadBalancerClient` 是全局共享的 Feign `Client` 装饰器，真正的选路在每次请求时通过 `BlockingLoadBalancerClient.choose()` 发生。
3. 有显式 `url` 时 Feign 会解包 LB 装饰器，直接走原始 HTTP client。

**下篇预告：** 下一篇进入 CircuitBreaker 与 fallback，看 Feign 的失败如何在更上层被熔断与降级接管。