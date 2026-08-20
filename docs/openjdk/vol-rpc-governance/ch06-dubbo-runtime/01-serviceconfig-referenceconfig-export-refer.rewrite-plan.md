# Dubbo：ServiceConfig、ReferenceConfig 与 export/refer 主线 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch06-dubbo-runtime`
- 篇：`01 ServiceConfig、ReferenceConfig 与 export/refer 主线`
- 对应主题：`D-MAIN-1 DubboBaseline Export/Refer Entry Spine`
- 文章类型：新框架 baseline 主线篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：不懂 Dubbo 的读者，第一次接触源码时最想知道的不是 `ScopeModel` 或 SPI，而是：一个 provider 到底怎么“暴露出去”？一个 `@DubboReference` 或 `ReferenceConfig.get()` 最后怎么变成一个能远程调用的 Java 代理？为什么 provider 这边要从 `ref` 先变成 `Invoker` 再 `export`，consumer 这边却要从 URL / registry 先拿到 `Invoker` 再 `getProxy()`？Dubbo 的真正运行时主线是不是就藏在这两个对象变形链里？
- 一句话顿悟：Dubbo 的 export/refer 主线可以压缩成两条对象变形链：**provider：`ref -> Invoker -> Exporter`；consumer：`URL / Registry -> Invoker -> Proxy`**。`ServiceConfig` 和 `ReferenceConfig` 不是普通配置对象，而是把配置态转换成运行时对象的两大入口；`ProxyFactory` 负责在“Java 对象世界”和“Invoker 世界”之间来回变形，`Protocol` 负责把 `Invoker` 真正暴露出去或引用回来，`RegistryProtocol` 则在 export/refer 路径中插入注册中心和目录更新逻辑。
- 文章边界：本篇只讲 Dubbo 最关键的入口缝：`DubboBootstrap/DefaultModuleDeployer`、`ServiceConfig`、`ReferenceConfig`、URL 组装、`ProxyFactory.getInvoker()/getProxy()`、`Protocol.export()/refer()`、`RegistryProtocol.export()/refer()` 的主线关系；不深讲自适应扩展生成、Filter 链、Directory/Router/LoadBalance/Cluster、底层 remoting/codec，这些留给后续篇章。

## 前置依赖

### HARD

- 无。作为 Dubbo 第一篇，本文应当能独立建立读者对框架入口的第一印象。

### SOFT

- 读者知道 Java 代理、接口调用、注册中心等概念即可。
- 不要求先懂 Dubbo SPI、ScopeModel、Triple、RegistryDirectory。

### NAV

- 后续可接：`Invoker、Protocol、Exporter、Proxy 与 Filter 窄腰`
- 后续可接：`Directory、Router、LoadBalance、Cluster consumer 流量主线`
- 后续可接：`DubboBootstrap、ScopeModel 与应用生命周期`

## 一句话困惑

Dubbo 里一个服务是怎么 export 出去的，一个引用又是怎么变成可调用代理的？为什么 provider 侧是 `ref -> Invoker -> Exporter`，而 consumer 侧是 `URL/Registry -> Invoker -> Proxy`？

## 一句话顿悟

`ServiceConfig` 和 `ReferenceConfig` 分别是 provider/export 和 consumer/refer 的总入口；Dubbo 用 `Invoker` 作为统一窄腰，把“本地 Java 对象”和“远程调用目标”都抽象成可调用体，再用 `Protocol` 决定怎么暴露和引用，用 `ProxyFactory` 决定怎么在 Java 对象与 `Invoker` 之间来回变形；注册中心只是插在 `Protocol.export()/refer()` 上的一层协调壳，而不是主线本身。

## 读者理解路径

