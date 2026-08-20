# 跨实例消息路由

> 对应目录：`vol-xhs/07-im-notification-message/`
> 目标问题：一旦 IM 和通知不再只跑单实例，消息为什么不能继续靠“本机在线就推一下”解决？`my-xhs` 当前到底怎样用 Redis 路由表、定向 Pub/Sub 和离线降级，把跨实例推送收成一条可解释的链？

## 一句话困惑

前面三篇已经把 `07-im-notification-message/` 里的三条主线分别立住了：

- IM 是有序会话消息系统
- SSE 通知是事件提醒链
- 通知聚合与未读数又是另一套收敛视图

但这三篇都还默认了一个相对温和的前提：**接收方要么就在本机，要么至少可以把“在线推送”理解成一个本实例动作。**

一旦服务进入多实例部署，这个前提立刻失效：

- 用户 A 连接在 `im-1`，用户 B 连接在 `im-2`
- 某条通知事件在 `notification-1` 消费完成，但用户在线连接其实挂在 `notification-2`
- 本机内存里明明没有目标连接，消息却不能因此丢掉
- 反过来，如果所有实例都广播收到消息再自己过滤，又会把无效工作放大成 N 倍

这说明跨实例问题真正难的地方，从来不是“多了几台机器”，而是：**一条已经成为系统事实的消息，怎样被路由到正确实例、在失败时怎样降级、以及为什么当前系统既不能简单广播，也不能只看本机在线列表。**

## 一句话答案

当前 `my-xhs` 的跨实例路由不是让所有实例都收到同一条消息，而是先把“目标用户现在挂在哪个实例”写成 Redis 路由事实，再通过定向 Pub/Sub 把消息只送到对应实例；如果目标实例推送失败，IM 链会降级为离线消息，SSE 链则保留通知列表与未读数这两条非在线视图。也就是说，跨实例问题在这里不是“推送方式升级”，而是**在线路由、精准投递和失败降级**三件事被重新建模。

## 先建立最小心智模型

先把当前跨实例链压成一张最小图：

```text
发送端实例
  → 先看目标用户是否在本机在线
    → 是：本机直推
    → 否：查 Redis 路由表
         → 找到 targetServerId：定向 Pub/Sub 给目标实例
         → 没找到：按链路语义降级
              IM：存离线消息
              SSE：不推送，但通知列表/未读数仍成立
```

这张图里最重要的判断是：**跨实例链真正先解决的不是“怎么推”，而是“现在应该推给哪台实例”。**

只要这一步没被明确建模，后面的“广播”“本机直推”“离线补投”全都会变成各说各话的局部补丁。

## 先推演第一个最直觉的失败方案：所有实例都收到消息，再各自判断是不是目标用户

这是最容易想到的多实例消息方案。

### 为什么这个方案很诱人

因为它几乎不需要额外路由表：

- 发送端只要把消息发进一个公共 Topic 或公共 Channel
- 所有实例都收到
- 每个实例看一下目标用户在不在自己这里
- 不在就丢掉

从实现角度看，这种做法很直接，甚至一开始在少量实例上也能跑通。

### 它会先坏在哪里

它会先坏在“绝大多数实例都在做无效工作”上。

当前 IM 代码里甚至保留了这段历史对照。`ImRouteSubscriber` 的类注释在 `my-xhs-im/src/main/java/com/myxhs/im/subscriber/ImRouteSubscriber.java:23` 到 `:29` 已经把旧方案和新方案并排写出来了：

- 旧方案：RocketMQ BROADCASTING，所有实例都收到，再 client-side 过滤
- 新方案：每实例订阅专属 Channel，只向目标实例精准投递

这说明当前实现不是理论上“也许广播更浪费”，而是已经明确把广播模式视为需要被替换掉的旧设计。

如果继续使用广播：

- IM 消息每来一条，N 个实例都要反序列化一次
- 大多数实例做完判断后什么也不干
- 实例数越多，无效 CPU 开销越高
- 已读回执、输入中提示这类高频小消息更会被放大

也就是说，这个方案的问题不是“能不能送达”，而是**把跨实例路由成本错误地摊给了所有实例。**

