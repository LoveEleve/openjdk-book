# Dubbo：Invoker、Protocol、Exporter、Proxy 与 Filter 窄腰

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：为什么 Dubbo 要绕这么一圈

如果你第一次深入 Dubbo 源码，最容易产生的感觉不是“优雅”，而是“怎么这么绕”。

provider 侧明明已经有一个真实的 Java 实现对象 `ref`，为什么不直接交给协议层？为什么还要先变成 `Invoker`，再交给 `Protocol.export()`，最后还要套一层 `Exporter`？

consumer 侧也一样。既然目标就是得到一个能调用远程服务的 Java 代理，为什么不直接在 `ReferenceConfig` 里生成代理？为什么要先 `Protocol.refer()` 拿回一个 `Invoker`，然后再让 `ProxyFactory.getProxy(invoker)` 变成 Java 对象？

如果你只看单个类，这些抽象确实很像“层层包装”。但 Dubbo 恰恰是靠这条包装链把不同协议、不同路由层、不同过滤器和本地/远程两种调用形态，压进同一个运行模型里。

这篇文章要回答的核心问题就是：**Dubbo 的真正窄腰到底是什么，为什么后续所有机制都要围着它转。**

## 二、前情回顾：第一篇已经立住入口，这一篇要立住窄腰

在第一篇里，我们已经把 Dubbo 的用户入口压成了两条对象变形链：

- provider：`ref -> Invoker -> Exporter`
- consumer：`URL/Registry -> Invoker -> Proxy`

那一篇解决的是“服务怎么暴露，引用怎么变成代理”。但它刻意没有继续问：

- 为什么这两条链都绕到 `Invoker` 上？
- `Protocol` 到底在统一什么？
- `Exporter` 真是执行者吗，还是只是注册项？
- `Filter` 为什么不是协议内部细节，而是绕着 `Invoker` 挂的一圈？

这一篇就做这件事：把第一篇的两条对象变形链继续往里打穿，找到真正的运行时窄腰。

## 三、先走三条失败的路

### 失败方案一：Dubbo 的核心是 `Protocol`

这是最容易得出的结论。因为 `Protocol.export()` 和 `Protocol.refer()` 看起来正好卡在 provider 和 consumer 的中心位置：一边导出，一边引用。

但如果你把 `Protocol` 当成真正的中心，就解释不了一件事：为什么 filter、listener、cluster、directory、proxy 这些横切能力，最终都不是围绕 `Protocol` 拼起来的，而是围绕 `Invoker` 拼起来的？

`Protocol` 更像桥。它负责把一个已经被框架统一好的调用体，真正暴露成服务，或者真正引用成远程入口。但这个统一调用体本身，不是 `Protocol`，而是 `Invoker`。

### 失败方案二：`Exporter` 会负责执行业务逻辑

看到 `Exporter` 这个名字，很多人会本能地把它理解成“导出器 / 执行器”。

但 provider 侧真正执行调用时，`DubboProtocol` 的请求处理链不是“找到 Exporter 然后让 Exporter 执行业务”，而是：

- 先根据 service key 找到 `Exporter`
- 再从 `Exporter` 里拿出 `Invoker`
- 最后调用 `exporter.getInvoker().invoke(invocation)`

这说明 `Exporter` 更像“导出后的服务注册项”，而不是执行者。它的核心价值在于：让协议层能按 service key 查到“当前应该调用哪一个 Invoker”。

### 失败方案三：Filter 是协议内部流程的一部分

如果你不看 wrapper，很容易把 filter 当成协议实现里的固定步骤：请求进来，协议先 decode，再跑 filter，再调业务。

但 Dubbo 没有要求每个协议自己认识 filter。相反，它用 `ProtocolFilterWrapper` 在 `export()` 和 `refer()` 的边界上，把原始 `Invoker` 包成 filter chain，然后再交给底层协议。

这意味着：**filter 不是协议内部逻辑，而是协议边界外侧的一圈横切调用链。** 协议本身甚至可以完全不知道 filter 的存在。

## 四、最小总图：所有抽象都围着 `Invoker` 转

先把整篇文章的最小总图压出来：

```text
Provider side
ref
  ↓ ProxyFactory.getInvoker(ref, type, url)
provider Invoker
  ↓ ProtocolFilterWrapper.export(...)
filtered provider Invoker
  ↓ Protocol.export(...)
Exporter
  ↓ request arrives
exporter.getInvoker().invoke(invocation)
  ↓
actual ref.method(...)

Consumer side
Protocol.refer(type, url)
  ↓
remote Invoker
  ↓ ProtocolFilterWrapper.refer(...)
filtered consumer Invoker
  ↓ ProtocolListenerWrapper.refer(...)
wrapped consumer Invoker
  ↓ ProxyFactory.getProxy(invoker)
Java interface proxy
  ↓ business method call
InvokerInvocationHandler -> invoker.invoke(rpcInvocation)
```

