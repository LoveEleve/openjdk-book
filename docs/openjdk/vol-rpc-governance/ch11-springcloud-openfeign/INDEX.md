# Spring Cloud OpenFeign 章节索引

> 收口时间：2026-08-22  
> 当前覆盖范围：`ch11-springcloud-openfeign` 全章  
> 当前状态：累计 `7` 篇 article base / `21` 个文件，三件套完整

## 一、这份索引解决什么问题

这份索引不是简单列文件名，而是把 Spring Cloud OpenFeign 这一章重新压成一张阅读地图。

它回答三个问题：

1. 这 7 篇分别在整章里承担什么角色？
2. 如果读者不是顺序通读，应该从哪一篇切入？
3. 到这一章结束时，Spring Cloud OpenFeign 相对 OpenFeign core，边界到底收在了哪里？

## 二、当前完成总览

| 章节 | 主题 | 已完成 |
|------|------|--------|
| `01` | registrar / factory bean / child context | 1/1 |
| `02` | contract / configuration / properties | 1/1 |
| `03` | load balancer client bridge | 1/1 |
| `04` | circuit breaker / fallback | 1/1 |
| `05` | micrometer / observation / capability | 1/1 |
| `06` | timeout / request options / retry / redirect | 1/1 |
| `07` | codec / error decoder / capability boundary | 1/1 |

总计：`7` 篇，`21` 个文件，目录级三件套完整率 `100%`。

## 三、推荐阅读顺序

### 路线 A：第一次系统进入 Spring Cloud OpenFeign

按完整主线读：

1. `01-enablefeignclients-registrar-factorybean.md`
2. `02-springmvccontract-configuration-properties.md`
3. `03-loadbalancer-feign-client.md`
4. `04-circuitbreaker-fallback.md`
5. `05-micrometer-observation-capability.md`
6. `06-timeout-options-retry-redirect.md`
7. `07-codec-errordecoder-capability-boundary.md`

这条路线对应一条非常稳定的理解路径：

- 先看 Feign client 怎么被注册、怎么进 child context
- 再看 Spring MVC 注解和配置怎么进入 builder
- 然后按运行期横切能力依次补：LoadBalancer、CircuitBreaker、Micrometer、Options/Retry
- 最后用 codec / error / capability 边界，把 Spring Cloud 与 OpenFeign core 的职责切开

### 路线 B：只关心线上行为与故障定位

如果读者是带着线上问题来的，建议这样进入：

1. `03-loadbalancer-feign-client.md`
2. `04-circuitbreaker-fallback.md`
3. `06-timeout-options-retry-redirect.md`
4. `05-micrometer-observation-capability.md`
5. 回补：`01-enablefeignclients-registrar-factorybean.md`
6. 回补：`07-codec-errordecoder-capability-boundary.md`

这条路线优先回答：

- 请求为什么打到了某个实例
- 失败后为什么进入 fallback 或没有进入 fallback
- timeout / retry / redirect 为什么和直觉不一样
- 观测能力到底挂在 builder 的哪一层

### 路线 C：只关心框架装配边界

如果读者想搞清 Spring Cloud 到底比 OpenFeign core 多做了什么，建议这样读：

1. `01-enablefeignclients-registrar-factorybean.md`
2. `02-springmvccontract-configuration-properties.md`
3. `05-micrometer-observation-capability.md`
4. `07-codec-errordecoder-capability-boundary.md`

这条路线的目标不是排障，而是建立一个稳定边界：

- child context / registrar / factory bean 在哪一层
- Spring MVC contract 与 properties 配置在 builder 的哪一层
- capability 是 Feign core 的 enrich 机制还是 Spring Cloud 的装配器
- codec / error decoder 的 default 和兜底到底归谁

## 四、篇章索引

