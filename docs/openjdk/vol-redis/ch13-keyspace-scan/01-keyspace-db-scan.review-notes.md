# vol-redis R-29 键空间与 SCAN — review notes

## 事实审

- 已核对 `src/server.h:968`-`:980`（`redisDb`：keys/expires/hexpires/blocking_keys/ready_keys/watched_keys，keys 和 expires 是 `kvstore`），正文成立。
- 已核对 `src/db.c:138`（`lookupKeyReadWithFlags()` 读路径），正文成立。
- 已核对 `src/db.c:146`（`lookupKeyRead()`），正文成立。
- 已核对 `src/db.c:155`（`lookupKeyWriteWithFlags()` 写路径），正文成立。
- 已核对 `src/db.c:35`（`expireIfNeeded()` 惰性删除），正文成立。
- 已核对 `src/db.c:864`（`keysCommand()` KEYS 命令），正文成立。
- 已核对 `src/dict.c:1369`（`dictScan()` 游标迭代），正文成立。
- 已核对 kvstore 作为多 dict 容器的存在（`redisDb.keys` 类型），正文成立。

## 因果审

- 键空间从 dict 变为 kvstore 是为了 cluster 槽位分片和独立 rehash，正文成立。
- `lookupKeyRead/Write` 是命令必经之路，`expireIfNeeded` 做惰性删除，正文成立。
- KEYS 用 dictScan 全表遍历阻塞主线程，正文成立。
- SCAN 反向二进制迭代游标分批遍历，不遗漏但不保证不重复，正文成立。

## 结构审

- 从"key 存在哪里"困惑开场，再落到 redisDb 结构、kvstore、lookupKey 路径、KEYS/SCAN 差异，主线集中。

## 读者审

- 读完应能回答：为什么 Redis 7.x 键空间不是单 dict。
- 读完应能回答：lookupKeyRead/Write 的完整路径。
- 读完应能回答：KEYS 阻塞而 SCAN 不阻塞的原因。
- 读完后能自然进入 R-30 阻塞命令。

## 边界审

- 本篇没有展开 dictScan 的二进制迭代算法细节。
- R-30 阻塞命令未提前透支，边界成立。

## 依赖审

- 前置依赖：R-3 Dict（HARD）、R-26 命令执行（HARD）。
- 后续桥接：R-30 阻塞命令。

## 结论

R-29 已完成四件套的事实回填与六层审查，可进入 R-30 阻塞命令。
