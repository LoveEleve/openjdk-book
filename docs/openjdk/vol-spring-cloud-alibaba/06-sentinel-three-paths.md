# 为什么 Sentinel 不是“只会拦 HTTP 请求”：Spring Cloud Alibaba 如何把限流接进 RestTemplate、Feign 和 Web 三条链

> 本文基于 Spring Cloud Alibaba 2025.0.0.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-alibaba` 的第六篇，进入主干层的 Sentinel 三路限流。重点放在 `SentinelBeanPostProcessor`、`SentinelProtectInterceptor`、`SentinelFeign`、`SentinelInvocationHandler`、`SentinelWebAutoConfiguration`、`SentinelWebInterceptor`，以及它们如何分别把限流接到 RestTemplate、Feign 和 Web MVC 请求链。下一篇将进入 Seata 三路透传 XID。

## 为什么限流不只发生在入口 Web，请求发出去之前和客户端调用里也要被保护

很多人提到 Sentinel，第一反应就是：

- 限流 Web 请求
- 某个 URL 触发了熔断或降级

这没错，但在真实系统里，限流不只发生在入口 Web。它还会发生在：

- 应用通过 `RestTemplate` 调别人时
- 应用通过 OpenFeign 调别人时
- 入口 Web 自己接住请求时

也就是说，Sentinel 要覆盖的不是一个点，而是三条不同调用链：

- **Web 入站**：请求进来时保护入口
- **RestTemplate 出站**：请求出去时保护客户端
- **Feign 出站**：Feign 代理调用时保护客户端

Spring Cloud Alibaba 的价值，不是“把 Sentinel API 暴露给你自己调用”，而是：

- **把 Sentinel 的限流能力接进 Spring 已有的三条调用链。**

第一层问题是：**Sentinel 限流不是一个统一的大拦截器，而是在不同技术栈节点分别接入。**

第二层问题是：**Web 入站、RestTemplate 出站、Feign 出站三条链的插入点完全不同。**

第三层问题是：**Spring Cloud Alibaba 的角色不是重写 Sentinel，而是把 Sentinel 的 entry / fallback 语义桥接到 Spring 调用链。**

## 先看失败方案：为什么不能只保护 Controller、不能让业务代码手写所有 entry、也不能把 Feign 和 RestTemplate 当成同一条链处理

### 失败方案一：只在入口 Web 层做限流

这会遗漏非常重要的一类问题：

- 服务 A 对服务 B 的调用在客户端侧也可能需要被保护

如果只在 Web 层入口保护，而不在出站调用链保护，那么：

- 下游依赖异常或抖动时，客户端仍然可能无限打爆它

### 失败方案二：业务代码自己 everywhere 写 `SphU.entry(...)`

这会导致：

- 限流逻辑散落到业务代码
- Feign / RestTemplate / Web 的切入点不统一
- fallback 处理和注解声明很难统一

所以 Alibaba 需要的是：

- **把 Sentinel 接入现有 Spring 调用链，而不是让业务代码自己 everywhere 写 entry。**

### 失败方案三：Feign 和 RestTemplate 反正都是客户端调用，走同一个拦截点就行

这也不成立。

因为：

- RestTemplate 依赖 `ClientHttpRequestInterceptor`
- Feign 依赖 `InvocationHandler` / Builder / FallbackFactory

二者插入点根本不同。

所以虽然它们都属于“客户端限流”，但接入方式必须分别设计。

## Sentinel 三路限流的最小总图

```text
Web request
   -> SentinelWebInterceptor
   -> SphU.entry(webResource)
   -> block / fallback / continue

RestTemplate request
   -> SentinelBeanPostProcessor finds @SentinelRestTemplate
   -> add SentinelProtectInterceptor
   -> SphU.entry(hostResource)

Feign call
   -> SentinelFeign custom builder
   -> SentinelInvocationHandler.invoke()
   -> SphU.entry(feignResource)
```

```text
[Web 入站]
SentinelWebInterceptor

   ->

[RestTemplate 出站]
SentinelBeanPostProcessor -> SentinelProtectInterceptor

   ->

