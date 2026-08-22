# Dubbo：Spring / Spring Boot 接入桥 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch07-dubbo-integration`
- 篇：`01 Spring / Spring Boot 接入桥`
- 对应主题：`D-INT-1 Spring / Spring Boot Integration Bridge`
- 文章类型：集成层主线篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：很多人以为自己“在用 `@DubboService` / `@DubboReference`”，其实运行时真正起作用的是 `ServiceBean`、`ReferenceBean`、`ReferenceAnnotationBeanPostProcessor`、`DubboConfigApplicationListener`、`DubboDeployApplicationListener` 和 `moduleModel.getDeployer()`。对于不懂 Dubbo 源码的读者，最想知道的是：这些 Spring 注解和 Boot 自动配置，最终是怎么接回 `ServiceConfig / ReferenceConfig` 那条主线的？
- 一句话顿悟：Dubbo Spring 集成不是“重新实现一套 export/refer”，而是搭一座桥：`@DubboService` 被扫描后变成 `ServiceBean`（`ServiceConfig` 子类），`@DubboReference` 被翻译成 `ReferenceBean`（FactoryBean + lazy proxy），两者再通过 `ConfigManager` / `ReferenceBeanManager` 纳入 `ModuleModel` deployer 生命周期；Spring Boot 主要只是补了自动配置、属性绑定和包扫描入口，核心桥接逻辑仍在 `dubbo-config-spring` 里。
- 文章边界：本篇重点讲注解扫描、BeanDefinition 注册、`ServiceBean` / `ReferenceBean`、`DubboSpringInitializer`、`DubboConfigApplicationListener`、`DubboDeployApplicationListener`、`ReferenceBeanManager` 与 `DubboBootstrap`/deployer 的接缝；不重讲 `ServiceConfig.doExport()` 和 `ReferenceConfig.createProxy()` 内部主线，也不深讲 SPI、Cluster、Remoting。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/01-serviceconfig-referenceconfig-export-refer.md`：已经知道 `ServiceConfig` / `ReferenceConfig` 是核心入口对象。
- `ch06-dubbo-runtime/02-invoker-protocol-exporter-proxy-filter.md`：已经知道 export/refer 后的窄腰运行链。

### SOFT

- 不要求先懂 Spring 全量 BeanFactory 生命周期。
- 不要求先懂 Dubbo ScopeModel 全部细节。

### NAV

- 后续可接：配置合并、外部化与 URL 生成。
- 后续可接：Spring 与 ScopeModel/ApplicationModel 关系专题。

## 一句话困惑

`@DubboService` 和 `@DubboReference` 到底是怎样接到 Dubbo 核心运行时上的？为什么注解并不是直接 export/refer，而是先变成 `ServiceBean` / `ReferenceBean`，再进入 deployer 生命周期？

## 一句话顿悟

Spring 侧真正做的不是“远程调用”，而是“把注解和配置翻译成 Dubbo 认识的运行时对象”：`@DubboService` 最终变成 `ServiceBean(ServiceConfig)`，`@DubboReference` 最终变成 `ReferenceBean(ReferenceConfig provider)`，再由 `DubboConfigApplicationListener` 和 `DubboDeployApplicationListener` 驱动 `moduleModel.getDeployer().prepare()/start()`，把桥接后的对象送入 Dubbo 核心主线。

## 读者理解路径

1. 先否定“注解直接 export/refer”的直觉。
2. 建立最小总图：Spring 注解/配置 → BeanDefinition/PostProcessor → ServiceBean/ReferenceBean → ConfigManager/ReferenceBeanManager → deployer → Dubbo runtime。
3. 解释 `@EnableDubbo` / `DubboComponentScanRegistrar` / `DubboSpringInitializer` 作为桥的入口。
4. 解释 `@DubboService` 如何被 `ServiceAnnotationPostProcessor` 扫描并注册为 `ServiceBean`。
5. 解释 `@DubboReference` 如何被 `ReferenceAnnotationBeanPostProcessor` 扫描、翻译、注册为 `ReferenceBean`，并通过 lazy proxy 注入字段。
6. 解释 `ReferenceBeanManager` 如何把多个注解注入点收拢到少量 `ReferenceConfig`。
7. 解释 `DubboConfigApplicationListener` / `DubboDeployApplicationListener` 如何把 Spring 容器生命周期接回 `moduleModel.getDeployer()`。
8. 收束到：Spring/Boot 是 Dubbo 的接入桥，不是第二套独立运行时。

## 失败方案推演

### 失败方案一：`@DubboService` 直接调用 `ServiceConfig.export()`

- 这会让读者误以为注解扫描时就已经完成导出。
- 实际上扫描后注册的是 `ServiceBean` BeanDefinition，`ServiceBean` 只是 `ServiceConfig` 的 Spring 包装，真正 export 要等 deployer 生命周期驱动。
- 所以注解只是把配置翻译成运行时入口对象，不直接跑完整主线。

### 失败方案二：`@DubboReference` 注入时已经建立远程连接

- 注入到字段里的通常是 `ReferenceBean` 提供的 lazy proxy，而不是立刻完成远程连接的最终调用结果。
- 真正的 `ReferenceConfig` 可能在预热阶段就创建，也可能拖到首次调用时才完成兜底初始化。
- 所以拿到一个 injected proxy，不等于这次远程引用已经全链路跑完。

### 失败方案三：Spring Boot 重新实现了一套 Dubbo 接入逻辑

- Boot 自动配置确实提供了扫描和属性绑定，但核心桥接逻辑并不在 Boot 模块里，而是在 `dubbo-config-spring`。
- `DubboAutoConfiguration` 更多是在激活入口和配置绑定；真正把注解翻成 `ServiceBean` / `ReferenceBean` 并接到 deployer 上的，仍然是 Spring 模块里的 processor 和 listener。
- 所以 Boot 是“入口外壳”，不是“第二套 Dubbo runtime”。

## 必须澄清的误解

1. `@DubboService` 不会直接 export，它先变成 `ServiceBean`，再纳入 deployer 生命周期。
2. `@DubboReference` 注入到字段里的不是原始 `ReferenceConfig`，而是 `ReferenceBean` 产出的 lazy proxy。
3. Spring/Boot 接入不取代 `ServiceConfig/ReferenceConfig` 主线，只是把注解和配置翻译成这两个入口对象。
4. `ReferenceBeanManager` 不是缓存代理本身，而是管理 `ReferenceBean` / `ReferenceConfig` 的复用与去重。
5. Boot 自动配置不是核心运行时，`dubbo-config-spring` 才是桥接主战场。

## 文章结构与字数预算

1. 困惑开场：为什么“用注解”其实没有绕过 Dubbo 主线（800-1000 字）
2. 最小总图：Spring 注解/配置到 Dubbo runtime 的桥（1000-1400 字）
3. `@EnableDubbo` / `DubboSpringInitializer`：接入桥入口（1200-1800 字）
4. `@DubboService` → `ServiceBean` → deployer（1600-2200 字）
5. `@DubboReference` → `ReferenceBean` / `ReferenceBeanManager` → lazy proxy（1800-2400 字）
6. `DubboConfigApplicationListener` / `DubboDeployApplicationListener`：生命周期接缝（1400-1800 字）
7. Spring Boot 自动配置：它做了什么、没做什么（1200-1600 字）
8. 收网总结（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

### Spring 入口
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/annotation/EnableDubbo.java:44` — `@EnableDubbo`
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/annotation/DubboComponentScan.java:42` — component scan 入口
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/annotation/DubboComponentScanRegistrar.java:62` — registrar 初始化
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/DubboSpringInitializer.java:51` — initializer
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/util/DubboBeanUtils.java:67` — common beans 注册

