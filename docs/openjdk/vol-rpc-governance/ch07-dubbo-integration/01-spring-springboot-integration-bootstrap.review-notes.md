# Dubbo：Spring / Spring Boot 接入桥 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `@EnableDubbo` 不是 export/refer 本身，而是通过 `@EnableDubboConfig` 和 `@DubboComponentScan` 把 Dubbo Spring 基础设施接入容器，证据：`dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/annotation/EnableDubbo.java:44`、`DubboComponentScan.java:42`。
2. `DubboComponentScanRegistrar` 会先初始化 Dubbo Spring 基础设施，再注册 `ServiceAnnotationPostProcessor`，证据：`dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/annotation/DubboComponentScanRegistrar.java:62`。
3. `DubboSpringInitializer.initialize(...)` 把当前 Spring 容器绑定到 Dubbo 的 ApplicationModel/ModuleModel，并注册 common beans，证据：`dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/DubboSpringInitializer.java:51`、`DubboBeanUtils.java:67`。
4. `ServiceAnnotationPostProcessor` 负责扫描类级/方法级 `@DubboService`，并把注解属性翻译成 `ServiceBean` BeanDefinition，证据：`dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/beans/factory/annotation/ServiceAnnotationPostProcessor.java:169`、`:205`、`:359`、`:453`、`:483`。
5. `ServiceBean` 直接 `extends ServiceConfig`，在 `afterPropertiesSet()` 中把自己注册到 `ConfigManager`，并未直接 export，证据：`dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/ServiceBean.java:42`、`:111`。
6. `ReferenceAnnotationBeanPostProcessor` 既负责提前注册 `ReferenceBean` BeanDefinition，也负责字段/方法注入，证据：`dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/beans/factory/annotation/ReferenceAnnotationBeanPostProcessor.java:76`、`:139`、`:379`、`:414`、`:538`。
7. 注入时 `doGetInjectedBean()` 不是直接 new 远程代理，而是从 BeanFactory 取 `ReferenceBean` 对应 bean，证据：`ReferenceAnnotationBeanPostProcessor.java:570`。
8. `ReferenceBean.getObject()` 返回 lazy proxy，`ReferenceBean.afterPropertiesSet()` 只是注册 manager，不等于立刻创建 `ReferenceConfig`，证据：`dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/ReferenceBean.java:201`、`:230`、`:272`。
9. `ReferenceBeanManager.initReferenceBean(...)` 才真正创建并注册 `ReferenceConfig`，同时负责同 key 复用和 deployer pending，证据：`dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/reference/ReferenceBeanManager.java:166`、`:197`。
10. `DubboConfigApplicationListener` 在 `DubboConfigInitEvent` 时做配置初始化并 `prepare()`，`DubboDeployApplicationListener` 在 `ContextRefreshedEvent` 时做 `start()`，证据：`dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/DubboConfigApplicationListener.java:72`、`DubboDeployApplicationListener.java:160`。
11. Spring Boot `DubboAutoConfiguration` 主要负责激活 `@EnableDubboConfig`、扫描入口和配置绑定，核心桥接逻辑仍落在 `dubbo-config-spring`，证据：`dubbo-spring-boot-project/dubbo-spring-boot-autoconfigure/src/main/java/org/apache/dubbo/spring/boot/autoconfigure/DubboAutoConfiguration.java:53`、`:62`、`spring.factories:1`、`AutoConfiguration.imports:1`。
12. `DubboBootstrap.start()` 最终只是 facade 到 deployer/applicationDeployer，Spring 集成更贴近 `moduleModel.getDeployer()` 生命周期，而不是到处显式调用 bootstrap，证据：`dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/bootstrap/DubboBootstrap.java:104`、`:229`。

### 测试证据已核对

1. `ServiceAnnotationPostProcessorTest.java:83` — 类级 `@DubboService`。
2. `ServiceAnnotationPostProcessorTest.java:94` — 方法级 `@DubboService`。
3. `ReferenceAnnotationBeanPostProcessorTest.java:135` — 字段/方法注入。
4. `ReferenceAnnotationBeanPostProcessorTest.java:286` — alias/重命名/复用。
5. `CompatibleDubboAutoConfigurationTest.java:54` — Boot 下 `ServiceAnnotationPostProcessor`。
6. `CompatibleDubboAutoConfigurationTestWithoutProperties.java:65` — 不配扫描包时的差异。
7. `DubboAutoConfigurationOnSingleConfigTest.java:95` — `dubbo.*` 属性绑定。
8. `DubboAutoConfigurationOnMultipleConfigTest.java:108` — 多配置绑定。

