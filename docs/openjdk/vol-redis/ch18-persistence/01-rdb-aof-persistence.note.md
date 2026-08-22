# vol-redis R-8 持久化 RDB + AOF — note

## 本篇主张

- RDB 是"点"快照（全量），AOF 是"线"日志（增量），两者互补。
- `rdbSave` 阻塞 / `rdbSaveBackground` fork COW 子进程。
- `flushAppendOnlyFile` 分 always/everysec/no 三种策略，在 `beforeSleep` 中调用。
- AOF Rewrite（7.0+）：Multi-part AOF，子进程写 base.rdb，主进程 `openNewIncrAofForAppend`（aof.c:771）打开 incremental.aof 接增量。
- Multi-part AOF：base.rdb + incremental.aof + manifest。

## 本篇边界

- 不展开 RDB 的 CRC64 校验和文件格式细节。
- 不展开 AOF manifest 的持久化细节。

## 下篇桥接

- R-9 复制将展开 PSYNC 部分同步、repl_backlog 和链式复制。
