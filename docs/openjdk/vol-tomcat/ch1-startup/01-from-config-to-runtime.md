# Tomcat 启动时到底发生了什么：从配置树到可收请求的运行时容器

> 本文基于 Tomcat 10.1.34 当前源码。本文只讲启动与装配闭环：一个嵌入式 Tomcat 为什么从 `Tomcat.start()` 出发，就能把容器树、请求入口和路由同步焊成一个真正可运行的系统。请求如何进入 Connector、协议如何解析、请求如何穿过 Valve/Filter/Servlet，会在后续几篇继续展开。

## 一个最容易被低估的问题：为什么“对象都建好了”还不等于 Tomcat 启动完成

很多人第一次看嵌入式 Tomcat，直觉会觉得它的启动并不神秘。

代码表面上看起来很像这样：

- new 一个 `Tomcat`
- 配个端口
- 建一个 `Context`
- 注册一个 `Servlet`
- 调 `start()`

如果只停在这层印象里，Tomcat 启动就会被误解成“把一棵配置对象树组装好”。可一旦真的沿源码往下追，就会发现这里至少还有两个更深的问题没有回答。

第一个问题是：**容器树为什么会变成请求处理系统？**

`Server`、`Service`、`Engine`、`Host`、`Context`、`Wrapper` 这些名字，描述的只是 Catalina 世界里的容器层次。它们解释了“请求进入容器后，该由谁继续往下分发”，但并没有解释：

- 请求是怎么进入 Tomcat 的？
- 端口是谁在监听？
- 字节流是谁在解析？
- Catalina 里的容器树，什么时候和 Coyote 的协议处理链真正接上线？

第二个问题是：**启动为什么不是一次性的静态组装？**

如果启动只是把对象互相 set 进去，它看起来就更像一段初始化脚本。但 Tomcat 当前启动源码还额外暴露出一组桥接角色；正是这些角色，让“对象已经连上”继续推进到了“系统开始具备运行态职责”。

- `Connector`
- `CoyoteAdapter`
- `Mapper`
- `MapperListener`

这些角色不负责业务逻辑，却决定了“配置对象”是否能承担运行时职责。只有当它们和容器树一起接好线，Tomcat 才从“树状配置结构”变成“可接收请求、可执行路由、可进入 Servlet”的运行时容器。

所以，本文真正想回答的问题不是“Tomcat 有哪些核心类”，而是：

**为什么 `Tomcat.start()` 之后，原本只是配置对象的一套结构，会突然变成一个真正活起来的请求处理系统？**

## 先看失败方案：为什么只有容器树还不够

要理解 Tomcat 启动，最好的办法不是直接背 `Server -> Service -> Engine -> Host -> Context -> Wrapper` 这条链，而是先看几个看似合理、实际上都不成立的朴素方案。

### 失败方案一：只要容器树完整，Tomcat 就算启动好了

这是最自然的直觉。

毕竟从概念上看，Tomcat 的职责就是：

- 找到目标虚拟主机
- 找到目标 Web 应用
- 找到目标 Servlet
- 调它的 `service()`

于是很容易得出一个朴素结论：

只要我把下面这些对象都挂好：

- `Server`
- `Service`
- `Engine`
- `Host`
- `Context`
- `Wrapper`

Tomcat 启动这件事就已经完成了。

这个结论的问题在于，它只回答了**容器内部怎么组织**，却没有回答**请求怎么进来**。

一棵纯粹的容器树，至少缺三种运行时能力：

- 没有端口监听能力
- 没有协议解析能力
- 没有请求对象跨层转换能力

也就是说，就算 `Engine/Host/Context/Wrapper` 全都组好了，这套结构依旧只是 Catalina 内部的处理框架。没有 `Connector` 和它背后的协议处理链，外部网络请求根本进不来；没有 `Adapter`，Coyote 世界里的协议请求也进不了 Catalina 世界里的容器链。

所以容器树只解决了“请求进入容器后怎么继续走”的问题，没有解决“请求如何被接进系统”的问题。

### 失败方案二：只要有 Connector，Tomcat 就能工作

既然前一个方案的问题是没有请求入口，那另一个直觉就会出现：

好，那我不要只看容器树，我把 `Connector` 配上不就行了吗？

这个方案也不够。

原因是 `Connector` 虽然把请求接进来了，但它并不知道 Catalina 内部该把请求交给谁。Tomcat 不是一个“一个入口只对一个处理器”的模型，它内部至少还要回答：

- 当前请求属于哪个 `Host`？
- 当前 URI 属于哪个 `Context`？
- 当前请求最终该命中哪个 `Wrapper`？
- 如果容器结构在运行中变化，路由数据谁来同步？

