# Dubbo：配置合并、外部化与 URL 生成 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `Environment` 明确组织多来源优先级：system、env、appExternal、external、appConfig、config object、properties，证据：`dubbo-common/src/main/java/org/apache/dubbo/common/config/Environment.java:188`、`:230`。
2. `DefaultApplicationDeployer` 会加载 config center 并更新 `externalConfiguration` / `appExternalConfiguration`，证据：`dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/deploy/DefaultApplicationDeployer.java:301`、`:936`。
3. `AbstractConfig.refresh()` 是对象级覆盖入口，先 `preProcessRefresh()`，再 `refreshWithPrefixes(...)`，最后 `postProcessRefresh()`，证据：`dubbo-common/src/main/java/org/apache/dubbo/config/AbstractConfig.java:718`。
4. `refreshWithPrefixes(...)` 只选择第一个真正有 subproperties 的 prefix，而不是累加所有候选 prefix，证据：`AbstractConfig.java:739`、`:743`。
5. `ConfigMode` 至少区分 `OVERRIDE_ALL` 和 `OVERRIDE_IF_ABSENT`，影响外部值是否覆盖已有字段，证据：`AbstractConfig.java:786`、`:807`。
6. `@Parameter(key=...)` 影响的是 URL 参数名，不是 refresh 时的属性名；注解属性复制与参数追加是两个阶段，证据：`AbstractConfig.java:511`、`:171`。
7. `AbstractInterfaceConfig.processExtraRefresh(...)` 会把 method/argument 配置从 property tree 展开成 `MethodConfig` / `ArgumentConfig`，证据：`dubbo-common/src/main/java/org/apache/dubbo/config/AbstractInterfaceConfig.java:321`。
8. `ServiceConfigBase` 会在 pre-refresh 和 getter fallback 两层继承 provider 默认值，`group/version` 等可能不直接写回子对象字段，证据：`dubbo-common/src/main/java/org/apache/dubbo/config/ServiceConfigBase.java:178`、`:397`。
9. `ReferenceConfigBase` 会继承 consumer 默认值，`check/init` 等通过 getter fallback 生效，证据：`dubbo-common/src/main/java/org/apache/dubbo/config/ReferenceConfigBase.java:135`、`:108`。
10. provider URL 参数由 `ServiceConfig.buildAttributes()` / `buildUrl()` 组装，顺序是 runtime → application → module → provider → protocol → service → method/argument，证据：`dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ServiceConfig.java:694`、`:709`、`:714`、`:835`。
11. token 有独立继承与 default UUID 生成逻辑，host/port bind/register 也走专门优先级，不只是普通字段 merge，证据：`ServiceConfig.java:736`、`:1053`。
12. consumer refer 参数由 `ReferenceConfig.appendConfig()` 组装，`register.ip`、method retries、consumer URL 构造都发生在这一层，证据：`dubbo-config/dubbo-config-api/src/main/java/org/apache/dubbo/config/ReferenceConfig.java:431`、`:463`、`:473`、`:511`。
13. `shouldJvmRefer()` 发生在 merge 之后，说明本地/远程判断也是配置语义的一部分，证据：`ReferenceConfig.java:846`。

### 测试证据已核对

1. `AbstractConfigTest.java:338` — system > external > bean > properties。
2. `AbstractConfigTest.java:404` — external > properties。
3. `AbstractConfigTest.java:438` — id-specific prefix 覆盖 generic prefix。
4. `AbstractConfigTest.java:515` — `OVERRIDE_ALL` vs `OVERRIDE_IF_ABSENT`。
5. `ConsumerConfigTest.java:166` — singular path 行为。
6. `ConsumerConfigTest.java:200` — plural-id path 行为。
7. `ConsumerConfigTest.java:244` — consumer -> reference 默认继承。
8. `InvokerSideConfigUrlTest.java:155` — consumer URL 形状（注意该测试部分历史性/disabled）。

