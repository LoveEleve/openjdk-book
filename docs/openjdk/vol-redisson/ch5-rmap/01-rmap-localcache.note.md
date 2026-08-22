# vol-redisson R-5 RMap 分布式映射 — note

## 本篇主张

- `RedissonMap`（1967 行，`RedissonMap.java:68`）通过 Redis Hash 实现 `RMap` 接口，`computeAsync` 等复合操作用 Lua 脚本原子执行。
- `LocalCachedMapOptions` 支持 NearCache：本地 `ConcurrentHashMap` + 写操作 invalidate → 减少 Redis 读压力。
- `MapWriter` / `MapLoader` 回写数据库，`EvictionScheduler` 清理过期 entries。

## 下篇桥接

- R-6 Spring Cache 集成。
ENDOFFILE