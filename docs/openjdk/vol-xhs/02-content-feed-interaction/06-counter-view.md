# counter：互动计数的展示视图层

> 对应模块：`my-xhs-counter`
> 目标问题：为什么计数要单独拆一个服务，它到底持有什么状态，又补了哪些工程边界？

## 一句话答案

`my-xhs-counter` 不是互动关系真相层，而是互动计数展示层：它消费 `SOCIAL_TOPIC`，把点赞、收藏、评论、分享、浏览、关注这些事件收敛成用户和内容侧的聚合数，再通过 Redis + Buffer + MySQL 三层结构兼顾实时读、批量写和最终持久化。

## 1. 业务：它持有的是“展示数”，不是“动作关系”

counter 回答的是：

- 某篇笔记当前点赞数是多少
- 某条评论当前点赞数是多少
- 某个用户当前粉丝数、关注数是多少

它不回答“谁点过赞”“谁关注了谁”。这些真相仍然在 analytics/content。

这就是为什么 `CounterController` 明确只提供查询和手动对账，不提供 HTTP 写入接口，见 `my-xhs-counter/src/main/java/com/myxhs/counter/controller/CounterController.java:14`。

## 2. 微服务：它是被动收敛者，不是业务源头

`CounterEventConsumer` 订阅 `SOCIAL_TOPIC`，按 Tag 把行为映射成目标类型和计数类型，见 `my-xhs-counter/src/main/java/com/myxhs/counter/consumer/CounterEventConsumer.java:17`。

具体映射关系包括：

- `LIKE/UNLIKE` → 笔记或评论点赞数
- `FAVORITE/UNFAVORITE` → 笔记收藏数
- `COMMENT/UNCOMMENT` → 笔记评论数
- `SHARE` → 笔记分享数
- `VIEW` → 笔记浏览数
- `FOLLOW/UNFOLLOW` → 用户粉丝数和关注数

因此 counter 的微服务定位很明确：它只负责把别域已经发生的动作，收敛成统一可读的计数视图。

## 3. 分布式：它靠 Redis 实时态 + Buffer 刷盘 + 对账修复维持一致性

### 3.1 写链路是三层

`CounterService` 的类注释已经把设计写明了，见 `my-xhs-counter/src/main/java/com/myxhs/counter/service/CounterService.java:21`：

1. Redis `INCR/DECR` 或 Lua 原子脚本，先让用户立即看到最新计数
2. `CounterBuffer` 把增量攒批合并，见 `my-xhs-counter/src/main/java/com/myxhs/counter/buffer/CounterBuffer.java:21`
3. `CounterMapper.batchUpsert()` 再批量刷到 MySQL，见 `my-xhs-counter/src/main/java/com/myxhs/counter/mapper/CounterMapper.java:17`

### 3.2 点赞计数是 Set-based，不再相信单纯 delta

为解决 MQ 乱序，点赞计数已经不是简单 `+1/-1`，而是 Redis Set 的 `SADD/SREM + SCARD`，见 `my-xhs-counter/src/main/java/com/myxhs/counter/service/CounterService.java:98`。

这意味着：

- `UNLIKE` 先到不会把计数打成负值
- 重复 `LIKE` 不会继续加 1
- 最终计数由成员集大小决定，而不是由消息到达顺序决定

### 3.3 最终一致性靠对账任务和权威源回拉

`CounterService.reconcile()` 会扫描 DB 与 Redis 差异做修复，见 `my-xhs-counter/src/main/java/com/myxhs/counter/service/CounterService.java:518`；而点赞计数还会额外从 analytics 的权威 Set 回拉，见 `my-xhs-counter/src/main/java/com/myxhs/counter/service/CounterService.java:340`。

这说明 counter 从设计上就承认：它是视图层，必要时要被业务真相层反向纠偏。

## 4. 工程：这个模块的瓶颈主要在批量读和刷盘写

### 4.1 Buffer-Trigger 是核心工程点

