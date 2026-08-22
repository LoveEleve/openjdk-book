# Dubbo：ScopeModel、ApplicationModel 与生命周期主线 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `ScopeModel` 不是业务模型，而是 scoped runtime 容器；它在初始化时创建 `ExtensionDirector` 与 `ScopeBeanFactory`，在销毁时统一销毁 bean factory 和 extension director，证据：`dubbo-common/src/main/java/org/apache/dubbo/rpc/model/ScopeModel.java:42`、`:100`、`:117`。
2. `FrameworkModel` 明确可承载多个 application，并创建 internal application model，证据：`dubbo-common/src/main/java/org/apache/dubbo/rpc/model/FrameworkModel.java:40`、`:101`。
3. `ApplicationModel` 的类注释直接指出旧时代很多能力偏单例/进程级，这是 3.x model 重构的动机；它同时拥有环境、ConfigManager、ServiceRepository、ApplicationDeployer 和 internal module，证据：`dubbo-common/src/main/java/org/apache/dubbo/rpc/model/ApplicationModel.java:40`、`:53`、`:111`。
4. `ModuleModel` 拥有 `ModuleConfigManager`、`ModuleServiceRepository` 和 `ModuleDeployer`，并在创建时通知 application deployer module pending，证据：`dubbo-common/src/main/java/org/apache/dubbo/rpc/model/ModuleModel.java:40`、`:82`。
5. `ConfigScopeModelInitializer` 在 model 初始化时为 application/module 挂载 `DefaultApplicationDeployer` / `DefaultModuleDeployer`，证据：`dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ConfigScopeModelInitializer.java:39`。
6. `DefaultApplicationDeployer.initialize()` 负责 config center、application config、module deployer、metrics、metadata center 等应用级准备，证据：`dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/deploy/DefaultApplicationDeployer.java:209`。
7. `DefaultApplicationDeployer.start()` / `startModules()` 统一驱动模块启动，且 internal module 先于 public modules，证据：`DefaultApplicationDeployer.java:676`、`:764`、`:805`。
8. `DefaultModuleDeployer.startSync()` 的主时间线是：initialize → exportServices → prepareInternalModule → referServices → registerServices → completion，证据：`dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/deploy/DefaultModuleDeployer.java:162`、`:176`、`:186`、`:189`。
9. `DeployState` 明确定义 `PENDING / STARTING / STARTED / COMPLETION / STOPPING / STOPPED / FAILED`，`AbstractDeployer` 提供统一状态机实现，证据：`dubbo-common/src/main/java/org/apache/dubbo/common/deploy/DeployState.java:22`、`AbstractDeployer.java:35`。
10. `ExtensionDirector` 是 scoped extension loader manager，按 scope 和 parent/child 层次解析 extension loader，证据：`dubbo-common/src/main/java/org/apache/dubbo/common/extension/ExtensionDirector.java:27`、`:67`。
11. `ScopeModelAwareExtensionProcessor` 负责按可见范围注入 model，说明 scoped SPI 真正绑定到了 model 树上，证据：`dubbo-common/src/main/java/org/apache/dubbo/rpc/model/ScopeModelAwareExtensionProcessor.java:32`。
12. `ConfigManager` 是 ApplicationExt，`ModuleConfigManager` 是 ModuleExt，说明配置管理也被挂在 model 层次上，证据：`dubbo-common/src/main/java/org/apache/dubbo/config/context/ConfigManager.java:53`、`ModuleConfigManager.java:56`。
13. `ServiceConfig.export()` 和 `ReferenceConfig.get()` 在外部托管生命周期场景下都会先触碰 `getScopeModel().getDeployer().prepare()/start()`，证据：`dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ServiceConfig.java:324`、`ReferenceConfig.java:228`。
14. Spring 侧的 `DubboConfigApplicationListener` 和 `DubboDeployApplicationListener` 不是替代 runtime，而是把 Spring 事件接回 deployer：前者触发 `prepare()`，后者触发 `start()`，证据：`dubbo-config/dubbo-config-spring/src/main/java/org/apache/dubbo/config/spring/context/DubboConfigApplicationListener.java:84`、`DubboDeployApplicationListener.java:160`。
15. `ApplicationModel.onDestroy()` 和 `ModuleModel.onDestroy()` 明确规定了 destroy 顺序；`FrameworkModel.tryDestroyProtocols()` 对 protocol 销毁采取保守策略，证据：`ApplicationModel.java:145`、`ModuleModel.java:98`、`FrameworkModel.java:272`。

### 测试证据已核对

