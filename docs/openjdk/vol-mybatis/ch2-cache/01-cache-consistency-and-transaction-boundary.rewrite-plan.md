# 篇：01 缓存与一致性边界

- 域：`M-5 缓存与一致性边界`
- 卷：`vol-mybatis`
- 目标：回答一级缓存、二级缓存、阻塞缓存和事务提交语义到底如何一起工作；避免把 MyBatis 缓存写成“性能优化小节”。

## 前置依赖

- HARD：已读 `M-3`、`M-4`，知道 `SqlSession` 生命周期与 Executor 执行链。

## 读者问题

为什么同样叫缓存，MyBatis 里会同时出现：

1. `BaseExecutor.localCache`
2. namespace 级 `Cache`
3. `CachingExecutor`
4. `TransactionalCacheManager`
5. `TransactionalCache`
6. `BlockingCache`
7. `CacheKey`

以及：

- 为什么二级缓存不是 query 完就立即可见，而要等 commit
- 为什么回滚时还要“释放未命中 key 的锁”
- 为什么 stored procedure 带 OUT 参数不能简单进缓存
- 为什么一级缓存和二级缓存不该混成“一个缓存的两层实现”

## 主结论

MyBatis 的缓存不是一个组件，而是两条不同责任线：

`SqlSession / BaseExecutor`
  -> 一级缓存 `localCache`
  -> 生命周期受当前会话和 `queryStack` 控制

`CachingExecutor`
  -> `TransactionalCacheManager`
    -> `TransactionalCache`
      -> namespace 级 `Cache` 实现（`Perpetual/LRU/FIFO/Blocking/...`）
  -> 真正可见性受 commit/rollback 控制

也就是说：

- 一级缓存是会话内部重复读与 deferred load 协议的一部分
- 二级缓存是 namespace 级共享视图，但必须经过事务缓冲层才能安全发布

## 结构设计

1. 困惑开场：为什么 MyBatis 缓存不是一个“打开就有的全局 Map”
2. 最小总图：一级缓存 vs 二级缓存 vs 事务缓冲层
3. 一级缓存：`BaseExecutor.localCache`、`queryStack`、`clearLocalCache()`
4. `CacheKey`：为什么缓存键必须编码 statement/rowBounds/sql/params/environment
5. `CachingExecutor`：二级缓存作为执行器装饰器进入主线
6. `TransactionalCacheManager` / `TransactionalCache`：为什么二级缓存要等 commit 才真正发布
7. `BlockingCache`：为什么未命中也要加锁、回滚也要释放锁
8. `Perpetual/LRU/FIFO/...`：Cache 装饰链表达的不是算法炫技，而是 namespace 级存储策略
9. 失败路径与禁区：OUT 参数、flushCacheRequired、rollback、duplicate cache 初始化失败
10. 收网：这篇立住的是“一致性边界”，不是性能小技巧
11. 下篇桥接：进入动态 SQL、参数绑定与插件拦截

## 必须回填的源码锚点

- `executor/BaseExecutor.java:58` `localCache`
- `executor/BaseExecutor.java:133` `query(...)`
- `executor/BaseExecutor.java:242` `commit(boolean required)`
- `executor/BaseExecutor.java:252` `rollback(boolean required)`
- `executor/BaseExecutor.java:331` `queryFromDatabase(...)`
- `executor/CachingExecutor.java:39` 类声明
- `executor/CachingExecutor.java:67` `query(...)`
- `executor/CachingExecutor.java:95` `commit(boolean required)`
- `executor/CachingExecutor.java:100` `rollback(boolean required)`
- `executor/CachingExecutor.java:121` `flushCacheIfRequired(...)`
- `cache/TransactionalCacheManager.java:31` `clear(...)`
- `cache/TransactionalCacheManager.java:43` `commit()`
- `cache/TransactionalCacheManager.java:49` `rollback()`
- `cache/decorators/TransactionalCache.java:42` `delegate`
- `cache/decorators/TransactionalCache.java:64` `getObject(...)`
- `cache/decorators/TransactionalCache.java:88` `clear()`
- `cache/decorators/TransactionalCache.java:94` `commit()`
- `cache/decorators/TransactionalCache.java:102` `rollback()`
- `cache/decorators/BlockingCache.java:67` `getObject(...)`
- `cache/decorators/BlockingCache.java:89` `acquireLock(...)`
- `cache/decorators/BlockingCache.java:112` `releaseLock(...)`
- `cache/CacheKey.java:74` `update(Object object)`
- `cache/CacheKey.java:92` `equals(Object object)`
- `cache/impl/PerpetualCache.java:31` `cache`
- `cache/decorators/LruCache.java:64` `putObject(...)`

## 必须引用的测试/证据

- `CachingSimpleExecutorTest` / `CachingReuseExecutorTest` / `CachingBatchExecutorTest`
- `BlockingCacheTest`：锁获取与 rollback 释放语义
- `CacheBuilderTest`：cache 初始化与失败路径
- `cursor_cache_oom`：说明缓存与大结果集边界不能混写

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。