# 哪些是 Servlet 规范要求，哪些是 Tomcat 自己的实现取舍

> 本文基于 Tomcat 10.1.34 当前源码与同仓内 `jakarta.servlet` 接口定义。本文不再重讲 Tomcat 主干链路，而是专门做一件事：把前面几篇里已经出现过的生命周期、Filter、DispatcherType、Session、async、Initializer 等行为，重新放回“规范要求 vs Tomcat 实现”这条视角里校准一遍。

## 为什么读完 Tomcat 主干之后，反而更需要回头补一篇“规范层”

Tomcat 主干卷讲到这里，读者对系统运行方式通常已经有了相当具体的印象：

- 容器树怎么启动
- 请求怎么进入
- Catalina 内部怎么从 Mapper 走到 Servlet
- async / timeout / error 怎么重新接住偏离路径
- Session 为什么不是一个普通对象
- Spring Boot 又是怎么把嵌入式 Tomcat 装起来的

这时候最容易发生的一种认知错觉，恰恰不是“还没看懂”，而是 **“已经看懂了，所以它本来就应该这样”**。

也就是说，读者会不自觉地把前面几篇里看到的 Tomcat 当前实现，直接误当成 Servlet 容器的天然定义：

- Filter 之所以这样执行，是因为 Servlet 容器本来就必须这样写
- Session 之所以会有这套生命史，是因为规范大概就是这么规定的
- async 为什么会牵涉这些状态机和错误出口，好像也是 Servlet API 自己天然长成这样

问题在于，这种理解会把两件本该分开的事混在一起：

- **规范在要求什么**
- **Tomcat 选择怎么实现这个要求**

前者是契约，后者是实现。

如果不把这层分开，前面几篇主干文章虽然能让人理解 Tomcat 当前是怎么跑的，却很难让人建立一个更稳的判断力：

- 哪些行为其实是任何 Servlet 容器都应该兑现的
- 哪些细节只是 Tomcat 在当前版本下的具体实现方式
- 哪些地方如果换个容器或换个版本，实现完全可以不同

所以，这篇的价值不在于再讲一遍 Servlet 是什么，而在于帮整卷书补上一层非常关键的视角：

**Tomcat 不是规范本身，而是规范的一个实现。**

也正因为如此，本文真正要回答的问题不是“Servlet 规范有哪些条款”，而是：

**前面几篇里那些看起来已经很自然的行为，到底哪些是规范硬要求，哪些又是 Tomcat 为了兑现这些要求而做出的实现取舍？**

## 先看失败方案：为什么不能把 Tomcat 当前实现直接当成规范本身

### 失败方案一：Tomcat 现在这样实现，说明 Servlet 规范就是这么规定的

这是读源码最容易发生的错觉。

因为前面几篇我们一直在看 Tomcat：

- `StandardWrapper` 怎么管生命周期
- `ApplicationFilterChain` 怎么推进 Filter
- `AsyncContextImpl` 怎么处理 async
- `StandardSession` / `Manager` 怎么管 Session

看久了之后，很容易在脑子里形成一种默认前提：既然容器是这么实现的，那规范大概也就是这么要求的。

这个前提的问题在于，它把“兑现契约的具体路径”误当成了“契约本身”。

更直白一点说：

- 规范可以要求 Servlet 要有生命周期
- 但它不会要求必须用 Tomcat 现在这套 `StandardWrapper + allocate/load/init/unload` 的路径去兑现

- 规范可以要求 Filter 形成链式调用
- 但它不会要求必须用 Tomcat 当前 `ApplicationFilterFactory + ApplicationFilterChain` 这套结构去组织

- 规范可以要求 Session 要跨请求保留状态
- 但它不会要求必须长成 Tomcat 当前这套 `Manager + expire + persist + replicate` 的生命史组织方式

所以，只要把 Tomcat 当前实现直接等同于规范，后面就会失去一个非常重要的判断能力：

**看到某个实现细节时，不知道它到底是契约硬要求，还是当前实现选择。**

### 失败方案二：那就只讲规范，不回头看实现

意识到“实现不等于规范”之后，另一个极端就来了：

- 好，那我干脆只看 Servlet 规范
- 规范怎么写，就怎么理解
- Tomcat 的细节不重要

