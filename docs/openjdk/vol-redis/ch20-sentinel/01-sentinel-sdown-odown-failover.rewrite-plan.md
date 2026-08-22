# 篇：01 Sentinel 哨兵：主客观下线与故障转移

- 域：`R-14 Sentinel`
- 卷：`vol-redis`
- 目标：回答 Sentinel 如何做主客观下线判断与自动故障转移。

## 前置依赖

- HARD：已读 `R-9 复制`（知道 SLAVEOF、slave promotion）。

## 读者问题

1. SDOWN（主观下线）和 ODOWN（客观下线）有什么区别？
2. 故障转移怎么选择新主节点？
3. sentinel 之间怎么协作判断 ODOWN？
4. sentinelTimer 多久跑一次？

## 主结论

Sentinel 用 **SDOWN（单哨兵主观判断）→ ODOWN（多哨兵投票确认）→ 故障转移** 三步完成自动选主。SDOWN 是单台哨兵认为实例下线，ODOWN 是达到 quorum 数量的哨兵确认下线，才触发故障转移。

## 结构设计

1. 困惑开场：为什么需要两阶段下线判断
2. sentinelTimer：每 100ms 执行
3. SDOWN：`sentinelCheckSubjectivelyDown` PING 超时
4. ODOWN：`sentinelCheckObjectivelyDown` 投票确认
5. 故障转移：`sentinelFailoverStateMachine` 选主 + SLAVEOF NO ONE
6. 失败路径
7. 收网与下篇桥接 R-15 Cluster

## 必须回填的源码锚点

- `src/sentinel.c:5449` `sentinelTimer()`（哨兵主循环）
- `src/sentinel.c:5358` `sentinelHandleRedisInstance()`（实例处理）
- `src/sentinel.c:4516` `sentinelCheckSubjectivelyDown()`（SDOWN）
- `src/sentinel.c:4590` `sentinelCheckObjectivelyDown()`（ODOWN）
- `src/sentinel.c:5310` `sentinelFailoverStateMachine()`（故障转移状态机）
- `src/sentinel.c:373` `sentinelGetObjectiveLeader()`
- `src/sentinel.c:2772` `sentinelPingReplyCallback()`（PING 回应）
- `src/sentinel.c:3844` `sentinelCommand()`（SENTINEL 命令，含 is-master-down-by-addr）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
