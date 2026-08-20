# Dubbo：Invoker、Protocol、Exporter、Proxy 与 Filter 窄腰 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch06-dubbo-runtime`
- 篇：`02 Invoker、Protocol、Exporter、Proxy 与 Filter 窄腰`
- 对应主题：`D-MAIN-2 Dubbo Narrow Waist`
- 文章类型：主干运行时核心机制篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：第一篇已经把 Dubbo 的 export/refer 主线压成了两条对象变形链：provider `ref -> Invoker -> Exporter`，consumer `URL/Registry -> Invoker -> Proxy`。但读者仍然会卡在真正的核心问题上：为什么 Dubbo 非要发明 `Invoker` 这样一个看似抽象的中间层？`Protocol`、`Exporter`、`ProxyFactory` 和 `Filter` 分别在哪个边界起作用？为什么同一个 `Invoker` 既能代表 provider 的本地实现，也能代表 consumer 的远程调用入口？
- 一句话顿悟：Dubbo 的运行时窄腰不是 `Protocol`，而是 `Invoker`。provider 和 consumer 两边都先被统一压成 `Invoker.invoke()` 这一种调用形式；`Protocol` 只负责把 invoker 暴露出去或引用回来，`ProxyFactory` 只负责对象/Invoker 的相互变形，`Exporter` 只是“已暴露服务”的登记句柄，`Filter` 和 `InvokerListener` 则通过 wrapper 链在不改协议实现的前提下把横切逻辑织进 `Invoker` 链。理解了这一点，Dubbo 大量看似分散的抽象就会重新收束成一条线。
- 文章边界：本篇重点讲 `Invoker`、`Protocol`、`Exporter`、`ProxyFactory`、`Filter` 这组窄腰抽象，以及 `ProtocolFilterWrapper`、`ProtocolListenerWrapper` 如何在 export/refer 边界改写运行链；只点到 `DubboProtocol` 的 provider request 入口和 `DubboInvoker` 的 consumer request 出口，用它们证明抽象如何落地；不展开 `Directory/Router/LoadBalance/Cluster`、registry 订阅、remoting/codec/dispatcher 的细节。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/01-serviceconfig-referenceconfig-export-refer.md`：已经知道 export/refer 两条对象变形链和 `ServiceConfig` / `ReferenceConfig` 入口。

### SOFT

- 不要求先懂 registry / cluster / remoting 的具体实现。
- 不要求先懂 Dubbo SPI 的代码生成细节。

### NAV

- 后续可接：`Directory、Router、LoadBalance、Cluster consumer 流量主线`
- 后续可接：`Remoting、Exchange、Dispatcher 与网络/线程派发`
- 后续可接：`ExtensionLoader、Adaptive 与 Dubbo SPI 机制`

## 一句话困惑

为什么 Dubbo 要围绕 `Invoker` 搭一整套 `Protocol`、`Exporter`、`ProxyFactory`、`Filter` 抽象？它们各自管什么边界，怎么一起组成 provider 和 consumer 的统一运行链？

## 一句话顿悟

Dubbo 用 `Invoker` 统一“可调用服务体”，把 provider 本地实现和 consumer 远程入口都压成同一种 `invoke()` 形式；`Protocol.export()/refer()` 只负责暴露和引用这个统一调用体，`ProxyFactory` 负责 Java 对象视图和 `Invoker` 视图之间的相互变形，`Exporter` 负责 provider 侧已暴露服务的登记与查找，`Filter`/`Listener` 通过 wrapper 在 `Protocol` 边界外织入横切逻辑。因此 Dubbo 的核心不是某个协议实现，而是围绕 `Invoker` 建起来的一条可组合调用链。

## 读者理解路径

1. 先否定“`Protocol` 才是 Dubbo 真正中心”这种直觉。
2. 建立最小总图：provider `ref -> AbstractProxyInvoker -> filter chain -> Protocol.export -> ExporterMap`；consumer `Protocol.refer -> remote Invoker -> filter/listener wrappers -> proxy -> invocation handler -> invoker.invoke()`。
3. 解释 `Invoker` 为什么是窄腰：provider 和 consumer 都围绕它收敛。
4. 解释 `Protocol` 负责什么，不负责什么。
5. 解释 `Exporter` 为什么只是句柄/登记项，而不是执行者。
6. 解释 `ProxyFactory` 的双向变形职责。
7. 解释 `ProtocolFilterWrapper` / `ProtocolListenerWrapper` 如何不改协议实现却重塑运行链。
8. 用 `DubboProtocol.requestHandler.reply()` 和 `DubboInvoker.doInvoke()` 证明抽象最终如何落地。
9. 收束到：后续的 Directory/Cluster、registry、remoting 都是在这条窄腰之上继续展开，而不是替代它。

## 失败方案推演

### 失败方案一：Dubbo 的核心是 `Protocol`

- 这会把 Dubbo 误写成“协议框架”。
- 但 `Protocol` 只定义 `export()` / `refer()`，真正统一 provider/consumer 两边调用语义的是 `Invoker.invoke()`。
- Filter、Listener、Cluster、Directory 包装的也都是 `Invoker`，不是 `Protocol`。
- 所以 `Protocol` 是窄腰外侧的桥，不是最窄的腰本身。

### 失败方案二：`Exporter` 会负责执行业务逻辑

- 这会把 `Exporter` 写成 handler。
- 实际上 `Exporter` 只是“已导出服务”的句柄，真正执行时还是 `exporter.getInvoker().invoke(...)`。
- `DubboProtocol` 查表拿 `Exporter`，目的只是通过 service key 找到真正的 `Invoker`。
- 所以 `Exporter` 更像注册项，不是执行器。

### 失败方案三：Filter 是协议内部逻辑的一部分

- 这会错过 `ProtocolFilterWrapper` 的设计。
- 具体协议实现完全可以不知道 filter 存在，filter 链是在 `export()` / `refer()` 边界把 invoker 包起来的。
- 所以 filter 是 “围绕 invoker 的横切链”，不是某个协议实现自带的固定流程。

## 必须澄清的误解

1. `Invoker` 不是只存在于 consumer 侧，provider 和 consumer 两边都围绕它收敛。
2. `Protocol` 不直接等于“发请求的人”，它返回/消费的是 `Invoker`。
3. `Exporter` 不是业务执行器，而是导出后可按 service key 查找的登记句柄。
4. `ProxyFactory.getProxy()` 生成的是 Java 代理，真正的 RPC 调用体仍然是背后的 `Invoker`。
5. `Filter` 不在协议实现内部硬编码，而是在 wrapper 边界拼进 invoker 链。

## 文章结构与字数预算

1. 困惑开场：为什么 Dubbo 需要一条“看起来很抽象”的窄腰（800-1000 字）
2. 最小总图：provider / consumer 两侧如何围绕 `Invoker` 收敛（1000-1400 字）
3. `Invoker`：为什么它是 Dubbo 真正的窄腰（1400-2000 字）
4. `Protocol` / `Exporter`：暴露、引用与登记的边界（1400-2000 字）
5. `ProxyFactory`：对象与 Invoker 的双向变形（1200-1600 字）
6. `ProtocolFilterWrapper` / `ProtocolListenerWrapper`：不改协议也能改运行链（1600-2200 字）
7. `DubboProtocol` / `DubboInvoker`：抽象如何落地（1400-1800 字）
8. 收网总结：为什么后续 cluster/remoting 都建立在这条窄腰之上（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### Invoker / Protocol / Exporter / Proxy
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/Invoker.java:28` — `Invoker` 定义
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/Invoker.java:44` — `invoke(Invocation)`
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/Protocol.java:33` — protocol 文档：`refer()` 返回对象被调用时，协议执行 `export()` 收到的 invoker
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/Protocol.java:69` — `export()`
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/Protocol.java:85` — `refer()`
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/Exporter.java:26` — `Exporter` 定义
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/ProxyFactory.java:38` — `getProxy()`
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/ProxyFactory.java:60` — `getInvoker()`

### provider / consumer implementation
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/proxy/AbstractProxyInvoker.java:42` — provider-side proxy invoker 定位
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/proxy/AbstractProxyInvoker.java:100` — provider invoke 统一结果包装
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/protocol/AbstractInvoker.java:60` — consumer-side abstract invoker 定位
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/protocol/AbstractInvoker.java:174` — consumer invoke 主线
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/proxy/InvokerInvocationHandler.java:50` — Java proxy invocation handler
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/proxy/InvokerInvocationHandler.java:69` — 组装 `RpcInvocation`
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/proxy/InvokerInvocationHandler.java:81` — 进入 `invoker.invoke(...)`

