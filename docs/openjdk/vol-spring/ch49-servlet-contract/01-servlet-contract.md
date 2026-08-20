# 为什么 Spring MVC 不是重新发明 HTTP 容器：Servlet 规范边界与 `DispatcherServlet` 的契约落点

> 本文基于 Spring Framework 6.x 与 Jakarta Servlet 规范相关源码。本文只讲规范层的第三篇：Servlet 规范到底要求了什么，Spring MVC 又在哪些地方严格站在 Servlet 契约之上，只在容器内部继续扩展自己的调度、参数解析、消息转换和视图渲染主线。Tomcat 与 Boot 的集成桥会在后续集成层继续展开。

## 为什么学完 Spring MVC 主干以后，还必须回头补一篇 Servlet 规范边界

前面这卷已经把 Spring MVC 的大部分主干拆开了：

- `DispatcherServlet.doDispatch(...)` 的前端控制器主线
- `HandlerMapping` 与 `HandlerAdapter` 的双链协作
- 参数解析器链和消息转换器链
- `ViewResolver` 视图分支
- `HandlerExceptionResolver` 异常回收链
- `HandlerInterceptor` 的正进逆出拦截线

如果只停在这些文章里，读者很容易形成一种危险的错觉：

- 好像 Spring MVC 自己定义了整个 Web 请求处理模型

这个印象之所以危险，不是因为它完全错，而是因为它会抹掉一个更基础的事实：

- Spring MVC 不是 HTTP 容器
- 它是建立在 Servlet 容器之上的 Web 框架

也就是说，Spring MVC 从来不是直接接收 Socket、直接解析 HTTP、直接管理底层连接的那一层。它接到的其实已经是 Servlet 世界统一提供的：

- `HttpServletRequest`
- `HttpServletResponse`
- `Filter` 链之后的调用入口
- `ServletContext`
- `HttpSession`

这意味着前面所有我们已经讲过的 Spring MVC 主线，其实都默认建立在一个更外层的规范边界之内。

第一层问题是：**Servlet 规范决定了 Spring MVC 能接到什么输入、必须遵守什么生命周期，而不是 Spring 自己想怎么设计就怎么设计。**

例如：

- `DispatcherServlet` 必须作为一个 `HttpServlet` 被容器调用
- 请求方法分发首先经过 Servlet 容器的 `service()` / `doGet()` / `doPost()` 体系
- Filter 发生在更外层
- Session 与 ServletContext 也都是规范对象

也就是说，Spring MVC 的很多设计并不是“凭空创意”，而是在 Servlet 契约给出的边界里继续展开。

第二层问题是：**Servlet 规范只定义了最外层行为，Spring MVC 真正扩展的是容器内部处理世界。**

也就是说：

- Servlet 规范并不会告诉你怎样做 `@RequestMapping`
- 也不会告诉你怎样组织参数解析器链、消息转换器链、视图解析器链
- 更不会规定 `@ControllerAdvice`、`@ResponseBody`、`HandlerMethod` 这些 Spring 语义

这说明：

- 规范给的是最外层边界
- Spring MVC 在这个边界内自己建立更丰富的调度和扩展模型

第三层问题是：**如果不把规范层和实现层分开，后面很多判断都会失真。**

例如你会很容易误会：

- Filter 和 Interceptor 只是两种风格差不多的拦截器
- SessionScope 完全是 Spring 自己发明的
- `DispatcherServlet.service()` 里的流程天生就该这样长

而更准确的理解应该是：

- Filter 是 Servlet 规范层
- Interceptor 是 Spring MVC 框架层
- SessionScope 是 Spring 对 `HttpSession` 的再建模
- `DispatcherServlet` 只是拿着规范对象继续往内层调度

因此，本文真正要回答的问题不是“Servlet 规范讲了什么”，而是：

**为什么对 Spring MVC 来说，Servlet 规范必须被看成外层边界，而不是和 Spring 自己的调度实现混成一件事？**

## 先看失败方案：为什么不能把 `DispatcherServlet` 当成普通 Servlet、也不能把 Filter 和 Interceptor 混成一层

### 失败方案一：`DispatcherServlet` 不就是一个普通 Servlet 吗

这是最容易产生的直觉。

因为从类继承关系看，它确实就是一个 `HttpServlet` 子类。于是很容易顺手认为：

- Spring MVC 的全部请求处理，本质上也不过就是 Servlet 逻辑的一种写法

这个判断的问题在于，它把“被容器调用的入口”误当成了“框架内部完整逻辑”。

更准确地说：

- `DispatcherServlet` 作为 Servlet 的那一层，只负责和 Servlet 容器说同一种话
- 真正复杂的 Spring MVC 调度逻辑，则发生在它往内层展开的 `doDispatch(...)` 之后

也就是说，`DispatcherServlet` 是一个桥，而不是“Servlet 规范的全部展开”。

### 失败方案二：Filter 和 `HandlerInterceptor` 都是拦截请求，差别不大

这是第二个非常常见的误区。

因为从效果看，两者都能做：

- 登录校验
- 日志埋点
- 加响应头

如果只看表面功能，很容易觉得：

