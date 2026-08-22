# vol-redis R-14 Sentinel — note

## 本篇主张

- Sentinel 的下线判断分两阶段：SDOWN（主观下线，单台哨兵 PING 超时）和 ODOWN（客观下线，多哨兵投票达 quorum）。
- `sentinelTimer`（100ms）→ `sentinelHandleRedisInstance` → `sentinelCheckSubjectivelyDown` / `sentinelCheckObjectivelyDown`。
- `sentinelFailoverStateMachine` 选主（priority + offset + runid）→ SLAVEOF NO ONE → 通知从节点 → 更新配置。
- 脑裂是 Sentinel 的固有风险，网络分区时可能两个主节点同时存在。

## 本篇边界

- 不展开 `sentinelPingReplyCallback` 的 PING 回应细节。
- 不展开 `sentinelGetObjectiveLeader` 的投票算法细节。

## 下篇桥接

- R-15 Cluster 将展开 16384 slot 分片、Gossip 协议和故障转移。
