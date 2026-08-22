# 点赞、收藏、评论与分享链

> 对应目录：`vol-xhs/02-content-feed-interaction/`
> 目标问题：为什么内容互动不是“改一条记录”这么简单，而是一条会继续扩散到计数、通知、推荐和后续展示的事件链？

## 一句话困惑

从用户视角看，点赞、收藏、评论、分享这些动作都很轻：

- 点一下赞
- 收藏一下
- 留一句评论
- 转发一次

它们似乎只是某篇笔记旁边的几个按钮。

但只要把这些动作放回系统里，就会马上碰到一个更复杂的事实：**每一个互动动作都不只是在修改“当前内容自己的状态”，它还会继续影响至少三件事：**

1. 计数展示要不要变
2. 通知要不要发给别人
3. 后续推荐、Feed 和热度要不要感知这次行为

也就是说，互动在产品层面像局部按钮，在系统层面却更像事件源。

这篇真正要讲清楚的，不是 Controller 上有哪些接口，而是：**为什么互动行为在 `my-xhs` 里被设计成“Redis 权威动作 + MQ 扩散 + 下游视图收敛”的链，而不是一次简单的表更新。**

## 一句话答案

当前 `my-xhs` 的互动链不是“谁点了赞就把 like_count +1”，而是：由 analytics/content 这些源服务先接住用户动作，把点赞/关注/评论/分享等权威关系落在 Redis 或内容库里，再通过 `SOCIAL_TOPIC`、`NOTIFICATION_TOPIC` 等事件继续扩散到 counter、notification、推荐和 Feed 视图。也就是说，互动行为的本体和互动行为的影响，从一开始就被拆成了两层。

## 先建立最小心智模型

先把当前互动链压成两层：

```text
动作本体层
  用户到底有没有点过赞 / 关注过某人 / 发出一条评论

扩散视图层
  点赞数、评论数、通知、推荐信号、后续内容分发
```

这两层虽然前后相连，但不是同一份状态：

- 动作本体回答“动作是否真的发生了”
- 扩散视图回答“这次动作对别人和别的系统意味着什么”

只要先把这两层拆开，后面点赞、评论、关注和计数为什么分散在不同服务里就都顺了。

## 先推演第一个最直觉的失败方案：互动动作直接改数据库计数列

这是最容易想到的做法。

### 为什么这个方案很诱人

因为它几乎和产品动作一一对应：

- 点赞 → `like_count + 1`
- 取消点赞 → `like_count - 1`
- 评论 → `comment_count + 1`
- 分享 → `share_count + 1`

甚至连 UI 上显示什么都可以直接对上。

### 它会先坏在哪里

它会先坏在“动作关系”和“展示计数”根本不是同一种真相。

以点赞为例，系统至少要回答两个不同问题：

1. 某个用户现在到底算不算已经点过赞？
2. 这篇笔记现在总共有多少赞？

第一个问题必须知道“谁和谁的关系”，第二个问题才是聚合数。

如果一开始就只改计数列：

- 重复点赞和取消点赞的幂等性会立刻变脆
- 网络重试或 MQ 重试容易把计数打歪
- 后续再想做“我是否已点赞”时，又得反推一套关系记录

所以当前实现没有把互动理解成“先改 count”，而是先立住动作关系，再让计数跟着这层关系收敛。

## 再推演第二个失败方案：动作发生时把通知、计数、推荐同步一起做完

为了避免前一个问题，另一种很自然的思路是：那就动作发生时，一次同步把所有影响都做完。

### 为什么这个方案也很诱人

因为它看起来“最终一致性最少”：

- 点赞时立刻改关系
- 立刻改计数
- 立刻发通知
- 立刻记推荐行为

用户也会觉得所有地方都是即时更新。

### 它为什么在当前系统里同样不合适

它会把原本很轻的交互动作，拖成一条长同步链。

点赞动作本身原本只需要确定“这个用户是否已点赞”，但如果把通知、计数、推荐都同步串上去：

- 某个下游服务抖一下，点赞本体就会失败
- 一个简单互动按钮会依赖太多后续动作都实时成功
- 用户感知是“我点个赞怎么也能转圈”

