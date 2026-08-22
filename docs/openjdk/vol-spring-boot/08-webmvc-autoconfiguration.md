# 为什么引入 `spring-boot-starter-web` 后，一个 MVC 应用几乎就自己站起来了

> 本文基于 Spring Boot 3.5.x 与 Spring Framework 6.2.x 当前源码。本文承接上一篇 Starter 机制，开始进入最典型的一条默认装配主线：Web MVC 自动装配。重点不在 `DispatcherServlet` 内部请求处理原理，而在 `spring-boot-starter-web` 带来的依赖基础，如何通过 `DispatcherServletAutoConfiguration`、`ServletWebServerFactoryAutoConfiguration`、`WebMvcAutoConfiguration` 等自动配置，把一个普通 Boot 应用推到“默认可提供 MVC Web 能力”的状态。下一篇将继续进入嵌入式 Servlet 容器自动装配。

## 为什么明明只引了一个 Web starter，却像突然拥有了一整套 MVC 运行环境

只要做过 Spring Boot Web 应用，几乎都会有一种非常直观的体验：

- 只引一个 `spring-boot-starter-web`
- 写一个 `@RestController`
- 再加一个 `main` 方法
- 应用就能直接监听端口、接收 HTTP 请求、解析 JSON、返回响应

这件事熟悉到很容易被低估。

因为如果退回到没有 Boot 的世界，要让一个 MVC 应用真正跑起来，至少要解决：

- 要不要有 Servlet 容器
- `DispatcherServlet` 谁来注册
- MVC 核心基础设施谁来配
- JSON 消息转换器谁来放进去
- 静态资源、欢迎页、格式化、校验、参数解析、异常处理默认策略从哪来

也就是说，用户感知到的是：

- “引一个 starter 之后，MVC 世界就起来了”

但源码层面真实发生的是：

- **一整组 Web 相关自动配置候选，在 Servlet 环境、类路径条件和默认退让规则满足时，协同落成了一套 MVC 默认运行环境。**

第一层问题是：**Web starter 本身不等于 MVC 自动配置，它只是把 MVC 自动配置得以成立的类路径和依赖基础先带进来。**

上一篇已经说明：

- starter 首先改变的是 classpath 事实

对于 Web 场景来说，这意味着：

- Spring MVC 所需的核心类在 classpath 上可见
- 嵌入式 Servlet 容器实现已经出现
- JSON 相关能力具备成立前提

但到这里还只是“可以开始自动装配”，并不是“已经配好了 MVC”。

第二层问题是：**Boot 的 Web 默认体验不是单个自动配置类的结果，而是多个自动配置模块协同后的结果。**

如果只盯着一个类，例如：

- `DispatcherServletAutoConfiguration`

很容易误会成：

- 好像它一个类就把整个 MVC 世界装完了

真实情况不是这样。

至少在最常见的 Servlet MVC 场景里，最终默认体验通常同时依赖：

- 容器相关自动配置
- `DispatcherServlet` 注册自动配置
- MVC 基础设施自动配置
- JSON / `HttpMessageConverter` 自动配置
- 某些错误页与异常处理相关自动配置

这里也要把边界说准：错误页和通用错误处理虽然常被用户感知成“Web 默认体验”的一部分，但它们不全都属于 MVC 基础设施本体；有些更接近 Servlet 错误页面和 Boot 错误处理层。

也就是说，Boot 的 Web 默认体验首先是一种：

- **协同装配结果**

而不是单个配置类的魔法。

第三层问题是：**Boot 在 Web 场景里真正提供的，不只是“把 MVC 打开”，而是“给 MVC 提供一套默认但可退让的运行环境”。**

这点特别关键。

因为 Boot 不想做的是：

- 替用户完全接管 Spring MVC

它更想做的是：

- 先给用户一套合理的默认配置
- 但一旦用户显式扩展或接管，默认装配应尽量退让

这也是为什么 Web 自动配置里，既有很多默认 Bean，也有：

- `@ConditionalOnMissingBean`
- `WebMvcConfigurer`
- 用户自定义 `HttpMessageConverters`、`Validator`、资源处理、格式化器等扩展点

