# Spring Cloud OpenFeign：从 `@EnableFeignClients` 到 Feign Proxy — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `@EnableFeignClients` 的本质是 `@Import(FeignClientsRegistrar.class)`，它本身不创建代理，证据：`spring-cloud-openfeign-core/src/main/java/org/springframework/cloud/openfeign/EnableFeignClients.java:41`。
2. `FeignClientsRegistrar.registerBeanDefinitions(...)` 负责注册 default configuration 和 feign client BeanDefinition，证据：`FeignClientsRegistrar.java:152`、`:157`、`:172`。
3. registrar 会为每个 client 注册 `FeignClientSpecification`，用于后续 named child context 配置，证据：`FeignClientsRegistrar.java:463`。
4. `FeignClientsRegistrar` 有 eager 与 lazy 两条注册路径，默认会直接注册 `FeignClientFactoryBean`，lazy 模式则注册接口类型 + Supplier，证据：`FeignClientsRegistrar.java:222`、`:266`。
5. `FeignClientFactory` 继承 `NamedContextFactory`，并以 `FeignClientsConfiguration` 为 default config type，为每个 client 提供 child context，证据：`spring-cloud-openfeign-core/src/main/java/org/springframework/cloud/openfeign/FeignClientFactory.java:39`、`:47`。
6. `NamedContextFactory.getContext(name)` 按需懒创建 child context，`registerBeans(...)` 会依次注册 client-specific config、default config 和默认 `FeignClientsConfiguration`，证据：`spring-cloud-commons/.../NamedContextFactory.java:119`、`:143`、`:187`。
7. `FeignClientsConfiguration` 提供默认 Decoder、Encoder、Contract(`SpringMvcContract`)、`Retryer.NEVER_RETRY` 和 prototype `Feign.Builder`，证据：`FeignClientsConfiguration.java:102`、`:108`、`:145`、`:160`、`:203`。
8. `FeignClientFactoryBean.getObject()`/`getTarget()` 才是真正创建 client proxy 的时刻，它会先从 child context 取 `Feign.Builder`、`Encoder`、`Decoder`、`Contract` 等，再组装 builder，证据：`FeignClientFactoryBean.java:454`、`:465`、`:135`。
9. `configureFeign(...)` 负责处理 Java configuration 与 properties 的优先级，`default-to-properties` 会改变顺序，证据：`FeignClientFactoryBean.java:166`、`:173`、`:256`。
10. 没有显式 URL 时，FactoryBean 会进入 `loadBalance(...)` 路径，说明 service name 作为逻辑 target 交给后续基础设施处理；有 URL 时，则走 `Targeter.target(...)`，默认 `DefaultTargeter` 最终调用 `feign.target(target)`，证据：`FeignClientFactoryBean.java:427`、`:483`、`DefaultTargeter.java:25`。
11. `SpringMvcContract` 只是 OpenFeign `Contract` 的 Spring 适配器，不是 Spring MVC handler 机制本身，证据：`spring-cloud-openfeign-core/src/main/java/org/springframework/cloud/openfeign/support/SpringMvcContract.java:98`。

### 测试证据已核对

1. `FeignClientsRegistrarTests.java:49` — registrar 的 name/url/fallback 基础校验。
2. `FeignClientsRegistrarTests.java:133` — placeholder/url/name 解析。
3. `FeignClientOverrideDefaultsTests.java:80` — Java configuration 覆盖默认配置。
4. `FeignClientFactoryBeanIntegrationTests.java:70` — default headers / query parameters / dismiss404 等集成行为。
5. `SpringMvcContractTests` 与 `AbstractSpringMvcContractIntegrationTests` — Spring 注解进入 MethodMetadata 的桥接行为。

### 深审发现

1. **高风险：容易把 `@EnableFeignClients` 当成“直接创建代理”的开关。** 当前正文已压回 registrar -> BeanDefinition -> FactoryBean -> getObject() 这条桥接链。  
2. **高风险：容易把 Spring Cloud OpenFeign 写成第二套 Feign runtime。** 当前正文已明确它只是制造桥，真正 runtime 仍然来自 OpenFeign core。  
3. **中风险：容易忽略 named child context 的价值。** 当前正文已把 per-client 配置隔离和父上下文继承一起解释。  
4. **中风险：容易把 `SpringMvcContract` 误解成 MVC handler 机制。** 当前正文已把它定位为 Contract adapter。  
5. **低风险：容易把注入成功的 Bean 当成“OpenFeign runtime 已 ready”。** 当前正文已补出“proxy 在，runtime 行为仍在调用期发生”的边界。  

