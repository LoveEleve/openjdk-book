# Spring Cloud OpenFeign：从 `@EnableFeignClients` 到 Feign Proxy — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch11-springcloud-openfeign`
- 篇：`01 从 @EnableFeignClients 到 Feign Proxy`
- 对应主题：`F-SC-1 Client Creation Bridge`
- 文章类型：Spring 集成桥接篇
- 正文状态：未开始
- 分析对象：`Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`

## 文章定位

- 核心困惑：不懂 Spring Cloud OpenFeign 源码的读者，最容易以为 `@FeignClient` 只是“给接口加个注解”，启动后 Spring 自然就会帮你造出一个可用的远程代理。但真正的问题是：这个代理是在哪一层被创建的？`@EnableFeignClients` 只是打开扫描，还是已经开始创建客户端？为什么每个 client 要有自己的 named child context？`FeignClientFactoryBean` 到底何时调用 OpenFeign core？
- 一句话顿悟：Spring Cloud OpenFeign 并没有重写 Feign runtime，它做的是一座“客户端制造桥”：`@EnableFeignClients` 导入 `FeignClientsRegistrar`，registrar 把 `@FeignClient` 接口注册成 `FeignClientFactoryBean`（或 lazy supplier）BeanDefinition，并记录一份 `FeignClientSpecification`；真正的代理创建发生在 `FeignClientFactoryBean.getObject()`，它会从 `FeignClientFactory` 管理的 named child context 中拿到 `Feign.Builder`、`Contract`、`Encoder`、`Decoder`、`Client`、`Targeter` 等组件，再调用 OpenFeign core 的 `Builder.target(...)` 造出最终 proxy。
- 文章边界：本篇只讲 Spring Cloud OpenFeign 的 client creation bridge：`@EnableFeignClients`、`FeignClientsRegistrar`、`FeignClientFactoryBean`、`FeignClientFactory` / `NamedContextFactory`、`FeignClientsConfiguration` 和 `SpringMvcContract` 的位置；不展开 LoadBalancer、CircuitBreaker、OAuth2、Refresh、Micrometer 等后续基础设施覆盖层。

## 前置依赖

### HARD

- `ch10-openfeign-core/01-runtime-spine-builder-proxy-http.md`
- `ch10-openfeign-core/02-contract-methodmetadata-requesttemplate.md`
- `ch10-openfeign-core/03-client-codec-retry-error-capability.md`

### SOFT

- 不要求先懂 Spring BeanFactory 全量机制。
- 不要求先懂 Spring Cloud LoadBalancer / CircuitBreaker。

### NAV

- 后续可接：`SpringMvcContract / client configuration`
- 后续可接：`LoadBalancer 如何接管 Feign Client`
- 后续可接：`CircuitBreaker / fallback / refresh / observability`

## 一句话困惑

`@EnableFeignClients`、`@FeignClient`、`FeignClientFactoryBean`、named child context 这些东西，到底是谁在什么时机把一个接口变成真正的 Feign proxy？

## 一句话顿悟

Spring Cloud OpenFeign 把“制造 Feign client”拆成两层：Spring 侧负责发现接口、注册 BeanDefinition、构建 per-client child context 和配置环境；OpenFeign core 侧负责用 builder / contract / method handler / client 真正生成 proxy。`FeignClientFactoryBean` 正好卡在这两层之间，成为最关键的桥对象。

## 读者理解路径

1. 先否定“`@EnableFeignClients` 一打开就直接创建代理”这种理解。
2. 建立最小总图：annotation -> registrar -> BeanDefinition -> FactoryBean -> named context -> Feign.Builder -> target -> proxy。
3. 解释 `@EnableFeignClients` / `FeignClientsRegistrar`：如何扫描并注册 client definition。
4. 解释 `FeignClientSpecification`：为什么每个 client 需要保存自己的 configuration 描述。
5. 解释 eager 与 lazy attributes resolution 的差异。
6. 解释 `FeignClientFactory` / `NamedContextFactory`：为什么每个 client 要有 child context。
7. 解释 `FeignClientsConfiguration` 提供哪些默认 Bean，以及它们如何喂进 `FeignClientFactoryBean`。
8. 解释 `FeignClientFactoryBean.getObject()` 和 `Targeter.target(...)` 怎样调用回 OpenFeign core。
9. 收束到：Spring Cloud OpenFeign 不是第二套 Feign runtime，而是 Feign client 的 Spring 制造桥。

