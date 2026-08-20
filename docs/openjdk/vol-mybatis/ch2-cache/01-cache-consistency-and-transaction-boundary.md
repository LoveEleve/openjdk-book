# 为什么 MyBatis 的缓存不是“查过一次就放进 Map”

> 本文基于 MyBatis 3.5.16 当前源码。本文只讲缓存与一致性边界：一级缓存、二级缓存、`CachingExecutor`、`TransactionalCacheManager`、`TransactionalCache`、`BlockingCache` 与 `CacheKey` 如何协同工作。不展开动态 SQL、类型系统与 Spring 集成。

## 为什么“一级缓存 + 二级缓存”这个说法太平了

很多人介绍 MyBatis 缓存时，都会用一句非常顺手的话：

- 一级缓存是 `SqlSession` 级
- 二级缓存是 namespace 级

这句话并不假，但它最大的问题是：太平了。

因为它会让人误以为：

- 一级缓存和二级缓存只是作用域不同的两个 Map

可一旦你真正看源码，就会发现完全不是这样：

- 一级缓存长在 `BaseExecutor` 里，和 `queryStack`、`DeferredLoad`、`clearLocalCache()` 绑定在一起
- 二级缓存不是 query 后立刻写入，而是先进 `TransactionalCache` 缓冲，等 commit 才真正发布
- `BlockingCache` 连“缓存未命中”都要上锁，而且 rollback 时还要显式释放锁
- callable statement 带 OUT 参数时，`CachingExecutor` 会直接拒绝使用缓存

也就是说，MyBatis 的缓存从来不是“存一下结果”这么简单，而是在编码：

**结果什么时候可以复用、什么时候必须失效、什么时候还不能对别的会话可见。**

## 缓存体系的最小总图

```text
当前 SqlSession
  -> BaseExecutor.localCache
    -> queryStack / DeferredLoad / clearLocalCache

namespace 级共享缓存
  -> CachingExecutor
    -> TransactionalCacheManager
      -> TransactionalCache
        -> Cache 实现（Perpetual/LRU/FIFO/Blocking/...）
```

这张图最重要的不是“有几层”，而是两条责任线：

1. 当前会话内部如何复用结果
2. 会话之外何时才能安全看见共享缓存结果

## 一、一级缓存：`BaseExecutor.localCache` 根本不是一个孤立缓存组件

一级缓存的入口其实已经在执行主线里出现过：

- `executor/BaseExecutor.java:58` `localCache`
- `executor/BaseExecutor.java:133` `query(...)`
- `executor/BaseExecutor.java:242` `commit(boolean required)`
- `executor/BaseExecutor.java:252` `rollback(boolean required)`
- `executor/BaseExecutor.java:331` `queryFromDatabase(...)`

`BaseExecutor.query(...)` 的关键逻辑是：

1. 如果 `queryStack == 0 && ms.isFlushCacheRequired()`，先清本地缓存
2. 如果没有 `ResultHandler`，先拿 `localCache.getObject(key)`
3. 命中则直接返回
4. 未命中则进 `queryFromDatabase(...)`
5. 最外层查询返回后再统一处理 `DeferredLoad`
6. 如果 `LocalCacheScope == STATEMENT`，最后再清掉一级缓存

这说明一级缓存本质上是：

- 当前会话的重复读缓存
- deferred load 的临时依赖仓
- query 嵌套深度控制的一部分

所以它不是一个可独立拔插的缓存插件，而是执行器运行协议的一部分。

## 二、`CacheKey`：缓存不是“SQL 一样就命中”，而是执行语义一样才命中

真正决定缓存是否相同的是：

- `cache/CacheKey.java:74` `update(Object object)`
- `cache/CacheKey.java:92` `equals(Object object)`

再结合 `BaseExecutor.createCacheKey(...)`，一个查询键至少会编码：

- `MappedStatement` id
- `RowBounds` offset / limit
- `BoundSql.getSql()`
- 参数值
- environment id

这意味着两个查询即使来自同一个 mapper 方法，只要：

- 分页不同
- 参数不同
- SQL 动态展开后不同
- 环境不同

就不会命中同一个缓存键。

所以 MyBatis 的缓存判断不是“方法名一样”，而是：

**真正的执行语义是否等价。**

## 三、`CachingExecutor`：二级缓存不是独立组件，而是执行器装饰器

二级缓存主入口在：

- `executor/CachingExecutor.java:39` 类声明
- `executor/CachingExecutor.java:67` `query(...)`
- `executor/CachingExecutor.java:95` `commit(boolean required)`
- `executor/CachingExecutor.java:100` `rollback(boolean required)`
- `executor/CachingExecutor.java:121` `flushCacheIfRequired(...)`

它包在真正 executor 外面，而不是旁路系统。

这让二级缓存天然跟执行时机绑在一起：

- query 前先判断 `flushCacheIfRequired(ms)`
- 只有 `ms.isUseCache()` 且 `resultHandler == null` 才允许读二级缓存
- 命中缓存直接返回
- 未命中先走底层 `delegate.query(...)`，然后 `tcm.putObject(cache, key, list)`
- commit/rollback/close 时由 `TransactionalCacheManager` 决定真正发布还是丢弃

所以二级缓存的重点不在“比一级缓存多活一会儿”，而在：

**它必须跟事务收束时机绑在一起，否则共享结果就会提前暴露。**

## 四、为什么 `TransactionalCache` 必须存在：因为 query 完并不等于结果可见

真正把二级缓存变成“事务后可见”的，是：

