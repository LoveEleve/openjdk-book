# Dubbo：ServiceConfig、ReferenceConfig 与 export/refer 主线

> 基于 Apache Dubbo 3.3.7-SNAPSHOT

## 一、困惑开场：服务怎么暴露，引用怎么变成代理

如果你第一次接触 Dubbo，最自然的使用方式可能是：provider 写一个实现类，加一个 `@DubboService`；consumer 写一个接口，加一个 `@DubboReference`。代码看起来很轻，但源码背后其实发生了两次复杂的对象变形。

provider 手里原本只有一个 Java 对象。这个对象怎么变成一个能接收远程 `Invocation` 的运行时入口？它什么时候开始监听端口？什么时候注册到注册中心？

consumer 手里原本只有一个接口类型。这个接口怎么变成一个可以直接调用的 Java 代理？代理背后到底是地址、连接、Invoker，还是注册中心订阅？

如果只按注解或配置对象去看，Dubbo 会显得像“魔法”。但把源码压成两条链，事情就清楚了：

```text
provider：ref -> Invoker -> Exporter
consumer：URL / Registry -> Invoker -> Proxy
```

这两条链的共同中间层是 `Invoker`。provider 把本地实现对象包装成 Invoker，再交给 Protocol 暴露；consumer 从直连 URL、injvm 或 registry 入口拿到 Invoker，再交给 ProxyFactory 生成 Java 代理。

## 二、前情回顾：先建立 Dubbo 的用户入口

这是 Dubbo 源码分析的第一篇，所以不要求读者先懂 SPI、Directory、Router 或 Triple。我们只从用户最容易理解的两个问题出发：服务怎么被暴露，引用怎么被拿到。

这里要先把边界收紧：**这篇不是要把 Dubbo 讲完，而是只解决一个读者入口问题——配置对象如何进入运行时。**

Dubbo 的复杂度不会一开始全部展开。本文先只建立两个入口对象：`ServiceConfig` 负责 provider export，`ReferenceConfig` 负责 consumer refer。`DubboBootstrap` 和 `DefaultModuleDeployer` 只作为启动时间线出现，确保读者知道这些入口是什么时候被触发。

后面再分别展开：`Invoker/Protocol/Exporter/Proxy/Filter` 的窄腰，Directory/Router/LoadBalance/Cluster 的流量主线，以及 remoting 和具体协议实现。也就是说，本文先只回答“怎么从配置态跨进运行态”，暂时不回答“运行态内部如何继续流动”。

## 三、先走三条失败的路

### 失败方案一：ServiceConfig 和 ReferenceConfig 只是配置 bean

如果把它们当成普通配置 bean，你会以为真正的运行时逻辑应该藏在某个“核心工厂”里，而 `ServiceConfig` 只是保存 interface、ref、protocol 等字段，`ReferenceConfig` 只是保存 interface、registry、url 等字段。

但 provider 启动时，`DefaultModuleDeployer.exportServices()` 会遍历 `ServiceConfig`，最终调用 `ServiceConfig.export()`；consumer 启动或首次获取代理时，`ReferenceConfig.get()` 会进入 `init()` 和 `createProxy()`。

这说明两个对象不是被动配置，而是配置态进入运行态的总闸门。它们决定什么时候刷新配置、什么时候构造 URL、什么时候创建 Invoker、什么时候交给 Protocol。

### 失败方案二：provider 和 consumer 是完全对称的

看起来 provider 和 consumer 似乎只是“一个 export，一个 refer”，可以把其中一边反过来就理解另一边。

实际不是。

provider 已经拥有一个本地实现对象 `ref`，它要做的是：

```text
ref -> ProxyFactory.getInvoker() -> Invoker -> Protocol.export() -> Exporter
```

consumer 一开始没有实现对象，只有接口、URL 或 registry。它要做的是：

```text
URL / Registry -> Protocol.refer() -> Invoker -> ProxyFactory.getProxy() -> ref
```

两条链共享 Invoker，但起点和终点相反。provider 把对象变成调用入口，consumer 把调用入口变回对象代理。

### 失败方案三：注册中心就是 Dubbo 主线的中心

注册中心当然重要，但它不是第一篇应该建立的骨架。

如果一开始就把 Dubbo 理解成“provider 注册到 registry，consumer 从 registry 拉地址”，你会错过三个更基础的抽象：

- `Protocol` 负责 export/refer
- `Invoker` 负责统一调用
- `ProxyFactory` 负责 Java 对象和 Invoker 的互相转换

