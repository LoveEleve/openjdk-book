# 篇：01 发布订阅：PUB/SUB 频道组广播、可靠性边界与对比

- 域：`R-31 发布订阅`
- 卷：`vol-redis`
- 目标：回答 PUB/SUB 的频道组广播机制、为什么"发了就忘"、与 Stream/List 的对比。

## 前置依赖

- HARD：已读 `R-25 缓冲区体系`（知道 `client-output-buffer-limit` 对 pubsub 的限制）。

## 读者问题

1. PUBLISH 消息后，Redis 怎么把消息发给所有订阅者？
2. 为什么 Pub/Sub 的消息会丢？怎么丢的？
3. Pub/Sub vs Stream vs List 消费者有什么区别？
4. `pubsub_channels` 和 `pubsub_patterns` 各管什么？

## 主结论

Pub/Sub 是"广播+易失"协议——`PUBLISH` 遍历 `server.pubsub_channels` 中订阅该频道的所有客户端，逐个写入响应。消息不持久化、不写入 AOF、不写入复制缓冲。断连的客户端收不到订阅期间的消息。

## 结构设计

1. 困惑开场：Pub/Sub 的消息为什么丢
2. 订阅：`pubsub_channels`（频道→客户端列表）和 `pubsub_patterns`（模式→客户端列表）
3. 发布：`pubsubPublishMessageInternal` 遍历客户端
4. 为什么"发了就忘"：无持久化、无 AOF、无复制
5. Pub/Sub vs Stream vs List 消费者
6. 失败路径
7. 收网与下篇桥接

## 必须回填的源码锚点

- `src/pubsub.c:520` `subscribeCommand()`（频道订阅）
- `src/pubsub.c:598` `publishCommand()`（发布）
- `src/pubsub.c:511` `pubsubPublishMessage()`（内部发布）
- `src/pubsub.c:49` `channelList()`（频道列表）
- `src/pubsub.c` `pubsub_channels` / `pubsub_patterns` 结构
- `src/server.h` `server.pubsub_channels` / `server.pubsub_patterns`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
