# 为什么 `RestTemplate` 里写服务名而不是 IP，也能发起请求：`@LoadBalanced` 与 `LoadBalancerClient` 如何改造请求

> 本文基于 Spring Cloud 2025.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-commons` 的第六篇，承接前一篇 `ServiceRegistry`。重点放在 `LoadBalancerClient`、`LoadBalancerInterceptor`、`LoadBalancerRequestFactory`、`@LoadBalanced` 的限定符角色，以及它们如何把“服务名 URL”改造成“实例 IP URL”。下一篇将进入 `ReactorLoadBalancer` 负载均衡策略。

## 为什么 `RestTemplate` 可以直接写成 `http://order-service/api`，而不是具体的 IP

在非分布式环境下，`RestTemplate` 通常这样写：

```java
restTemplate.getForObject("http://192.168.1.10:8080/api", String.class);
```

但在 Spring Cloud 里很常见的写法是：

```java
@LoadBalanced
@Bean
RestTemplate restTemplate() {
    return new RestTemplate();
}

// 调用时直接写服务名
restTemplate.getForObject("http://order-service/api", String.class);
```

这里 URL 的 host 不是 IP 也不是域名，而是一个 **服务名**：`order-service`。

`RestTemplate` 本身不会把服务名翻译成实例地址。真正做这件事的是：

- `LoadBalancerInterceptor`
- 它实现了 `ClientHttpRequestInterceptor`
- 在 `RestTemplate` 发送请求前拦截，把服务名替换成真实实例

**第一层问题是：`@LoadBalanced` 是一个限定符，标记“这个 RestTemplate 需要接负载均衡拦截器”。**

**第二层问题是：`LoadBalancerClient` 是负载均衡请求执行的契约，它负责选实例并重构 URI。**

**第三层问题是：`LoadBalancerRequestFactory` 创建 `LoadBalancerRequest`，让拦截器不需要关心传输细节。**

## 先看失败方案：为什么不能让业务代码手动选实例、不能在 `RestTemplate` 里硬编码 IP、也不能把所有 URL 改造成服务名

### 失败方案一：业务代码自己通过 DiscoveryClient 选实例再拼 URL

这会：

- 让每个调用方自己处理选实例逻辑
- 重复执行 choose / reconstructURI
- 把负载均衡细节散落到业务代码

### 失败方案二：URL 里硬编码具体实例 IP

服务动态扩缩容后：

- IP 会变
- 实例可能上线/下线
- 硬编码 IP 会让调用方依赖静态拓扑

### 失败方案三：把所有 URL 都写服务名，但 `RestTemplate` 没接负载均衡能力

如果 `RestTemplate` 没有 `@LoadBalanced` 或缺少 `LoadBalancerInterceptor`：

- 服务名 URL 不会被翻译
- 请求会以“order-service”作为 host 去连接，必然失败

所以必须显式让 `RestTemplate` 接入负载均衡拦截器。

## `@LoadBalanced` / `LoadBalancerClient` 的最小总图

```text
restTemplate.getForObject("http://order-service/api")
   -> LoadBalancerInterceptor.intercept()
   -> LoadBalancerClient.execute("order-service", request)
   -> choose a ServiceInstance from LoadBalancer
   -> requestFactory.createRequest(...)
   -> reconstructURI to real host:port
   -> execute real request
```

```text
[调用方]
RestTemplate 发请求，host 是服务名

   ->

[拦截器]
LoadBalancerInterceptor

   ->

[负载均衡执行]
LoadBalancerClient.execute()

   ->

[选实例]
ServiceInstanceChooser.choose()

   ->

[URI 重构]
reconstructURI()

   ->

[真实请求]
以真实 host:port 执行
```

## 一、`LoadBalancerClient`：负载均衡请求执行的契约

```java
public interface LoadBalancerClient extends ServiceInstanceChooser {
    <T> T execute(String serviceId, LoadBalancerRequest<T> request) throws IOException;
    <T> T execute(String serviceId, ServiceInstance serviceInstance, LoadBalancerRequest<T> request) throws IOException;
    URI reconstructURI(ServiceInstance instance, URI original);
}
```

它继承 `ServiceInstanceChooser`，所以同时具备：

- `choose(String serviceId)`：选一个实例
- `choose(String serviceId, Request<T> request)`：携带请求上下文选实例
- `execute(...)`：在选定实例上执行 LoadBalancerRequest
- `reconstructURI(...)`：把“服务名 URI”改造成“真实 host:port URI”

`ServiceInstanceChooser` 的真实定义同时提供了两个 choose 重载，`LoadBalancerRequest<T>` 会带上。

`BlockingLoadBalancerClient` 是它的阻塞式实现，位于 spring-cloud-loadbalancer 模块。

## 二、`LoadBalancerInterceptor`：真正拦截 `RestTemplate` 请求的入口

`LoadBalancerInterceptor` 实现 `ClientHttpRequestInterceptor`，这样 `RestTemplate` 会在发送前调用它：

