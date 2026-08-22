# 为什么 `DispatcherServlet` 明明没人手工注册，却总能出现在 Boot Web 应用的默认入口上

> 本文基于 Spring Boot 3.5.x 与 Spring Framework 6.2.x 当前源码。本文承接前一篇嵌入式 Servlet 容器自动装配，继续往 Web 默认体验的最后一跳推进：既然外层嵌入式 Servlet 容器已经自己带起来了，那 Spring MVC 最核心的前端控制器 `DispatcherServlet` 到底是谁创建、谁注册、为什么默认落到 `/` 这样的请求入口上？重点放在 `DispatcherServletAutoConfiguration`、`DispatcherServletRegistrationBean`、默认 servlet 名称与 mapping、以及它们如何进入 `ServletContextInitializer` / 容器启动链。下一篇将进入 `HttpMessageConverters` 与 JSON 默认体验。

## 为什么从来没写过 `web.xml`，也没手工调过 `addServlet(...)`，`DispatcherServlet` 却还是总站在最前面

只要用过 Spring Boot Web 应用，几乎都见过一种再熟悉不过的事实：

- 没写 `web.xml`
- 没手工注册任何 `Servlet`
- 也没显式 new 过 `DispatcherServlet`
- 但 HTTP 请求一进来，最后总是先进入 Spring MVC

这个现象如果从用户体验看很自然，但从源码角度看其实非常值得单独拆一篇。

因为在传统 Servlet 应用里，这一步通常需要显式处理：

- 容器里要有一个 `DispatcherServlet`
- 它要有名字
- 它要有 URL 映射
- 它还要被放进 ServletContext 的启动注册链

也就是说，Spring MVC 要成为请求入口，不只是“容器里有这个类”这么简单，而是要满足一整组注册条件。

Boot 真正做的，就是把这组条件变成默认结果。

第一层问题是：**`DispatcherServlet` 作为 Bean 存在，不等于它已经成为 Servlet 容器里的请求入口。**

这一点特别容易被忽略。

因为在 Spring 视角里，只要容器里有：

- 一个 `DispatcherServlet` Bean

看起来好像 MVC 核心已经在了。

但对于真正的 Web 请求入口来说，这还远远不够。还必须进一步解决：

- 它在 Servlet 容器里的名字是什么
- 它映射到哪些 URL
- 它什么时候被注册到 ServletContext
- 它是不是 load-on-startup

也就是说，从 Bean 到 Servlet 请求入口，中间还隔着一层：

- **Servlet 注册语义。**

第二层问题是：**Boot 不能只创建 `DispatcherServlet`，还必须把“创建”和“注册”拆成两个协作结果。**

如果把这两件事混成一件事，后面很快就会看不清：

- 哪部分是 Spring 容器里的 Bean 管理
- 哪部分是 Servlet 世界里的注册桥接

所以 Boot 在这里刻意分成两步：

- 先让 `DispatcherServlet` 成为应用上下文中的 Bean
- 再用 `DispatcherServletRegistrationBean` 把它翻译成 Servlet 容器可消费的注册对象

这一步是理解 Boot Web 自动装配边界的关键。

第三层问题是：**默认映射到 `/` 不是偶然习惯，而是 Boot 对“谁应该成为应用默认入口”的明确立场。**

这里也要先把话说准：默认路径通常是 `/`，但它实际来自 `webMvcProperties.getServlet().getPath()`，也就是用户仍可通过 `spring.mvc.servlet.path` 一类配置改变入口前缀。很多人会顺手把默认 `/` 映射当作一个普通默认值看过去。

但实际上，这个默认值一旦改掉，整个 Web 应用的入口语义都会变：

- 请求是否优先走 MVC
- 静态资源和其他 Servlet 会怎样竞争路径
- 用户自定义 servlet path 会怎样影响整条入口链

也就是说，`/` 映射不只是“懒得配置时给的兜底值”，而是：

- **Boot 对 Web 默认入口模型的直接表达。**

因此，本文真正要回答的问题不是“Boot 会自动注册 `DispatcherServlet`”，而是：

**为什么对 Boot 来说，必须把 `DispatcherServlet` 的 Bean 创建、Servlet 注册对象、默认 servlet 名称与 URL 映射、以及容器启动期真正执行注册这几层拆开，再协同接回嵌入式容器启动链，Spring MVC 才能稳定成为 Boot Web 应用的默认请求入口。**

## 先看失败方案：为什么不能只创建 Bean、不能把注册动作塞进 `DispatcherServlet` 本身、也不能把默认入口路径留给用户每次重配

### 失败方案一：只要容器里有 `DispatcherServlet` Bean，就算自动配置完成了

这是最容易出现的错觉。

因为从 Spring 容器视角看，一个核心 Bean 已经在容器里，似乎问题就解决了。