### wrappers / filter / listener
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/Filter.java:23` — Filter 文档
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/Filter.java:31` — Filter 语义
- `dubbo-rpc/dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/filter/ProtocolFilterWrapper.java:53` — provider export 侧包 filter
- `dubbo-rpc/dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/filter/ProtocolFilterWrapper.java:67` — consumer refer 侧包 filter
- `dubbo-rpc/dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/filter/FilterChainBuilder.java:92` — filter chain 以 invoker 为节点
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/protocol/ProtocolListenerWrapper.java:64` — export 侧 listener wrapper
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/protocol/ProtocolListenerWrapper.java:86` — refer 侧 listener wrapper

### concrete protocol proof
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboProtocol.java:346` — `DubboProtocol.export()`
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboProtocol.java:318` — provider request handler 查 exporter
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboProtocol.java:331` — `exporter.getInvoker().invoke(...)`
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboProtocol.java:451` — `protocolBindingRefer()`
- `dubbo-rpc/dubbo-rpc-dubbo/src/main/java/org/apache/dubbo/rpc/protocol/dubbo/DubboInvoker.java:90` — `doInvoke()`

## 测试证据清单

- `dubbo-rpc/dubbo-cluster/src/test/java/org/apache/dubbo/rpc/cluster/filter/DefaultFilterChainBuilderTest.java:52` — provider/reference filter chain 构建
- `dubbo-rpc/dubbo-rpc-api/src/test/java/org/apache/dubbo/rpc/protocol/ProtocolListenerWrapperTest.java:57` — refer 返回 `ListenerInvokerWrapper`
- `dubbo-rpc/dubbo-rpc-api/src/test/java/org/apache/dubbo/rpc/proxy/InvokerInvocationHandlerTest.java:45` — proxy invocation handler 特殊方法分支

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇重点放在 rpc-api 窄腰抽象和 dubbo 协议最小落地点，不展开 triple/dubbo2 差异对比。
- 本篇默认 `ProtocolFilterWrapper` 使用当前 3.x filter chain builder，不回头兼容 2.x 旧模型。

## 与其他篇的边界

### 本篇要讲清

- `Invoker` 为什么是 Dubbo 的窄腰。
- `Protocol` 与 `Exporter` 的职责边界。
- `ProxyFactory` 的双向变形职责。
- `ProtocolFilterWrapper` / `ProtocolListenerWrapper` 如何重塑运行链。
- 具体协议如何把这套抽象落地。

### 本篇不深讲

- registry / directory / router / loadbalance / cluster（下一篇）。
- remoting / exchange / codec / dispatcher（后续 remoting 篇）。
- SPI/adaptive 生成细节（后续 SPI 篇）。

## 写作后检查

- [ ] 开篇先抓“为什么 Dubbo 需要这条抽象窄腰”，而不是直接讲接口定义。
- [ ] 至少展开 3 个失败方案，且包含“Dubbo 核心是 Protocol”“Filter 在协议内部”。
- [ ] 明确给出 provider / consumer 两侧围绕 `Invoker` 的总图。
- [ ] 不把本篇写成接口清单。
- [ ] 每个 wrapper 都先讲“为什么要包”再给 file:line。
- [ ] 删除代码块后，读者仍能复述窄腰五件套与运行链。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。