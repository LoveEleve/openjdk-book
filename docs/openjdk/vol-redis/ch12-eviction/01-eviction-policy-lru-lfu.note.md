# vol-redis R-28 内存淘汰策略 — note

## 本篇主张

- Redis 的 LRU 不是教科书版，而是 **采样 + 候选池** 的近似实现：`evictionPoolPopulate` 从 dict 随机采样 `maxmemory-samples`（默认 5）个 key，`EvictionPoolLRU` 池中选 `idle` 最大的淘汰。
- 8 种策略：`volatile-lru/lfu/ttl/random` + `allkeys-lru/lfu/random` + `noeviction`。
- LFU 的 8 位计数器对数增长（`LFULogIncr` 概率递增）+ 周期衰减（`LFUDecrAndReturn` 按分钟衰减）。
- 过期删除 vs 内存淘汰：前者 TTL 到了删，后者内存满了踢——目标不同、触发时机不同、作用对象不同。

## 本篇边界

- 不展开 `processCommand` 中 `performEvictions` 的调用时机（R-26 覆盖）。
- 不展开 `lfu-decay-time` 和 `lfu-log-factor` 的配置调优细节。

## 下篇桥接

- R-29 键空间与 SCAN 将展开 `redisDb` 结构、`lookupKeyRead/Write` 路径、KEYS 阻塞 vs SCAN 游标式遍历。
