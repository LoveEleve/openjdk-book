# vol-redis R-28 内存淘汰策略 — review notes

## 事实审

- 已核对 `src/server.h:562`-`:569`（8 种淘汰策略宏），正文成立。
- 已核对 `src/evict.c:35`-`:40`（`evictionPoolEntry`：idle/key/cached/dbid），正文成立。
- 已核对 `src/evict.c:43`（`EvictionPoolLRU` 静态池），正文成立。
- 已核对 `src/evict.c:125`（`evictionPoolPopulate()` 采样填充池），正文成立。
- 已核对 `src/evict.c:520`（`performEvictions()` 主入口），正文成立。
- 已核对 `src/evict.c:152`-`:162`（LRU/LFU 分支，`LFUDecrAndReturn` 调用），正文成立。
- 已核对 `src/evict.c:281`（`LFULogIncr()` 对数递增实现），正文成立。
- 已核对 `src/evict.c:249`-`:259`（LFU 衰减注释），正文成立。
- 已核对 `src/config.c:3163`（`maxmemory-samples` 默认 5），正文成立。
- 已核对 `src/server.h:556`-`:560`（`MAXMEMORY_FLAG_LRU/LFU/ALLKEYS`），正文成立。

## 因果审

- 近似 LRU 用采样 + 候选池替代全局链表，避免高并发锁竞争，正文成立。
- LFU 8 位计数器对数增长 + 概率递增，少量访问快速升频，正文成立。
- `LFUDecrAndReturn` 按分钟衰减，长时间不访问自动降频，正文成立。
- 过期删除 vs 内存淘汰的区别（目标/时机/对象），正文成立。

## 结构审

- 从"为什么不用教科书 LRU"困惑开场，再落到 8 种策略、近似 LRU、LFU 对数计数、周期衰减、过期 vs 淘汰，主线集中。

## 读者审

- 读完应能回答：为什么是近似 LRU 而不是教科书 LRU。
- 读完应能回答：LFU 的 8 位计数器怎么实现对数增长。
- 读完应能回答：过期删除 vs 内存淘汰的区别。
- 读完后能自然进入 R-29 键空间。

## 边界审

- 本篇没有展开 `processCommand` 中淘汰的调用时机（R-26 覆盖）。
- R-29 键空间未提前透支，边界成立。

## 依赖审

- 前置依赖：R-1 redisObject（HARD，知道 lru:24bit 的双重身份）。
- 后续桥接：R-29 键空间与 SCAN。

## 结论

R-28 已完成四件套的事实回填与六层审查，可进入 R-29 键空间与 SCAN。
