# Dubbo：ScopeModel、ApplicationModel 与生命周期主线 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch06-dubbo-runtime`
- 篇：`07 ScopeModel、ApplicationModel 与生命周期主线`
- 对应主题：`D-MAIN-0 Runtime Skeleton and Lifecycle`
- 文章类型：主干运行时收束篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：前面的几篇已经分别讲了 export/refer、Invoker 窄腰、consumer 流量主线、remoting 网络和 SPI 扩展机制，但这些东西看起来仍然像若干平行机制：`ServiceConfig`、`ReferenceConfig`、`ExtensionLoader`、`ConfigManager`、Spring listeners、registry/export/refer 都各自存在。读者真正还没完全想透的是：Dubbo 3.x 到底靠什么把它们装进一个统一的 runtime？为什么 3.x 要引入 `FrameworkModel / ApplicationModel / ModuleModel / ScopeModel` 这一整套模型层？
- 一句话顿悟：Dubbo 3.x 的 model/lifecycle 体系不是“多加几层对象”，而是 runtime 的总骨架：`ScopeModel` 给每个作用域配上 scoped `ExtensionDirector`、`ScopeBeanFactory` 和 destroy 边界，`FrameworkModel / ApplicationModel / ModuleModel` 负责分层拥有 SPI、config、service repository 和 deployer，`DefaultApplicationDeployer` / `DefaultModuleDeployer` 则把 export/refer/metadata/registry 注册这些动作收进统一状态机。前面所有篇章里分散的主线，都是被它们重新收束起来的。
- 文章边界：本篇重点讲 model 树、deployer 状态机、scoped SPI、配置与服务仓库的挂接、Spring 如何接回 deployer 生命周期，以及 destroy 顺序；不重讲 `ServiceConfig.doExport()` / `ReferenceConfig.createProxy()` 的具体流程，不重讲 SPI 细节本身，不展开 remoting/registry/cluster 算法。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/01-serviceconfig-referenceconfig-export-refer.md`
- `ch06-dubbo-runtime/05-extensionloader-adaptive-activate-spi.md`
- `ch07-dubbo-integration/01-spring-springboot-integration-bootstrap.md`

### SOFT

- 不要求先懂 Spring 全量生命周期。
- 不要求先懂所有 ScopeModel 扩展点。

### NAV

- 后续可接：Dubbo 生产层（registry/config/metadata 失配排障）
- 后续可接：ScopeModel / 多应用隔离专题

## 一句话困惑

Dubbo 3.x 为什么要引入 `FrameworkModel / ApplicationModel / ModuleModel / ScopeModel` 这一套层次？它们和 export/refer、SPI、ConfigManager、Spring 接桥之间到底是什么关系？

## 一句话顿悟

这些 model 不是附属对象，而是 Dubbo runtime 的拥有权结构：谁拥有 SPI loader、谁拥有 config、谁拥有 service repository、谁驱动 deployer 的 prepare/start/complete/stop、谁负责 destroy 边界，全部通过这一套模型树决定。它们解决的不是“代码怎么组织”，而是“一个进程里能不能安全地同时承载多套 Dubbo runtime，以及这些 runtime 在启动和销毁时谁先谁后”。

## 读者理解路径

1. 先否定“Model 只是为了分层命名”的理解。
2. 建立最小总图：`FrameworkModel -> ApplicationModel -> ModuleModel -> ScopeModel`，以及每层挂的 SPI / config / repository / deployer。
3. 解释为什么 Dubbo 3.x 不能继续沿用过去更偏全局单例的 runtime。
4. 解释 `ScopeModel`：scoped bean factory、ExtensionDirector、destroy contract。
5. 解释 `FrameworkModel` / `ApplicationModel` / `ModuleModel`：谁拥有谁，谁共享谁。
6. 解释 `DefaultApplicationDeployer` / `DefaultModuleDeployer` 的启动时间线和状态机。
7. 解释前几篇内容如何重新收束：export/refer、SPI、Spring、config 都回到这套 model/lifecycle 上。
8. 收束到：这一篇不是新机制，而是整卷的“总时钟”和“总骨架”。

## 失败方案推演

### 失败方案一：Model 只是把类分层，和运行时语义无关

- 如果只是分层命名，就不需要 `ExtensionDirector`、`ScopeBeanFactory`、destroy listeners、deployer、service repository 都挂在 model 上。
- 实际上这些 model 决定了扩展实例的作用域、配置的归属、服务仓库的边界以及启动/销毁顺序。
- 所以它们不是命名层，而是 runtime ownership 层。

### 失败方案二：Dubbo 3.x 只是把原来的全局单例拆成更多对象，语义没变

- 如果语义没变，多 Application / 多 Module 的隔离与生命周期协调就不需要重新设计。
- `ApplicationModel` 注释明确说明旧时代很多能力是单例/进程级的，这正是 3.x 要解决的问题。
- 所以这不是简单重构，而是 runtime 作用域模型的重建。

### 失败方案三：Spring 生命周期就是 Dubbo 生命周期

- Spring 只是桥接入口。真正 export/refer、prepare/start/complete/stop 仍然由 deployer 驱动。
- `DubboConfigApplicationListener` 和 `DubboDeployApplicationListener` 只是把 Spring 事件接回 Dubbo deployer，而不是替代它。
- 所以 Spring 生命周期和 Dubbo 生命周期是桥接关系，不是覆盖关系。

## 必须澄清的误解

1. `ApplicationModel` 不是“整个 JVM 只有一个”的代名词，它挂在 `FrameworkModel` 下，且 Framework 允许多 application。
2. `ModuleModel` 不是 Maven module，也不是 Java 9 module，而是 Dubbo 的运行时服务分组作用域。
3. `STARTED` 和 `COMPLETION` 不是重复状态，前者表示已启动，后者表示 export/refer 后续动作也完成了。
4. `DubboBootstrap.start()` 只是 facade，真正时间线在 application/module deployer。
5. Spring integration 不是第二套 runtime，而是把 Spring 事件接回 model/deployer 主线。

## 文章结构与字数预算

1. 困惑开场：为什么 Dubbo 3.x 多了这么多 Model（800-1000 字）
2. 最小总图：Framework/Application/Module/Scope 与 deployer 骨架（1000-1400 字）
3. `ScopeModel`：scoped SPI、bean factory、destroy contract（1400-2000 字）
4. `FrameworkModel` / `ApplicationModel` / `ModuleModel` 的拥有权关系（1600-2200 字）
5. `DefaultApplicationDeployer` / `DefaultModuleDeployer` 的启动状态机（1800-2400 字）
6. 前面几篇如何回到这条骨架上收束（1200-1600 字）
7. destroy 顺序与多应用隔离（1000-1400 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

### model tree
- `dubbo-common/src/main/java/org/apache/dubbo/rpc/model/ScopeModel.java:42` — ScopeModel 定位
- `ScopeModel.java:100` — 初始化 ExtensionDirector / ScopeBeanFactory
- `ScopeModel.java:117` — destroy 主流程
- `dubbo-common/src/main/java/org/apache/dubbo/rpc/model/FrameworkModel.java:40` — FrameworkModel 可承载多个 application
- `FrameworkModel.java:101` — internal application model
- `dubbo-common/src/main/java/org/apache/dubbo/rpc/model/ApplicationModel.java:40` — 旧单例问题与 3.x 动机
- `ApplicationModel.java:53` — application-level fields
- `ApplicationModel.java:111` — internal module
- `dubbo-common/src/main/java/org/apache/dubbo/rpc/model/ModuleModel.java:40` — module-level fields
- `ModuleModel.java:82` — 创建时通知 application deployer module pending

### deployer attachment / state
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ConfigScopeModelInitializer.java:39` — 给 app/module 挂 deployer
- `dubbo-common/src/main/java/org/apache/dubbo/common/deploy/DeployState.java:22` — 状态枚举
- `dubbo-common/src/main/java/org/apache/dubbo/common/deploy/AbstractDeployer.java:35` — 状态机基础实现
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/deploy/DefaultApplicationDeployer.java:209` — initialize
- `DefaultApplicationDeployer.java:676` — start
- `DefaultApplicationDeployer.java:764` — startModules
- `DefaultApplicationDeployer.java:1185` — 从 module 状态推导 application 状态
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/deploy/DefaultModuleDeployer.java:162` — startSync
- `DefaultModuleDeployer.java:176` — exportServices
- `DefaultModuleDeployer.java:186` — referServices
- `DefaultModuleDeployer.java:189` — module completion 相关时序