| 文件 | 角色定位 | 读者收获 |
|------|----------|----------|
| `01-enablefeignclients-registrar-factorybean.md` | 入口与装配总线 | 建立 `@EnableFeignClients -> Registrar -> FactoryBean -> child context` 主线 |
| `02-springmvccontract-configuration-properties.md` | 注解契约与配置落位 | 理解 Spring MVC 注解、properties、config class 如何汇入 builder |
| `03-loadbalancer-feign-client.md` | serviceId 到真实实例的桥 | 理解逻辑 target、`FeignBlockingLoadBalancerClient`、选路与 503 语义 |
| `04-circuitbreaker-fallback.md` | 失败保护与降级语义 | 理解 `FeignCircuitBreaker.Builder`、`Targeter`、fallback / fallbackFactory 与 invocation 层包装 |
| `05-micrometer-observation-capability.md` | 观测集成与 capability 主线 | 理解 observation vs legacy metrics、child context 开关、`builder.addCapability()` |
| `06-timeout-options-retry-redirect.md` | timeout / retry 真实执行链 | 理解 `Request.Options`、`Retryer`、`runWithRetry()`、raw Feign 与 Spring 默认差异 |
| `07-codec-errordecoder-capability-boundary.md` | 章节收束与边界切分 | 理解 Spring Cloud 负责拼 Spring-aware bean 图，OpenFeign core 负责定义并消费 SPI |

## 五、这一章真正讲清了什么

到这里，这一章已经不再只是"Spring Cloud 怎么用 OpenFeign"，而是形成了一个完整的源码闭环：

1. **注册闭环**：`@EnableFeignClients` 如何把接口变成真正可注入的 bean
2. **装配闭环**：Spring MVC contract、配置类、properties 如何进入 builder
3. **请求路由闭环**：serviceId 如何在运行期变成真实 host
4. **失败保护闭环**：失败如何在 invocation 层进入 CircuitBreaker 与 fallback
5. **观测闭环**：Micrometer/Observation 如何通过 capability 进入 builder enrichment
6. **执行策略闭环**：timeout / redirect / retryer 如何从 properties 变成 runtime 行为
7. **边界闭环**：Spring Cloud 与 OpenFeign core 各自负责什么

## 六、当前最稳的结论

到这里，Spring Cloud OpenFeign 这一章最稳的结论可以压成一句话：

**Spring Cloud OpenFeign 的核心职责，不是重写 Feign runtime，而是用 Spring 的注册机制、child context、配置模型和少量基础设施桥，把 OpenFeign core 的 SPI 组装成一套 Spring 应用可用的 client 运行时。**

再拆细一点，就是四层：

- **注册层**：Registrar / FactoryBean / child context
- **装配层**：Contract / Encoder / Decoder / ErrorDecoder / Options / Retryer
- **桥接层**：LoadBalancer / CircuitBreaker / Micrometer
- **边界层**：Spring 语义适配 vs OpenFeign core SPI / runtime

## 七、和 OpenFeign core 章节的边界

这一章如果和前面的 OpenFeign core 三篇放在一起读，分工会非常清楚：

- OpenFeign core 章节负责回答：Feign 自己的 builder、proxy、client、codec、retry、error、capability 是怎么工作的
- Spring Cloud OpenFeign 章节负责回答：Spring 是怎么把这些 core SPI 组装成框架内可注入、可配置、可观测、可治理的 client 的

也就是说：

- OpenFeign core 偏 runtime spine
- Spring Cloud OpenFeign 偏 integration spine

## 八、后续最自然的动作

到这一章收口后，后面最自然有两条路：

1. **修总索引 / 卷级导航**  
   把 OpenFeign core 与 Spring Cloud OpenFeign 两部分统一进 Feign 总目录或 RPC/治理卷总导航。
2. **进入下一技术栈**  
   顺着治理侧继续推进 `Spring Cloud LoadBalancer`、`CircuitBreaker` 下层库，或者切到 `Nacos` / `Sentinel` / `Cloud Gateway` 这类更外层基础设施。

## 九、当前状态结论

- 当前目录级三件套完整率：`100%`
- 当前已完成 article base：`7`
- 当前总文件数（三件套）：`21`
- 当前这一章已形成稳定闭环，可作为 Spring Cloud OpenFeign 的章节级总索引使用
