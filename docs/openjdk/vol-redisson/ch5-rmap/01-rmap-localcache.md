# RMap 为什么不是简单的"Java Map 存 Redis"——本地缓存与回写数据库

> 本文基于 Redisson main 分支（latest）当前源码。本文只讲 `RedissonMap` 的分布式映射实现：通过 Redis Hash 存储、`LocalCachedMapOptions` 的 NearCache 本地缓存、`MapWriter`/`MapLoader` 回写数据库。不展开 Codec（R-3）和 Spring Cache（R-6）。

## 为什么"RMap 就是 Java 的 map 存进 Redis"这个理解，会把分布式映射读浅

第一次用 Redisson 的 RMap，很容易觉得它就是"Java 的 Map，底层存 Redis 的 Hash，put/get 而已"。

但如果真去看 `RedissonMap.java`（1967 行），会发现它远不止 put/get：

- `computeAsync` / `computeIfAbsentAsync` 用 Lua 脚本在 Redis 端原子执行复合操作
- `LocalCachedMapOptions` 支持 NearCache——本地内存缓存读压力，写操作 invalidate
- `MapWriter` / `MapLoader` 可以把 Redis 当缓存、数据库当数据源
- `EvictionScheduler` 定期清理过期 entries

也就是说，RMap 的复杂度不在"HashMap 存 Hash"，而在 **"跨节点的缓存一致性 + 数据源回写 + TTL 过期"**。

## 一、RedissonMap 的底层：Redis Hash

`RedissonMap.java:68`：

```java
public class RedissonMap<K, V> extends RedissonExpirable implements RMap<K, V> {
```

每个 RMap 对应一个 Redis Hash key。`put(k, v)` → `HSET key k v`，`get(k)` → `HGET key k`。跨节点共享一份数据，天然分布式。

### computeIfAbsentAsync 不是"Lua 脚本"，而是 RLock + get + putIfAbsent 的组合

`computeIfAbsentAsync`（`RedissonMap.java:294`）据源码，不是一次 Lua 脚本原子执行，而是四步组合：

```java
RLock lock = getLock(key);
CompletionStage<V> f = lock.lockAsync(threadId)
        .thenCompose(r -> getAsync(key, threadId))
        .thenCompose(oldValue -> {
            if (oldValue != null) return completedFuture(oldValue);   // 已存在直接返回
            return CompletableFuture.supplyAsync(() -> mappingFunction.apply(key), // 构造新值
                    getServiceManager().getExecutor())
                .thenCompose(newValue -> putIfAbsentAsync(key, newValue));
        })
        .whenComplete((c, e) -> lock.unlockAsync(threadId));  // 显式解锁
```

关键点：

1. **用 RLock 保证并发安全**：`getLock(key)` 拿一把分布式锁，`lockAsync` 加锁，多个客户端同时 `computeIfAbsent` 同一个 key 时只有一个能进入 construct。
2. **`mappingFunction.apply(key)` 在 `getServiceManager().getExecutor()` 上执行**：构造函数不在 IO 线程跑，避免阻塞连接。
3. **`putIfAbsentAsync` 二次校验**：因为锁释放后另一个线程可能已放入，`putIfAbsent` 保证"不存在才放入"。
4. **`whenComplete` 显式 `lock.unlockAsync`**：无论成功失败都释放锁。

这正是 RMap `compute` 系列与 RLock 的衔接——R-2 讲的锁在这里被 RMap 用作并发控制原语。注意：**是"分布式锁 + get + compute + putIfAbsent"的客户端组合，不是 Redis 端的 Lua 原子操作**——这与 RLock 的 `tryLockInnerAsync`（真 Lua 脚本）不同。

## 二、LocalCachedMapOptions：NearCache 本地缓存

`LocalCachedMapOptions` 启用 NearCache 后，RMap 的读变成本地优先：

1. `get(k)` 先查本地 `ConcurrentHashMap`（`LocalCachedMapCacheObj`）
2. 未命中再查 Redis，命中后把结果存本地
3. 写操作（put/remove）通过 Pub/Sub 广播 invalidate，其他实例的本地缓存失效

收益：热点 key 的读不再打 Redis，读压力大幅下降。
代价：缓存一致性——写入后到 invalidate 生效之间，其他实例可能读到旧值。

## 三、MapWriter / MapLoader：Redis 当缓存，数据库当数据源

`MapLoader` 和 `MapWriter` 是 Redisson 把 RMap 变成"缓存 + 数据库双写"的两个接口：

- `MapLoader.load(key)`：本地缓存未命中且 Redis 未命中时，**从数据库加载**
- `MapWriter.write(key, value)`：RMap 写入时**同步/异步回写数据库**
- `MapWriter.writeAll(map)`：批量回写

这是 Read/Write-Through 模式：Redis 是热缓存，数据库是真实数据源。

## 四、过期策略与 EvictionScheduler

`RMapCache`（RMap 的 TTL 变体）支持单 entry 过期。实现上用一个 ZSet 记录每个 entry 的过期时间戳，`EvictionScheduler` 定期扫描 ZSet，把过期的 entry 从 Hash 中删除。

## 五、失败路径

- **computeIfAbsent 的锁窗口**：`mappingFunction` 执行期间锁未释放，其他线程阻塞等待；若 mappingFunction 抛异常，`whenComplete` 仍会解锁但构造失败
- **NearCache 一致性窗口**：写后 invalidate 之前，其他实例读到旧值
- **MapLoader 时序**：load 和 put 并发时可能读到过期数据或双写冲突
- **EvictionScheduler 周期**：过期清理是周期的，不是实时的，过期到清理之间 entry 仍可读

## 收网

RMap 通过 Redis Hash 实现分布式映射，`compute` 系列用 **RLock + get + compute + putIfAbsent** 的客户端组合保证并发正确（非 Lua 原子）。`LocalCachedMapOptions` 提供 NearCache（本地缓存 + invalidate），`MapWriter`/`MapLoader` 支持 Read/Write-Through，`RMapCache` 的 EvictionScheduler 管理单 entry 过期。

## 下篇桥接

R-6 Spring Cache 集成。
ENDOFFILE