这里也要避免把“可接管”说得太绝对：Boot 确实提供了很多渐进式扩展口，但不同层级的默认组件并不是都建议或都适合直接替换；有些更适合通过配置器扩展，有些则是通过显式 Bean 替代。

因此，本文真正要回答的问题不是“Boot 怎么自动配置 MVC”，而是：

**为什么对 Boot 来说，必须把 Web starter 提供的类路径前提，翻译成由容器自动配置、`DispatcherServlet` 自动配置、MVC 基础设施自动配置和消息转换器自动配置共同组成的一套默认 MVC 运行环境，并让这套环境始终保持可扩展、可覆盖、可退让。**

## 先看失败方案：为什么不能只注册一个 `DispatcherServlet`、不能把所有 Web 默认行为塞进同一个配置类、也不能让 Boot 完全接管 MVC 不给用户退路

### 失败方案一：只要自动注册一个 `DispatcherServlet`，Web MVC 就算配好了

这是最容易产生的错觉。

因为在 Spring MVC 世界里，`DispatcherServlet` 的地位确实非常核心。

但只注册它远远不够。

因为一个真正可用的 MVC 运行环境还需要：

- `HandlerMapping`
- `HandlerAdapter`
- `HandlerExceptionResolver`
- `HttpMessageConverter`
- 静态资源处理
- 格式化与校验相关基础设施

也就是说：

- `DispatcherServlet` 是入口调度器
- 但不是整个 MVC 世界的全部

如果只注册它，最多只是把门打开，却没有把屋里该有的东西摆好。

### 失败方案二：把容器、MVC、JSON、错误处理全塞进一个超级自动配置类里

这个方案看起来最“集中”：

- 用户只要引一个 Web starter
- 那就让一个自动配置类把所有 Web 默认体验一次性装完

问题在于，这会直接把不同层级的问题揉成一团：

- 容器层问题
- Servlet 注册问题
- MVC 基础设施问题
- 消息转换器问题
- 错误处理问题

这些问题虽然最终共同构成 Web 默认体验，但它们并不是一个抽象层。

如果全塞到一个配置类里：

- 条件边界会变得极难维护
- 用户扩展时也很难知道该从哪一层接管
- 整条装配链的桥接关系会被抹平

所以 Boot 必须把这条默认体验拆成协作装配，而不是做成一个巨大黑盒。

### 失败方案三：Boot 一旦开启 MVC，就完全接管，不给用户扩展空间

这同样会毁掉 Boot 的设计平衡。

因为真实项目非常常见的需求就是：

- 默认配置先给我一个能跑的 MVC 应用
- 但某些细节我要自己改

例如：

- 自定义消息转换器
- 修改静态资源处理
- 增加拦截器
- 替换某些默认 Bean

如果 Boot 完全接管 MVC，用户的唯一选择就会变成：

- 要么全吃默认
- 要么彻底退出 Boot 默认体验，自己重配整套 MVC

这显然不是一个好框架该给出的取舍。

所以 Web 自动配置必须天然支持：

- **默认成立，但用户可渐进式接管。**

## Web MVC 自动装配的最小总图

如果把这条装配链先压缩成最小模型，它可以写成下面这样：

```text
spring-boot-starter-web
   -> servlet/webmvc/tomcat/json classes on classpath
   -> servlet web application conditions match
   -> dispatcher servlet + mvc infrastructure + message converters auto-configure
   -> default MVC runtime environment appears
```

如果再换一种更适合理解分层的拆法，它可以分成下面五层：

```text
[依赖前提]
web starter 改变 classpath

   ->

[应用类型前提]
Servlet WebApplicationType 成立

   ->

[容器与入口]
ServletWebServerFactory + DispatcherServlet registration

   ->

[MVC 基础设施]
WebMvcAutoConfiguration

   ->

[消息与默认体验]
HttpMessageConverters / Jackson / 静态资源 / 欢迎页 / 错误处理
```

这张图最重要的价值，不是背配置类名，而是把五个问题分开：

