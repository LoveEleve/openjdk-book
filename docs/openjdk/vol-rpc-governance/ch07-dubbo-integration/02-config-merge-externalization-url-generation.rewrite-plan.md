# Dubbo：配置合并、外部化与 URL 生成 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch07-dubbo-integration`
- 篇：`02 配置合并、外部化与 URL 生成`
- 对应主题：`D-INT-2 Config Merge / Externalization / URL Generation`
- 文章类型：集成层与配置语义篇
- 正文状态：未开始
- 基于版本：`Apache Dubbo 3.3.7-SNAPSHOT`

## 文章定位

- 核心困惑：Dubbo 的配置层是最容易让人迷路的部分之一。`application/module/provider/consumer/service/reference` 这些层次，到底谁覆盖谁？`dubbo.properties`、环境变量、系统属性、config center、Spring `dubbo.*` 配置、注解属性，最终谁说了算？更关键的是，这些配置不是为了“存在于 bean 上”，而是最终要被压成 provider URL 和 consumer refer URL。读者最困惑的是：Dubbo 到底在什么时候做 merge，什么时候做 refresh，什么时候把值写进 URL？
- 一句话顿悟：Dubbo 的配置处理不是一次“总合并”，而是三段：先由 `Environment` 建立多来源优先级（system -> env -> external config -> app config -> object -> properties），再由 `AbstractConfig.refresh()` 按 prefix 和 `ConfigMode` 把外部值覆盖到具体 config 对象，最后在 `ServiceConfig` / `ReferenceConfig` 的 URL 组装阶段按 application -> module -> provider/consumer -> service/reference -> method/argument 的顺序压成真正的 runtime URL 参数；所以“看到 bean 上有什么值”和“最终 URL 上有什么值”不是同一个问题。
- 文章边界：本篇重点讲 `AbstractConfig` 的 refresh/assign 机制、`Environment` 的来源优先级、`ConfigManager`/`ModuleConfigManager` 的协调作用、provider/consumer/service/reference 的配置继承，以及 provider URL / consumer refer 参数如何生成；不展开 Spring 注解扫描（上一篇已覆盖），不展开 export/refer 主线和 registry/cluster 内部调用。

## 前置依赖

### HARD

- `ch06-dubbo-runtime/01-serviceconfig-referenceconfig-export-refer.md`：已经知道 `ServiceConfig` / `ReferenceConfig` 是入口对象。
- `ch07-dubbo-integration/01-spring-springboot-integration-bootstrap.md`：已经知道 Spring/Boot 如何把注解和属性翻译成这些 config 对象。

### SOFT

- 不要求先懂 registry / cluster。
- 不要求先懂 Spring Binder 细节。

### NAV

- 后续可接：Dubbo 生产层中的配置不一致 / registry-config-center 失配排障。
- 后续可接：ScopeModel / ConfigManager 生命周期专题。

## 一句话困惑

Dubbo 里这么多配置来源和层级，最后到底谁覆盖谁？`refresh()` 是什么时候执行的？bean 上的值和最终 URL 上的值为什么有时看起来不一样？

## 一句话顿悟

Dubbo 配置要分三段看：**来源优先级**由 `Environment` 决定，**对象级覆盖**由 `AbstractConfig.refresh()` 决定，**最终运行时参数**由 `ServiceConfig` / `ReferenceConfig` 在 URL 组装阶段决定；因此不能把“配置 bean 的当前字段值”和“最终 provider/refer URL 参数”混为一谈。

## 读者理解路径

1. 先否定“Dubbo 会把所有配置一次性 merge 成一个大对象”这种直觉。
2. 建立最小总图：来源层 -> refresh 覆盖层 -> URL 生成层。
3. 解释 `Environment` 的优先级顺序：system、env、external config、app config、object、properties。
4. 解释 `AbstractConfig.refresh()`：prefix 选择、`ConfigMode`、setter 覆盖、map/nested config 处理。
5. 解释 `ServiceConfigBase` / `ReferenceConfigBase` 的 provider/consumer 默认值继承。
6. 解释 provider URL 如何按 application/module/provider/protocol/service/method 顺序组装。
7. 解释 consumer refer 参数如何按 application/module/consumer/reference/method 顺序组装。
8. 收束到：配置排障要分清“值从哪来”“什么时候刷进对象”“什么时候进 URL”。