## 再推演第二个失败方案：本机没连接就当用户离线，直接结束

既然广播太浪费，另一个也很自然的极端就是：发送端只看本机内存在线列表，没有就视为离线。

### 为什么这个方案也很诱人

因为它足够简单：

- 查本机 `sessions` 或 `emitters`
- 有连接就推
- 没连接就走离线或直接结束

不需要 Redis 路由，也不需要跨实例 Pub/Sub。

### 它为什么在当前实现里同样站不住

它会把“用户不在本机”和“用户不在线”混成一件事。

但在多实例系统里，这两者完全不同：

- 用户不在本机，只说明目标连接挂在别的实例
- 用户不在线，才说明当前确实没有任何实时推送路径

当前 IM 和 SSE 都明确不接受这种混淆。

- IM 侧 `ChatService.handleChat()` 在 `my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:138` 到 `:168` 中，会先查 `onlineRouteService.getRoute(receiverId)`；只有 `targetServerId == null` 时，才视为用户不在线并存离线消息。
- SSE 侧 `SseEmitterManager.pushNotification()` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:136` 到 `:151` 中，也会先查本机 `emitters`，再查 Redis 中的 `notify:sse:{userId}` 路由；只有两边都没有，才返回 `false`。

这说明当前系统对“跨实例在线”的定义非常明确：**本机没有连接，不是最终结论；Redis 路由表才是在线事实的全局视图。**

## 第一步：跨实例链的第一份真相，是 Redis 路由表而不是本机内存映射

### IM 的在线路由表

`OnlineRouteService` 的类注释在 `my-xhs-im/src/main/java/com/myxhs/im/service/OnlineRouteService.java:14` 到 `:29` 中，把 IM 的两份路由状态写得非常清楚：

- `myxhs:im:route:{userId} -> serverId`
- `myxhs:im:online:{userId} -> 1`

这说明当前 IM 不是只维护一个“用户是否在线”的布尔值，而是同时维护：

1. 用户在不在线
2. 用户在线在哪个实例

而且这两份状态都有 90 秒 TTL，靠心跳续期，见 `my-xhs-im/src/main/java/com/myxhs/im/service/OnlineRouteService.java:22` 到 `:24` 和 `:75` 到 `:98`。

### SSE 的在线路由表

SSE 当前没有单独拆成 `SseRouteService`，路由直接内嵌在 `SseEmitterManager` 里：

- `myxhs:notification:sse:{userId} -> serverId`
- TTL 30 秒

见 `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:56` 到 `:60` 与 `:108` 到 `:110`。

这说明通知链和 IM 链虽然都要解决“目标用户在哪个实例”，但当前实现并没有强行抽象成同一个公共路由服务，而是：

- IM 需要更丰富的在线/路由双状态与心跳续期语义
- SSE 直接把路由附着在连接管理器里

这种差异本身就很能说明：**跨实例问题在两个系统里是同类问题，但不是同一套对象模型。**

## 第二步：用户上线时，跨实例事实先被写入 Redis，连接只是本机表现

### IM 上线链

`ImWebSocketHandler.afterConnectionEstablished()` 在 `my-xhs-im/src/main/java/com/myxhs/im/handler/ImWebSocketHandler.java:45` 到 `:74` 中，按顺序做了：

1. 从握手 attributes 取 `userId`
2. 踢掉旧连接
3. `onlineRouteService.registerRoute(userId)`
4. 推送离线消息

这说明在 IM 里，“上线”不只是本机 `sessions.put(userId, session)`，而是：

```text
本机连接成立
→ 全局路由事实写入 Redis
→ 旧连接失效
→ 离线消息补投窗口开启
```

### SSE 上线链

`NotificationController.sseConnect()` 先走 ticket 两步法，见 `my-xhs-notification/src/main/java/com/myxhs/notification/controller/NotificationController.java:43` 到 `:63`；真正建立连接时，`SseEmitterManager.createConnection()` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:72` 到 `:123` 中：

