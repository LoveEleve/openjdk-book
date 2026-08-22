# 横切基础设施：common 模块

> 对应目录：`vol-xhs/13-common-cross-cutting/`
> 目标问题：my-xhs-common 里到底封装了哪些横切能力，它们各自解决什么问题，又留下了哪些边界和风险？

## 一句话答案

`my-xhs-common` 不是业务模块，而是全系统共用的横切基础设施层，主要集中了五类能力：AOP 切面（限流/幂等/分布式锁/TCC Fence）、MQ 幂等与 DLQ 框架、ID 生成（雪花/号段双Buffer/Redis 流水号）、读写分离与影子表路由、全链路 trace 与流量染色、以及多活（Zone）路由与数据源热切换。

## 1. AOP 横切切面

### 1.1 RateLimitAspect：Redis Lua 滑动窗口限流

`my-xhs-common/src/main/java/com/myxhs/common/aspect/RateLimitAspect.java:43` 基于 Redis Lua 脚本实现 ZSet 滑动窗口限流。Lua 脚本保证 ZREMRANGEBYSCORE + ZCARD + ZADD + EXPIRE 四步原子执行。Key 按 `prefix:className:methodName` 构建，`perUser=true` 时按 `X-User-Id` 或 `X-Real-IP` 细分。

**边界**：Redis 不可用时降级放行（保证核心业务可用，但限流失效）。未登录匿名用户共用 `...:ip:unknown` 一个 Key，限流粒度过粗。

### 1.2 IdempotentAspect：接口幂等

`my-xhs-common/src/main/java/com/myxhs/common/aspect/IdempotentAspect.java:47` 基于 Redis SET NX 判断幂等。异常处理区分可重试与不可重试：BizException 删除幂等标记允许重试，TimeoutException 保留幂等标记防止重复执行。

**边界**：Redis 不可用时降级放行；超时异常保守保留标记，可能导致业务实际未执行但被幂等键拦住。

### 1.3 IdempotentMessageAspect：MQ 消息幂等

`my-xhs-common/src/main/java/com/myxhs/common/aspect/IdempotentMessageAspect.java:42` 与 `IdempotentAspect` 类似，专为 MQ 消费者设计，Key 默认取第一个参数 toString。

### 1.4 DistributedLockAspect：分布式锁

`my-xhs-common/src/main/java/com/myxhs/common/aspect/DistributedLockAspect.java:43` 基于 Redisson，支持互斥锁、读写锁、公平锁。`leaseTime=-1` 启用 Watchdog 自动续期（30 秒锁，10 秒续期）。Redis 不可用时降级放行。

## 2. MQ 幂等与 DLQ

### 2.1 MessageIdempotentHelper：统一幂等工具

`my-xhs-common/src/main/java/com/myxhs/common/mq/MessageIdempotentHelper.java:36` 封装 `isFirstProcess()` / `removeMark()`，用于 MQ 消费者幂等。Redis 不可用时降级返回 `true`（首次处理），这意味着重复消息会被处理两次。

### 2.2 DlqMessageHandler：死信模板方法

`my-xhs-common/src/main/java/com/myxhs/common/mq/DlqMessageHandler.java:8` 提供 `handleDlqMessage()` 模板方法，记录死信指标到 Prometheus 并通过 `onDlqMessage()` 钩子支持自定义告警（钉钉/企微）。

## 3. ID 生成

`my-xhs-common/src/main/java/com/myxhs/common/id/IdGeneratorUtil.java:24` 封装三种策略：

- **雪花 ID**：使用 MyBatis-Plus 内置 `IdWorker.getId()`，用于订单/笔记/评论
- **号段双Buffer**：`SegmentIdGenerator` 在 `my-xhs-common/src/main/java/com/myxhs/common/id/SegmentIdGenerator.java:34` 实现，从 `t_id_segment` 表批量获取号段，双 Buffer 交替使用，当前号段使用 70% 时异步预加载下一个。号段加载用乐观锁 `WHERE version=?`，最多重试 3 次
- **Redis 流水号**：`nextSerialNo()` 生成 `{prefix}{yyyyMMdd}{6位序号}`，首次创建 Key 时设置 2 天 TTL

