# 篇：01 慢命令阻塞与 IO 多线程边界

- 域：`R-24 慢命令阻塞与 IO 多线程边界`
- 卷：`vol-redis`
- 目标：回答 KEYS/EVAL 为什么阻塞、IO 多线程为什么不能解决命令执行阻塞。

## 前置依赖

- HARD：已读 `R-2 事件驱动`（知道 IO 多线程的两阶段）。

## 读者问题

1. `KEYS` / `SMEMBERS` / `ZRANGE` 为什么阻塞？
2. `EVAL` 死循环时为什么只能 SHUTDOWN？
3. IO 多线程为什么不能解决慢命令阻塞？

## 主结论

`KEYS`（`db.c:864` `keysCommand`）用 `dictScan` 全表遍历，百万级 key 上阻塞数秒。`EVAL` 死循环不交出控制权，`lua-time-limit` 超时后只能 `SCRIPT KILL` 或 `SHUTDOWN NOSAVE`。IO 多线程只负责读写，命令执行仍由主线程串行，所以不解决慢命令的执行阻塞。

## 必须回填的源码锚点

- `src/db.c:864` `keysCommand()`
- `src/server.c:3184` `lookupCommandLogic()` 命令表
- `src/networking.c` `io_threads_op` 三态
- `src/config.c:3149` `io-threads` 默认 1

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
