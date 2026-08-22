# 篇：01 RMap 分布式映射：本地缓存、MapWriter/MapLoader 与过期策略

- 域：`R-5 RMap 分布式映射`
- 卷：`vol-redisson`
- 目标：回答 RedissonMap 怎么实现本地缓存、MapWriter 回写数据库和 TTL 过期。

## 前置依赖

- HARD：已读 `R-3 Codec`（知道 Codec 序列化）。

## 读者问题

1. RMap 的 `put` / `get` 怎么跨节点同步？
2. `LocalCachedMapOptions` 的 NearCache 怎么工作？
3. `MapWriter` / `MapLoader` 怎么同步回写数据库？
4. `EvictionScheduler` 怎么清理过期 entries？

## 主结论

`RedissonMap`（1967 行）实现 `RMap` 接口（`api/RMap.java`），通过 Redis 的 Hash 数据结构存储。`LocalCachedMapOptions` 支持 NearCache（本地 `ConcurrentHashMap` 缓存 + 写操作 invalidate），`MapWriter`/`MapLoader` 回写数据库，`EvictionScheduler` 定期清理过期 entries。

## 必须回填的源码锚点

- `org.redisson/RedissonMap.java:68` 类声明
- `org.redisson/RedissonMap.java:236` `computeAsync`（操作入口之一）
- `org.redisson/api/RMap.java` 接口
- `org.redisson/eviction/EvictionScheduler.java` 过期调度

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE