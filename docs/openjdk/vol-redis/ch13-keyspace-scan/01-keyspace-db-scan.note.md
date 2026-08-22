# vol-redis R-29 键空间与 SCAN — note

## 本篇主张

- Redis 7.x 键空间是 `kvstore`（多 dict 容器，按 cluster slot 分片），不是单 dict。
- `redisDb.keys` / `.expires` 是 `kvstore`，`hexpires` 是 `ebuckets` 过期哈希表。
- `lookupKeyReadWithFlags`（db.c:138）/ `lookupKeyWriteWithFlags`（db.c:155）是所有命令的必经之路，内部调 `expireIfNeeded` 做惰性删除。
- KEYS 用 `dictScan` 全表遍历阻塞主线程；SCAN 用反向二进制迭代游标分批遍历，不遗漏但不保证不重复。

## 本篇边界

- 不展开 dictScan 的二进制迭代算法细节。
- 不展开 ebuckets 过期哈希表的内部结构。

## 下篇桥接

- R-30 阻塞命令将展开 BLPOP/BRPOP 的 `blockForKeys` / `signalKeyAsReady` 实现。