### 深审发现

1. **高风险：容易把 Dubbo 配置写成“总对象 merge”。** 当前正文已压回来源层、refresh 层、URL 层三段。  
2. **高风险：容易把 bean 字段值和最终 URL 参数等同。** 当前正文已强调 getter fallback、method 级追加和 bind/register 特殊路径。  
3. **中风险：容易低估 config center 在优先级链中的位置。** 当前正文已把它放回 `Environment` 而不是某个 bean 的附属配置。  
4. **中风险：容易混淆 `@Parameter(key=...)` 和 refresh 属性匹配。** 当前正文已专门拆开。  
5. **低风险：容易忽略 singular/plural property prefix 的语义差异。** 当前正文已点出 `dubbo.consumer.*` 与 `dubbo.consumers.xxx.*` 的不同。  

## 第二轮：因果审

- Dubbo 必须先通过 `Environment` 建立来源优先级，否则系统属性、config center、Spring 配置之间无法裁决谁覆盖谁：✅
- `refresh()` 必须是对象级覆盖而不是全局总合并，否则 config bean 会失去自身 prefix 和 `ConfigMode` 语义：✅
- provider/consumer 默认值继承必须允许 getter fallback，否则并非所有默认值都需要提前回写到子对象字段：✅
- provider URL / consumer URL 必须在 export/refer 前再做一轮组装，否则 method/argument 级参数和 runtime 参数无法进入最终运行时：✅
- bind/register host/port 必须走单独优先级路径，否则系统级运维参数无法在最后阶段强制覆盖：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → 总图 → Environment → refresh → provider/consumer 继承 → provider URL → consumer URL → 误解澄清 → 收网总结”推进，没有退化成配置字段说明书。

失败方案已覆盖：
- 一次性 merge 成总对象  
- bean 值 = 最终 URL 值  
- Spring Boot 配置 = 最高优先级  

每一层拆解均包含：来源/覆盖/参数化三个层次的边界，符合配置语义篇定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- Dubbo 配置必须分成来源层、refresh 层、URL 层三段看  
- `Environment` 的优先级链  
- `refresh()` 的 prefix / ConfigMode 语义  
- provider/consumer/service/reference 的默认继承  
- provider URL 与 consumer refer 参数的最终组装  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重讲 Spring 注解桥接（上一篇已覆盖）。✅
- 未重讲 export/refer / registry / cluster 主线（前几篇已覆盖）。✅
- 未展开 remoting / network 细节。✅
- 未展开 XML 老配置模型和 2.x 兼容差异。✅
- 重点仍压在配置语义和 URL 生成层，边界收得住。✅

## 第六轮：依赖审

- 已承接集成篇：Spring/Boot 负责把值喂给 Dubbo config bean，本篇解释值之后怎样被覆盖和压成 URL。✅
- 已承接第一篇：最终 URL 直接决定后续 `ServiceConfig.export()` / `ReferenceConfig.createProxy()` 的主线行为。✅
- `AbstractConfigTest`、`ConsumerConfigTest` 足以支撑本文最核心的来源优先级与覆盖语义。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅
- 代码块：使用少量总图，不承担主叙事骨架。✅
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `Environment`、`AbstractConfig`、`AbstractInterfaceConfig`、`ServiceConfigBase`、`ReferenceConfigBase`、`ServiceConfig`、`ReferenceConfig`、`DefaultApplicationDeployer`。✅
- 去掉代码块后正文仍成立：是。✅
- 叙述性正文字符数（不含代码块与空白行）：约 `15,102`。  
- 目标定位：Dubbo 配置语义与 URL 生成篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 Dubbo 配置从“到处都是值”提升到“来源层 / refresh 层 / URL 层”三段式语义，让读者能够区分：值从哪来、什么时候刷进对象、最终什么时候进入 provider/refer URL。只要这三层边界立住，Dubbo 配置排障就不再像黑魔法。