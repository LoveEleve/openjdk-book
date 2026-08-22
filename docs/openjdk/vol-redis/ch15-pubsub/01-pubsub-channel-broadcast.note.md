# vol-redis R-31 发布订阅 — note

## 本篇主张

- Pub/Sub 不是消息队列，而是 **广播+易失** 协议：消息不持久化、不写入 AOF、不写入复制缓冲。
- `PUBLISH` 遍历 `server.pubsub_channels`（频道→客户端列表）和 `server.pubsub_patterns`（模式→客户端列表）逐个写响应。
- 断线客户端收不到订阅期间的消息，这是 Pub/Sub 的固有设计。
- 与 Stream（持久化+消费者组）和 List（独占消费）是三种不同的消息模型。

## 本篇边界

- 不展开 shard Pub/Sub（ssubscribe/spublish）的完整实现。
- 不展开 `pubsubPublishMessageInternal` 的具体遍历细节。

## 下篇桥接

- R-32 ACL 权限控制将展开 default 用户、ACL 规则和命令类别位标志。
