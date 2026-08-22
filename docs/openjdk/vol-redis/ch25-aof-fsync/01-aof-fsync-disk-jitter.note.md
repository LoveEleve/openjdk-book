# vol-redis R-22 AOF fsync 与磁盘抖动 — note

## 本篇主张

- `flushAppendOnlyFile`（`aof.c:1045`）三种策略：always fsync 慢、everysec bio 异步 fsync 最多丢 1s、no 不主动 fsync。
- `always` 磁盘慢时直接阻塞主线程，`everysec` 的 `write()` 也可能阻塞。
- `no-appendfsync-on-rewrite` 避免 rewrite 期间 fsync 竞争。

## 本篇边界

- 不展开 `aof_buf` 的 SDS 增长细节。

## 下篇桥接

- R-23 过期 key 删除与阻塞。
