# home：页面聚合与降级控制层

> 对应模块：`my-xhs-home`
> 目标问题：为什么 home 不是薄 BFF，而是一个需要主动管理并发、依赖分层和页面故障语义的聚合层？

## 一句话答案

`my-xhs-home` 不拥有最多业务真相，但它决定前端最终以什么形状、什么延迟、什么降级语义看见这些真相。它真正负责的是页面编排：把 Feed、笔记详情、商品详情、用户主页和购物车页拆成不同的下游拓扑，再用线程池、`CompletableFuture` 和字段级降级把结果组装成页面视图。

## 1. 业务：它负责的是页面视图，不是领域真相

home 回答的是：

- 首页 Feed 该怎样聚合作者、计数、互动状态
- 笔记详情页该怎样把内容、作者、评论、计数拼成一个对象
- 用户主页和购物车页怎样以页面语义返回，而不是原样吐下游对象

因此 home 的业务角色不是“再做一份内容/商品/购物车”，而是“把多个域重新组织成页面级 VO”。

## 2. 微服务：它位于前端和多个后端域之间的编排缝合层

- content / product / user / cart / coupon / inventory / analytics / counter 各自提供局部真相
- home 决定页面按什么层次、什么并发方式去读这些真相
- 前端不再自己理解每个下游的接口碎片和故障差异

这让 home 天然不是业务源头服务，而是消费多个源头服务的页面消费层。

## 3. 分布式：它的核心问题不是数据库一致性，而是下游扇出和故障传播

### 3.1 Controller 层已经主动异步化

`HomeController` 几个主入口都返回 `CompletableFuture`，见 `my-xhs-home/src/main/java/com/myxhs/home/controller/HomeController.java:46`。这说明 home 从入口就承认：页面聚合不应长时间占着请求线程同步等待所有下游。

### 3.2 聚合拓扑按页面分层，而不是一把梭并发

- `NoteAggService` 是两层聚合，先拿笔记本体，再补作者和评论，见 `my-xhs-home/src/main/java/com/myxhs/home/service/NoteAggService.java:24`
- `UserProfileAggService` 更偏单层并行，见 `my-xhs-home/src/main/java/com/myxhs/home/service/UserProfileAggService.java:24`
- `FeedService` 先从 Redis 收件箱/发件箱拿 noteId，再补详情和作者/计数，见 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:31`

### 3.3 降级语义由 BFF 统一编码

home 不是只决定“怎么查”，还决定“出错时页面还能不能成立”：

- 核心下游不可用时整体失败
- 弱依赖字段不可用时置默认值或空集合
- 这类决策不再散落在前端

## 4. 工程：这个模块最重的是线程池和资源模型

### 4.1 不是所有并发都能共用一个线程池

`AggregatorThreadPoolConfig` 明确拆出了 `aggregatorPool` 和 `batchFeignPool`，就是为了避免外层聚合任务把线程池占满，内层批量 Feign 子任务拿不到线程，见 `my-xhs-home/src/main/java/com/myxhs/home/config/AggregatorThreadPoolConfig.java:61`。

### 4.2 home 的真正工程成本在扇出

一个页面请求背后常常不是 1 次下游调用，而是多层扇出：先拿 ID，再查详情，再补作者、计数、互动状态。这使得 home 的瓶颈通常是：

- 线程池饥饿
- 下游超时传播
- 批量 Feign 扇出成本
- MDC / trace 上下文在异步线程中的透传

## 5. Bug：这轮重扫继续确认并修复的真实问题

### 5.1 Feed 清理任务原来把限速计数器写进了循环体

`FeedCleanupJob` 原来在两个清理循环里都把 `count` 写在 `while` 内部，导致“每 100 条 sleep 50ms”的限速逻辑实际上永远不触发。现在已经把计数器外提，恢复分批限速，见 `my-xhs-home/src/main/java/com/myxhs/home/job/FeedCleanupJob.java:1`。

### 5.2 Feed 作者信息与大 V 关系集都补了批量化/缓存化

这一轮又补了两个此前仍留在运行态的热点：

- 作者公开信息不再按作者逐个 Feign 拉取，而是新增 user 批量公开信息接口，Feed 改成单次批量调用
- 关注大 V 列表不再每次请求都全量扫关注 ZSet + `MGET` 所有 bigV 标记，而是增加 `myxhs:feed:following:bigv:{userId}` 的 5 分钟缓存

这说明 home 现在不只是“并行化下游调用”，而是已经开始把高频聚合热点进一步收敛成真正的批量接口和短 TTL 视图缓存。

## 6. 真实故障案例：为什么一个看似不起眼的清理任务 bug 会慢慢演变成 Redis 压力问题

### 现象

系统平时功能都正常，但 Redis 里的 Feed 收件箱/发件箱脏数据清理速度越来越慢。线上不会立刻 500，而是清理任务执行时间持续拉长，冷数据积压增加，后续分页和未读逻辑都开始背负更多历史垃圾。

### 根因

问题不在清理策略本身，而在节流计数器作用域。旧实现想表达的是“每处理 100 条停 50ms”，但 `count` 放在 `while` 循环内部，每轮迭代都会重新归零，限速条件永远无法成立。

### 修复前

- 逻辑看上去有 sleep 节流
- 真实运行中计数器每轮重置
- 清理任务实际按最快速度持续扫 Redis

### 修复后

- `count` 外提到循环外
- 每累计 100 条再 sleep 50ms
- 清理速度重新回到可控节奏

### 余波

这个问题很典型：home 虽然主要是读聚合层，但它一旦带了后台清理任务、未读维护和 Feed 视图收口，就同样会出现“不是功能错，而是节奏错”的运行态 bug。页面层服务不只怕 500，也怕这种慢慢拖高底层存储压力的隐形问题。

## 证据清单

- BFF 主文：`docs/openjdk/vol-xhs/06-search-recommendation-home/04-home-bff.md:1`
- Feed 清理修复点：`my-xhs-home/src/main/java/com/myxhs/home/job/FeedCleanupJob.java:1`
- Feed 聚合：`my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:31`
- 线程池配置：`my-xhs-home/src/main/java/com/myxhs/home/config/AggregatorThreadPoolConfig.java:13`