`RegistryProtocol` 更像插在 Protocol 外面的协调壳：provider 侧它组织“底层协议本地导出 + registry.register”；consumer 侧它组织“registry 订阅 + directory + cluster.join”。

所以第一篇先把对象变形链立住，registry 的深层目录和路由逻辑放到后续文章。

## 四、最小总图：两条对象变形链

先建立整篇文章的总图。

```text
DubboBootstrap
    ↓
DefaultModuleDeployer
    ├─ exportServices()
    │    ↓
    │  ServiceConfig.export()
    │    ↓
    │  provider URL
    │    ↓
    │  ref -> ProxyFactory.getInvoker()
    │    ↓
    │  Invoker -> Protocol.export()
    │    ↓
    │  Exporter / registry register
    │
    └─ referServices()
         ↓
       ReferenceConfig.get()
         ↓
       URL / Registry / injvm
         ↓
       Protocol.refer()
         ↓
       Invoker
         ↓
       ProxyFactory.getProxy()
         ↓
       Java interface proxy
```

这里有三个关键角色：

- **配置入口**：`ServiceConfig` / `ReferenceConfig` 把配置态推进到运行态。
- **统一调用体**：`Invoker` 把本地对象和远程调用都抽象成统一的 `invoke()` 入口。
- **边界转换器**：`Protocol` 负责暴露/引用，`ProxyFactory` 负责对象/Invoker 转换。

还要再钉死一个最容易混淆的点：Provider 和 Consumer 两条链都围绕 `Invoker` 展开，但它们不是镜像对称的执行流程。

- Provider 是“我已经有对象了，怎么把它变成可被远程调用的入口”。  
- Consumer 是“我只有接口和配置，怎么把远程调用入口重新变回一个本地可调用对象”。

所以同样看到 `Invoker`，两边问的问题并不一样：一边是在做暴露，一边是在做代理生成。

## 五、启动时间线：DubboBootstrap 什么时候触发 export/refer

### 5.1 Bootstrap 不是 export/refer 的全部实现

`DubboBootstrap.start()` 是用户看到的启动入口，但它不会自己把所有 provider 和 reference 一个个处理完。真正负责模块级启动顺序的是 `DefaultModuleDeployer`。

`DubboBootstrap.java:229` — `DubboBootstrap.start()` 委托 deployer
`DefaultModuleDeployer.java:162` — `startSync()`

启动时间线大致是：

```text
DubboBootstrap.start()
    ↓
DefaultModuleDeployer.startSync()
    ↓
exportServices()
    ↓
referServices()
```

`DefaultModuleDeployer.java:176` — `exportServices()`
`DefaultModuleDeployer.java:186` — `referServices()`

这一步对读者很重要：`ServiceConfig` 和 `ReferenceConfig` 不是随机在业务代码某个时刻被调用，而是会被模块部署器纳入统一生命周期。

### 5.2 provider 与 consumer 的启动顺序

provider 侧，`exportServices()` 遍历配置管理器中的 `ServiceConfigBase`，调用 `ServiceConfig.export()`。

consumer 侧，`referServices()` 遍历 `ReferenceConfigBase`。如果引用需要初始化，就通过 reference cache 触发 `ReferenceConfig.get()`。

因此第一篇不应该从 `ServiceConfig.export()` 单独开讲，而应该先把它放回 `DefaultModuleDeployer` 的时间线里：export/refer 是应用模块启动阶段的两条分支。

## 六、Provider 主线：ServiceConfig 如何把 ref 暴露出去

### 6.1 `ServiceConfig.export()` 是配置态转运行态的总闸门

`ServiceConfig.export()` 先确保 scope/deployer 已启动，再刷新配置，判断是否应该 export、是否有 delay，最后进入 `doExport()`。

`ServiceConfig.java:324` — `export()` 入口
`ServiceConfig.java:356` — `doExport()`

这几个判断说明 export 不是简单的“调用一次就打开端口”：

- 服务可能被 scope 配置禁止 export
- export 可能被 delay 推迟
- 配置需要在真正运行前 refresh
- 导出状态需要被记录，避免重复导出

### 6.2 `doExport()` 先进入 URL 世界

`doExport()` 会补默认的 `path=interfaceName`，再进入 `doExportUrls()`。

`ServiceConfig.java:566` — `doExport()`

`doExportUrls()` 先把服务接口注册进 `ModuleServiceRepository`，创建 `ProviderModel`，再加载 registry 列表，最后按照每个 `ProtocolConfig` 进行导出。

`ServiceConfig.java:582` — `doExportUrls()`
`ServiceConfig.java:596` — provider model / service repository
`ServiceConfig.java:610` — 加载 registry
`ServiceConfig.java:622` — 按 protocol 导出

这一步的意义是：Dubbo 不直接拿着配置对象往 Protocol 里塞，而是先把配置折叠成统一的 URL 模型。

### 6.3 配置对象如何折叠成 provider URL

`doExportUrlsFor1Protocol()` 会汇总 application、module、provider、protocol、service、method 等多层参数，再通过 `buildUrl()` 创建 provider URL。

`ServiceConfig.java:628` — `doExportUrlsFor1Protocol()`
`ServiceConfig.java:835` — `buildUrl()`

最终创建的是 `ServiceConfigURL`，并挂上 `scopeModel`、`providerModel` 等模型引用。

`ServiceConfig.java:854` — 创建 `ServiceConfigURL`
`ServiceConfig.java:870` — 挂接 scope/provider model

所以 Dubbo 的 URL 不只是字符串。它同时承载：

- 协议、host、port、path
- 超时、线程、序列化等参数
- scope model
- provider model

### 6.4 local 与 remote：为什么默认还会 exportLocal

`exportUrl()` 会先处理 scope。默认情况下，Dubbo 会先导出一份 injvm 本地服务，再决定是否导出 remote。

`ServiceConfig.java:875` — `exportUrl()` scope 分支
`ServiceConfig.java:881` — local export
`ServiceConfig.java:1000` — export local / remote

这不是重复打开端口。injvm export 的目的，是让同一 JVM 内的 consumer 可以直接复用本地 Invoker，避免绕一圈网络。

### 6.5 `ref -> Invoker -> Protocol.export()`

`doExportUrl()` 是 provider 对象变形的核心位置：

1. 读取业务实现对象 `ref`
2. 通过 `ProxyFactory.getInvoker(ref, interfaceClass, url)` 把它包装成 Invoker
3. 通过 `Protocol.export(invoker)` 暴露出去

`ServiceConfig.java:978` — `doExportUrl()`
`ServiceConfig.java:988` — `ProxyFactory.getInvoker(ref, interfaceClass, url)`
`ServiceConfig.java:992` — `protocolSPI.export(invoker)`

provider 真正暴露出去的不是原始业务对象，而是一个能接收 `Invocation`、再把调用转回业务对象的统一入口。

## 七、RegistryProtocol：本地导出与注册中心注册的协调壳

### 7.1 provider URL 和 registry URL 不是同一个东西

当配置了 registry 时，`ServiceConfig.exportRemote()` 会把 provider URL 放进 registry URL 的 `EXPORT_KEY` attribute，再把这个 registry URL 交给自适应 Protocol。

`ServiceConfig.java:928` — registry URL 处理
`ServiceConfig.java:961` — provider URL 放入 `EXPORT_KEY`

因此传进 `Protocol.export()` 的不一定是“真正监听端口的 provider URL”，而可能是一个带有内嵌 export 信息的 registry URL。

### 7.2 `RegistryProtocol.export()` 做两件事

当自适应协议命中 registry protocol 后，`RegistryProtocol.export()` 会拆出 registry URL 和 provider URL，然后分两步做事：

1. `doLocalExport()` 调用底层真实协议，把 Invoker 导出成真正的 Exporter。
2. `registry.register()` 把 provider URL 注册到注册中心。

`RegistryProtocol.java:272` — `RegistryProtocol.export()`
`RegistryProtocol.java:290` — 取 registry/provider URL
`RegistryProtocol.java:293` — 本地导出
`RegistryProtocol.java:298` — 注册中心注册
`RegistryProtocol.java:352` — `doLocalExport()`

所以 registry protocol 不是替代底层协议，而是在底层 export 旁边增加注册中心行为。

### 7.3 export 完成不等于立刻“对外可发现”

这里必须把一个最容易误解的边界压实：`export()` 完成，不等于“provider 已经在所有外部 consumer 眼里可发现”。

Dubbo 3.x 的 export 过程还会受到 `RegisterTypeEnum` 影响。某些模式会把“本地 export”和“register 到 registry”拆成不同阶段。

对读者来说，先记住这两个动作的职责差别：

- **export**：让本地运行时具备接收调用的能力，也就是端口、协议和 Invoker 这一侧准备好了。  
- **register**：让外部 consumer 能发现这个 provider，也就是注册中心那一侧的可见性准备好了。

