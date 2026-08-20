# 为什么 `DispatcherServlet` 不需要 `web.xml` 也能进 Tomcat：从 `ServletWebServerApplicationContext` 到嵌入式容器的注册链

> 本文基于 Spring Framework 6.x、Spring Boot 3.x 与 Tomcat 10.1.x 当前源码。本文只讲集成层的第一篇：Spring Boot 是怎样在没有 `web.xml` 的情况下，把 `DispatcherServlet` 注册进嵌入式 Tomcat 的。重点放在 `ServletWebServerApplicationContext`、`ServletContextInitializer`、`ServletRegistrationBean` / `DispatcherServletRegistrationBean` 与 `TomcatStarter` 这一条注册链上。Tomcat 内部如何再把这些注册项接成 `Wrapper` 和请求入口，会在下一篇继续展开。

## 为什么明明没有 `web.xml`，`DispatcherServlet` 却还是准时出现在 Tomcat 里

如果你是从传统 Servlet 项目一路走到 Spring Boot 的，很容易在某个时刻冒出一个很实际的问题：

- 以前配 Spring MVC，常常要写 `web.xml`
- 现在只写一个 `@SpringBootApplication`
- 连 `DispatcherServlet` 都没手工注册
- 但应用照样能监听端口、接收请求、把请求分发到 Spring MVC

也就是说，**Tomcat 里那个最关键的 Servlet 是谁注册进去的？**

这个问题之所以重要，不只是因为它是“配置从哪来的”这么简单，而是因为它恰好站在两套世界的交界上：

- 一边是 Spring Boot / Spring Framework 的 Bean 世界
- 一边是 Servlet 容器（这里是 Tomcat）的 Servlet / Filter / Listener 注册世界

前面我们已经把这两边各自的主线讲得很清楚了：

- Spring 一边有 `ApplicationContext`、`refresh()`、`BeanFactoryPostProcessor`、`BeanPostProcessor`
- Servlet 一边有 `HttpServlet`、`Filter`、`ServletContext`
- `DispatcherServlet` 自己又站在两边中间，既是 Spring MVC 的总调度器，又是一个 `HttpServlet`

所以这里真正要解释的，不是“少写了哪个配置文件”，而是：

**两套注册模型到底是怎样被桥起来的。**

第一层问题是：**`DispatcherServlet` 在 Spring 世界里首先只是一个 Bean，不是一个已经放进 Tomcat 的 Servlet。**

也就是说，Spring 容器里先发生的是：

- `DispatcherServlet` 被创建为普通 Bean
- 它拥有 Spring MVC 的所有内部调度逻辑

但这还不够。因为只要它还停留在 Bean 世界里，Tomcat 根本不知道：

- 有这么一个 Servlet
- 它该映射到哪个 URL
- load-on-startup 是多少
- asyncSupported 是否开启

这说明 Spring Boot 还必须再做一层“翻译”。

第二层问题是：**Spring Boot 不是直接 new 一个 Tomcat `Wrapper` 塞进去，而是先把注册意图统一成 `ServletContextInitializer` 体系。**

这点特别关键。

因为 Spring Boot 面对的并不只是一种注册项：

- `DispatcherServlet`
- 其他普通 Servlet
- Filter
- Listener
- ErrorPage

如果每种都单独写一套“Spring Bean → Tomcat 内部对象”的映射逻辑，整个集成层会很快碎掉。

所以它先抽出一层更中性的桥：

- **`ServletContextInitializer`**

也就是说，在真正接触 Tomcat 前，Spring Boot 先把“我要向 Servlet 容器注册什么”统一描述成一个个 `onStartup(ServletContext)` 动作。

第三层问题是：**嵌入式容器注册不是在容器已经完全跑起来以后做的，而是卡在 `refresh()` 过程中的一个特定时点。**

如果这个时机放错，问题会立刻出现：

- 太早：很多需要注册的 Bean 还没准备好
- 太晚：Tomcat 端口可能已经绑定，但 Servlet / Filter 还没装进容器

所以 Spring Boot 必须明确决定：

- Spring Bean 世界什么时候已经足够稳定，适合把注册信息翻译到 `ServletContext`
- Tomcat 又在什么时候拿到这些初始化器，并把它们真正落成容器内部结构

因此，本文真正要回答的问题不是“Spring Boot 怎么省掉 `web.xml`”，而是：