### 一、依赖前提

回答：为什么 starter 一引入，Web 自动配置 suddenly 有了成立前提？

### 二、应用类型前提

回答：为什么必须先是 Servlet Web 应用，后续这条链才有意义？

### 三、容器与入口

回答：谁负责把 WebServer 与 `DispatcherServlet` 这两个最外层入口立起来？

### 四、MVC 基础设施

回答：谁负责把 Spring MVC 运行所需的那套默认组件放进容器？

### 五、消息与默认体验

回答：为什么用户最后感知到的是 JSON、静态资源、欢迎页等完整体验，而不是几个孤立 Bean？

## 一、`spring-boot-starter-web` 先带来的不是 MVC 本身，而是“这条默认体验可以成立的类路径事实”

上一篇已经讲过 starter 的本质：

- 它首先是默认体验的依赖入口

所以回到 Web 场景，第一步不能直接问：

- MVC 为什么自动好了

而应该先问：

- 哪些类路径前提先被带进来了

从模块依赖角度看，`spring-boot-starter-web` 至少会把：

- `spring-web`
- `spring-webmvc`
- 嵌入式 Tomcat starter
- JSON starter

这类核心依赖组合带进来。

这里的“默认 Servlet 容器”也要说准：对 `spring-boot-starter-web` 而言，默认带上的是 Tomcat starter；但 Boot 的 Servlet Web 路径并不只支持 Tomcat，Jetty 和 Undertow 仍可以通过替换对应 starter 进入这条装配世界。

这意味着什么？

意味着前面条件体系篇里提到的很多判断，现在突然有了可能成立的基础：

- MVC 核心类存在
- Servlet Web 容器实现存在
- JSON 序列化基础存在

也就是说，starter 到这里做的仍然不是“装 Bean”，而是：

- **把 Web 默认装配所需的类路径事实先铺平。**

## 二、为什么必须先是 Servlet Web 应用：不是任何 Boot 应用都该装 MVC

即便 Web starter 已经引入，Boot 也不能不加区分地给所有应用装 MVC。

因为在 Boot 里至少还存在：

- 非 Web 应用
- Reactive Web 应用
- Servlet Web 应用

MVC 这条链只属于其中一类：

- Servlet Web 应用

这也是为什么 Web MVC 自动装配的很多关键类，都会建立在：

- `@ConditionalOnWebApplication(type = SERVLET)`

这一类条件之上。

也就是说，Web starter 改变的是“能不能装”的 classpath 前提，而 Web 条件决定的是：

- **当前应用是不是该走 MVC 这条默认路径。**

如果这条边界不立住，Boot 很容易在错误应用类型里误装 Servlet MVC 世界。

## 三、`DispatcherServletAutoConfiguration`：Boot 先把前端控制器与注册入口立起来

只要应用类型已经确定是 Servlet Web 应用，下一层最容易被感知到的自动配置通常就是：

- `DispatcherServletAutoConfiguration`

它的重要性不在于“MVC 全部都在这”，而在于：

- 它把 Spring MVC 最外层的前端控制器 Bean 与 Servlet 注册入口接了起来

也就是说，Boot 在这里解决的不是 MVC 所有细节，而是先把两个最外层入口立住：

- 容器里有一个 `DispatcherServlet`
- 这个 `DispatcherServlet` 会被注册到 Servlet 容器

前面 `vol-spring` 已经单独讲过：

- `DispatcherServlet` 在 Framework 层怎么做请求调度
- 它怎样注册进 Servlet 容器

Boot 这里补的不是原理，而是：

- **把这些原理变成默认成立的应用装配结果。**

## 四、`WebMvcAutoConfiguration`：真正把 MVC 运行环境铺出来的不是入口 Servlet，而是这层基础设施自动配置

如果 `DispatcherServletAutoConfiguration` 解决的是“入口立起来”，那真正把 MVC 世界铺开的关键类通常就是：

- `WebMvcAutoConfiguration`

这类自动配置负责的不是一个单点组件，而是一整套 MVC 默认基础设施，例如：