两者相关，但不是同一动作，更不是同一时刻完成的动作。线上看到“服务已经 export 了，为什么 consumer 还发现不到”，首先就该怀疑 register/registry 可见性，而不是马上怀疑 export 本身失败。

## 八、Consumer 主线：ReferenceConfig 如何得到代理

### 8.1 `ReferenceConfig.get()` 是 consumer 入口

consumer 侧拿代理的入口是 `ReferenceConfig.get()`。如果 `ref` 还没有创建，它会先确保 deployer 已启动，再进入 `init()`。

`ReferenceConfig.java:230` — `get()` 入口
`ReferenceConfig.java:235` — 确保 deployer 启动
`ReferenceConfig.java:244` — 进入 `init()`

这里的 `ref` 指的是最终交给业务代码的 Java 代理，不是 Invoker。

### 8.2 `init()` 把引用配置变成运行时对象

`init()` 会刷新配置，初始化 service metadata，创建 ConsumerModel，然后调用 `createProxy()`。

`ReferenceConfig.java:332` — `init()`
`ReferenceConfig.java:355` — service metadata
`ReferenceConfig.java:366` — ConsumerModel
`ReferenceConfig.java:383` — `createProxy()`

这一步对应 provider 侧的 `ServiceConfig.export()`：都是把配置态转成运行态，只是 provider 走 export，consumer 走 refer/proxy。

### 8.3 `createProxy()` 先收集 URL，再创建 Invoker

`createProxy()` 会先处理显式直连 URL；如果没有直连 URL，就从 registry 聚合；然后进入 `createInvoker()`，最后调用 `ProxyFactory.getProxy(invoker)`。

`ReferenceConfig.java:490` — `createProxy()`
`ReferenceConfig.java:495` — URL 聚合
`ReferenceConfig.java:500` — 创建 Invoker
`ReferenceConfig.java:502` — 生成 Proxy

consumer 的对象变形链是：

```text
interface/config
    ↓
URL / Registry / injvm
    ↓
Protocol.refer()
    ↓
Invoker
    ↓
ProxyFactory.getProxy()
    ↓
Java interface proxy
```

这里还要切开两个容易混在一起的时刻：

- **创建代理**：发生在 `ReferenceConfig.get()/init()/createProxy()` 这一阶段，目的是把“接口 + 配置”变成一个本地可调用对象。  
- **代理后续真正发起远程调用**：发生在业务代码 later 调 `proxy.someMethod()` 时，此时才会通过 `InvokerInvocationHandler` 把方法调用包装成 `RpcInvocation` 再交给 `invoker.invoke(...)`。

也就是说，拿到 proxy 只是 consumer 入口准备好了，不代表这一次方法调用已经真的沿着 remoting/cluster/registry 全链路跑完。

### 8.4 injvm refer 是主线分叉，不是边角优化

`ReferenceConfig.shouldJvmRefer()` 会按优先级判断是否走 injvm：

- 显式 `injvm` 配置优先
- 指定直连 URL 时偏向 remote
- scope 配置继续参与判断
- 最后由 `InjvmProtocol.isInjvmRefer()` 判断同 JVM 是否已经有 provider

`ReferenceConfig.java:846` — `shouldJvmRefer()`
`ReferenceConfig.java:856` — 显式 injvm / url 判断
`ReferenceConfig.java:862` — `InjvmProtocol.isInjvmRefer()`

所以同一个 JVM 内，Dubbo 可能不经过 registry 和网络，而是直接从本地 Exporter 找到 provider Invoker。

## 九、RegistryProtocol.refer：consumer 如何接入目录和订阅

### 9.1 `Protocol.refer()` 命中 registry protocol

当 consumer URL 是 registry 风格时，`ReferenceConfig.createInvoker()` 最终会调用 `protocolSPI.refer(interfaceClass, curUrl)`。

`RegistryProtocol.refer()` 会把 registry URL 标准化，拿到 Registry，取出 `REFER_KEY` 中的 consumer 参数，再继续创建实际引用链。

`RegistryProtocol.java:557` — `RegistryProtocol.refer()`
`RegistryProtocol.java:565` — registry 标准化
`RegistryProtocol.java:574` — 获取 registry / refer 参数

### 9.2 从 registry 到 Directory，再到 Cluster

`doCreateInvoker()` 是 consumer registry refer 的关键：

1. 创建并配置 Directory
2. 将 Registry、Protocol 绑定到 Directory
3. 注册 consumer URL
4. 构建 router chain
5. 订阅 provider 地址与配置变化
6. `Cluster.join(directory, true)` 形成上层 Invoker

