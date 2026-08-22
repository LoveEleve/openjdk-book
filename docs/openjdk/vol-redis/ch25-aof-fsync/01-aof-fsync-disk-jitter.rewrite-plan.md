# 篇：01 AOF fsync 与磁盘抖动

- 域：`R-22 AOF fsync 与磁盘抖动`
- 卷：`vol-redis`
- 目标：回答 always/everysec/no 三种策略的 fsync 行为，以及 AOF 阻塞问题。

## 前置依赖

- HARD：已读 `R-8 持久化`（知道 flushAppendOnlyFile 与 aof_buf）。

## 读者问题

1. `always` 策略为什么吞吐低？
2. `everysec` 策略为什么最多丢 1 秒数据？
3. `no-appendfsync-on-rewrite` 避免什么？

## 主结论

`flushAppendOnlyFile()`（`aof.c:1045`）在 `beforeSleep` 中把 `aof_buf` 写入文件。`always` 每条命令后 fsync（`aof_fsync`），`everysec` 后台 fsync，`no` 交给操作系统。`everysec` 的 `fsync` 在 bio 线程但在磁盘慢时可能阻塞主线程。

## 必须回填的源码锚点

- `src/aof.c:1045` `flushAppendOnlyFile()`
- `src/aof.c:1117` `aofWrite()`
- `src/server.h:1788` `aof_buf`
- `src/aof.c:905` `aof_background_fsync()`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