1. 原子替换旧 emitter
2. 注册回调清理资源
3. 把 `myxhs:notification:sse:{userId}` 写进 Redis
4. 发送 `connected` 事件

也就是说，SSE 链同样把“连接成立”升级成了一条跨实例可见的路由事实，而不是停在本机内存里。

## 第三步：跨实例推送真正解决的是“精准投递”，不是“让所有实例都知道”

### IM：每实例专属 Channel

`ImRouteSubscriber.start()` 在 `my-xhs-im/src/main/java/com/myxhs/im/subscriber/ImRouteSubscriber.java:62` 到 `:74` 中，订阅的是：

```text
myxhs:im:route:{serverId}
```

这意味着发送端不是往一个公共广播 Channel 发消息，而是已经知道：

- 目标用户现在挂在哪个 `targetServerId`
- 于是直接 `convertAndSend("myxhs:im:route:" + targetServerId, ...)`

见 `my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:147` 到 `:160`。

这条链真正值得记住的，不是 Redis Pub/Sub 这个技术选型，而是：**系统先用路由表把目标实例求出来，再做一次点对点投递。**

### SSE：公共 Channel + 目标实例本地过滤

SSE 当前用的是另一种折中方式。`SseEmitterManager.publishCrossInstance()` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:225` 到 `:245` 中，会把消息发到公共 Channel：

```text
myxhs:notification:sse:channel
```

随后 `SseCrossInstanceSubscriber.onMessage()` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseCrossInstanceSubscriber.java:70` 到 `:88` 中，收到消息后交给本机 `SseEmitterManager.handleCrossInstanceMessageJson(...)`，只有目标用户在本实例在线时才真正推送。

这说明当前 SSE 链在跨实例投递上比 IM 更保守：

- IM 已经做到了“按目标实例建专属 Channel”
- SSE 仍是“公共 Channel 广播 + 目标实例本地在线判断”

因此，如果要更严格地说：**当前 IM 的跨实例投递已经是精准定向，SSE 则更接近共享 Channel 下的轻量分发。**

这也是 `04-cross-instance.md` 值得单独写的原因：很多人会把“都用了 Redis Pub/Sub”误读成“架构完全一样”，其实不是。

## 第四步：失败降级路径决定了“消息是丢了，还是只是没在线送到”

跨实例路由最危险的，不是当下没推到，而是推不到以后系统如何定义这次失败。

### IM 的降级：离线消息是正式兜底层

IM 里无论是：

- 本机直推失败
- Pub/Sub 路由失败
- 接收者根本不在线

最终都会收敛到 `storeOfflineMessage()`，见 `my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:142` 到 `:168` 以及 `my-xhs-im/src/main/java/com/myxhs/im/subscriber/ImRouteSubscriber.java:127` 到 `:133`。

而 `storeOfflineMessage()` 自己又不是随便塞一个 List，而是：

- 用 Sorted Set 按时间排序
- Lua 原子裁剪到最多 1000 条
- TTL 7 天

见 `my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:293` 到 `:314`。

这说明在 IM 里，跨实例失败的系统语义是：

```text
实时通道失败
≠ 消息失败
而是降级成离线待补投
```

### SSE 的降级：不在线就不推，但通知内容和红点仍然成立

SSE 的降级语义完全不同。

`SseEmitterManager.pushNotification()` 和 `pushUnreadCount()` 在找不到本机 emitter、也找不到 Redis 路由时，只是返回 `false` 或直接结束，见：

- `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:136` 到 `:152`
- `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:157` 到 `:169`

它不会再像 IM 那样另存一份“通知离线消息队列”。原因不是功能缺失，而是语义不同：

- 通知内容已经在数据库列表里
- 未读数已经在 Redis 视图里
- 用户下次主动打开通知页时仍能看见

也就是说，对通知链而言，“在线立刻推到”只是强化体验，不是消息存在性的前提。

这正是 IM 和通知跨实例路径最根本的差别：

- IM 不在线时，必须保一条离线补投链
- 通知不在线时，列表和红点本身就是离线可见视图

## 第五步：跨实例链还要同时维护顺序、心跳和旧连接清理，不能只看路由命中