`RegistryProtocol.java:647` — `doCreateInvoker()`
`RegistryProtocol.java:649` — 设置 registry/protocol
`RegistryProtocol.java:662` — consumer register
`RegistryProtocol.java:666` — 构建 router chain
`RegistryProtocol.java:667` — `directory.subscribe(...)`
`RegistryProtocol.java:669` — `cluster.join(directory, true)`

这里先不要深入 Directory、Router、LoadBalance 的内部算法。首篇只要看懂：consumer 得到的 Invoker 不是一条固定地址，而是一个会随着 registry 更新、路由和 cluster 规则变化的运行时调用入口。

## 十、ProxyFactory：为什么业务代码最后拿到的是代理

provider 侧，`JavassistProxyFactory.getInvoker()` 把业务对象包装成 `AbstractProxyInvoker`；consumer 侧，`getProxy(invoker)` 把 Invoker 包成接口代理。

`JavassistProxyFactory.java:80` — provider `getInvoker(ref, interface, url)`
`JavassistProxyFactory.java:44` — consumer `getProxy(invoker)`

代理真正被调用时，`InvokerInvocationHandler.invoke()` 会把 Java 方法调用组装成 `RpcInvocation`，再交给 `invoker.invoke(...)`。

`InvokerInvocationHandler.java:50` — handler 入口
`InvokerInvocationHandler.java:69` — 组装 invocation
`InvokerInvocationHandler.java:81` — 进入 `invoker.invoke()`

于是 consumer 侧“看起来像本地接口调用”的代码，最终进入了 Dubbo 的统一 Invoker 世界。

## 十一、误解澄清

### 误解一：`ServiceConfig.export()` 就是直接打开端口

不完全是。它会经过 URL 组装、ProxyFactory、Protocol，并可能先 exportLocal，再由 RegistryProtocol 组织底层协议 export 和 registry register。

### 误解二：`ReferenceConfig.get()` 拿到的是 Invoker

不是。`ReferenceConfig.get()` 最终返回的是 Java 代理 `ref`，代理内部才持有 Invoker。

### 误解三：provider URL 和 registry URL 是同一个 URL

不是。Dubbo 经常把 provider URL 放进 registry URL 的 `EXPORT_KEY` attribute，再交给 RegistryProtocol 拆开处理。

### 误解四：consumer 只要从 registry 拿地址就结束了

不是。registry refer 还要接入 Directory、router、订阅和 Cluster，最终才形成可随 provider 列表变化的 Invoker。

### 误解五：consumer 拿到 proxy，就等于已经连上远端

也不是。proxy 只是本地入口对象，说明 `ReferenceConfig` 已经把配置态翻译成了可调用的 Java 代理。真正的远程调用、directory 更新、cluster 选择、过滤器链、remoting 编码发送，都是在后续每次方法调用时才继续发生。

## 十二、收网总结：先记住两条对象变形链

回到开头的问题：服务怎么暴露，引用怎么变成代理？

provider 侧，Dubbo 把已有的 Java 实现对象包装成统一 Invoker，再交给 Protocol export；如果有 registry，就由 RegistryProtocol 组织底层本地导出和注册中心注册。

consumer 侧，Dubbo 从直连 URL、injvm 或 registry 入口取得 Invoker，再通过 ProxyFactory 生成 Java 代理；如果来自 registry，Invoker 背后还会连接 Directory、订阅、路由和 Cluster。

真正应该记住的不是一串类名，而是两条链：

```text
provider：ref -> ProxyFactory.getInvoker() -> Invoker -> Protocol.export() -> Exporter
consumer：URL/Registry -> Protocol.refer() -> Invoker -> ProxyFactory.getProxy() -> ref
```

**三句话总结：**

1. `ServiceConfig` 与 `ReferenceConfig` 不是普通配置 bean，而是 provider export 和 consumer refer 的运行时入口。
2. `Invoker` 是 Dubbo 的统一调用窄腰：provider 把 `ref` 变成 Invoker，consumer 再把 Invoker 变回 Java proxy。
3. `RegistryProtocol` 把注册中心接到 Protocol 主线上，但没有替代 Protocol、Invoker、ProxyFactory 这条核心对象变形链。

**下篇预告：** 下一篇进入 `Invoker、Protocol、Exporter、Proxy 与 Filter` 窄腰，继续解释 Dubbo 如何把不同协议、代理和拦截器统一成一套调用模型。