# SSE 通知推送

> 对应目录：`vol-xhs/07-im-notification-message/`
> 目标问题：通知为什么不是“查一张通知表”就够了？`my-xhs` 当前为什么要把通知做成“MQ 消费 → 聚合 → 未读计数 → SSE 推送”的链，而且还要用 Ticket 两步法建立连接？

## 一句话困惑

通知在产品层面看起来很轻：

- 别人点赞了你的笔记
- 有人评论了你
- 有新的关注或系统提醒

直觉上，这似乎只需要：

1. 往通知表里插一行
2. 前端定时拉列表

但在 `my-xhs` 当前实现里，通知链明显比这重得多：

- 通知不是由用户主动创建，而是从 `NOTIFICATION_TOPIC` 消费来的事件
- 同类通知在 5 分钟窗口内会聚合，而不是每条都孤立入表
- 未读数不是每次都扫表现算，而是单独维护
- 在线用户不是靠轮询感知，而是通过 SSE 实时推送
- SSE 连接本身还要绕开浏览器 EventSource 不能带自定义 Header 的限制

这说明通知在这里根本不是一张表，而是一条**事件消费 + 读模型收敛 + 在线推送**的组合链。

## 一句话答案

在 `my-xhs` 里，通知链并不是“插库后前端自己查”，而是：上游业务动作先经 `NOTIFICATION_TOPIC` 进入通知域，通知服务再把它渲染成通知实体、按窗口聚合、更新未读数，并在用户在线时通过 SSE 立即推送。也就是说，当前通知系统同时维护了三份不同语义的状态：通知内容、未读计数和在线连接。

## 先建立最小心智模型

先把当前通知链压成四层：

```text
上游业务动作
  → MQ 事件
    → 通知实体 / 聚合结果
      → 未读计数
        → SSE 在线推送 / 列表查询
```

这里最重要的判断是：**通知不是从表往前推出来的，而是从事件往后收敛出来的。**

`NotificationService` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:27` 到 `:32` 的类注释里，已经把当前职责拆得很清楚：

1. 处理通知事件
2. 通知列表查询
3. 标记已读
4. 获取未读计数

这说明通知域从一开始就不是一个单纯的“查表 API”，而是先消费事件、再形成列表和推送视图。

## 先推演第一个最直觉的失败方案：每次互动直接插一条通知，然后前端轮询查询

这是最容易想到的通知实现。

### 为什么这个方案很诱人

因为它简单：

- 点赞/评论/关注发生时，直接插通知表
- 前端每隔几秒查一次 `/list`
- 未读数就临时 `count(*) where is_read=0`

不用长连接，也不用额外维护在线状态。

### 它会先坏在哪里

它会先坏在两个地方：

1. **实时性和资源消耗互相冲突**：轮询频率高，数据库和接口压力就高；轮询频率低，实时感又差。
2. **同类通知刷屏**：一个人在短时间内连续点赞/评论，会迅速插入一堆结构相似的通知，用户体验很差。

当前实现明显不接受这两个代价：

- 不想让前端只靠轮询
- 也不想让通知列表变成流水账刷屏

所以它选择的是“事件先消费，通知再聚合，在线再推送”。

## 再推演第二个失败方案：SSE 直接带 JWT 建立连接

既然轮询不够好，一个也很自然的思路是：那就直接让浏览器 EventSource 带上 JWT，建立 SSE 长连接。

### 为什么这个方案很诱人

因为它最直观：

- 用户已经登录
- JWT 已经在浏览器里
- 建 SSE 连接时把 JWT 带上就行

看起来不需要额外步骤。

### 它为什么在当前实现里站不住

`SseTicketService` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/SseTicketService.java:13` 到 `:24` 已经把问题讲透：浏览器原生 EventSource API 不支持自定义 Header。

如果直接把 JWT 放在 URL 里，就会把凭证暴露给：

- 浏览器历史
- Gateway / 反向代理访问日志
- CDN / 代理链路日志

所以当前实现不走“URL 直接带 JWT”，而是专门设计了两步法：

1. 先用正常 HTTP POST（Header 带用户身份）换一个 30 秒有效、一次性的 Ticket
2. 再用这个 Ticket 建立 SSE 连接

这里要把原因说得更精确：当前选择 Ticket 两步法，不是因为 JWT 本身不适合 SSE，而是因为浏览器原生 EventSource 不能带 Header、把 JWT 放进 URL 又会泄漏凭证。也就是说，这里约束的是浏览器 API，而不是 JWT 本身。

这说明 SSE 在当前系统里不是“多加个推送通道”这么简单，而是已经开始影响认证边界设计。

## 第一步：通知并不是主动创建，而是被动消费业务事件