- 只是两个 API 不同而已

但从层级看，它们根本不在一个世界：

- Filter 在 Servlet 容器层，运行在 `DispatcherServlet` 之前
- `HandlerInterceptor` 在 Spring MVC 内部，已经知道当前 handler 是谁、是否有 `ModelAndView`

也就是说，它们不是并列工具，而是：

- **两个发生在不同抽象层级的拦截面。**

### 失败方案三：Session、ServletContext、Request 都属于 Spring 自己的上下文对象

这也是很容易混的地方。

因为前面我们已经讲过：

- `RequestContextHolder`
- request/session/application scope
- `WebDataBinder`

于是人很容易把这些都当成 Spring 自己的“原生 Web 世界”。

但实际上：

- `RequestContextHolder` 只是桥
- Spring 真实复用的底层对象仍然是 Servlet 规范里的 `HttpServletRequest`、`HttpSession`、`ServletContext`

也就是说，Spring 不负责定义这些对象，它负责的是：

- **把这些外部对象重新映射进自己的容器语义。**

## Spring MVC 与 Servlet 规范边界的最小总图

如果把这条边界先压缩成最小模型，它可以写成下面这样：

```text
Servlet container world
   -> Filter / HttpServlet.service / ServletRequest / ServletResponse / ServletContext / HttpSession
   -> DispatcherServlet bridge
   -> Spring MVC internal dispatch world
```

如果再换一种更容易理解的拆法，这条链可以分成四层：

```text
[规范层入口]
HttpServlet / Filter / request / response / session / servletContext

   ->

[桥接层]
DispatcherServlet / FrameworkServlet

   ->

[框架层内部世界]
HandlerMapping / HandlerAdapter / argument resolvers / message converters / views

   ->

[Spring 重新建模]
RequestContextHolder / Web scopes / binding / validation
```

这张图最重要的价值，不是让读者记住几个接口名字，而是先把四个问题分开：

### 一、规范层入口

回答：Servlet 容器到底先给了 Spring MVC 什么基础对象和生命周期？

### 二、桥接层

回答：`DispatcherServlet` 在哪一层真正把 Servlet 世界切进 Spring 世界？

### 三、框架层内部世界

回答：哪些请求处理能力是 Servlet 规范没有定义、完全由 Spring MVC 自己建立的？

### 四、Spring 重新建模

回答：Spring 是怎样把 request / session / context 这些外部对象接回自己的 scope、binding 和校验主线的？

## 一、Servlet 规范真正先提供的是“最外层请求壳子”和“最外层拦截面”

先从 Servlet 规范这一侧看，最重要的不是它提供了多少 API，而是它定义了 Spring MVC 进入 Web 世界的最低层入口：

- `HttpServletRequest`
- `HttpServletResponse`
- `Filter`
- `HttpSession`
- `ServletContext`

这意味着 Spring MVC 在运行时接到的，并不是：

- 原始 Socket
- 原始 HTTP 字节流

而是已经被 Servlet 容器包装好的请求 / 响应对象。

也就是说，Spring MVC 从一开始就站在 Servlet 容器更高的一层，而不是在重复发明 HTTP 接入栈。

这一步特别关键，因为它会直接影响你如何理解后面这些主线：

- 参数解析不是从原始协议字段开始，而是从 Servlet request 开始
- 视图渲染最终落回 `ServletResponse`
- SessionScope 最终依赖的是 `HttpSession`

所以 Servlet 规范真正提供的，不只是几个对象，而是：

- **Spring MVC 整个运行世界的最外层输入壳。**

## 二、`DispatcherServlet`：它首先是 Servlet 世界到 Spring 世界的桥，而不是完整请求处理本体

前面已经单独讲过 `DispatcherServlet.doDispatch(...)`。这里要补的关键边界是：

- 在进入 `doDispatch` 之前，`DispatcherServlet` 先是一个 Servlet

也就是说，它先要遵守 Servlet 规范的最外层调用方式：

- 容器调用 `service()`
- `FrameworkServlet` 把请求进一步统一收口
- 再进入 Spring MVC 的内部调度主线

这说明 `DispatcherServlet` 的真实位置不是：

- 普通的 MVC 工具类

而是：

- **Servlet 入口和 Spring MVC 内部世界之间的桥梁 Servlet。**

所以如果不把这层桥接关系立住，后面就很容易误把：

- Spring MVC 的所有行为

都当成 Servlet 规范自己定义的东西。

## 三、Filter vs `HandlerInterceptor`：一个在容器层，一个在框架层

这是规范层最值得单独钉死的一条边界。

- Filter：发生在 Servlet 容器层，早于 `DispatcherServlet`
- `HandlerInterceptor`：发生在 Spring MVC 内部，围着 Handler 执行链运转

因此，两者虽然都叫“拦截”，但回答的问题完全不同：

### Filter 适合做什么

- 编码
- CORS
- 安全头
- 统一请求包装
- 更底层的容器前置逻辑

### `HandlerInterceptor` 适合做什么

- 登录校验（依赖当前 handler 语义）
- 审计日志（知道当前 HandlerMethod）
- 处理 `ModelAndView` 相关逻辑
- 统一在 `postHandle` / `afterCompletion` 做 MVC 层清理

