# 请求进入 Catalina 之后发生了什么：从 Mapper 到 Servlet

> 本文基于 Tomcat 10.1.34 当前源码。本文只讲“请求进入 Catalina 之后，如何从路由入口一路推进到 `Servlet.service()`”。也就是说，重点是 `Mapper -> Engine/Host/Context/Wrapper Valve -> ApplicationFilterChain -> Servlet` 这一段主线。至于 async/error 如何反向切回 HostValve、Session 如何在执行主线里参与、Mapper 树如何动态更新，会在后续专题继续展开。

## 请求已经进了 Catalina，为什么还不能直接调 Servlet

在上一篇里，请求主线停在了一个非常关键的位置：

- 连接已经进入 Tomcat
- HTTP 已经被协议层接住
- 请求也已经通过 `CoyoteAdapter` 完成了从 Coyote 世界到 Catalina 世界的跨层切换

看到这里，很多人会自然地产生一个直觉：

既然请求已经进入 Catalina，那接下来不就该直接找到目标 Servlet，然后调 `service()` 了吗？

这个直觉看起来很合理，因为从结果看，Tomcat 最终确实就是把请求交给某个 Servlet 去执行。但如果真按这个理解往下写，后面会立刻解释不通一大串现实问题：

- 一个请求到底先属于哪个 `Host`？
- URI 是怎么落到具体 `Context` 和 `Wrapper` 上的？
- 为什么 `Engine / Host / Context / Wrapper` 每一层都还有自己的 `Valve`？
- 为什么到了 `StandardWrapperValve` 还没有结束，还要再进 `ApplicationFilterChain`？
- Filter 为什么能先于 Servlet 执行？
- async dispatch、异常出口、错误页为什么又会和 HostValve、WrapperValve 重新发生关系？

这些问题共同说明一件事：**进入 Catalina 并不等于“已经到达 Servlet”。**

Tomcat 在 Catalina 内部还保留了一整条非常明确的执行主线：

1. 先确定请求的目标位置
2. 再沿容器四层责任链逐层收束执行上下文
3. 最后才把 Filter 与 Servlet 串成真正的执行末端

所以，本文真正要回答的问题不是“Tomcat 最后怎么调 Servlet”，而是：

**为什么一个请求进入 Catalina 之后，仍然必须先经过 Mapper、四层 Valve 和 FilterChain，最后才会真正走到 `Servlet.service()`？**

## 先看失败方案：为什么不能从 Adapter 直接跳到 Servlet

要理解 Catalina 的执行主线，最容易的方式仍然不是先背类图，而是先看几个最常见、也最容易误导人的朴素理解。

### 失败方案一：进入 Catalina 之后，直接找到 Servlet 调 `service()`

这是最常见的直觉，因为从结果看，Tomcat 最终的确会调用某个 Servlet。

于是很容易把这条主线压缩成这样：

- 请求已经通过 `CoyoteAdapter` 进入 Catalina
- Catalina 找到目标 Servlet
- 调 `service()`

这个说法在结果上没错，但它把最关键的执行中间层全删掉了。

如果真这样写，你就没法解释：

- Tomcat 是如何根据 Host/Context/Wrapper 逐层确定目标的
- 为什么容器四层各自要有一层 `Valve`
- 为什么 Filter 没被写死在 Servlet 前面，而是通过独立的 `ApplicationFilterChain` 组织
- 为什么后面 async/error 还能沿着这条链反向影响执行

所以“直接调 Servlet”描述的是结果，不是主线。

### 失败方案二：Mapper 只是一个前置工具类，真正重要的是后面的 Valve 链

当读者开始意识到“直接调 Servlet”不对时，通常会往前补一步：先加上 `Mapper`。

然后又很容易产生第二个误解：

- `Mapper` 只是前面做个 URL 路由匹配
- 真正重要的执行主线，是后面的四层 `Valve`

这个切法也不对。

