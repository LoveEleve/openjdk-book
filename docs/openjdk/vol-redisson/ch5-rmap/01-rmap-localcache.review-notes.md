# vol-redisson R-5 RMap 分布式映射 — review notes

## 事实审
- `RedissonMap.java:68` class RedissonMap extends RedissonExpirable implements RMap ✅
- `api/RMap.java` 接口 ✅
- `RedissonMap.java:294` computeIfAbsentAsync ✅（RLock + get + supplyAsync + putIfAbsent，非 Lua 脚本）
- `RedissonMap.java:236` computeAsync ✅

## 因果审
- RMap 通过 Redis Hash 存储 ✅
- computeIfAbsentAsync 是 RLock + get + supplyAsync + putIfAbsent 的客户端组合（非 Lua 原子）✅
- LocalCachedMap Write 操作 invalidate 本地缓存 ✅
- MapWriter/MapLoader 回写数据库 ✅

## 结构审
- 接口/本地缓存/回写/过期，主线集中 ✅

## 读者审
- 读完能回答：RMap 的 computeIfAbsent 怎么保证并发安全 ✅

## 依赖审
- 前置 R-3，后续 R-6 ✅

## 结论
R-5 通过六层审查（修正 computeIfAbsent 描述：非 Lua 脚本，是 RLock + get + compute + putIfAbsent 组合）。
ENDOFFILE