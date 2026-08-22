# WebSocket 即时通讯

> 对应目录：`vol-xhs/07-im-notification-message/`
> 目标问题：为什么 IM 不能和通知链混在一起理解？`my-xhs` 当前的 WebSocket 即时通讯到底怎样处理在线连接、跨实例路由、消息持久化、未读数和离线补投？

## 一句话困惑

通知和 IM 在产品层面都长得像“消息”：

- 别人给你点了赞，会有一条通知
- 别人给你发了私信，也会有一条消息

于是最自然的误解就是：**它们无非是两种不同 UI 展示，底层逻辑应该差不多。**

但真正读代码之后会发现，两者的系统语义完全不同：

- 通知是“别人做了什么”的异步感知链
- IM 是“双方实时对话”的会话内消息链

也就是说，通知更像事件收敛和提醒系统，IM 更像会话状态和在线路由系统。

如果不先把这两条链拆开，后面很多设计都会看不懂：

- 为什么通知用 SSE，而 IM 用 WebSocket
- 为什么通知可以“即发即忘”，IM 却要维护会话内序号和离线补投
- 为什么通知的核心是聚合与未读数，IM 的核心却是在线路由和会话一致性

这篇要讲清楚的就是：**当前 `my-xhs` 的 IM 到底解决了什么问题，为什么它不是“通知的另一种发送方式”。**

## 一句话答案

在 `my-xhs` 里，IM 不是事件提醒，而是“有序会话消息”的系统：WebSocket 负责实时收发，Redis 路由表负责跨实例找人，消息先持久化到共享会话存储，再按接收者在线状态选择本机直推、跨实例 Pub/Sub 路由或离线补投。也就是说，通知系统回答的是“你该知道什么”，IM 系统回答的是“你们之间刚刚说了什么，而且顺序不能乱”。

## 先建立最小心智模型

先把当前 IM 链压成一张最小图：

```text
客户端 WebSocket
  → IM 服务接住消息协议
    → 先持久化消息和会话状态
      → 查接收者在线路由
        → 本机直推 / 跨实例定向推送 / 离线存储
```

这张图里最重要的判断是：**IM 当前并不是“先推送成功再说”，而是先把消息写成共享会话事实，再决定推给谁、怎么推。**

`ImController` 的类注释在 `my-xhs-im/src/main/java/com/myxhs/im/controller/ImController.java:24` 到 `:33` 里已经把这条边界写得很清楚：

- WebSocket 负责实时消息收发
- REST 只负责 ticket、会话列表、历史消息、已读和未读数

也就是说，当前 IM 从一开始就把“实时收发”和“查询/管理”拆成了两条通道。

## 先推演第一个最直觉的失败方案：把 IM 当成“通知 + 长连接”来做

这是最容易产生的误读。

### 为什么这个方案很诱人

因为通知系统已经有：

- 用户身份
- 未读数
- 在线推送
- 跨实例路由

如果只看这些能力，很容易觉得 IM 不过是在通知基础上把 payload 换成聊天内容而已。

### 它为什么在当前实现里站不住

它会先坏在“会话有序性”和“双边视角”上。

通知只需要回答：

- 发生了一件值得提醒你的事
- 你看到这条提醒了吗

IM 还必须回答：

- 这条消息在这个会话里排第几条
- 发送方和接收方看到的是不是同一条会话
- 对方不在线时，消息如何补投
- 已读回执如何回流

这些问题在通知链里根本不存在。当前 `ChatMessage` 实体就已经把这条边界钉死了：

- `conversationId` 把同一会话固定下来，见 `my-xhs-im/src/main/java/com/myxhs/im/entity/ChatMessage.java:27`
- `seqNo` 保证同会话消息严格有序，见 `my-xhs-im/src/main/java/com/myxhs/im/entity/ChatMessage.java:39`

这说明 IM 一开始就不是“提醒系统”，而是“有序会话系统”。