- 默认的 MVC 配置适配器
- 格式化和转换相关基础设施
- 静态资源处理
- 欢迎页支持
- 一些与消息转换、校验、路径匹配有关的默认策略

也就是说，用户之所以觉得“一个 MVC 应用几乎自己站起来了”，真正的原因并不是：

- 只有一个 DispatcherServlet 被注册了

而是：

- **一整套 MVC 运行时基础设施已经被默认铺好。**

这一点也再次证明，Boot Web 默认体验是协同装配结果，而不是单类魔法。

## 五、为什么 JSON、`HttpMessageConverter` 和 Controller 返回值体验会跟着一起成立

只要 MVC 基础设施已经有了，用户很快就会进一步感受到另一层“自动好了”的体验：

- `@RequestBody` 可以直接反序列化 JSON
- `@ResponseBody` / `@RestController` 可以直接返回 JSON
- 常见对象的序列化行为基本开箱即用

这背后并不是 MVC 自己天然完成的，而是：

- JSON 相关依赖已在 classpath 上
- `HttpMessageConverters` 自动配置命中
- Jackson 相关默认对象和定制链进入容器

也就是说，用户感知到的“Web 应用默认能收发 JSON”，本质上是：

- **MVC 自动配置和消息转换自动配置已经协同落地。**

这也解释了为什么 Web 默认体验常常不是单个 autoconfigure 模块就能讲完的。

## 六、为什么静态资源、欢迎页和默认 Web 行为会让人误以为 Boot 在“接管 MVC”

除了 Controller 和 JSON，Boot 还会给出很多非常容易被忽略、却非常强烈的默认体验：

- 静态资源目录默认可用
- `index.html` 可能自然成为欢迎页
- 某些常见格式化、路径匹配、错误处理行为已经有默认策略

正是这些东西叠加起来，才让很多用户产生一种强烈感觉：

- Boot 好像“把整个 Web 都接管了”

但更准确的理解应该是：

- Boot 给出的是一套默认行为组合
- 这些默认行为大多建立在 `@ConditionalOnMissingBean`、可配置属性和扩展点之上
- 它并不试图禁止用户扩展，而是试图减少“从零起配 MVC”的摩擦

也就是说，Boot 在 Web 场景里真正提供的不是绝对控制，而是：

- **高质量默认值。**

## 七、为什么这条链必须始终允许用户渐进式接管，而不是只能二选一

Web 场景是最能检验 Boot 设计克制力的地方。

因为如果 Boot 太弱：

- 用户会抱怨“还要自己配一堆 MVC 细节”

如果 Boot 太强：

- 用户会抱怨“我一改默认行为就得退出整个 Boot 世界”

真正合理的平衡只能是：

- 默认先把 80% 的 MVC 体验铺好
- 剩下 20% 允许用户按层渐进式接管

这也是为什么 Boot Web 自动配置世界里，用户通常可以通过：

- 自定义某些 Bean
- 提供 `WebMvcConfigurer`
- 替换某些默认 `HttpMessageConverter`
- 添加拦截器、格式化器、校验器

来逐步调整默认体验，而不必重写整套 MVC。

这正是 Boot 在 Web 层最重要的设计价值之一：

- **让默认体验和用户接管不是互斥关系。**

## 八、最小源码证据：这条链确实不是“一个 Web starter + 一个 DispatcherServlet”那么简单

如果只讲概念，读者仍然可能会觉得：

- 这是不是只是一些经验总结
- 源码层面有没有更直接的证据说明它是协同装配链

先看 Web starter 本身的依赖聚合证据：

```groovy
dependencies {
    api(project(":spring-boot-project:spring-boot-starters:spring-boot-starter"))
    api(project(":spring-boot-project:spring-boot-starters:spring-boot-starter-json"))
    api(project(":spring-boot-project:spring-boot-starters:spring-boot-starter-tomcat"))
    api("org.springframework:spring-web")
    api("org.springframework:spring-webmvc")
}
```

来源：`spring-boot-project/spring-boot-starters/spring-boot-starter-web/build.gradle:23`。

它证明了第一层事实：