这里就引出第二组关键角色：

- `Mapper`
- `MapperListener`

`Mapper` 负责保存并执行路由映射规则，`MapperListener` 负责监听容器变化并把这些变化同步到 `Mapper`。如果没有它们，`Connector` 就只是把请求送到 Catalina 门口，却不知道 Catalina 内部真正的目标节点是谁。

所以只有请求入口，没有路由同步，Tomcat 仍然无法形成完整运行时系统。

### 失败方案三：启动只是一次性静态连线

还有一种更隐蔽的误解：认为启动只是“启动前的配置期动作”，只要在 `start()` 前把所有对象都配好，后面就只是简单执行。

这个误解的问题是，它把启动看成“树形组装”，却没有意识到 Tomcat 启动里有一部分是**运行态接线**。

例如 `StandardService` 不只是简单持有一个 `Engine`。它同时还持有：

- `Mapper`
- `MapperListener`

并且在运行中切换 `Engine` 时，`MapperListener` 还需要先 stop、再 start，重新把新的容器树和路由结构接上。这说明启动不是一次性的“对象图成型”，而是进入运行态前的最后一轮装配闭环。

同样，`Connector` 在 `initInternal()` 里才创建 `CoyoteAdapter`，再把它挂给 `ProtocolHandler`。这也不是单纯的“字段赋值”，而是在把协议处理层和容器层真正打通。

所以，Tomcat 启动最核心的理解方式不是“类之间有什么引用关系”，而是：

**启动是把容器树、请求入口、协议桥接、路由同步四套能力焊接成一个闭环。**

## Tomcat 启动的最小总图：先把四类角色分清楚

如果不先把角色分层，后面很容易一头扎进类名里出不来。Tomcat 启动至少可以拆成四类角色。

```text
Tomcat.start()
   |
   v
[容器树]
Server -> Service -> Engine -> Host -> Context -> Wrapper
   |
   +----[请求入口]
   |        Connector -> ProtocolHandler -> Endpoint
   |
   +----[协议桥接]
   |        CoyoteAdapter
   |
   +----[路由同步]
            Mapper + MapperListener
```

如果你是第一次系统看 Tomcat，这里不用急着把所有类名都记住。先抓住一个最小认识就够了：

- 上面那张图在回答“启动时有哪些角色必须接上线”
- 下面这张图在回答“接好线以后，请求会沿哪条主线开始流动”

也就是说，第一张图偏静态装配，第二张图偏运行时流动。

如果把这张总图再往前推一小步，Tomcat 真正的运行时接线关系可以压缩成下面这一条：

```text
Socket/HTTP bytes
   -> Endpoint / ProtocolHandler
   -> Http11Processor
   -> CoyoteAdapter
   -> Mapper
   -> Engine/Host/Context/Wrapper Pipeline
   -> ApplicationFilterChain
   -> Servlet.service()
```

前一张图回答“启动时有哪些角色必须接上线”，后一张图回答“这些角色一旦接好，请求将沿哪条主线开始流动”。

这四类角色各自回答的问题完全不同。

### 一、容器树：请求进入 Catalina 之后，谁负责继续往下分发

这一层第一次看时最容易被类名压住，所以可以先只记住两层关系：

- `Service` 把“请求入口”和“容器树”组织在一起
- `Engine -> Host -> Context -> Wrapper` 负责把请求一层层往具体目标收束

如果再展开成完整容器层次，就是：

- `Server`：最外层服务器对象
- `Service`：把一个 `Engine` 和多个 `Connector` 组织在一起
- `Engine`：按虚拟主机维度往下分发
- `Host`：表示一个虚拟主机
- `Context`：表示一个 Web 应用
- `Wrapper`：表示一个 Servlet

这一层回答的不是“请求怎么进来”，而是“请求一旦进入 Catalina，应该落到哪一层继续处理”。

### 二、请求入口：外部连接如何被接进系统

这层由 `Connector` 及其背后的协议实现承担。

它回答的是：

- 哪个端口在监听
- 接收到的是哪种协议
- 连接怎么被协议处理器消费

换句话说，没有这层，请求连门都进不了。

### 三、协议桥接：Coyote 世界如何切到 Catalina 世界

Tomcat 不是单层系统。

在接收连接和解析协议这一侧，核心主角是 Coyote；
在容器执行和 Servlet 调度这一侧，核心主角是 Catalina。

从当前实现看，这两个世界之间需要一个桥接层。

