# Sentinel 为什么需要两阶段下线判断

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第二十篇，回答 Sentinel 的主客观下线判断与自动故障转移。

## 为什么"Sentinel 就是监控"这个理解会把哨兵读浅

很多人第一次用 Sentinel，觉得它就是一个监控工具，检测到主节点挂了就切换。

但 Sentinel 的"主节点挂了"分**两阶段**：SDOWN（主观下线，单台哨兵认为挂了）和 ODOWN（客观下线，多台哨兵投票确认挂了）。只有 ODOWN 才触发故障转移，避免单台哨兵误判导致切换。

## 一、sentinelTimer：主循环

`sentinelTimer()`（`src/sentinel.c:5449`）是 Sentinel 的主循环，每 100ms 执行一次。对每个监控的实例（master/slave/sentinel）调用 `sentinelHandleRedisInstance()`（`src/sentinel.c:5358`）。

## 二、SDOWN：主观下线

`sentinelCheckSubjectivelyDown()`（`src/sentinel.c:4516`）检查实例是否主观下线：

- 如果 `PING` 超时（`down-after-milliseconds`），标记为 `SRI_S_DOWN`
- SDOWN 是**单台哨兵**的判断，不与其他哨兵协商

## 三、ODOWN：客观下线

`sentinelCheckObjectivelyDown()`（`src/sentinel.c:4590`）检查是否达到客观下线条件：

- 通过 `SENTINEL is-master-down-by-addr` 命令向其他哨兵询问对主节点的判断
- 如果至少 `quorum` 个哨兵确认主节点挂了，标记为 `SRI_O_DOWN`
- ODOWN 是**多哨兵投票**的结果，达到 quorum 才触发故障转移

## 四、故障转移

`sentinelFailoverStateMachine()`（`src/sentinel.c:5310`）是故障转移的状态机，依次执行：

1. 选新主节点：`sentinelGetObjectiveLeader()`（`sentinel.c:373`）按 `slave-priority` + `repl_offset` + runid 选最优从节点
2. `SLAVEOF NO ONE`：提升新主节点
3. 通知其他从节点指向新主节点
4. 更新配置

## 五、失败路径

### 1. 脑裂

Sentinel 误判主节点下线（实际上主节点还在运行，只是网络分区），导致两个主节点同时存在。`sentinel-rename` 等机制缓解，但无法完全避免。

### 2. quorum 不足

如果 quorum 设置过大，网络分区后哨兵无法达到 quorum，不触发故障转移。

### 3. 选主延迟

选主后原主节点恢复，但已经被降级为从节点，需手动处理。

## 到这里，R-14 真正立住的是"SDOWN+ODOWN+故障转移三阶段"

如果只看表面，Sentinel 被读成"监控工具"。

更稳的理解方式应该是：

1. SDOWN：`sentinelCheckSubjectivelyDown` 单台哨兵 PING 超时判断
2. ODOWN：`sentinelCheckObjectivelyDown` 多哨兵投票确认
3. 故障转移：`sentinelFailoverStateMachine` 选主 + SLAVEOF NO ONE

## 下篇桥接

R-15 Cluster 将展开 16384 slot 分片、Gossip 协议和故障转移。
