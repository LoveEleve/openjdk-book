# 篇：04 Executor 执行链与 JDBC 落地

- 域：`M-4 Executor 执行链与 JDBC 落地`
- 卷：`vol-mybatis`
- 目标：回答一次 MyBatis 执行是怎样从 `Executor` 穿过缓存、StatementHandler、参数绑定、JDBC Statement 和 ResultSetHandler 的；并立住一级缓存、deferred load、二级缓存装饰与 Statement 路由的边界。

## 前置依赖

- HARD：已读 `M-1`、`M-2`、`M-3`。

## 读者问题

为什么一条 mapper 调用不会直接变成 `PreparedStatement.executeQuery()`，而是要绕过：

1. `BaseExecutor` 的一级缓存与 `queryStack`
2. `CachingExecutor` 的二级缓存事务包装
3. `RoutingStatementHandler` 的三种 Statement 路由
4. `DefaultParameterHandler` 的参数取值与类型处理
5. `DefaultResultSetHandler` 的结果装配与 deferred load

## 主结论

MyBatis 的执行链不是“一个 Executor 调 JDBC”，而是：

`MapperMethod.execute()`
  -> `SqlSession.select/update...`
    -> `Executor` (`CachingExecutor` -> `BaseExecutor` -> `Simple/Reuse/BatchExecutor`)
      -> `Configuration.newStatementHandler(...)`
        -> `RoutingStatementHandler`
          -> `ParameterHandler.setParameters()`
          -> JDBC `Statement.execute*`
            -> `DefaultResultSetHandler.handleResultSets()`

其中：

- `BaseExecutor` 负责一级缓存、`CacheKey`、`queryStack`、deferred load 与事务提交前后的本地清理
- `CachingExecutor` 负责 namespace 级二级缓存与 commit/rollback 时机
- `RoutingStatementHandler` 决定 `STATEMENT/PREPARED/CALLABLE`
- `DefaultResultSetHandler` 负责把 ResultSet 落成对象图

## 结构设计

1. 困惑开场：为什么 MyBatis 执行链不是“拿 SQL -> 执行 -> 返回”
2. 最小总图：`MapperMethod` -> `Executor` -> `StatementHandler` -> `ResultSetHandler`
3. `BaseExecutor.query()/update()`：一级缓存、`queryStack`、`queryFromDatabase()`
4. `createCacheKey()` 与 `deferLoad()`：为什么缓存键和延迟加载属于执行器层
5. `CachingExecutor`：二级缓存不是另一个缓存类，而是执行器装饰器
6. `Simple/Reuse/BatchExecutor`：三种落地策略的差异
7. `RoutingStatementHandler`：按 `StatementType` 路由
8. `DefaultParameterHandler`：参数如何变成 JDBC 值
9. `DefaultResultSetHandler`：结果集、嵌套对象与 deferred load
10. 收网：这篇立住的是“执行协议”，不是类图清单
11. 下篇桥接：进入缓存或动态 SQL 的补深层

## 必须回填的源码锚点

- `executor/BaseExecutor.java:54` `transaction`
- `executor/BaseExecutor.java:57` `deferredLoads`
- `executor/BaseExecutor.java:58` `localCache`
- `executor/BaseExecutor.java:62` `queryStack`
- `executor/BaseExecutor.java:83` `close(boolean forceRollback)`
- `executor/BaseExecutor.java:111` `update(...)`
- `executor/BaseExecutor.java:133` `query(...)`
- `executor/BaseExecutor.java:177` `queryCursor(...)`
- `executor/BaseExecutor.java:184` `deferLoad(...)`
- `executor/BaseExecutor.java:197` `createCacheKey(...)`
- `executor/BaseExecutor.java:242` `commit(boolean required)`
- `executor/BaseExecutor.java:252` `rollback(boolean required)`
- `executor/BaseExecutor.java:331` `queryFromDatabase(...)`
- `executor/CachingExecutor.java:39` 类声明
- `executor/CachingExecutor.java:49` `close(boolean forceRollback)`
- `executor/CachingExecutor.java:67` `query(...)`
- `executor/CachingExecutor.java:121` `flushCacheIfRequired(...)`
- `executor/statement/RoutingStatementHandler.java:39` 构造函数
- `executor/statement/RoutingStatementHandler.java:42` `switch (ms.getStatementType())`
- `scripting/defaults/DefaultParameterHandler.java:61` `setParameters(...)`
- `executor/SimpleExecutor.java:56` `doQuery(...)`
- `executor/ReuseExecutor.java:55` `doQuery(...)`
- `executor/BatchExecutor.java:54` `doUpdate(...)`
- `executor/BatchExecutor.java:114` `doFlushStatements(...)`
- `executor/resultset/DefaultResultSetHandler.java:127` 构造函数
- `executor/resultset/DefaultResultSetHandler.java:188` `handleResultSets(...)`

## 必须引用的测试/证据

- `BaseExecutorTest`：一级缓存、deferredLoads、结果映射主线
- `BatchExecutorTest`：批处理行为
- `Caching*ExecutorTest`：二级缓存与执行器装饰行为
- `cursor_cache_oom`、`blocking_cache`：生产层候选证据

## note / review 约束

- note 只记主张、边界、桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。