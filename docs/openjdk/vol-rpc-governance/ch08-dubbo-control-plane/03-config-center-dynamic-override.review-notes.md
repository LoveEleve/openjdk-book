# Dubbo：Config Center / Dynamic Override — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `DefaultApplicationDeployer.initialize()` 会启动 config center，构造 `DynamicConfiguration` 组合并放入 `Environment`，证据：`dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/deploy/DefaultApplicationDeployer.java:224`、`:298`、`:308`。
2. `DefaultGovernanceRuleRepositoryImpl` 只是 `DynamicConfiguration` 的薄封装，`addListener()` / `getRule()` 都委托给当前 `moduleModel.modelEnvironment().getDynamicConfiguration()`，证据：`dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/governance/DefaultGovernanceRuleRepositoryImpl.java:32`、`:56`。
3. `AbstractConfiguratorListener.initWith(key)` 会先注册 listener，再拉一次当前规则；`process(...)` 会在规则变化时解析 raw rule 并调用 `notifyOverrides()`，证据：`dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/AbstractConfiguratorListener.java:73`、`:85`、`:104`、`:121`。
4. `Configurator.toConfigurators(...)` 负责把 rule URL 排序并通过 adaptive `ConfiguratorFactory` 转成 executable configurators，证据：`dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/Configurator.java:70`、`:99`。
5. `AbstractConfigurator.configure(...)` 先做 URL/host/side/condition match，再应用覆盖逻辑，说明 configurator 是条件性的 URL 变换器，证据：`dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/configurator/AbstractConfigurator.java:70`、`:125`、`:159`。
6. `OverrideConfigurator` 的语义是覆盖现有参数，而 `AbsentConfigurator` 只补缺失值，证据：`dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/configurator/override/OverrideConfigurator.java:34`。
7. 在传统 registry 路径中，`RegistryDirectory.notify()` 会先处理 registry `configurators` category，再在 `refreshOverrideAndInvoker()` 中重算 `directoryUrl` 并刷新 invokers，证据：`dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:217`、`:257`、`:652`。
8. 在 service-discovery 路径中，`ServiceDiscoveryRegistryDirectory` 会通过 `overrideDirectoryWithConfigurator()` 和 `OverrideInstanceAddressURL` 改写 consumer URL 与 instance-derived provider URL，证据：`dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/ServiceDiscoveryRegistryDirectory.java:220`、`:270`、`OverrideInstanceAddressURL.java:117`、`:166`。
9. provider 侧也会走 configurator 覆盖；当 export URL 确实变化时，`RegistryProtocol.OverrideListener.doOverrideIfNecessary()` 会触发 `reExport(...)`，证据：`dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:895`、`:900`。
10. 动态覆盖与地址更新不同：前者即使 provider URL 列表不变，也可能让 `directoryUrl`、provider invoker URL 或 provider export URL 变化，证据链见 `RegistryDirectory.java:257`、`ServiceDiscoveryRegistryDirectory.java:220`、`RegistryProtocol.java:895`。

### 测试证据已核对

1. `OverrideConfiguratorTest.java:39` — override 规则的 host/side/app-name 等匹配语义。
2. `AbsentConfiguratorTest.java:31` — absent 只补缺失值。
3. `ConfiguratorTest.java:42` — configurator 的排序与优先级。
4. `ZookeeperDynamicConfigurationTest.java:113` — `*.configurators` 监听变化事件。
5. `NacosDynamicConfigurationTest.java:79` — 另一种 backend 下相同行为。

### 深审发现

1. **高风险：容易把 config center 动态规则写成上一章静态 merge 的延伸。** 当前正文已明确区分“来源层 merge”和“运行中治理平面”。  
2. **高风险：容易把 configurator 影响理解成 consumer 独有。** 当前正文已补 provider-side re-export。  
3. **中风险：容易忽略 registry configurators 与 config-center 规则在运行时是同一抽象。** 当前正文已压回 `Configurator`。  
4. **中风险：容易把地址不变误判成行为不变。** 当前正文已把 `directoryUrl`、invoker URL、export URL 三个 override 位置拆开。  
5. **低风险：容易把 `OverrideInstanceAddressURL` 当普通 URL wrapper。** 当前正文已强调它保持 instance identity 同时覆盖参数语义。  

## 第二轮：因果审

- config center 必须先进入 `DynamicConfiguration` / `Environment`，否则治理 listener 没有统一规则来源：✅
- configurator 必须是条件性 URL 变换器，而不是直接改 invoker 对象，否则无法保持与 registry/config-center 两套来源的统一抽象：✅
- consumer 侧必须重新计算 `directoryUrl` 和 provider URL，否则动态规则无法进入 router/cluster/live invoker 选择：✅
- provider 侧必须在 export URL 改变时触发 re-export，否则控制面规则只会“看起来存在”，却不会改到真实对外服务：✅
- registry `configurators` 与 config-center rules 必须收敛到同一 `Configurator` 抽象，否则两套治理来源会形成两套不兼容 runtime 行为：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → 动态覆盖总图 → DynamicConfiguration / GovernanceRuleRepository → AbstractConfiguratorListener → Configurator 抽象 → consumer override → provider re-export → 误解澄清 → 收网总结”推进，没有退化成 config-center 接入手册。

失败方案已覆盖：
- config center 只是启动期配置来源  
- 地址不变行为就不该变  
- configurator 只影响 consumer  

每一层拆解均包含：规则来源 → 规则解析 → URL 覆盖 → runtime 生效边界，符合控制面治理篇要求。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- config center 动态规则如何进入 Dubbo runtime  
- configurator 如何统一 consumer/provider 的 URL 覆盖  
- registry configurators 与 config-center rules 为什么会在同一抽象层汇合  
- 为什么地址不变但行为会变  
- provider 何时会触发 re-export  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重讲静态配置 merge（上一章已覆盖）。✅
- 未重讲 registry 地址更新基础链（上一篇已覆盖）。✅
- 未重讲 service-discovery migration。✅
- 未展开具体 vendor backend 实现细节。✅
- 重点仍压在治理平面如何改写 live runtime 语义，边界收得住。✅

## 第六轮：依赖审

- 已承接 Dubbo 配置 merge 篇：config center 在这里不是来源层，而是运行中的治理平面。✅
- 已承接 registry/control-plane 篇：本篇补地址不变时的 runtime 语义变化。✅
- `OverrideConfiguratorTest`、`AbsentConfiguratorTest`、动态配置 listener tests 足以支撑“URL 覆盖器”这一抽象。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。
- 代码块：使用少量控制面总图，不承担主叙事骨架。
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `DefaultApplicationDeployer`、`DefaultGovernanceRuleRepositoryImpl`、`AbstractConfiguratorListener`、`Configurator`、`OverrideConfigurator`、`RegistryDirectory`、`ServiceDiscoveryRegistryDirectory`、`OverrideInstanceAddressURL`、`RegistryProtocol.OverrideListener`。
- 去掉代码块后正文仍成立：是。
- 叙述性正文字符数（不含代码块与空白行）：约 `13,394`。
- 目标定位：Dubbo config-center / dynamic-override 控制面篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 Dubbo config center 从“又一个配置来源”提升到“独立于地址发现的治理平面”，讲清规则文本如何变成 `Configurator`，再怎样重新作用到 consumer `directoryUrl`、provider invoker URL 和 provider export URL 上，从而解释“地址不变但行为改变”的运行时现象。