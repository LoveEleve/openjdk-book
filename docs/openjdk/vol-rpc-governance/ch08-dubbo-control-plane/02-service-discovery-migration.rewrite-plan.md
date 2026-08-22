# Dubbo：Service Discovery / Migration 机制 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch08-dubbo-control-plane`
- 篇：`02 Service Discovery / Migration 机制`
- 对应主题：`D-CTRL-2 Service Discovery / Migration`
- 文章类型：控制面高阶机制篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：Dubbo 3.x 不再只停留在传统“接口级地址发现”，还引入了应用级服务发现与迁移逻辑。但读者最容易糊涂的不是“概念上有两种发现模型”，而是：运行时到底怎么在旧路径和新路径之间切换？`MigrationInvoker` 为什么存在？`ServiceDiscoveryRegistryDirectory` 和 `RegistryDirectory` 为什么可以同时存在？配置规则一变，consumer 手里的对象到底哪里变了，哪里没变？
- 一句话顿悟：Dubbo 的迁移不是“启动时选一个模式就结束”，而是通过 `MigrationInvoker` 把两条发现链并存起来：旧链是 `RegistryDirectory` 驱动的接口级 provider URL 视图，新链是 `ServiceDiscoveryRegistryDirectory` 驱动的应用级实例视图；`MigrationRuleListener` / `MigrationRuleHandler` 根据规则和地址比较器驱动“偏向新路径、强制旧路径、强制新路径”的切换，最终变化的不是业务 proxy 本身，而是它背后 `currentAvailableInvoker` 指向哪一条子树。
- 文章边界：本篇重点讲 interface-level discovery 与 application-level discovery 的 runtime 区别、`MigrationInvoker`/`ServiceDiscoveryMigrationInvoker` 的职责、迁移规则如何驱动切换、`ServiceDiscoveryRegistry` / `ServiceInstancesChangedListener` 如何把实例列表变成 `InstanceAddressURL` 和 live invokers；不展开具体 registry vendor、metadata 上报细节、router/loadbalance 算法细节。

## 前置依赖

### HARD

- `ch08-dubbo-control-plane/01-registryprotocol-registrydirectory-address-update.md`
- `ch06-dubbo-runtime/03-directory-router-loadbalance-cluster.md`
- `ch06-dubbo-runtime/02-invoker-protocol-exporter-proxy-filter.md`

### SOFT

- 不要求先懂具体服务发现后端（Nacos、ZK）。
- 不要求先懂 metadata report 全量实现。

### NAV

- 后续可接：Config Center / Dynamic Override
- 后续可接：Dubbo 生产控制面排障篇

## 一句话困惑

Dubbo 3 里“接口级地址发现”和“应用级服务发现”到底怎么在运行时共存和切换？为什么需要 `MigrationInvoker`，它到底在替换什么？

## 一句话顿悟

Dubbo 把迁移做成了一层“上层 Invoker 壳”：业务侧仍然拿同一个 `Invoker` / proxy，下面同时挂着旧路径 `RegistryDirectory` 和新路径 `ServiceDiscoveryRegistryDirectory` 两棵树；规则和比较器决定当前请求走哪棵树，成功迁移后再销毁另一侧。这意味着迁移的核心不是“换 registry”，而是“在不换业务入口的前提下切换底层 invoker 子树”。

## 读者理解路径

1. 先否定“迁移就是启动时选一个发现模式”的理解。
2. 建立最小总图：旧路径 `RegistryDirectory`、新路径 `ServiceDiscoveryRegistryDirectory`、中间 `MigrationInvoker` 壳。
3. 解释接口级发现与应用级发现的 runtime 差异。
4. 解释 `RegistryProtocol.doRefer()` 如何创建 migration invoker。
5. 解释 `MigrationRuleListener` / `MigrationRuleHandler` 如何把规则变成切换动作。
6. 解释 `ServiceDiscoveryRegistry` / `ServiceInstancesChangedListener` 如何把实例变化变成 `InstanceAddressURL`。
7. 解释迁移过程中哪些对象保持不变，哪些对象在切换。
8. 收束到：迁移是 invoker 子树的切换，不是业务入口对象的替换。

## 失败方案推演

### 失败方案一：迁移就是启动时选一个模式，后面不再变化

- 这会把 migration 写成配置开关。
- 实际上 `MigrationRuleListener` 会持续监听规则变化，`MigrationRuleHandler` 可以在运行中反复触发切换。
- 所以迁移是动态控制面行为，不是启动期开关。

### 失败方案二：应用级服务发现只是换一套地址格式

- 旧路径直接拿接口级 provider URL；新路径先拿 app/service instances，再根据 metadata 和 `ProtocolServiceKey` 还原成可 refer 的地址。
- 这意味着运行时对象、订阅关系、live invoker 生成方式都发生变化，不只是 URL 长相不同。

### 失败方案三：迁移时业务 proxy 会被替换

- 业务 proxy / 上层 Invoker 不需要变。
- 变化的是 `MigrationInvoker.currentAvailableInvoker` 指向哪棵底层 invoker 子树。
- 所以迁移是“壳不变，里子切换”。

## 必须澄清的误解

1. application-level discovery 不是“直接按 app 调用”，而是先发现 app 实例，再通过 metadata 回到接口服务。
2. `MigrationInvoker` 不是 cluster 策略，而是两条发现路径的运行时协调壳。
3. `APPLICATION_FIRST` 不是“永远优先新路径”，它仍受比较器和比例影响。
4. `ServiceDiscoveryMigrationInvoker` 与普通 `MigrationInvoker` 的行为并不完全对称。
5. 迁移成功后销毁的是某一侧的 invoker 子树，不是业务 proxy 本身。

## 文章结构与字数预算

1. 困惑开场：为什么发现模型迁移不会直接替换 proxy（800-1000 字）
2. 最小总图：旧路径 / 新路径 / MigrationInvoker 壳（1000-1400 字）
3. interface-level vs application-level 运行时差异（1400-2000 字）
4. `RegistryProtocol` 如何创建 migration invoker（1200-1800 字）
5. `MigrationRuleListener` / `MigrationRuleHandler`：规则到切换动作（1600-2200 字）
6. `ServiceDiscoveryRegistry` / `ServiceInstancesChangedListener`：实例如何变成 live invokers（1600-2200 字）
7. 对象图切换：什么变了，什么没变（1200-1600 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/RegistryProtocol.java:578` — doRefer
- `RegistryProtocol.java:592` — `CONSUMER_URL_KEY`
- `RegistryProtocol.java:601` — 默认返回 `ServiceDiscoveryMigrationInvoker`
- `RegistryProtocol.java:635` — service-discovery invoker path
- `RegistryProtocol.java:641` — interface-level invoker path
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/migration/MigrationInvoker.java:64` — old/new/current invoker fields
- `MigrationInvoker.java:143` — reRefer
- `MigrationInvoker.java:171` — force application path
- `MigrationInvoker.java:212` — force interface path
- `MigrationInvoker.java:253` — calculate preferred invoker
- `MigrationInvoker.java:285` — APPLICATION_FIRST invoke path
- `MigrationInvoker.java:433` — destroy interface invoker
- `MigrationInvoker.java:520` — destroy service-discovery invoker
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/migration/ServiceDiscoveryMigrationInvoker.java:53` — service-discovery-only behavior
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/migration/MigrationRuleHandler.java:47` — rule to step dispatch
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/migration/MigrationRuleListener.java:160` — rule change fan-out
- `MigrationRuleListener.java:277` — onRefer attach handler
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/ServiceDiscoveryRegistry.java:63` — old/new model bridge
- `ServiceDiscoveryRegistry.java:199` — subscribe path
- `ServiceDiscoveryRegistry.java:341` — subscribeURLs / shared listener
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/event/listener/ServiceInstancesChangedListener.java:143` — instance change handling
- `ServiceInstancesChangedListener.java:460` — notifyAddressChanged
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/InstanceAddressURL.java:48` — instance-derived address model
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/ServiceDiscoveryRegistryDirectory.java:197` — notify
- `ServiceDiscoveryRegistryDirectory.java:463` — instance URL -> protocol invoker
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/integration/InterfaceCompatibleRegistryProtocol.java:77` — plain `MigrationInvoker` path
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/migration/model/MigrationRule.java:157` — step resolution
- `dubbo-registry/dubbo-registry-api/src/main/java/org/apache/dubbo/registry/client/migration/DefaultMigrationAddressComparator.java:49` — address count ratio / threshold

## 测试证据清单

- `MigrationInvokerTest.java:103` — force/application-first/invoke switching
- `MigrationRuleHandlerTest.java:41` — rule -> migrate path
- `MigrationRuleListenerTest.java:81` — default rule / remote rule change handling
- `MigrationRuleTest.java:69` — interface/app-specific override
- `DefaultMigrationAddressComparatorTest.java:41` — threshold decision
- `ServiceDiscoveryRegistryTest.java:184` — service-discovery subscribe path
- `ServiceInstancesChangedListenerTest.java:228` — instance URLs and notification

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇聚焦运行时切换，不展开 metadata 上报内部实现和具体 registry vendor。
- 默认 `RegistryProtocol` 当前更偏 service-discovery 路径，普通 `MigrationInvoker` 的对称共存逻辑在兼容协议里更典型。

## 与其他篇的边界

### 本篇要讲清

- 两套发现模型的运行时差异。
- `MigrationInvoker`/`ServiceDiscoveryMigrationInvoker` 的壳作用。
- 规则和比较器如何驱动切换。
- 实例变化如何进入新路径并生成 invokers。
- 迁移时对象图哪些变、哪些不变。

### 本篇不深讲

- registry vendor 实现。
- metadata publish internals。
- router/loadbalance/cluster 算法本身。
- Dubbo 生产排障大全。

## 写作后检查

- [ ] 开篇先抓“迁移不会直接替换 proxy”，而不是直接讲 MigrationStep。
- [ ] 至少展开 3 个失败方案，且包含“启动时选一次就结束”“应用级发现只是换地址格式”。
- [ ] 明确给出旧路径 / 新路径 / migration 壳的总图。
- [ ] 不把本篇写成 migration rule 枚举说明书。
- [ ] 每个切换结论都落到具体 file:line 和测试。
- [ ] 删除代码块后，读者仍能复述 migration 的对象图和切换主线。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。