这说明：

- Filter 和 Interceptor 不是“你喜欢哪个就用哪个”
- 它们各自站在不同层级，并拥有不同信息视野

所以这条边界一旦不清楚，后面很多 MVC 拦截设计都会被讲歪。

## 四、Servlet 规范并不关心 `HandlerMethod`、参数解析器、消息转换器、视图解析器这些内层机制

前面我们已经写过：

- `HandlerMapping`
- `HandlerAdapter`
- 参数解析器链
- `HttpMessageConverter`
- `ViewResolver`
- `HandlerExceptionResolver`

这些看起来已经非常“Web 框架”了，但它们其实都不属于 Servlet 规范要求。

Servlet 规范只负责：

- 最外层 Servlet 生命周期
- 请求 / 响应对象
- Filter 链
- Session / Context 这些基础能力

至于：

- 请求如何映射到方法
- 参数如何解析
- body 如何转对象
- 返回值如何走视图或 JSON
- 异常如何通过 resolver 链收回

这些全部都是 Spring MVC 在 Servlet 之上的再建模。

也就是说，Spring MVC 真正扩展的，不是 HTTP 容器，而是：

- **容器内部的应用调度世界。**

## 五、Request / Session / ServletContext 在 Spring 里不是被重新定义，而是被重新桥接

前面 scope 和数据绑定篇已经讲过：

- `RequestContextHolder`
- request/session/application scope
- `WebDataBinder`

这里必须补上的边界是：Spring 并没有重新发明 request / session / context 对象。

它做的是：

- 通过 `ServletRequestAttributes`、`RequestContextHolder`
- 把 Servlet 规范对象重新桥接进自己的容器世界

例如：

- request scope 不是 Spring 自己有一个“request 对象池”
- 它依赖的仍然是当前线程绑定的 `HttpServletRequest`
- session scope 依赖的仍然是 `HttpSession`
- application scope 本质上仍然挂在 `ServletContext` 上

也就是说，Spring 的价值不在于重新定义这些对象，而在于：

- **把它们重新安放进自己的 Bean 和 scope 语义里。**

## 六、为什么这篇必须放在集成层与 MVC 主干之间回头写

看到这里，最值得回收的一个问题就是：

- 为什么这篇要放在现在，而不是一开始就讲？

因为如果没有前面的 MVC 主干篇做铺垫，规范边界这件事其实很难真正看出价值。

只有你先见过：

- HandlerMapping
- HandlerAdapter
- 参数解析器
- 消息转换器
- 视图解析器
- 异常处理器

你才会真正看清：

- 哪些是 Servlet 规范给的
- 哪些是 Spring MVC 自己填进去的

也就是说，规范层不是导读层，而是：

- **在主干篇已经建立之后，用来校准“哪里是边界、哪里是扩展”的回看层。**

## 七、几个最容易错的判断

### 1. `DispatcherServlet` 就是一个普通 Servlet，所以 Spring MVC 本质上只是 Servlet 的另一种写法

不成立。

`DispatcherServlet` 是桥，真正复杂的 MVC 调度、参数解析、消息转换和视图解析都发生在它进入内部世界之后。

### 2. Filter 和 `HandlerInterceptor` 只是两种拦截器 API

不成立。

它们站在两个不同抽象层级：Filter 在 Servlet 容器层，Interceptor 在 Spring MVC 框架层。

### 3. `HttpSession` / `ServletContext` 在 Spring 里被重新实现了一套

不成立。

Spring 主要做的是桥接与重新建模，而不是重新定义这些对象。

### 4. `@RequestMapping`、`@ResponseBody` 这些都是 Servlet 规范的一部分

不成立。

这些都属于 Spring MVC 在 Servlet 规范之上的框架层扩展。

## 收网：Spring MVC 统一的不是“HTTP 怎么工作”，而是“Servlet 容器给定外层边界后，框架如何在内部继续建立自己的调度世界”

现在可以回到开头的问题：为什么学完 Spring MVC 主干后，还必须回头补一篇 Servlet 规范边界？

因为只有把 Servlet 规范和 Spring MVC 自己的实现层分开，你才会真正看清：

- 容器提供的是外层 HTTP 壳子和 Filter 世界
- `DispatcherServlet` 是桥
- HandlerMapping / HandlerAdapter / 参数解析 / 消息转换 / 视图解析 / 异常处理，都是 Spring MVC 在容器内部再建模出来的主线

所以这篇真正该带走的结论不是“Servlet 规范讲了什么”，而是：

**Spring MVC 把 Web 问题从“HTTP 容器怎么接请求”提升成了“在 Servlet 规范给定的外层边界之内，如何继续建立自己的请求调度与扩展世界”的框架级协议。**

这也留下了下一篇最自然的问题：既然 Servlet 规范层已经立住，那回到集成层，`DispatcherServlet` 到底是怎样被注册进嵌入式 Tomcat 的，以及 `ServletWebServerApplicationContext` 又如何把这条桥接主线真正装起来？

下一篇进入 `DispatcherServlet` 接入 Tomcat 的集成层主线。