这张图里最关键的一刀是：Provider 和 Consumer 看起来方向相反，但它们真正共享的不是 `Protocol`，而是 `Invoker`。

- Provider 把本地对象变成 Invoker，再交给协议暴露。  
- Consumer 从协议拿到远程 Invoker，再变成 Java 代理。  

所以这篇真正要立住的是：**`Invoker` 不是辅助抽象，而是 Dubbo 的运行时窄腰。**

## 五、`Invoker`：为什么它才是 Dubbo 的真正窄腰

### 5.1 `Invoker` 只有两个核心能力

`Invoker` 的接口极小。它最核心的两件事就是：

- `getInterface()`：我代表哪个服务接口
- `invoke(Invocation)`：请帮我执行这次调用

`Invoker.java:28` — `Invoker` 定义
`Invoker.java:44` — `invoke(Invocation)`

这看起来非常朴素，但正因为它极小，Provider 和 Consumer 两边都能收敛到它身上。

### 5.2 Provider 侧：本地对象先变成 `Invoker`

Provider 侧已经有现成的 Java 实现对象 `ref`。`ProxyFactory.getInvoker(ref, interface, url)` 会把它包装成一个 `AbstractProxyInvoker` 子类。

`ProxyFactory.java:60` — `getInvoker()`
`AbstractProxyInvoker.java:42` — provider-side proxy invoker 定位

这个 `Invoker` 的职责不是自己理解网络，不是自己理解注册中心，而是把一个统一的 `Invocation` 再翻译回真实对象方法调用。

### 5.3 Consumer 侧：远程入口也先变成 `Invoker`

Consumer 侧没有本地实现对象，只有接口、URL 或 registry 信息。`Protocol.refer()` 返回的不是代理，而是协议实现自己的远程 `Invoker`。

`Protocol.java:85` — `refer()`
`DubboProtocol.java:451` — `protocolBindingRefer()`
`DubboInvoker.java:90` — `doInvoke()`

也就是说，Consumer 侧先把“远程服务”包装成一个统一调用体，后面代理、过滤器、集群逻辑都只需要面对这个统一调用体。

### 5.4 为什么不是 `Protocol` 做窄腰

如果让 `Protocol` 直接成为所有横切能力的中心，会有两个问题：

1. `Protocol` 太靠下，它同时要面对协议实现差异（dubbo、triple、injvm）。  
2. Java 对象代理、过滤器、目录、集群这些上层机制，并不应该理解每个具体协议。

让所有上层都只面对 `Invoker.invoke()`，再让不同协议各自实现“如何把 invoke 送出去 / 如何把远程服务变成 invoker”，就把“调用语义”和“协议语义”拆开了。

## 六、`Protocol` 与 `Exporter`：桥接和登记，不是全部真相

### 6.1 `Protocol` 负责双向桥接

`Protocol` 的职责不是“发请求”这么简单，而是双向桥接：

- `export(Invoker)`：把 provider invoker 暴露成可接收远程调用的服务。  
- `refer(Class, URL)`：把某个远程服务引用成 consumer 侧可调用的 Invoker。

`Protocol.java:69` — `export()`
`Protocol.java:85` — `refer()`

它统一的是边界，而不是统一所有行为。不同协议实现（Dubbo2、Triple、Injvm）都可以有自己的远程细节，但在 export/refer 这一层对外暴露同一套抽象。

### 6.2 `Exporter` 是导出后的服务句柄

`Exporter` 的接口很小：`getInvoker()` 和 `unexport()`。

`Exporter.java:26` — `Exporter` 定义
`Exporter.java:33` — `getInvoker()`
`Exporter.java:42` — `unexport()`

这已经说明它的角色不是执行器，而是句柄：

- 协议层用它来登记已导出的服务。  
- 请求进来时先按 service key 找到它。  
- 再从它那里拿到真正的 `Invoker` 去执行业务。  

### 6.3 provider 侧真正的执行落点

在 `DubboProtocol.requestHandler.reply()` 中，请求进来后，协议层会：

1. 从消息里解析出 `Invocation`  
2. 用 `serviceKey` 找到对应 `DubboExporter`  
3. 调用 `exporter.getInvoker().invoke(invocation)`

`DubboProtocol.java:318` — 根据 service key 查 exporter
`DubboProtocol.java:331` — `exporter.getInvoker().invoke(inv)`

所以 Exporter 的真正地位是“协议层的索引项”，Invoker 才是“执行体”。

## 七、`ProxyFactory`：为什么要负责双向变形

### 7.1 Consumer 侧：`Invoker -> proxy`

Consumer 侧最终拿给业务代码的是 Java 接口代理，而不是 Invoker。`ProxyFactory.getProxy(invoker)` 完成这一步。

