# Dubbo：Registry / Config / Metadata 失配问题分析 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `RegistryDirectory.notify()` 是传统 registry 路径的控制面入口，会把通知按 configurators / routers / providers 分桶，证据：`dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:200`、`:206`、`:217`、`:219`、`:224`。
2. `refreshOverrideAndInvoker()` 会先重算 `directoryUrl` 再进入 `refreshInvoker()`，说明 configurator 覆盖和 invoker 刷新是顺序相关的，证据：`RegistryDirectory.java:257`。
3. `refreshInvoker()` 负责 forbid、empty-protection、URL 去重、invoker map 构造、router 刷新、切换与销毁，证据：`RegistryDirectory.java:278`、`:293`、`:315`、`:337`、`:363`、`:371`。
4. 协议兼容检查和 `protocol.refer()` 失败都会让 provider URL 无法落成 live invoker，证据：`RegistryDirectory.java:560`、`:476`。
5. `AbstractConfiguratorListener` 通过 `GovernanceRuleRepository` 监听远程规则，规则变更经过 `process()` 和 `parseConfigurators()` 变成 `Configurator`，证据：`dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/AbstractConfiguratorListener.java:73`、`:85`、`:104`。
6. `RegistryDirectory.overrideWithConfigurator(...)` 会把 configurator 叠加到 provider URL 和 consumer directory URL 上，证据：`RegistryDirectory.java:652`。
7. provider 侧 `RegistryProtocol.OverrideListener.doOverrideIfNecessary()` 在 export URL 真正变化时会触发 `reExport(...)`，证据：`dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:895`、`:900`。
8. service-discovery 路径不是直接得到 provider URL，而是 `ServiceDiscoveryRegistry -> ServiceInstancesChangedListener -> InstanceAddressURL -> ServiceDiscoveryRegistryDirectory` 这条链，证据：`dubbo-registry/.../ServiceDiscoveryRegistry.java:199`、`:234`、`ServiceInstancesChangedListener.java:143`、`:460`、`InstanceAddressURL.java:48`、`ServiceDiscoveryRegistryDirectory.java:197`、`:463`。
9. `MigrationInvoker` 同时持有旧路径、新路径和当前生效路径，迁移切的是 `currentAvailableInvoker` 指向，而不是业务 proxy 本身，证据：`dubbo-registry/.../MigrationInvoker.java:64`、`:285`、`:315`。
10. `RegistryProtocol` 默认 `getMigrationInvoker(...)` 返回 `ServiceDiscoveryMigrationInvoker`，说明默认实现对 service-discovery 有偏置，证据：`RegistryProtocol.java:601`。

### 测试证据已核对

1. `MigrationInvokerTest.java:103` — dual-path coexistence 与切换。
2. `MigrationRuleHandlerTest.java:41` — 规则到切换动作，失败时不推进 step。
3. `MigrationRuleListenerTest.java:82` — 规则监听与 fan-out。
4. `ServiceDiscoveryRegistryTest.java:125` — mapping 缺失时不进入新路径订阅。
5. `ServiceInstancesChangedListenerTest.java:214` — 实例/metadata 聚合。
6. `ServiceInstancesChangedListenerWithoutEmptyProtectTest.java:76` — empty-protection 差异。
7. `OverrideConfiguratorTest.java:39` — configurator 匹配与 override 语义。

### 深审发现

1. **高风险：容易把“控制面推送成功”误写成“运行态已切换完成”。** 当前正文已按 `directoryUrl`、`urlInvokerMap`、`serviceUrls`、`currentAvailableInvoker` 四类对象拆开。  
2. **高风险：容易把 registry 有地址直接等同于可调用。** 当前正文已拆出协议检查、refer 失败、router 裁空、forbidden/empty-protection 等断点。  
3. **中风险：容易把 config center 规则理解成静态配置 merge 的延伸。** 当前正文已强调 listener 驱动的治理平面。  
4. **中风险：容易把 metadata 变更理解成新路径立即生效。** 当前正文已把 mapping、metadata 拉取、serviceUrls、migration 壳切换拉成链。  
5. **低风险：容易忽略默认 service-discovery 偏置与 plain `MigrationInvoker` 的解释价值。** 当前正文已明确指出。  

## 第二轮：因果审

- registry 地址变更和 configurator/metadata/migration 规则变更必须分开看，否则控制面多个来源会被误判成一个总状态：✅
- `directoryUrl`、provider invoker URL、`serviceUrls` 和 `currentAvailableInvoker` 必须分别建模，否则“控制面说 X、运行态表现 Y”的失配无法定位：✅
- migration 必须维持壳不变、子树切换，否则业务 proxy 层会因为规则变化频繁替换对象：✅
- provider re-export 必须作为动态 override 的一部分看待，否则地址不变时的 provider 行为变化会被误判成 consumer 问题：✅
- empty-protection 必须存在，否则 registry 抖动会把 consumer 瞬时打空：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → 对象层失配总图 → registry 有地址但调不通 → config center 已推但行为没变 → metadata 已更新但仍像旧模型 → 新 provider 已上线但仍走旧路径 → 误解澄清 → 收网总结”推进，没有退化成前面三篇的简单复述拼盘。

失败方案已覆盖：
- 控制面推送成功 = 运行态切换成功  
- registry 有地址 = 一定能调  
- metadata 更新 = 立刻像新模型  

每一层拆解都落在“哪个运行态对象没跟上”这条诊断主线，符合控制面失配篇定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- 四类控制面分别改哪些 runtime 对象  
- registry 地址、config center 规则、metadata、migration 规则为什么不会同时生效  
- `urlInvokerMap` / `directoryUrl` / `serviceUrls` / `currentAvailableInvoker` 的区别  
- 为什么“控制面已变”不等于“当前调用已体现变化”  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重讲 registry 地址更新基础链（上一篇已覆盖）。✅
- 未重讲 service discovery / migration 基础机制（上一篇已覆盖）。✅
- 未重讲静态配置 merge（配置篇已覆盖）。✅
- 未展开具体 registry vendor / metadata publish 后端。✅
- 重点仍压在控制面与 runtime 对象的失配诊断，边界收得住。✅

## 第六轮：依赖审

- 已承接 Dubbo registry/control-plane 三篇，把它们重新收成“对象层失配”这一篇。✅
- 已承接 Dubbo 生产诊断第一篇：本篇继续扩大“最终现象不等于原始来源”的诊断方法，但换成控制面对象视角。✅
- `MigrationInvokerTest`、`ServiceDiscoveryRegistryTest`、`OverrideConfiguratorTest` 等足以支撑本文关键断点。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。
- 代码块：使用少量对象图，不承担主叙事骨架。
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `RegistryDirectory`、`AbstractConfiguratorListener`、`RegistryProtocol.OverrideListener`、`ServiceDiscoveryRegistry`、`ServiceInstancesChangedListener`、`MigrationInvoker`、`MigrationRuleListener`、`MigrationRuleHandler`。
- 去掉代码块后正文仍成立：是。
- 叙述性正文字符数（不含代码块与空白行）：约 `13,394`。
- 目标定位：Dubbo 控制面失配诊断篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 Dubbo 控制面问题从“哪个中心推了什么”提升到“哪个运行态对象没跟上”的诊断模型，让读者能从 registry、config center、metadata、migration 四条链回到 `directoryUrl`、`urlInvokerMap`、`serviceUrls`、`currentAvailableInvoker` 这些真正会影响调用结果的对象上来。