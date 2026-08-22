# 为什么分布式事务不是只在本地开个注解：Seata 如何把 XID 透传进 Feign、RestTemplate 和 Web 入站链

> 本文基于 Spring Cloud Alibaba 2025.0.0.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-alibaba` 的第七篇，承接前一篇 Sentinel 三路限流。重点放在 `SeataFeignRequestInterceptor`、`SeataFeignBuilderBeanPostProcessor`、`SeataRestTemplateInterceptor`、`SeataHandlerInterceptor`，以及它们如何把 Seata 的全局事务 XID 透传进 Feign、RestTemplate 和 Web 入站调用链。本文不重复 Seata 本体的全局事务协调器原理，而聚焦 Spring Cloud Alibaba 的透传集成层。下一篇将进入 RocketMQ Stream Binder 或全卷阶段性整理。

## 为什么分布式事务最大的难点，不是本地数据库事务，而是“跨服务调用时上下文会不会丢”

只要真正做过分布式事务，就会很快意识到一个现实：

- 本地数据库事务本身并不神秘
- 真正难的是服务 A 调服务 B、服务 B 再调服务 C 时，全局事务上下文能不能一路带过去

如果上下文丢了，就会立刻出现：

- A 以为自己在一个全局事务里
- B 和 C 却各自按普通本地调用处理
- 最后回滚边界完全断裂

Seata 在这里的核心概念是：

- `XID`

它代表当前全局事务的上下文标识。

Spring Cloud Alibaba 的工作，不是重做 Seata 事务协调器，而是回答：

- **这个 XID 怎样在 Spring 的不同调用链里自动传播。**

第一层问题是：**分布式事务透传不是某一条链路的事情，而是至少同时涉及 Feign、RestTemplate 和 Web 入站。**

真实调用链可能是：

- A 服务通过 Feign 调 B
- B 服务通过 RestTemplate 调 C
- C 服务作为 Web 请求入口接住这次调用

如果三条链中任何一条不传播 XID，全局事务就会断。

第二层问题是：**透传不应由业务代码手工读写 Header，而应由集成层自动接进客户端与服务端拦截链。**

如果每个业务方法都要自己：

- 从 `RootContext` 拿 XID
- 手工塞进 Header
- 服务端再手工解析出来绑定

那很快就会变成：

- 透传逻辑散落在各处
- 极易漏掉
- 难以测试与维护

第三层问题是：**Spring Cloud Alibaba 在这里真正解决的不是事务本身，而是 XID 在 Spring 调用路径中的桥接。**

因此，本文真正要回答的问题不是“Seata 怎么实现分布式事务”，而是：

**为什么对 Spring Cloud Alibaba 来说，必须把 XID 透传分别接到 Feign、RestTemplate 和 Web 入站三条链上，才能让 Seata 的全局事务上下文在跨服务调用中不丢失。**

## 先看失败方案：为什么不能只在 Feign 里透传、不能让业务代码手工写 Header、也不能只在服务端入口处理 XID

### 失败方案一：只在 Feign 里透传 XID

这会漏掉另一条常见客户端路径：

- RestTemplate

一旦服务内部还有非 Feign 的 HTTP 调用，XID 就可能断掉。

### 失败方案二：业务代码自己手工写 Header

这会让透传逻辑散落在所有调用点：

- 漏一个就断
- 代码噪音大
- 难以统一修改

而且业务代码会开始直接依赖：

- `RootContext.getXID()`
- header key 常量

这本来应该由集成层承担。

### 失败方案三：只在服务端入口解析 XID 就够了

服务端入口当然需要把请求头里的 XID 重新绑定到 `RootContext`，但如果客户端根本没透传 XID：

- 服务端再怎么解析也拿不到东西

所以客户端透传和服务端入站绑定是两半，缺一不可。

## XID 透传的最小总图

```text
RootContext.getXID()
   -> client side (Feign / RestTemplate) add header
   -> HTTP call
   -> server side interceptor read header
   -> RootContext.bind(xid)
```

```text
[上游客户端]
Feign / RestTemplate

   ->

[XID 注入]
request header: Seata XID

   ->

[下游服务入站]
SeataHandlerInterceptor

   ->