### `@DubboService`
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/beans/factory/annotation/ServiceAnnotationPostProcessor.java:169` — 扫描入口
- `ServiceAnnotationPostProcessor.java:205` — 候选类处理
- `ServiceAnnotationPostProcessor.java:359` — beanName / serviceBeanName 构造
- `ServiceAnnotationPostProcessor.java:453` — `ServiceBean` BeanDefinition 构造
- `ServiceAnnotationPostProcessor.java:483` — ref / interface 注入
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/ServiceBean.java:42` — `ServiceBean extends ServiceConfig`
- `ServiceBean.java:111` — `afterPropertiesSet()` 注册 ConfigManager

### `@DubboReference`
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/beans/factory/annotation/ReferenceAnnotationBeanPostProcessor.java:76` — 双职责注释
- `ReferenceAnnotationBeanPostProcessor.java:139` — post processor 位置
- `ReferenceAnnotationBeanPostProcessor.java:379` — `prepareInjection()`
- `ReferenceAnnotationBeanPostProcessor.java:414` — `registerReferenceBean(...)`
- `ReferenceAnnotationBeanPostProcessor.java:538` — 注册 `ReferenceBean` 定义
- `ReferenceAnnotationBeanPostProcessor.java:570` — 注入时 `getBean(referenceBeanName)`
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/reference/ReferenceBeanSupport.java:63` — 注解属性归一化
- `ReferenceBeanSupport.java:124` — referenceKey 生成
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/ReferenceBean.java:201` — lazy proxy 创建
- `ReferenceBean.java:230` — `afterPropertiesSet()`
- `ReferenceBean.java:438` — 首次调用时兜底 initReferenceBean
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/reference/ReferenceBeanManager.java:166` — initReferenceBean
- `ReferenceBeanManager.java:197` — 创建并注册 `ReferenceConfig`