但 Servlet 世界根本不这么看。

对 Servlet 容器来说，请求入口的关键问题不是：

- 这个类是不是某个 Bean

而是：

- 它有没有注册成 Servlet
- 它有没有 URL 映射
- 它是不是在启动时就进入容器

所以光有 Bean 还不够，必须把它继续桥接成容器级注册对象。

### 失败方案二：让 `DispatcherServlet` 自己在初始化时直接向容器注册自己

这个方案看起来很“自洽”：

- 既然它最清楚自己是前端控制器
- 那干脆自己注册自己

问题在于，这会把两个世界搅在一起：

- Bean 生命周期
- Servlet 容器注册生命周期

`DispatcherServlet` 作为 Spring MVC 入口调度器，应该关注的是：

- 请求到来后怎样分发

而不是：

- 自己怎样插进容器启动注册链

所以 Boot 不能把注册动作压回 `DispatcherServlet` 自身，而必须放在独立的注册桥接对象里。

### 失败方案三：默认入口路径留给用户每次自己显式配置

这当然可行，但会直接削弱 Boot 的默认体验价值。

因为对于绝大多数 MVC Web 应用来说，用户最常见的预期就是：

- 整个应用默认由 Spring MVC 接住绝大多数请求

如果每个项目都必须自己决定：

- servlet name 叫什么
- mapping 是 `/` 还是 `/app/*`
- load-on-startup 是多少

那 Boot Web 自动装配就又退回到了“半自动模板”而不是“默认入口系统”。

所以 Boot 必须在这里表达非常明确的默认立场：

- **默认把 `DispatcherServlet` 注册成应用的主请求入口。**

## `DispatcherServlet` 注册链的最小总图

如果把这条链先压缩成最小模型，它可以写成下面这样：

```text
DispatcherServlet bean
   -> DispatcherServletRegistrationBean
   -> ServletContextInitializer
   -> ServletContext.addServlet(...)
   -> mapping "/"
   -> MVC becomes default request entry
```

如果再换一种更适合理解层级的拆法，它可以分成下面五层：

```text
[Bean 创建]
DispatcherServlet bean

   ->

[注册模型]
DispatcherServletRegistrationBean

   ->

[容器启动桥]
ServletContextInitializer

   ->

[真实注册动作]
ServletContext.addServlet + mapping

   ->

[默认入口结果]
DispatcherServlet 成为 Boot Web 应用默认请求入口
```

这张图最重要的价值，不是记住类名，而是把五个问题分开：

### 一、Bean 创建

回答：谁负责把 `DispatcherServlet` 本身放进应用上下文？

### 二、注册模型

回答：谁负责把这个 Bean 翻译成 Servlet 容器可消费的注册对象？

### 三、容器启动桥

回答：这个注册对象怎样进入嵌入式容器启动链？

### 四、真实注册动作

回答：什么时候真正发生 `addServlet(...)`、mapping 和 load-on-startup 设置？

### 五、默认入口结果

回答：为什么最终大多数请求会先由 `DispatcherServlet` 接住？

## 一、`DispatcherServletAutoConfiguration` 先做的不是“接请求”，而是把前端控制器 Bean 和注册桥都准备好

回到最外层自动配置，真正负责把这件事带进应用世界的关键类就是：

- `DispatcherServletAutoConfiguration`

它的重要性不在于自己完成了整个 MVC 运行环境，而在于：

- 它把前端控制器和它的注册桥接对象一起带进容器

也就是说，Boot 在这里至少要解决两件事：

- `DispatcherServlet` 自己要作为 Bean 存在
- 与之对应的注册对象也要作为 Bean 存在

这一步特别关键，因为它再次体现了 Boot 的一贯分层：

- Bean 世界里的对象
- Servlet 世界里的注册语义

不能混成一层处理。

## 二、为什么 `DispatcherServletRegistrationBean` 是这条链最关键的桥，而不是一个普通包装器

只要 `DispatcherServlet` Bean 已经有了，下一个最重要的问题就是：

- 谁去把它变成容器真正认识的 Servlet 注册项？

Boot 的答案是：

- `DispatcherServletRegistrationBean`

这个类很容易被误看成一个“只是包一下 servlet 的简单对象”。

但更准确地说，它承担的是：

- servlet name
- URL mappings
- load-on-startup
- multipart 等注册相关参数
- 与 Boot `WebMvcProperties` 默认值和 Servlet 路径配置的桥接

也就是说，它不是一个随手包装器，而是：

- **把 Spring Bean 翻译成 Servlet 注册语义的专用桥接对象。**

这也是为什么前面一再强调：

- `DispatcherServlet` Bean 存在，不等于请求入口已经成立

真正让请求入口“能落到容器里”的关键层，就是这个 registration bean。

## 三、为什么这个 registration bean 必须同时是 `ServletContextInitializer`

