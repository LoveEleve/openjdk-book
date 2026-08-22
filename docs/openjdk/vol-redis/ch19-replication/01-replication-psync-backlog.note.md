# vol-redis R-9 复制 PSYNC — note

## 本篇主张

- 主从复制分两阶段：**全量同步**（RDB 传输，只做一次）和 **PSYNC 部分同步**（repl_backlog 环形缓冲，断线重连时只同步增量）。
- `repl_backlog` 用 `ref_repl_buf_node` 链表 + `blocks_index`（rax 树索引）快速定位 offset。
- `replid` 是当前复制 ID，`replid2` 是继承的旧主节点 ID，用于链式复制回退。
- `repl-backlog-size` 默认 1MB，太小覆盖后退化为全量同步。

## 本篇边界

- 不展开 `readSyncBulkPayload` 的完整 RDB 加载细节。
- 不展开 `replicationCron` 中所有定时任务的完整实现。

## 下篇桥接

- R-14 Sentinel 将展开哨兵的主客观下线判断与故障转移。
