# Dubbo：Config Center / Dynamic Override — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch08-dubbo-control-plane`
- 篇：`03 Config Center / Dynamic Override`
- 对应主题：`D-CTRL-3 Config Center / Dynamic Override`
- 文章类型：控制面机制篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：前面两篇控制面文章已经分别讲了“地址变化如何进入 live runtime”和“新旧发现模型如何切换”，但读者在线上经常遇到另一类更诡异的问题：provider 地址根本没变，consumer 的行为却变了；或者服务端配置改了，旧连接还在，新的请求却已经开始表现出不同 timeout/loadbalance/router 结果。这类现象的根本原因不在地址本身，而在 configurator / dynamic override 这条控制面链。
- 一句话顿悟：Dubbo 把“地址更新”和“参数覆盖”分成两条控制面：registry/service-discovery 负责告诉你“有哪些目标”，config center / configurator 负责告诉你“这些目标该怎样被看待和使用”。运行时上，config-center 通过 `DynamicConfiguration` -> `GovernanceRuleRepository` -> `AbstractConfiguratorListener` 把规则文本转成 `Configurator` 列表，再把这些 configurator 重新应用到 consumer directory URL、provider URL 乃至 provider export URL 上，所以你会看到“地址没变但行为变了”的现象。
- 文章边界：本篇重点讲 config center 动态覆盖链路、`Configurator` 抽象、consumer directory URL / provider URL 的 override、provider 侧 re-export，以及 configurator 与地址更新链的交叉点；不展开具体 Nacos/Zookeeper/Apollo 适配器实现，不重讲静态配置 merge（上一章已覆盖），不展开 registry/vendor 细节。

## 前置依赖

### HARD

- `ch07-dubbo-integration/02-config-merge-externalization-url-generation.md`
- `ch08-dubbo-control-plane/01-registryprotocol-registrydirectory-address-update.md`
- `ch08-dubbo-control-plane/02-service-discovery-migration.md`

### SOFT

- 不要求先懂具体 config-center 中间件。
- 不要求先懂 metadata 全量实现。

### NAV

- 后续可接：Dubbo 生产控制面失配排障专题。
- 后续可接：metadata / governance 规则专题。

## 一句话困惑

为什么 provider 地址一点没变，Dubbo consumer / provider 的行为却变了？config center、configurator 和 registry 更新链到底是怎样交叉起来的？

## 一句话顿悟

地址更新解决“谁存在”，dynamic override 解决“怎么使用”。`AbstractConfiguratorListener` 从 config center 拿到规则文本，解析为 `Configurator`，再把它们覆盖到 consumer 侧 `directoryUrl`、invoker URL 和 provider export URL 上；因此地址不变时，timeout、loadbalance、router、tag、权重等行为仍然可能在下一次 invocation 中立刻变化。

## 读者理解路径

1. 先否定“地址没变，行为就不该变”的直觉。
2. 建立最小总图：config center -> DynamicConfiguration -> GovernanceRuleRepository -> Configurator -> Directory/Provider export URL override。
3. 解释 configurator 与 provider 地址更新的根本差异。
4. 解释 `AbstractConfiguratorListener` 如何监听并解析远程规则。
5. 解释 consumer 侧：如何重算 `directoryUrl`、provider URL 和 live invokers。
6. 解释 provider 侧：何时会触发 re-export。
7. 解释旧 registry `configurators` category 与新 config-center 规则如何在抽象层汇合到 `Configurator`。
8. 收束到：Dubbo 有一条独立于地址发现的治理平面。

## 失败方案推演

### 失败方案一：只要地址没变，consumer 行为就不该变

- 这会把“目标集合”和“目标参数语义”混成一层。
- 实际上 router、loadbalance、timeout、tag、weight 等都可能通过 configurator 变化，而 provider 地址完全不动。
- 所以地址不变，不代表调用语义不变。

### 失败方案二：config center 只是启动期配置来源

- 这会把它写成上一章“来源层”的延伸。
- 但动态覆盖不是一次性 merge，而是运行中的 listener + rule parsing + runtime reapply。
- 所以 config center 这里讨论的是治理平面，而不是静态配置来源。

### 失败方案三：configurator 只会影响 consumer

- 其实 provider export URL 也可能被 override，并触发 re-export。
- 也就是说 configurator 不是“客户端覆盖器”，而是作用于双方 runtime URL 语义的统一抽象。

## 必须澄清的误解

1. `Config center` 的动态规则不是静态配置 merge 的延长线，而是运行中 listener 驱动的治理平面。
2. configurator 更新不要求 provider 地址变化。
3. `directoryUrl` 被 override 与 provider URL 被 override 不是一回事。
4. 旧 registry `configurators` category 和新 config-center 规则虽然来源不同，但最终都会落到 `Configurator` 抽象上。
5. provider re-export 不是每次配置变化都发生，但一旦 export URL 变了就可能触发。

