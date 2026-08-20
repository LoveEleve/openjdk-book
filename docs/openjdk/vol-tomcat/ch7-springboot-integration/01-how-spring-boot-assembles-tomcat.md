# Spring Boot 到底是怎么把嵌入式 Tomcat 装起来的

> 本文基于 Spring Boot 3.5.16 与 Tomcat 10.1.34 当前源码。本文只讲“上层装配桥”：在真实 Spring Boot 项目里，我们几乎不会手写 `new Tomcat()`、`addContext()`、`addServlet()`，但嵌入式 Tomcat 仍然会被准确地创建、装配、注册和启动。本文关注的正是这条桥：`ServletWebServerApplicationContext -> TomcatServletWebServerFactory -> TomcatStarter -> TomcatWebServer`。

## 为什么 Tomcat 本体已经讲清楚了，但读者还是会觉得“离真实项目差一口气”

前面 Tomcat 主干卷已经把容器本体的几条核心链路立住了：

- 它怎么从配置对象变成运行时容器
- 请求怎么从 Socket 进入 Catalina
- Catalina 里怎么从 Mapper 走到 Servlet
- async / timeout / error 为什么会把请求重新接住
- Session 和 Mapper 这些专题在系统里各自扮演什么角色

如果只看这些内容，Tomcat 这一卷在“本体机制”意义上其实已经很完整了。

但很多读者读到这里，仍然会有一种非常具体的不满足感：

**这些都对，可我在真实 Spring Boot 项目里从来没手写过这些代码。那我的项目到底是怎么把 Tomcat 装起来的？**

这类困惑不是读者想太多，而是之前几篇天然留下的一个断层。

因为前面几篇讲的是：

- Tomcat 本体一旦被建立起来，会如何运行

但真实项目里，开发者真正面对的通常不是“裸 Tomcat”，而是：

- `@SpringBootApplication`
- `SpringApplication.run()`
- `application.yml`
- 几个 `Customizer`
- 然后端口就起来了，应用也能收请求了

也就是说，在工程实践里，Tomcat 不是“自己站起来”的，而是**被 Spring Boot 装起来并接入 Spring 生命周期**的。

如果这一层不讲清楚，读者会出现一种典型断裂：

- 知道 Tomcat 本体怎么工作
- 但不知道 Spring Boot 项目里的 Tomcat 是怎么被真正落地的

这也是为什么完整卷不能只停在 Tomcat 主干闭环，还必须补上“集成层”。

所以，本文真正要回答的问题不是“Spring Boot 里有几个和 Tomcat 相关的类”，而是：

**为什么在真实 Spring Boot 项目里，我们几乎不手写 `new Tomcat()`，但嵌入式 Tomcat 仍然会被完整、准确地装起来？**

## 先看失败方案：为什么不能把 Boot 集成理解成“帮你少写几行初始化”

### 失败方案一：Spring Boot 不过是替你 `new Tomcat()`

这是最常见的直觉，因为表面上看，嵌入式 Tomcat 的确像是被框架“代劳”了：

- 你没自己 new
- 你没自己 addContext
- 你没自己 addServlet
- 但最终 Tomcat 还是起来了

于是很容易得出一句很顺手的话：

- Spring Boot 不过是替你把 Tomcat 初始化代码封装掉了

这个说法的问题在于，它把“装配桥”误写成了“语法糖”。

因为 Spring Boot 额外承担的远不止少写几行代码，而至少包括三类结构性工作：

- **把外部配置映射成 Tomcat 内部对象结构**
- **把 Spring 应用里的 Servlet / Filter / Listener 组件注册回 Tomcat 容器**
- **把 Tomcat 的启动与关闭纳入 Spring 自己的生命周期**

也就是说，如果只是“帮你 new 一下”，那它解释不了：

- 为什么 `ServletWebServerApplicationContext` 要专门存在
- 为什么 `TomcatServletWebServerFactory` 不是普通工厂类
- 为什么 `TomcatStarter` 要专门负责应用注册
- 为什么 `TomcatWebServer` 不是个简单包装器

所以 Boot 集成不是语法糖，而是一整条装配桥。

### 失败方案二：`TomcatServletWebServerFactory` 只是一个普通工厂类

当读者意识到“不是简单代劳”以后，第二个误区就来了：

- 好，Spring Boot 确实做了不少事
- 但无非就是一个 Factory，把 Tomcat 造出来而已

这个理解也不够。