## 失败方案推演

### 失败方案一：Dubbo 会把所有配置一次性 merge 成一个总对象

- 这会让读者以为 Spring/Boot、config-center、系统属性、`dubbo.properties` 都会在某个时刻“汇总成一个最终 bean”。
- 实际上 Dubbo 的配置处理是分阶段的：来源优先级在 `Environment`，对象覆盖在 `refresh()`，URL 组装在 export/refer 时。
- 所以不存在一个“所有配置都汇总完毕的一次性对象”。

### 失败方案二：bean 上看到的值，就等于最终 URL 上的值

- provider/consumer 的默认值可能通过 getter fallback 生效，而不一定提前写回子 config 字段。
- method/argument 配置也会在 URL 组装阶段以 `sayHello.timeout` 这类键附加进参数，而不是总能在上层 bean 字段里直接看到。
- 所以看 bean 字段值和看最终 URL，回答的是两个层次的问题。

### 失败方案三：Spring Boot 自动配置决定了 Dubbo 的最终配置优先级

- Boot 只是把 `dubbo.*` 属性喂给 Dubbo 环境和 config bean。
- 真正的覆盖顺序在 `Environment` 里，系统属性和外部 config center 依然可能压过 Boot 配置。
- 所以“Spring Boot 里写了什么”不是最终答案，而是配置来源之一。

## 必须澄清的误解

1. `refresh()` 不是“把所有配置 merge 完”，而是“按 prefix 和 ConfigMode 覆盖当前对象”。
2. `@Parameter(key=...)` 影响的是 URL 参数名，不等于 refresh 覆盖时的属性名。
3. provider/consumer 的默认值继承有时发生在 getter fallback，有时发生在 URL append 顺序，不是总写回子对象字段。
4. `dubbo.properties` 不是最高优先级，system / env / external config 可以覆盖它。
5. singular 与 plural 的 properties 路径（如 `dubbo.consumer.*` vs `dubbo.consumers.xxx.*`）不是随便写都生效。

## 文章结构与字数预算

1. 困惑开场：为什么同一份 Dubbo 配置到处看起来不一样（800-1000 字）
2. 最小总图：来源层 / refresh 层 / URL 层（1000-1400 字）
3. `Environment`：来源优先级与外部化配置（1400-2000 字）
4. `AbstractConfig.refresh()`：prefix、ConfigMode、setter 覆盖（1800-2400 字）
5. `ServiceConfigBase` / `ReferenceConfigBase`：provider/consumer 默认值继承（1400-2000 字）
6. provider URL 参数组装（1400-2000 字）
7. consumer refer 参数组装（1400-2000 字）
8. 误解澄清与排障视角（1000-1400 字）
9. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