`ProxyFactory.java:38` — `getProxy()`
`JdkProxyFactory.java:35` — JDK proxy 版本
`JavassistProxyFactory.java:44` — Javassist proxy 版本

### 7.2 Provider 侧：`ref -> Invoker`

Provider 侧恰好反过来，要把已经存在的 Java 对象 `ref` 变成 Invoker。

`JavassistProxyFactory.java:80` — provider `getInvoker(ref, type, url)`
`JdkProxyFactory.java:41` — provider 侧另一实现

这说明 `ProxyFactory` 不是“只管 consumer 代理”，而是负责对象世界和 Invoker 世界的双向边界。

### 7.3 为什么这一步必须和 `Protocol` 分开

如果让 `Protocol` 既负责对象代理，又负责网络引用，那么协议层就必须直接理解 Java 对象、反射调用、代理方式、特殊方法（`toString()`、`$destroy`）等语言层细节。

Dubbo 把这些职责拆开，让 `Protocol` 只关心 export/refer，`ProxyFactory` 只关心对象/Invoker 转换，边界更清楚，也更容易扩展不同协议和不同代理实现。

## 八、`InvokerInvocationHandler`：代理真正是怎么落到 `invoker.invoke()` 的

### 8.1 代理不是魔法

Consumer 侧业务代码看起来像在调普通 Java 接口：

```java
demoService.sayHello("world")
```

但代理收到这个方法调用后，不是直接跑远程逻辑，而是先进入 `InvokerInvocationHandler`。

`InvokerInvocationHandler.java:50` — handler 入口

### 8.2 方法调用先变成 `RpcInvocation`

`InvokerInvocationHandler.invoke()` 会先处理一些特殊方法（比如 `Object` 的方法、`toString()`、`$destroy`）。普通业务方法则会被组装成 `RpcInvocation`，再交给 `InvocationUtil.invoke(...)`。

`InvokerInvocationHandler.java:69` — 组装 `RpcInvocation`
`InvokerInvocationHandler.java:81` — 进入 `invoker.invoke(...)`

### 8.3 这里要切开的一个边界

这里特别容易让新读者混淆两个时刻：

- **拿到 proxy**：只是 consumer 入口已经准备好了。  
- **proxy 上的方法真正被调用**：这时才会通过 invocation handler 进入 Dubbo 的统一调用链。  

所以“拿到代理”不等于“已经发出远程调用”，更不等于“已经连上远端”。它只说明后续每次方法调用，都知道该往哪条 Invoker 链里送。

## 九、`ProtocolFilterWrapper` / `ProtocolListenerWrapper`：不改协议也能改运行链

这里先做一个路标。前面几节讲的是五个核心角色本身；这一节讲的是一个更关键的设计：**为什么 Dubbo 可以在不修改具体协议实现的前提下，把 filter 和 listener 织进整条运行链。**

### 9.1 `ProtocolFilterWrapper`：在 export/refer 边界包一层 invoker 链

`ProtocolFilterWrapper` 包着一个已经存在的 `Protocol`。它不实现新协议，只是拦在 `export()` 和 `refer()` 两个边界上：

- provider 侧 `export(invoker)` 之前，先把 provider invoker 包成 filter chain。  
- consumer 侧 `refer()` 之后，再把 remote invoker 包成 reference filter chain。  

`ProtocolFilterWrapper.java:53` — provider export 侧包 filter
`ProtocolFilterWrapper.java:67` — consumer refer 侧包 filter

这就是为什么 filter 不需要写进 `DubboProtocol`、`TripleProtocol` 等协议内部。协议只认 invoker；wrapper 负责把 invoker 变成“带着 filter 的 invoker”。

### 9.2 Filter chain 的节点本身还是 `Invoker`

这层设计更妙的地方在于：filter chain 里的每个节点，本身依然表现成 `Invoker`。也就是说，filter 不是一个单独的 side structure，而是把一层层 filter 包成一层层 invoker。

`FilterChainBuilder.java:92` — filter chain 以 invoker 为节点
`DefaultFilterChainBuilder.java:68` — 倒序包裹 invoker 链

所以无论 provider 还是 consumer，最终下游协议看到的依然只是一个普通 `Invoker`。这就是窄腰抽象真正的威力：**横切逻辑不需要改变下游眼中的对象类型。**

### 9.3 `ProtocolListenerWrapper`：给 export/refer 加生命周期监听

`ProtocolListenerWrapper` 的思路和 filter wrapper 类似：它也不改协议语义，只是在 `export()` 和 `refer()` 的结果外面加一层 listener wrapper。

`ProtocolListenerWrapper.java:64` — export 侧 listener wrapper
`ProtocolListenerWrapper.java:86` — refer 侧 listener wrapper