跨实例路由不仅是“找到目标实例”这么简单，它还必须保证路由事实本身不脏。

### IM：顺序与误删保护

IM 当前专门做了两层很关键的保护：

1. `seqNo` 作为会话级递增序号，跨实例消息也会跟着透传，见 `my-xhs-im/src/main/java/com/myxhs/im/dto/RouteMessage.java:31` 到 `:32` 与 `my-xhs-im/src/main/java/com/myxhs/im/subscriber/ImRouteSubscriber.java:112` 到 `:120`
2. `unregisterRoute()` 用 Lua 做“检查 serverId 再删除”，避免旧实例误删新实例路由，见 `my-xhs-im/src/main/java/com/myxhs/im/service/OnlineRouteService.java:48` 到 `:69`

这说明 IM 的跨实例问题不只是消息发不发得到，还包括：

- 路由是不是旧的
- 会话序号会不会乱
- 旧连接断开时会不会把新连接的路由一起删掉

### SSE：心跳和双参数 remove

SSE 侧则在连接生命周期上做了另一类保护：

- `emitters.remove(userId, emitter)` 双参数 remove，防止旧连接回调误删新连接，见 `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:85` 到 `:106`
- 每 10 秒心跳续期 Redis 路由键，并顺手检测连接活性，见 `my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:248` 到 `:291`

这说明通知跨实例问题真正要维护的是：

- 当前这条路由是不是还活着
- Redis TTL 是否被及时续期
- 断开的旧连接会不会残留在线路由脏值

也就是说，**跨实例系统最难的并不是“推一次消息”，而是“长时间维持一份可信的在线路由事实”。**

## 第六步：跨实例链的入口也受安全边界约束

跨实例路由不是在一个真空世界里发生的，它仍然受连接建立时的安全边界约束。

### IM：ws_ticket 不是 access token

`ImHandshakeInterceptor` 在 `my-xhs-im/src/main/java/com/myxhs/im/handler/ImHandshakeInterceptor.java:41` 到 `:57` 中，明确要求：

- URL 参数里必须有 ticket
- 解析出 JWT 后，`type` 必须是 `ws_ticket`
- 不能拿普通 access token 冒充 WebSocket 握手票据

### SSE：ticket 两步法 + 一次性消费