- Web starter 先把 MVC、JSON 和默认 Servlet 容器依赖组合带上

再看 `DispatcherServletAutoConfiguration` 上最关键的条件入口：

```java
@AutoConfigureOrder(Ordered.HIGHEST_PRECEDENCE)
@AutoConfiguration(after = ServletWebServerFactoryAutoConfiguration.class)
@ConditionalOnWebApplication(type = Type.SERVLET)
@ConditionalOnClass(DispatcherServlet.class)
public class DispatcherServletAutoConfiguration {
```

这段定义证明了第二层事实：

- 这条自动配置只在 Servlet Web 应用 + `DispatcherServlet` 类存在时才成立
- 而且它明确放在 Servlet WebServer 工厂自动配置之后

也就是说，Web MVC 默认体验的真实结构不是：

- “引一个 starter，自动就有 Web”

而是：

- **starter 提供依赖前提，多个自动配置类在 Servlet 环境下按条件协同成立。**

## 九、为什么这篇必须放在嵌入式容器篇之前，而不是先讲 Tomcat 再讲 MVC

看到这里，最值得回收的一个问题就是：

- 为什么先讲 Web MVC 自动装配，再单独压嵌入式容器？

因为从用户心智看，最先感知到的不是：

- Tomcat 的生命周期细节

而是：

- 我为什么一引 Web starter，写个 Controller 就能跑起来

也就是说，先立住“Web 默认体验是协同装配结果”，读者再进入下一篇看嵌入式容器时，才知道：

- 容器自动装配是这套默认体验的一层
- 不是 Web 默认体验的全部

如果顺序反过来，很容易把 Boot Web 世界误读成“其实就是自动起个 Tomcat”。

## 十、几个最容易错的判断

### 1. `spring-boot-starter-web` 一引入，MVC 就已经自动配置好了

不完整。

starter 先提供 classpath 前提，真正让 MVC 成立的是后续多个自动配置模块的协同命中。

### 2. `DispatcherServletAutoConfiguration` 就等于整个 Web MVC 自动配置

不成立。

它更像前端控制器与注册入口层，完整 MVC 默认体验还依赖 WebMvc、消息转换器、容器和其他相关自动配置。

### 3. Boot Web 默认体验的本质就是自动启动一个 Tomcat

不成立。

Tomcat 只是最外层容器前提之一，MVC 基础设施、JSON、静态资源、欢迎页等默认行为共同构成了完整体验。

### 4. Boot 一旦开启 MVC，就等于完全接管 MVC

不成立。

它提供的是默认可用、用户可接管的装配环境，而不是禁止用户扩展的封闭系统。

### 5. Web 自动配置应该全部塞进一个类里，用户理解起来反而更简单

不成立。

不同层级的问题必须分层装配，否则条件边界和扩展边界都会变得模糊。

## 收网：Boot 统一的不是“怎么自动起一个 Web 进程”，而是“怎样把 Servlet MVC 应用所需的多层默认能力协同装起来”

现在可以回到开头的问题：为什么引入 `spring-boot-starter-web` 后，一个 MVC 应用几乎就自己站起来了？

因为真实发生的不是单个开关被打开，而是一条协同装配链：

```text
web starter
   -> MVC / JSON / servlet container 相关依赖进入 classpath
   -> Servlet WebApplicationType 成立
   -> WebServer / DispatcherServlet / WebMvc / MessageConverters 等自动配置协同命中
   -> 一个默认可运行、可扩展、可退让的 MVC 环境落地
```

所以这篇真正该带走的结论不是“Web starter 很强”，而是：

**Boot 先用 starter 带来 Web 依赖前提，再通过容器、前端控制器、MVC 基础设施和消息转换器等多层自动配置协同落地；因此，用户感知到的并不是某一个 Bean 被自动创建，而是一整套 Servlet MVC 默认运行环境已经被装起来。**

下一篇进入嵌入式 Servlet 容器自动装配：既然 Web 默认体验已经立住，那 Boot 到底是怎样把 Tomcat 这类 Servlet 容器创建出来，并和应用上下文真正接到一起的。