`NotificationEventConsumer` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/consumer/NotificationEventConsumer.java:18` 到 `:30` 已经把这一点讲得非常清楚：

- 它消费 `NOTIFICATION_TOPIC`
- 不靠数据库唯一键做幂等
- 而是用 Redis `msgId` 去重 + 聚合窗口锁双重保障

这说明通知域当前的第一原则不是“谁来写通知表”，而是：

```text
上游业务动作先变成通知事件
通知服务再决定它最终要不要形成一条通知
```

也就是说，通知本体本身已经是下游结果，不是上游服务直接控制的主数据。

## 第二步：通知真正成立前，还要先经过模板渲染和聚合

`NotificationService.processEvent()` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:47` 到 `:82` 中，把通知收敛链拆成四步：

1. 构建通知实体（模板渲染标题/内容）
2. 聚合处理
3. 更新未读计数
4. 如果用户在线，立即 SSE 推送

### 为什么要先模板渲染

通知列表最终给用户看的，不是一个裸事件，而是：

- 谁做了什么
- 作用在什么对象上
- 以怎样的标题和摘要显示

`buildNotification()` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:160` 到 `:198` 中，会把 `senderName`、`targetName`、`content` 等变量代入模板。这说明通知已经不是“事件本身”，而是对事件的人类可读翻译。

### 为什么还要聚合

如果每次点赞、评论都直接变成一条孤立通知，用户很快就会被同类通知刷屏。

所以 `NotificationService` 并没有把 `buildNotification()` 的结果直接插库，而是先交给 `NotificationAggregator.processWithAggregate(...)`，见 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:61` 到 `:69`。

也就是说，当前通知列表里的每一条，不一定等于一次事件，它可能已经是 5 分钟窗口内多次事件的合并结果。

## 第三步：未读计数是另一份独立视图，不等于通知列表现查

这是当前实现里最容易被低估的一层。

`NotificationService.processEvent()` 在聚合后，并不是每次都简单 `count(*)`。它会单独调用 `UnreadCountService`：

- 新建通知才 `incrementUnread`，见 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:64` 到 `:68`
- 聚合更新则不增加未读，因为用户已经“看到了红点”，见 `:69`

这说明未读数不是通知表的一个简单派生值，而是有自己业务语义的读模型。`UnreadCountService` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/UnreadCountService.java:15` 到 `:23` 已经把这层职责写得很清楚：

- 总未读数走 Redis String + INCR/DECR
- 分类未读数走 Redis Hash
- DECR 用 Lua 防负数
- 再由对账任务以 DB 为准修复 Redis

也就是说，它自己就是一套独立维护的视图：

```text
不是每次事件都一定加一
不是每次聚合都一定再加一
已读时还要按单条 / 类型 / 全部重置
```

这也是为什么 `markAsRead()`、`markAllReadByType()`、`markAllAsRead()` 不只是改通知表，还要同步调未读计数服务，见 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:118` 到 `:155`。

## 第四步：SSE 推送不是简单长连接，而是在线路由 + 跨实例转发链

很多系统在讲 SSE 时，只会说“在线用户就 push 一下”。当前实现明显比这重得多。

`SseEmitterManager` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:23` 到 `:43` 的注释里，已经把自己的职责列得很完整：

1. 管理本实例 `userId → SseEmitter` 映射
2. 心跳保活
3. 推送通知和未读计数
4. 多实例通过 Redis Pub/Sub 跨实例推送

### 为什么这里不只是本机在线列表

`pushNotification()` 和 `pushUnreadCount()` 都采用同一种思路：

1. 先查本机 `emitters`
2. 本机不在线，再查 Redis 中的 SSE 路由
3. 如果在别的实例在线，就通过 Redis Pub/Sub 发跨实例消息

对应代码见：

- `pushNotification()`：`my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:126` 到 `:152`
- `pushUnreadCount()`：`my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:155` 到 `:169`

而跨实例订阅本身也不是概念说明，`SseCrossInstanceSubscriber` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseCrossInstanceSubscriber.java:18` 到 `:30` 已经明确写了：所有实例都订阅同一个 Redis Channel，收到消息后只有目标用户在本实例在线时才真正推送。这说明当前系统并没有把“在线用户”理解成本机内存小问题，而是把它做成了一条跨实例路由链。

## 第五步：Ticket 两步法说明推送链本身也在被安全边界约束

`NotificationController` 的 SSE 入口非常能说明当前实现的安全意识：

- `/sse/ticket` 先换 Ticket，见 `my-xhs-notification/src/main/java/com/myxhs/notification/controller/NotificationController.java:37` 到 `:47`
- `/sse` 再用 Ticket 建连，见 `my-xhs-notification/src/main/java/com/myxhs/notification/controller/NotificationController.java:49` 到 `:63`

而 `SseTicketService` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/SseTicketService.java:21` 到 `:24` 里，把这条两步法写得非常明白：

- 先正常 HTTP POST，Header 携带身份
- 再用短期 Ticket 建连接

这说明在当前实现里，通知链不是“功能优先到处开洞”，而是连推送通道本身都放在认证边界约束下。

## 第六步：心跳和在线数说明通知链还在维护一份“连接状态视图”

