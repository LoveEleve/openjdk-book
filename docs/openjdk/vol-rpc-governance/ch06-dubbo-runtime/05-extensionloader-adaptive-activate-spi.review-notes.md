# Dubbo：ExtensionLoader、Adaptive 与 Activate SPI 机制 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `ExtensionDirector.getExtensionLoader(type)` 会校验：非空、必须是接口、必须带 `@SPI`，并按 parent/local scope 查找或创建 Loader，证据：`dubbo-common/src/main/java/org/apache/dubbo/common/extension/ExtensionDirector.java:67`、`:80`。
2. `@SPI` 提供默认扩展名 `value()` 和作用域 `scope()`，例如 `Protocol` 默认 `dubbo`、`ProxyFactory` 默认 `javassist`、`Cluster` 默认 `failover`、`Dispatcher` 默认 `all`，证据：`dubbo-common/src/main/java/org/apache/dubbo/common/extension/SPI.java:56`、`dubbo-rpc/dubbo-rpc-api/src/main/java/org/apache/dubbo/rpc/Protocol.java:58`、`ProxyFactory.java:29`、`Cluster.java:34`、`Dispatcher.java:28`。
3. `ExtensionLoader` 首次使用时延迟扫描资源，按 `LoadingStrategy.directory() + type.getName()` 读取 `META-INF/dubbo/internal` 等资源，建立名称到实现类映射，证据：`ExtensionLoader.java:955`、`:987`、`:1045`。
4. Loader 内部维护多级缓存：名称->类、类->名称、实现类->原始实例、名称->最终包装实例、Adaptive 类/实例、wrapper 类、activate 信息等，证据：`ExtensionLoader.java:117`。
5. `getExtension(name)` 负责固定名称扩展的创建和缓存，最终对象会经过后处理、依赖注入、wrapper 和生命周期初始化，证据：`ExtensionLoader.java:549`、`:772`、`:788`、`:911`。
6. `getDefaultExtension()` 只是使用 `@SPI.value()` 中的默认名称，再走 `getExtension(defaultName)`，证据：`ExtensionLoader.java:595`、`:1026`。
7. `getAdaptiveExtension()` 返回的是 Adaptive 代理，不是固定实现；手写 `@Adaptive` 类优先，否则由 `AdaptiveClassCodeGenerator` 生成，证据：`ExtensionLoader.java:720`、`:1449`、`dubbo-common/src/main/java/org/apache/dubbo/common/extension/Adaptive.java:37`、`AdaptiveClassCodeGenerator.java:242`。
8. `AdaptiveClassCodeGenerator` 会根据 `@Adaptive` 的 key 顺序、接口名推导、`protocol` 特殊处理和参数对象 `getUrl()` 生成动态分派逻辑，证据：`AdaptiveClassCodeGenerator.java:271`、`:361`、`:381`。
9. `@Activate` 的自动激活需要同时通过 group、URL value、`onClass` 和排序等条件，`getActivateExtension()` 还支持 `default`、`-name` 等语法，证据：`dubbo-common/src/main/java/org/apache/dubbo/common/extension/Activate.java:45`、`ExtensionLoader.java:329`、`:364`、`:375`、`:471`、`:1279`、`ActivateComparator.java:52`。
10. Wrapper 通过“单参数构造器”识别；`ProtocolFilterWrapper` 和 `ProtocolListenerWrapper` 都是 `Protocol` wrapper，证据：`ExtensionLoader.java:1393`、`ProtocolFilterWrapper.java:35`、`ProtocolListenerWrapper.java:46`。
11. `ProtocolFilterWrapper` 在 export/refer 边界包 Filter chain，`DefaultFilterChainBuilder` 的每个链节点本身仍是 `Invoker`，说明 Filter 是 Invoker 链而不是协议内部步骤，证据：`ProtocolFilterWrapper.java:53`、`:67`、`FilterChainBuilder.java:92`、`DefaultFilterChainBuilder.java:68`。
12. Setter 注入由 `ExtensionLoader.injectExtension()` 完成，依赖来自 `ExtensionInjector`；Lifecycle 实例会调用 `initialize()`，销毁时清理原始实例、wrapper 实例和缓存，证据：`ExtensionLoader.java:856`、`:911`、`:249`。

### 测试证据已核对

1. `ExtensionLoader_Adaptive_Test.java:57` — 默认 key 推导。
2. `ExtensionLoader_Adaptive_Test.java:97` — protocol 特殊选择。
3. `ExtensionLoader_Adaptive_Test.java:205` — 参数 getter URL。
4. `ExtensionLoader_Adaptive_Test.java:312` — Adaptive 依赖注入。
5. `ExtensionLoader_Activate_Test.java:30` — `onClass` 条件筛选。
6. `DefaultFilterChainBuilderTest.java:52` — Filter chain 的自动组装。
7. `ProtocolListenerWrapperTest.java:57` — refer 返回 listener wrapper。

