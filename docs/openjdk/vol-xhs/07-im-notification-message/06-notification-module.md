# notification：事件提醒、聚合与未读视图层

> 对应模块：`my-xhs-notification`
> 目标问题：通知服务真正维护的是哪几份状态，它和 IM 的差别又落在哪里？

## 一句话答案

`my-xhs-notification` 不是“别人做了什么就插一条表”的简单通知服务，而是事件提醒收敛层：它消费 `NOTIFICATION_TOPIC`，把上游动作渲染成通知实体，按窗口聚合更新，单独维护未读数，并在用户在线时通过 SSE 尽力即时推送。它真正维护的是“通知内容视图 + 未读计数视图 + 在线连接视图”三套状态。

## 1. 业务：它负责的是提醒语义，不是双边会话语义

notification 回答的是：

- 哪些业务动作值得提醒用户
- 提醒应该怎样被渲染成标题、摘要和目标对象
- 同类提醒要不要折叠成一条
- 红点和列表应该怎样分别维护

它不像 IM 那样维护一条双边会话顺序链，而是更像单边感知链。

## 2. 微服务：它位于业务事件下游，而不是业务动作上游

点赞、评论、关注、系统提醒等事件先进入 `NOTIFICATION_TOPIC`；notification 再决定：

- 这次要不要生成新通知
- 是更新旧通知还是新增通知
- 未读数要不要增加
- 在线用户要不要立即 SSE 推送

这说明通知本体是下游结果，不是上游服务直接持有的主数据。

## 3. 分布式：它靠事件消费、聚合锁和未读对账维持一致性

### 3.1 通知和未读数是两套并行视图

- 通知内容视图落在 `t_notification`
- 未读数视图高频驻留 Redis，再由对账任务用数据库拉回

这条边界由 `NotificationService` 和 `UnreadCountService` 共同维持，见 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:47`、`my-xhs-notification/src/main/java/com/myxhs/notification/service/UnreadCountService.java:15`。

### 3.2 聚合不是查库决定，而是 Redis 先裁定窗口归属

`NotificationAggregator` 先通过 Redis 窗口锁判断这次事件是窗口内第一条还是已有聚合主通知，再决定 insert 还是 update，见 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationAggregator.java:104`。

### 3.3 SSE 跨实例推送只是即时体验通道

通知内容和未读数已经分别落库/落 Redis；SSE 跨实例 Pub/Sub 只是“在线时马上推一下”。它不承担消息队列式的历史重放，这一点和 IM 的离线补投语义完全不同。

## 4. 工程：这个模块最重的是视图收敛，而不是发连接

### 4.1 浏览器限制反向塑造了认证边界

因为原生 EventSource 不能带自定义 Header，通知链必须走 ticket 两步法，而不是把 JWT 直接放进 SSE URL。这个约束来自浏览器 API，而不是来自通知业务本身。

### 4.2 真正的复杂度在聚合和红点，不在 SSE 语法

如果只看 SSE，很容易误以为通知的难点是长连接；但源码更重的部分其实是：

- 窗口聚合
- 幂等消费
- 未读数单独维护
- 已读后的视图对齐
- Redis 与数据库之间的对账修复

## 5. Bug：这轮重扫继续确认的真实边界

### 5.1 通知链的“在线推送成功”不能被误当成通知已可靠送达

SSE 即时推送是尽力而为；真正可靠的是通知实体和未读数视图。如果排障时只盯着 SSE Channel 或前端是否立刻弹出提醒，很容易误判“通知没进系统”。对 notification 而言，更重要的是：表里有没有通知、Redis 未读数是不是最终对齐。

### 5.2 聚合更新和新增通知不能混成同一种未读语义

当前实现已经明确：只有生成新通知时才增加未读数；如果只是把已有主通知聚合更新，不再重复加红点。否则用户会被同一类提醒连续抬高未读数。

## 6. 真实故障案例：为什么通知最容易出现“我明明收到了推送，但红点不对”

### 现象

用户在线时前端可能已经通过 SSE 收到一条通知，但列表条数、聚合后的主通知内容、以及总未读/分类未读不一定天然同步。表面看像是“推送到了但系统没对齐”。

### 根因

问题不在某一条连接，而在 notification 天生维护三套状态：

- 通知内容视图
- 未读计数视图
- 在线连接视图

只盯住其中一套状态，很容易把“局部成功”误判成“整体正确”。

### 修复前的直觉误区

- 看到 SSE 已推送，就以为通知链没问题
- 看到表里有通知，就以为红点一定正确
- 看到红点数字正确，就以为聚合主通知一定没漂移

### 当前实现的收敛方式

- 通知内容靠聚合器与数据库主通知字段收敛
- 未读数靠 Redis 视图和 `UnreadReconcileJob` 收敛
- 在线推送只负责即时感知，不承担持久真相

### 余波

这个故障模型说明，notification 最难的地方不是“推送出去”，而是“提醒语义、列表语义和红点语义最后能不能重新对齐”。它本质上是一套多视图收敛系统，而不是单通道发送系统。

## 证据清单

- SSE 主文：`docs/openjdk/vol-xhs/07-im-notification-message/02-sse-notification.md:1`
- 聚合与未读主文：`docs/openjdk/vol-xhs/07-im-notification-message/03-message-aggregation.md:1`
- NotificationService：`my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:27`
- NotificationAggregator：`my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationAggregator.java:24`
- UnreadCountService：`my-xhs-notification/src/main/java/com/myxhs/notification/service/UnreadCountService.java:15`
