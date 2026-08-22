# vol-redis R-9 复制 PSYNC — review notes

## 事实审

- 已核对 `src/replication.c:689`（`replicationSetupSlaveForFullResync()` 全量同步），正文成立。
- 已核对 `src/replication.c:915`（`syncCommand()` PSYNC 处理），正文成立。
- 已核对 `src/replication.c:102`（`createReplicationBacklog()` backlog 初始化），正文成立。
- 已核对 `src/replication.c:3704`（`replicationCron()` 定时心跳），正文成立。
- 已核对 `src/server.h:1868`-`:1869`（`replid` / `replid2`），正文成立。
- 已核对 `src/server.h:1879`-`:1881`（`repl_backlog` / size / time_limit），正文成立。

## 因果审

- 全量同步 + PSYNC 增量两阶段避免每次断线都全量 RDB，正文成立。
- `repl_backlog` 环形缓冲 + rax 索引快速定位 offset，正文成立。
- `replid2` + `second_replid_offset` 链式复制回退，正文成立。
- backlog 太小覆盖后退化为全量同步，正文成立。

## 结构审

- 从"为什么要同步两次"困惑开场，再落到全量/PSYNC/backlog/replid/链式复制，主线集中。

## 读者审

- 读完应能回答：全量同步和部分同步怎么切换。
- 读完应能回答：repl_backlog 怎么工作。
- 读完应能回答：replid2 解决什么问题。
- 读完后能自然进入 R-14 Sentinel。

## 边界审

- 本篇没有展开 RDB 传输的完整加载细节。
- R-14 Sentinel 未提前透支，边界成立。

## 依赖审

- 前置依赖：R-8 持久化（HARD）。
- 后续桥接：R-14 Sentinel。

## 结论

R-9 已完成四件套的事实回填与六层审查，可进入 R-14 Sentinel。
