# 篇：01 复制 backlog 溢出与全量重同步风暴

- 域：`R-21 复制 backlog 溢出与全量重同步风暴`
- 卷：`vol-redis`
- 目标：回答 repl-backlog-size 太小为什么导致频繁全量同步，以及多从节点同时全量的风暴。

## 前置依赖

- HARD：已读 `R-9 复制`（知道 PSYNC 与 repl_backlog）。

## 读者问题

1. `repl-backlog-size` 默认 1MB 够吗？
2. backlog 被覆盖后为什么退化为全量同步？
3. 多个从节点同时掉线重连的"复制风暴"怎么发生？

## 主结论

从节点断线后，主节点继续写 `repl_backlog` 环形缓冲。如果 backlog 被新数据覆盖，从节点的 offset 已不在缓冲内，PSYNC 无法部分同步，退化为全量 RDB 传输 + Load。

## 必须回填的源码锚点

- `src/replication.c:102` `createReplicationBacklog()`
- `src/replication.c:104` `repl_backlog zmalloc`
- `src/server.h:1880` `repl_backlog_size`
- `src/replication.c` `addReplyReplicationBacklog()`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