只要注册对象已经存在，下一步问题就变成：

- 它怎样进入嵌入式容器启动过程？

这里又回到了前一篇埋下的桥：

- 容器不是外部服务器
- 它是在 `ServletWebServerApplicationContext` 启动链里被拉起来

所以 `DispatcherServletRegistrationBean` 不能只是“保存一堆注册参数”，它还必须能：

- 在容器启动时真正执行注册动作

这也正是为什么这一类 registration bean 最终会走到：

- `ServletContextInitializer`

语义上。

也就是说，它不仅描述“该怎么注册”，还必须参与：

- **容器启动期的真实注册执行。**

这使整条链闭了环：

- Bean 世界里准备注册对象
- 容器启动时回调它
- 它再把 servlet 正式注册到 `ServletContext`

## 四、为什么默认 servlet 名称和默认 `/` 映射值得被单独看待

很多人看到默认 servlet name 和 `/` 映射时，会下意识觉得：

- 只是些小配置

其实不是。

因为这两个默认值共同定义了：

- 这个 Servlet 在容器里的身份
- 这个 Servlet 在 URL 空间里的地位

尤其是 `/` 映射，几乎就是在明确表达：

- 对这个 Boot Web 应用来说，Spring MVC 是默认主入口

这会直接影响：

- 普通请求谁先接
- 静态资源如何协调
- 用户自定义 servlet path 时，整条入口链如何变化

也就是说，这不是普通的数字/字符串默认值，而是：

- **Web 默认入口模型的一部分。**

## 五、真正的注册动作发生在哪里：不是注解上，也不是 Bean 创建时，而是在容器启动期回调里

这里是这篇最关键的事实边界。

很多人一看到：

- `DispatcherServletAutoConfiguration`
- `DispatcherServletRegistrationBean`

就容易误以为：

- 请求入口已经在 Bean 创建时就确定了

更准确的说法应该是：

- Bean 创建阶段，注册对象已经准备好了
- 容器启动阶段，这个对象才真正获得 `ServletContext`
- 然后才执行真实的 `addServlet(...)` 和映射动作

也就是说，真正的注册现场不在 Bean 定义层，而在：

- **嵌入式容器启动期。**

这一步特别重要，因为它把前几篇的桥重新接上了：

- starter 提供 classpath
- 容器工厂被自动装配
- `ServletWebServerApplicationContext` 拉起 WebServer
- registration bean 作为 `ServletContextInitializer` 进入容器启动链
- 最终 `DispatcherServlet` 真正变成对外请求入口

## 六、为什么 Boot 能做到“默认成立，但用户仍可接管入口语义”

只要默认注册链已经立住，另一个同样重要的问题就是：

- 用户还能不能改？

如果 Boot 在这里完全写死：

- servlet name
- mapping
- 注册参数

那它会再次走向“默认方便，但稍微定制就必须退出整个自动装配世界”。

Boot 不想这么做。

它更合理的平衡是：

- 默认先给出主入口语义
- 但用户仍然可以通过属性、显式 Bean 或其他配置路径调整注册行为

这里也要避免把“可接管”说得过满：最自然的调整路径通常是 `spring.mvc.servlet.path`、multipart 配置或替换/自定义 registration bean 一类入口，而不是意味着所有 servlet 注册语义都应该被频繁整体重写。

也就是说，Boot 在这里不是“禁止用户碰入口”，而是：

- **先把入口默认立住，再让用户按需接管。**

这也是它和“只会塞默认值”的脚手架式框架的区别。

## 七、最小源码证据：这条链确实是“Bean -> registration bean -> ServletContextInitializer -> 容器注册”

如果只讲到这里，读者仍然可能会觉得：

- 这是不是又是一种合理推断
- 源码里有没有更直接的证据说明创建、桥接和注册是分层存在的

先看 `DispatcherServletAutoConfiguration` 的核心 bean 定义：

```java
@Bean(name = DEFAULT_DISPATCHER_SERVLET_BEAN_NAME)
public DispatcherServlet dispatcherServlet(WebMvcProperties webMvcProperties) {
    DispatcherServlet dispatcherServlet = new DispatcherServlet();
    dispatcherServlet.setDispatchOptionsRequest(webMvcProperties.isDispatchOptionsRequest());
    dispatcherServlet.setDispatchTraceRequest(webMvcProperties.isDispatchTraceRequest());
    dispatcherServlet.setPublishEvents(webMvcProperties.isPublishRequestHandledEvents());
    dispatcherServlet.setEnableLoggingRequestDetails(webMvcProperties.isLogRequestDetails());
    return dispatcherServlet;
}
```

以及：