因为如果 `TomcatServletWebServerFactory` 只是一个普通工厂，它顶多回答：

- 创建哪个 Tomcat 对象
- 组一下 Context / Connector
- 返回给调用方

但真实问题远比“造对象”更复杂。对嵌入式容器来说，上层装配桥至少还要回答：

- 配置怎么一层层映射进 Connector/Context/ProtocolHandler
- 应用组件什么时候被注册进容器
- Tomcat 启动时机是谁驱动的
- 为什么不是在 ApplicationContext 一创建完就立刻 bind 端口

所以 Factory 在这里不是“普通构造器模式”，而是整条集成桥的上半段。

### 失败方案三：Tomcat 生命周期和 Spring 刷新流程互不相干

如果只分别阅读 Tomcat 与 Spring 的源码，很容易形成第三种误解：

- Tomcat 有自己的启动逻辑
- Spring 有自己的 refresh 流程
- 两边大概只是某处碰巧接上了

问题在于，真实嵌入式模式下，Tomcat 并不是“旁边独立跑起来的一台服务器”，而是被编排进了 Spring 的应用启动节奏里。

换句话说，真实应用里的问题不是：

- Tomcat 会不会启动

而是：

- **Tomcat 在 Spring 的哪一步被创建？**
- **Tomcat 在 Spring 的哪一步开始真正变成可接请求的 WebServer？**
- **Spring 应用自己的 Servlet/Filter/Listener 又是在什么时候挂进去的？**

如果这一层不讲清楚，读者会知道两套系统各自怎么跑，却不知道它们在真实工程里是怎么接成一条链的。

## Spring Boot 装配嵌入式 Tomcat 的最小总图

如果把这条集成桥先压缩成最小模型，它可以写成下面这样：

```text
SpringApplication.run()
   -> ServletWebServerApplicationContext
   -> TomcatServletWebServerFactory.getWebServer()
   -> TomcatStarter
   -> TomcatWebServer
   -> Embedded Tomcat becomes available
```

如果再换一种更便于理解的拆法，这条链可以分成四段职责：

```text
[Spring 触发者]
ServletWebServerApplicationContext

   ->

[Tomcat 组装者]
TomcatServletWebServerFactory

   ->

[应用注册桥]
TomcatStarter

   ->

[生命周期托管者]
TomcatWebServer
```

这张图最重要的价值，不是让读者背类名，而是先把四种问题分开：

### 一、Spring 触发者
回答：是谁在 Spring Boot 启动过程中决定“现在该创建 Web 容器了”？

这一层主要由：
- `ServletWebServerApplicationContext`

承担。

它在当前实现里最关键的两个动作是：
- `onRefresh()` 中调用 `createWebServer()`
- `createWebServer()` 再去找 `ServletWebServerFactory`，并执行 `factory.getWebServer(getSelfInitializer())`

证据：`org/springframework/boot/web/servlet/context/ServletWebServerApplicationContext.java:164`
证据：`org/springframework/boot/web/servlet/context/ServletWebServerApplicationContext.java:186`
证据：`org/springframework/boot/web/servlet/context/ServletWebServerApplicationContext.java:193`

### 二、Tomcat 组装者
回答：是谁把 Tomcat、Connector、Context 这些结构真正组装出来？

这一层主要由：
- `TomcatServletWebServerFactory`

承担。

### 三、应用注册桥
回答：Spring 管理的 Servlet / Filter / Listener 体系，怎么被挂回 Tomcat 容器里？

这一层主要由：
- `TomcatStarter`

承担。

### 四、生命周期托管者
回答：Tomcat 不是裸跑，而是怎样被纳入 Spring 应用启动与关闭节奏的？

这一层主要由：
- `TomcatWebServer`

承担。

只要先把这四段职责分开，后面 Factory / Starter / WebServer 之间为什么不能互相替代，就会清楚很多。

## 一、`ServletWebServerApplicationContext`：为什么是它来触发嵌入式容器创建

从 Spring Boot 视角看，嵌入式容器并不是随便在哪个地方被 new 出来的。它必须被纳入 Spring 应用上下文刷新流程里。

所以第一件必须立住的事是：**谁在 Spring 这边按下了“现在该创建 Web 容器”的按钮？**

这层角色，典型就是：

- `ServletWebServerApplicationContext`

它的关键意义不在于“它是个 ApplicationContext 子类”，而在于：它把“普通 Spring 容器刷新”推进成了“带 Servlet 容器的 Spring 容器刷新”。