这正是当前实现为什么几乎都采用：

```text
动作本体先成立
后续影响再异步扩散
```

## 第一步：点赞先在 Redis 关系层成立，而不是先动计数

`LikeController` 在 `my-xhs-analytics/src/main/java/com/myxhs/analytics/controller/LikeController.java:35` 到 `:67` 中暴露点赞与取消点赞入口。

真正的关键逻辑在 `LikeService`。

### 当前点赞权威数据源是什么

`LikeService` 注释在 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:25` 到 `:36` 写得非常直接：

- Redis Set 存储点赞关系（权威数据源）
- `SADD` 天然幂等
- MQ 异步落库到 MySQL（最终一致性）

这说明系统首先关心的是：**这个用户和这个笔记/评论之间，现在有没有一条点赞关系。**

### 为什么点赞还要再叠一层 `@Idempotent`

`LikeController.like()` 在 `my-xhs-analytics/src/main/java/com/myxhs/analytics/controller/LikeController.java:42` 到 `:52` 上既加了 `@RateLimit`，又加了 `@Idempotent`。

这说明当前实现把幂等分成了两层：

- `@Idempotent`：挡住网络抖动和极短窗口重复提交
- `SADD`：从业务关系层保证“同一用户重复点赞不再产生第二条关系”

也就是说，幂等不是交给某一层单独处理，而是从入口到关系存储一起守。

### 点赞成功后会扩散什么

`LikeService.like()` 在 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:103` 到 `:119` 中，至少做了两条后续扩散：

1. 给笔记作者或评论作者发通知（`NOTIFICATION_TOPIC`）
2. 发 `LIKE` 事件到 MQ，让后续 MySQL 持久化或计数视图更新

这说明当前点赞不是“点完就地结束”，而是会继续推动通知与计数链。

## 第二步：关注关系和点赞一样，也是先立关系，再扩散影响

`FollowService` 在 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:27` 到 `:40` 中，把自己定义成：

- Redis ZSet 为权威关注关系
- Lua 原子操作维护关注/粉丝关系和计数
- MySQL 只是同步写入兜底

### 当前关注关系本体先成立在哪里

`follow()` 在 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:75` 到 `:145` 中，先做了：

- 不能关注自己
- 目标用户存在性校验
- 被拉黑时拒绝关注
- 两段 Lua：当前用户侧关注列表 + 目标用户侧粉丝列表

也就是说，关注关系本体在当前实现里不是 `t_follow` 表，而是 Redis 两端关系结构。

### 关注成功后又会扩散什么

`FollowService.follow()` 后续又做了两件事：

1. 发送 MQ 更新 counter 服务的关注/粉丝计数，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:141` 到 `:142`
2. 发关注通知，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:144` 到 `:145`

这说明关注动作和点赞动作一样，当前实现里都遵循：

```text
关系先成立
影响再扩散
```

## 第三步：评论先写进内容本体，再在 afterCommit 扩散通知和计数

评论链和点赞/关注又有一个很关键的不同：评论本体本身就是内容域的一部分。

`CommentService.createComment()` 在 `my-xhs-content/src/main/java/com/myxhs/content/service/CommentService.java:67` 到 `:206` 中，顺序非常清楚：

1. 校验笔记存在且已发布
2. DFA 敏感词检测
3. 校验父评论 / replyTo 关系
4. 插入评论
5. 事务提交后再清缓存、发通知、发计数事件

### 为什么评论和点赞不一样

因为点赞和关注本体都是“关系”，评论本体是“内容”。

所以评论必须先在内容域里成为一条正式评论，再在事务提交后：

- 发 `NOTIFICATION_TOPIC` 通知被评论者或被回复者，见 `my-xhs-content/src/main/java/com/myxhs/content/service/CommentService.java:173` 到 `:202`
- 发评论计数事件给 counter 服务，见 `my-xhs-content/src/main/java/com/myxhs/content/service/CommentService.java:163` 到 `:164`

这说明评论的扩散顺序比点赞更严格：**评论本体必须先落定，通知和计数才能跟着成立。**

### 评论删除的双权限模型

