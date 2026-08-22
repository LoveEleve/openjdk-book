# Spring Cloud OpenFeign：SpringMvcContract、配置属性与 per-client 配置 — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch11-springcloud-openfeign`
- 篇：`02 SpringMvcContract、配置属性与 per-client 配置`
- 对应主题：`F-SC-2 Spring Contract / Configuration`
- 文章类型：Spring 集成契约篇
- 正文状态：未开始
- 分析对象：`Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`

## 文章定位

- 核心困惑：第一篇已经讲清 Spring Cloud OpenFeign 的 client creation bridge，但读者仍然会问：`@FeignClient` 接口上写的 `@GetMapping`、`@PathVariable`、`@RequestParam` 到底是怎么被 OpenFeign core 理解的？`spring.cloud.openfeign.client.config.foo.timeout` 等配置属性为什么能覆盖 Java configuration 的 Bean？`name`、`contextId`、Bean name 到底有什么区别？
- 一句话顿悟：Spring Cloud OpenFeign 通过 `SpringMvcContract` 把 Spring MVC 注解翻译成 OpenFeign `MethodMetadata`，再通过 `FeignClientProperties` 把 externalized 配置属性按 `default -> client-specific` 的优先级覆盖规则喂进 `FeignClientFactoryBean` 的 builder 组装过程；`name` 是 service id，`contextId` 是 child context 标识，Bean name 是接口 Spring 容器中的名称，三者不是同一个东西。
- 文章边界：本篇重点讲 `SpringMvcContract` 的注解适配逻辑、`FeignClientProperties` 的配置覆盖规则、`name/contextId/Bean name` 的语义差异，以及 `FeignBuilderCustomizer` / `Capability` 如何接入 per-client 配置；不展开 LoadBalancer、CircuitBreaker，不重讲 OpenFeign core 的 `Contract`/`MethodMetadata` 内部实现。

## 前置依赖

### HARD

- `ch11-springcloud-openfeign/01-enablefeignclients-registrar-factorybean.md`
- `ch10-openfeign-core/02-contract-methodmetadata-requesttemplate.md`

### SOFT

- 不要求先懂 Spring Cloud LoadBalancer 全量机制。
- 不要求先懂 OpenFeign core 的 `DefaultContract` 全量细节。

### NAV

- 后续可接：`LoadBalancer 如何接管 Feign Client`
- 后续可接：`CircuitBreaker / fallback / refresh / observability`

## 一句话困惑

`@GetMapping` 和 `@PathVariable` 这种 Spring MVC 注解，到底是怎么被 OpenFeign 理解的？配置属性为什么能覆盖 Java 配置类？`name`、`contextId`、Bean name 到底有什么区别？

## 一句话顿悟

Spring Cloud OpenFeign 通过 `SpringMvcContract` 把 Spring 风格注解翻译成 OpenFeign 的 `MethodMetadata`，通过 `FeignClientProperties` 把 externalized 配置属性以 `default -> client-specific` 的顺序覆盖进 builder 组装过程，通过 `FeignBuilderCustomizer` 和 `Capability` 让 per-client 定制化不限于 `@FeignClient(configuration = ...)` 一种方式。

## 读者理解路径

1. 先否定“Spring MVC 注解和 Feign 注解是两套独立体系”的理解。
2. 建立总图：Spring annotations → `SpringMvcContract` → `MethodMetadata` → `Feign.Builder`。
3. 解释 `SpringMvcContract` 如何把 `@RequestMapping`/`@GetMapping`/`@PostMapping` 变成 HTTP method 和 path template。
4. 解释 `@PathVariable`、`@RequestParam`、`@RequestHeader`、`@SpringQueryMap` 等参数注解如何被 `AnnotatedParameterProcessor` 分类。
5. 解释 `FeignClientProperties` 的配置覆盖规则：`default-to-properties`、`default config` → `client config`。
6. 解释 `name` / `contextId` / Bean name / qualifier 的语义差异。
7. 解释 `FeignBuilderCustomizer` 和 `Capability` 如何接入 per-client 配置。
8. 收束到：Spring Cloud OpenFeign 的配置体系不是扁平属性表，而是三层叠加。

## 失败方案推演

### 失败方案一：Spring MVC 注解和 Feign 注解是两套完全独立的体系

- 这会让人以为 `SpringMvcContract` 是一个“额外的翻译器”，而不是 `Contract` 接口的一个实现。
- 实际上 `SpringMvcContract` 直接继承 `Contract.BaseContract`，它就是 OpenFeign core 的 `Contract` 接口在 Spring 环境下的实现。
- 所以 Spring MVC 注解解析不是“另外一套”，而是通过同一套 `Contract -> MethodMetadata -> RequestTemplate` 主线走下来的。

### 失败方案二：`spring.cloud.openfeign.client.config` 里的属性，优先级一定高于 `@FeignClient(configuration = ...)`

