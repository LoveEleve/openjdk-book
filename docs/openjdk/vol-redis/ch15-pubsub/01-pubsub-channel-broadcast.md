# 为什么 Pub/Sub 的消息会丢

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第十五篇，回答 PUB/SUB 的频道组广播机制、可靠性边界与三种消息模型对比。

## 为什么"PUBLISH 就是发消息"这个理解会把 Pub/Sub 读浅

很多人第一次用 Redis Pub/Sub，觉得它就像一个消息队列，PUBLISH 发消息、SUBSCRIBE 收消息。

但 Pub/Sub 不是消息队列——它是**广播+易失**协议。消息不持久化、不写入 AOF、不写入复制缓冲。断连的客户端收不到订阅期间的消息。

## 一、订阅：`pubsub_channels` 与 `pubsub_patterns`

`subscribeCommand()`（`src/pubsub.c:520`）把客户端频道加入 `c->pubsub_channels`（客户端级字典）和 `server.pubsub_channels`（服务端级字典，`kvstore`，频道→客户端列表）。

`psubscribeCommand()`（`src/pubsub.c:554`）把模式加入 `c->pubsub_patterns`（`dict`）和 `server.pubsub_patterns`（`dict`，模式→客户端列表）。

## 二、发布：遍历所有订阅者

`publishCommand()`（`src/pubsub.c:598`）→ `pubsubPublishMessage()`（`src/pubsub.c:511`）→ `pubsubPublishMessageInternal()`：

1. 从 `pubsub_channels` 中查找频道对应的客户端列表，逐个写入 `*3\r\n$7\r\nmessage\r\n...` 响应
2. 从 `pubsub_patterns` 中遍历所有模式，匹配的客户端逐个写入 `*3\r\n$8\r\npmessage\r\n...` 响应

## 三、为什么"发了就忘"

Pub/Sub 的不持久化体现在：

1. **不写入 `aof_buf`**：`publishCommand` 不调 `propagate()`，AOF 中不记录 PUBLISH
2. **不写入 `repl_buffer_blocks`**：不从主节点复制到从节点（除非 `cluster_enabled` 传播）
3. **不写入 `repl_backlog`**：断线重连的从节点不重放订阅期间的消息
4. **客户端断线消息丢失**：订阅期间断开连接的客户端，消息直接丢失，不缓冲

## 四、Pub/Sub vs Stream vs List 消费者

| 维度 | Pub/Sub | Stream | List (BLPOP) |
|------|---------|--------|-------------|
| 持久化 | 无 | RDB/AOF 持久化 | RDB/AOF 持久化 |
| 消息确认 | 无 | XACK 确认 | 消费即删除 |
| 消费独占 | 广播（所有订阅者收到） | 消费者组（每条消息一个消费者） | 独占（一个 LPOP） |
| 消费者组 | 无 | 有（XREADGROUP） | 无 |
| 超时/阻塞 | 无 | XREAD BLOCK | BLPOP timeout |

## 五、失败路径

### 1. 客户端消费太慢被断开

`client-output-buffer-limit` 对 pubsub 类客户端的限制通常比 normal 更严格（默认 `32mb 8mb 60`）。客户端消费 PUBLISH 消息的速度慢于生产速度时，输出缓冲膨胀，超过限制被断开。

### 2. 断线期间消息丢失

客户端断线期间，所有 PUBLISH 消息都丢失。这是 Pub/Sub 的固有特性，不属于"故障"而是设计。

### 3. 模式匹配的性能开销

`PSUBSCRIBE foo:*` 模式下，每次 `PUBLISH` 到 `foo:bar` 频道时，需要遍历 `server.pubsub_patterns` 所有模式做通配符匹配。大规模模式列表下，`PUBLISH` 的延迟随模式数线性增长。

## 到这里，R-31 真正立住的是"Pub/Sub 是广播+易失协议"

如果只看表面，Pub/Sub 被读成"消息队列"。

更稳的理解方式应该是：

1. 订阅：`server.pubsub_channels`（频道→客户端列表）+ `server.pubsub_patterns`（模式→客户端列表）
2. 发布：遍历所有匹配的客户端，逐个写响应
3. 不持久化、不 AOF、不复制，断线消息丢失
4. 与 Stream（持久化+消费者组）和 List（独占）是三种不同的消息模型

## 下篇桥接

R-32 ACL 权限控制将展开 default 用户、ACL 规则和命令类别位标志。