### 来源优先级 / Environment
- `dubbo-common/src/main/java/org/apache/dubbo/common/config/Environment.java:188` — provider-first 配置链
- `Environment.java:230` — app config / external config / properties 组合
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/deploy/DefaultApplicationDeployer.java:301` — config center 加载
- `DefaultApplicationDeployer.java:936` — external/appExternalConfiguration 更新

### refresh / merge
- `dubbo-common/src/main/java/org/apache/dubbo/config/AbstractConfig.java:511` — 注解属性复制
- `AbstractConfig.java:603` — prefix 构造
- `AbstractConfig.java:718` — `refresh()`
- `AbstractConfig.java:739` — `refreshWithPrefixes(...)`
- `AbstractConfig.java:786` — `ConfigMode` 行为
- `AbstractConfig.java:856` — map / nested config / setter 赋值
- `dubbo-common/src/main/java/org/apache/dubbo/config/AbstractInterfaceConfig.java:321` — method/argument 配置 refresh

### manager / inheritance
- `dubbo-common/src/main/java/org/apache/dubbo/config/context/ConfigManager.java:272` — loadConfigs/refresh
- `dubbo-common/src/main/java/org/apache/dubbo/config/context/ModuleConfigManager.java:139` — default provider/consumer 查找
- `ModuleConfigManager.java:168` — refreshAll
- `dubbo-common/src/main/java/org/apache/dubbo/config/ServiceConfigBase.java:178` — provider 默认继承 / preProcessRefresh
- `ServiceConfigBase.java:397` — group/version fallback
- `dubbo-common/src/main/java/org/apache/dubbo/config/ReferenceConfigBase.java:135` — consumer 默认继承 / preProcessRefresh
- `ReferenceConfigBase.java:108` — check/init fallback

### provider URL / consumer refer params
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ServiceConfig.java:694` — provider buildAttributes
- `ServiceConfig.java:709` — method/argument params 追加
- `ServiceConfig.java:714` — methods/revision/generic
- `ServiceConfig.java:736` — token 继承与 default 生成
- `ServiceConfig.java:835` — buildUrl
- `ServiceConfig.java:1053` — host/port bind/register 优先级
- `dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ReferenceConfig.java:431` — consumer appendConfig
- `ReferenceConfig.java:463` — `register.ip`
- `ReferenceConfig.java:473` — method retries 归一化
- `ReferenceConfig.java:490` — createProxy
- `ReferenceConfig.java:511` — consumer URL 构造
- `ReferenceConfig.java:846` — shouldJvmRefer

## 测试证据清单

- `dubbo-config/dubbo-config-api/src/test/java/org/apache/dubbo/config/AbstractConfigTest.java:338` — system > external > bean > properties
- `AbstractConfigTest.java:404` — external > properties
- `AbstractConfigTest.java:438` — id-specific prefix 覆盖 generic prefix
- `AbstractConfigTest.java:515` — `OVERRIDE_ALL` vs `OVERRIDE_IF_ABSENT`
- `dubbo-config/dubbo-config-api/src/test/java/org/apache/dubbo/config/ConsumerConfigTest.java:166` — singular path 差异
- `ConsumerConfigTest.java:200` — plural-id path 生效
- `ConsumerConfigTest.java:244` — consumer -> reference 继承
- `dubbo-config/dubbo-config-api/src/test/java/org/apache/dubbo/config/url/InvokerSideConfigUrlTest.java:155` — consumer URL 生成（注意测试部分已过时/disabled）

## 版本边界

- 当前分析对象固定为 `Apache Dubbo 3.3.7-SNAPSHOT`。
- 本篇聚焦 Dubbo 配置语义和 URL 生成，不展开 Spring Binder 细节，不展开 registry/cluster 运行时。
- XML 老配置模型和 2.x 兼容差异不在本文展开。

## 与其他篇的边界

### 本篇要讲清

- Environment 的来源优先级。
- `refresh()` 的对象覆盖语义。
- provider/consumer/service/reference 的默认值继承。
- provider URL 和 consumer refer 参数如何被组装出来。

### 本篇不深讲

- Spring 注解/BeanDefinition 桥（上一篇）。
- export/refer 主线和 registry/cluster 内部运行（前几篇）。
- remoting/network 细节。

## 写作后检查

- [ ] 开篇先抓“同一份配置为什么看起来不一样”，而不是直接讲 `AbstractConfig`。
- [ ] 至少展开 3 个失败方案，且包含“bean 值=最终 URL 值”“Boot 配置=最终最高优先级”。
- [ ] 明确给出来源层/refresh层/URL层总图。
- [ ] 不把本文写成配置字段说明书。
- [ ] 每个优先级/覆盖结论都要落到 file:line 和测试。
- [ ] 删除代码块后，读者仍能复述 Dubbo 配置为什么要分三段看。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。