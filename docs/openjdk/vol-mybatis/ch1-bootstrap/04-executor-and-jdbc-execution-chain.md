# 为什么 MyBatis 的执行链不是“拿 SQL 就打 JDBC”

> 本文基于 MyBatis 3.5.16 当前源码。本文只讲执行主线：`BaseExecutor`、`CachingExecutor`、`Simple/Reuse/BatchExecutor`、`RoutingStatementHandler`、`DefaultParameterHandler`、`DefaultResultSetHandler` 如何把一次 mapper 调用落到 JDBC。缓存专题、动态 SQL 和类型系统只在本篇按执行链需要点到为止。

## 为什么“Executor 调一下 Statement”这个印象会越读越糊

很多人第一次理解 MyBatis 执行时，会把它压成这样：

- Mapper 方法进 `SqlSession`
- `SqlSession` 找 `Executor`
- `Executor` 执行 SQL
- 拿到结果返回

这条线当然不假，但它太粗了。

它解释不了很多你迟早会撞到的现实问题：

- 为什么相同查询在同一个 `SqlSession` 里不一定重复打数据库
- 为什么有的查询之前会先清一级缓存
- 为什么 `deferredLoads` 不是放在结果处理器里，而是放在执行器里
- 为什么 callable statement 带 OUT 参数不能进二级缓存
- 为什么同样是执行 SQL，还要区分 `SimpleExecutor`、`ReuseExecutor`、`BatchExecutor`
- 为什么最终不是直接 new 某个 Statement，而是先过 `RoutingStatementHandler`

更准确的说法应该是：

**MyBatis 的执行不是一次 JDBC 调用，而是一套“缓存判定 + 语句路由 + 参数绑定 + 结果落地”的执行协议。**

## 执行链的最小总图

```text
MapperMethod.execute()
  -> SqlSession.select/update...
    -> Executor
      -> CachingExecutor（可选二级缓存装饰）
        -> BaseExecutor
          -> Simple / Reuse / BatchExecutor
            -> Configuration.newStatementHandler(...)
              -> RoutingStatementHandler
                -> ParameterHandler.setParameters()
                -> Statement.execute*
                  -> DefaultResultSetHandler.handleResultSets()
```

这条链里有两个特别重要的“中间层”：

1. `Executor` 并不直接等于 JDBC 执行器，它还承担缓存与延迟加载语义
2. `StatementHandler` / `ResultSetHandler` 把“怎么执行”和“怎么落结果”从执行器里拆了出去

## 一、`BaseExecutor`：执行链真正的状态中心，不是 StatementHandler

`BaseExecutor` 的核心字段一开始就暴露了它的职责：

- `executor/BaseExecutor.java:54` `transaction`
- `executor/BaseExecutor.java:57` `deferredLoads`
- `executor/BaseExecutor.java:58` `localCache`
- `executor/BaseExecutor.java:62` `queryStack`

这说明它关心的不是单次 SQL，而是一次会话期内的运行状态：

- 当前事务是什么
- 一级缓存里有什么
- 哪些延迟加载任务还挂着
- 当前查询嵌套深度是多少

如果把它只当成“执行 SQL 的父类”，你会低估它在整条链里的位置。

## 二、`query()/update()`：为什么执行器先判断缓存和查询深度，再决定要不要打数据库

- `executor/BaseExecutor.java:111` `update(...)`
- `executor/BaseExecutor.java:133` `query(...)`
- `executor/BaseExecutor.java:331` `queryFromDatabase(...)`

### 1. `update(...)`

更新路径一进来先 `clearLocalCache()`，再 `doUpdate(ms, parameter)`。

也就是说，在 MyBatis 里更新操作首先是“缓存破坏者”，然后才是 JDBC 更新调用。

### 2. `query(...)`

查询路径更有意思：

1. 先根据 `ms.getBoundSql(parameter)` 生成 `BoundSql`
2. 再生成 `CacheKey`
3. 如果 `queryStack == 0 && ms.isFlushCacheRequired()`，先清一级缓存
4. 如果 `resultHandler == null`，优先查 `localCache`
5. 命中则直接返回，并处理 output parameter 回填
6. 未命中才进 `queryFromDatabase(...)`
7. 查询栈回到 0 后，统一执行 `DeferredLoad.load()` 并按 `LocalCacheScope` 决定要不要清缓存

这就说明：

**真正控制“要不要打数据库”的第一关，不在 StatementHandler，而在 BaseExecutor 的本地缓存与查询栈协议。**

## 三、`createCacheKey()` 与 `deferLoad()`：为什么缓存键和延迟加载属于执行器层

- `executor/BaseExecutor.java:184` `deferLoad(...)`
- `executor/BaseExecutor.java:197` `createCacheKey(...)`

`createCacheKey()` 不是随手拼一个字符串，而是把：

- statement id
- rowBounds offset/limit
- `boundSql.getSql()`
- 参数值
- environment id

一起压成缓存键。

这意味着 MyBatis 的“相同查询”不是看方法名，而是看真正执行语义是否等价。

而 `deferLoad(...)` 更能说明执行器为什么是状态中心：

- 如果 localCache 里已经能装配目标值，就立刻 load
- 否则把 `DeferredLoad` 挂到队列里，等最外层查询返回时统一回放

也就是说，延迟加载不是结果处理器里现场完成的动作，而是：

**先由结果装配阶段发现依赖，再由执行器在正确时机统一回放。**

## 四、`CachingExecutor`：二级缓存不是一个孤立组件，而是执行器装饰器

- `executor/CachingExecutor.java:39` 类声明
- `executor/CachingExecutor.java:49` `close(boolean forceRollback)`
- `executor/CachingExecutor.java:67` `query(...)`
- `executor/CachingExecutor.java:121` `flushCacheIfRequired(...)`