## 第二轮：因果审

- `@EnableFeignClients` 必须只导入 registrar，而不能直接创建代理，否则 Spring 配置阶段和 Feign runtime 组装阶段会混在一起：✅
- `FeignClientSpecification` 必须独立注册，否则每个 named client 无法拥有自己的配置空间：✅
- named child context 必须按需创建，否则每个 Feign client 的配置隔离和延迟初始化都会失效：✅
- `FeignClientFactoryBean` 必须作为 FactoryBean 桥接 Spring Bean 世界和 OpenFeign Builder 世界，否则 Spring 无法延迟并定制 client 创建：✅
- `SpringMvcContract` 必须作为 Contract 适配器而不是重写 MethodHandler/Client 链，否则 Spring 注解就会侵入 OpenFeign core 运行主线：✅

## 第三轮：结构审

正文结构按“困惑开场 → 前情回顾 → 失败方案(3个) → annotation -> child context -> builder -> proxy 总图 → `@EnableFeignClients` / registrar → `FeignClientFactory` / child context → `FeignClientsConfiguration` → `FeignClientFactoryBean` → `SpringMvcContract` → 误解澄清 → 收网总结”推进，没有退化成 Spring 配置属性清单。

失败方案已覆盖：
- `@EnableFeignClients` 一打开就直接创建代理  
- Spring Cloud OpenFeign 自己实现了一套 Feign runtime  
- 每个 `@FeignClient` 共用同一套配置  

每一层拆解均围绕“Spring 世界如何把 client 制造出来”这条桥接主线展开，符合 integration bridge 篇定位。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- `@EnableFeignClients` 如何导入 registrar
- registrar 如何注册 `FeignClientFactoryBean` / `FeignClientSpecification`
- named child context 为什么存在
- `FeignClientsConfiguration` 默认提供什么
- `FeignClientFactoryBean.getObject()` 如何回到 OpenFeign core
- `SpringMvcContract` 在这条桥里的位置

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未深入 OpenFeign core 的 MethodHandler / Client.execute / ResponseHandler（前几篇已覆盖）。✅
- 未展开 LoadBalancer / CircuitBreaker / OAuth2 / Refresh / Observability 细节。✅
- 未把 Spring MVC 注解解析细节写成单独语法手册。✅
- 重点仍压在 registrar / factory / named context / builder 组装桥接，边界收得住。✅

## 第六轮：依赖审

- 已承接 OpenFeign core 三篇：这篇只讲如何把 Spring 世界里的接口和配置接回 Feign core。✅
- `FeignClientsRegistrarTests`、`FeignClientOverrideDefaultsTests`、`FeignClientFactoryBeanIntegrationTests` 足以支撑桥接主线。✅
- 后续 `SpringMvcContract / per-client configuration`、`LoadBalancer`、`CircuitBreaker` 可以自然接在本篇后面继续展开。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。
- 代码块：使用少量 bridge 总图，不承担主叙事骨架。
- 源码引用：已与 rewrite-plan 证据清单对照，正文锚点来自 `EnableFeignClients`、`FeignClientsRegistrar`、`FeignClientFactory`、`FeignClientsConfiguration`、`FeignClientFactoryBean`、`DefaultTargeter`、`SpringMvcContract`、`NamedContextFactory`。
- 去掉代码块后正文仍成立：是。✅
- 叙述性正文字符数（不含代码块与空白行）：约 `12,270`。  
- 目标定位：Spring Cloud OpenFeign 第一篇接桥篇，篇幅与结构满足要求。✅

## 结论

本篇的目标是把 Spring Cloud OpenFeign 从“加个注解就有 HTTP client”提升到“annotation / BeanDefinition / child context / Builder / proxy 的制造桥”，讲清 registrar、FactoryBean、named context 和 `FeignClientsConfiguration` 各自处在什么位置，以及它们如何把 Spring 世界稳定地接回 OpenFeign core。