## 再推演第二个失败方案：只要用户在线，就直接推，不在线就算了

这也是一个非常常见、但很快会出问题的简化方案。

### 为什么这个方案也很诱人

因为它最接近聊天产品的表面直觉：

- 在线就推 WebSocket
- 不在线就下次再说

如果系统是单实例 demo，这样做一开始甚至很顺。

### 它为什么在当前实现里不成立

它会同时坏在两件事上：

1. **多实例路由**：用户未必连在当前这台 IM 实例上。
2. **离线补投**：用户当下不在线，不代表消息可以丢。

当前实现很明确不允许这两种“算了”：

- `OnlineRouteService` 明确维护了 `userId → serverId` 路由表，见 `my-xhs-im/src/main/java/com/myxhs/im/service/OnlineRouteService.java:17` 到 `:29`
- `ImRouteSubscriber` 在跨实例推送失败时，会降级存离线消息，见 `my-xhs-im/src/main/java/com/myxhs/im/subscriber/ImRouteSubscriber.java:31` 到 `:35` 和 `:123` 到 `:133`

所以当前 IM 的设计前提是：**你不在眼前，不等于消息可以丢。**

## 第一步：WebSocket 连接建立时，系统先承认“你在线了”

`ImController.createTicket()` 在 `my-xhs-im/src/main/java/com/myxhs/im/controller/ImController.java:51` 到 `:64` 里，先签发一个 5 分钟有效的短期 `ws_ticket`。

这说明当前实现和通知 SSE 一样，也没有把长期 JWT 直接塞进 URL，而是先换一个短期 Ticket。原因不是 IM 特殊，而是浏览器长连接建立时同样要避免把长期凭证直接暴露在 URL 上。

### 连接真正建立后发生了什么

`ImWebSocketHandler.afterConnectionEstablished()` 在 `my-xhs-im/src/main/java/com/myxhs/im/handler/ImWebSocketHandler.java:45` 到 `:74` 中，顺序非常清楚：

1. 检查连接数上限
2. 从 session attributes 取 `userId`
3. 踢掉旧连接（同一用户只保留一个 WebSocket）
4. 在 Redis 注册在线路由
5. 推送离线消息

这说明当前 IM 在用户一上线时，不只是“建了个连接”，而是立即更新了三类状态：

- 本机在线映射
- Redis 路由映射
- 离线消息清空与补投窗口

也就是说，“用户上线”在当前系统里本身就是一件状态机动作。

## 第二步：在线路由表回答的不是“在线没在线”，而是“在线在哪台实例”

`OnlineRouteService` 的注释在 `my-xhs-im/src/main/java/com/myxhs/im/service/OnlineRouteService.java:15` 到 `:29` 已经把当前路由表语义讲透了：

- `im:route:{userId} -> serverId`
- `im:online:{userId} -> 1`

这说明系统把“是否在线”和“在线在哪”拆成了两份状态，而不是只做一个布尔值。

### 为什么要分成两份

因为在多实例部署里，只知道用户在线还不够，还必须知道：

```text
这条消息应该打到哪台 IM 实例
```

`registerRoute()`、`unregisterRoute()`、`renewRoute()` 分别对应：

- 上线建立路由
- 下线删除路由
- 心跳续期路由 TTL

而且 `unregisterRoute()` 还专门用了 Lua 脚本按 `serverId` 原子删除，见 `my-xhs-im/src/main/java/com/myxhs/im/service/OnlineRouteService.java:26` 到 `:29` 和 `:48` 到 `:69`。这说明当前实现已经在认真对付“旧实例误删新实例路由”的竞态问题。

## 第三步：消息不是先推给对方，再决定要不要存；而是先写会话事实，再决定怎么投递

这是当前 IM 和通知链最本质的不同之一。

`MessagePersistService` 在 `my-xhs-im/src/main/java/com/myxhs/im/service/MessagePersistService.java:16` 到 `:29` 中，把当前持久化模式写得非常清楚：