[Feign 出站]
SentinelFeign -> SentinelInvocationHandler
```

## 一、RestTemplate：`@SentinelRestTemplate` + BeanPostProcessor + Interceptor

RestTemplate 这条链的关键不是某个 auto-config 直接 new 出一个特殊 RestTemplate，而是：

- 用户声明 `@SentinelRestTemplate`
- `SentinelBeanPostProcessor` 在 BeanDefinition 阶段识别这个 RestTemplate
- 它给该 RestTemplate 挂上 `SentinelProtectInterceptor`

`SentinelProtectInterceptor` 的职责是：

- 在请求发出前进入 `SphU.entry(hostResource, EntryType.OUT)`
- 由 Sentinel 决定放行、限流或 fallback

也就是说，RestTemplate 这条路径最关键的结构是：

- **声明注解 → BeanPostProcessor → 拦截器 → Sentinel entry**

## 二、Feign：`SentinelFeign` 替换 InvocationHandlerFactory

Feign 不是通过 `ClientHttpRequestInterceptor` 工作，它是：

- 通过 JDK 动态代理
- 代理接口方法调用

所以 Sentinel 在 Feign 世界里的入口不是 interceptor，而是：

- `SentinelFeign`
- `SentinelInvocationHandler`

`SentinelFeign` 定制 Feign Builder，把原有 `InvocationHandlerFactory` 替换为 Sentinel 版本；`SentinelInvocationHandler` 在 `invoke()` 里执行：

- `SphU.entry(...)`
- 调真实方法或走 fallback / fallbackFactory

也就是说，Feign 路径的关键结构是：

- **Builder 接管 → InvocationHandler 替换 → 方法调用进入 Sentinel entry**

## 三、Web MVC：`SentinelWebAutoConfiguration` + `SentinelWebInterceptor`

Web 入站的路径最接近大家直觉里的“限流入口”。

`SentinelWebAutoConfiguration` 负责：

- 注册 `SentinelWebInterceptor`
- 注册 `BlockExceptionHandler`
- 把 Sentinel 的 Web 拦截接入 MVC 主线

这意味着：

- 请求一进入 MVC 链
- 先经过 `SentinelWebInterceptor`
- `SphU.entry(...)` 进入 Sentinel 规则判断
- 被 block 时交给 `BlockExceptionHandler`

所以 Web 路径的关键是：

- **MVC 拦截器接入，而不是 Controller 自己手写限流代码。**

## 四、为什么三条路径的共同点不是“都调用了 Sentinel API”，而是“都把 Sentinel 接进 Spring 调用链”

这点必须单独钉死。

如果只说“都调用了 `SphU.entry(...)`”，会低估 Alibaba 的真正价值。

真正的价值在于：

- Web：接进 MVC interceptor 链
- RestTemplate：接进 `ClientHttpRequestInterceptor` 链
- Feign：接进 `InvocationHandler` 链

也就是说，Spring Cloud Alibaba 做的不是“帮你调用一次 Sentinel”，而是：

- **把 Sentinel 变成 Spring 各调用路径里的自然组成部分。**

## 五、为什么这一篇必须在 Nacos 主线之后

Nacos 主线解决的是：

- 服务怎么被发现和负载均衡

Sentinel 这一篇解决的是：

- 调用已经发生时，如何保护这些链路

也就是说，顺序上：

- 先知道请求怎么找到目标实例
- 再知道请求在进入或离开服务时，怎样被限流 / 保护

这样读者才不会把“注册发现”和“流量治理”混在一层。

## 六、最小源码证据：三条限流链不是同一个切入点

本地源码已经确认：

- `SentinelBeanPostProcessor`：处理 `@SentinelRestTemplate`
- `SentinelProtectInterceptor`：RestTemplate 出站拦截
- `SentinelFeign` / `SentinelInvocationHandler`：Feign Builder / 动态代理链
- `SentinelWebAutoConfiguration` / `SentinelWebInterceptor`：Web MVC 入站链

这证明：

- Alibaba 没有用“一个总拦截器”解决所有问题
- 而是按 Spring 调用链类型分开接入 Sentinel

## 七、几个最容易错的判断

### 1. Sentinel 只在 Web Controller 入口限流

不成立。

它同时接入了 Web 入站、RestTemplate 出站和 Feign 出站三条链。

### 2. RestTemplate 和 Feign 的限流可以共用同一个拦截器实现

不成立。

RestTemplate 通过 `ClientHttpRequestInterceptor`，Feign 通过 `InvocationHandler`，插入点完全不同。

### 3. Spring Cloud Alibaba 只是把 Sentinel API 暴露给业务自己调

不成立。

它真正做的是把 Sentinel 接进 Spring 调用链。

### 4. Web 被限流和客户端被限流是同一个问题

不完整。

它们都属于流量保护，但发生在不同方向、不同调用链上。

### 5. 这篇讲完就等于学完 Sentinel 源码

不成立。

本文只讲 Spring Cloud Alibaba 的集成层，不讲 Sentinel 核心规则引擎本体。

## 收网

现在可以回到开头的问题：为什么 Sentinel 不是“只会拦 HTTP 请求”？

因为在 Spring Cloud Alibaba 里，它被明确接进了三条不同调用链：

- Web MVC 入站：`SentinelWebInterceptor`
- RestTemplate 出站：`SentinelProtectInterceptor`
- Feign 出站：`SentinelInvocationHandler`

所以这篇真正该带走的结论不是“Sentinel 可以限流”，而是：

**Spring Cloud Alibaba 不把 Sentinel 当成业务代码要手写调用的 API，而是按 Spring 不同调用链的结构，把它分别接入 Web、RestTemplate 和 Feign；因此，Sentinel 的价值在 Alibaba 集成层里，不只是规则本身，而是它被变成了 Spring 调用链的自然组成部分。**

下一篇进入 Seata 三路透传 XID。