- 这取决于 `default-to-properties` 的值。
- `true` 时 properties 优先级高于 Java configuration。
- `false` 时 Java configuration 优先级高于 properties。
- 所以不能简单说“properties 一定覆盖 Java config”。

### 失败方案三：`name` 和 `contextId` 可以随便互换

- `name` 是 service id / load-balancer name。
- `contextId` 是 child context 的标识和配置 key。
- 默认相等，但显式指定 `contextId` 后就可以指向同一 service 的多客户端使用不同 child context。

## 必须澄清的误解

1. `SpringMvcContract` 不是 MVC handler，而是 `Contract` 实现。
2. `@RequestMapping` 不允许出现在 `@FeignClient` 接口的类级别上。
3. `default-to-properties` 控制 Java config 与 properties 的优先级顺序。
4. `name` 和 `contextId` 语义不同，默认相等但不互锁。
5. `FeignBuilderCustomizer` 和 `Capability` 是 per-client 配置文件之外的两条自定义入口。

## 文章结构与字数预算

1. 困惑开场：Spring MVC 注解怎么变成 Feign 请求（800-1000 字）
2. 最小总图：SpringMvcContract + 配置覆盖 + per-client 定制（1000-1400 字）
3. `SpringMvcContract`：注解适配与参数分类（1800-2400 字）
4. `FeignClientProperties`：配置覆盖规则（1400-2000 字）
5. `name` / `contextId` / Bean name 语义（1200-1600 字）
6. `FeignBuilderCustomizer` / `Capability`：per-client 定制的额外入口（1200-1600 字）
7. 收网总结（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `spring-cloud-openfeign-core/src/main/java/org/springframework/cloud/openfeign/support/SpringMvcContract.java:98` — 类型定义
- `SpringMvcContract.java:226` — 类级 `@RequestMapping` 拒绝
- `SpringMvcContract.java:240` — `parseAndValidateMetadata` 入口
- `SpringMvcContract.java:298` — HTTP method 解析
- `SpringMvcContract.java:307` — path 解析
- `SpringMvcContract.java:327` — produces / consumes
- `SpringMvcContract.java:360` — 参数处理器入口
- `SpringMvcContract.java:479` — 内置处理器注册
- `FeignClientFactoryBean.java:166` — `configureFeign(...)`
- `FeignClientFactoryBean.java:173` — `default-to-properties` 分支
- `FeignClientFactoryBean.java:256` — `configureUsingProperties(...)`
- `FeignClientFactoryBean.java:269` — properties 应用顺序
- `FeignClientsRegistrar.java:441` — `getClientName(...)`
- `FeignClientsRegistrar.java:339` — `getContextId(...)`
- `FeignAutoConfiguration.java:113` — `FeignClientFactory` 创建
- `FeignClientsConfiguration.java:145` — `SpringMvcContract` 声明
- Core OpenFeign `Contract.java:49` — `parseAndValidateMetadata`

## 测试证据清单

- `SpringMvcContractTests.java` — 全部注解解析测试
- `SpringMvcContractIntegrationTests.java`
- `SpringMvcContractSlashEncodingIntegrationTests.java`
- `FeignClientOverrideDefaultsTests.java:80` — 配置覆盖测试
- `FeignClientFactoryBeanIntegrationTests.java:70` — 集成行为

## 版本边界

- 当前分析对象固定为 `Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`。
- 本篇不展开 OpenFeign core 的 `Contract.BaseContract` 全量解析逻辑（前卷已覆盖）。
- 不展开 LoadBalancer / CircuitBreaker 细节。

## 与其他篇的边界

### 本篇要讲清

- `SpringMvcContract` 的注解适配逻辑。
- `FeignClientProperties` 的配置覆盖规则。
- `name` / `contextId` / Bean name 的语义。
- `FeignBuilderCustomizer` / `Capability` 的 per-client 接入点。

### 本篇不深讲

- OpenFeign core 的 `Contract` 内部 `MethodMetadata` 构造细节（前卷已覆盖）。
- LoadBalancer / CircuitBreaker 细节。
- 所有 `AnnotatedParameterProcessor` 实现逐个展开。

## 写作后检查

- [ ] 开篇先抓“Spring MVC 注解怎么变成 Feign 请求”，而不是直接讲 `SpringMvcContract` 类定义。
- [ ] 至少展开 3 个失败方案，且包含“Spring MVC 注解和 Feign 注解是两套独立体系”。
- [ ] 明确给出 `SpringMvcContract` 的适配总图。
- [ ] 不把本篇写成注解属性说明书。
- [ ] 每个配置覆盖规则都要落到 `file:line`。
- [ ] 删除代码块后，读者仍能复述 `SpringMvcContract`、配置覆盖、`name/contextId` 的核心关系。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。