- 不是 A/B 各写一份消息
- 而是共享存储：同一条消息只写一份，按 `conversation_id` 分片

而 `ChatService.handleChat()` 在真正路由投递之前，会先通过 `messagePersistService.saveMessageWithTransaction(...)` 落这份共享会话事实，见 `my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:122` 到 `:129`。这一步把“先持久化、后投递”的顺序钉死了。

### 持久化事务里到底写了什么

`saveMessageWithTransaction()` 在 `my-xhs-im/src/main/java/com/myxhs/im/service/MessagePersistService.java:39` 到 `:105` 中，同事务做了三件事：

1. 插入 `ChatMessage`
2. 更新发送者会话
3. 更新接收者会话（未读数 +1）

这说明当前 IM 消息不是“先推过去、存不存再说”，而是：

```text
先把这条会话事实写进系统
再决定实时投递能不能成功
```

这正是 IM 和通知最关键的差别：通知可以“即发即忘”，会话消息则必须先成为一条可靠事实。

## 第四步：跨实例消息路由并不走广播，而是定向 Pub/Sub

很多人第一次做多实例 IM，会直觉想到“所有实例都收到这条消息，再自己判断是不是目标用户”。当前实现明确不走这条路。

`ImRouteSubscriber` 在 `my-xhs-im/src/main/java/com/myxhs/im/subscriber/ImRouteSubscriber.java:23` 到 `:29` 中，把旧方案和新方案对比得很清楚：

- 旧：RocketMQ 广播，所有实例都收到，再 client-side 过滤
- 新：每实例订阅自己专属 `im:route:{serverId}` Channel，定向投递到目标实例

这说明当前设计明确把“跨实例消息路由”视为一条成本敏感链：不是能送到就行，还要避免 N-1 个实例做无效工作。

### 推送失败时怎么处理

`onMessage()` 在 `my-xhs-im/src/main/java/com/myxhs/im/subscriber/ImRouteSubscriber.java:94` 到 `:137` 中，如果跨实例推送失败，不会把消息直接吞掉，而是降级去存离线消息。

而且这条“离线补投”并不是只在跨实例失败时才出现。`ChatService.handleChat()` 在 `my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:138` 到 `:168` 中，已经把三种情况都收敛到了同一个 `storeOfflineMessage()`：

- 本机直推失败 → 存离线
- 跨实例 Pub/Sub 路由失败 → 存离线
- 接收者根本不在线 → 直接存离线

也就是说，不同失败源头在当前实现里最终会收敛到同一条离线补投机制，而不是各自发散成不同兜底路径。

这再次说明：**在线推送只是当前最好路径，不是消息存在性的前提。**

## 跨实例 IM 还有两个必须正面承认的边界：Pub/Sub 易失性与握手密钥来源

### Redis Pub/Sub 投递成功，不等于目标实例已经接收

`ChatService` 在跨实例分支里调用 `convertAndSend()` 后，只要 Redis 发布动作没有抛异常，就继续往下走；而 `ImRouteSubscriber` 只有在目标实例实际收到消息、但本机推送失败时，才会调用 `storeOfflineMessage()`。

这带来一个很具体的分布式边界：

```text
目标实例仍在线并订阅 Channel
  → 收到消息，推送失败
  → 可以降级存离线

目标实例在发布瞬间已崩溃或未订阅
  → Redis Pub/Sub 可能仍返回发布成功
  → 订阅回调不会执行
  → 发送端不会自动得到离线降级机会
```

这不是说消息一定永久丢失，因为 `ChatMessage` 已经先写入共享数据库，历史消息接口仍有机会查到；但它说明当前“离线补投”主要覆盖的是**回调已执行但实时推送失败**的场景，并没有把 Redis Pub/Sub 本身变成持久消息队列。要把这条链写成更强的可靠投递，还需要额外的 outbox、Stream 或消费确认机制。

