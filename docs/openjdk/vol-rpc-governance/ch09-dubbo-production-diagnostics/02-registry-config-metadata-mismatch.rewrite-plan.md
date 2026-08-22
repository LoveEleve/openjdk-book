# Dubbo：Registry / Config / Metadata 失配问题分析 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch09-dubbo-production-diagnostics`
- 篇：`02 Registry / Config / Metadata 失配问题分析`
- 对应主题：`D-PROD-2 Control Plane / Runtime Mismatch Diagnostics`
- 文章类型：生产诊断控制面篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：线上最让人无从下手的一类 Dubbo 问题，不是“有异常栈”，而是“控制面说一套，运行态表现另一套”。registry 明明有 provider 地址，consumer 却打不到；config center 明明推送了规则，行为却没变；metadata 明明更新了，consumer 却还像旧模型；新 provider 明明已经上线，但流量还是走旧 invoker。读者最大的困惑是：这些现象到底卡在哪个对象上？是 registry URL list、directoryUrl、router chain、invoker map、currentAvailableInvoker，还是 instance metadata？
- 一句话顿悟：Dubbo 的控制面不是单条链，而是多条更新链在运行态对象图里交汇：registry 改 provider URL 集合，config center 改 configurator 语义，metadata 改 service-discovery instance 视图，migration 规则改 `currentAvailableInvoker` 指向；因此“控制面已经变了”不等于“当前调用一定已经体现这个变化”，排障要先搞清哪个运行态对象已经变、哪个还没变。
- 文章边界：本篇重点讲 registry / configurator / metadata / migration 失配的几类典型现场，串起 `RegistryDirectory`、`ServiceDiscoveryRegistryDirectory`、`MigrationInvoker`、`ServiceInstancesChangedListener`、`AbstractConfiguratorListener` 这些对象在运行态里各自代表什么；不重新展开 registry/vendor 适配器、config center backend 细节，不重讲前面三篇控制面主线。

## 前置依赖

### HARD

- `ch08-dubbo-control-plane/01-registryprotocol-registrydirectory-address-update.md`
- `ch08-dubbo-control-plane/02-service-discovery-migration.md`
- `ch08-dubbo-control-plane/03-config-center-dynamic-override.md`

### SOFT

- 不要求先懂具体 registry vendor。
- 不要求先懂 metadata publish 全量细节。

### NAV

- 后续可接：Dubbo metadata/reporting 专题
- 后续可接：Dubbo 控制面生产排障总篇

## 一句话困惑

为什么控制面明明已经变了，运行态却还表现成旧的样子？到底是哪一个对象没跟上：地址列表、directoryUrl、invoker map、router chain，还是 migration 当前生效的 invoker 子树？

## 一句话顿悟

排这种问题，不能只问“控制面有没有推到”，而要问“哪一个运行态对象已经变、哪一个还没变”：`RegistryDirectory` 的 `urlInvokerMap`、`directoryUrl`、`cachedInvokerUrls`，`ServiceInstancesChangedListener` 的 `serviceUrls`，`MigrationInvoker` 的 `currentAvailableInvoker`，以及 provider 侧 export URL，它们更新时间不同、语义也不同。

## 读者理解路径

1. 先否定“控制面推送成功 = 运行态已经切好”的直觉。
2. 建立最小总图：registry / config center / metadata / migration 分别改写哪个 runtime 对象。
3. 解释 registry 有地址但调不通的几个断点。
4. 解释 config center 规则已推但行为没变的几个断点。
5. 解释 metadata 已更新但服务发现仍像旧模型的几个断点。
6. 解释新 provider 已上线但仍走旧路径的几个断点。
7. 收束到：排障时要先确认“是哪个对象没更新”，再问它为什么没更新。

## 失败方案推演

### 失败方案一：控制面推送成功，就等于运行态已经切换成功

- 这会把“收到事件”和“对象图完成切换”混为一谈。
- 实际上配置中心、registry、metadata 和 migration 各有自己的 listener、缓存、双链或双树切换步骤。
- 所以“控制面已推到”只是开始，不是结束。

### 失败方案二：registry 有地址，consumer 就应该能调通

- provider URL list 只是上游输入，不是最终可调集合。
- 还要经过协议兼容检查、invoker refer、router 裁剪、forbidden/empty protection、本地 availability 过滤。
- 所以“registry 里有地址”不等于“调用时还有可用 invoker”。

### 失败方案三：metadata 更新后，流量会立刻切到新模型