## 4. 读写分离与影子表

### 4.1 ReadWriteRoutingDataSource

`my-xhs-common/src/main/java/com/myxhs/common/datasource/ReadWriteRoutingDataSource.java:22` 实现三层路由策略（优先级从高到低）：

1. `DataSourceContextHolder` 手动指定
2. `@Transactional(readOnly=true)` 自动路由
3. SQL 分析路由（由 `ReadWriteRoutingInterceptor` 驱动）

从库不可用时自动降级到主库，每 30 秒探测一次从库恢复。

### 4.2 ReadWriteRoutingInterceptor

`my-xhs-common/src/main/java/com/myxhs/common/aspect/ReadWriteRoutingInterceptor.java:44` 是 MyBatis Executor 层拦截器，在 `getConnection()` 之前设置 SLAVE 标记。活跃写事务中不做 SQL 路由（保持单一连接，避免事务内 SELECT 走从库读到未提交数据）。

**边界**：`Executor.query` 方法一律判定为读操作，`SELECT ... FOR UPDATE` 也会被路由到从库，在高并发场景可能导致锁失效。

### 4.3 ShadowTableInterceptor

`my-xhs-common/src/main/java/com/myxhs/common/trace/ShadowTableInterceptor.java:51` 当 `TraceContextHolder.isPressureTest()` 为 true 时，自动将 SQL 中的 `t_` 开头的表名替换为 `{table}_shadow`。默认关闭，需配置 `myxhs.shadow.enabled=true`。

**边界**：正则 `(?i)(FROM|INTO|UPDATE|JOIN)\s+`?(t_\w+)`?` 只匹配关键字后紧跟的表名，不会处理 `SELECT ... FROM t_a, t_b` 中的第二个表，也不会处理子查询嵌套中的表名。

## 5. 全链路 trace 与流量染色

### 5.1 TraceContextHolder

`my-xhs-common/src/main/java/com/myxhs/common/trace/TraceContextHolder.java:17` 基于 ThreadLocal 管理 TraceContext，包含 `traceId`、`userId`、`grayTag`、`apiVersion`、`abGroup`、`pressureTest` 六个染色标记。提供 `snapshot()` 深拷贝供跨线程传递。

### 5.2 MqTraceHelper

`my-xhs-common/src/main/java/com/myxhs/common/trace/MqTraceHelper.java:33` 负责 MQ 生产者发送时将 TraceContext 注入消息 Header，消费者消费时恢复。标记通过 `wrapWithTraceContext()` / `restoreTraceContext()` 透传，支持灰度、压测、AB 测试组等流量元数据随 MQ 跨服务传播。

### 5.3 FeignInternalCallInterceptor

`my-xhs-common/src/main/java/com/myxhs/feign/config/FeignInternalCallInterceptor.java:22` 是全局 Feign 请求拦截器，自动注入 `X-Internal-Call` Header。Token 通过 `@Value("${myxhs.internal.token:}")` 和 `initFromEnv()` 双路径读取，默认空时 fail-closed（不携带 Header，下游拒绝）。

## 6. 多活（Zone）路由

### 6.1 ZoneContext

`my-xhs-common/src/main/java/com/myxhs/common/zone/ZoneContext.java:28` 单例状态管理器，维护当前 zone、优先路由启用状态、上游 zone 就绪百分比、同 zone 最小可用实例数、禁用 zone 等配置参数。通过 `PropertyChangeSupport` 支持数据源热切换等事件监听。

### 6.2 ZonePreferenceFilter

`my-xhs-common/src/main/java/com/myxhs/common/zone/ZonePreferenceFilter.java:34` 核心路由算法，10 步决策：

1. 空/单实体直接返回
2. Zone 功能未启用 → 返回全部
3. Zone 优先未启用 → 返回全部
4. 当前 zone 为无效值 → 忽略优先
5. 过滤禁用 zone 的实体 → 剩余不足时返回全部
6. 按 zone 分组统计
7. 上游 zone 就绪百分比未达标 → 返回全部
8. 同 zone 数不满足最小可用阈值 → 返回全部
9. 同 zone 有实体 → 返回同 zone 实体
10. 无同 zone 实体 → 返回全部（跨区 fallback）

### 6.3 ZonePreferenceServiceInstanceListSupplier

`my-xhs-common/src/main/java/com/myxhs/common/zone/loadbalancer/ZonePreferenceServiceInstanceListSupplier.java:19` 接入 Spring Cloud LoadBalancer，在 `get()` 返回服务实例列表时执行 zone 优先过滤。

### 6.4 DynamicDataSource

`my-xhs-common/src/main/java/com/myxhs/common/zone/datasource/DynamicDataSource.java:54` Zone 热切换数据源代理。在 `switchDataSource()` 切换目标 zone 的数据源时，通过 `waitForActiveConnections()` 等待最多 30 秒让活跃事务完成，超时后强制切换（依赖 TCC Cancel 兜底）。

### 6.5 Redis 命令拦截

`my-xhs-common/src/main/java/com/myxhs/common/zone/redis/wrapper/RedisTemplateWrapper.java:19` 通过 `preProcessConnection()` 注入 JDK 动态代理，`EventPublishingRedisCommandInterceptor` 在写命令执行成功后发布 `RedisCommandEvent` 到 Spring 事件总线，供跨 zone 数据同步使用。

### 5.2.1 空壳消费者：PayResultConsumer / RefundResultConsumer

`my-xhs-payment/src/main/java/com/myxhs/payment/consumer/PayResultConsumer.java:31` 和 `my-xhs-payment/src/main/java/com/myxhs/payment/consumer/RefundResultConsumer.java:27` 分别订阅了 `PAY_RESULT_TOPIC` 和 `REFUND_RESULT_TOPIC`，但**只读日志不做任何业务逻辑**。真正的订单通知走的是 Feign 同步（`notifyPaySuccess`/`notifyPayFail`），MQ 消息被消费空确认后实际丢失。`maxReconsumeTimes=5` 意味着空轮询 5 次后进 DLQ。这两个消费者属于**已接线但无业务逻辑的空壳**，如果后续真正依赖 MQ 做支付结果通知，需要补全消费者逻辑。

## 7. 可观测性：日志 / 指标 / 健康检查

### 7.1 日志

所有服务统一使用 `logback-spring.xml`，以 `LogstashEncoder` 输出 JSON 结构化日志，并携带 `app` 字段（`spring.application.name`）。日志通过 MDC 携带 `traceId` 和 `userId`，由 `TraceIdConfig`（HTTP 请求）和 `MqTraceHelper`（MQ 消费）分别注入。

### 7.2 全链路 trace 与染色

从请求进入 Gateway 到最终响应，trace 和染色标记经过三层透传：

1. **Gateway**：`RequestLogFilter` 生成/透传 `X-Trace-Id`，`TrafficColoringFilter` 注入 `X-Gray-Tag` / `X-Api-Version` / `X-AB-Group` / `X-Pressure-Test` 到 HTTP Header
2. **下游服务**：`TraceIdConfig.HandlerInterceptor`（Servlet）从 HTTP Header 恢复 `TraceContext` 到 `TraceContextHolder` + MDC
3. **Feign 调用**：`FeignTraceInterceptorConfig` 从 `TraceContextHolder` 读取 6 个染色标记透传到 Feign 请求 Header
4. **MQ 消息**：`MqTraceHelper.wrapWithTraceContext()` 在发送端注入，`restoreTraceContext()` 在消费端恢复

### 7.3 业务指标

`BusinessMetrics` 在 `my-xhs-common/src/main/java/com/myxhs/common/metrics/BusinessMetrics.java:26` 提供统一的 Counter / Timer 指标，通过 `MeterRegistry` 注册到 Micrometer，经 `/actuator/prometheus` 暴露。覆盖的指标包括：

- 订单：`orders.created.total`、`orders.paid.total`、`orders.timeout.closed`、`orders.create.latency`
- 库存：`inventory.prededuct.total`、`inventory.prededuct.latency`、`inventory.action.total`
- 支付：`payment.callback.total`
- Feed：`feed.push.total`、`feed.push.latency`
- 优惠券：`coupon.action.total`
- MQ：`mq.consume.total`、`myxhs.mq.dlq.total`

`MetricsAutoConfiguration` 在 `my-xhs-common/src/main/java/com/myxhs/common/metrics/MetricsAutoConfiguration.java:24` 负责为所有指标注入 `application` 和 `instance` 公共标签，并将 `BusinessMetrics` 注入到 `DlqMessageHandler`（死信指标记数）。

### 7.4 基础设施指标

- **Redis 客户端**：`LettuceMetricsConfig` 在 `my-xhs-common/src/main/java/com/myxhs/common/config/LettuceMetricsConfig.java:24` 启用 `MicrometerCommandLatencyRecorder`，记录 `lettuce.command.latency` / `lettuce.command.count` 指标
- **MyBatis SQL**：`MyBatisMetricsInterceptor` 在 `my-xhs-common/src/main/java/com/myxhs/common/metrics/MyBatisMetricsInterceptor.java:48` 记录 `mybatis.sql.latency` / `mybatis.sql.total` 指标
- **Tomcat**：`MyXhsTomcatCustomizer` 在 `my-xhs-common/src/main/java/com/myxhs/common/config/MyXhsTomcatCustomizer.java:21` 注册 MBean，配合 `server.tomcat.mbeanregistry.enabled=true` 暴露线程池指标
- **DLQ 死信积压**：`DlqMetrics` 在 `my-xhs-common/src/main/java/com/myxhs/common/metrics/DlqMetrics.java:22` 每 30 秒扫描 20+ 个 consumer group 的 `%DLQ%` 队列，缓存积压量后通过 Gauge 暴露 `rocketmq.dlq.backlog`
- **JVM 死锁**：`JvmDeadlockMetricsBinder` 定期检测 JVM 线程死锁并记录为指标
- **percentiles-histogram**：`HikariCP` 连接池和业务 Timer 均配置了 `percentiles-histogram=true`，保证 `histogram_quantile` 在 Prometheus 中可用

### 7.5 各服务可观测性落地的差异

扫描全部 13 个微服务的 `application.yml` 和 `logback-spring.xml` 后，可观测性采用的并不是"每个服务一套独立写法"，而是"common 提供统一底座 + 各服务做薄差异化声明"：

- **logback-spring.xml**：除 `content`、`gateway` 外，其余 10 个服务的 logback 文件字节级完全一致（一份 JSON Logstash 模板）；`content` 和 `gateway` 各有细微差异，但都基于同一套 JSON 结构化思路。
- **Actuator 端点**：所有服务统一暴露 `health,info,prometheus,metrics` 四个端点，`health` 开启 `probes`（liveness/readiness）。
- **percentiles-histogram**：所有服务统一为 Hikari `connections.acquire/usage/creation` 和三个业务延迟 Timer（`feed.push.latency`、`orders.create.latency`、`inventory.prededuct.latency`）开启 bucket，保证 `histogram_quantile` 可用。注意：这是一份被复制到所的配置，即使某服务并不实际产生对应业务指标，也会声明这三个延迟 Timer。
- **logging.level**：统一 `com.myxhs: info`；`order` 额外加上 `org.apache.shardingsphere: info`。
- **XXL-Job**：`order/search/home/notification` 等持有任务的服务各自声明 executor 端口与 logpath；`notification/home` 用了 `${XXL_JOB_TOKEN:...}` 环境变量注入。
- **Sentinel 端口**：每服务在 `spring.cloud.sentinel.transport.port` 单独分配 8726~8734，避免同机多实例端口冲突。

这意味着：可观测性底座确实是横切的（common 提供 Exchange/MDC/Metrics 标签），但**落地细节是逐服务显式声明的**，且有一定复制粘贴痕迹（业务延迟 Timer 声明与真实埋点并不完全对齐）。

### 7.6 健康检查

各服务通过 Actuator 暴露 `/actuator/health`、`/actuator/info`、`/actuator/prometheus`、`/actuator/metrics`，并启用 `livenessState` / `readinessState` 探针。自定义健康指标：

- `CacheRedisHealthIndicator`：Redis 连接健康检查
- `RocketMQHealthIndicator`：RocketMQ 连接健康检查（各服务 consumer 组）
- `ApplicationReadinessIndicator`：应用就绪状态

### 6.6 多活（Zone）代码的存活状态

多活基础设施并非全部生效，需要明确区分"活"与"死"：

- **ZoneContext 是活**：`ZoneContextAutoConfiguration` 的 `@ConditionalOnProperty(matchIfMissing=true)` 默认启用，从 `spring.cloud.nacos.discovery.metadata.zone`（各服务配置 `${MYXHS_ZONE:defaultZone}`）读取当前 zone，`zone` 属性变化会触发 `PropertyChangeSupport` 事件。
- **Zone 优先路由是死代码**：`ZoneLoadBalancerConfiguration` 需要 `myxhs.availability.zone.preference.enabled=true` 才创建 `ZonePreferenceServiceInstanceListSupplier`，但全仓库没有任何 application.yml 打开该开关，因此同 zone 优先/跨区兜底/禁用 zone/就绪百分比这套负载均衡过滤逻辑从未被接线。
- **Redis 命令拦截是死代码**：`RedisInterceptorAutoConfiguration` 使用 `matchIfMissing=false`，需要 `myxhs.redis.interceptor.enabled=true` 才包装 `RedisTemplate`，而该配置也不存在，`EventPublishingRedisCommandInterceptor`（跨 zone 同步事件）没有实际生效。
- **DynamicDataSource 是死代码**：zone 动态数据源只提供了类，没有任何自动配置或服务引用，跨 zone 数据源热切换也没有接线。

结论：`my-xhs` 的 ZoneContext 是当前真实生效的基础设施（感知 zone），但 zone 优先路由、Redis 跨 zone 事件、数据源热切换属于"代码已存在、开关未启用"的未激活能力。文档描述时必须把它如实写成预留能力，而非已落地链路。

## 8. 真实缺陷与边界清单

### 7.1 限流/幂等切面的 Redis 降级窗口

`RateLimitAspect`、`IdempotentAspect`、`IdempotentMessageAspect`、`DistributedLockAspect`、`MessageIdempotentHelper` 在 Redis 不可用时全部降级放行。这意味着 Redis 故障期间会失去限流保护、幂等保护和分布式锁保护，全站退化为无保护状态。

### 7.2 幂等异常处理的不对称性

`IdempotentAspect` 对 `BizException` 删除幂等标记允许重试，但 `BizException` 也可能在业务部分执行后抛出，导致重试后部分操作重复执行。当前依赖各业务模块自行保证 `BizException` 语义为"业务未实际执行"。

### 7.3 SELECT ... FOR UPDATE 路由到从库

`ReadWriteRoutingInterceptor` 对 `Executor.query` 方法一律判定为读操作，`SELECT ... FOR UPDATE` 会被路由到从库，在高并发锁场景下会导致锁失效。

### 7.4 影子表正则有局限

`ShadowTableInterceptor` 的正则只匹配 `FROM/INTO/UPDATE/JOIN` 后紧跟的 `t_` 表名，不会处理 `SELECT ... FROM t_a, t_b` 中的第二个表，也不会处理子查询嵌套中的表名。

### 7.5 Zone 过滤器对禁用 zone 的处理

`ZonePreferenceFilter` 过滤禁用 zone 后如果剩余实体 <= 1，回退到返回原始全量实体（而非过滤后的目标实体），意味着禁用 zone 的实体在"剩余不足"时不会被过滤掉。

### 7.6 DynamicDataSource 超时切换依赖 TCC Cancel

Zone 切换时等待活跃事务最多 30 秒，超时后强制切换数据源。此时正在执行的 TCC 事务（Try 已完成但 Confirm/Cancel 未执行）可能因数据源切换而无法正确完成，依赖 TCC Cancel 兜底机制保证数据最终一致。

## 8. 证据清单

- 限流切面与 Lua 脚本：`my-xhs-common/src/main/java/com/myxhs/common/aspect/RateLimitAspect.java:43`
- 幂等切面：`my-xhs-common/src/main/java/com/myxhs/common/aspect/IdempotentAspect.java:47`
- 分布式锁切面：`my-xhs-common/src/main/java/com/myxhs/common/aspect/DistributedLockAspect.java:43`
- 消息幂等辅助：`my-xhs-common/src/main/java/com/myxhs/common/mq/MessageIdempotentHelper.java:36`
- 死信模板：`my-xhs-common/src/main/java/com/myxhs/common/mq/DlqMessageHandler.java:8`
- 号段双Buffer 生成器：`my-xhs-common/src/main/java/com/myxhs/common/id/SegmentIdGenerator.java:34`
- ID 生成工具：`my-xhs-common/src/main/java/com/myxhs/common/id/IdGeneratorUtil.java:24`
- 读写分离路由：`my-xhs-common/src/main/java/com/myxhs/common/datasource/ReadWriteRoutingDataSource.java:22`
- MyBatis 读写路由拦截器：`my-xhs-common/src/main/java/com/myxhs/common/aspect/ReadWriteRoutingInterceptor.java:44`
- 影子表路由：`my-xhs-common/src/main/java/com/myxhs/common/trace/ShadowTableInterceptor.java:51`
- 全链路 trace 上下文：`my-xhs-common/src/main/java/com/myxhs/common/trace/TraceContextHolder.java:17`
- MQ 染色透传：`my-xhs-common/src/main/java/com/myxhs/common/trace/MqTraceHelper.java:33`
- 全局 Feign 内部调用拦截器：`my-xhs-common/src/main/java/com/myxhs/feign/config/FeignInternalCallInterceptor.java:22`
- TCC Fence 三阶段：`my-xhs-common/src/main/java/com/myxhs/common/tcc/TccFenceService.java:24`
- Zone 上下文：`my-xhs-common/src/main/java/com/myxhs/common/zone/ZoneContext.java:28`
- Zone 优先路由算法：`my-xhs-common/src/main/java/com/myxhs/common/zone/ZonePreferenceFilter.java:34`
- Zone 负载均衡：`my-xhs-common/src/main/java/com/myxhs/common/zone/loadbalancer/ZonePreferenceServiceInstanceListSupplier.java:19`
- Zone 动态数据源：`my-xhs-common/src/main/java/com/myxhs/common/zone/datasource/DynamicDataSource.java:54`
- Zone Redis 命令拦截与事件发布：`my-xhs-common/src/main/java/com/myxhs/common/zone/redis/wrapper/RedisTemplateWrapper.java:19`、`my-xhs-common/src/main/java/com/myxhs/common/zone/redis/interceptor/EventPublishingRedisCommandInterceptor.java:18`
- 混沌工程注入：`my-xhs-common/src/main/java/com/myxhs/common/chaos/ChaosInterceptor.java:27`