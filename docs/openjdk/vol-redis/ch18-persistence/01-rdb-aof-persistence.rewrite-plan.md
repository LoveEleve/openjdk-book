# 篇：01 持久化：RDB 快照与 AOF 追加日志

- 域：`R-8 持久化 RDB + AOF`
- 卷：`vol-redis`
- 目标：回答 RDB 与 AOF 各自解决什么问题，以及 Multi-part AOF 的实现。

## 前置依赖

- HARD：已读 `R-2 事件驱动`（知道 `beforeSleep` 中 `flushAppendOnlyFile` 的执行时机）。

## 读者问题

1. RDB 的 SAVE 和 BGSAVE 有什么区别？
2. AOF 的 always/everysec/no 三种策略各自怎么工作？
3. AOF Rewrite 是怎么做的？fork 子进程 + pipe 增量？
4. Multi-part AOF（7.0+）的 base + incremental + manifest 是什么？

## 主结论

RDB 与 AOF 的持久化策略互补：RDB 是"点"快照（全量），AOF 是"线"日志（增量）。7.0 的 Multi-part AOF 用 base.rdb + incremental.aof + manifest 替代了旧版单一 AOF 文件。

## 结构设计

1. 困惑开场：为什么需要两种持久化
2. RDB：SAVE 阻塞 + BGSAVE fork COW
3. AOF：flushAppendOnlyFile 与 always/everysec/no 三策略
4. AOF Rewrite：fork + pipe 增量 + rename 替换
5. Multi-part AOF 7.0+
6. 失败路径
7. 收网与下篇桥接 R-9 复制

## 必须回填的源码锚点

- `src/rdb.c:1593` `rdbSave()`（SAVE 阻塞保存）
- `src/rdb.c:1636` `rdbSaveBackground()`（BGSAVE fork 子进程）
- `src/rdb.c:1452` `rdbSaveRio()`（序列化核心）
- `src/aof.c:1045` `flushAppendOnlyFile()`（AOF 落盘）
- `src/aof.c:1117` `aofWrite()`（写入文件）
- `src/aof.c:1308` `feedAppendOnlyFile()`（命令追加到 aof_buf）
- `src/aof.c:2357` `rewriteAppendOnlyFile()`（AOF rewrite）
- `src/aof.c:2437` `rewriteAppendOnlyFileBackground()`（fork 重写）
- `src/aof.c:27`-`:54` Multi-part AOF manifest 注释

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