## 第二轮：因果审

- Spring 注解不能直接 export/refer，否则会在 BeanFactory 尚未稳定时提前进入运行时主线：✅
- `ServiceBean` / `ReferenceBean` 必须作为桥对象存在，否则 Spring BeanDefinition 世界无法平稳接到 Dubbo `ServiceConfig` / `ReferenceConfig` 世界：✅
- `ReferenceAnnotationBeanPostProcessor` 必须提前注册，否则普通字段注入阶段拿不到 Dubbo 引用桥：✅
- `ReferenceBeanManager` 必须负责 key 级复用，否则多个注入点会生成重复 `ReferenceConfig`：✅
- Boot 自动配置必须停留在“入口壳”层，否则会和 `dubbo-config-spring` 重复实现主线：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → Spring 到 Dubbo 总图 → `@EnableDubbo` / initializer → `@DubboService` → `@DubboReference` → `ReferenceBeanManager` → listener/deployer 生命周期 → Boot 角色 → 误解澄清 → 收网总结”推进，没有退化成注解属性说明书。

失败方案已覆盖：
- `@DubboService` 直接调用 `ServiceConfig.export()`  
- `@DubboReference` 注入时已经连上远端  
- Spring Boot 重写了一套 Dubbo 接入逻辑  

每一层拆解均包含：Spring 世界对象 → Dubbo 入口对象 → deployer 生命周期接缝，符合集成层桥接篇要求。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- `@DubboService` 如何变成 `ServiceBean(ServiceConfig)`  
- `@DubboReference` 如何变成 `ReferenceBean` / `ReferenceConfig` / lazy proxy  
- `ReferenceBeanManager` 与 ConfigManager 的桥接角色  
- `DubboConfigApplicationListener` / `DubboDeployApplicationListener` 如何接回 deployer  
- 为什么 Spring Boot 只是入口外壳  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重讲 `ServiceConfig.doExport()` / `ReferenceConfig.createProxy()` 内部主线（第一篇已覆盖）。✅
- 未重讲 Invoker / Protocol / Cluster / Remoting 内部机制（前几篇已覆盖）。✅
- 未深入 ScopeModel / ApplicationModel 全部细节。✅
- 未写 XML 老配置模型。✅
- 重点仍压在 Spring/Boot 接桥而不是重复 Dubbo runtime，边界收得住。✅

## 第六轮：依赖审

- 已直接承接第一篇：`ServiceConfig` / `ReferenceConfig` 作为运行时入口已知，本篇解释它们如何被 Spring 翻译出来。✅
- 已承接后续几篇：这些桥接对象最终接到前面已建立的 Dubbo runtime 主线。✅
- `ServiceAnnotationPostProcessorTest`、`ReferenceAnnotationBeanPostProcessorTest`、Boot auto-configuration tests 足以支撑“Spring 不是第二套 runtime，而是接入桥”的结论。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅
- 代码块：使用少量桥接总图，不承担主叙事骨架。✅
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `EnableDubbo`、`DubboComponentScanRegistrar`、`DubboSpringInitializer`、`ServiceAnnotationPostProcessor`、`ServiceBean`、`ReferenceAnnotationBeanPostProcessor`、`ReferenceBean`、`ReferenceBeanManager`、`DubboConfigApplicationListener`、`DubboDeployApplicationListener`、`DubboAutoConfiguration`。✅
- 去掉代码块后正文仍成立：是。✅
- 叙述性正文字符数（不含代码块与空白行）：约 `15,102`。  
- 目标定位：Dubbo 集成层接入桥篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 `@DubboService` / `@DubboReference` 从“注解使用方式”提升到“Spring 世界进入 Dubbo runtime 的桥接链”，让读者看清 `ServiceBean`、`ReferenceBean`、`ReferenceBeanManager`、deployer 和 Boot 自动配置各自处在什么位置，以及为什么它们并没有重写 Dubbo 主线，只是在接入层把它接进 Spring 容器。