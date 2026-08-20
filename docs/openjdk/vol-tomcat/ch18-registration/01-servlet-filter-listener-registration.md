# 为什么这些组件不会自己出现在容器里：Tomcat 的注册体系是怎样把应用装成运行单元的

> 本文基于 Tomcat 10.1.34 与 Spring Boot 3.5.16 当前源码。本文只讲 Servlet / Filter / Listener 的注册主线：它们在应用代码里看起来只是几个类、几个 Bean、几个注解，但在运行时里并不是“自然存在于容器中”，而是通过规范扩展点、`Context` 托管体系和 Spring Boot 的初始化回放链，被系统性挂进同一个应用运行单元里。

## 为什么应用代码里写出来的组件，不会自动出现在容器里

业务开发者看一个 Web 应用，最直观的东西往往就是这些：

- 写一个 Servlet
- 写几个 Filter
- 配几个 Listener
- 再加一点 Spring Boot 配置

只要应用跑起来，这些组件看起来就像天然存在于系统里：

- Filter 会自动在请求前后执行
- Servlet 会自动接请求
- Listener 会自动感知启动、关闭或事件

这种体验太顺滑了，顺滑到人很容易忘记问一句更底层的问题：

**这些组件到底是怎么进入容器的？**

也就是说，从业务开发者视角看，它们像是“本来就在那儿”；但从源码视角看，事情远没有这么自然。容器必须明确回答：

- 它是在什么时候发现这些组件的
- 这些组件被挂到哪一层结构里
- 它们按什么顺序被注册和初始化
- Spring Boot 自己那一层对象，又是如何被回放进 Tomcat 容器的

如果这些问题不回答，前面整卷里很多东西都会突然悬空：

- `StandardContext` 为什么要那么重
- `TomcatStarter` 为什么要存在
- `ServletContextInitializerBeans` 为什么不是个小辅助工具
- 规范里的 SCI / Initializer 为什么会和嵌入式注册主线直接连在一起

所以，本文真正要回答的问题不是“Tomcat 支持注册哪些组件”，而是：

**为什么这些组件不会自己出现在容器里，而必须经过一整条注册体系，才能被系统性挂进 `Context`，最后变成真正的运行单元？**

## 先看失败方案：为什么不能把注册理解成“容器自己会发现”

### 失败方案一：组件写在应用里，Tomcat 自然就能看到

这是最自然的业务直觉。

因为在应用代码里，组件通常只是这样出现：

- 一个 Servlet 类
- 一个 Filter Bean
- 一个 Listener

应用一启动，请求就能走到它们，于是很容易形成一个隐含前提：

- 既然都能跑，那容器肯定自己会知道这些组件在哪里

这个理解的问题在于，它把“运行结果”当成了“注册过程的解释”。

可在源码视角下，“知道它们在哪里”本身就需要一条链来完成：

- 谁先给容器暴露这些组件
- 谁把它们组织成初始化器集合
- 谁在合适的时机把这些初始化器真正回放到 `ServletContext`
- `Context` 又是怎样把这些注册结果纳入自己的应用级托管体系

也就是说，组件不会自己出现，运行结果的背后一定有一条注册链。

### 失败方案二：Servlet、Filter、Listener 三套体系彼此完全独立

从 API 表面看，这种理解也很自然：

- Servlet 负责处理请求
- Filter 负责包一层执行链
- Listener 负责感知事件

它们职责不同，所以很容易继续推断：

- 它们的注册过程大概也彼此独立

但这个理解的问题在于，它只抓住了功能差异，没有抓住容器侧的统一托管需求。

从 `StandardContext` 的视角看，这三类组件虽然职责不同，但它们有一个共同点：

- 都属于同一个 Web 应用
- 都必须一起进入应用运行单元
- 都必须在合适的生命周期阶段被纳入托管

所以它们可以在功能上不同，却不能在容器侧完全散着注册。

### 失败方案三：Spring Boot 注册只是额外封装，和容器注册主线关系不大

这也是一个特别容易低估的误解。

很多人会觉得：

- 容器自己的注册链是一回事
- Spring Boot 无非是在外面再包一层方便用的封装

这个理解的问题在于，它会让你看不到两者之间真正的连接关系：

- 规范先提供 SCI / Initializer 这一类扩展点
- Tomcat 把这套扩展点兑现成实际容器入口
- Spring Boot 再利用这个入口，把自己容器里的 Servlet / Filter / Listener / Initializer 体系批量回放进去

也就是说，Boot 注册不是平行于容器主线的一层便利封装，而是直接踩在容器注册主线上的现实入口。

## 组件注册主线的最小总图

如果把这条注册体系先压缩成最小模型，它可以写成下面这样：