1. 先否定“`ServiceConfig`/`ReferenceConfig` 只是配置 bean”这种理解。
2. 建立最小总图：module deployer 驱动 `exportServices()/referServices()`，provider 侧 `ref -> Invoker -> Exporter`，consumer 侧 `URL/Registry -> Invoker -> Proxy`。
3. 解释 `DefaultModuleDeployer` 作为 provider/consumer 启动时间线的作用。
4. 解释 `ServiceConfig.export()/doExport()` 怎样从配置态进入 URL 组装、Invoker 创建和 `Protocol.export()`。
5. 解释 registry export：为什么 provider URL 会被塞进 registry URL 的 `EXPORT_KEY`，最后由 `RegistryProtocol` 做“本地导出 + 注册中心注册”。
6. 解释 `ReferenceConfig.get()/init()/createProxy()` 怎样从配置态进入 URL 聚合、`Protocol.refer()`、cluster/registry 入口，再生成 Java 代理。
7. 解释为什么 consumer 拿到的最终是 `ref` 代理，而不是 `Invoker`。
8. 收束到：首篇真正要读懂的不是所有模块，而是 Dubbo 用哪条对象变形链把配置变成运行时。

## 失败方案推演

### 失败方案一：`ServiceConfig` 和 `ReferenceConfig` 只是普通配置对象

- 这会让读者以为 export/refer 的真正逻辑在别处，`ServiceConfig`/`ReferenceConfig` 只是“把参数传进去”。
- 但源码里真正触发 provider 暴露和 consumer 引用的入口，恰恰就是它们：`ServiceConfig.export()/doExport()` 与 `ReferenceConfig.get()/init()/createProxy()`。
- 所以它们不是被动配置 bean，而是配置态进入运行态的两大入口。

### 失败方案二：provider 和 consumer 的主线是对称的，都是“直接走 Protocol”

- 如果这么理解，就会漏掉 `ProxyFactory` 的对象变形职责。
- provider 这边是先拿已有 `ref` 对象，包装成 `Invoker`，再 export；consumer 这边是先 refer 得到 `Invoker`，再生成 Java 代理。
- 所以二者不是“同一条线反着走”，而是围绕 `Invoker` 这个窄腰做两种不同方向的变形。

### 失败方案三：注册中心就是 Dubbo 主线的中心

- 注册中心当然重要，但它不是第一篇应该建立的骨架。
- 如果一开始就把主线理解成“provider 注册到 registry，consumer 从 registry 拉列表”，你会错过真正的运行时窄腰：`Invoker`、`Protocol`、`ProxyFactory`。
- `RegistryProtocol` 更像插在主线上的协调壳：它把“本地导出/引用”与“注册中心/目录/订阅”接起来，而不是完全取代主线。

## 必须澄清的误解

1. `ServiceConfig` / `ReferenceConfig` 不是普通配置 bean，而是 export/refer 的入口对象。
2. provider 侧最终暴露出去的不是业务对象 `ref` 本身，而是包装过的 `Invoker`。
3. consumer 侧最终给业务代码的不是 `Invoker`，而是通过 `ProxyFactory` 生成的 Java 代理 `ref`。
4. `RegistryProtocol` 不是 Dubbo 唯一主线，而是插在 `Protocol.export()/refer()` 上的一层协调壳。
5. injvm 导出/引用不是边角功能，而是 Dubbo 默认主线的一部分。

## 文章结构与字数预算

1. 困惑开场：为什么 Dubbo 的服务暴露/引用看起来比 gRPC 多绕一圈（800-1000 字）
2. 最小总图：provider `ref -> Invoker -> Exporter` 与 consumer `URL -> Invoker -> Proxy`（1000-1400 字）
3. 启动时间线：`DubboBootstrap` / `DefaultModuleDeployer`（1000-1400 字）
4. provider export 主线：`ServiceConfig.export()/doExport()`（1800-2400 字）
5. registry export：`RegistryProtocol.export()`（1200-1600 字）
6. consumer refer 主线：`ReferenceConfig.get()/init()/createProxy()`（1800-2400 字）
7. registry refer 与 cluster 入口（1200-1600 字）
8. 收网总结：两条对象变形链如何建立 Dubbo baseline 心智图（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### 启动/时间线
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/bootstrap/DubboBootstrap.java:229` — `DubboBootstrap.start()` 委托 deployer
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/deploy/DefaultModuleDeployer.java:162` — `startSync()`
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/deploy/DefaultModuleDeployer.java:176` — `exportServices()`
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/deploy/DefaultModuleDeployer.java:186` — `referServices()`

