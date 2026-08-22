# RedissonSpringCacheManager 为什么不是把 @Cacheable 缓存到本地内存

> 本文基于 Redisson main 分支（latest）当前源码。本文只讲 `redisson-spring-cache` 模块：`RedissonSpringCacheManager` 怎么实现 Spring 的 `CacheManager`、`RedissonCache` 怎么包装 RMap。不展开 RMap 本身（R-5）和 Codec（R-3）。

## 为什么"Spring Cache 就是内存缓存"这个理解，会把 Redisson 集成读浅

第一次用 Spring `@Cacheable` 的人，默认认知是缓存就存在应用本地内存里（`ConcurrentMapCacheManager`）。看到 Redisson 集成时，觉得无非是把缓存换个存储位置。

但 Redisson 集成不是"换了存储位置的 Map"，而是把 Spring 的缓存抽象（`CacheManager` / `Cache`）绑定到 RMap——这带来两个关键差异：

- 缓存是**跨节点共享**的：多个应用实例命中同一个 Redis 缓存，而不是各自一份
- 缓存支持 **TTL / maxIdleTime**，Spring 本地缓存没有这个概念

也就是说，RedissonSpringCacheManager 解决的不仅"缓存存哪"，而是"**多节点共享 + 存活策略**"。

## 一、Spring 的缓存抽象：CacheManager / Cache

Spring Cache 的核心是两个接口：

- `CacheManager.getCache(name)`：按名字取缓存
- `Cache.get(key)` / `Cache.put(key, value)`：读写单个缓存项

`@Cacheable("users")` 注解解析后，Spring 通过 `CacheManager` 拿到名为 `users` 的 `Cache`，再 `get` / `put`。

## 二、RedissonSpringCacheManager：实现 CacheManager

`redisson-spring-cache/.../RedissonSpringCacheManager.java`（305 行）实现 `CacheManager`：

```java
public class RedissonSpringCacheManager implements CacheManager {
    private final RedissonClient redisson;
    private final Map<String, CacheConfig> configMap;
    // ...
}
```

- 构造函数接收 `RedissonClient`
- `getCache(name)` 创建/返回一个 `RedissonCache`，RMap 名字即缓存名
- `configMap` 里每个 `CacheConfig` 定义 TTL / maxIdleTime

这样配置：

```java
@Bean
public CacheManager cacheManager(RedissonClient redissonClient) {
    Map<String, CacheConfig> config = new HashMap<>();
    config.put("users", new CacheConfig(24*60*1000, 12*60*1000));
    return new RedissonSpringCacheManager(redissonClient, config);
}
```

`users` 缓存 TTL 24 小时，空闲 12 小时过期。

## 三、RedissonCache：包装 RMap 实现 Cache

`redisson-spring-cache/.../RedissonCache.java`（353 行）实现 Spring 的 `Cache`：

```java
public class RedissonCache implements Cache {
    private final RMapCache<Object, Object> map;
    // ...
}
```

- `get(key)` → `map.get(key)`（未命中返回 null 或包装的 Optional）
- `put(key, value)` → `map.put(key, value, ttl, TimeUnit.MILLISECONDS)`
- 内部是 `RMapCache`（支持单 entry TTL），缓存项自动过期

## 四、失败路径

- **Codec 不匹配**：缓存值用什么 Codec 写入，读出必须一致，否则反序列化失败
- **TTL 与业务不符**：TTL 太短缓存频繁失效，太长数据陈旧
- **多实例缓存一致性**：无 NearCache 时多实例命中同一个 Redis 缓存，天然一致；开启 NearCache 后需要 invalidate 机制

## 收网

`RedissonSpringCacheManager` 实现 `CacheManager`，`RedissonCache` 用 `RMapCache` 实现 `Cache`。缓存跨节点共享，支持 TTL / maxIdleTime。`@Cacheable("users")` 解析后走 RMapCache 读写，天然分布式。

## 下篇桥接

R-7 基础数据结构（RBucket / RAtomicLong / RSemaphore）。
ENDOFFILE