```java
@Bean(name = DEFAULT_DISPATCHER_SERVLET_REGISTRATION_BEAN_NAME)
@ConditionalOnBean(value = DispatcherServlet.class, name = DEFAULT_DISPATCHER_SERVLET_BEAN_NAME)
public DispatcherServletRegistrationBean dispatcherServletRegistration(DispatcherServlet dispatcherServlet,
        WebMvcProperties webMvcProperties, ObjectProvider<MultipartConfigElement> multipartConfig) {
    DispatcherServletRegistrationBean registration = new DispatcherServletRegistrationBean(dispatcherServlet,
            webMvcProperties.getServlet().getPath());
    registration.setName(DEFAULT_DISPATCHER_SERVLET_BEAN_NAME);
    registration.setLoadOnStartup(webMvcProperties.getServlet().getLoadOnStartup());
    multipartConfig.ifAvailable(registration::setMultipartConfig);
    return registration;
}
```

这两段代码至少证明了三件事：

- `DispatcherServlet` 自己先作为 Bean 被创建
- 注册语义由单独的 `DispatcherServletRegistrationBean` 承担
- 默认名称、路径、load-on-startup 等入口语义都在注册层集中设置

再结合前一篇已经讲过的：

- `ServletContextInitializer` 会在嵌入式容器启动过程中被真正回调

就可以把整条链闭起来：

- Bean 世界准备好 `DispatcherServlet`
- registration bean 准备好容器注册语义
- 容器启动期再真正执行注册动作

也就是说，Boot 在这里的真实结构并不是：

- “MVC 自己冒出来就接请求了”

而是：

- **`DispatcherServlet` 先作为 Bean 存在，再通过 registration bean 和容器启动桥，真正成为默认请求入口。**

## 八、为什么这篇必须放在消息转换器篇之前

看到这里，最值得回收的一个问题就是：

- 为什么不先讲 JSON 和 `HttpMessageConverters`，反正用户感知更明显？

因为如果默认请求入口还没立住，后面很多“收发 JSON”的体验其实都没有真正的承载点。

也就是说：

- `@RequestBody` 为什么能工作
- `@ResponseBody` 为什么能返回 JSON
- controller 为什么会先被 MVC 接住

这些问题都默认建立在：

- `DispatcherServlet` 已经是 Web 应用的真实前端入口

这个前提上。

所以顺序上，先讲“谁把 MVC 挂到请求入口上”，再讲“入口之后怎么做消息转换”，逻辑才闭环。

## 九、几个最容易错的判断

### 1. `DispatcherServlet` 只要作为 Bean 存在，就天然会成为请求入口

不成立。

从 Bean 到 Servlet 请求入口，中间还隔着注册模型、mapping 和容器启动期真正执行注册这几层。

### 2. `DispatcherServletRegistrationBean` 只是个简单包装器，没有什么机制价值

不成立。

它承担了 servlet 名称、路径、load-on-startup、multipart 配置等一整组 Servlet 注册语义。

### 3. 默认映射到 `/` 只是随手给的兜底值

不完整。

它实际上表达了 Boot 对“Spring MVC 应作为应用默认主入口”的默认立场。

### 4. `DispatcherServlet` 的注册动作发生在 Bean 创建时

不成立。

Bean 创建时只是把 servlet 和 registration bean 准备好；真实注册动作要等到容器启动期通过 `ServletContextInitializer` 执行。

### 5. Boot 一旦默认注册了 `DispatcherServlet`，用户就很难再调整入口语义

不成立。

Boot 的设计仍然是默认成立、用户可接管，而不是封死入口。 

## 收网：Boot 统一的不是“帮你 new 一个 `DispatcherServlet`”，而是“把 MVC 前端控制器稳定挂到 Web 应用默认入口上”

现在可以回到开头的问题：为什么 `DispatcherServlet` 明明没人手工注册，却总能出现在 Boot Web 应用的默认入口上？

因为真实发生的不是“框架偷偷帮你 new 了一个 servlet”，而是一条分层注册链：

```text
DispatcherServlet Bean
   -> DispatcherServletRegistrationBean
   -> ServletContextInitializer
   -> ServletContext.addServlet + 默认 mapping
   -> MVC 成为 Boot Web 应用默认请求入口
```

所以这篇真正该带走的结论不是“Boot 自动注册了 `DispatcherServlet`”，而是：

**Boot 先把 `DispatcherServlet` 作为 Bean 放进应用上下文，再用 `DispatcherServletRegistrationBean` 承担 Servlet 注册语义，并在嵌入式容器启动期通过 `ServletContextInitializer` 真正把它注册到容器；因此，Spring MVC 默认入口并不是偶然存在，而是 Boot 精确桥接 Bean 世界与 Servlet 世界后的结果。**

下一篇进入 `HttpMessageConverters` 与 JSON 默认体验：既然默认请求入口已经立住，那请求体和响应体为什么又能在不手工配置的情况下自然完成对象与 JSON 之间的转换。