换句话说，没有它，后面的 TomcatFactory 再会造，也没有明确时机进入 Spring 主线。

所以在这条集成桥里，`ServletWebServerApplicationContext` 扮演的不是“某个配置载体”，而是**装配动作的 Spring 侧触发者**。

而且它做的还不只是“触发创建”。在 `selfInitialize(ServletContext)` 里，它会遍历 `getServletContextInitializerBeans()` 返回的初始化器集合，并逐个执行 `initializerBean.onStartup(servletContext)`；而这个集合本身又来自 `new ServletContextInitializerBeans(getBeanFactory())`。

证据：`org/springframework/boot/web/servlet/context/ServletWebServerApplicationContext.java:241`
证据：`org/springframework/boot/web/servlet/context/ServletWebServerApplicationContext.java:245`
证据：`org/springframework/boot/web/servlet/context/ServletWebServerApplicationContext.java:270`

## 二、`TomcatServletWebServerFactory`：为什么它不是普通工厂类

一旦 Spring 这边决定要创建嵌入式 Web 容器，接下来最关键的角色就是：

- `TomcatServletWebServerFactory`

它为什么重要？因为它不是单纯“new 一个 Tomcat”而已。

更准确地说，它承担的是集成桥的上半段：

- 决定用 Tomcat 作为嵌入式容器实现
- 创建 Tomcat、Connector、Context 等核心对象
- 接住 Spring Boot 的外部配置和 customizer
- 把这些配置继续压到 Tomcat 的内部结构上

在当前实现里，这条链不是抽象说法，而是非常具体的方法序列：
- `getWebServer(...)` 里 `new Tomcat()`
- 创建 `Connector` 并挂到 `Service`
- `customizeConnector(connector)`
- `prepareContext(...)`
- `mergeInitializers(initializers)`
- `configureContext(...)`
- 最后返回 `getTomcatWebServer(tomcat)`

证据：`org/springframework/boot/web/embedded/tomcat/TomcatServletWebServerFactory.java:196`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatServletWebServerFactory.java:200`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatServletWebServerFactory.java:206`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatServletWebServerFactory.java:209`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatServletWebServerFactory.java:218`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatServletWebServerFactory.java:235`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatServletWebServerFactory.java:269`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatServletWebServerFactory.java:403`

也就是说，它不是普通工厂，而是：

**Spring Boot 配置与 Tomcat 内部对象结构之间的总装配车间。**

如果没有这一层，Tomcat 本体源码再清楚，也很难解释真实项目里那些：

- `server.port`
- `server.tomcat.*`
- connector / protocol / context 定制

到底是怎么进入容器内部结构的。

所以，这一层讲的不是“Factory 能造对象”，而是“Factory 为什么是集成桥的上半段”。

## 三、`TomcatStarter`：Spring 应用对象怎么挂回 Tomcat 容器

就算 `TomcatServletWebServerFactory` 已经把容器骨架组出来了，还有一个更关键的问题没解决：

**Spring 容器里的 Servlet、Filter、Listener 等应用对象，是怎么真正注册进 Tomcat 的？**

这就是 `TomcatStarter` 这种角色存在的意义。

它的重要性在于：它不是普通帮助类，而是把 Spring 世界里的 Web 组件，重新接到 Tomcat 容器世界里的桥。

这一点在源码里体现得非常直接：`TomcatStarter` 自己实现了 `ServletContainerInitializer`，而在 `onStartup(...)` 中，会遍历并调用所有 `ServletContextInitializer` 的 `onStartup(servletContext)`。

证据：`org/springframework/boot/web/embedded/tomcat/TomcatStarter.java:36`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatStarter.java:49`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatStarter.java:51`

换句话说：

- Tomcat 本体负责提供容器能力
- Spring 负责管理应用对象
- `TomcatStarter` 负责把两边真正接起来

如果没有这层桥，Factory 就算把空容器搭好了，应用仍然不会真正出现在容器执行链里。

所以，`TomcatStarter` 的存在说明一件很重要的事：

**嵌入式 Tomcat 的“应用注册”不是容器自己顺带完成的，而是由 Boot 集成桥专门补上的。**

这也是为什么不应该把它写成“小工具类”就带过去。

## 四、`TomcatWebServer`：为什么它不只是个包装器

当 Tomcat 已经被组好、应用也已经挂进去后，最后还剩一个更上层的问题：

- 这台嵌入式容器，是怎么和 Spring 整个应用生命周期一起启动、一起关闭、一起可用的？

这一步就轮到：

- `TomcatWebServer`

如果只从名字看，它很容易被理解成一个薄包装：

- 里面包了一个 Tomcat
- 暴露几个 start/stop 方法
- 这样就完了

但在集成层里，它的真正地位比这重得多。

因为它承担的不是“再包一下 API”，而是：

**把 Tomcat 这台容器纳入 Spring Boot 应用自己的生命周期节奏。**

这一点在 `TomcatWebServer` 里也有很硬的实现证据：
- 构造阶段直接调用 `initialize()`
- `initialize()` 里会 `removeServiceConnectors()`、`disableBindOnInit()`，然后先 `this.tomcat.start()` 触发初始化
- 真正对外 `start()` 时，再 `addPreviouslyRemovedConnectors()`，并检查连接器是否已经启动

证据：`org/springframework/boot/web/embedded/tomcat/TomcatWebServer.java:107`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatWebServer.java:110`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatWebServer.java:121`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatWebServer.java:125`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatWebServer.java:128`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatWebServer.java:169`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatWebServer.java:229`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatWebServer.java:236`

