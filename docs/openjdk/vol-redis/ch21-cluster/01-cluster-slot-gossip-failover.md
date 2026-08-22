# Cluster 怎么把 key 路由到正确的节点

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第二十一篇，回答 Cluster 的 slot 分片、重定向、Gossip 协议与故障转移。

## 为什么"Cluster 就是多台 Redis"这个理解会把集群读浅

很多人第一次用 Redis Cluster，觉得它就是多台 Redis 一起工作。

但 Cluster 的关键不是"多台"，而是**数据如何跨节点路由**：key 通过 CRC16 映射到 16384 个 slot，每个 slot 属于一个节点。客户端访问某个 key 时，如果节点不持有该 key 的 slot，返回 MOVED 让客户端重定向到正确节点。

## 一、slot 映射：CRC16 % 16384

`CLUSTER_SLOTS 16384`（`src/cluster.h:9`）。`keyHashSlot()`（`src/cluster.c`）计算 key 的 slot：

```
slot = CRC16(key) % 16384
```

支持 hash tag：key 中 `{...}` 内的内容用于计算 slot，让 `{user123}:cart` 和 `{user123}:profile` 落在同一 slot，支持多 key 操作。

## 二、重定向：MOVED / ASK / TRYAGAIN / CLUSTERDOWN

`clusterRedirectClient()`（`src/cluster.c:1179`）根据错误码返回不同重定向：

- **MOVED**：key 的 slot 在另一个节点，客户端需缓存并重定向
- **ASK**：slot 迁移中，客户端需重定向但 `ASKING` 命令标记
- **TRYAGAIN**：多 key 命令在 slot 迁移窗口期，稍后重试
- **CLUSTERDOWN**：集群不可用（slot 未服务等）

## 三、迁移：MIGRATING / IMPORTING

slot 迁移时，源节点标记 `MIGRATING`，目标节点标记 `IMPORTING`。迁移窗口内，源节点仍持有部分 key，`getNodeByQuery`（`src/cluster.c:956`）检查 key 是否还在源节点：

- 还在源节点：直接执行
- 已迁走：返回 ASK 重定向

## 四、Gossip 协议

`clusterCron()`（`src/cluster_legacy.c:4634`）每 100ms 执行，通过 Gossip 协议维护集群拓扑：

1. 发送 PING/PONG 消息给部分其他节点
2. 消息中包含 `clusterMsgDataGossip` 数组，携带其他节点的状态
3. 接收方 `clusterProcessGossipSection` 更新本节点的集群认知
4. 节点通过 MEET 通知新节点加入

Gossip 协议是**最终一致**的——不保证所有节点第一时间知道所有状态，但随时间收敛。

## 五、故障转移

`clusterHandleSlaveFailover()`（`src/cluster_legacy.c`）在从节点检测到主节点 PFAIL 超时后执行：

1. 通过 Gossip 把主节点标记为 PFAIL
2. 达到多数节点确认（quorum）后标记 FAIL
3. 从节点发起投票请求，赢得多数投票后成为新主节点
4. 接管主节点的 slot

## 六、失败路径

### 1. 脑裂

主节点网络分区后，从节点升主，原主节点恢复后仍有存量数据，可能丢数据。`cluster-node-timeout` 控制 PFAIL 超时。

### 2. slot 迁移一致窗口

迁移窗口期，多 key 命令可能返回 TRYAGAIN，客户端需重试。

### 3. MOVED 缓存失效

客户端缓存了 MOVED 映射，但节点故障后 slot 归属变化，旧缓存指向过期节点。

## 到这里，R-15 真正立住的是"slot 路由 + Gossip 拓扑 + 故障转移"

如果只看表面，Cluster 被读成"多台 Redis"。

更稳的理解方式应该是：

1. `keyHashSlot` 用 CRC16 % 16384 映射 key 到 slot
2. `clusterRedirectClient` 处理 MOVED/ASK/TRYAGAIN/CLUSTERDOWN
3. `clusterCron` 用 Gossip 协议维护拓扑
4. slot 迁移用 MIGRATING/IMPORTING 标记
5. `clusterHandleSlaveFailover` 投票选主

## 下篇桥接

R-19 生产排障层将展开 RDB 阻塞、大 key 删除、复制 backlog 溢出等线上问题。