创建评论只有一种身份（登录用户），但删除评论却有两种身份。`CommentService.deleteComment()` 允许**评论作者本人**或**笔记作者**删除评论，见 `my-xhs-content/src/main/java/com/myxhs/content/controller/CommentController.java:49` 到 `:62` 的注释：“评论作者或笔记作者可删除”。删除一级评论时，其下所有子评论也会被级联删除。

这说明当前系统对评论的管理权不是“谁写的谁管”，而是“写的人和被写的人一起管”。笔记作者对自己笔记下的评论有治理权，这和纯关系型互动（点赞、关注）的权限模型完全不同。

### 分享链：计数事件走 MQ 异步扩散

`NoteService.shareNote()` 在 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:495` 到 `:507` 中，先校验笔记存在，然后通过 `sendCounterEvent()` 发送 `SOCIAL_TOPIC:SHARE` 事件。这个方法用 `asyncSend` 加回调发送，成功只记 debug 日志，失败只记 warn 日志——是典型的 fire-and-forget 模式。内容域不等 counter 确认，也不对发送失败做重试。

这说明分享计数的可靠性完全依赖 MQ + counter 消费端，内容域只负责“事件已发出”，不负责“计数已收敛”。

## 第三步半：内容域对外暴露的内部端点

除了面向用户的 API，内容域还通过 `CommentController` 暴露了一个仅供微服务内部调用的端点：`/internal/info/{commentId}`，见 `my-xhs-content/src/main/java/com/myxhs/content/controller/CommentController.java:122` 到 `:137`。

这个端点返回评论的存在性、作者和所属笔记 ID，供 analytics 点赞校验与评论点赞通知使用。它的保护机制不是 Gateway 层的用户认证，而是 `X-Internal-Call` Header 里的静态 Token 校验——只有持有正确 token 的内部服务才能调用。

这是一个典型的微服务内部通信模式：内容域不把评论详情通过公开 Feign 接口暴露给所有人，而是用一个带 token 保护的内部端点专门给需要的域使用。它说明当前系统在“服务间调用”层面已经区分了“面向用户的公开 API”和“面向内部服务的受保护端点”。

## 第四步：计数服务明确把“写入”从 HTTP 里剥离出去，只承认 MQ 驱动

`CounterController` 的类注释在 `my-xhs-counter/src/main/java/com/myxhs/counter/controller/CounterController.java:14` 到 `:19` 已经把自己的定位写明：

- 写入统一通过 MQ 事件驱动
- HTTP 只提供查询和手动对账

这说明当前实现明确拒绝了一种常见偷懒做法：

```text
互动服务自己改计数表
```

相反，当前设计是：

- analytics / content 这些源服务发事件
- counter 的 `CounterEventConsumer` 订阅 `SOCIAL_TOPIC`，按 `LIKE / FAVORITE / COMMENT / FOLLOW` 等 Tag 分派处理，见 `my-xhs-counter/src/main/java/com/myxhs/counter/consumer/CounterEventConsumer.java:17` 到 `:33` 和 `:87` 到 `:108`
- counter 再作为专门的展示计数视图去收敛

收藏事件也有直接实现证据：`FavoriteService.favorite()` 通过 Redis ZSet 建立收藏关系后，发送 `SOCIAL_TOPIC:FAVORITE`，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FavoriteService.java:49` 到 `:85`；counter 消费端再把它映射到笔记收藏计数，见 `my-xhs-counter/src/main/java/com/myxhs/counter/consumer/CounterEventConsumer.java:167` 到 `:195`。

这也说明计数并不是动作本体的内联字段，而是动作扩散后的投影视图。

### counter 查询口的工程边界

`CounterController.batchGetCounts()` 对外暴露的是批量计数查询接口，真实执行路径是：先把请求展开成多组 `targetType:targetId:countType`，再做 Redis Pipeline 批量 GET，最后把 Redis 未命中的项拼成一条 MySQL `IN (...)` 批量回查。

这条路径的性能前提，不是“接口天然就是批量的”，而是“调用方提交的批量规模本身受控”。旧实现里 `queries` 和每项 `countTypes` 都没有上限，恶意或误用请求可以一次塞进非常大的列表，直接放大成超长 Pipeline 和超大 SQL `IN`。这类问题平时压测不一定显影，但在生产里会直接表现成 Redis 单次请求过大、MySQL SQL 包体过长、以及 counter 实例瞬时内存抖动。