`CounterBuffer` 用双 buffer 交换、排序后批量 upsert、失败重试、停机前强制刷盘，见 `my-xhs-counter/src/main/java/com/myxhs/counter/buffer/CounterBuffer.java:34`。

这个模块真正的工程价值，不在于“有个缓存”，而在于把高频小增量改造成可批处理的稳定写流。

### 4.2 批量查询不是天然安全，必须限制输入天花板

`batchGetCounts()` 会把请求展开后做 Redis Pipeline，再把未命中的项拼成 MySQL `IN (...)` 批量查询，见 `my-xhs-counter/src/main/java/com/myxhs/counter/service/CounterService.java:428`。

如果没有请求上限，这条读链很容易被超大批量请求打穿：

- Redis 一次性 Pipeline 过长
- MySQL `IN` 子句和参数包体过大
- counter 实例临时对象暴涨

这轮已补上 DTO 约束：

- `queries` 最多 100 项，见 `my-xhs-counter/src/main/java/com/myxhs/counter/dto/CounterBatchRequest.java:20`
- 每项 `countTypes` 最多 7 项，见 `my-xhs-counter/src/main/java/com/myxhs/counter/dto/CounterBatchRequest.java:40`

## 5. Bug：这轮重新深挖补出的真实问题

### 5.1 批量查询入口原来没有输入上限

这是典型的工程型漏洞：接口逻辑本身正确，但边界没封住，导致“批量能力”可以被误用成“无限批量能力”。修复后，这条链才真正和 `Pipeline + batch SQL` 的设计假设对齐。

### 5.2 counter 永远不能被误当成动作真相源

排障时如果只盯着 `t_counter` 或 Redis `myxhs:counter:*`，很容易把“展示数漂移”误当成“业务动作没发生”。但 counter 设计上就允许短时漂移，并依赖对账修复；它是展示视图，不是行为真相。

## 6. 真实故障案例：为什么批量查询口会演变成工程型风险点

### 现象

接口语义只是“批量拿几个计数”，平时也很容易被当成读接口里的优化项。但只要调用方把 `queries` 塞得足够大，counter 实例就会同时放大三段成本：Redis Pipeline 长度、MySQL `IN` 参数规模、以及 JVM 临时对象数量。

### 根因

`batchGetCounts()` 的核心路径本身没错：批量展开 → Pipeline 批量 GET → MySQL 批量回查。真正的问题是旧 DTO 没有写入输入上限，于是“批量”被放大成了“理论上无限批量”。

### 修复前

- 接口层允许超大 `queries`
- 服务层照单全收，继续展开所有 `countTypes`
- Redis / MySQL / JVM 同时承压

这类问题最隐蔽的地方在于：代码逻辑仍然完全正确，但工程边界已经失效。

### 修复后

- `queries` 最多 100 项
- 每项 `countTypes` 最多 7 项
- 批量能力终于和 Pipeline、批量 SQL 的设计假设一致

### 余波

这说明 counter 最危险的错误，不一定是计数算错，反而可能是“接口太通用、边界没封住”。对这种视图层服务来说，输入规模本身就是 correctness 的一部分，因为一旦实例被大请求压垮，再正确的计数逻辑也来不及执行。

## 证据清单

- 写链路总注释：`my-xhs-counter/src/main/java/com/myxhs/counter/service/CounterService.java:21`
- Set-based like 计数：`my-xhs-counter/src/main/java/com/myxhs/counter/service/CounterService.java:98`
- Buffer 刷盘：`my-xhs-counter/src/main/java/com/myxhs/counter/buffer/CounterBuffer.java:21`
- MQ 消费映射：`my-xhs-counter/src/main/java/com/myxhs/counter/consumer/CounterEventConsumer.java:17`
- 对账任务：`my-xhs-counter/src/main/java/com/myxhs/counter/job/CounterReconcileJob.java:11`
- DTO 上限：`my-xhs-counter/src/main/java/com/myxhs/counter/dto/CounterBatchRequest.java:20`