原因是 `Mapper` 在这里不是一个边缘工具类，它是 Catalina 执行主线真正的第一跳。没有它，后面的 Valve 链根本不知道请求该先落到哪个 Host、哪个 Context、哪个 Wrapper。

也就是说，`Mapper` 和后面的容器责任链不是平行关系，而是前后相接的一条主线：

- `Mapper` 解决“该去哪里”
- `Valve` 链解决“到了这一层以后，该怎样继续收束执行”

如果把 Mapper 降级成“前置小工具”，后面四层 Valve 为什么按这个顺序传播、为什么会落到某个特定 Wrapper，就会失去来源。

### 失败方案三：四层 Valve 链走完，请求执行也就讲完了

还有一种更隐蔽的误解：

- Engine -> Host -> Context -> Wrapper 这四层已经形成了一条容器责任链
- 那么只要把这条链讲清楚，请求执行主线也就算讲完了

问题在于，`StandardWrapperValve` 还不是最后一站。

它虽然已经是容器四层里的最末端，但到了这里，Tomcat 还要继续做一件关键动作：

- 构造 `ApplicationFilterChain`
- 再通过 `filterChain.doFilter(...)`
- 把 Filter 和 Servlet 串成真正的执行末端

也就是说，容器责任链解决的是“请求如何逐层收束到正确的执行目标”，而 `ApplicationFilterChain` 解决的是“目标确定后，Filter 与 Servlet 如何真正被组织成执行链”。

如果不把这两个层次拆开，后面讲 Filter 行为时，读者会误以为 Filter 只是某个 Valve 的附属步骤；而源码里它们并不是一回事。

## Catalina 执行主线的最小总图

如果把 Catalina 内部这段链路先压缩成最小模型，它可以写成下面这样：

```text
CoyoteAdapter
   -> Mapper
   -> StandardEngineValve
   -> StandardHostValve
   -> StandardContextValve
   -> StandardWrapperValve
   -> ApplicationFilterChain
   -> Servlet.service()
```

如果再换一种更容易理解的说法，这条链其实可以拆成三段职责：

```text
[路由入口]
Mapper

   ->

[容器四层收束]
EngineValve -> HostValve -> ContextValve -> WrapperValve

   ->

[执行末端]
ApplicationFilterChain -> Servlet.service()
```

这张图最重要的价值，不是让读者背类名，而是先分清三种问题：

### 一、路由入口
回答：请求在 Catalina 里首先该落到哪个目标上？

这一步主要由：
- `Mapper`

承担。

### 二、容器四层收束
回答：确定了大方向以后，请求如何沿 Engine / Host / Context / Wrapper 四层逐步收束到最终执行节点？

这一步主要由：
- `StandardEngineValve`
- `StandardHostValve`
- `StandardContextValve`
- `StandardWrapperValve`

承担。

### 三、执行末端
回答：到了最终 Wrapper 之后，Filter 与 Servlet 如何真正被串成执行链？

这一步主要由：
- `ApplicationFilterFactory`
- `ApplicationFilterChain`
- `Servlet.service()`

承担。

只要把这三段职责先分开，后面每一层的存在理由就会清楚很多。

## 一、`Mapper`：容器执行闭环的真正入口

在 Ch2 里，我们把 `CoyoteAdapter` 定位为“请求进入 Catalina 的边界”。但进入 Catalina 之后，请求并不会自动落到某个 Servlet。它首先还需要知道：

- 当前请求属于哪个虚拟主机
- 当前 URI 属于哪个 Web 应用
- 当前最终该命中哪个 Wrapper

也就是说，请求进入 Catalina 之后，第一件事不是“执行”，而是“选目标”。

这也是 `Mapper` 在整条执行主线里的位置：它不是旁路工具，而是 Catalina 执行闭环入口侧的第一个关键角色。

`Mapper` 的定义位置：

证据：`org/apache/catalina/mapper/Mapper.java:47`

这里先不展开四级匹配细节，但要先立住它在主线里的功能边界：

