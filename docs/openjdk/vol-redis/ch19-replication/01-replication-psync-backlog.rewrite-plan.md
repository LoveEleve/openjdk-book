# 篇：01 主从复制：PSYNC 部分同步与 repl_backlog

- 域：`R-9 复制 PSYNC`
- 卷：`vol-redis`
- 目标：回答主从如何只同步增量，replid 与 replid2 解决什么问题。

## 前置依赖

- HARD：已读 `R-8 持久化`（知道全量复制的 RDB 传输）。

## 读者问题

1. 从节点同步的主流程是什么？
2. PSYNC 部分同步的 repl_backlog 怎么工作？
3. replid 与 replid2 怎么解决链式复制回退？
4. repl-backlog-size 默认 1MB 够吗？

## 主结论

主从复制分两阶段：**全量同步**（SLAVEOF → RDB 传输 → Load）和 **PSYNC 部分同步**（repl_backlog 环形缓冲，断线重连时只同步增量）。

replid 是当前复制 ID，replid2 是继承的旧主节点 ID，用于链式复制（A→B→C 时 C 的主节点 B 崩溃后，C 可用 replid2 找到 A）。

## 结构设计

1. 困惑开场：从节点为什么要同步两次
2. 全量同步：SLAVEOF → replicationSetupSlaveForFullResync
3. PSYNC：syncCommand 与 repl_backlog
4. repl_backlog 结构：ref_repl_buf_node + blocks_index + histlen + offset
5. replid / replid2：链式复制
6. replicationCron
7. 失败路径
8. 收网与下篇桥接 R-14 Sentinel

## 必须回填的源码锚点

- `src/replication.c:689` `replicationSetupSlaveForFullResync()`（全量同步）
- `src/replication.c:915` `syncCommand()`（PSYNC 处理）
- `src/replication.c:102` `createReplicationBacklog()`（backlog 初始化）
- `src/replication.c:152` `createReplicationBacklogIndex()`（rax 索引）
- `src/replication.c:3704` `replicationCron()`（定时心跳）
- `src/server.h:1868`-`:1869` `replid` / `replid2`
- `src/server.h:1871` `second_replid_offset`
- `src/server.h:1879`-`:1881` `repl_backlog` / size / time_limit
- `src/server.h:1894`-`:1895` `repl_buffer_mem` / `repl_buffer_blocks`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