### WebSocket ticket 的安全性还取决于实际密钥注入

`ImHandshakeInterceptor` 在 `my-xhs-im/src/main/java/com/myxhs/im/handler/ImHandshakeInterceptor.java:28` 中仍保留了 `jwt.secret` 的源码 fallback。运行环境正确注入统一密钥时，握手会按配置校验 `ws_ticket`；但如果配置缺失或漂移，服务可能退回源码默认值。

这说明 IM 的 ticket 两步法只解决了“长期 Access Token 不直接放进 WebSocket URL”的问题，并没有自动解决密钥治理问题。面试或架构复盘时必须把两件事拆开：

- ticket 短 TTL、类型校验和一次性入口，是协议层安全；
- 实际 `jwt.secret` 来源、禁止使用公开 fallback，是部署与密钥治理安全。

## 第五步：当前 IM 消息协议本身就已经区分了聊天、回执、已读和心跳

`ImMessage` 在 `my-xhs-im/src/main/java/com/myxhs/im/dto/ImMessage.java:17` 到 `:36` 中，把客户端协议显式区分成：

- `CHAT`
- `ACK`
- `READ`
- `TYPING`
- `PING`
- `LOGOUT`

这说明当前 IM 链不是“全都发文本消息”这么简单，而是已经把：

- 真正聊天内容
- 已读回执
- 输入中提示
- 心跳保活
- 主动下线

都视为会话协议的一部分。

也就是说，当前 WebSocket 链不只在传内容，也在维护连接状态和会话状态。

## 第六步：会话列表和历史消息说明 IM 不是推送通道，而是完整对话视图

`ImController` 除了签发 Ticket 外，还提供：

- 会话列表 `/conversations`，见 `my-xhs-im/src/main/java/com/myxhs/im/controller/ImController.java:66` 到 `:93`
- 历史消息 `/messages/{peerId}`，见 `my-xhs-im/src/main/java/com/myxhs/im/controller/ImController.java:95` 到 `:124`
- 已读标记 `/read/{peerId}`，见 `my-xhs-im/src/main/java/com/myxhs/im/controller/ImController.java:126` 到 `:136`
- 总未读数 `/unread-count`，见 `my-xhs-im/src/main/java/com/myxhs/im/controller/ImController.java:138` 到 `:145`

这说明 IM 当前并不是一条孤立的推送通道，而是一套完整会话视图：

- 实时消息
- 历史消息
- 会话列表
- 未读计数

这也是为什么消息必须先落库：否则后面的会话列表和历史消息根本无从成立。

## 真实故障案例：为什么 IM 最危险的错误，不是“当下没推到”，而是“消息已经成立，但在线路由和离线补投都没接住”

IM 链里最危险的问题，不是单次 WebSocket 发送失败，而是消息已经成为系统事实，但接收方既没有在线收到，也没有离线补回来。

### 现象

典型现象包括：

- 发送者看到消息发出成功
- 接收者当前没收到
- 过一会儿重连也看不到

这时用户感知是“消息像是被系统吞了”。

### 根因

根因通常不是单点失败，而是三段链路里至少有一段掉了：

1. 本机/跨实例实时推送没命中目标连接
2. 在线路由表已经过期或被误删
3. 离线补投没有把消息重新挂回去

### 修复

当前实现对这类风险的核心设计是：

- 先持久化消息和双方会话
- 再查在线路由
- 推送失败就降级存离线消息
- 用户上线时优先推离线消息

### 验证

验证 IM 链，不能只看某次 WebSocket 有无响应，而要同时看：

- `ChatMessage` 是否写入
- `ChatUserRelation` 是否更新
- `im:route:{userId}` 是否存在且归属正确实例
- 目标用户不在线时，离线消息是否被记录并在重连后补推

### 余波

这个案例说明，**IM 系统真正难的不是“在线时能不能推”，而是“无论用户此刻在线与否，这条会话消息最终都要落进双方共享的会话世界里”。**