**为什么对 Spring Boot 来说，`DispatcherServlet` 的嵌入式注册必须被拆成“Bean 创建 → 注册意图建模 → `ServletContextInitializer` 桥接 → Tomcat 启动时回调”的完整集成链，而不是一个简单的自动配置黑盒？**

## 先看失败方案：为什么不能在 Bean 创建时直接注册 Servlet、也不能把 Tomcat 注册逻辑散落在每个 Bean 里

### 失败方案一：`DispatcherServlet` Bean 一创建出来，就直接调用 Tomcat API 注册自己

这是最容易想到的方案。

因为从表面看，好像只要 `DispatcherServlet` 已经是个 Bean，就可以立刻：

- 拿到 Tomcat
- 调 `addServlet`
- 再设置 mapping

这个思路的问题在于，它会把 Spring Bean 生命周期和 Servlet 容器注册阶段硬绑在一起。

而真实情况是：

- `DispatcherServlet` Bean 的创建只是 Spring 世界里的事实
- Tomcat 什么时候可注册、其他 Filter / Servlet / Listener 是否已经都准备好，根本不是这个 Bean 自己能决定的

也就是说，Servlet 注册不是某个 Bean 自己的职责，而是：

- **整个 Web 应用装配过程中的一环。**

如果让它在 Bean 创建时直接注册，后面很难统一处理：

- 多个 Servlet / Filter 的排序
- 统一的 URL 映射约束
- 容器还没完全就绪时的注册时机问题

### 失败方案二：每种注册项各自直接对 Tomcat 编程

如果意识到单个 Bean 自己注册不合理，第二种自然思路就会变成：

- `DispatcherServlet` 自己有一套注册逻辑
- `FilterRegistrationBean` 自己有一套
- `ServletRegistrationBean` 再有一套
- 最后都直接碰 Tomcat API

这个方案的问题在于，它会把集成层撕成很多平行小逻辑。

而 Spring Boot 真正要守住的，是一套统一的 Servlet 容器注册模型。

所以它不能让每个注册项各写各的 Tomcat 编程，而必须先抽出：

- `ServletContextInitializer`
- `RegistrationBean`

这样的中间层，让所有注册意图先被统一表达，再统一翻译给容器。

### 失败方案三：等 Tomcat 完全启动后再补注册 `DispatcherServlet`

如果再往后退一步，有人会想：

- 那就先让 Tomcat 启动起来
- 容器活了以后再补注册 Servlet

这个方案也不成立。

因为对 Servlet 容器来说，Servlet / Filter / Listener 的注册，本来就属于：

- 启动阶段要完成的初始化工作

一旦端口都已经对外开放，Servlet 还没进来，就会出现很危险的“容器已接流量、调度器还没挂好”的空窗期。

所以正确时机一定是：

- **Tomcat 启动过程中的回调阶段**

而不是启动前某个单个 Bean 时刻，也不是启动后某个补丁时刻。

## `DispatcherServlet` 接入嵌入式 Tomcat 的最小总图

如果把这条链先压缩成最小模型，它可以写成下面这样：

```text
Spring beans
   -> ServletContextInitializerBeans collect registration intents
   -> ServletWebServerApplicationContext creates WebServer
   -> TomcatStarter.onStartup(ServletContext)
   -> each initializer registers servlet/filter/listener
   -> DispatcherServlet appears in servlet container
```

如果再换一种更容易理解的拆法，这条链可以分成四层：

```text
[Bean 世界]
DispatcherServlet / RegistrationBean / FilterRegistrationBean

   ->

[桥接模型]
ServletContextInitializer

   ->

[上下文触发点]
ServletWebServerApplicationContext.onRefresh / createWebServer

   ->

[容器回调点]
TomcatStarter.onStartup(ServletContext)
```

这张图最重要的价值，不是让读者记住几个类名，而是先把四个问题分开：

### 一、Bean 世界

回答：Spring 自己先持有哪些与 Web 注册相关的 Bean？

### 二、桥接模型

回答：为什么 Spring Boot 先把注册动作统一抽成 `ServletContextInitializer`，而不是直接碰 Tomcat？

### 三、上下文触发点

回答：在 `refresh()` 的哪一个阶段，Spring Boot 认为“现在可以创建 WebServer 并准备注册 Servlet”了？

### 四、容器回调点