### 深审发现

1. **高风险：容易把 Dubbo SPI 写成资源扫描器。** 当前正文已把资源扫描降到输入层，把真正重点压在 Loader 的实例组装链。  
2. **高风险：容易把 Adaptive 当默认扩展。** 当前正文已明确固定默认值与 URL 动态路由的差异。  
3. **中风险：容易把 Activate 理解成“只要有注解就自动生效”。** 当前正文已把 group/value/onClass/order/default 语法拆开。  
4. **中风险：容易混淆 Wrapper 与 Filter。** 当前正文已把 `ProtocolFilterWrapper -> FilterChainBuilder -> Filter -> Invoker` 关系讲清。  
5. **低风险：容易忽略 ScopeModel 对扩展实例的影响。** 当前正文已补 `ExtensionDirector` 与 scope 查找路径。  

## 第二轮：因果审

- Dubbo 必须有 `ExtensionDirector` 这一层，否则不同 scope 下的扩展实例无法隔离：✅  
- `@SPI` 必须只声明默认名称和 scope，而不能直接绑定实例，否则扩展运行时就失去动态性：✅  
- `getAdaptiveExtension()` 必须返回代理而不是具体实现，否则同一接口无法按 URL 在调用期切换扩展：✅  
- `@Activate` 必须支持 group、URL 条件和 onClass，否则 Filter/Listener 这种条件链路无法按场景自动装配：✅  
- wrapper 必须在实例创建后统一包裹，否则协议、Filter、Listener 等横切层都要侵入具体实现：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → SPI 总图 → `@SPI`/Director → ExtensionLoader → fixed/default/adaptive → Activate → wrapper/injection/lifecycle → 真实运行示例 → 误解澄清 → 收网总结”推进，没有退化成 `ExtensionLoader` 方法清单。

失败方案已覆盖：
- Dubbo SPI 只是读取 Java SPI 文件  
- `getAdaptiveExtension()` 就是默认扩展  
- `@Activate` 会自动加载所有标注类  

每一层拆解均包含：扩展契约 → 组装链 → 运行时示例 → 证据位，符合框架基础设施机制篇要求。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- `@SPI`、`ExtensionDirector`、`ExtensionLoader` 的职责边界  
- `getExtension` / default / adaptive 三种扩展获取方式的差别  
- `@Activate` 如何条件激活 Filter/Listener  
- wrapper、注入、生命周期如何把裸实现变成最终运行对象  
- Protocol/Filter/Dispatcher/LoadBalance 为什么能动态插拔  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开具体 Protocol 网络实现。✅  
- 未展开具体 Filter 业务语义。✅  
- 未展开 Cluster 容错算法和 LoadBalance 算法细节。✅  
- 未展开 Netty Dispatcher 线程模型。✅  
- 重点仍压在 Dubbo SPI 运行时组装机制，边界收得住。✅

## 第六轮：依赖审

- 已承接第二篇：Protocol/Filter/Dispatcher/LoadBalance 作为“被装配的扩展点”已知，本篇解释它们为什么能动态插拔。✅  
- 后续可自然接到具体协议篇、Filter 专题、Cluster/LoadBalance 实现篇，而不用在本篇提前透支。✅  
- `ExtensionLoader_Adaptive_Test`、`ExtensionLoader_Activate_Test`、`DefaultFilterChainBuilderTest`、`ProtocolListenerWrapperTest` 的组合足以支撑本文的运行时装配结论。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：使用少量文字图，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `ExtensionDirector`、`ExtensionLoader`、`SPI`、`Adaptive`、`Activate`、`AdaptiveClassCodeGenerator`、`ProtocolFilterWrapper`、`ProtocolListenerWrapper`、`DefaultFilterChainBuilder`。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数（不含代码块与空白行）：约 `16,383`。  
- 目标定位：Dubbo 扩展基础设施篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 Dubbo 的动态拼装能力从“很多扩展名和注解”提升到一套完整的运行时：`@SPI` 定义契约，`ExtensionDirector` 管 scope，`ExtensionLoader` 管扫描/映射/缓存/注入/wrapper/lifecycle，Adaptive 负责 URL 动态路由，Activate 负责条件扩展组装。只要这条 SPI 主线立住，前面几篇里出现的 Protocol、Filter、Dispatcher、Cluster、LoadBalance 才真正成为一个统一可解释的系统。