## 文章结构与字数预算

1. 困惑开场：为什么“地址没变但行为变了”最难排障（800-1000 字）
2. 最小总图：动态覆盖链路（1000-1400 字）
3. `DynamicConfiguration` / `GovernanceRuleRepository`：控制面规则来源（1200-1800 字）
4. `AbstractConfiguratorListener`：规则文本到 `Configurator`（1400-2000 字）
5. `RegistryDirectory` / `ServiceDiscoveryRegistryDirectory`：consumer 侧 override 生效（1800-2400 字）
6. provider 侧 override 与 re-export（1400-2000 字）
7. 旧 registry configurators 与新 config-center 规则的汇合（1000-1400 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/deploy/DefaultApplicationDeployer.java:224` — startConfigCenter
- `DefaultApplicationDeployer.java:298` — dynamic config composite
- `DefaultApplicationDeployer.java:308` — 存入 environment
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/governance/DefaultGovernanceRuleRepositoryImpl.java:32` — addListener
- `DefaultGovernanceRuleRepositoryImpl.java:56` — getRule
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/AbstractConfiguratorListener.java:73` — initWith/addListener/getRule
- `AbstractConfiguratorListener.java:85` — process config changed event
- `AbstractConfiguratorListener.java:104` — parseConfigurators
- `AbstractConfiguratorListener.java:121` — toConfigurators / notifyOverrides
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/Configurator.java:70` — toConfigurators
- `Configurator.java:99` — sort / factory use
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/configurator/AbstractConfigurator.java:70` — configure matching
- `AbstractConfigurator.java:125` — condition match
- `AbstractConfigurator.java:159` — v2.7 / v3 conditions
- `dubbo-cluster/src/main/java/org/apache/dubbo/rpc/cluster/configurator/override/OverrideConfigurator.java:34` — override semantics
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryDirectory.java:217` — registry configurator category
- `RegistryDirectory.java:257` — refreshOverrideAndInvoker
- `RegistryDirectory.java:652` — overrideWithConfigurator
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/ServiceDiscoveryRegistryDirectory.java:220` — refreshOverrideAndInvoker / overrideDirectoryWithConfigurator
- `ServiceDiscoveryRegistryDirectory.java:270` — override provider URL via `OverrideInstanceAddressURL`
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/OverrideInstanceAddressURL.java:117` — getParameter override
- `OverrideInstanceAddressURL.java:166` — parameter map merge
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:895` — provider-side doOverrideIfNecessary
- `RegistryProtocol.java:900` — reExport trigger

## 测试证据清单

- `dubbo-cluster/src/test/java/org/apache/dubbo/rpc/cluster/configurator/override/OverrideConfiguratorTest.java:39`
- `dubbo-cluster/src/test/java/org/apache/dubbo/rpc/cluster/configurator/absent/AbsentConfiguratorTest.java:31`
- `dubbo-cluster/src/test/java/org/apache/dubbo/rpc/cluster/ConfiguratorTest.java:42`
- `dubbo-configcenter/dubbo-configcenter-zookeeper/src/test/java/org/apache/dubbo/configcenter/support/zookeeper/ZookeeperDynamicConfigurationTest.java:113`
- `dubbo-configcenter/dubbo-configcenter-nacos/src/test/java/org/apache/dubbo/configcenter/support/nacos/NacosDynamicConfigurationTest.java:79`

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇聚焦动态治理规则，不展开 vendor-specific config-center 实现细节。
- 本篇只在需要时提及 metadata 取值，不展开 metadata publish 主线。

## 与其他篇的边界

### 本篇要讲清

- config center 动态规则如何进入 runtime。
- configurator 如何覆盖 consumer/provider URL。
- 为什么地址没变但行为会变。
- provider re-export 的触发条件。

### 本篇不深讲

- 静态配置 merge（上一章）。
- registry 地址更新基础链（上一章）。
- migration 两套发现模型切换（上一章）。
- registry vendor 实现细节。

## 写作后检查

- [ ] 开篇先抓“地址没变但行为变了”的排障痛点。
- [ ] 至少展开 3 个失败方案，且包含“config center 只是启动期配置来源”“configurator 只影响 consumer”。
- [ ] 明确给出 config center -> configurator -> runtime override 总图。
- [ ] 不把本篇写成配置中心接入手册。
- [ ] 每个 override 结论都落到 file:line。
- [ ] 删除代码块后，读者仍能复述动态覆盖链路。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。