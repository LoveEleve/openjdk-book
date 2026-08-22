# vol-redis R-8 持久化 RDB + AOF — review notes

## 事实审

- 已核对 `src/rdb.c:1593`（`rdbSave()` SAVE 阻塞保存），正文成立。
- 已核对 `src/rdb.c:1636`（`rdbSaveBackground()` BGSAVE fork 子进程），正文成立。
- 已核对 `src/rdb.c:1452`（`rdbSaveRio()` 序列化核心），正文成立。
- 已核对 `src/aof.c:1045`（`flushAppendOnlyFile()` AOF 落盘），正文成立。
- 已核对 `src/aof.c:1117`（`aofWrite()` 写入文件），正文成立。
- 已核对 `src/aof.c:1308`（`feedAppendOnlyFile()` 命令追加 aof_buf），正文成立。
- 已核对 `src/aof.c:2357`（`rewriteAppendOnlyFile()` AOF rewrite），正文成立。
- 已核对 `src/aof.c:2437`（`rewriteAppendOnlyFileBackground()` fork 重写），正文成立。
- 已核对 `src/aof.c:771`（`openNewIncrAofForAppend()` 打开新 incremental AOF），正文成立。
- 已核对 `src/aof.c:27`-`:54`（Multi-part AOF manifest 注释），正文成立。

## 因果审

- RDB 点快照恢复快但可能丢数据（SAVE 阻塞 / BGSAVE COW），正文成立。
- AOF 线日志恢复慢但丢数据少（三种 fsync 策略），正文成立。
- AOF Rewrite（7.0+）用 Multi-part AOF 的 base.rdb + incremental.aof 替代旧版单一 AOF + pipe 机制，正文已修正。
- 深度复审发现并修正了"fork + pipe 增量"的过时表述（Redis 6.x 模型，7.x 已改为 Multi-part AOF）。

## 结构审

- 从"为什么需要两种持久化"困惑开场，再落到 RDB/AOF/Rewrite/Multi-part AOF，主线集中。

## 读者审

- 读完应能回答：RDB 和 AOF 各自解决什么问题。
- 读完应能回答：三种 fsync 策略的区别。
- 读完应能回答：AOF Rewrite 在 7.x 的 Multi-part 机制。
- 读完后能自然进入 R-9 复制。

## 边界审

- 本篇没有展开 RDB 的 CRC64 校验和文件格式细节。
- R-9 复制未提前透支，边界成立。

## 依赖审

- 前置依赖：R-2 事件驱动（HARD，知道 beforeSleep 中 flushAppendOnlyFile）。
- 后续桥接：R-9 复制 PSYNC。

## 结论

R-8 已完成深度复审，1 处过时表述已修正，可进入 R-9 复制。
