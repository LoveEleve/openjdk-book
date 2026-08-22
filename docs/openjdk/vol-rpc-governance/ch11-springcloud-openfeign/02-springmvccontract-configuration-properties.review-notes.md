# Spring Cloud OpenFeign：SpringMvcContract、配置属性与 per-client 配置 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `SpringMvcContract` 直接继承 `Contract.BaseContract`，不是独立于 OpenFeign core 的第二套实现，证据：`spring-cloud-openfeign-core/src/main/java/org/springframework/cloud/openfeign/support/SpringMvcContract.java:98`。
2. `SpringMvcContract` 类级处理会拒绝 `@RequestMapping` 出现在 `@FeignClient` 接口上，证据：`SpringMvcContract.java:226`。
3. 方法级 `parseAndValidateMetadata(...)` 先调用 core 的解析入口，再处理 Spring 注解；HTTP method 默认 GET，path 进入 `RequestTemplate.uri(...)`，produces→Accept、consumes→Content-Type，证据：`SpringMvcContract.java:240`、`:298`、`:307`、`:327`。
4. 参数级别的 `@PathVariable` / `@RequestParam` / `@RequestHeader` / `@RequestPart` / `@SpringQueryMap` / `@CookieValue` 通过 `AnnotatedParameterProcessor` 分派，证据：`SpringMvcContract.java:360`、`:479`。
5. `FeignClientFactoryBean.configureFeign(...)` 根据 `default-to-properties` 决定 Java configuration 与 properties 的先后顺序，证据：`FeignClientFactoryBean.java:166`、`:173`。
6. properties 内部顺序是 `default config → client-specific config`，证据：`FeignClientFactoryBean.java:256`、`:269`。
7. `name` 是 service id，`contextId` 是 child context key / 配置 key，Bean name 是 Spring Bean 名；`getContextId(...)` 和 `getClientName(...)` 分别解析，证据：`FeignClientsRegistrar.java:339`、`:441`。
8. 配置项默认设置 `Retryer.NEVER_RETRY`，`default-to-properties` 在 `FeignClientFactoryBean` 中处理，证据：`FeignClientFactoryBean.java:166`、`FeignClientsConfiguration.java:160`。
9. `FeignBuilderCustomizer` 和 `Capability` 是 per-client 定制的另外两条入口，与 properties 的 key/value 覆盖机制不同。

### 测试证据已核对

1. `SpringMvcContractTests` — Spring MVC 注解解析主测试。
2. `SpringMvcContractIntegrationTests` — 注解到请求的集成行为。
3. `SpringMvcContractSlashEncodingIntegrationTests` — 斜杠编码。
4. `FeignClientOverrideDefaultsTests.java:80` — Java configuration 覆盖默认配置。
5. `FeignClientFactoryBeanIntegrationTests.java:70` — 集成行为。

### 深审发现

1. **高风险：容易把 SpringMvcContract 写成 MVC 翻译器独立体系。** 当前正文已强调它是 `Contract.BaseContract` 的子类，走同一条主线。  
2. **高风险：容易写死“properties 一定覆盖 Java config”。** 当前正文已通过 `default-to-properties` 拆开两条方向。  
3. **中风险：容易把 `name` 和 `contextId` 混为一谈。** 当前正文已明确二者语义不同。  
4. **中风险：容易把 `SpringMvcContract` 当成支持类级 `@RequestMapping`。** 当前正文已点出它明确拒绝。  
5. **低风险：容易忽略 `FeignBuilderCustomizer` / `Capability` 作为额外 per-client 入口。** 当前正文已单列。  

## 第二轮：因果审

- Spring MVC 注解必须落到 Feign 的 `Contract` 模型里，否则会形成两套互不兼容的请求构造体系：✅  
- `default-to-properties` 必须存在，否则 externalized 配置无法决定是否覆盖 Java config Bean：✅  
- `name` 与 `contextId` 必须分离，否则多个 client 指向同一 service 时无法复用独立配置空间：✅  
- `SpringMvcContract` 必须继承 `Contract.BaseContract`，否则它无法被 Feign.Builder 识别为契约实现：✅  
- `FeignBuilderCustomizer` / `Capability` 必须存在，否则 per-client 定制只有 `@FeignClient(configuration=...)` 一种入口：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → SpringMvcContract 总图 → SpringMvcContract 解析 → FeignClientProperties 覆盖 → name/contextId → FeignBuilderCustomizer/Capability → 误解澄清 → 收网总结”推进，没有退化成注解属性说明书。

失败方案已覆盖：
- Spring MVC 注解和 Feign 注解是两套独立体系  
- properties 一定覆盖 Java config  
- name 和 contextId 是同一个东西  

每一层拆解均围绕“注解适配 + 配置覆盖 + per-client 定制入口”展开，符合 Spring 集成契约篇定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- `SpringMvcContract` 如何把 Spring MVC 注解翻成 MethodMetadata
- `default-to-properties` 如何决定配置覆盖方向
- `name` / `contextId` / Bean name 的区别
- `FeignBuilderCustomizer` / `Capability` 作为额外 per-client 入口

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未重讲 OpenFeign core 的 Contract / MethodMetadata 内部构造（前卷已覆盖）。✅
- 未展开所有 `AnnotatedParameterProcessor` 逐个实现细节。✅
- 未展开 LoadBalancer / CircuitBreaker。✅
- 重点仍压在契约适配与配置覆盖，边界收得住。✅

## 第六轮：依赖审

- 已承接 Spring Cloud OpenFeign 第一篇的 client creation bridge，解释桥接后 Spring 风格注解和配置如何生效。✅
- 已承接 OpenFeign core blueprint 篇，说明 SpringMvcContract 仍走 core 主线。✅
- `SpringMvcContractTests`、`FeignClientOverrideDefaultsTests` 足以支撑契约适配与配置覆盖结论。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。
- 代码块：使用少量注解/配置总图与对照代码，不承担主叙事骨架。
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `SpringMvcContract`、`FeignClientFactoryBean`、`FeignClientsRegistrar`、`FeignClientsConfiguration`。
- 去掉代码块后正文仍成立：是。
- 叙述性正文字符数（不含代码块与空白行）：约 `9,900`。
- 目标定位：Spring Cloud OpenFeign 契约与配置篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 Spring MVC 注解和配置属性在 Spring Cloud OpenFeign 里的真正角色讲清楚：`SpringMvcContract` 是 Feign `Contract` 的实现，配置属性通过 `default-to-properties` 和 default→client-specific 顺序进入 builder；`name` / `contextId` / Bean name 是不同语义，三者默认相等但不互锁。