`CachingExecutor` 的位置很关键：它包在真正的 executor 外面，而不是独立漂在一边。

这让二级缓存天然绑定到执行时机：

- update/queryCursor/query 之前先 `flushCacheIfRequired(ms)`
- query 时只有 `ms.isUseCache()` 且 `resultHandler == null` 才允许走二级缓存
- commit/rollback/close 时，通过 `TransactionalCacheManager` 决定是 `commit()` 还是 `rollback()`

尤其 `ensureNoOutParams(ms, boundSql)` 更说明它不是“万能缓存层”：

- 如果是 `CALLABLE` 且参数里有 OUT 参数，直接拒绝进入缓存

所以二级缓存不是“另一个 Map”，而是：

**执行器层在事务提交语义下，给 namespace 级缓存加的一层受控装饰。**

## 五、为什么要有 `Simple` / `Reuse` / `BatchExecutor` 三种执行器

### 1. `SimpleExecutor`

- `executor/SimpleExecutor.java:56` `doQuery(...)`

语义最直接：每次准备新的 Statement，执行完就收。

### 2. `ReuseExecutor`

- `executor/ReuseExecutor.java:55` `doQuery(...)`

它在执行器内部保留 Statement，可复用相同 SQL 的 Statement 对象。

### 3. `BatchExecutor`

- `executor/BatchExecutor.java:54` `doUpdate(...)`
- `executor/BatchExecutor.java:114` `doFlushStatements(...)`

它不是“立刻执行 update”，而是：

- 相同 SQL + 相同 `MappedStatement` 继续往现有 batch 里塞参数
- 不同 SQL 才新建 Statement/BatchResult
- `flushStatements()` 时统一 `executeBatch()`
- 如果第 i 个 batch 失败，会明确告诉你“前面若干 sub executor 已成功，但整批仍将回滚”

这说明三种执行器的区别不是性能选项小节，而是：

**执行语义到底是一次一条、复用 Statement，还是先积攒后统一刷出。**

## 六、`RoutingStatementHandler`：为什么真正的 Statement 创建要再走一层路由

- `executor/statement/RoutingStatementHandler.java:39` 构造函数
- `executor/statement/RoutingStatementHandler.java:42` `switch (ms.getStatementType())`

这里的职责很纯粹：按 `MappedStatement.getStatementType()` 选择：

- `SimpleStatementHandler`
- `PreparedStatementHandler`
- `CallableStatementHandler`

这层存在的意义是：

- Executor 不必知道 Statement 的 JDBC 细分差异
- 参数绑定、batch、query、cursor 都统一走 `StatementHandler` 抽象

所以 MyBatis 不是“每种执行器直接 new 某种 JDBC Statement”，而是先进入一个更稳定的中间协议层。

## 七、`DefaultParameterHandler`：参数绑定不是顺手 set 一下，而是类型系统真正落地的一刻

- `scripting/defaults/DefaultParameterHandler.java:61` `setParameters(...)`

虽然类型系统的完整专题会后移，但执行链里必须先知道它的位置：

- 从 `BoundSql.getParameterMappings()` 取参数映射
- 解析每个参数值
- 找对应 `TypeHandler`
- 把 Java 值真正写入 JDBC `PreparedStatement`

也就是说，`ParameterHandler` 是“方法参数语义”真正变成“JDBC 参数值”的落地点。

## 八、`DefaultResultSetHandler`：JDBC 结果不是执行器直接返回，而是经过对象图装配器

- `executor/resultset/DefaultResultSetHandler.java:127` 构造函数
- `executor/resultset/DefaultResultSetHandler.java:188` `handleResultSets(...)`

`DefaultResultSetHandler` 一眼看上去就很重：

- `nestedResultObjects`
- `ancestorObjects`
- `pendingRelations`
- `autoMappingsCache`
- `constructorAutoMappingColumns`

这些字段说明它不是“把 ResultSet 每行塞进对象”那么简单，而是在处理：

- 嵌套结果对象
- 多结果集关联
- 自动映射缓存
- 构造器映射
- deferred relation

所以整个执行链的最后一跳不是 JDBC 返回 list，而是：

**JDBC 结果先进入一个对象图装配器，再由它决定最终返回结构。**

## 到这里，M-4 真正立住的不是类图，而是“执行协议”

如果只看类名，这篇很容易被读成：

- `BaseExecutor` 做缓存
- `CachingExecutor` 做二级缓存
- `StatementHandler` 做 Statement
- `ResultSetHandler` 做结果映射

这当然对，但还是碎。

更稳的理解方式应该是：

1. `BaseExecutor` 负责一级缓存、`queryStack`、`deferredLoads` 和事务边界下的本地清理
2. `CachingExecutor` 把 namespace 级二级缓存装进执行协议，而不是独立外挂
3. `Simple/Reuse/BatchExecutor` 负责具体 JDBC 落地策略
4. `RoutingStatementHandler` 决定 Statement 形态
5. `DefaultParameterHandler` 与 `DefaultResultSetHandler` 负责参数和值对象真正落地

所以这篇真正立住的是：

**MyBatis 的执行主线，是一套把缓存、语句路由、参数绑定和结果装配串起来的协议，而不是“Executor 直接打 JDBC”。**

## 这篇之后，最自然的继续方向

到这里，主干层已经把配置、Mapper 入口、Session 生命周期和执行链都立住了。

接下来最自然的继续方向有两个：

- 如果顺着主干继续收束，就进入 `M-5 缓存与一致性边界`
- 如果想补执行主线里已经出现但还没深挖的机制，就进入 `M-6 动态 SQL、参数绑定与插件拦截`

按当前卷级顺序，更自然的是先进入 `M-5`。