## 失败方案推演

### 失败方案一：`@EnableFeignClients` 打开时就直接创建了所有代理

- 这会把 registrar 和 factory bean 的职责混成一层。
- 实际上 `@EnableFeignClients` 只是导入 registrar，registrar 主要负责扫描接口并注册 BeanDefinition，不直接生成代理对象。
- 真正的代理创建要等到 `FeignClientFactoryBean.getObject()` 被调用时才发生。

### 失败方案二：Spring Cloud OpenFeign 自己实现了一套 Feign runtime

- 这会低估 OpenFeign core 的作用。
- Spring Cloud 负责发现接口、命名子上下文、组装 Builder 所需的 Spring Bean；真正的 MethodMetadata、MethodHandler、InvocationHandler、Client.execute() 仍然来自 OpenFeign core。
- 所以 Spring Cloud 不是 runtime 本身，而是 runtime 的制造桥。

### 失败方案三：每个 `@FeignClient` 共享完全同一套 Spring Bean 配置

- 这会解释不了不同 client 为什么可以有不同 contract、encoder、decoder、logger、request interceptor 等。
- `FeignClientFactory` 基于 `NamedContextFactory` 为每个 contextId 创建一个 child context，client-specific configuration 正是在这里隔离生效。
- 所以 named child context 不是多余设计，而是 per-client 配置隔离的必要前提。

## 必须澄清的误解

1. registrar 不创建代理，它只注册“将来能创建代理”的 BeanDefinition。
2. `FeignClientFactoryBean` 不是 HTTP client，它是连接 Spring 和 OpenFeign core 的 FactoryBean。
3. named child context 不是为了好看，而是为了每个 client 拿到独立配置空间。
4. `SpringMvcContract` 是 OpenFeign `Contract` 的 Spring 适配器，不是 Spring MVC Controller 机制的一部分。
5. `@FeignClient(name)`、`contextId`、Bean name、qualifier 不是同一个概念。

## 文章结构与字数预算

1. 困惑开场：为什么“加个注解”远不止注册一个 Bean（800-1000 字）
2. 最小总图：annotation -> registrar -> child context -> builder -> proxy（1000-1400 字）
3. `@EnableFeignClients` / registrar：扫描与 BeanDefinition 注册（1600-2200 字）
4. `FeignClientSpecification` 与 named child context（1400-2000 字）
5. `FeignClientsConfiguration`：默认 Bean 提供（1400-1800 字）
6. `FeignClientFactoryBean`：真正创建 client proxy（1800-2400 字）
7. SpringMvcContract 在这条链里的位置（1000-1400 字）
8. 收网总结（600-800 字）

目标叙述性正文：`10000-14000` 字；代码块不计入目标。

## 证据清单

