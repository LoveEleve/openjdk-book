# AOF fsync 为什么慢、为什么丢数据

> 本文基于 Redis 7.4.2 当前源码。排障层第四篇，回答 AOF fsync 的阻塞与数据丢失问题。

## 一、flushAppendOnlyFile 三种策略

`flushAppendOnlyFile()`（`aof.c:1045`）在 `beforeSleep` 中把 `aof_buf` 写入文件：

- **always**：`aofWrite` 后调 `redis_fsync`，每条命令都 fsync，最安全但最慢
- **everysec**（默认）：`aofWrite` 后把 fsync 交给 `aof_background_fsync()`（`aof.c:905`），由 bio 线程异步执行，最多丢 1 秒数据
- **no**：不主动 fsync，由操作系统刷盘，可能丢多秒数据

## 二、阻塞场景

`always` 策略下，`redis_fsync` 在磁盘慢时（如 HDD 或 IO 竞争）直接阻塞主线程。`everysec` 策略下，`aof_background_fsync` 在 bio 线程执行，但 `aofWrite` 的 `write()` 在磁盘慢时也可能阻塞。

## 三、no-appendfsync-on-rewrite

`no-appendfsync-on-rewrite` 配置默认 `no`。开启后，AOF rewrite 期间不 fsync，避免 fsync 与 rewrite 竞争磁盘 IO。

## 四、失败路径

- `always` 策略下磁盘慢 → 主线程阻塞 → 吞吐骤降
- `everysec` 策略下 fsync 延迟 → 最多丢 1 秒数据
- `aof_buf` 未落盘时宕机 → 丢失 aof_buf 中尚未写入的增量

## 收网

`flushAppendOnlyFile` 三种策略的 fsync 行为决定吞吐与安全性的取舍。`everysec` 是默认且推荐的平衡策略。

## 下篇桥接

R-23 过期 key 删除与阻塞。
