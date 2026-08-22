# KEYS / EVAL 为什么阻塞，IO 多线程为什么解决不了

> 本文基于 Redis 7.4.2 当前源码。排障层第六篇，回答慢命令阻塞的根因。

## 一、KEYS 阻塞

`keysCommand()`（`db.c:864`）用 `dictScan`（`dict.c:1369`）遍历整个键空间，对所有 key 做模式匹配。百万级 key 上需要遍历所有 dict 桶，耗时数十毫秒到数秒，期间主线程无法处理其他命令。**生产禁用 `KEYS`，用 `SCAN` 分批遍历**。

## 二、SMEMBERS / ZRANGE 大集合阻塞

`SMEMBERS` 返回 Set 的所有成员，`ZRANGE` 返回 ZSet 范围。如果集合百万级，结果集构造和发送都耗时。用 `SSCAN` / `ZRANGEBYSCORE` 分批。

## 三、EVAL 死循环

`EVAL` 中的死循环不交出控制权（单线程）。`lua-time-limit`（默认 5s）超时后 Redis 开始响应 `SCRIPT KILL`，但如果脚本已写数据（`SCRIPT_WRITE_DIRTY`），`SCRIPT KILL` 被拒绝，只能 `SHUTDOWN NOSAVE`。

## 四、IO 多线程为什么解决不了

IO 多线程（`io-threads`，默认 1）只负责网络读写，命令执行仍由主线程串行。慢命令的 CPU 执行时间在主线程，IO 线程不能分担。所以 IO 多线程解决的是"网络 IO 瓶颈"，不是"命令执行瓶颈"。

## 五、收网

慢命令（KEYS/SMEMBERS/ZRANGE/EVAL）的执行时间在主线程，IO 多线程分担不了。生产避免全量遍历命令，脚本用 `SCRIPT KILL`/限时，或用 `SCAN` 系列分批。

## 下篇桥接

R-16 事务（MULTI/EXEC/WATCH）与 R-17/18。