- `spring-cloud-openfeign-core/src/main/java/org/springframework/cloud/openfeign/EnableFeignClients.java:41` — `@Import(FeignClientsRegistrar.class)`
- `FeignClientsRegistrar.java:152` — `registerBeanDefinitions`
- `FeignClientsRegistrar.java:157` — register default configuration
- `FeignClientsRegistrar.java:172` — scan / explicit clients path
- `FeignClientsRegistrar.java:222` — eager register `FeignClientFactoryBean`
- `FeignClientsRegistrar.java:266` — lazy attributes resolution path
- `FeignClientsRegistrar.java:463` — `FeignClientSpecification` 注册
- `spring-cloud-openfeign-core/src/main/java/org/springframework/cloud/openfeign/FeignClientFactory.java:39` — extends `NamedContextFactory`
- `FeignClientFactory.java:47` — default config type = `FeignClientsConfiguration`
- `spring-cloud-openfeign-core/src/main/java/org/springframework/cloud/openfeign/FeignClientsConfiguration.java:102` — decoder
- `FeignClientsConfiguration.java:108` — encoder
- `FeignClientsConfiguration.java:145` — `SpringMvcContract`
- `FeignClientsConfiguration.java:160` — default `Retryer.NEVER_RETRY`
- `FeignClientsConfiguration.java:203` — prototype `Feign.Builder`
- `spring-cloud-openfeign-core/src/main/java/org/springframework/cloud/openfeign/FeignClientFactoryBean.java:135` — `feign(context)`
- `FeignClientFactoryBean.java:166` — `configureFeign(...)`
- `FeignClientFactoryBean.java:256` — properties 覆盖顺序
- `FeignClientFactoryBean.java:454` — `getObject()`
- `FeignClientFactoryBean.java:465` — `getTarget()`
- `FeignClientFactoryBean.java:483` — URL 存在时 builder/client/targeter
- `FeignClientFactoryBean.java:427` — `loadBalance(...)`
- `spring-cloud-openfeign-core/src/main/java/org/springframework/cloud/openfeign/DefaultTargeter.java:25` — `feign.target(target)`
- `spring-cloud-openfeign-core/src/main/java/org/springframework/cloud/openfeign/support/SpringMvcContract.java:98` — SpringMvcContract 类型定义
- `spring-cloud-commons/.../NamedContextFactory.java:119` — getContext lazy creation
- `NamedContextFactory.java:143` — registerBeans
- `NamedContextFactory.java:187` — child context parent

## 测试证据清单

- `FeignClientsRegistrarTests.java:49`
- `FeignClientsRegistrarTests.java:133`
- `FeignClientOverrideDefaultsTests.java:80`
- `FeignClientFactoryBeanIntegrationTests.java:70`
- `SpringMvcContractTests`
- `AbstractSpringMvcContractIntegrationTests`
- `CompatibleDubboAutoConfigurationTest`（无关，勿混）

## 版本边界

- 当前分析对象固定为 `Spring Cloud OpenFeign 4.3.2 + OpenFeign 13.6.1`。
- 本篇的精确 `file:line` 证据优先来自 `spring-cloud-openfeign` 仓库；本地 OpenFeign `13.14-SNAPSHOT` 只作为上一卷 core 概念参照。
- 不把 Spring Cloud 4.3.2 的行为和 OpenFeign 13.14 的细节直接画等号。

## 与其他篇的边界

### 本篇要讲清

- `@EnableFeignClients` 如何导入 registrar。
- registrar 如何把 `@FeignClient` 注册成 `FeignClientFactoryBean` / BeanDefinition。
- named child context 如何形成每个 client 的独立配置空间。
- `FeignClientFactoryBean` 怎样真正回调到 OpenFeign core 造 proxy。

### 本篇不深讲

- Spring MVC 注解怎样解析成 MethodMetadata 细节（只定位到 `SpringMvcContract`）。
- LoadBalancer / CircuitBreaker / OAuth2 / Refresh / Observability 细节。
- OpenFeign core 的 MethodHandler / Client / ResponseHandler 细节（前几篇已覆盖）。

## 写作后检查

- [ ] 开篇先抓“为什么加个注解不等于立刻有代理”，而不是直接讲 registrar。
- [ ] 至少展开 3 个失败方案，且包含“@EnableFeignClients 直接创建代理”“Spring Cloud 重写 Feign runtime”。
- [ ] 明确给出 annotation -> child context -> builder -> proxy 总图。
- [ ] 不把本文写成配置属性清单。
- [ ] 每个桥接对象都先讲职责，再给 file:line。
- [ ] 删除代码块后，读者仍能复述 registrar/factory/named-context 的关系。
- [ ] 所有 `file:line` 写正文时重新验证。
- [ ] 通过一次性深审收口。