# 一个 HTTP 请求是怎么进入 Tomcat 的：从 Socket 到 Catalina

> 本文基于 Tomcat 10.1.34 当前源码。本文只讲“请求如何进入 Tomcat，并在何处从 Coyote 切进 Catalina”。也就是说，重点是 `Connector / Endpoint / Processor / Adapter` 这一段主线。至于请求进入 Catalina 之后，Mapper 如何选目标、Valve 链如何传播、FilterChain 和 Servlet 如何真正执行，会在后续几篇继续展开。

## 请求已经进来了，这句话到底省略了多少东西

很多文章写 Tomcat，请求进入流程时都会一句带过：

- 浏览器发起 HTTP 请求
- Tomcat 收到请求
- 找到目标 Servlet
- 调用 `service()`

这四步在结果上当然没错，但问题也恰恰出在这里：它把一整条运行时主线压扁成了一句“Tomcat 收到请求”。

一旦这么写，读者后面会连续遇到几个解释不通的问题。

第一个问题是：**到底是谁“收到”了请求？**

Tomcat 不是单个类在接请求。连接先进入网络层，再进入协议层，然后才有可能进入容器层。这中间至少还要分清：

- 谁在监听端口
- 谁在拿到可读事件
- 谁在解析 HTTP 协议
- 谁把协议请求转换成容器世界的请求对象

第二个问题是：**协议层和容器层之间到底在哪里切换？**

Tomcat 的请求处理不是单层系统。前一段链路里，主角是：

- `Connector`
- `ProtocolHandler`
- `Endpoint`
- `Processor`

而到了真正容器执行的世界，主角又变成：

- `Mapper`
- `Pipeline`
- `FilterChain`
- `Servlet`

如果不把这条边界讲清楚，读者很容易产生一种误解：仿佛 HTTP 一解析完，请求就“自然”流到了 Servlet。源码里并不是这样，真正让这条链接上的，是一个很具体的桥接角色：`CoyoteAdapter`。

第三个问题是：**为什么 Tomcat 不能把“请求进入”压成一个 `Connector` 章节？**

因为 `Connector` 只是外层门面。它确实是配置和生命周期上的入口，但请求真正经历的运行时路径，比一个 `Connector` 要深得多。只要把 `Connector` 当成“请求处理器”，后面一讲到：

- IO 事件怎么进来
- Processor 为什么能复用
- async/timeout 为什么深入协议层
- 请求是在哪里切到 Catalina 的

整条线都会开始模糊。

所以，本文真正想回答的不是“Tomcat 怎么收 HTTP 请求”这种表面问题，而是：

**一个 HTTP 请求进入 Tomcat 后，究竟是在什么地方被接住、被解析、被包装，又是在什么地方从 Coyote 世界切进 Catalina 世界？**

## 先看失败方案：为什么“Connector 收到请求”远远不够

理解请求进入主线，最容易的方法仍然不是直接看类图，而是先看几个看似合理、实际上都不够的朴素理解。

### 失败方案一：请求进入 = Connector 收到请求

这是最常见的写法，因为从配置视角看，Tomcat 对外暴露的网络入口就是 `Connector`。

于是很容易形成一个直觉：

- 端口是 Connector 配的
- 协议是 Connector 选的
- 所以请求进入也就是 Connector 处理的

这个说法的问题在于，它把“外层入口”与“运行时分工”混在了一起。

`Connector` 当然重要，但它回答的是：

- 这个入口用什么协议
- 背后挂哪个 `ProtocolHandler`
- 生命周期如何和整体容器联动

它并不直接等于：

- 谁接收 TCP 连接
- 谁拿到可读事件
- 谁逐步解析 HTTP 报文
- 谁把请求推进到 Catalina

也就是说，`Connector` 是入口门面，不是整条运行时主线的全部。把“请求进入”压缩成一句“Connector 收到请求”，会把后面最关键的分层全部抹掉。

### 失败方案二：NIO 线程 + HTTP 解析就是全部主线

另一种常见偷懒方式，是把请求进入理解成一个黑箱：

- `NioEndpoint` 负责 NIO
- `Http11Processor` 负责 HTTP
- 然后请求就进去了

这个理解比第一种进了一步，但依旧不够，因为它仍然没回答：

- 解析完的请求对象是怎么切到 Catalina 世界的？
- `Mapper`、`Pipeline`、`FilterChain` 的入口究竟在哪里？
- 协议层世界和容器层世界之间，谁负责跨层切换？

如果这里不讲清，后面写到 `Mapper` 或 `FilterChain` 时，读者心里会一直悬着一句话：

**“这些东西到底是谁先调起来的？”**

所以，`Endpoint + Processor` 只是请求进入链的前半段，不是整条主线的全部。

### 失败方案三：`CoyoteAdapter` 只是一个名字上好看的适配器