### 生命周期 / Boot
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/DubboConfigApplicationListener.java:72` — 配置初始化与 prepare
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/DubboDeployApplicationListener.java:160` — ContextRefreshedEvent 时 start
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/DubboInfraBeanRegisterPostProcessor.java:55` — 提前注册 ReferenceAnnotationBeanPostProcessor
- `dubbo-spring-boot-project/dubbo-spring-boot-autoconfigure/src/main/java/org/apache/dubbo/spring/boot/autoconfigure/DubboAutoConfiguration.java:53` — Boot 自动配置
- `DubboAutoConfiguration.java:62` — 条件注册 ServiceAnnotationPostProcessor
- `dubbo-spring-boot-project/dubbo-spring-boot-autoconfigure/src/main/resources/META-INF/spring.factories:1` — Boot 自动配置入口
- `dubbo-spring-boot-project/dubbo-spring-boot-autoconfigure/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports:1` — 新式自动配置入口

## 测试证据清单

- `ServiceAnnotationPostProcessorTest.java:83` — 类级 `@DubboService`
- `ServiceAnnotationPostProcessorTest.java:94` — 方法级 `@DubboService`
- `ReferenceAnnotationBeanPostProcessorTest.java:135` — 字段/方法注入
- `ReferenceAnnotationBeanPostProcessorTest.java:286` — alias/重命名/复用
- `CompatibleDubboAutoConfigurationTest.java:54` — Boot 自动配置存在 ServiceAnnotationPostProcessor
- `CompatibleDubboAutoConfigurationTestWithoutProperties.java:65` — 不配扫描包时不注册 ServiceAnnotationPostProcessor，但基础 reference 基础设施仍存在
- `DubboAutoConfigurationOnSingleConfigTest.java:95` — `dubbo.*` 属性绑定成 Config Bean
- `DubboAutoConfigurationOnMultipleConfigTest.java:108` — 多配置绑定

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇以 `dubbo-config-spring` / Spring Boot 接入为主，不展开 XML 老配置模型。
- 本篇聚焦 Spring 桥接，不重讲 `ServiceConfig.doExport()` / `ReferenceConfig.createProxy()` 内部主线。

## 与其他篇的边界

### 本篇要讲清

- Spring 注解/配置如何翻译成 `ServiceBean` / `ReferenceBean`。
- `ReferenceBeanManager`、ConfigManager、deployer 如何接桥。
- Boot 自动配置到底提供了什么入口。
- 为什么 Spring/Boot 不是第二套 Dubbo runtime。

### 本篇不深讲

- `ServiceConfig` / `ReferenceConfig` 内部主线（第一篇）。
- Invoker / Protocol / Filter / Cluster / Remoting 内部机制（前几篇）。
- ScopeModel / ApplicationModel 的深度细节。

## 写作后检查

- [ ] 开篇先抓“注解并没有绕过 Dubbo 主线”，而不是直接讲 `@EnableDubbo`。
- [ ] 至少展开 3 个失败方案，且包含“`@DubboReference` 注入即连上远端”“Boot 重写接入逻辑”。
- [ ] 明确给出 Spring 注解/配置到 Dubbo runtime 的桥接总图。
- [ ] 不把本篇写成注解属性说明书。
- [ ] 每个 processor/listener 都先讲职责再给 file:line。
- [ ] 删除代码块后，读者仍能复述 `ServiceBean` / `ReferenceBean` / deployer 的桥接关系。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。