# 篇：01 Spring Cache 集成：@Cacheable 的 Redisson 实现

- 域：`R-6 Spring Cache 集成`
- 卷：`vol-redisson`
- 目标：回答 RedissonSpringCacheManager 怎么替代默认的 ConcurrentMapCacheManager。

## 前置依赖

- HARD：已读 `R-5 RMap`（知道 RedissonMap 的存储结构）。

## 读者问题

1. `RedissonSpringCacheManager` 怎么实现 `CacheManager` 接口？
2. `RedissonCache` 怎么包装 RMap 实现 `@Cacheable`？
3. TTL 和 maxIdleTime 怎么配置？

## 主结论

`RedissonSpringCacheManager`（305 行，`redisson-spring-cache` 模块）实现 `CacheManager` 接口，替代 Spring 默认的 `ConcurrentMapCacheManager`。`RedissonCache`（353 行）包装 RMap 实现 `Cache` 接口，支持 TTL 和 maxIdleTime。

## 必须回填的源码锚点

- `redisson-spring-cache/.../RedissonSpringCacheManager.java` 305 行
- `redisson-spring-cache/.../RedissonCache.java` 353 行

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE