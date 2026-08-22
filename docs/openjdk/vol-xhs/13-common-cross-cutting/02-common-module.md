# common：全系统共享的横切基础设施层

> 对应模块：`my-xhs-common`
> 目标问题：为什么 common 不是“工具类堆放区”，而是整个系统很多正确性前提的承载层？

## 一句话答案

`my-xhs-common` 不是边角料，而是全系统的横切正确性底座：限流、幂等、分布式锁、TCC Fence、ID 生成、读写分离、影子表、trace、内部调用令牌、多活 Zone 和可观测性能力都从这里长出来。业务服务看上去各自独立，但很多关键正确性前提其实共享同一套 common 机制。

## 1. 业务：它不直接做业务，却改变所有业务怎样成立

common 不回答“订单多少钱”“谁点赞了谁”，但它会决定：

- 同一个请求能否重复执行
- 同一段临界区能否被并发进入
- 一条消息是否会被重复消费
- Trace 和内部调用身份能否跨服务透传
- 读请求到底去主库还是从库

因此它虽然不是业务模块，却直接参与业务正确性。

## 2. 微服务：它是共享底座，不是独立域服务

与 search、order、content 不同，common 不作为单独进程对外提供业务接口；它以内嵌库方式进入每个服务。也正因为如此，一处 common 的设计边界会被放大到全系统。

## 3. 分布式：它把很多分散问题收敛成统一机制

### 3.1 限流 / 幂等 / 分布式锁都建立在 Redis 语义上

- `RateLimitAspect` 用 Lua 做滑动窗口限流
- `IdempotentAspect` / `IdempotentMessageAspect` 用 Redis 标记做幂等
- `DistributedLockAspect` 用 Redisson 做分布式锁

见 `my-xhs-common/src/main/java/com/myxhs/common/aspect/RateLimitAspect.java:43`、`my-xhs-common/src/main/java/com/myxhs/common/aspect/IdempotentAspect.java:47`、`my-xhs-common/src/main/java/com/myxhs/common/aspect/DistributedLockAspect.java:43`。

### 3.2 trace / Feign / MQ 透传是一条统一上下文链

`TraceContextHolder`、`MqTraceHelper`、`FeignInternalCallInterceptor` 一起负责把 traceId、用户上下文、灰度标记和内部调用身份跨 HTTP/Feign/MQ 传播。

### 3.3 多活 Zone 现在是“部分活、部分死”的预留体系

- `ZoneContext` 真正在用
- Zone 优先路由、Redis 拦截、DynamicDataSource 目前都没接线

所以 common 里很多多活代码不是“坏掉”，而是“存在但没被启用”。

## 4. 工程：这个模块最危险的地方在于“一改全站受影响”

### 4.1 common 的失败是系统级失败

业务模块里一个 bug 往往只影响一条链；common 的 bug 会同时影响多条链，因为每个服务都在共享它。典型例子就是：内部调用 token、限流切面、Trace 透传和读写路由，只要其中一个公共假设出错，就会在多个服务同时冒出来。

### 4.2 工具化外观容易掩盖它的真实重要性

common 最容易被低估的点是：很多类看上去像“工具类”或“配置类”，但它们实际上定义的是系统协议。比如幂等异常如何删标记、内部调用 token 如何 fail-closed、读写分离何时路由从库，这些都不是实现细节，而是系统行为规则。

## 5. Bug：这轮重扫继续确认的真实问题

### 5.1 `SELECT ... FOR UPDATE` 误路由问题已经修正

`ReadWriteRoutingInterceptor` 之前对 `Executor.query` 一律按读操作处理，`SELECT ... FOR UPDATE` 也会被送到从库，锁语义直接失效。现在已经改成先解析 `BoundSql`：命中 `FOR UPDATE` 时按写链路处理，其余只读 SQL 再继续走从库判断。

### 5.2 Zone 相关代码要严格区分“已生效”和“预留未接线”

如果把 `ZonePreferenceFilter`、`DynamicDataSource`、Redis 命令拦截都写成已落地能力，会直接误导读者和排障者。当前真正在线上生效的只是 `ZoneContext` 感知，其他几块仍是预留能力。

## 6. 真实故障案例：为什么 common 层最危险的错误往往不是单点 bug，而是全站退化

### 现象

系统不会立刻全部 500，但会出现一类很难第一时间归因的全站退化：限流突然失效、幂等保护突然失效、分布式锁开始放行、重复消息处理概率上升。表面看像多个业务同时“各自出了一点问题”。

### 根因

这些问题的共同根因通常不在某个业务模块，而在 common 共享机制的退化策略。当前很多 Redis 依赖型横切能力在 Redis 不可用时都会降级放行：

- 限流放行
- 幂等放行
- 分布式锁放行
- MQ 幂等工具放行

### 修复前的系统语义

- 优先保证主流程可用
- 共享保护能力失效时默默放开
- 结果是全站进入“可用但无保护”的退化态

### 当前文档要强调的边界

- 这不是单模块 bug，而是平台级退化策略
- Redis 故障期间的行为必须被明确当成风险窗口
- 不能把“业务没报错”误当成“系统仍保持原保护级别”

### 余波

这个故障模型说明，common 最需要审的不是单个算法是否优雅，而是：共享底座在依赖失效时到底把全系统带向什么状态。它最危险的地方恰恰在于——出问题时看起来像很多业务都轻微异常，实际上根因是一处横切策略同时影响了所有人。

## 证据清单

- common 主文：`docs/openjdk/vol-xhs/13-common-cross-cutting/01-common-infrastructure.md:1`
- 限流切面：`my-xhs-common/src/main/java/com/myxhs/common/aspect/RateLimitAspect.java:43`
- 幂等切面：`my-xhs-common/src/main/java/com/myxhs/common/aspect/IdempotentAspect.java:47`
- 分布式锁切面：`my-xhs-common/src/main/java/com/myxhs/common/aspect/DistributedLockAspect.java:43`
- 读写路由：`my-xhs-common/src/main/java/com/myxhs/common/aspect/ReadWriteRoutingInterceptor.java:44`
- `FOR UPDATE` 路由修复点：`my-xhs-common/src/main/java/com/myxhs/common/aspect/ReadWriteRoutingInterceptor.java:68`
- Zone 上下文：`my-xhs-common/src/main/java/com/myxhs/common/zone/ZoneContext.java:28`
