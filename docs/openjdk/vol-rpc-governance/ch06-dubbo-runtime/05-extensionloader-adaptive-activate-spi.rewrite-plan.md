# Dubbo：ExtensionLoader、Adaptive 与 Activate SPI 机制 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch06-dubbo-runtime`
- 篇：`05 ExtensionLoader、Adaptive 与 Activate SPI 机制`
- 对应主题：`D-EXT-1 Dubbo SPI / Adaptive / Activate`
- 文章类型：框架基础设施机制篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：前面几篇已经反复出现 `Protocol`、`Filter`、`Dispatcher`、`LoadBalance`、`Cluster` 等扩展名，但读者仍然不知道 Dubbo 到底如何把一个字符串名字变成可运行对象。`@SPI` 的默认值是什么？`getExtension("tri")` 和 `getAdaptiveExtension()` 有什么差异？`@Activate` 为什么能自动组装 Filter 链？`ProtocolFilterWrapper` 为什么可以在不修改具体 Protocol 的前提下插进去？
- 一句话顿悟：Dubbo 的 SPI 不是“读取一个 Java SPI 文件”这么简单，而是一套扩展运行时：`ExtensionDirector` 按 ScopeModel 管理 Loader，`ExtensionLoader` 扫描 `META-INF/dubbo/internal` 资源并建立名称映射，创建实例时完成缓存、依赖注入、wrapper、生命周期和后处理；`getAdaptiveExtension()` 再根据 URL key 动态选择具体实现，`getActivateExtension()` 则根据 group、URL 条件、`onClass` 和 order 组装条件扩展。它是 Dubbo 能把 Protocol、Filter、Dispatcher、Cluster、LoadBalance 动态拼起来的基础设施。
- 文章边界：本篇重点讲 `ExtensionDirector`、`ExtensionLoader`、`@SPI`、`@Adaptive`、`@Activate`、wrapper、依赖注入、缓存和生命周期，并用 Protocol/Filter/Dispatcher/LoadBalance 做最小落地示例；不展开具体协议实现、具体 Filter 业务语义、Cluster 容错算法和 Netty dispatcher 算法。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/02-invoker-protocol-exporter-proxy-filter.md`：已经知道 Protocol、Filter、Proxy 等扩展点在哪条调用链上。

### SOFT

- 不要求先懂 Java 原生 SPI。
- 不要求先懂完整 ScopeModel 生命周期。

### NAV

- 后续可接：Dubbo2 / Triple 协议对照。
- 后续可接：Filter、Cluster、LoadBalance 的具体实现专题。

## 一句话困惑

Dubbo 如何把一个扩展接口、一个配置名字和一个 URL 参数，变成最终可运行的 Protocol、Filter、Dispatcher 或 LoadBalance 实例？

## 一句话顿悟

Dubbo SPI 的完整链条是：`@SPI` 声明扩展契约 → `ExtensionDirector` 按 scope 管理 Loader → `ExtensionLoader` 扫描资源并建立名称映射 → `getExtension(name)` 创建具体实例 → wrapper/注入/生命周期组装 → `getAdaptiveExtension()` 根据 URL 动态路由 → `getActivateExtension()` 按条件组装自动扩展。SPI 不是配置读取器，而是 Dubbo 的运行时组装器。

## 读者理解路径

1. 先否定“Dubbo SPI 只是 Java SPI 的换皮”这种理解。
2. 建立最小总图：接口 → Director → Loader → 资源映射 → 实例缓存 → wrapper/注入/生命周期。
3. 解释 `@SPI` 的默认名称和 scope。
4. 解释 `getExtension(name)`、`getDefaultExtension()`、`getAdaptiveExtension()` 的区别。
5. 解释 Adaptive 如何从 URL protocol、参数 key、getter URL 推导扩展名。
6. 解释 Activate 如何根据 group、value、onClass、order 组装 Filter/Listener。
7. 解释 wrapper、依赖注入、post processor、lifecycle 和多级缓存。
8. 用 Protocol、Filter、Dispatcher、LoadBalance 说明这些机制如何进入真实运行链。
9. 收束到：Dubbo 的动态性来自 SPI 运行时，而不是各模块互相硬编码。

## 失败方案推演

### 失败方案一：Dubbo SPI 就是读取 Java SPI 文件

- 这只能解释名称到类的映射，解释不了 scope、wrapper、注入、生命周期和 Adaptive。
- `ExtensionLoader` 创建的不是裸实现，而是经过多个组装阶段的最终实例。
- 所以资源文件只是输入，ExtensionLoader 才是运行时组装器。

### 失败方案二：`getAdaptiveExtension()` 就是默认扩展

- 默认扩展是 `@SPI.value()` 对应的 `getExtension(defaultName)`。
- Adaptive 扩展是一个代理，每次调用根据 URL 重新选择具体扩展。
- 两者的时间点不同：默认扩展是固定名称，Adaptive 是动态路由。

### 失败方案三：`@Activate` 会自动加载所有标注类

- `@Activate` 只是“允许自动激活”的条件声明。
- 还要通过 group、URL value、onClass、order 和显式配置语法筛选。
- 所以“类上有 @Activate”不等于“它一定出现在当前 Filter 链里”。

## 必须澄清的误解

1. `ExtensionLoader` 返回的最终对象可能已经经过 wrapper，不一定是资源文件对应的裸实现。
2. `@SPI("dubbo")` 只提供默认名称，不等于接口直接持有默认实例。
3. `getAdaptiveExtension()` 不是一个固定实现，而是根据 URL 动态选择的适配器。
4. `@Activate` 不是无条件自动加载，而是带 group/value/onClass/order 的条件激活。
5. Filter chain 的节点本身仍然是 Invoker，wrapper 和 Filter 不是同一个层级。

## 文章结构与字数预算

1. 困惑开场：为什么 Dubbo 能动态拼出这么多扩展（800-1000 字）
2. 最小总图：接口到最终实例的 ExtensionLoader 组装链（1000-1400 字）
3. `@SPI` / `ExtensionDirector`：扩展契约与 scope（1400-2000 字）
4. `ExtensionLoader`：资源扫描、名称映射和缓存（1800-2400 字）
5. `getExtension` / default / Adaptive：固定选择与动态选择（1800-2400 字）
6. `@Activate`：条件扩展与 Filter 链（1600-2200 字）
7. wrapper、注入、生命周期与真实运行示例（1600-2200 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

### contract / scope
- `dubbo-common/src/main/java/org/apache/dubbo/common/extension/ExtensionDirector.java:67` — SPI/interface 校验
- `dubbo-common/src/main/java/org/apache/dubbo/common/extension/ExtensionDirector.java:80` — parent/local Director 查找
- `dubbo-common/src/main/java/org/apache/dubbo/common/extension/SPI.java:56` — default name / scope
- `dubbo-common/src/main/java/org/apache/dubbo/common/extension/ExtensionLoader.java:955` — lazy load extension classes
- `ExtensionLoader.java:987` — LoadingStrategy 资源扫描
- `ExtensionLoader.java:1045` — resource parsing

### name/default/cache
- `ExtensionLoader.java:117` — caches
- `ExtensionLoader.java:549` — getExtension
- `ExtensionLoader.java:595` — getDefaultExtension
- `ExtensionLoader.java:720` — getAdaptiveExtension
- `ExtensionLoader.java:772` — instance creation
- `ExtensionLoader.java:788` — wrapper/injection/lifecycle 组装

### adaptive
- `dubbo-common/src/main/java/org/apache/dubbo/common/extension/Adaptive.java:37` — Adaptive 定义
- `ExtensionLoader.java:1449` — 手写/生成 Adaptive class
- `AdaptiveClassCodeGenerator.java:242` — Adaptive method generation
- `AdaptiveClassCodeGenerator.java:361` — interface name -> key
- `AdaptiveClassCodeGenerator.java:271` — protocol 特殊处理
- `AdaptiveClassCodeGenerator.java:381` — 参数 getter URL

### activate
- `dubbo-common/src/main/java/org/apache/dubbo/common/extension/Activate.java:45` — Activate 定义
- `ExtensionLoader.java:329` — getActivateExtension
- `ExtensionLoader.java:364` — group 条件
- `ExtensionLoader.java:375` — default/explicit syntax
- `ExtensionLoader.java:471` — URL value 条件
- `ExtensionLoader.java:1279` — onClass 检查
- `ActivateComparator.java:52` — order / 排序

### wrapper/injection/lifecycle
- `ExtensionLoader.java:1393` — wrapper 构造器识别
- `ExtensionLoader.java:829` — post processors
- `ExtensionLoader.java:856` — setter injection
- `ExtensionLoader.java:911` — Lifecycle initialize
- `ExtensionLoader.java:249` — destroy
- `ProtocolFilterWrapper.java:53` — filter wrapper
- `ProtocolListenerWrapper.java:64` — listener wrapper
- `DefaultFilterChainBuilder.java:68` — 反向构造 filter chain

## 测试证据清单

- `dubbo-common/src/test/java/org/apache/dubbo/common/extension/ExtensionLoader_Adaptive_Test.java:57` — 默认 key
- `ExtensionLoader_Adaptive_Test.java:97` — protocol 特殊选择
- `ExtensionLoader_Adaptive_Test.java:205` — 参数 getter URL
- `ExtensionLoader_Adaptive_Test.java:312` — Adaptive 依赖注入
- `dubbo-common/src/test/java/org/apache/dubbo/common/extension/ExtensionLoader_Activate_Test.java:30` — onClass 条件
- `dubbo-cluster/src/test/java/org/apache/dubbo/rpc/cluster/filter/DefaultFilterChainBuilderTest.java:52` — Filter chain
- `dubbo-rpc/dubbo-rpc-api/src/test/java/org/apache/dubbo/rpc/protocol/ProtocolListenerWrapperTest.java:57` — Listener wrapper

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇讨论 Dubbo 3.x 当前 ExtensionLoader/Adaptive/Activate 机制，不展开 2.x SPI 兼容差异。
- `ExtensionFactory` 已 deprecated，正文以 `ExtensionInjector`/当前 Loader 注入机制为准。
- 具体 Filter、Protocol、Cluster、LoadBalance 算法不展开。

## 与其他篇的边界

### 本篇要讲清

- `@SPI`、ExtensionDirector、ExtensionLoader 的关系。
- 资源扫描、名称映射、默认扩展、实例缓存。
- Adaptive 的 URL 动态选择。
- Activate 的条件激活和排序。
- wrapper、注入、生命周期如何组装最终对象。

### 本篇不深讲

- 具体 Protocol 网络实现。
- 具体 Filter 业务语义。
- Cluster 容错算法和 LoadBalance 算法。
- Netty Dispatcher 线程模型。

## 写作后检查

- [ ] 开篇先抓“Dubbo 如何动态拼出运行对象”，而不是直接讲 SPI 注解。
- [ ] 至少展开 3 个失败方案，且包含“SPI=资源文件”“Adaptive=默认实现”“Activate=无条件加载”。
- [ ] 明确给出接口到最终实例的 ExtensionLoader 组装图。
- [ ] 不把本文写成 ExtensionLoader 方法清单。
- [ ] 每个机制先讲动机，再给 file:line。
- [ ] 删除代码块后，读者仍能复述 SPI/default/adaptive/activate/wrapper 的关系。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。