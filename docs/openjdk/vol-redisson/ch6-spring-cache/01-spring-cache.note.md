# vol-redisson R-6 Spring Cache 集成 — note

## 本篇主张

- `RedissonSpringCacheManager`（305 行，`redisson-spring-cache` 模块）实现 `CacheManager` 接口，替代 Spring 默认的 `ConcurrentMapCacheManager`。
- `RedissonCache`（353 行）包装 RMap 实现 `Cache` 接口，TTL 和 maxIdleTime 在 `CacheConfig` 中设置。
- 默认使用 `JsonJacksonCodec` 序列化。

## 下篇桥接

- R-7 基础数据结构（RBucket/RAtomicLong/RSemaphore）。
ENDOFFILE