### scoped SPI / Spring bridge / config managers
- `dubbo-common/src/main/java/org/apache/dubbo/common/extension/ExtensionDirector.java:27` — scoped extension loader manager
- `ExtensionDirector.java:67` — scope-based loader resolution
- `dubbo-common/src/main/java/org/apache/dubbo/rpc/model/ScopeModelAwareExtensionProcessor.java:32` — model-aware injection规则
- `dubbo-common/src/main/java/org/apache/dubbo/config/context/ConfigManager.java:53` — ApplicationExt config manager
- `dubbo-common/src/main/java/org/apache/dubbo/config/context/ModuleConfigManager.java:56` — ModuleExt config manager
- `ModuleConfigManager.java:314` — module -> application config delegation
- `dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/DubboConfigApplicationListener.java:84` — Spring 触发 prepare
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ServiceConfig.java:324` — ServiceConfig 进入 deployer lifecycle
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ReferenceConfig.java:228` — ReferenceConfig 进入 deployer lifecycle

## 测试证据清单

- `dubbo-config/dubbo-config-api/src/test/java/org/apache/dubbo/config/ConfigScopeModelInitializerTest.java:45` — app/module deployer 挂接
- `dubbo-common/src/test/java/org/apache/dubbo/rpc/model/FrameworkModelTest.java:29` — framework/application 关系
- `dubbo-common/src/test/java/org/apache/dubbo/rpc/model/ApplicationModelTest.java:40` — application/module 关系
- `dubbo-common/src/test/java/org/apache/dubbo/rpc/model/ModuleModelTest.java:33` — module lifecycle
- `dubbo-common/src/test/java/org/apache/dubbo/common/extension/ExtensionDirectorTest.java:40` — scoped SPI 继承
- `ExtensionDirectorTest.java:155` — data isolation
- `dubbo-common/src/test/java/org/apache/dubbo/rpc/model/ScopeModelAwareExtensionProcessorTest.java:46` — scope-aware injection

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇聚焦 3.x model/lifecycle 主线，不回头展开 2.x 旧全局模式兼容历史。
- Spring Boot / Spring 只作为桥接点引用，不再展开具体接桥细节（前篇已覆盖）。

## 与其他篇的边界

### 本篇要讲清

- model 树和 deployer 状态机。
- scoped SPI / config / repository 的拥有权边界。
- export/refer、Spring、SPI 为何都要回到 model/deployer 收束。
- destroy 顺序与多应用隔离。

### 本篇不深讲

- `ServiceConfig.doExport()` / `ReferenceConfig.createProxy()` 细节。
- SPI 的扫描/Adaptive/Activate 细节。
- remoting/network 主线。
- cluster / registry / routing 算法。

## 写作后检查

- [ ] 开篇先抓“为什么要多出这么多 Model”，而不是直接讲类继承图。
- [ ] 至少展开 3 个失败方案，且包含“Spring 生命周期就是 Dubbo 生命周期”“Model 只是分层命名”。
- [ ] 明确给出 model/deployer 总图。
- [ ] 不把本篇写成 ScopeModel 字段说明书。
- [ ] 每个 lifecycle 结论都落到 file:line 和测试证据。
- [ ] 删除代码块后，读者仍能复述 model 树、deployer 状态机和收束关系。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。