这个方向同样不对。

因为对于读源码的人来说，真正有价值的问题不是：

- 规范文档里写了什么抽象要求

而是：

- 这些抽象要求，Tomcat 是怎么把它们压成可运行代码的？

也就是说，规范如果不回到实现，就只剩定义；实现如果不回到规范，就只剩局部事实。两边必须对照着看，才会形成真正稳固的理解。

### 失败方案三：规范层只是附录，放在卷末补一下就行

很多人做源码分析时，会把规范层当成“读完实现以后顺便回顾一下”的附录。

这个安排的问题在于，它会让读者在读主干篇时不断把实现误当契约。

等到最后再回头补规范层，很多印象已经定型：

- Filter 链就应该这样组织
- Session 就应该这样管理
- async 就应该这样转回来

而规范层真正该起的作用，其实不是卷末补知识点，而是**反向校准前面整个主干卷的理解边界**。

所以它不是附录，而是完整卷中非常关键的一层：

- 它不取代主干篇
- 但它会重新解释主干篇里哪些东西该被看成契约，哪些只该被看成 Tomcat 当前实现

## 规范层的最小总图：先把“契约”和“实现”拆开

如果把这一篇要做的事先压缩成最小模型，它可以写成下面这样：

```text
Servlet Spec contract
   -> Tomcat current implementation
   -> Embedded Spring Boot usage
```

如果再换一种更容易理解的拆法，这条线可以分成三层：

```text
[规范层]
Servlet / Filter / Async / Session / SCI 契约

   ->

[实现层]
Tomcat 当前版本的生命周期、执行链、Session、错误处理等实现路径

   ->

[使用层]
Spring Boot 嵌入式模式如何依赖这些契约与实现
```

这张图最重要的价值，不是让读者去背接口名，而是先把三个问题分开：

### 一、规范层
回答：外部契约到底要求了什么行为？

### 二、实现层
回答：Tomcat 当前是怎么兑现这些行为的？

### 三、使用层
回答：上层框架在嵌入式模式里，究竟依赖的是规范、实现，还是两者共同作用后的结果？

只有把这三层分开，读者才不会把 Tomcat 当前实现误当成规范本体。

## 一、生命周期：规范规定了“要有”，Tomcat 决定了“怎么做”

前面几篇里，我们已经反复看到 `StandardWrapper`、`loadServlet()`、`initServlet()`、`unload()` 这些实现路径。它们很容易给人一种感觉：Servlet 生命周期好像天然就等于 Tomcat 这套方法链。

这里首先要拆开的，就是这个误解。

从 Servlet 规范视角看，生命周期最重要的要求不是“内部类该怎么组织”，而是：

- 容器必须负责 Servlet 的初始化
- 请求到来时要调用 `service()`
- 容器在合适时机要触发销毁

这些要求在接口注释里其实已经写得很直白：
- `Servlet.service(...)` 是容器调用的请求处理入口
- `destroy()` 只会在容器确认 `service` 线程都退出、或等待超时后调用，且之后不应再调用 `service()`

证据：`jakarta/servlet/Servlet.java:102`
证据：`jakarta/servlet/Servlet.java:114`

也就是说，规范在这里规定的是：

**生命周期语义必须成立。**

而 Tomcat 做的，是把这个语义压成一条自己当前版本的实现路径：

- 用 `StandardWrapper` 作为 Servlet 生命周期的承载者
- 用 `allocate()` / `loadServlet()` / `initServlet()` 组织实例创建与初始化
- 用 `unload()` / unavailable 等机制处理生命周期收尾与故障状态

这说明一个很重要的边界：

- Servlet 生命周期是规范要求
- `StandardWrapper` 这一整套落地方式，是 Tomcat 当前实现选择

如果把这两层混在一起，读者会误以为“只有这样实现才是 Servlet 生命周期”。而更准确的说法应该是：Tomcat 当前是这样兑现 Servlet 生命周期契约的。

## 二、Filter 与 DispatcherType：规范给了调用契约，Tomcat 给了执行组织方式

Filter 链也是最容易被实现细节带跑偏的地方。

读前面 Tomcat 主干时，大家看到的是：