于是 provider 导出时可以触发 exported/unexported 监听，consumer 引用时可以触发 referred/destroyed 监听。它同样遵守一个原则：**不改协议实现本身，只改边界对象。**

### 9.4 为什么 wrapper 会跳过 registry URL

两个 wrapper 都刻意跳过 registry URL。原因很简单：它们针对的是 RPC 调用面，而不是注册中心协调层。registry protocol 本身属于“主线外面的协调壳”，不应该在这里被混进实例级 filter 或 listener 语义。

这也是为什么本文先立住窄腰，再讲 registry / cluster / directory，会更清楚。

## 十、具体协议如何落地这条抽象链

### 10.1 provider 侧：`DubboProtocol.export()` 到 `requestHandler.reply()`

具体协议需要证明这套抽象不是空转的。`DubboProtocol.export()` 会创建 `DubboExporter`，并把它放进 `exporterMap`。

`DubboProtocol.java:346` — `DubboProtocol.export()`
`DubboExporter.java:34` — exporter 构造时登记

请求真正进来时，`requestHandler.reply()` 根据 service key 查 exporter，再取 invoker 执行。

`DubboProtocol.java:318` — 查 exporter
`DubboProtocol.java:331` — `exporter.getInvoker().invoke(...)`

### 10.2 consumer 侧：`DubboProtocol.refer()` 到 `DubboInvoker.doInvoke()`

consumer 侧 `Protocol.refer()` 最终会创建 `DubboInvoker`。这是具体协议对“远程调用入口”这一抽象的实现。

`DubboProtocol.java:451` — `protocolBindingRefer()`
`DubboInvoker.java:90` — `doInvoke()`

`DubboInvoker.doInvoke()` 会补齐 path/version，选择 client，组装 request，然后根据 one-way / two-way 的语义分别走 `send()` 或 `request()`。

这一步证明：**协议层真正关心的是怎么实现一个远程 Invoker，而不是怎么给业务代码造代理。**

## 十一、误解澄清

### 误解一：`Invoker` 只存在于 consumer 侧

不是。Provider 侧 `AbstractProxyInvoker` 和 Consumer 侧 `AbstractInvoker` 都实现同一个 `Invoker` 窄腰，只是一个把本地对象包装进去，一个把远程调用包装进去。

### 误解二：`Protocol` 才是 Dubbo 最核心的中心

也不是。`Protocol` 很重要，但真正让 filter、listener、proxy、cluster、directory 可以统一拼装的，是 `Invoker.invoke()` 这个共同调用面。

### 误解三：`Exporter` 会负责执行业务逻辑

不是。`Exporter` 更像导出后的注册项。执行时仍然要从 `Exporter` 里拿出 `Invoker`，真正跑的是 `invoker.invoke(...)`。

### 误解四：Filter 是协议内部流程的一部分

不是。Filter 是在 `Protocol.export()/refer()` 边界外把 invoker 包成链，具体协议实现完全可以不知道 filter 的存在。

### 误解五：拿到 proxy，就等于已经完成一次远程连接

也不是。proxy 只是 consumer 本地入口对象。真正的远程调用要等业务代码后续调方法，才通过 `InvokerInvocationHandler` 进入 `invoker.invoke(...)` 链。

## 十二、收网总结：先记住这条窄腰，再去看后面的目录、路由和集群

回到开头的问题：为什么 Dubbo 要绕这么一圈？

因为它要把“本地对象”和“远程服务”统一压成同一种可组合调用体，再让协议、过滤器、监听器、集群和目录在这条统一调用体上继续拼接。如果没有 `Invoker` 这条窄腰，provider 与 consumer 两边的逻辑会直接裂开，后续所有横切能力都得理解每个具体协议的细节。

所以这一篇真正应该记住的，不是五个抽象名词，而是这条关系：

- `Invoker` 是窄腰。  
- `Protocol` 负责暴露和引用这个窄腰。  
- `ProxyFactory` 负责 Java 对象和窄腰之间的双向变形。  
- `Exporter` 负责 provider 侧导出后的登记与查找。  
- `Filter` / `Listener` 通过 wrapper 在边界外把横切逻辑织进窄腰。  

**三句话总结：**

1. Dubbo 的真正窄腰不是 `Protocol`，而是 `Invoker.invoke()` 这一条统一调用面。  
2. Provider 和 Consumer 两边都围绕 `Invoker` 收敛：一边把对象变成 Invoker，一边把 Invoker 变成对象。  
3. 后续的 registry、directory、router、loadbalance、cluster 和 remoting 都是在这条窄腰之上继续展开，而不是取代它。  

**下篇预告：** 下一篇进入 `Directory、Router、LoadBalance、Cluster` consumer 流量主线，看 consumer 侧怎样从一组 provider 中选出这一次真正要调用的目标。