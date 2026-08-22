# 篇：01 Cluster 集群：16384 slot 分片、Gossip 协议与故障转移

- 域：`R-15 Cluster`
- 卷：`vol-redis`
- 目标：回答 Cluster 如何分片、重定向、维护拓扑与自动故障转移。

## 前置依赖

- HARD：已读 `R-27 Lua 脚本`（知道 CROSSSLOT 检查，`getNodeByQuery` 是共同入口）。

## 读者问题

1. key 怎么被映射到 16384 个 slot？
2. MOVED / ASK / TRYAGAIN / CLUSTERDOWN 各在什么场景返回？
3. Gossip 协议怎么维护集群拓扑？
4. 故障转移怎么选主？

## 主结论

Cluster 用 **CRC16(key) % 16384** 把 key 映射到槽位，`keyHashSlot`（`cluster.c`）实现。节点间用 Gossip 协议（PING/PONG/MEET/FAIL）维护拓扑。`clusterRedirectClient`（`cluster.c:1179`）处理 MOVED/ASK/TRYAGAIN/CLUSTERDOWN 重定向。

## 结构设计

1. 困惑开场：跨节点怎么路由 key
2. slot 映射：CRC16 % 16384，keyHashSlot
3. 重定向：MOVED / ASK / TRYAGAIN / CLUSTERDOWN
4. 迁移：MIGRATING / IMPORTING
5. Gossip 协议：clusterCron + clusterProcessGossipSection
6. 故障转移：clusterHandleSlaveFailover
7. 失败路径
8. 收网与下篇桥接 R-19 排障层

## 必须回填的源码锚点

- `src/cluster.h:9`-`:10` `CLUSTER_SLOTS 16384` / `CLUSTER_SLOT_MASK`
- `src/cluster.c` `keyHashSlot()`（CRC16 % 16384）
- `src/cluster.c:956` `getNodeByQuery()`（slots 一起检查）
- `src/cluster.c:1022` `keyHashSlot` 调用
- `src/cluster.c:1179` `clusterRedirectClient()`（MOVED/ASK/TRYAGAIN）
- `src/cluster.c:1141`-`:1181` CROSSSLOT/TRYAGAIN 错误
- `src/cluster_legacy.c:4634` `clusterCron()`（Gossip）
- `src/cluster_legacy.c` `clusterHandleSlaveFailover()`
- `src/cluster.c` `getNodeBySlot()`
- `src/cluster.c:1386`-`:1390` `CLUSTER_SLOTS` 遍历

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