也就是说，Tomcat 本体虽然有自己的启动逻辑，但在嵌入式模式下，真正决定它什么时候开始可用、什么时候对外暴露服务、什么时候跟随应用关闭的，是上层 `WebServer` 这类托管角色。

所以 `TomcatWebServer` 的意义，不在于“它包装了 Tomcat”，而在于：

- 它把 Tomcat 的生命周期接进了 Spring 的生命周期
- 它让嵌入式容器不再是旁边独立跑的一台服务器，而是应用本体的一部分

## 到了这里，Tomcat 本体主干和 Spring Boot 集成桥终于接上了

看到这里，可以把前面几篇和本篇真正拼起来了。

前面几篇讲的是：

- Tomcat 本体一旦被建立起来，会如何启动、接请求、执行、处理异常、管理状态

而本篇讲的是：

- 真实 Spring Boot 项目里，这台 Tomcat 本体到底是谁创建的
- 谁把应用对象注册进去
- 谁把它纳入应用生命周期

也就是说，到这里为止，Tomcat 这一卷终于补上了前面一直缺的那一口气：

**Tomcat 不只是“自己会跑”，而是被 Spring Boot 这条上层装配桥，准确地装成了现实项目里的嵌入式容器。**

## 这篇真正立住的，不是几个类名，而是“上层装配桥”这个概念

如果只从表面看，Spring Boot 集成很容易被讲成：

- 有个 Factory
- 有个 Starter
- 有个 WebServer 包装器
- 然后 Tomcat 就起来了

这种说法当然不算错，但还是太平。

从当前源码归纳出来，更稳妥的理解方式应该是：

1. `ServletWebServerApplicationContext` 负责在 Spring 启动流程里触发 Web 容器创建
2. `TomcatServletWebServerFactory` 负责把配置映射成 Tomcat 内部结构
3. `TomcatStarter` 负责把 Spring 管理的 Web 组件挂进 Tomcat
4. `TomcatWebServer` 负责把这台容器纳入 Spring 生命周期

只有把这四层角色分开，读者才会真正理解：

- 为什么真实项目里不需要手写 `new Tomcat()`
- 为什么 Tomcat 本体源码和 Spring Boot 集成源码必须一起看
- 为什么“嵌入式容器”不是一个类，而是一条完整的装配桥

## 这篇之后，Tomcat 完整卷最自然的继续方向是什么

到这里为止，Tomcat 这一卷已经不只停留在主干机制层，而开始把“集成层”补进来了。

这篇真正补上的，不是新的 Tomcat 本体机制，而是一座上层装配桥：

- Spring 在哪里触发嵌入式容器创建
- 谁来把 Tomcat 组装出来
- 谁把应用组件注册进容器
- 谁把容器纳入 Spring 生命周期

所以如果继续往下写，最自然的方向不再是回头重讲主干，而是继续补完整卷里还缺的层次，尤其是：

- **Servlet 规范与 Tomcat 实现边界**

因为到这里，读者已经知道 Tomcat 怎么装起来、怎么运行、怎么接请求、怎么处理偏离路径、怎么管 Session、怎么做路由；这时候再回头补“哪些行为是 Servlet 规范要求，哪些是 Tomcat 的实现取舍”，理解会更稳。