- `ApplicationFilterFactory.createFilterChain(...)`
- `ApplicationFilterChain.doFilter(...)`
- `StandardWrapperValve` 在合适时机把请求推进到 FilterChain

如果只盯着这些代码，很容易形成一个印象：

- Filter 就是这样被组织起来的
- DispatcherType 也自然就在这套链里流动

但从规范视角看，更该先抓住的是另一层问题：

- Filter 必须能先于目标 Servlet 执行
- 同一请求在不同 DispatcherType 下，应当有不同的过滤器适用边界
- 转发、包含、异步再分派这些动作，对 Filter 可见性是有契约约束的

这说明规范给的是“调用与可见性契约”，而 Tomcat 回答的是“我怎么把这套契约压成一条真实可跑的链”。

至少从接口定义就能先立住一个硬约束：`FilterChain.doFilter(...)` 的语义不是“容器可选地继续往下调”，而是**调用下一个过滤器，或者在链尾调用最终资源**。

证据：`jakarta/servlet/FilterChain.java:22`
证据：`jakarta/servlet/FilterChain.java:33`

所以：

- Filter 链必须存在，是规范层问题
- `ApplicationFilterFactory + ApplicationFilterChain` 这样组织，是 Tomcat 的实现层问题

也正因为如此，我们在看 `ApplicationFilterChain` 时，既不能把它降成“小工具类”，也不能把它误当成规范本体。它只是 Tomcat 当前版本兑现 Filter 契约的方式。

## 三、async：规范给了可偏离同步主线的能力，Tomcat 给了状态机和回流路径

async 是另一个特别容易把契约和实现混成一团的地方。

规范层真正要求的核心，是：

- 请求处理可以不在当前同步调用链里立刻完成
- 容器要支持后续重新 dispatch、complete、error 等行为
- async 请求在后续阶段仍然要遵守容器和过滤链契约

也就是说，规范给的是：

**允许请求偏离传统同步主线，并要求容器继续正确托管这条偏离路径。**

这一点在 `AsyncContext` 接口里能直接看到：
- `dispatch()` 只能在请求处于异步模式时调用
- `complete()` 负责完成异步请求处理
- `start(Runnable)` 允许异步处理在线程中继续推进

证据：`jakarta/servlet/AsyncContext.java:72`
证据：`jakarta/servlet/AsyncContext.java:109`
证据：`jakarta/servlet/AsyncContext.java:114`

Tomcat 当前实现做的，则是另一层事：

- 用 `AsyncStateMachine` 看住状态迁移
- 用 `AsyncContextImpl` 做容器侧协调
- 用 `StandardWrapperValve` / `StandardHostValve` / `ErrorReportValve` 把偏离路径重新收束回容器控制流里

这说明：

- async 能不能偏离同步主线，是规范问题
- 偏离后为什么会出现这些具体状态机、错误出口、回流路径，是 Tomcat 当前实现问题

如果把这两层不分开，读者很容易在前面几篇主干里产生一种误觉：async 好像天生就等于 Tomcat 现在这套状态机组织方式。更准确的说法应该是：Tomcat 用这套状态机去兑现 async 契约。

## 四、Session：规范规定跨请求状态语义，Tomcat 再把它扩成生命史

Session 也是一个特别典型的例子。

从规范层看，它首先解决的是：

- 容器要允许跨请求保存与访问会话状态
- Session 要有基本的创建、访问、失效语义

这些要求在 `HttpSession` 接口注释里也能直接看到：
- Session 用来在多个请求之间识别用户并保存信息
- `lastAccessedTime` 取的是容器收到请求的时间，而不是业务代码读写属性的时间
- `setMaxInactiveInterval/getMaxInactiveInterval` 规定了超时失效边界

证据：`jakarta/servlet/http/HttpSession.java:24`
证据：`jakarta/servlet/http/HttpSession.java:80`
证据：`jakarta/servlet/http/HttpSession.java:103`

这其实是在定义“跨请求状态对象”应该具备什么行为边界。

而 Tomcat 当前实现则把这个契约继续扩展成了一条完整生命史：

- `StandardSession` 作为状态实体
- `Manager` 作为生命周期控制者
- 过期扫描、回收、持久化、复制作为请求之外的延伸管理