- 在它之前，请求只是“已经进入 Catalina”
- 在它之后，请求才开始知道自己应该去哪个 Host/Context/Wrapper

所以 `Mapper` 回答的不是“请求怎么执行”，而是“请求该去哪里执行”。

也正因为如此，如果把 `Mapper` 从主线里拿掉，后面的 `Valve` 链就会失去起点。因为四层 `Valve` 不是在真空里执行的，它们必须站在一个已经有了目标方向的请求之上继续收束上下文。

这也是为什么本篇要把 `Mapper` 放在执行闭环的第一段，而不是当作后面某篇路由专题的附属材料。

## 二、四层 `Valve` 链：不是重复套壳，而是逐层收束执行上下文

一旦请求通过 `Mapper` 确定了大方向，接下来进入的就是 Catalina 最容易被“概念化过度”的一段：四层 `Valve` 链。

很多文章一讲到这里，就会开始用“责任链模式”一把带过。这样写当然不算错，但问题是它会迅速把代码里真正重要的分层差异抹平。

Tomcat 这里不是为了展示设计模式才有四层 `Valve`，而是因为请求在容器世界里的收束本来就分四层：

- 先收束到 `Engine`
- 再收束到 `Host`
- 再收束到 `Context`
- 最后收束到 `Wrapper`

这四层对应的基本 `Valve` 分别是：

证据：`org/apache/catalina/core/StandardEngineValve.java:35`
证据：`org/apache/catalina/core/StandardHostValve.java:50`
证据：`org/apache/catalina/core/StandardContextValve.java:40`
证据：`org/apache/catalina/core/StandardWrapperValve.java:50`

这条链最值得强调的，不是它“像不像责任链”，而是它回答的层层递进问题不同。

### `StandardEngineValve`

这一层更接近全局容器入口。它回答的是：请求已经进入当前 Service 的容器树后，该沿哪个 Engine 视角继续推进。

### `StandardHostValve`

这一层把请求继续收束到具体 Host。也正因为 Host 与错误页、异常出口、Context 选择关系更近，所以后面 async/error 主线反向切回来时，`StandardHostValve` 会再次变得关键。

### `StandardContextValve`

这一层把请求继续收束到具体 Web 应用，也就是某个 Context 的边界内。

### `StandardWrapperValve`

这是容器四层里的最后一层。很多人讲到这里会自然停下，以为“容器链到这里就完成了”。但 Tomcat 真正执行请求的世界，恰恰从这里才开始变得更具体。

所以看四层 Valve 链时，最重要的不是把它记成四个类名，而是记住它们共同完成的一件事：

**每往下一层，请求的执行上下文就被收束得更窄、更具体，直到最终落到某个 Wrapper。**

## 三、`StandardWrapperValve`：容器链和执行链的边界点

如果说前面的三层 `Valve` 还在回答“该收束到哪里”，那么 `StandardWrapperValve` 就站在一个特别关键的边界上：

- 它一边仍然属于 Catalina 容器四层责任链
- 另一边又马上要把请求推进到 Filter 与 Servlet 的真实执行世界

这也是为什么它不能被简单写成“第四层 Valve”就完事了。

在 `StandardWrapperValve` 里，一个关键动作是：

```java
ApplicationFilterChain filterChain = ApplicationFilterFactory.createFilterChain(request, wrapper, servlet);
```

证据：`org/apache/catalina/core/StandardWrapperValve.java:141`

紧接着，真正执行请求的是：

```java
filterChain.doFilter(request.getRequest(), response.getResponse());
```

证据：`org/apache/catalina/core/StandardWrapperValve.java:155`

这两步说明：

- 到 `StandardWrapperValve` 为止，请求只是收束到了最终 Wrapper
- 真正把 Filter 与 Servlet 组织成一条执行链，是从这里才开始的

所以，`StandardWrapperValve` 的关键价值不是“第四层也有个 Valve”，而是：

**它是容器责任链与执行末端链之间的交界点。**