如果只从设计模式的直觉看，`Adapter` 很容易被读成“一个薄薄的接口转换层”，甚至像是可有可无的胶水类。

但在 Tomcat 的请求进入主线里，`CoyoteAdapter` 的地位远不止这样。

因为在它之前，请求还属于协议处理世界；在它之后，请求才真正进入 Catalina 的容器执行世界。它不是“顺手转一下对象”的工具，而是整个跨层切换的边界点。

如果低估这一层，整篇文章最后就会卡在一个很致命的断点上：

- HTTP 已经解析完了
- 然后呢？

所以，`CoyoteAdapter` 不是附属知识，而是整条请求进入主线最不能跳过的一段。

## 请求进入 Tomcat 的最小总图

如果把这一整段主线先压缩成最小模型，它其实可以写成下面这样：

```text
Socket/HTTP bytes
   -> Endpoint / ProtocolHandler
   -> Http11Processor
   -> CoyoteAdapter
   -> Catalina request processing begins
```

如果再把 Catalina 里的下游去处补出来，就是：

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

这里最重要的不是把类名背下来，而是先分清四段职责：

### 一、请求入口
回答：连接和字节流先被谁接住？

这一段主要由：
- `Connector`
- `ProtocolHandler`
- `Endpoint`

承担。

### 二、协议处理
回答：HTTP 报文在什么地方被解析成更高层的请求语义？

这一段主要由：
- `Http11Processor`

承担。

### 三、跨层切换
回答：什么时候不再只是“协议已解析”，而开始变成“容器可以执行”？

这一段主要由：
- `CoyoteAdapter`

承担。

### 四、Catalina 接手
回答：进入容器世界后，请求如何找到目标、如何真正执行？

这一段会进入：
- `Mapper`
- `Pipeline`
- `FilterChain`
- `Servlet`

但这些是后续主题；本篇只负责把请求送到它们门口。

## 一、`Connector`：它是门面入口，但不是整条主线

请求进入 Tomcat，外层最容易看见的角色当然是 `Connector`。在 Ch1 我们已经看到过，`Connector` 在初始化时会做一件非常关键的事：

```java
adapter = new CoyoteAdapter(this);
protocolHandler.setAdapter(adapter);
```

证据：`org/apache/catalina/connector/Connector.java:999`
证据：`org/apache/catalina/connector/Connector.java:1000`

这段代码说明两件事。

第一，`Connector` 确实是请求主线的门面入口。因为外层协议能力、下游适配关系，都是在这里被接上的。

第二，也正因为它只是门面，所以不能把它误写成“请求处理器本体”。它本质上做的是：

- 选择一个 `ProtocolHandler`
- 把 `Adapter` 挂上去
- 让后续运行时链条有路可走

换句话说，`Connector` 的价值更像“总入口的配置与挂接点”，而不是“所有请求细节都在这里执行”。

如果把 `Connector` 写成整条主线，就会掩盖掉 `Endpoint`、`Processor` 和 `Adapter` 的不同职责。

## 二、`NioEndpoint`：请求真正接触网络世界的地方

当请求真的从外部进入时，最先面对它的不是容器树，也不是 `Mapper`，而是更靠近网络的一层：`Endpoint`。

Tomcat 当前 HTTP/1.1 NIO 主线里，关键角色是 `NioEndpoint`：

证据：`org/apache/tomcat/util/net/NioEndpoint.java:71`

这个类在本文里不需要深入到每个内部线程细节，但至少要立住它的职责边界：

- 它更靠近连接接收和 IO 事件这一侧
- 它是“请求真正碰到 Tomcat 网络栈”的地方
- 它负责把“外部世界有连接/有数据”这件事推进到后续协议处理链

也就是说，如果把请求进入比作一条生产线，`NioEndpoint` 更像是把原始材料送进车间的入口，而不是本篇要展开的协议解析中心或容器执行中心。这里先立住它更靠近“连接接收与事件入口”这一侧，内部线程与事件细节留到后续需要时再展开。

这一点非常关键，因为后面只要讲到：

- 超时
- keep-alive
- 连接复用
- 异步写回

这些话题都离不开“请求最开始是在哪一侧被接住”的视角。如果这里写糊了，后面很多边界都会跟着糊掉。

## 三、`Http11Processor`：协议已经不是字节流了，但还不是容器执行

请求离开 `Endpoint` 之后，就进入了另一个更像“协议处理器”的角色：`Http11Processor`。

证据：`org/apache/coyote/http11/Http11Processor.java:70`

这一步最容易被误写成：

- `Http11Processor` 解析完 HTTP
- 所以 Tomcat 就开始执行 Servlet 了

但中间其实还差一层很关键的跨层切换。

更准确地说，`Http11Processor` 所在的位置是：