`CoyoteAdapter` 的关键价值不在于“它也处理请求”，而在于它把协议层请求转换成容器层请求，把“字节流已经被协议栈接住”继续推进到“容器树可以开始执行”。

### 四、路由同步：容器结构变化如何进入请求路由系统

即使有了容器树，也还要把它转成请求可用的路由数据结构。

这就是 `Mapper` 和 `MapperListener` 的职责。

- `Mapper` 保存路由映射规则
- `MapperListener` 监听容器生命周期和结构变化，并把变化同步给 `Mapper`

这样，请求在运行时才能根据 Host / Context / Wrapper 路由到正确目标。

所以从当前源码可以归纳出：判断 Tomcat 是否已经从“配置对象集合”进入“可运行系统”，不能只看对象是否建好，而要看这四类角色是否都已经接上线。

## 源码里真正的接线点在哪里

前面的总图如果没有源码支撑，就还只是结构化理解。真正让这套理解落地的，是几个关键接线点。

## 一、`Tomcat.start()`：外层启动入口

在 `Tomcat` 启动类里，可以直接看到外层入口：

```java
public void start() throws LifecycleException {
    getServer();
    server.start();
}
```

证据：`org/apache/catalina/startup/Tomcat.java:435`

这段代码证明的不是“start 调用了 start”这么简单，而是：对外暴露的 `Tomcat.start()`，最终把启动责任交给了更底层的 `Server` 生命周期体系。

也就是说，外层 `Tomcat` 本身更像嵌入式模式下的装配门面。它负责帮你建好对象、拼好配置、暴露便捷 API；但一旦真正进入启动阶段，核心启动责任还是回落到 Catalina 的生命周期对象上。

这一步把“嵌入式友好 API”接到了“真正生命周期执行器”。

## 二、`Connector.initInternal()`：协议入口和 Catalina 之间的桥接被真正焊上

前面说过，只有容器树还不够，因为请求根本进不来；只有 Connector 也不够，因为它不知道怎么把协议请求交给容器树。

这个桥接动作在 `Connector.initInternal()` 里非常直接：

```java
adapter = new CoyoteAdapter(this);
protocolHandler.setAdapter(adapter);
```

证据：`org/apache/catalina/connector/Connector.java:999`
证据：`org/apache/catalina/connector/Connector.java:1000`

这两行代码非常短，但它们几乎可以看作 Tomcat 启动中最关键的一次“焊点”。

原因在于：

- `ProtocolHandler` 代表的是协议处理世界
- `CoyoteAdapter` 代表的是从协议层切向 Catalina 层的桥

当 `setAdapter(adapter)` 完成时，协议处理链就有了一个明确的下游去处：请求在协议层被接住之后，可以继续被推进到 Catalina 容器世界。

也就是说，`Connector` 的意义不只是“开端口”。它真正让请求入口闭环的，是：

1. 它持有一个 `ProtocolHandler`
2. 这个 `ProtocolHandler` 会在请求进入后推动协议处理
3. 而协议处理结果，会通过 `CoyoteAdapter` 接入 Catalina 世界

这一点如果不强调，Tomcat 启动很容易被写成“容器树章节”和“Connector 章节”各说各话。实际上两者真正碰面的地方，就在这里。

## 三、`StandardService`：容器树、路由器和请求入口的汇合点

如果说 `Connector.initInternal()` 解决的是“协议入口如何接到 Catalina”，那 `StandardService` 解决的就是另一个问题：**谁来把容器树、请求入口和路由同步组织在同一个运行时汇合点上。**

先看它内部直接持有的关键对象：

```java
protected final Mapper mapper = new Mapper();
protected final MapperListener mapperListener = new MapperListener(this);
```

证据：`org/apache/catalina/core/StandardService.java:97`
证据：`org/apache/catalina/core/StandardService.java:103`

这两行特别重要，因为它说明 `Service` 并不只是一个“Connector 列表 + Engine 容器”的中介壳子。它自己就直接承担了“容器树”和“路由同步器”之间的连接职责。

接着再看 `setContainer(Engine engine)` 里的运行态接线逻辑：

```java
if (this.engine != null) {
    this.engine.setService(this);
}
if (getState().isAvailable()) {
    if (this.engine != null) {
        this.engine.start();
    }
    mapperListener.stop();
    mapperListener.start();
    if (oldEngine != null) {
        oldEngine.stop();
    }
}
```

证据：`org/apache/catalina/core/StandardService.java:134`
证据：`org/apache/catalina/core/StandardService.java:151`

从这段代码里，至少可以收出两层比“容器树组好了”更深的事实。