当前修复已经把入参限制为：最多 100 个 query、每个 query 最多 7 个计数类型。也就是说，counter 这条读链真正的稳定性，不只来自“用了 Pipeline”，还来自“把批量接口的输入天花板写进 DTO 校验”。

## 第五步：互动链为什么天然会继续影响推荐和 Feed，而不只是通知和计数

如果只看点赞或评论局部逻辑，很容易以为它们最多影响通知和计数。但从整个项目结构看，互动行为天然还会反向影响流量入口。

### 关注行为直接影响 Feed 候选来源

`FollowService` 本身维护的是关注关系，而 `FeedService` 在读取时又会基于关注列表去拉大V outbox。也就是说，关注动作不是“社交局部信息”，它直接决定了后续 Feed 候选集合从哪里来。

### 点赞、收藏、停留具备进入推荐行为语义的条件

推荐链那一章已经证明 `ItemCFRecallStrategy` 会从 `t_user_behavior` 中取正向行为，而 `RecommendService.reportBehavior()` 也会接收点赞、收藏、长停留等行为类型并写入 `RECOMMEND_BEHAVIOR_TOPIC`。因此可以确认：这些行为具备进入推荐链的输入路径。

但本文不把“每一次 analytics 点赞/收藏事件都必然写入 `t_user_behavior`”写成已证实事实；当前直接证据支持的是：互动行为与推荐行为模型存在明确的对接入口，完整消费/落库闭环仍应在推荐专题和运行态验证中继续核对。

因此内容互动从来不是终点，它至少是推荐链的潜在输入源之一。

也就是说，当前互动系统不是“内容详情页上的几个按钮”，而是流量系统的行为入口。

## 这一链路新补出的两个边界

### 共同关注的“伪限流”问题

`FollowService.getCommonFollowing()` 原来的注释写着“最多取前 `MAX_COMMON_FOLLOW_FETCH` 个，防止大 V 关注列表过大导致 OOM”，但旧实现实际调用的是 `ZSet.intersect()`，它会先把**完整交集**拉回 JVM，再在 Java Stream 上 `.limit(5000)`。也就是说，保护是写在结果阶段，不在取数阶段；如果两个大 V 的共同关注本来就有几十万，这个方法会先把几十万成员全部搬回堆内存，再丢掉大部分结果。

这属于典型的“代码看起来有限制，真实执行路径却没有提前截断”的伪限流问题。当前修复已经改成：先在 Redis 侧 `intersectAndStore` 到临时 key，再 `range(0, 4999)` 只取前 5000 条，最后删除临时 key。限制现在真正落在 Redis 取数边界，而不是 JVM 结果流边界。

### 关注关系的两层真相仍然要分开看

即使共同关注查询已经补了边界，`follow` 这一条链仍然要继续区分两层：

- Redis 的关注/粉丝 ZSet 是当前权威关系
- MySQL `t_follow` 和 counter 只是持久化/展示视图

这意味着：共同关注、粉丝列表、互关判断这些读路径，首先要问 Redis 里的关系有没有成立；MySQL 和 counter 更多是在回答“长期持久化是否齐全”和“聚合数是否收敛”。如果只看 `t_follow` 或只看 counter，很容易把展示视图误当成关系真相。

## 真实故障案例：为什么互动最危险的错误，不是单次按钮失败，而是关系成立了、扩散没跟上

互动链里最危险的故障，不一定是接口直接报错，而是动作本体和扩散视图脱节。

### 现象

典型现象包括：

- 用户已经点赞成功，但点赞数没变
- 评论已经发出来了，但被回复者没收到通知
- 关注关系已经存在，但粉丝数或关注数没收敛
- 用户行为已经发生，但推荐链和 Feed 候选没有感知到

### 根因

根因并不总在某个按钮本身，而在“关系/内容本体”和“后续扩散链”之间的断层：

- MQ 没发出去
- 消费端没跟上
- 计数视图收敛慢了
- 通知链断了一段

### 修复

