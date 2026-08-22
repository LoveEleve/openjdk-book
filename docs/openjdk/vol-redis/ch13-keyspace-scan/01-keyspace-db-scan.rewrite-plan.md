# 篇：01 键空间：redisDb / kvstore / lookupKey / KEYS vs SCAN

- 域：`R-29 键空间与 SCAN 迭代器`
- 卷：`vol-redis`
- 目标：回答 key 存在哪里、lookupKey 的读取路径、KEYS 为什么阻塞而 SCAN 不阻塞。

## 前置依赖

- HARD：已读 `R-3 Dict`（dictScan 是 dict 的迭代器）、`R-26 命令执行`（lookupKey 在命令中的必经之路）。

## 读者问题

1. `redisDb` 结构包含哪些字段？keyspace 存在哪个字段？
2. `kvstore` 是什么？为什么 Redis 7.x 用它替代 dict 直接存键空间？
3. `lookupKeyRead` / `lookupKeyWrite` 的完整路径是什么？
4. KEYS 为什么阻塞而 SCAN 不阻塞？
5. SCAN 的游标（reverse binary iteration）怎么保证不遗漏、不保证不重复？

## 主结论

Redis 7.x 的键空间不是 `dict`，而是 **`kvstore`（多个 dict 的容器）**。`redisDb.keys` 和 `redisDb.expires` 都是 `kvstore`，`hexpires` 是过期哈希表。

`lookupKeyReadWithFlags`（`db.c:138`）是所有读命令的必经之路，内部调用 `expireIfNeeded` 做惰性删除。`lookupKeyWriteWithFlags`（`db.c:155`）是写命令的必经之路。

`KEYS`（`db.c:864` `keysCommand`）用 `dictScan` 全表遍历并返回所有匹配 key，在百万级 key 上阻塞主线程。`SCAN` 用同样的 `dictScan` 但每次返回一个游标，保证不遗漏、不保证不重复。

## 结构设计

1. 困惑开场：key 到底存在哪里
2. redisDb 结构：keys/expires/hexpires/blocking_keys/watched_keys
3. kvstore：多 dict 容器，cluster 槽位分片
4. lookupKeyRead/Write 路径 + expireIfNeeded 惰性删除
5. KEYS 命令：dictScan 全表遍历，阻塞
6. SCAN 游标：反向二进制迭代
7. 失败路径
8. 收网与下篇桥接 R-30 阻塞命令

## 必须回填的源码锚点

- `src/server.h:968`-`:980` `redisDb` 结构（keys/expires/hexpires/blocking_keys/ready_keys/watched_keys）
- `src/db.c:138` `lookupKeyReadWithFlags()`（读路径）
- `src/db.c:146` `lookupKeyRead()`（无标志读）
- `src/db.c:155` `lookupKeyWriteWithFlags()`（写路径）
- `src/db.c:35` `expireIfNeeded()`（惰性删除）
- `src/db.c:864` `keysCommand()`（KEYS 命令）
- `src/dict.c:1369` `dictScan()`（SCAN 游标迭代）
- `src/kvstore.h` `kvstore` 结构（多 dict 容器）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
