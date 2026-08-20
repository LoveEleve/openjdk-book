# M-5 缓存与一致性边界 — review notes

## 事实审

- 已核对 `executor/BaseExecutor.java:58`、`executor/BaseExecutor.java:133`、`executor/BaseExecutor.java:242`、`executor/BaseExecutor.java:252`、`executor/BaseExecutor.java:331`，一级缓存、提交流程与 `queryFromDatabase()` 位置成立。
- 已核对 `executor/CachingExecutor.java:39`、`executor/CachingExecutor.java:67`、`executor/CachingExecutor.java:95`、`executor/CachingExecutor.java:100`、`executor/CachingExecutor.java:121`，二级缓存装饰与 commit/rollback 语义成立。
- 已核对 `cache/decorators/TransactionalCache.java:42`、`cache/decorators/TransactionalCache.java:64`、`cache/decorators/TransactionalCache.java:88`、`cache/decorators/TransactionalCache.java:94`、`cache/decorators/TransactionalCache.java:102`，事务缓冲层主线成立。
- 已核对 `cache/decorators/BlockingCache.java:67`、`cache/decorators/BlockingCache.java:89`、`cache/decorators/BlockingCache.java:112`，阻塞缓存加锁与释放路径成立。
- 已核对 `cache/CacheKey.java:74`、`cache/CacheKey.java:92`、`cache/impl/PerpetualCache.java:31`、`cache/decorators/LruCache.java:64`，缓存键与基础存储体位置成立。
- 已补测试证据：`CachingSimpleExecutorTest` / `CachingReuseExecutorTest` / `CachingBatchExecutorTest`、`BlockingCacheTest`、`CacheBuilderTest`、`cursor_cache_oom` 都对应本篇的缓存一致性与边界语义。

## 因果审

- 一级缓存服务于当前会话与 deferred load，二级缓存服务于共享结果，这个分层在源码上成立。
- `TransactionalCache` 把 query 后结果延迟到 commit 再发布，rollback 只释放锁不发布结果，正文成立。
- `BlockingCache` 的锁协议与 `TransactionalCache.unlockMissedEntries()` 形成闭环，正文成立。
- callable statement OUT 参数禁止进入缓存的约束，由 `CachingExecutor` 直接编码，正文成立。

## 结构审

- 从“缓存不是 Map”切入，再落到一级缓存、CacheKey、二级缓存装饰、事务缓冲、阻塞缓存和禁区，主线集中。
- 没有把 LRU/FIFO/Soft/Weak 这些实现细节写成主线，符合方法论。

## 读者审

- 读完应能回答：为什么 query 完并不等于结果立刻可被别的会话看见。
- 读完应能回答：为什么 rollback 也要显式释放缓存 miss 锁。
- 读完后能自然接到动态 SQL / 插件专题，而不会把缓存和 SQL 生成混在一起。

## 边界审

- 本篇没有把动态 SQL、类型系统、Spring 缓存桥提前透支。
- `cursor_cache_oom` 只作为生产层边界证据，不在本篇展开为 Cursor 专题，边界成立。

## 依赖审

- 前置依赖：M-3 生命周期、M-4 执行链。
- 后续桥接：M-6 动态 SQL 与插件、生产层缓存一致性排障都成立。

## 结论

M-5 已完成单域四件套的事实回填与六层审查，可进入下一个补深域。