第一，`Engine` 不是一个孤立容器，它会反向拿到自己的 `Service`。这说明 Catalina 容器树不是简单的单向树，它和请求入口组织者之间存在显式绑定。

第二，`MapperListener` 不是“启动时顺带开的一个监听器”。当 `Engine` 在运行态切换时，`MapperListener` 会 stop/start 一次，重新拾取新的容器结构。这说明路由同步并不是静态初始化结果，而是运行期必须持续保持一致的系统能力。

因此，把 `StandardService` 看成一个汇合点会更自然：

- 上接 `Server`
- 下接 `Engine`
- 旁边连着多个 `Connector`
- 内部还持有 `Mapper` 与 `MapperListener`

从本文分析视角看，`StandardService` 正是“配置树如何转向运行时系统”的中心接线板。

## 四、为什么 `MapperListener` 不能在启动篇里完全后移

很多人会想，`Mapper` 既然是 URL 路由结构，那等到后面专门写路由时再讲不就行了？

这个想法只对一半。

路由细节当然可以后写，但 **`MapperListener` 作为启动接线角色，不能完全后移**。

因为如果你在启动篇里完全不讲它，读者会自然产生一个错误印象：

- Tomcat 启动时只做了容器树装配和 Connector 初始化
- 路由系统像是后面“自然就有了”

而源码恰恰说明不是这样。`StandardService` 在一开始就构造了 `Mapper` 和 `MapperListener`，并且在容器切换时明确重启 `MapperListener`。这意味着路由同步器从启动期就已经参与系统装配。

所以在启动篇里，`MapperListener` 不需要展开到四级匹配算法，但必须被明确定位成：

**把容器结构转成可运行路由结构的同步桥接角色。**

只有这样，后续写 `Mapper` 专题时，读者才不会把它误会成某个“单独的工具类”。

## 启动之后，系统相对“只有对象树”到底多了什么能力

现在可以回到开头那个问题：为什么 `Tomcat.start()` 之后，一棵配置对象树会开始表现得像真正的运行时系统？

从前面的源码接线点往回收，可以把这种变化概括为四种运行能力的出现。

### 一、容器分层能力

系统已经知道：

- 请求进入 Catalina 后，该如何沿 `Engine -> Host -> Context -> Wrapper` 一层层向下分发

这来自容器树本身。

### 二、请求入口能力

系统已经知道：

- 哪个端口在监听
- 哪条协议链在接收和解析请求

这来自 `Connector + ProtocolHandler + Endpoint`。

### 三、协议到容器的桥接能力

系统已经知道：

- 协议层一旦把请求解析出来，应该如何切到 Catalina 容器世界

这来自 `CoyoteAdapter`。

### 四、运行态路由同步能力

系统已经知道：

- 当前容器树怎样映射成请求可用的路由结构
- 容器树变化后，谁负责同步这些变化

这来自 `Mapper + MapperListener`。

从本文归纳出来的判断方式看，只有当这四种能力同时出现时，我们才有充分理由把它理解为已经跨过了“配置结构”与“运行系统”之间的分界线。

## 这篇真正立住的，不是类图，而是一个启动判断标准

看到这里，Tomcat 启动至少应该换一种看法。

以后再判断一个容器系统有没有“真正启动起来”，不能只看：

- 对象是不是 new 出来了
- 配置是不是 set 完了
- 容器树是不是组好了

更应该看它是否已经完成了四件事：

1. 容器树是否成型
2. 请求入口是否打开
3. 协议桥接是否打通
4. 路由同步是否可用

从本文角度看，更稳妥的判断方式是：只有当这四条都成立时，我们才有理由把它理解为“系统已经从配置结构跨进运行态”。

也正因为如此，Tomcat 卷的第一篇不能只是“类名导览”或“容器层次科普”。它必须先把这个总装配闭环立住，否则后面写 Connector、Mapper、Valve、FilterChain 时，读者看到的仍然会是散落在不同目录里的零件，而不是同一个系统启动后的不同工作面。

## 下一篇该接什么

这篇只回答了：**为什么一棵配置树能变成运行时容器。**

但它还没回答：请求真的进来之后，Tomcat 是怎么处理的？

也就是说，我们现在只是把“系统为什么活了”讲清楚了，还没讲“系统活起来以后第一口气怎么喘”。

下一篇最自然的继续点就是：

- `Connector`
- `NioEndpoint`
- `Http11Processor`
- `CoyoteAdapter`

也就是 **请求进入与协议处理闭环**。

到那时，前面立住的启动总图才会真正开始流动起来：端口开始监听，连接开始进入，协议开始被解析，请求也终于从 Coyote 世界穿进 Catalina 世界。