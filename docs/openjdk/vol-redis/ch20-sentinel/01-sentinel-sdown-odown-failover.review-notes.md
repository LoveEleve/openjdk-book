# vol-redis R-14 Sentinel — review notes

## 事实审

- 已核对 `src/sentinel.c:5449`（`sentinelTimer()` 哨兵主循环），正文成立。
- 已核对 `src/sentinel.c:5358`（`sentinelHandleRedisInstance()` 实例处理），正文成立。
- 已核对 `src/sentinel.c:4516`（`sentinelCheckSubjectivelyDown()` SDOWN），正文成立。
- 已核对 `src/sentinel.c:4590`（`sentinelCheckObjectivelyDown()` ODOWN），正文成立。
- 已核对 `src/sentinel.c:5310`（`sentinelFailoverStateMachine()` 故障转移状态机），正文成立。
- 已核对 `src/sentinel.c:373`（`sentinelGetObjectiveLeader()` 选主），正文成立。
- 已核对 `src/sentinel.c:3844`（`sentinelCommand()` 含 is-master-down-by-addr），正文成立。

## 因果审

- SDOWN + ODOWN 两阶段避免单台哨兵误判触发切换，正文成立。
- quorum 投票机制保证客观下线确认，正文成立。
- 故障转移选主按 priority + offset + runid 选择最优节点，正文成立。

## 结构审

- 从"为什么需要两阶段下线判断"困惑开场，再落到 sentinelTimer/SDOWN/ODOWN/故障转移，主线集中。

## 读者审

- 读完应能回答：SDOWN 和 ODOWN 的区别。
- 读完应能回答：故障转移怎么选新主节点。
- 读完后能自然进入 R-15 Cluster。

## 边界审

- 本篇没有展开 PING 回应的完整实现。
- R-15 Cluster 未提前透支，边界成立。

## 依赖审

- 前置依赖：R-9 复制（HARD）。
- 后续桥接：R-15 Cluster。

## 结论

R-14 已完成四件套的事实回填与六层审查，可进入 R-15 Cluster。