```text
Servlet spec extension points
   -> Context registration model
   -> Boot initializer collection and replay
   -> runtime component set inside the app
```

如果再换一种更容易理解的拆法，这条链可以分成三段职责：

```text
[规范扩展点]
SCI / Initializer contract

   ->

[容器托管层]
StandardContext holds and organizes app-level components

   ->

[Boot 回放链]
ServletContextInitializerBeans -> TomcatStarter -> onStartup(...)
```

这张图最重要的价值，不是让读者背一串接口和类名，而是先把三个问题分开：

### 一、规范扩展点
回答：组件凭什么有机会在容器启动期被挂进来？

### 二、容器托管层
回答：这些组件为什么最终会被统一纳入 `Context` 这一层？

### 三、Boot 回放链
回答：Spring Boot 里的对象，究竟是怎样沿着这条规范和容器链条进入 Tomcat 的？

只要把这三段职责分开，后面“组件为什么不会自己出现”就能被真正解释清楚。

## 一、规范扩展点：组件之所以能被挂进来，首先是因为契约给了入口

在容器世界里，应用组件不是天然悬浮在空中的。它们之所以有机会进入系统，是因为规范层本来就提供了扩展入口。

最典型的就是：

- `ServletContainerInitializer`
- 以及围绕它形成的 `Initializer` 扩展契约

这说明一件很重要的事：

- 组件能不能被挂进容器，不是实现层随手决定的
- 它首先是规范明确允许、甚至要求容器支持的扩展能力

也就是说，注册体系先不是 Tomcat 的发明，而是 Servlet 世界先给了这条“启动期接入容器”的契约通道。

这也是为什么在前面的规范层里，我们专门把 SCI / Initializer 拿出来讲：因为没有这层契约，后面的 Tomcat 和 Spring Boot 注册链就没有共同基础。

规范侧最硬的锚点就是：`ServletContainerInitializer` 明确要求容器在应用启动期回调 `onStartup(Set<Class<?>>, ServletContext)`。

证据：`jakarta/servlet/ServletContainerInitializer.java:22`
证据：`jakarta/servlet/ServletContainerInitializer.java:38`

## 二、`StandardContext`：组件最终为什么都要汇合到应用运行单元里

规范给了扩展点之后，接下来就轮到容器回答：

- 这些组件最后应该挂到哪里
- 它们怎么和一个具体 Web 应用绑定

从前面 `StandardContext` 那篇已经知道：Tomcat 不把应用看成组件清单，而是看成一个完整运行单元。

所以到了注册体系这里，一个特别关键的结论也就自然成立了：

**Servlet、Filter、Listener 虽然功能不同，但最终都必须被统一纳入 `Context` 这一层的应用级托管体系。**

这不是抽象总结，`StandardContext` 自己就直接持有：
- `applicationEventListenersList`
- `applicationLifecycleListenersObjects`
- `initializers`

并且在启动链里会继续触发：
- `listenerStart()`
- `filterStart()`

证据：`org/apache/catalina/core/StandardContext.java:219`
证据：`org/apache/catalina/core/StandardContext.java:226`
证据：`org/apache/catalina/core/StandardContext.java:232`
证据：`org/apache/catalina/core/StandardContext.java:3919`
证据：`org/apache/catalina/core/StandardContext.java:3842`

换句话说，这些组件不是各自为政地散落进系统，而是在同一个应用边界里被组织起来的。

这也是为什么：

- 它们不是“容器顺手知道了几个类”
- 而是“被一条注册链明确地挂进了某个应用运行单元”

一旦有了这个视角，再回头看 `Context` 持有的 Listener、Filter、Wrapper、Initializer 相关结构，就不会觉得它们只是属性堆砌，而会明白：这些正是“应用单元如何成型”的组织证据。

## 三、为什么 Servlet、Filter、Listener 虽然不同，却必须一起看

只要把注册问题放回 `Context` 视角，就会看到另一个很容易被忽略的事实：

- Servlet
- Filter
- Listener

这三类组件虽然职责不同，但它们进入容器时面对的是同一个问题：

- 什么时候被发现
- 什么时候被挂进来
- 什么时候开始对当前应用生效

所以从功能上看，它们当然可以拆；但从“应用是怎么被装成一个运行单元”的角度看，它们必须先被一起看。

否则就会出现一种很典型的误解：

- Servlet 好像是主线
- Filter 是附属链
- Listener 只是旁边听一听

可在注册体系里，这三者先是同一类问题：**它们都必须被系统性纳入应用托管结构。**

也正因为如此，这篇讲的不是三种组件的内部执行细节，而是它们为什么会共同出现在同一条注册主线上。

## 四、Spring Boot：不是重新发明注册链，而是把自己的对象沿容器注册链回放进去

到了这里，最容易被误读的就是 Spring Boot 那一层。

