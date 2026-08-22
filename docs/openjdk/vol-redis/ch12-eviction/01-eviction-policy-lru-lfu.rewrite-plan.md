# 篇：01 内存淘汰策略：8 种策略、近似 LRU、LFU 对数计数与衰减

- 域：`R-28 内存淘汰策略`
- 卷：`vol-redis`
- 目标：回答 Redis 的 8 种淘汰策略、近似 LRU 的采样池实现、LFU 的对数计数与衰减机制。

## 前置依赖

- HARD：已读 `R-1 redisObject`（`lru:24bit` 的双重身份）、`R-23 过期删除`（与淘汰的反差）。

## 读者问题

1. Redis 有哪 8 种淘汰策略？`volatile-*` 和 `allkeys-*` 有什么区别？
2. 为什么是"近似 LRU"而不是教科书 LRU？采样池怎么实现？
3. LFU 的 8 位计数器怎么设计？怎么实现对数增长和衰减？
4. 过期删除 vs 内存淘汰到底有什么区别？（面试易混淆）
5. `maxmemory-samples`（默认 5）怎么影响淘汰准确性？

## 主结论

Redis 的内存淘汰不是"教科书 LRU"，而是 **采样 + 候选池** 的近似实现：每次从 dict 随机采样 `maxmemory-samples`（默认 5）个 key，把最久未访问（LRU，`evictionPoolEntry.idle`）或访问最少（LFU，频率衰减）的候选放入固定大小的 `EvictionPoolLRU` 池，淘汰池中最该淘汰的 key。

LFU 的计数器用 **8 位 log 计数 + 概率递增 + 周期衰减**，让少量热点访问快速升频、长时间不访问缓慢降频。

`过`期删除（expire）是"TTL 到了删 key"，`淘汰`（evict）是"内存满了踢 key"——两者目标不同、触发时机不同、作用对象不同。

## 结构设计

1. 困惑开场：为什么不能直接用教科书 LRU
2. 8 种策略与 volatile/allkeys 分类
3. `maxmemory-samples` 与近似采样
4. `EvictionPoolLRU` 候选池 + `evictionPoolPopulate`
5. `performEvictions()` 主入口
6. LFU：`LFULogIncr` 对数计数 + `LFUDecrAndReturn` 周期衰减
7. 过期删除 vs 内存淘汰（易混淆对）
8. 失败路径
9. 收网与下篇桥接 R-29 键空间

## 必须回填的源码锚点

- `src/server.h:562`-`:569` 8 种策略宏
- `src/evict.c:35`-`:40` `evictionPoolEntry` 结构（idle/key/cached/dbid）
- `src/evict.c:43` `EvictionPoolLRU` 静态池
- `src/evict.c:125` `evictionPoolPopulate()`（采样填充池）
- `src/evict.c:567` `performEvictions()`（主入口）
- `src/evict.c:152`-`:162` LRU/LFU 分支（`LFUDecrAndReturn`）
- `src/evict.c:281` `LFULogIncr()`（对数递增）
- `src/evict.c:249`-`:259` LFU 衰减注释
- `src/config.c:3163` `maxmemory-samples` 默认 5
- `src/config.c` `maxmemory` / `maxmemory-policy`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