当前实现围绕这个问题做的核心设计，就是把动作本体和扩散视图分开：

- 本体先成立
- 下游再异步扩散
- 计数服务再统一收敛
- 通知服务再统一推送

### 验证

验证互动链，不能只看按钮返回 200，而要同时看：

- 关系或评论本体是否真实成立
- counter 侧是否更新
- notification 侧是否收到事件
- 下游依赖（Feed / 推荐）是否最终感知

### 余波

这个案例说明，**互动系统最难的不是把动作接住，而是让动作的影响继续沿着正确的方向扩散出去。**

## 这一篇先收束成一张总图

```text
点赞 / 收藏 / 关注 / 评论 / 分享
  → analytics 或 content 接住动作本体
    → Redis 关系 / 内容表先成立
      → MQ 扩散到 counter / notification / 其他下游
        → 计数、通知、推荐、Feed 再分别收敛
```

这里最重要的不是动作种类多，而是三条判断：

1. 当前互动链真正先保护的是“动作本体是否成立”，不是展示计数是否立刻变化。
2. 点赞、关注更像关系写入，评论更像内容写入，但它们后面都会进入扩散链。
3. 互动一旦发生，就不再只属于内容页本身，而会成为通知、计数、推荐和 Feed 的输入源。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 点赞入口与双层幂等：`my-xhs-analytics/src/main/java/com/myxhs/analytics/controller/LikeController.java:35`、`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:25`
- 点赞后通知扩散：`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:103`、`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:292`
- 收藏关系与 SOCIAL_TOPIC 事件：`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FavoriteService.java:21`、`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FavoriteService.java:201`
- 关注关系与 MQ 计数/通知：`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:27`、`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:141`
- 评论创建、审核、afterCommit 通知与计数：`my-xhs-content/src/main/java/com/myxhs/content/service/CommentService.java:67`、`my-xhs-content/src/main/java/com/myxhs/content/service/CommentService.java:156`
- Counter 消费 SOCIAL_TOPIC 并映射互动计数：`my-xhs-counter/src/main/java/com/myxhs/counter/consumer/CounterEventConsumer.java:17`、`my-xhs-counter/src/main/java/com/myxhs/counter/consumer/CounterEventConsumer.java:167`
- 计数服务 HTTP 只读/对账，写入由 MQ 驱动：`my-xhs-counter/src/main/java/com/myxhs/counter/controller/CounterController.java:14`
- 评论删除双权限（评论作者或笔记作者）：`my-xhs-content/src/main/java/com/myxhs/content/controller/CommentController.java:49`
- 分享→counter 异步 fire-and-forget：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:495`、`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:513`
- 内部端点 /internal/info（微服务间 token 保护）：`my-xhs-content/src/main/java/com/myxhs/content/controller/CommentController.java:122`

## 边界清单

- 本篇是互动链总览，不逐条展开收藏服务、分享服务和所有 Counter 消费实现细节，它们属于后续更细专题或运行时故障专题。
- 当前推荐链与 Feed 链会消费互动结果，但本文只点到为止，不把推荐打分或 Feed 排序机制再次展开。
- 点赞、关注当前以 Redis 关系为权威，评论以内容库为权威；这两类互动本体不同，不能混写成统一“表更新”。
- 本篇重点是互动如何扩散，不展开权限校验和敏感词算法原理，这些已在其他篇章建立。
- 评论删除的双权限模型和内部端点 token 保护是微服务内部通信模式的体现，已在本篇补充。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么互动行为不能被理解成“给当前内容加一个数字”，而必须先区分动作本体和扩散视图。
- 为什么点赞、关注、评论虽然本体不同，但后面都会继续进入计数、通知、推荐和 Feed 链。
- 为什么互动链真正难的不是动作本身，而是动作成立之后，影响如何被可靠扩散。

但它还没进入内容域里最后一个同样重要的问题：敏感词和审核边界当前到底做到什么程度，哪些是自动规则，哪些还没有真正进入人工审核链。

所以下一篇应该进入 `04-content-moderation.md`，去回答**当前内容审核为什么是 DFA 规则前置而不是完整审核平台，以及这条边界会怎样影响发布与互动链**。
