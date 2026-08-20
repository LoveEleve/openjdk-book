# M-3 SqlSession、事务与资源生命周期 — review notes

## 事实审

- 已核对 `session/defaults/DefaultSqlSessionFactory.java:50`、`session/defaults/DefaultSqlSessionFactory.java:71`、`session/defaults/DefaultSqlSessionFactory.java:91`，Session 创建与事务工厂选择位置成立。
- 已核对 `session/defaults/DefaultSqlSession.java:52`、`session/defaults/DefaultSqlSession.java:53`、`session/defaults/DefaultSqlSession.java:54`，`autoCommit`、`dirty`、`cursorList` 状态核心成立。
- 已核对 `session/defaults/DefaultSqlSession.java:121`、`session/defaults/DefaultSqlSession.java:193`、`session/defaults/DefaultSqlSession.java:221`、`session/defaults/DefaultSqlSession.java:238`、`session/defaults/DefaultSqlSession.java:261`、`session/defaults/DefaultSqlSession.java:271`、`session/defaults/DefaultSqlSession.java:300`，查询、更新、事务收束与 Cursor 关闭位置成立。
- 已核对 `transaction/jdbc/JdbcTransaction.java:59`、`transaction/jdbc/JdbcTransaction.java:67`、`transaction/jdbc/JdbcTransaction.java:76`、`transaction/jdbc/JdbcTransaction.java:85`、`transaction/jdbc/JdbcTransaction.java:111`，JDBC 自管事务主线成立。
- 已核对 `transaction/managed/ManagedTransaction.java:56`、`transaction/managed/ManagedTransaction.java:64`、`transaction/managed/ManagedTransaction.java:69`、`transaction/managed/ManagedTransaction.java:74`，容器托管事务 no-op 语义成立。

## 因果审

- `openSessionFromDataSource()` 不是简单 new Session，而是 `Transaction -> Executor -> DefaultSqlSession` 的捆绑创建，正文成立。
- `dirty` 与 `autoCommit` 共同决定 commit/rollback 是否真正下沉，正文成立。
- `cursorList` 说明 Cursor 是会话级资源，不是普通返回值，正文成立。
- `JdbcTransaction` 与 `ManagedTransaction` 不是实现细节差异，而是责任边界差异，正文成立。

## 结构审

- 从“为什么 SqlSession 不是薄门面”切入，再落到创建、状态核心、commit/rollback、close、两种事务边界，结构集中。
- 没有把事务类和 Session API 分散讲解，符合方法论。

## 读者审

- 读完应能回答：为什么只做查询时 commit/rollback 不一定真正下沉。
- 读完应能回答：为什么 close 不只是关一个 Session 引用，而是要收 executor 和 cursor。
- 读完后能自然接到 M-4 的执行链，而不会把事务和执行链混成一层。

## 边界审

- 本篇没有提前透支 Executor 内部 query/update/缓存细节。
- 没有提前进入 Spring 事务同步，只保留原生与容器托管的边界差异。

## 依赖审

- 前置依赖：M-1 的 Configuration 元数据中心、M-2 的 Mapper 方法入口。
- 后续桥接：M-4 执行链、M-5 缓存、S-1 Spring 会话/事务桥都成立。

## 结论

M-3 已完成单域四件套的事实回填与六层审查，可进入下一域。