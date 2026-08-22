# vol-redis R-15 Cluster — review notes

## 事实审

- 已核对 `src/cluster.h:9`-`:10`（`CLUSTER_SLOTS 16384` / `CLUSTER_SLOT_MASK`），正文成立。
- 已核对 `src/cluster.c`（`keyHashSlot()` CRC16 % 16384），正文成立。
- 已核对 `src/cluster.c:956`（`getNodeByQuery()` 统一 key 检查入口）、`:1022`（`keyHashSlot` 调用），正文成立。
- 已核对 `src/cluster.c:1179`（`clusterRedirectClient()` MOVED/ASK/TRYAGAIN），正文成立。
- 已核对 `src/cluster_legacy.c:4634`（`clusterCron()` Gossip），正文成立。
- 已核对 `src/cluster.c:1386`-`:1390`（`CLUSTER_SLOTS` 遍历），正文成立。

## 因果审

- CRC16 % 16384 映射 key 到 slot，hash tag 支持同 slot 多 key，正文成立。
- `clusterRedirectClient` 按错误码返回不同重定向，正文成立。
- Gossip 协议最终一致，随时间收敛，正文成立。
- `clusterHandleSlaveFailover` 投票选主接管 slot，正文成立。

## 结构审

- 从"Cluster 怎么路由 key"困惑开场，再落到 slot 映射、重定向、迁移、Gossip、故障转移，主线集中。

## 读者审

- 读完应能回答：key 怎么映射到 16384 个 slot。
- 读完应能回答：MOVED 和 ASK 的区别。
- 读完应能回答：Gossip 协议怎么维护拓扑。
- 读完后能自然进入 R-19 排障层。

## 边界审

- 本篇没有展开 Gossip 消息的完整编码细节。
- R-19 生产排障未提前透支，边界成立。

## 依赖审

- 前置依赖：R-9 复制（SOFT）、R-27 Lua 集群约束（HARD，getNodeByQuery 共同入口）。
- 后续桥接：R-19 生产排障层。

## 结论

R-15 已完成四件套的事实回填与六层审查，可进入 R-19~R-24 排障层。