- migration 允许双路径共存，`currentAvailableInvoker` 未必马上切换。
- service discovery 路径也可能还卡在 mapping、metadata 拉取、serviceUrls 构造、notifyAddressChanged 的某一层。
- 所以“metadata 已经更新”不等于“这次调用已经走新路径”。

## 必须澄清的误解

1. 控制面与运行态失配，不一定是“配置没推到”，更可能是“推到了，但还没切到某个对象层”。
2. `urlInvokerMap`、`directoryUrl`、`currentAvailableInvoker` 是三个不同层次的运行态对象，不能混为一谈。
3. registry 空地址、EMPTY_PROTOCOL、router 裁空、service discovery 无 metadata，都可能表现成“打不到 provider”，但断点不同。
4. migration 切换的是 invoker 子树，不是业务 proxy 本身。
5. config center 改的是 URL 语义，地址不变也足够让运行时行为变化。

## 文章结构与字数预算

1. 困惑开场：控制面和运行态为什么会“各说各话”（800-1000 字）
2. 最小总图：四条控制面链各自改哪个对象（1000-1400 字）
3. registry 有地址但调不通（1600-2200 字）
4. config center 已推但行为没变（1400-2000 字）
5. metadata 已更新但仍像旧模型（1400-2000 字）
6. 新 provider 已上线但仍走旧 invoker（1400-2000 字）
7. 误解澄清与排障对象表（1000-1400 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:200` — notify
- `RegistryDirectory.java:257` — refreshOverrideAndInvoker
- `RegistryDirectory.java:337` — newUrlInvokerMap 构造
- `RegistryDirectory.java:363` — refreshRouter / setInvokers
- `RegistryDirectory.java:371` — destroyUnusedInvokers
- `RegistryDirectory.java:560` — 协议兼容检查
- `RegistryDirectory.java:476` — protocol.refer 失败路径
- `RegistryDirectory.java:278` — EMPTY_PROTOCOL / forbidden
- `RegistryDirectory.java:293` — empty protection
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/AbstractConfiguratorListener.java:85` — process config changed
- `AbstractConfiguratorListener.java:104` — parse rules
- `RegistryDirectory.java:652` — overrideWithConfigurator
- `RegistryProtocol.java:895` — provider-side override
- `RegistryProtocol.java:900` — reExport
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/ServiceDiscoveryRegistry.java:199` — subscribe path
- `ServiceDiscoveryRegistry.java:234` — no mapping no subscribeURLs
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/event/listener/ServiceInstancesChangedListener.java:143` — onEvent
- `ServiceInstancesChangedListener.java:185` — metadata missing / retry
- `ServiceInstancesChangedListener.java:460` — notifyAddressChanged
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/migration/MigrationInvoker.java:64` — old/new/current invoker
- `MigrationInvoker.java:285` — APPLICATION_FIRST invoke path
- `MigrationInvoker.java:315` — service-discovery invoker unavailable fallback
- `MigrationRuleListener.java:160` — rule fan-out
- `MigrationRuleHandler.java:47` — rule -> migrate dispatch

## 测试证据清单

- `MigrationInvokerTest.java:103`
- `MigrationRuleHandlerTest.java:41`
- `MigrationRuleListenerTest.java:82`
- `ServiceDiscoveryRegistryTest.java:125`
- `ServiceInstancesChangedListenerTest.java:214`
- `ServiceInstancesChangedListenerWithoutEmptyProtectTest.java:76`
- `OverrideConfiguratorTest.java:39`

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇聚焦控制面与运行态对象失配，不展开具体 vendor 实现。
- metadata 只讲它如何影响服务发现路径，不展开上报细节。

## 与其他篇的边界

### 本篇要讲清

- 控制面变化分别改写哪些 runtime 对象。
- 为什么“控制面变了”与“行为变了”之间会有时滞或分叉。
- 典型失配症状的源码断点。

### 本篇不深讲

- registry / config center / migration 的基础机制（前面三篇已覆盖）。
- router/loadbalance/cluster 算法。
- 具体 metadata 存储和上报实现。

## 写作后检查

- [ ] 开篇先抓“控制面和运行态各说各话”的排障痛点。
- [ ] 至少展开 3 个失败方案，且包含“控制面已推到=已生效”“registry 有地址=一定能调”。
- [ ] 明确给出“对象层失配”总图。
- [ ] 不把本文写成几个子系统的复述拼盘。
- [ ] 每个断点都落到具体对象和 file:line。
- [ ] 删除代码块后，读者仍能复述失配排障应该先看哪个对象。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。