回答：Tomcat 真正是在什么时机拿到这些初始化器，并把 `DispatcherServlet` 注册进 `ServletContext`？

## 一、`ServletWebServerApplicationContext`：Web 容器创建的真正触发点不在 Bean 世界，而在 `refresh()` 的子类钩子里

如果先从 Spring 侧看，最重要的入口不是 `DispatcherServlet` Bean 本身，而是：

- `ServletWebServerApplicationContext.onRefresh()`

这一步特别关键。

因为它说明 Spring Boot 并不是在某个 Bean 创建完成后顺手启动 Web 容器，而是：

- 在 `AbstractApplicationContext.refresh()` 的模板方法骨架里
- 通过子类钩子 `onRefresh()`
- 在一个受控时点统一触发 `createWebServer()`

也就是说，Web 容器的创建和 Servlet 注册本来就是：

- **ApplicationContext 激活过程的一部分**

而不是某个单个 Bean 的附属行为。

这和前面 `refresh()` 总串联篇完全呼应：

- `onRefresh()` 就是留给子类在总体启动骨架里插入自己世界的那个口子

对于 Web 上下文来说，这个“自己世界”恰好就是：

- 创建内嵌 WebServer
- 把 Spring 的注册意图翻译给 Servlet 容器

## 二、`ServletContextInitializerBeans`：Spring 不是直接找 `DispatcherServlet`，而是先收集所有“要注册到容器里的东西”

只要 WebServer 创建入口立住之后，下一步最关键的工作就不是“注册 DispatcherServlet”，而是：

- **先把所有注册意图收集起来。**

这正是 `ServletContextInitializerBeans` 存在的原因。

它会从 BeanFactory 中收集：

- `ServletRegistrationBean`
- `FilterRegistrationBean`
- 其它实现了 `ServletContextInitializer` 的 Bean

也就是说，Spring Boot 在这一层并不先区分：

- 你是 DispatcherServlet
- 还是普通 Filter
- 还是别的 Listener

它先统一问的是：

- 你能不能在 `onStartup(ServletContext)` 里完成一次注册动作？

这说明 `ServletContextInitializer` 才是集成层真正统一的语言，而 `DispatcherServlet` 只是最终某一种会被注册进去的对象。

## 三、`DispatcherServletRegistrationBean`：DispatcherServlet 不是直接进 Tomcat，而是先变成一个“注册意图对象”

这一步特别值得单独拎出来。

因为很多人会本能地以为：

- Spring 最后就是把 `DispatcherServlet` 直接丢进 Tomcat

真实情况要更间接一层。

对于 `DispatcherServlet`，Spring Boot 首先会把它包成：

- `DispatcherServletRegistrationBean`

这个对象真正承载的不是调度逻辑本身，而是：

- servletName
- URL mappings
- loadOnStartup
- asyncSupported
- init parameters

也就是说，`DispatcherServlet` 在这里先从“执行体”变成了：

- **可交给 Servlet 容器注册的描述对象。**

这一步非常重要，因为它再次说明：

- Spring Boot 不是直接碰 Tomcat 内部对象
- 它先把注册语义抽象成一个独立模型

而 `ServletRegistrationBean` / `DispatcherServletRegistrationBean` 正是这个模型在 Servlet 方向上的落地。

## 四、`TomcatStarter`：真正把 Spring 注册意图翻译进 Tomcat 的，是一个 `ServletContainerInitializer` 适配器

只要前面的注册意图都已经被收集好了，最后关键的问题就是：

- 它们怎样在 Tomcat 启动时真正生效？

这时候真正接棒的不是某个 Spring Bean，而是：

- `TomcatStarter`

它实现了：

- `ServletContainerInitializer`

这一步特别关键，因为它正好站在 Servlet 规范和 Spring 世界的边界上。

也就是说：

- Tomcat 只认 `ServletContainerInitializer` 这类容器启动回调
- Spring 手里却是一组 `ServletContextInitializer`

`TomcatStarter` 的作用正是：

- 在 Tomcat 的 `onStartup(ServletContext)` 回调里
- 遍历 Spring 收集好的 `ServletContextInitializer`
- 逐个调用它们的 `onStartup(servletContext)`

也就是说，TomcatStarter 不是“又一个启动类”，而是：

- **Servlet 规范层回调模型与 Spring 注册模型之间的翻译器。**

没有这层适配，Spring Bean 世界里的注册意图永远到不了 Tomcat 的 `ServletContext`。

