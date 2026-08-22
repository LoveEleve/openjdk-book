# vol-redis R-19 RDB 阻塞与 fork 陷阱 — note

## 本篇主张

- `SAVE`（`rdb.c:1593`）在主线程 `rdbSaveRio` 序列化全部数据，全程阻塞。
- `BGSAVE`（`rdb.c:1636`）fork 子进程，但 fork 本身在主线程复制页表，实例越大越慢。
- COW 让峰值内存可能翻倍。

## 本篇边界

- 不展开 RDB 文件格式细节。

## 下篇桥接

- R-20 大 key 删除与 lazyfree。
