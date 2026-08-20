# 篇：03 SqlSession、事务与资源生命周期

- 域：`M-3 SqlSession、事务与资源生命周期`
- 卷：`vol-mybatis`
- 目标：回答一个 `SqlSession` 到底持有什么、何时变脏、什么时候提交/回滚、谁关闭 Cursor、谁关闭 Connection，以及 `JdbcTransaction` 与 `ManagedTransaction` 的责任边界。

## 前置依赖

- HARD：已读 `M-1`、`M-2`，知道 `Configuration` 如何建立元数据、Mapper 方法如何进入 `SqlSession`。

## 读者问题

为什么 `SqlSession` 看起来像个轻量 API，却要同时承担：

1. 持有 `Executor`
2. 跟踪 dirty 状态
3. 记住 autoCommit
4. 注册 Cursor 并在 close 时级联关闭
5. 决定 commit/rollback 是否真正下沉到事务对象
6. 区分 JDBC 自管事务和容器托管事务

## 主结论

MyBatis 的 `SqlSession` 不是简单的门面，而是资源所有权和事务收束的第一责任人：

`DefaultSqlSessionFactory.openSession*()`
  -> `TransactionFactory.newTransaction(...)`
    -> `Configuration.newExecutor(tx, execType)`
      -> `DefaultSqlSession(configuration, executor, autoCommit)`
        -> 查询/更新改写 dirty 与 cursorList
        -> `commit/rollback` 通过 `isCommitOrRollbackRequired(force)` 决定是否真正下沉
        -> `close()` 先关 executor，再关 cursor，再清 dirty

其中：

- `JdbcTransaction` 自己提交/回滚/close
- `ManagedTransaction` 忽略 commit/rollback，把责任交给容器

## 结构设计

1. 困惑开场：为什么 `SqlSession` 不是一个薄 API
2. 最小总图：openSession -> Transaction -> Executor -> DefaultSqlSession
3. `DefaultSqlSessionFactory`：从 DataSource/Connection 两条入口构造 Session
4. `DefaultSqlSession`：dirty、autoCommit、cursorList 三个状态核心
5. commit/rollback：`isCommitOrRollbackRequired(force)` 的真正语义
6. close：为什么既要关 executor，又要关 cursor
7. `JdbcTransaction`：延迟取连接、自管提交与 close 前 resetAutoCommit
8. `ManagedTransaction`：commit/rollback no-op 的容器托管语义
9. 收网：这篇立住的是“资源责任协议”，不是几个事务类说明
10. 下篇桥接：进入 Executor 执行链和 JDBC 落地

## 必须回填的源码锚点

- `session/defaults/DefaultSqlSessionFactory.java:50` `openSessionFromDataSource(...)`
- `session/defaults/DefaultSqlSessionFactory.java:71` `openSessionFromConnection(...)`
- `session/defaults/DefaultSqlSessionFactory.java:91` `getTransactionFactoryFromEnvironment(...)`
- `session/defaults/DefaultSqlSession.java:52` `autoCommit`
- `session/defaults/DefaultSqlSession.java:53` `dirty`
- `session/defaults/DefaultSqlSession.java:54` `cursorList`
- `session/defaults/DefaultSqlSession.java:121` `selectCursor(...)`
- `session/defaults/DefaultSqlSession.java:150` `selectList(...)`
- `session/defaults/DefaultSqlSession.java:193` `update(String statement, Object parameter)`
- `session/defaults/DefaultSqlSession.java:221` `commit(boolean force)`
- `session/defaults/DefaultSqlSession.java:238` `rollback(boolean force)`
- `session/defaults/DefaultSqlSession.java:261` `close()`
- `session/defaults/DefaultSqlSession.java:271` `closeCursors()`
- `session/defaults/DefaultSqlSession.java:300` `isCommitOrRollbackRequired(boolean force)`
- `transaction/jdbc/JdbcTransaction.java:59` `getConnection()`
- `transaction/jdbc/JdbcTransaction.java:67` `commit()`
- `transaction/jdbc/JdbcTransaction.java:76` `rollback()`
- `transaction/jdbc/JdbcTransaction.java:85` `close()`
- `transaction/jdbc/JdbcTransaction.java:111` `openConnection()`
- `transaction/managed/ManagedTransaction.java:56` `getConnection()`
- `transaction/managed/ManagedTransaction.java:64` `commit()`
- `transaction/managed/ManagedTransaction.java:69` `rollback()`
- `transaction/managed/ManagedTransaction.java:74` `close()`

## 必须引用的测试/证据

- `SqlSessionTest` / `SqlSessionManagerTest`：Session 生命周期与 commit/rollback 行为
- `JdbcTransactionTest`：JDBC 事务语义与 autoCommit 边界
- Cursor 相关测试：`closeCursors()` 的资源关闭责任

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。