`SseTicketService.validateAndConsume()` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/SseTicketService.java:56` 到 `:67` 中，使用 `getAndDelete` 原子消费 ticket，一次成功后就不再可复用。

这说明跨实例推送链不是一个脱离认证世界的“内部技巧”，而是建立在：

- IM 握手 ticket 正确
- SSE 两步法 ticket 一次性消费
- 用户上线事实被安全地映射到 Redis 路由

这些前提之上。

## 真实故障案例：为什么跨实例路由最危险的不是收不到一条消息，而是旧方案把每条消息广播给所有实例

当前最值得保留的真实故障/修复案例，不是“某次网络超时”，而是 IM 跨实例路由从 RocketMQ 广播改成 Redis Pub/Sub 定向投递的那次架构修正。

### 现象

旧方案下，每个实例都会收到跨实例 IM 消息：

- 大多数实例收到后发现目标用户不在本机
- 做完反序列化和过滤后直接丢弃
- 实例越多，无效工作越多

### 根因

根因不是 MQ 不可用，而是跨实例路由设计本身把“目标用户在哪台实例”这件事放到了消息消费之后才判断。也就是说，路由决策做晚了。

### 修复

当前实现把路由前移：

1. 先由 `OnlineRouteService` 给出 `userId -> serverId`
2. 再按 `targetServerId` 构造 `myxhs:im:route:{serverId}` 专属 Channel
3. 只有目标实例真正订阅并消费这条消息

对应修复线索已经直接写在：

- `my-xhs-im/src/main/java/com/myxhs/im/subscriber/ImRouteSubscriber.java:23`
- `my-xhs-im/src/main/java/com/myxhs/im/dto/RouteMessage.java:11`

### 验证

要验证这类问题，不能只看“跨实例能不能送到”，还要看：

- 目标用户在另一实例时，是否只命中目标实例 Channel
- 非目标实例是否不再做无效 client-side 过滤
- 推送失败时是否降级存离线
- 重连后是否按 `seqNo` 顺序补推

### 余波

这个案例说明，**跨实例路由最重要的优化不是“推送更快一点”，而是“把路由决策尽量前移，别让所有实例替目标实例白干活”。**

## 证据清单

这篇关键判断主要由以下证据托底：

- IM 握手 ticket 类型校验：`my-xhs-im/src/main/java/com/myxhs/im/handler/ImHandshakeInterceptor.java:17`
- IM 本机会话建立与 Redis 路由注册：`my-xhs-im/src/main/java/com/myxhs/im/handler/ImWebSocketHandler.java:45`
- IM 在线路由表与 Lua 注销保护：`my-xhs-im/src/main/java/com/myxhs/im/service/OnlineRouteService.java:14`
- IM 先持久化再路由：`my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:122`
- IM 跨实例定向 Pub/Sub 与离线降级：`my-xhs-im/src/main/java/com/myxhs/im/service/ChatService.java:147`、`my-xhs-im/src/main/java/com/myxhs/im/subscriber/ImRouteSubscriber.java:123`
- IM 路由消息结构与 `seqNo`：`my-xhs-im/src/main/java/com/myxhs/im/dto/RouteMessage.java:8`
- SSE ticket 两步法与一次性消费：`my-xhs-notification/src/main/java/com/myxhs/notification/controller/NotificationController.java:37`、`my-xhs-notification/src/main/java/com/myxhs/notification/service/SseTicketService.java:12`
- SSE 本机连接映射、Redis 路由键和心跳续期：`my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseEmitterManager.java:23`
- SSE 跨实例 Pub/Sub 订阅：`my-xhs-notification/src/main/java/com/myxhs/notification/sse/SseCrossInstanceSubscriber.java:18`

## 边界清单

- 本篇讨论的是“跨实例路由和失败降级”这条横切主线，不重复展开 IM 会话协议、通知聚合或未读计数本身的业务语义。
- 当前 IM 已经采用按目标实例专属 Channel 的定向 Pub/Sub；SSE 仍是公共 Channel + 本机在线判断，两者不能被写成完全同一种跨实例策略。
- 当前 SSE 链没有像 IM 那样单独维护“离线通知消息队列”；它依赖的是通知列表和未读数本身作为离线可见视图，这属于当前实现语义，不是所有通知系统通用做法。
- 当前证据已经足够支撑“跨实例路由结构存在且代码路径完整”，但是否在多实例环境中持续在线跑过 IM 与 SSE 的跨实例全链路，仍应继续参考历史 G7、review 文档和后续运行态验证材料，不能把本文直接写成所有环境都已 L2 实测打通。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 收网：这篇 Cross-Instance 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的跨实例消息路由不是“多部署几台服务后再加个广播”这么轻，而是把在线连接、目标实例、定向投递和失败降级重新建模成了一条独立基础设施链。IM 和 SSE 之所以都要跨实例路由，不是因为它们都叫“消息”，而是因为它们都要回答“用户现在不在我这台机器上，我还能不能把正确语义送到他眼前”；不同的是，IM 必须再保一条离线补投链，而通知链则把通知列表和未读数本身当作离线可见视图。

从业务逻辑视角看，它守住的是“用户无论连到哪台实例，消息和提醒都不该凭空蒸发”；从工程视角看，它把 Redis 路由表、Pub/Sub、TTL 续期、Lua 注销保护、离线降级和 ticket 两步法织成了统一控制面；从分布式视角看，它说明跨实例系统最难的不是把消息发出去，而是长期维持一份可信的在线事实，并在这份事实失真时有明确降级；从微服务视角看，它也把“消息系统”内部再次拆成了 IM 会话路由链和通知在线路由链两种不同形态。

更重要的是，这篇把一个特别容易被讲轻的事实钉住了：**跨实例最危险的从来不是‘偶尔收不到一条消息’，而是系统根本没有先回答‘这条消息此刻该去哪台实例，以及去不到时语义应该落到哪里’。**