`SseEmitterManager.heartbeat()` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:248` 到 `:291` 中，每 10 秒做两件事：

1. 批量续期 Redis 里的 SSE 路由键
2. 给客户端发心跳，顺便检测连接是否存活

这说明当前通知系统除了：

- 通知内容视图
- 未读计数视图

还额外维护了一份：

```text
谁现在在线、能不能立刻推
```

的连接状态视图。

也就是说，当前通知系统不是一张表，也不是一条推送通道，而是三条视图并行：

- 通知列表
- 未读计数
- 在线连接

## 真实故障案例：为什么通知最危险的错误，不是“少推一条消息”，而是“通知列表、未读红点和在线推送三套视图开始分裂”

通知链最容易被低估的风险，并不是单次 SSE 推送失败，而是三份不同语义的状态开始各说各话。

### 现象

典型现象包括：

- 通知列表里已经有一条通知，但红点没加
- 红点有了，SSE 却没推到在线用户
- SSE 推到了，但用户刷新列表看不到对应通知

### 根因

根因通常不是某个 Controller 写错，而是通知链同时维护：

- 聚合后的通知实体
- 未读计数
- 在线路由和推送

只要其中一段掉队，用户感知就会变成“哪里都差一点点，但整体不一致”。

### 修复

当前实现通过四层方式尽量把三份视图拉齐：

1. 先消费事件并做幂等
2. 聚合后再决定是否增加未读数
3. 只有用户在线才推 SSE
4. 已读动作反过来同步更新未读计数

### 验证

验证通知链，不能只看 `/list` 有没有数据，而要同时看：

- 通知表里是否有记录
- `UnreadCountService` 的值是否同步变化
- 用户在线时 SSE 是否收到通知和红点事件
- 跨实例在线时 Pub/Sub 路径是否生效

### 余波

这个案例说明，**通知系统真正难的地方，不在“发一条消息”，而在“把内容、红点和在线感知三条视图一起收住”。** 当前实现甚至专门有 `UnreadReconcileJob` 来兜这个问题：它每 5 分钟对比 Redis 未读计数和 MySQL COUNT，以 DB 为准修 Redis，见 `my-xhs-notification/src/main/java/com/myxhs/notification/job/UnreadReconcileJob.java:17` 到 `:31` 和 `:90` 到 `:101`。

## 这一篇先收束成一张总图

```text
上游业务动作
  → NOTIFICATION_TOPIC
    → NotificationEventConsumer 幂等消费
      → NotificationService 模板渲染 + 聚合
        → 更新未读计数
          → 用户在线时 SSE 推送
            → 多实例下通过 Redis Pub/Sub 转发
```

这里最重要的不是记住接口名，而是三条判断：

1. 通知不是从表往前推出来的，而是从业务事件往后收敛出来的。
2. 当前系统真正维护的是三份并行视图：通知内容、未读计数和在线连接状态。
3. SSE 在这里不是一个附属推送通道，而是通知链对“用户当前是否在线”这件事的即时响应层。

## 证据清单

这篇的关键判断主要由以下证据托底：

- SSE Ticket 两步法入口：`my-xhs-notification/src/main/java/com/myxhs/notification/controller/NotificationController.java:37`
- 通知服务处理链：`my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:47`
- 未读计数独立视图：`my-xhs-notification/src/main/java/com/myxhs/notification/service/UnreadCountService.java:15`
- 未读对账修复：`my-xhs-notification/src/main/java/com/myxhs/notification/job/UnreadReconcileJob.java:17`
- 事件消费与双重幂等：`my-xhs-notification/src/main/java/com/myxhs/notification/consumer/NotificationEventConsumer.java:17`
- SSE 连接管理与跨实例架构：`my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:23`
- 跨实例订阅器：`my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseCrossInstanceSubscriber.java:18`
- Ticket 服务安全边界：`my-xhs-notification/src/main/java/com/myxhs/notification/service/SseTicketService.java:12`
- 多实例在线推送与心跳续期：`my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:126`、`my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:248`

## 边界清单

- 本篇聚焦 SSE 通知主链，不展开 IM WebSocket 链，这会在 IM 专题单独说明。
- 当前实现里通知聚合窗口、未读计数语义和 SSE 心跳策略都已经存在，但不等于已经构成完整消息中台；这里讨论的是当前功能闭环。
- SSE Ticket 两步法解决的是 EventSource 不能带 Header 的约束，不等于系统没有其他推送方式；当前只是选了 SSE 作为通知在线通道。
- 本篇不展开 `NotificationAggregator`、`UnreadCountService`、`SseCrossInstanceSubscriber` 的全部内部实现细节，后续若继续深挖通知域可单列专题。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么通知不是“插表 + 前端轮询”，而是一条事件消费、聚合、未读计数和 SSE 推送联合工作的链。
- 为什么当前通知系统必须同时维护通知内容、未读数和在线连接三份不同语义的状态。
- 为什么 SSE 推送不是一个小工具，而是通知系统里和认证、在线状态、多实例路由一起工作的最后一跳。

如果继续沿“用户感知链”往前推，下一个自然的方向就是 `07-im-notification-message/01-websocket-im.md`，因为通知解决的是异步提醒，而 IM 解决的是用户之间的实时会话；两者看起来都像“消息”，但系统边界完全不同。