## 五、为什么这里不需要 `web.xml`：因为 Servlet 3.0 之后，编程式注册已经是规范通道

只要理解了 `ServletContainerInitializer` 这一层，`web.xml` 之所以消失就很好解释了。

因为 Servlet 3.0 之后，规范已经允许：

- 通过 `ServletContainerInitializer`
- 以及 `ServletContext#addServlet` / `addFilter`
- 在启动时编程式注册组件

也就是说，Spring Boot 并不是自己偷偷绕开了 Servlet 规范，而是：

- 充分利用了规范给嵌入式和编程式装配预留的官方入口

所以这里真正发生的不是“没有 web.xml 了”，而是：

- **静态 XML 描述被编程式注册模型取代。**

这也说明嵌入式模型和传统 WAR 部署并不是两套完全无关的世界，而是在同一规范下采用了不同的注册入口。

## 六、为什么这篇必须放在 Servlet 规范边界之后，而不是直接并进 `DispatcherServlet` 主干篇

看到这里，最值得回收的一个问题就是：

- 为什么 `DispatcherServlet` 接入 Tomcat 不能直接并进 `DispatcherServlet.doDispatch` 或 Servlet 规范篇里讲完？

因为这篇解决的不是：

- 请求进来后怎么调度

而是：

- **这个调度器本身是怎么被放进嵌入式容器里的。**

也就是说，它站在：

- Servlet 规范边界之后
- Spring MVC 主干之前
- Spring Boot Web 容器装配链之内

如果把它并进 DispatcherServlet 主干，就会看不清：

- 调度器逻辑
- 和调度器注册逻辑

是两件完全不同的事。

而如果不先讲 Servlet 规范边界，又看不清：

- `ServletContextInitializer`
- `ServletContainerInitializer`

这两层桥为什么会成立。

## 七、几个最容易错的判断

### 1. `DispatcherServlet` Bean 创建出来，就已经进 Tomcat 了

不成立。

Bean 世界和 Servlet 容器注册世界是两层不同语义，中间还隔着注册意图建模和容器回调。

### 2. `TomcatStarter` 只是个普通工具类

不成立。

它是 `ServletContainerInitializer`，承担的是规范层回调与 Spring 注册模型之间的适配工作。

### 3. Spring Boot 不用 `web.xml`，说明它绕开了 Servlet 规范

不成立。

它恰恰是通过 Servlet 3.0 之后的编程式注册通道来完成嵌入式装配。

### 4. `DispatcherServletRegistrationBean` 只是把 Servlet 包装一下

不完整。

它真正承载的是一整套注册意图：名字、映射、loadOnStartup、asyncSupported 等。

## 收网：Spring Boot 真正统一的不是“怎么把一个 Servlet 丢进 Tomcat”，而是“Bean 世界里的注册意图如何被桥接成 Servlet 容器启动回调”

现在可以回到开头那个问题：为什么明明没有 `web.xml`，`DispatcherServlet` 却还是能进 Tomcat？

因为 Spring Boot 并不是直接在某个 Bean 创建时对 Tomcat 编程，而是建立了一条完整的集成桥：

```text
Spring Bean 世界
   -> ServletContextInitializerBeans 收集注册意图
   -> DispatcherServletRegistrationBean 描述注册项
   -> ServletWebServerApplicationContext 在 refresh 子类钩子中创建 WebServer
   -> TomcatStarter.onStartup(ServletContext)
   -> 真正把 Servlet / Filter / Listener 注册进容器
```

因此，这篇真正该带走的结论不是“Spring Boot 自动帮你注册了 DispatcherServlet”，而是：

**Spring Boot 把嵌入式 Servlet 注册问题从“少写一个 web.xml”提升成了“Bean 世界的注册意图如何通过 `ServletContextInitializer` / `ServletContainerInitializer` 双桥接，进入 Tomcat 启动时回调”的集成层协议。**

这也留下了下一篇最自然的问题：既然 `DispatcherServlet` 已经能被桥进嵌入式容器，那 Spring Boot 再往前那一层——`SpringApplication.run()`、`@SpringBootApplication`、`AutoConfigurationImportSelector`——又是怎样把整套 Spring Framework 主干、Web 容器与自动装配一起接成一个应用启动总入口的？

下一篇进入 Spring Boot 装配 Spring Framework 的集成总主线。