## 这一篇先收束成一张总图

```text
客户端发 WebSocket 消息
  → IM 服务解析协议
    → 先持久化 ChatMessage + 双方会话状态
      → 查接收者在线路由
        → 本机直推 / 跨实例定向推送 / 离线消息降级
          → 接收者重连时补推离线消息
```

这里最重要的不是记住接口名，而是三条判断：

1. IM 不是通知的另一种发送方式，而是一条要维护会话顺序、双边视图和在线路由的独立链。
2. 当前实现里，消息先成为共享会话事实，再决定如何投递，而不是推送成功后才补存储。
3. 多实例 IM 的关键不是“能不能收到广播”，而是“能不能把消息精准送到正确实例，失败时再降级补回”。

## 证据清单

这篇的关键判断主要由以下证据托底：

- IM REST / WebSocket 分工：`my-xhs-im/src/main/java/com/myxhs/im/controller/ImController.java:24`
- WebSocket ticket 两步法：`my-xhs-im/src/main/java/com/myxhs/im/controller/ImController.java:51`
- WebSocket 会话管理：`my-xhs-im/src/main/java/com/myxhs/im/handler/ImWebSocketHandler.java:17`
- 在线路由注册/续期：`my-xhs-im/src/main/java/com/myxhs/im/handler/ImWebSocketHandler.java:67`、`my-xhs-im/src/main/java/com/myxhs/im/handler/ImWebSocketHandler.java:177`、`my-xhs-im/src/main/java/com/myxhs/im/service/OnlineRouteService.java:14`
- 上线补推离线消息：`my-xhs-im/src/main/java/com/myxhs/im/handler/ImWebSocketHandler.java:70`、`my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:317`
- 共享存储模式与消息持久化事务：`my-xhs-im/src/main/java/com/myxhs/im/service/MessagePersistService.java:16`
- ChatService 先持久化再投递：`my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:122`
- 跨实例定向 Pub/Sub：`my-xhs-im/src/main/java/com/myxhs/im/subscriber/ImRouteSubscriber.java:23`
- 离线消息统一降级收口：`my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:305`
- 客户端消息协议：`my-xhs-im/src/main/java/com/myxhs/im/dto/ImMessage.java:8`
- 会话消息实体与 seqNo：`my-xhs-im/src/main/java/com/myxhs/im/entity/ChatMessage.java:13`

## 边界清单

- 本篇讨论的是 IM 主链和在线路由，不展开一致性哈希负载均衡、离线消息存储上限和各类聊天室扩展模式，这些可在后续 IM 深挖专题补充。
- 当前实现是“共享存储”会话模式，而不是消息写扩散双写模式；这是一条当前实现事实，不等于唯一合理设计。
- WebSocket ticket 两步法在本文只作为会话入口边界讲解，不进一步展开 JWT 签名细节和 Gateway 白名单细节，这些在用户认证篇已建立。
- 本篇不展开通知链的未读聚合与 SSE，那是另一套“事件提醒”系统，虽然都叫消息，但边界不同。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么 IM 不能和通知链混成一个“消息系统”，而必须被理解成会话消息系统。
- 为什么当前 IM 链先持久化消息和会话，再决定本机推送、跨实例路由或离线补投。
- 为什么在线路由、多实例定向投递和离线补回，是当前 WebSocket IM 里比“发出去一条文本”更核心的基础设施能力。

到这里，`07-im-notification-message` 目录里，通知链和 IM 链的边界已经初步立住了。

下一步如果继续往这条用户感知链深挖，可以进入 `03-message-aggregation.md`，把通知聚合、未读计数和消息视图收敛机制单独讲透。

补：IM ticket 使用的 `jwt.secret` 现在要求安全配置，缺失或落回默认值时服务启动直接失败，避免短期 ticket 使用内置明文密钥签发。