1. `ConfigScopeModelInitializerTest.java:45` — app/module deployer 挂接。
2. `FrameworkModelTest.java:29` — framework/application 关系。
3. `ApplicationModelTest.java:40` — application/module 关系。
4. `ModuleModelTest.java:33` — module lifecycle。
5. `ExtensionDirectorTest.java:40` — scoped SPI 继承。
6. `ExtensionDirectorTest.java:155` — data isolation。
7. `ScopeModelAwareExtensionProcessorTest.java:46` — scope-aware injection。

### 深审发现

1. **高风险：容易把 model 树写成命名层次，而不是 runtime ownership。** 当前正文已把 SPI、config、repository、deployer 都挂回 model 上，方向正确。  
2. **高风险：容易把 deployer 写成辅助类。** 当前正文已强调 deployer 是 export/refer/complete/stop 的总时钟，而不是 helper。  
3. **中风险：容易忽略 internal application/module 的意义。** 当前正文已指出它们承担内部服务和预备阶段的作用。  
4. **中风险：容易把 Spring 生命周期当成 Dubbo 生命周期。** 当前正文已把 listener 的桥接角色与 deployer 主线拆开。  
5. **低风险：容易把 STARTED 和 COMPLETION 当作重复状态。** 当前正文已明确二者区分。  

## 第二轮：因果审

- Dubbo 必须引入 model 树，否则多 application、多 module、scoped SPI 和分层 destroy 都无从成立：✅
- `ScopeModel` 必须先创建 `ExtensionDirector` 与 `ScopeBeanFactory`，否则 scoped SPI 和 scoped bean 生命周期无法挂接：✅
- deployer 必须作为 model 初始化的一部分挂上去，否则 export/refer 仍会退回“谁想调用就调用”的分散时序：✅
- `ApplicationDeployer` 与 `ModuleDeployer` 必须分层存在，否则 application-level 基础设施（config center、metadata center）与 module-level export/refer 无法分开协调：✅
- Spring 只能桥接 prepare/start，不能替代 deployer 主线，否则容器生命周期会和 Dubbo runtime 语义混成一团：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → model/deployer 总图 → ScopeModel → Framework/Application/Module 拥有权 → Deployer 状态机 → 前面主线如何收束 → destroy 顺序 → 误解澄清 → 收网总结”推进，没有退化成类继承图说明书。

失败方案已覆盖：
- Model 只是分层命名  
- 3.x 只是把全局单例拆成更多对象，语义没变  
- Spring 生命周期就是 Dubbo 生命周期  

每一层拆解均包含：拥有权边界 → 状态机时间线 → 与前面篇章的收束关系，符合 runtime skeleton 收束篇定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- `FrameworkModel -> ApplicationModel -> ModuleModel -> ScopeModel` 的层次关系  
- `ExtensionDirector`、config manager、repository、deployer 分别挂在哪层  
- `DefaultApplicationDeployer` / `DefaultModuleDeployer` 的启动时间线  
- 为什么 export/refer、SPI、Spring 都要回到这条 model/deployer 骨架上  
- destroy 顺序和多应用隔离的意义  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重讲 `ServiceConfig.doExport()` / `ReferenceConfig.createProxy()` 细节（前文已覆盖）。✅
- 未重讲 SPI 扫描/Adaptive/Activate 细节（SPI 篇已覆盖）。✅
- 未重讲 remoting/network 主线（remoting 篇已覆盖）。✅
- 未深入 registry/cluster/路由算法。✅
- 重点仍压在 model/deployer 作为总骨架，边界收得住。✅

## 第六轮：依赖审

- 已承接 export/refer、SPI、Spring 接桥几篇，把它们重新收束到同一条 ownership/lifecycle 主线上。✅
- `ConfigScopeModelInitializerTest`、model tests、`ExtensionDirectorTest` 足以支撑 model 树与 scoped SPI 的关键结论。✅
- 后续如进入 Dubbo 生产层或控制面层，这篇可以作为新的总时钟基线。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅
- 代码块：使用少量总图，不承担主叙事骨架。✅
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `ScopeModel`、`FrameworkModel`、`ApplicationModel`、`ModuleModel`、`ConfigScopeModelInitializer`、`DefaultApplicationDeployer`、`DefaultModuleDeployer`、`ExtensionDirector`、Spring listeners。✅
- 去掉代码块后正文仍成立：是。✅
- 叙述性正文字符数（不含代码块与空白行）：约 `14,327`。  
- 目标定位：Dubbo runtime skeleton 收束篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把前面分散出现的 export/refer、SPI、config、Spring 桥接和 destroy 逻辑重新收束到 Dubbo 3.x 的 model/lifecycle 骨架上，解释清楚：谁拥有运行时状态，谁驱动启动与完成，谁负责销毁，以及为什么 Dubbo 3.x 不再是“JVM 全局单例 + 松散初始化”的框架。