如果没有这层边界意识，后面再讲 FilterChain 时，读者很容易把它误会成某个附属工具，而看不到它在主线里的位置。

## 四、`ApplicationFilterFactory` / `ApplicationFilterChain`：执行末端真正成型

到了这里，Tomcat 才真正开始进入“Filter 和 Servlet 怎么跑起来”的执行末端。

先看 `ApplicationFilterFactory.createFilterChain(...)` 的入口：

证据：`org/apache/catalina/core/ApplicationFilterFactory.java:57`

从这个工厂方法的定义可以先立住一个事实：Filter 链不是某个 `Valve` 顺手写死进去的，它有自己独立的装配入口。

再看 `ApplicationFilterChain` 本身的定义位置：

证据：`org/apache/catalina/core/ApplicationFilterChain.java:46`

这两者合起来，回答的是这样一个问题：

为什么 Filter 能先于 Servlet 执行，而且还能形成一条独立的可传播链？

答案就在这里：Tomcat 到了 `StandardWrapperValve` 并不会直接调 `Servlet.service()`，而是先构造 `ApplicationFilterChain`，再由这条链去组织后续执行。

换句话说，Filter 和 Servlet 不是两个平行的末端目标，而是同一条执行末端链上的前后段：

- 前半段由 `ApplicationFilterChain` 逐步推进 Filter
- 末端才真正落到 `Servlet.service()`

这也是为什么本篇不能把 `ApplicationFilterChain` 写成实现细节。它不是一个“小辅助类”，而是执行末端正式成型的地方。

## 到了这里，请求还没“结束”，只是终于开始在正确的目标上执行

看到 `ApplicationFilterChain` 之后，又很容易产生另一个错觉：

- Mapper 选好目标了
- Valve 链收束完了
- FilterChain 也装好了
- 那请求是不是已经讲完了？

也还没有。

更准确地说，到了这里，我们只是终于把请求推进到了“正确的目标与正确的执行链”上。

接下来它仍然还会继续碰到：

- Filter 的前后传播
- Servlet 真正执行
- async dispatch
- 异常出口
- 错误页
- Session 访问

这些都属于后面的专题。

所以本篇真正收住的位置，不是“Tomcat 请求完整生命周期结束”，而是：

**Catalina 内部的执行闭环已经真正成型：目标选出来了，容器链收束完了，执行末端也搭起来了。**

## 这篇真正立住的，是“执行主线不能被压成一句调 Servlet”

回到最开头那个最容易误导人的直觉：

- 请求进入 Catalina
- 找到 Servlet
- 调 `service()`

现在应该已经能看清这里中间省略了多少层：

1. `Mapper` 负责先选目标
2. `Engine/Host/Context/Wrapper` 四层 `Valve` 负责逐层收束执行上下文
3. `StandardWrapperValve` 把请求推进到真正的执行末端边界
4. `ApplicationFilterChain` 把 Filter 与 Servlet 串成执行链
5. 末端才真正落到 `Servlet.service()`

只有把这几层拆开，后面再讲 async/error/Session/Mapper 动态更新时，读者才知道那些机制分别是在影响哪一段主线。

## 下一篇该接什么

这篇已经把 Catalina 内部“目标如何被选出来、执行链如何被搭起来”讲清楚了。

但它还没展开一个同样重要的问题：

- 为什么 async dispatch、timeout、异常出口，会重新把控制流拉回 HostValve、WrapperValve 甚至 ErrorReportValve？

也就是说，执行主线已经立住了，但它的失败路径和反向控制流还没有展开。

所以下一篇最自然的继续点之一，不是再补 Servlet 细枝末节，而是进入：

- async
- timeout
- dispatch
- onError
- ErrorReportValve / StandardHostValve

也就是 **异步、超时与错误处理闭环**。

到那时，这条正向执行主线才会真正补上它的另一半：不是“请求怎么正常执行”，而是“请求一旦偏离正常路径，Tomcat 怎么把它重新接住”。