### provider export
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ServiceConfig.java:324` — `export()` 入口
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ServiceConfig.java:356` — `doExport()`
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ServiceConfig.java:582` — `doExportUrls()`
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ServiceConfig.java:628` — `doExportUrlsFor1Protocol()`
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ServiceConfig.java:835` — `buildUrl()`
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ServiceConfig.java:875` — `exportUrl()` scope / local / remote 分支
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ServiceConfig.java:978` — `doExportUrl()`
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/proxy/javassist/JavassistProxyFactory.java:80` — provider `getInvoker(ref, interface, url)`

### registry export
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:272` — `RegistryProtocol.export()`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:352` — `doLocalExport()`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:293` — registry register

### consumer refer
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ReferenceConfig.java:230` — `get()` 入口
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ReferenceConfig.java:332` — `init()`
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ReferenceConfig.java:490` — `createProxy()`
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ReferenceConfig.java:633` — `aggregateUrlFromRegistry()`
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ReferenceConfig.java:669` — `createInvoker()`
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ReferenceConfig.java:846` — `shouldJvmRefer()`
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/proxy/javassist/JavassistProxyFactory.java:44` — consumer `getProxy(invoker)`
- `dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/proxy/InvokerInvocationHandler.java:50` — 代理调用进入 `invoker.invoke()`

### registry refer / cluster 入口
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:557` — `RegistryProtocol.refer()`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:578` — `doRefer()`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:647` — `doCreateInvoker()`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:667` — `directory.subscribe(...)`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:669` — `cluster.join(directory, true)`

## 测试证据清单

- `dubbo-config/dubbo-config-api/src/test/java/.../ServiceConfig*Test` — export 入口与 URL 组装相关测试
- `dubbo-config/dubbo-config-api/src/test/java/.../ReferenceConfig*Test` — get/init/createProxy 相关测试
- `dubbo-registry/dubbo-registry-api/src/test/java/.../RegistryProtocol*Test` — registry export/refer 主线测试
- `dubbo-rpc/dubbo-rpc-api/src/test/java/.../ProxyFactory*Test` — proxy / invoker 变形测试

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇只建立 Dubbo baseline 主线，不展开 Triple / Dubbo2 协议分叉细节。
- 本篇只点到 registry 作为 export/refer 协调壳，不展开 Directory/Router/LoadBalance/Cluster 内部算法。
- Spring / Spring Boot 注解驱动入口也不展开，默认从 `DubboBootstrap` / `DefaultModuleDeployer` 作为统一时间线进入。

## 与其他篇的边界

### 本篇要讲清

- Dubbo 的 export/refer 两条入口主线。
- `ServiceConfig` / `ReferenceConfig` 为什么不是普通配置 bean。
- `Invoker`、`Protocol`、`ProxyFactory` 在这条主线里的基本角色。
- `RegistryProtocol` 作为协调壳的作用。
- injvm / remote 的主分叉。

### 本篇不深讲

- 自适应扩展生成细节（留给 SPI 篇）。
- Filter 链、Invoker wrapper 细节（留给窄腰篇）。
- Directory/Router/LoadBalance/Cluster 内部流量主线（留给下一篇）。
- remoting、exchange、codec、线程模型（留给 remoting 篇）。

## 写作后检查

- [ ] 开篇先抓“服务怎么暴露、引用怎么变代理”，而不是直接讲 DubboBootstrap。
- [ ] 至少展开 3 个失败方案，且包含“`ServiceConfig` 只是配置 bean”“注册中心就是主线中心”。
- [ ] 明确给出 provider `ref -> Invoker -> Exporter` 与 consumer `URL/Registry -> Invoker -> Proxy` 两条总图。
- [ ] 不把本篇写成 ServiceConfig/ReferenceConfig API 说明书。
- [ ] 每个关键协调方法先讲生命周期职责，再给 file:line。
- [ ] 删除代码块后，读者仍能复述 export/refer 的两条对象变形链。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。