从外面看，Boot 常常像是在做另一套自己的事：

- 扫 Bean
- 找 Filter
- 找 Servlet
- 然后 somehow 就进了容器

如果不把它放回前面那两层链条里，很容易觉得 Boot 是“额外附加的一套注册体系”。

更准确的说法应该是：

- 规范先给了扩展点
- Tomcat 提供了容器注册入口
- Spring Boot 再把自己容器里的对象，沿着这条入口回放进去

这条 Boot 回放链在源码里也有非常明确的落点：
- `ServletContextInitializerBeans` 明确“包含所有 `ServletContextInitializer` bean，并适配 `Servlet`、`Filter` 和某些 `EventListener` bean”
- `TomcatStarter.onStartup(...)` 再遍历这些 initializer，逐个回放到 `ServletContext`

证据：`org/springframework/boot/web/servlet/ServletContextInitializerBeans.java:53`
证据：`org/springframework/boot/web/servlet/ServletContextInitializerBeans.java:95`
证据：`org/springframework/boot/web/servlet/ServletContextInitializerBeans.java:160`
证据：`org/springframework/boot/web/embedded/tomcat/TomcatStarter.java:49`

也就是说，Boot 不是绕开 Tomcat，而是在借 Tomcat 已经承认的扩展主线来完成自己的应用装配。

这也是为什么前面在集成层里我们反复强调：
- `ServletContextInitializerBeans`
- `TomcatStarter`
- `onStartup(...)`

这些角色都不是“方便用的外围封装”，而是现实项目里应用组件真正进入容器的桥。

所以从这里再回头看，Spring Boot 不只是把 Tomcat 装起来，它还负责把应用组件系统性地装进已经被装好的 Tomcat。

## 五、为什么注册体系本身就是应用运行单元成型的关键一步

把规范扩展点、Context 托管层、Boot 回放链放在一起之后，就能看清注册体系最核心的价值了。

它解决的不是“组件怎么配置”这么窄的问题，而是：

**应用里的这些组件，怎样从代码/Bean/定义，真正变成一个会参与运行时主线的容器单元。**

也就是说，在注册完成之前：
- 这些东西只是定义

在注册完成之后：
- 它们才真正变成当前 Web 应用运行结构的一部分

这也解释了为什么本篇必须单独存在。因为如果不把注册体系抽出来讲，读者虽然能在主干篇里看到 Filter/Servlet/Listener 的执行效果，却不知道这些东西当初是怎么被系统性放进容器的。

## 到了这里，“组件列表”就真正变成了“运行单元的一部分”

现在再回头看最开始那个直觉：

- 我写了几个 Servlet、Filter、Listener
- 容器自然就知道它们了

看到这里，这种理解已经不够用了。

更准确的说法应该是：

- 这些组件之所以能生效，不是因为“容器自己会发现”
- 而是因为它们沿着规范扩展点、容器托管结构和 Boot 回放链，被系统性地挂进了 `Context`
- 从那一刻开始，它们才真正成为当前 Web 应用运行单元的一部分

也就是说，注册体系不是附属细节，而是“应用如何成型”的关键一环。

## 这篇真正立住的，不是几类组件，而是“应用是被装进去的”这个概念

如果只从表面看，这篇很容易被讲成：

- Servlet 怎么注册
- Filter 怎么注册
- Listener 怎么注册

这种讲法当然有用，但还是太散。

从前面整卷主线归纳回来，更稳妥的理解方式应该是：

1. 规范先提供扩展入口
2. Tomcat 让这些入口落到 `Context` 的应用级托管结构里
3. Spring Boot 再把自己的组件体系沿这条链回放进去
4. 所以应用不是“组件清单”，而是“被系统性装进容器的运行单元”

这篇真正补上的，也就不是注册技巧，而是一种卷级视角：

**应用组件不是天然存在于容器里，而是被一条明确注册主线装进去的。**

## 这篇之后，Tomcat 还剩下哪些值得继续补的线

到这里，Tomcat 完整卷的机制补深层又补上了一条很关键的线：

- 应用运行单元如何被托管
- 组件又是如何被系统性挂进这个运行单元

如果继续往下补，最自然的方向还有两类：

1. 继续补机制补深层：
   - 线程池 / Executor 专题
   - `Mapper` 四级匹配进一步细化

2. 或者开始回头做卷级整理：
   - 卷前导读
   - 总图 / 总索引
   - 章节间导航和收束增强

如果按当前嵌入式主线继续推进，更自然的下一步是：

- **线程池 / Executor 专题**

因为到这里，应用是怎么装起来、怎么跑、怎么退、怎么被持续托管，都已经立住了；再往下最值得补的，就是这些运行单元在并发与执行资源层面到底如何被调度和承压。