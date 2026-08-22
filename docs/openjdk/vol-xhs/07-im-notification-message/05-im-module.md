# im：有序会话与跨实例在线路由层

> 对应模块：`my-xhs-im`
> 目标问题：为什么 IM 不能被当成“通知换个 payload”，它真正负责的业务与分布式语义是什么？

## 一句话答案

`my-xhs-im` 不是提醒系统，而是有序会话系统：它先把消息写成共享会话事实，再根据接收方在线路由做本机直推、跨实例定向投递或离线补投。它真正持有的是“双方刚刚说了什么、顺序是什么、对方现在挂在哪台实例”这三类状态。

## 1. 业务：它负责的不是事件提醒，而是双边会话事实

IM 回答的是：

- 这条消息属于哪个 `conversationId`
- 它在这个会话里排第几条 `seqNo`
- 发送者和接收者各自的会话未读状态怎样变化
- 对方在线时如何实时送达，不在线时如何稍后补投

这类语义天然不同于 notification 的“你该知道什么”。

## 2. 微服务：它和 notification 的边界是“会话”对“提醒”

- IM 关注共享消息存储、会话列表、历史消息、已读回执和在线路由
- notification 关注事件渲染、聚合、未读红点和即时提醒
- 两者都会推消息，但推送只是末端动作，不是同一类业务对象

## 3. 分布式：它靠路由表、共享存储和离线补投维持正确性

### 3.1 在线事实不只是在不在线，还包括“在线在哪台实例”

`OnlineRouteService` 同时维护：

- `myxhs:im:route:{userId} -> serverId`
- `myxhs:im:online:{userId} -> 1`

见 `my-xhs-im/src/main/java/com/myxhs/im/service/OnlineRouteService.java:14`。

### 3.2 消息先持久化，再决定怎么推

`ChatService.handleChat()` 会先调用 `saveMessageWithTransaction(...)`，再根据在线路由决定本机直推、跨实例路由还是离线消息，见 `my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:122`。

### 3.3 跨实例投递已经是定向 Channel，而不是公共广播

`ImRouteSubscriber` 的设计已经从“所有实例都收到再过滤”演进到“每实例专属 Channel”，见 `my-xhs-im/src/main/java/com/myxhs/im/subscriber/ImRouteSubscriber.java:23`。

## 4. 工程：这个模块最重的是运行态状态机，而不是 WebSocket 接口数量

### 4.1 上线本身就是一条状态机动作

`ImWebSocketHandler.afterConnectionEstablished()` 会：

- 踢旧连接
- 注册在线路由
- 推送离线消息

见 `my-xhs-im/src/main/java/com/myxhs/im/handler/ImWebSocketHandler.java:45`。

### 4.2 REST 和 WebSocket 被清楚拆开

WebSocket 负责实时收发；REST 负责 ticket、会话列表、历史消息、已读和未读数。也就是说，IM 当前不是“所有事都挤在长连接协议里”。

## 5. Bug：这轮重扫继续确认并修复的真实问题

### 5.1 心跳续期原来没有先检查本地 session 是否还活着

旧逻辑里，心跳续期可能在本地连接已经关闭或被替换后，仍然继续刷新 Redis 路由 TTL，造成“路由看起来还在线、真实连接却已经没了”的假在线窗口。现在已经修成：续期前先检查本地 `session` 仍存在且 `isOpen()`，见 `my-xhs-im/src/main/java/com/myxhs/im/handler/ImWebSocketHandler.java:1`。

### 5.2 IM 的正确性更多取决于运行态状态，而不是单条消息 API 成功

接口返回成功，只能说明发送方请求被接住；真正的链路正确性还要继续看：共享存储是否写入、接收方路由是否有效、跨实例推送是否命中目标实例、离线补投是否最终可见。

## 6. 真实故障案例：为什么心跳续期 bug 会制造“假在线”

### 现象

用户实际上已经断开，或者新连接已经替换了旧连接，但 Redis 里的 `im:route:{userId}` 还在被续期。结果是发送端查路由时认为对方在线，继续走跨实例实时投递；真正投递时才发现目标实例并没有有效 session，消息又要额外绕一次失败降级。

### 根因

问题不在 Redis TTL，而在续期前提。旧逻辑只要收到心跳或定时续期路径被触发，就可能继续刷新路由，没有先确认“当前本地这条 session 还活着、而且还是用户的现行连接”。

### 修复前

- 路由 TTL 可以被过期 session 继续刷新
- Redis 在线事实滞后于真实连接事实
- 发送端更容易误走在线投递分支

### 修复后

- 续期前先检查本地 `session` 是否仍存在且 `isOpen()`
- 假在线窗口被收窄
- 路由事实重新更贴近真实连接状态
- WebSocket 心跳和 Redis 在线路由的一致性重新回到同一条状态机上

### 余波

这个故障非常像真实 IM 系统里的典型问题：最难的不是消息格式，而是“运行态状态机的每一步是不是还代表真实世界”。只要在线路由和真实连接略微脱节，后面的跨实例投递、离线补投和未读语义都会被连带污染。

## 证据清单

- WebSocket IM 主文：`docs/openjdk/vol-xhs/07-im-notification-message/01-websocket-im.md:1`
- 跨实例主文：`docs/openjdk/vol-xhs/07-im-notification-message/04-cross-instance.md:1`
- 心跳续期修复点：`my-xhs-im/src/main/java/com/myxhs/im/handler/ImWebSocketHandler.java:1`
- 在线路由：`my-xhs-im/src/main/java/com/myxhs/im/service/OnlineRouteService.java:14`
- 消息持久化：`my-xhs-im/src/main/java/com/myxhs/im/service/MessagePersistService.java:16`
