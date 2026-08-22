# 主从复制：全量同步与 PSYNC 部分同步

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第十九篇，回答主从复制如何从全量同步过渡到部分同步。

## 为什么"主从就是复制数据"这个理解会把复制读浅

很多人第一次用 Redis 主从，觉得就是 SLAVEOF 之后主节点把数据同步到从节点就完了。

但 Redis 的主从复制分**两阶段**：全量同步（RDB 传输，只做一次）和 PSYNC 部分同步（repl_backlog 环形缓冲，断线重连时只同步增量）。replid 和 replid2 处理链式复制场景。

## 一、全量同步

`replicationSetupSlaveForFullResync()`（`src/replication.c:689`）是全量同步的入口：

1. 从节点发 `SLAVEOF master_ip master_port`
2. 主节点 `BGSAVE` 生成 RDB 文件
3. 主节点把 RDB 发送给从节点
4. 从节点 `rdbLoad()` 加载 RDB

## 二、PSYNC 部分同步

`syncCommand()`（`src/replication.c:915`）处理从节点的 PSYNC 请求。如果从节点断线重连，主节点检查 `repl_backlog` 中是否还保留着从节点缺失的数据（通过 offset 判断）。

`repl_backlog` 初始化（`src/replication.c:102` `createReplicationBacklog()`）：

```c
server.repl_backlog->ref_repl_buf_node = NULL;
server.repl_backlog->blocks_index = raxNew();  // 用 rax 树索引快速定位 offset
server.repl_backlog->histlen = 0;
server.repl_backlog->offset = server.master_repl_offset + 1;
```

`repl_backlog` 是一个环形缓冲，`repl-backlog-size` 默认 1MB。当从节点断线后，主节点继续写入的数据如果覆盖了 backlog 中的旧数据，从节点就无法通过 PSYNC 恢复，退化为全量同步。

## 三、replid / replid2：链式复制

`replid`（`src/server.h:1868`）是主节点的复制 ID。`replid2`（`:1869`）是继承的旧主节点 ID，`second_replid_offset`（`:1871`）记录对应偏移量。

链式复制场景：A（主）→ B（从）→ C（从 B）。如果 B 崩溃后重启指向 A，C 断线后重连到 B，但 B 已经不是原来的主节点。此时 C 用 `replid2` 和 `second_replid_offset` 回溯到 A，避免全量同步。

## 四、replicationCron

`replicationCron()`（`src/replication.c:3704`）在 `serverCron` 中每 100ms 执行，检查主从连接状态、发送心跳 PING、处理超时等。

## 五、失败路径

### 1. backlog 溢出

`repl-backlog-size` 太小（默认 1MB），从节点断线时间稍长 backlog 就被覆盖，退化为全量同步。全量同步的 RDB 传输和 Load 都会造成主从毛刺。

### 2. 复制风暴

多个从节点同时断线重连，全部请求全量同步。主节点同时 fork 多个 BGSAVE 进程，CPU 和内存压力剧增。

## 到这里，R-9 真正立住的是"全量 + PSYNC 增量 + replid 链式复制"

如果只看表面，复制被读成"SLAVEOF 复制数据"。

更稳的理解方式应该是：

1. 全量同步：`replicationSetupSlaveForFullResync` → RDB 传输 → Load
2. PSYNC：`syncCommand` 检查 backlog，offset 比照
3. `repl_backlog`：环形缓冲 + rax 索引 + histlen + offset
4. `replid` / `replid2`：链式复制回退

## 下篇桥接

R-14 Sentinel 将展开哨兵的主客观下线判断与故障转移。
