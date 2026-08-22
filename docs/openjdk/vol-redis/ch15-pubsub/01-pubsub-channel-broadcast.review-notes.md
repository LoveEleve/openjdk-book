# vol-redis R-31 发布订阅 — review notes

## 事实审

- 已核对 `src/pubsub.c:520`（`subscribeCommand()` 频道订阅），正文成立。
- 已核对 `src/pubsub.c:598`（`publishCommand()` 发布命令），正文成立。
- 已核对 `src/pubsub.c:511`（`pubsubPublishMessage()` 内部发布），正文成立。
- 已核对 `src/pubsub.c:49`（`channelList()` 频道列表），正文成立。
- 已核对 `src/pubsub.c` 中 `pubsub_channels` 和 `pubsub_patterns` 结构（`server.pubsub_channels` / `server.pubsub_patterns`），正文成立。

## 因果审

- `PUBLISH` 遍历 `pubsub_channels` 和 `pubsub_patterns` 逐个写响应，正文成立。
- Pub/Sub 不持久化、不 AOF、不复制，断线消息丢失，正文成立。
- Pub/Sub vs Stream vs List 三种消息模型的差异，正文成立。
- 输出缓冲限制对 pubsub 类客户端的约束，正文成立。

## 结构审

- 从"为什么消息会丢"困惑开场，再落到订阅/发布机制、不持久化原因、三种消息模型对比，主线集中。

## 读者审

- 读完应能回答：PUBLISH 怎么把消息发给所有订阅者。
- 读完应能回答：为什么 Pub/Sub 的消息会丢。
- 读完应能回答：Pub/Sub vs Stream vs List 的差异。
- 读完后能自然进入 R-32 ACL。

## 边界审

- 本篇没有展开 shard Pub/Sub（ssubscribe/spublish）的完整实现。
- R-32 ACL 未提前透支，边界成立。

## 依赖审

- 前置依赖：R-25 缓冲区体系（HARD，知道 client-output-buffer-limit）。
- 后续桥接：R-32 ACL 权限控制。

## 结论

R-31 已完成四件套的事实回填与六层审查，可进入 R-32 ACL。