- `cache/decorators/TransactionalCache.java:42` `delegate`
- `cache/decorators/TransactionalCache.java:64` `getObject(...)`
- `cache/decorators/TransactionalCache.java:88` `clear()`
- `cache/decorators/TransactionalCache.java:94` `commit()`
- `cache/decorators/TransactionalCache.java:102` `rollback()`

它自己维护三组状态：

- `clearOnCommit`
- `entriesToAddOnCommit`
- `entriesMissedInCache`

语义很关键：

### 1. 查询未命中时

`getObject(key)` 会把 miss 记进 `entriesMissedInCache`。

### 2. query 后 put 时

结果不是直接放进真实 cache，而是先放进 `entriesToAddOnCommit`。

### 3. commit 时

- 如果 `clearOnCommit`，先清真实 cache
- 再把 `entriesToAddOnCommit` 刷进 delegate
- 对那些 miss 但后来仍没有值的 key，写一个 `null` 占位以释放可能的阻塞锁

### 4. rollback 时

- 不发布结果
- 只 `unlockMissedEntries()`
- 然后 reset 本地缓冲状态

所以 `TransactionalCache` 的存在不是“再包一层缓存”，而是在表达：

**一个会话里得到的结果，在 commit 前只是候选结果，不是共享事实。**

## 五、`BlockingCache`：为什么缓存未命中也要加锁，回滚时还要释放锁

- `cache/decorators/BlockingCache.java:67` `getObject(...)`
- `cache/decorators/BlockingCache.java:89` `acquireLock(...)`
- `cache/decorators/BlockingCache.java:112` `releaseLock(...)`

`BlockingCache` 最容易让人误读成“某种高级并发优化”。

但它真正解决的问题很具体：

- 多个线程同时 miss 同一个 key 时，不能让大家都去打数据库

于是它的协议变成：

1. `getObject(key)` 先拿锁
2. 命中则立刻释放锁返回结果
3. 未命中则保持锁，等待后续 put 或 rollback 时释放

这就解释了为什么 `TransactionalCache` 在 rollback 时必须显式 `unlockMissedEntries()`：

- 因为这次会话虽然没有生成结果，但它已经替别人抢过这把“未命中锁”了
- 如果不释放，后面的线程会一直挂住

所以 `BlockingCache` 不是性能小技巧，而是：

**共享缓存未命中场景下的并发一致性协议。**

`BlockingCacheTest` 的价值就在这里：它验证的不是“缓存能不能用”，而是“锁有没有在 put 和 rollback 两种路径上都被正确释放”。

## 六、`PerpetualCache`、`LruCache`、`FifoCache`：这些装饰器表达的是 namespace 级存储策略，不是主协议本身

- `cache/impl/PerpetualCache.java:31` `cache`
- `cache/decorators/LruCache.java:64` `putObject(...)`

`PerpetualCache` 就是最基础的 HashMap 存储体。

而 `LruCache`、`FifoCache`、`SoftCache`、`WeakCache` 等，是在这个基础上叠加不同淘汰或引用策略。

它们当然重要，但要注意层次：

- 它们回答的是“namespace 级共享缓存怎样存”
- 不是“结果何时可见、何时失效”的核心协议

真正的一致性协议仍然掌握在：

- `CachingExecutor`
- `TransactionalCacheManager`
- `TransactionalCache`
- `flushCacheIfRequired`
- commit/rollback 路径

## 七、失败路径与禁区：为什么缓存专题本质上是“一致性边界专题”

这一篇真正值钱的地方，不在 happy path，而在禁区：

### 1. OUT 参数禁区

`CachingExecutor.ensureNoOutParams(...)` 明确拒绝 callable statement 的 OUT 参数缓存。

### 2. flushCacheRequired

某些 statement 在查询前就要求清缓存，说明缓存不是“越多越好”，而是必须服从 statement 语义。

### 3. rollback 不能发布结果

这就是 `TransactionalCache.rollback()` 的根本意义。

### 4. 阻塞缓存未命中锁必须释放

否则 miss 就会变成死锁源。

### 5. 大结果集和 Cursor 不能和“缓存命中率”问题混成一个话题

`cursor_cache_oom` 用例提醒的是：大结果集、nested result map、Cursor 消费边界与缓存是不同主题，不能把所有“性能问题”都糊成缓存优化。

## 到这里，M-5 真正立住的不是缓存实现类，而是“结果何时可见”的协议

如果只看类名，这篇很容易被读成：

- `localCache` 是一级缓存
- `CachingExecutor` 是二级缓存入口
- `TransactionalCache` 是缓冲层
- `BlockingCache` 是并发优化

这些都对，但还不够。

更稳的理解方式应该是：

1. 一级缓存服务于当前会话与 deferred load
2. 二级缓存服务于 namespace 级共享结果
3. 二级缓存结果不会在 query 之后立刻共享，而要经过 `TransactionalCache` 缓冲直到 commit
4. `BlockingCache` 补的是未命中并发一致性，而不是单纯加速
5. 所有这些设计最终都在回答同一个问题：

**一条查询结果，什么时候才可以被别的执行上下文安全复用。**

## 这篇之后，最自然的继续方向

缓存边界立住后，下一步最自然的是回到执行主线里另一个已出现但还没深挖的主题：

- 动态 SQL 是怎样生成最终 `BoundSql` 的
- 插件又是怎样切进 `Executor` / `StatementHandler` / `ParameterHandler` / `ResultSetHandler` 的

也就是说，下一篇应该进入 `M-6 动态 SQL、参数绑定与插件拦截`。