- 它已经不再只是网络字节流入口
- 它开始处理 HTTP/1.1 协议语义
- 但它还没有直接进入 Catalina 容器执行世界

所以，`Processor` 更像是请求主线里的“协议处理中心”。它把原始字节流推进成可理解的 HTTP 请求语义，但这个阶段仍然属于 Coyote 世界。

这也是为什么本篇不能把 `Processor` 和 `Servlet` 直接连在一起。中间少掉的那一步，就是下文要讲的 `CoyoteAdapter`。

## 四、`CoyoteAdapter`：请求从 Coyote 切进 Catalina 的边界

如果前面三段职责都分清了，那么整篇真正的关键点就会非常明确：

**请求不是在 `Http11Processor` 里“自然”进入 Catalina 的，而是通过 `CoyoteAdapter` 这个桥真正切进去的。**

`CoyoteAdapter` 的定义位置：

证据：`org/apache/catalina/connector/CoyoteAdapter.java:64`

它在整条主线里的位置，不该理解成“又一个帮忙处理请求的类”，而应理解成：

- 在它之前，请求主要处在协议处理世界
- 在它之后，请求才开始进入 Catalina 的容器执行世界

换句话说，`CoyoteAdapter` 回答的是：

**协议已经解析到足够程度之后，Tomcat 怎么把它交给容器体系继续处理？**

这也是为什么 Ch1 里我们说 `Connector.initInternal()` 里的：

```java
adapter = new CoyoteAdapter(this);
protocolHandler.setAdapter(adapter);
```

不是普通字段赋值，而是一次运行时接线。因为从这一刻开始，协议栈解析出来的请求就不再是“停在 Coyote 这边的结果”，而是有了一条明确的下游路径，能继续被送往 Catalina。

如果非要把这条链压成一句最短的话，那应该是：

- `Endpoint` 负责把连接和事件接进来
- `Http11Processor` 负责把字节流推进成 HTTP 请求语义
- `CoyoteAdapter` 负责把协议请求切进 Catalina 容器世界

只有这样分层，后面再写 `Mapper -> Pipeline -> FilterChain -> Servlet`，读者才知道这些东西不是凭空启动的，而是从 `Adapter` 这里正式接手。

## 到了这里，请求其实还没有“执行完”，只是终于进了门

看到这里，非常容易出现一种错觉：

- 连接接住了
- 协议解析了
- `CoyoteAdapter` 也出场了
- 那请求应该已经快执行完了

其实不是。

更准确地说，到了 `CoyoteAdapter` 这一层，请求只是终于完成了一个最关键的动作：

**它不再只是协议层里的请求，而开始变成 Catalina 可以继续处理的请求。**

也就是说，本篇真正收住的位置，不是“请求执行结束”，而是“请求已经完成协议层到容器层的跨层切换”。

接下来它还要继续回答：

- 目标 Host/Context/Wrapper 是谁
- Valve 链怎么传播
- `ApplicationFilterFactory.createFilterChain(...)` 在哪里把 Filter 链真正装起来
- Servlet 是在哪一层真正被调用

这些都属于下一篇的内容。

所以本篇最重要的收获，不是记住了几个类名，而是记住了这条边界：

- `Endpoint / Processor` 之前之后，讲的是请求怎么被接住、怎么被解析
- `CoyoteAdapter` 之后，才开始讲请求在 Catalina 里怎么被真正执行

## 这篇真正立住的，是“请求进入”不能被压扁

回到开头那句常见表述：

- 浏览器发起 HTTP 请求
- Tomcat 收到请求
- 找到目标 Servlet
- 调用 `service()`

现在应该已经能看出来，这里面最危险的就是第二句：**“Tomcat 收到请求”。**

因为它会把整条最值得学习的运行时主线都折叠掉。

从当前源码归纳出来，更稳妥的理解方式应该是：

1. 请求先从网络世界进入 `Endpoint`
2. 协议语义在 `Http11Processor` 中被推进
3. 请求通过 `CoyoteAdapter` 从 Coyote 世界切进 Catalina 世界
4. Catalina 再继续完成路由与执行

只有把这四步拆开，后面讲 async、timeout、error、Mapper、Valve、FilterChain 时，读者才知道每一层到底是在回答哪一种问题。

## 下一篇该接什么

这篇只回答了：**请求是怎么进入 Catalina 的。**

但它还没回答：进入 Catalina 之后，请求是怎么找到目标并真正跑到 Servlet 上的？

所以下一篇最自然的继续点就是：

- `Mapper`
- `StandardEngineValve`
- `StandardHostValve`
- `StandardContextValve`
- `StandardWrapperValve`
- `ApplicationFilterChain`

也就是 **容器执行闭环**。

到那时，请求主线才会真正从“进门”继续推进到“落座”：先找到目标，再经过 Valve 和 Filter，最后真正调到 `Servlet.service()`。