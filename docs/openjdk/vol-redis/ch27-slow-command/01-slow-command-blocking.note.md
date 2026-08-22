# vol-redis R-24 慢命令阻塞与 IO 多线程边界 — note

## 本篇主张

- KEYS（`db.c:864` `keysCommand` → `dictScan`）全表遍历阻塞主线程。
- SMEMBERS/ZRANGE 大集合结果集构造耗时。
- EVAL 死循环 + `SCRIPT_WRITE_DIRTY` 只能 `SHUTDOWN NOSAVE`。
- IO 多线程（`io-threads` 默认 1）只负责读写，不解决命令执行瓶颈。

## 本篇边界

- 不展开 `dictScan` 的二进制迭代算法。

## 下篇桥接

- R-16 事务（MULTI/EXEC/WATCH）。
