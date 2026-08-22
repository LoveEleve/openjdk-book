# analytics：点赞、收藏、关注的关系真相层

> 对应模块：`my-xhs-analytics`
> 目标问题：这个服务到底持有什么业务真相，它和 content、counter、notification 的边界又在哪里？

## 一句话答案

`my-xhs-analytics` 不是一个“杂项互动服务”，而是社交关系真相层：点赞、收藏、关注这些动作先在这里落成 Redis 权威关系，再通过 MQ 把影响扩散到 MySQL 持久化、counter 计数、notification 提醒和下游流量系统。

## 1. 业务：它真正负责的不是 count，而是关系是否成立

点赞、收藏、关注这三条链看上去都在改数字，但 `analytics` 真正回答的是更底层的问题：

- 某个用户现在是否点赞了某篇笔记或某条评论
- 某个用户现在是否收藏了某篇笔记
- 某个用户现在是否关注了另一个用户

这三类状态在当前实现里都不是先改 MySQL：

- 点赞权威态是 Redis Set，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:25`
- 收藏权威态是 Redis ZSet，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FavoriteService.java:24`
- 关注权威态是 Redis ZSet，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:29`

所以 `analytics` 的业务角色不是“帮内容服务维护几个互动字段”，而是“单独持有社交关系真相”。

## 2. 微服务：它和 content / counter / notification 的边界很清楚

### 2.1 与 content 的边界

`analytics` 不拥有笔记和评论本体，只在写关系前问 content：目标是否存在、是否可互动。

- 笔记点赞/收藏通过 `batchGetNoteDetail()` 校验，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:351`
- 评论点赞通过 `getCommentInfo()` 校验并拿作者信息，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:361`

这说明 content 负责“内容是否存在”，analytics 负责“人与内容之间是否建立了关系”。

### 2.2 与 counter 的边界

`analytics` 自己不维护展示计数权威态。它发 `SOCIAL_TOPIC` 事件，让 `counter` 收敛点赞数、收藏数、关注数、粉丝数。

- 点赞/取消点赞发 `LIKE` / `UNLIKE`，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:435`
- 收藏/取消收藏发 `FAVORITE` / `UNFAVORITE`，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FavoriteService.java:210`
- 关注/取关发 `FOLLOW` / `UNFOLLOW`，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:614`

### 2.3 与 notification 的边界

通知不是动作本体的一部分，而是动作成功后的扩散影响：

- 笔记点赞通知，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:298`
- 评论点赞通知，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:373`
- 关注通知，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:579`

## 3. 分布式：这套设计靠“关系先成立，影响再扩散”维持可用性

### 3.1 关系先在 Redis 成立

- 点赞使用单 key Lua + Set 幂等，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:80`
- 收藏使用 ZSCORE + ZADD Lua 原子化，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FavoriteService.java:68`
- 关注拆成当前用户侧与目标用户侧两段 Lua，兼容 Redis Cluster，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:91`

### 3.2 MySQL 和通知失败不阻断主动作

当前实现清楚地把“主动作可用性”放在前面：

- 关注时 MySQL 落库失败只记日志，由对账修复，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:127`
- 点赞/收藏发 MQ 失败不回滚主 Redis 关系，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:112`、`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FavoriteService.java:79`
- 通知发失败也不影响主动作返回

### 3.3 乱序与重复消费靠消费者收口

- 点赞/取消点赞统一 consumer group，并用 `actionTime` 做版本防乱序，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/consumer/LikeUnlikeConsumer.java:22`
- 收藏/取消收藏同样统一消费并做版本控制，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/consumer/FavoriteUnlikeConsumer.java:23`

## 4. 工程：这个模块最重的不是 Controller，而是修复链和边界保护

### 4.1 对账任务是正式能力，不是临时补丁

`FollowCounterRepairJob` 会按批扫描用户，修关注/粉丝计数、修 Redis ↔ MySQL 关系、再同步到 counter 模块 key，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/job/FollowCounterRepairJob.java:14`。

这说明 follow 链从设计上就承认：双写和异步扩散可能漂移，系统需要正式的收敛器。

### 4.2 内部调用是 token 保护的，不走用户鉴权语义

like/favorite/follow 的存在性校验依赖 content/user 的内部端点，而不是拿用户 token 去调公开 API。这个边界让微服务之间的职责更稳定，也避免把内部链路耦合到前台登录态。

## 5. Bug：这轮重新深挖补出的真实问题

### 5.1 共同关注查询原来是“伪限流”

`getCommonFollowing()` 注释说最多取 5000 条，但旧实现先做 `intersect()` 把完整交集拉回 JVM，再在 Java Stream 上 `.limit(5000)`。两个大 V 共同关注很大时，内存保护实际失效。

现在已修复为 Redis 侧 `intersectAndStore + range`，只取前 5000 条并删除临时 key，见 `my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:340`。

### 5.2 follow 读路径要一直记住“Redis 才是关系真相”

`FollowService` 里共同关注、粉丝列表、互关判断都先读 Redis。MySQL `t_follow` 是持久化兜底，不是读路径第一真相；如果排障时只看 MySQL，很容易误判“关系没建立”或“关系已经消失”。

## 6. 真实故障案例：为什么共同关注会成为 analytics 的隐蔽热点

### 现象

接口功能看上去正常，小用户也测不出异常，但一旦两个大 V 的关注集合都很大，共同关注接口会让 analytics 实例堆内存瞬时抬升，严重时甚至触发 Full GC。

### 根因

问题不在 Redis 交集能力本身，而在旧实现的取数位置：先把完整交集拉到 JVM，再在 Java 侧做 `.limit(5000)`。限制写在结果阶段，不写在取数阶段，于是共同关注越大，analytics 堆里落下的中间对象越多。

### 修复前

- Redis 负责算交集
- JVM 负责承接完整结果
- Java Stream 最后才截断

这意味着“看上去限制了 5000 条”，实际上只是“最终返回值限制了 5000 条”。

### 修复后

- Redis 先 `intersectAndStore`
- 再只 `range` 前 5000 条
- 临时 key 读完即删

现在限制真正前移到了数据出 Redis 的边界，堆内中间结果不再随着完整交集规模线性放大。

### 余波

这个故障说明：在关系型读路径里，只要注释写着“防 OOM”“只取前 N 条”，就必须继续追问——限制到底落在 Redis/DB 取数边界，还是只落在 Java 结果阶段。两者的工程含义完全不同。

## 证据清单

- 点赞关系：`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/LikeService.java:25`
- 收藏关系：`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FavoriteService.java:24`
- 关注关系：`my-xhs-analytics/src/main/java/com/myxhs/analytics/service/FollowService.java:29`
- 点赞消费者：`my-xhs-analytics/src/main/java/com/myxhs/analytics/consumer/LikeUnlikeConsumer.java:22`
- 收藏消费者：`my-xhs-analytics/src/main/java/com/myxhs/analytics/consumer/FavoriteUnlikeConsumer.java:23`
- 关注对账任务：`my-xhs-analytics/src/main/java/com/myxhs/analytics/job/FollowCounterRepairJob.java:14`