[上下文恢复]
RootContext.bind(xid)
```

## 一、Feign：`SeataFeignRequestInterceptor` 负责把当前 XID 写进出站请求头

Feign 这条链的关键在于：

- 请求发出前拿到当前全局事务 XID
- 把它写入请求头

Alibaba 的实现就是：

- `SeataFeignRequestInterceptor`

它的本地源码非常直接：

```java
@Override
public void apply(RequestTemplate template) {
    String xid = RootContext.getXID();
    if (!StringUtils.hasLength(xid)) {
        return;
    }
    template.header(RootContext.KEY_XID, xid);
}
```

这说明 Feign 出站透传不是推断行为，而是真实发生的：

- 从 `RootContext` 取当前 XID
- 如果有值，就把它写进请求头 `RootContext.KEY_XID`

这样，Feign 每次出站请求都会自动携带当前全局事务上下文。

## 二、为什么还需要 `SeataFeignBuilderBeanPostProcessor`

只写一个 `RequestInterceptor` 还不够，因为 Feign 的 builder 和客户端创建过程需要确保这个 interceptor 真正被挂进去。

这就是：

- `SeataFeignBuilderBeanPostProcessor`

存在的意义。

本地源码里它的职责其实比“挂 interceptor”更克制、更具体：

```java
@Override
public Object postProcessAfterInitialization(Object bean, String beanName) throws BeansException {
    if (bean instanceof Feign.Builder) {
        ((Feign.Builder) bean).retryer(Retryer.NEVER_RETRY);
    }
    return bean;
}
```

也就是说，这个 BeanPostProcessor 直接介入 Feign Builder 的后处理阶段，把重试策略统一改成：

- `Retryer.NEVER_RETRY`

它的价值在于：Seata 全局事务场景下，Feign 默认不应在客户端层悄悄重试，否则可能破坏全局事务语义与幂等边界。

因此，Alibaba 不只是提供一个工具类，而是：

- 在 Feign Bean 创建阶段把 Seata 相关约束接进 Feign 构建链

这样用户不需要手工把 interceptor 塞到每个 Feign client 配置里。

## 三、RestTemplate：`SeataRestTemplateInterceptor` 负责把 XID 写进 Header

RestTemplate 和 Feign 的调用模型不同：

- Feign 用动态代理
- RestTemplate 用 `ClientHttpRequestInterceptor`

所以 Alibaba 在 RestTemplate 路径上提供的是：

- `SeataRestTemplateInterceptor`

它的本地源码也很直接：

```java
@Override
public ClientHttpResponse intercept(HttpRequest httpRequest, byte[] bytes,
        ClientHttpRequestExecution clientHttpRequestExecution) throws IOException {
    HttpRequestWrapper requestWrapper = new HttpRequestWrapper(httpRequest);
    String xid = RootContext.getXID();
    if (StringUtils.hasLength(xid)) {
        requestWrapper.getHeaders().add(RootContext.KEY_XID, xid);
    }
    return clientHttpRequestExecution.execute(requestWrapper, bytes);
}
```

这说明 RestTemplate 出站链里的透传动作是：

- 从 `RootContext` 读取当前 XID
- 包装原始请求
- 把 XID 写入 header
- 再把请求交给真正的执行链

但它接入的 Spring 调用链不同：

- 是 RestTemplate 的 interceptor 链，而不是 Feign builder 链

这也再次说明，XID 透传是“多链路桥接问题”，不是单一路径问题。

## 四、Web 入站：`SeataHandlerInterceptor` 负责把请求头里的 XID 重新绑回当前线程上下文

客户端透传只是第一半。

服务端收到请求后，必须：

- 从请求头提取 XID
- 重新绑定到当前线程的 `RootContext`

这一步由：

- `SeataHandlerInterceptor`

完成。

本地源码里它的关键逻辑分成两段：

```java
@Override
public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
    String xid = RootContext.getXID();
    String rpcXid = request.getHeader(RootContext.KEY_XID);
    if (StringUtils.isBlank(xid) && rpcXid != null) {
        RootContext.bind(rpcXid);
    }
    return true;
}
```

以及：

```java
@Override
public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
        Object handler, Exception e) {
    if (StringUtils.isNotBlank(RootContext.getXID())) {
        String rpcXid = request.getHeader(RootContext.KEY_XID);
        if (StringUtils.isEmpty(rpcXid)) {
            return;
        }
        String unbindXid = RootContext.unbind();
        if (!rpcXid.equalsIgnoreCase(unbindXid) && unbindXid != null) {
            RootContext.bind(unbindXid);
        }
    }
}
```

这说明它不仅负责：

- 从请求头里恢复 XID 到 `RootContext`

还负责：

- 请求结束后把当前线程里的 XID 清理出去
- 如果中间链路改写了 XID，还会尝试把原上下文重新绑回去

它的意义非常关键，因为没有这一步：

- 虽然 Header 里带了 XID
- 但业务代码和数据库事务上下文仍然看不到它

也就是说，透传不是“写进 Header 就结束”，而是：

- **写出 + 读入 + 绑定 + 清理 四段都要完整。**

## 五、为什么这条链最核心的不是 HTTP 协议，而是 `RootContext`

表面看上去，这整篇都在讲：

- 往 Header 里写一个值
- 再从 Header 里读一个值

但真正的核心不是 Header 本身，而是：

- `RootContext`

因为 XID 只有进入 `RootContext`，Seata 后续所有：

- 事务分支注册
- 数据源代理
- 分支提交 / 回滚

才有上下文可依附。

也就是说：

- Header 只是跨进程传输媒介
- `RootContext` 才是本进程内的事务上下文锚点

## 六、为什么这篇必须放在 Sentinel 三路限流之后

Sentinel 和 Seata 这两篇有一个很有意思的共同点：

- 它们都不是在讲中间件本体
- 而是在讲“如何接到 Spring 的不同调用链里”

但它们接入的目标不同：

- Sentinel 接的是流量治理语义
- Seata 接的是事务上下文透传语义

把两篇连着看，读者最容易理解 Alibaba 集成层的真正工作方式：

- 不是重做中间件
- 而是把中间件能力变成 Spring 调用链的自然一部分

## 七、最小源码证据：这条链确实是“客户端注入 Header -> 服务端入站恢复 RootContext”

本地源码已经明确给出了三条路径的关键类：

- `SeataFeignRequestInterceptor`
- `SeataFeignBuilderBeanPostProcessor`
- `SeataRestTemplateInterceptor`
- `SeataHandlerInterceptor`

它们分别对应：

- Feign 出站 XID 注入
- Feign builder 阶段接入 Seata 拦截逻辑
- RestTemplate 出站 XID 注入
- Web 入站 XID 恢复与绑定

也就是说，Alibaba 在 Seata 这条主线里并没有创造新的事务协议，而是：

- **把同一个 XID 上下文分别桥接进不同调用路径。**

## 八、几个最容易错的判断

### 1. 分布式事务的关键只是数据库事务够不够强

不成立。

真正难的是跨服务调用时，全局事务上下文会不会丢失。

### 2. 只在 Feign 上做透传就够了

不成立。

RestTemplate 和 Web 入站同样需要各自的桥接路径。

### 3. Header 里带了 XID 就已经完成事务透传

不成立。

服务端还需要通过 `SeataHandlerInterceptor` 把它重新绑定回 `RootContext`。

### 4. 业务代码自己手工读写 XID 更直接

不成立。

这样会让透传逻辑散落在业务代码里，极易漏掉，且难以统一维护。

### 5. 这一篇讲完就等于学完了 Seata 源码

不成立。

本文只讲 Spring Cloud Alibaba 的透传集成层，不讲 Seata 本体的事务协调机制。

## 收网

现在可以回到开头的问题：为什么分布式事务最大的难点，不是本地数据库事务，而是“跨服务调用时上下文会不会丢”？

因为全局事务本质上依赖一个跨进程传播的：

- `XID`

而 Alibaba 的工作，就是把这个 XID 分别接进：

- Feign 出站
- RestTemplate 出站
- Web 入站

三条调用链。

所以这篇真正该带走的结论不是“Seata 支持分布式事务”，而是：

**Spring Cloud Alibaba 通过 `SeataFeignRequestInterceptor`、`SeataRestTemplateInterceptor` 和 `SeataHandlerInterceptor` 把 XID 注入和恢复接进 Spring 的不同调用链，再借助 `RootContext` 统一进程内事务上下文；因此，Seata 在 Spring 世界里的关键不是事务算法本身，而是事务上下文在多条调用路径中的可靠透传。**

下一篇进入 RocketMQ Stream Binder。