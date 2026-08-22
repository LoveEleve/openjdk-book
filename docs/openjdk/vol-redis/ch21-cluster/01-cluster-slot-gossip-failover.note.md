# vol-redis R-15 Cluster — note

## 本篇主张

- Cluster 的关键不是"多台 Redis"，而是**数据跨节点路由**：`keyHashSlot` 用 CRC16 % 16384 把 key 映射到 slot。
- `clusterRedirectClient` 处理 MOVED/ASK/TRYAGAIN/CLUSTERDOWN 重定向。
- `clusterCron` 每 100ms 用 Gossip 协议（PING/PONG/MEET/FAIL）维护最终一致的集群拓扑。
- slot 迁移用 MIGRATING/IMPORTING 标记，迁移窗口期多 key 命令返回 TRYAGAIN。
- `clusterHandleSlaveFailover` 投票选主，接管 slot。

## 本篇边界

- 不展开 Gossip 消息的完整编码细节。
- 不展开 `clusterProcessGossipSection` 的完整处理逻辑。

## 下篇桥接

- R-19 生产排障层将展开 RDB 阻塞、大 key 删除、复制 backlog 溢出等线上问题。
