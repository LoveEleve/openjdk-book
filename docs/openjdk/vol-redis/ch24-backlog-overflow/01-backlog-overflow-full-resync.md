# repl-backlog-size 太小为什么会导致全量同步

> 本文基于 Redis 7.4.2 当前源码。排障层第三篇，回答复制 backlog 溢出问题。

## 一、repl_backlog 环形缓冲

`createReplicationBacklog()`（`replication.c:102`）创建环形缓冲，`repl_backlog_size`（`server.h:1880`）默认 1MB。主节点每写一条命令，同时写入 `repl_buffer_blocks`（给在线的从节点）和 `repl_backlog`（给可能重连的从节点）。

## 二、backlog 覆盖 → 退化为全量

从节点断线后，主节点继续写 backlog。当新数据超过 `repl-backlog-size` 时，**最旧的数据被覆盖**。从节点重连时 `syncCommand` 检查其 offset，如果 offset 对应的数据已被覆盖，PSYNC 无法部分同步，退化为全量 RDB 传输。

## 三、复制风暴

多个从节点同时断线重连且 backlog 都被覆盖，同时请求全量同步。主节点需要 fork 多个 RDB 生成进程（实际是串行），RDB 传输和从节点 Load 造成大范围毛刺。

## 四、失败路径

- `repl-backlog-size` 太小 → 短断线就退化全量
- 副本节点消费慢 → `repl_buffer_blocks`（在线缓冲）增长，可被 `client-output-buffer-limit replica` 断开
- 链式复制中主从拖慢放大 backlog 压力

## 收网

`repl_backlog` 环形缓冲默认 1MB，被新数据覆盖后从节点无法部分同步，退化为全量。多从节点同时退化造成复制风暴。

## 下篇桥接

R-22 AOF fsync 与磁盘抖动。