```java
public class LoadBalancerInterceptor implements BlockingLoadBalancerInterceptor {

    @Override
    public ClientHttpResponse intercept(HttpRequest request, byte[] body, ClientHttpRequestExecution execution)
            throws IOException {
        URI originalUri = request.getURI();
        String serviceName = originalUri.getHost();
        return loadBalancer.execute(serviceName, requestFactory.createRequest(request, body, execution));
    }
}
```

来源：`spring-cloud-commons/.../loadbalancer/LoadBalancerInterceptor.java:49-56`。

它做两件事：

- 从请求 URI 的 host 取出服务名
- 交给 `LoadBalancerClient.execute(serviceName, request)` 执行

它自己并不关心“选哪个实例”，那是 `LoadBalancerClient` / chooser 的职责。

## 三、`LoadBalancerRequestFactory`：把拦截器拿到的传输信息包装成 LoadBalancerRequest

`LoadBalancerRequest` 描述“在某个实例上执行这个请求”的延迟执行动作。

`LoadBalancerRequestFactory` 负责把：

- 原始请求
- body
- 执行链

打包成一个 `LoadBalancerRequest`，并应用 `LoadBalancerRequestTransformer`。

这样 `LoadBalancerClient.execute()` 在选定实例后，只需要调用 request 回调，而不需要了解 RestTemplate 内部细节。

## 四、为什么 `@LoadBalanced` 是限定符，而不是负载均衡功能本身

`@LoadBalanced` 的源码非常简单：

```java
@Target({ ElementType.FIELD, ElementType.PARAMETER, ElementType.METHOD })
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Inherited
@Qualifier
public @interface LoadBalanced {
}
```

它本质上是 `@Qualifier`。

`LoadBalancerAutoConfiguration` 通过 `@LoadBalanced @Autowired` 收集所有被标记的 `RestTemplate` Bean，再通过 `SmartInitializingSingleton` 回调为它们挂上 `LoadBalancerInterceptor`：

```java
@LoadBalanced
@Autowired(required = false)
private List<RestTemplate> restTemplates = Collections.emptyList();

@Bean
public SmartInitializingSingleton loadBalancedRestTemplateInitializerDeprecated(...) {
    return () -> restTemplateCustomizers.ifAvailable(customizers -> {
        for (RestTemplate restTemplate : restTemplates) {
            for (RestTemplateCustomizer customizer : customizers) {
                customizer.customize(restTemplate);
            }
        }
    });
}
```

来源：`spring-cloud-commons/.../loadbalancer/LoadBalancerAutoConfiguration.java:58-83`。

所以 `@LoadBalanced` 的职责是“标记”，拦截器装配由自动配置完成。

## 五、为什么这篇必须紧跟 `ServiceRegistry`

负载均衡的执行依赖第一层能力：能拿到某个服务的一组实例。

正是 `DiscoveryClient`（消费者视角）提供的：

- `List<ServiceInstance> getInstances(serviceId)`

`LoadBalancerClient` 在选实例时：

- 调 `ServiceInstanceChooser.choose(serviceId)`
- 具体实现从 `DiscoveryClient` 拿实例列表
- 再按策略（轮询 / 随机）选一个

也就是说：

- 上一篇解决了“有哪些实例可选”
- 这一篇解决“从这些实例里怎么选一个并真正发请求”

## 六、几个最容易错的判断

### 1. `@LoadBalanced` 本身就实现了负载均衡

不成立。

它是 `@Qualifier` 限定符，真正的拦截和选实例在 `LoadBalancerClient` / `LoadBalancerInterceptor`。

### 2. `LoadBalancerInterceptor` 自己负责选实例

不成立。

它只负责把服务名和请求交给 `LoadBalancerClient.execute()`，选实例在 chooser 里。

### 3. 不写 `@LoadBalanced`，服务名 URL 也能正常工作

不成立。

没有 `@LoadBalanced`，`RestTemplate` 不会挂拦截器，服务名 host 不会被翻译。

### 4. `LoadBalancerRequestFactory` 只是创建请求对象

它是关键一环，但职责不只是创建。

它还会应用 `LoadBalancerRequestTransformer`，让请求在发送前可以被定制。

### 5. 服务名 URL 和实例 IP URL 是同一个东西

不成立。

服务名 URL 经过拦截器重构成实例 IP URL 后才真正发送。

## 收网

现在可以回到开头的问题：为什么 `RestTemplate` 写服务名而不是 IP，也能发起请求？

因为 Spring Cloud 用 `@LoadBalanced` 标记需要负载均衡能力的 `RestTemplate`，`LoadBalancerAutoConfiguration` 为它挂上 `LoadBalancerInterceptor`；拦截器从 URI host 取出服务名，交给 `LoadBalancerClient` 选实例并 `reconstructURI` 成真实 host:port 后执行。

所以这篇真正该带走的结论不是“服务名 URL 是随便写的”，而是：

**`@LoadBalanced` 限定需要负载均衡的 RestTemplate，`LoadBalancerClient` 通过 `ServiceInstanceChooser` 选实例、通过 `reconstructURI` 改造请求，再让 `LoadBalancerRequestFactory` 打包的请求在真实实例上执行；因此，服务名 URL 变成了负载均衡请求的入口，而不是静态 IP 的替代写法。**

下一篇进入 `ReactorLoadBalancer` 负载均衡策略。