所以：

- Session 要跨请求保存状态，是规范层问题
- Session 为什么在 Tomcat 里会被组织成 `Manager + expire + persist + replicate` 这条生命史，是实现层问题

这也解释了为什么前面那篇 Session 主线不能只停留在 API，而这一篇又必须回来做一次契约校准。

## 五、SCI / Initializer：规范给了扩展点，Tomcat 与 Spring Boot 各自把桥接补齐

到了集成层，这种“契约 vs 实现”的区别会更明显。

比如前面在 Spring Boot 集成篇里，我们已经看到：

- `TomcatStarter` 实现了 `ServletContainerInitializer`
- 它会在 `onStartup(...)` 里遍历 `ServletContextInitializer`

如果只看实现，很容易把这理解成 Spring Boot 独有的注册技巧。

但从规范视角看，这里先存在的是一个更上层的事实：

- 容器要为应用和框架提供启动期扩展点
- 这些扩展点允许组件在容器初始化阶段把自己接进来

也就是说：

- SCI / Initializer 这一类扩展能力，本身先是契约层问题
- Tomcat 去兑现 SCI
- Spring Boot 再借这个桥把自己的 `ServletContextInitializer` 系统接进去

规范侧的硬证据也很明确：`ServletContainerInitializer` 本身就规定了容器在应用启动期回调 `onStartup(Set<Class<?>>, ServletContext)`。

证据：`jakarta/servlet/ServletContainerInitializer.java:22`
证据：`jakarta/servlet/ServletContainerInitializer.java:38`

因此，这里就不只是“Tomcat 怎么实现”，而是一个三层关系：

- 规范定义扩展点
- Tomcat 提供实现入口
- Spring Boot 借入口完成嵌入式集成

这也是为什么规范层和集成层不能完全割裂开看。集成桥之所以成立，本来就建立在规范给出的扩展契约之上。

## 到了这里，前面整卷主干的很多“理所当然”都该重新校准一遍了

看到这里，这篇真正的价值已经显出来了。

它不是在增加一条新的运行时主线，而是在反过来校准前面整个 Tomcat 卷的理解边界。

也就是说，前面我们看到的那些“很自然”的行为，现在都应该重新拆成两层看：

- 这是规范要求必须存在的行为
- 这是 Tomcat 当前版本为了兑现这种行为而做出的实现方式

这样一来，读者就不会再轻易把：

- `StandardWrapper` 的生命周期组织方式
- `ApplicationFilterChain` 的执行组织方式
- `AsyncStateMachine` 的状态组织方式
- `Manager` 的 Session 生命史组织方式

直接误当成“Servlet 容器唯一正确写法”。

## 这篇真正立住的，不是规范条文，而是“契约视角”

如果只从表面看，这篇似乎是在做一件很平常的事：

- 对照一下规范
- 再对照一下 Tomcat 实现

但它真正补上的，其实是一种更深的阅读视角：

1. 规范负责回答“容器必须做什么”
2. Tomcat 负责回答“我现在具体怎么做”
3. Spring Boot 负责回答“我怎么把这个实现装到真实项目里”

只有把这三层都立住，读者才会真正知道：

- 哪些东西换个容器也应该成立
- 哪些东西只是 Tomcat 当前的组织方式
- 为什么同一个外部行为，规范、容器实现、上层集成会同时参与塑形

所以，这篇不是附录，而是整卷非常关键的一次“认知校准”。

## 这篇之后，Tomcat 完整卷最自然的继续方向是什么

到这里，这一卷已经补到了规范层。

如果继续往下写，最自然的方向有两个：

1. 继续补机制补深层：
   - `StandardWrapper` 生命周期深挖
   - `WebappClassLoaderBase` 与应用隔离

2. 继续补生产层：
   - 生产性能
   - 安全运维
   - 故障排查

如果按当前完整卷路线图继续推进，更自然的下一步是：

- **Servlet 生命周期（StandardWrapper 深挖）**

因为到这里，读者已经知道：
- 规范要求生命周期必须成立
- Tomcat 主干也已经讲了它的总体组织

这时候再回头深挖 `StandardWrapper`，理解会更稳，也更不容易把 Tomcat 的具体实现误当成规范本身。