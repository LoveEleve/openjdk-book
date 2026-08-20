# 为什么 `SqlSession` 不是一个薄门面，而是 MyBatis 的资源责任中心

> 本文基于 MyBatis 3.5.16 当前源码。本文只讲 `SqlSession`、事务与资源生命周期：`DefaultSqlSessionFactory` 如何创建 Session，`DefaultSqlSession` 如何管理 dirty 状态与 Cursor，`JdbcTransaction` 与 `ManagedTransaction` 如何划分提交/关闭责任。不展开执行器内部细节和 Spring 集成。

## 为什么“SqlSession 就是个 DAO API”这个理解会误导后续阅读

很多人把 `SqlSession` 记成一个很顺手的 API：

- `selectOne`
- `selectList`
- `insert`
- `update`
- `delete`
- `commit`
- `rollback`
- `close`

于是很自然会产生一个印象：

- `SqlSession` 只是把请求转发给底层 Executor

这当然有一部分是真的，但如果你只停在这里，后面很多行为都会变得难以解释：

- 为什么 `selectCursor()` 之后还要在 `close()` 里额外关 Cursor
- 为什么只做查询时，`commit(false)` 可能根本不下沉
- 为什么 `JdbcTransaction` 在 `close()` 前要尝试把 autocommit 复位成 `true`
- 为什么同样叫 transaction，`ManagedTransaction` 居然对 `commit()` / `rollback()` 什么都不做

这些都说明：

**`SqlSession` 不是一个薄门面，而是 MyBatis 把“资源归谁负责、何时真正收束”集中表达出来的责任中心。**

## `SqlSession` 生命周期的最小总图

```text
DefaultSqlSessionFactory.openSession*()
  -> TransactionFactory.newTransaction(...)
    -> Configuration.newExecutor(tx, execType)
      -> DefaultSqlSession(configuration, executor, autoCommit)
        -> select/update 改写 dirty 与 cursorList
        -> commit/rollback 决定是否真正下沉到 transaction
        -> close() -> executor.close(...) -> closeCursors()
```

如果再把事务语义压进去，可以变成：

```text
JdbcTransaction
  -> getConnection() 延迟取连接
  -> commit()/rollback() 真正操作 JDBC
  -> close() 前 resetAutoCommit()

ManagedTransaction
  -> getConnection() 延迟取连接
  -> commit()/rollback() no-op
  -> close() 只在允许时关闭连接
```

这张图真正要建立的是：

- `SqlSession` 持有的是一次“会话责任”
- `Transaction` 持有的是“连接与提交责任”
- 二者不是同一个层级，但由 `DefaultSqlSessionFactory` 在启动 Session 时绑到一起

## 一、`DefaultSqlSessionFactory`：Session 不是凭空出现，而是和 Transaction/Executor 一起被构造出来

入口在：

- `session/defaults/DefaultSqlSessionFactory.java:50` `openSessionFromDataSource(...)`
- `session/defaults/DefaultSqlSessionFactory.java:71` `openSessionFromConnection(...)`
- `session/defaults/DefaultSqlSessionFactory.java:91` `getTransactionFactoryFromEnvironment(...)`

`openSessionFromDataSource(...)` 做的事情非常完整：

1. 从 `Configuration` 拿 `Environment`
2. 根据 environment 取 `TransactionFactory`
3. 用 `dataSource + isolation + autoCommit` 创建 `Transaction`
4. 用这个 transaction 创建 `Executor`
5. 最后构造 `DefaultSqlSession(configuration, executor, autoCommit)`

也就是说，`SqlSession` 在诞生时就已经和事务、执行器绑死了。

更关键的是异常路径：如果构造途中出错，它会调用 `closeTransaction(tx)`，避免已经拿到的连接泄漏。

这说明 `DefaultSqlSessionFactory` 不只是“帮你 new 一个 Session”，而是在创建入口上就把资源回收责任收住了。

## 二、`DefaultSqlSession`：三个真正应该先记住的状态是 `autoCommit`、`dirty`、`cursorList`

`DefaultSqlSession` 的状态核心非常集中：

- `session/defaults/DefaultSqlSession.java:52` `autoCommit`
- `session/defaults/DefaultSqlSession.java:53` `dirty`
- `session/defaults/DefaultSqlSession.java:54` `cursorList`

这三个状态几乎决定了它后面所有生命周期行为。

### 1. `autoCommit`

它不是 JDBC Connection 上的原始 autocommit，而是这次 Session 创建时的提交策略视角。

### 2. `dirty`

只要执行了 update/insert/delete，或者某些 `dirtySelect`，它就会被置成 `true`。

### 3. `cursorList`

只要通过 `selectCursor()` 返回过 Cursor，它就会被注册进列表，等待 `close()` 时级联关闭。

这意味着 `DefaultSqlSession` 管的不是“当前执行了哪条 SQL”，而是：

- 这次会话是否已经改变了数据语义
- 这次会话是否还挂着未关闭的增量结果资源

## 三、为什么查询、更新、Cursor 会改写不同的生命周期状态

### 1. 查询路径

- `session/defaults/DefaultSqlSession.java:150` `selectList(...)`

普通查询本身不直接把 `dirty` 置为 true，但它会经过 `MappedStatement` 判断 `isDirtySelect()`；这说明 MyBatis 允许某些 select 被视为需要事务语义参与的脏操作。

### 2. 更新路径

- `session/defaults/DefaultSqlSession.java:193` `update(String statement, Object parameter)`

这里在真正执行前就 `dirty = true`，因为从资源责任角度，它已经不再是“纯只读会话”。

### 3. Cursor 路径

- `session/defaults/DefaultSqlSession.java:121` `selectCursor(...)`

`selectCursor()` 不只是 query 一次，它还会：

1. 拿到 `Cursor<T>`
2. 调用 `registerCursor(cursor)`
3. 把它挂到 `cursorList`

也就是说，Cursor 的本质不是“另一种返回类型”，而是“需要会话最终负责关闭的外部资源句柄”。

## 四、`commit/rollback` 真正的关键，不是调用了什么，而是何时需要真正调用

- `session/defaults/DefaultSqlSession.java:221` `commit(boolean force)`
- `session/defaults/DefaultSqlSession.java:238` `rollback(boolean force)`
- `session/defaults/DefaultSqlSession.java:300` `isCommitOrRollbackRequired(boolean force)`

这里最容易被忽略的是 `isCommitOrRollbackRequired(force)`：

```text
return !autoCommit && dirty || force
```

这意味着：

- autoCommit=true 时，普通 commit/rollback 不一定需要下沉
- 纯查询且不 dirty 时，也不一定需要 commit/rollback
- 只有非 autoCommit 且会话已脏，或者调用方显式 force，才真正要求事务动作下沉

所以 `commit()` / `rollback()` 的本质不是“总是转发给事务”，而是：

**先由 `SqlSession` 判断这次会话是否已经进入必须收束事务的状态。**

这也解释了为什么 MyBatis 在 `JdbcTransaction.close()` 前还要处理 autocommit：并不是每个会话都会显式做 commit/rollback，但连接关闭前仍可能需要把数据库状态收干净。

## 五、`close()`：真正的收束顺序是先 executor，再 cursor，再清会话状态

- `session/defaults/DefaultSqlSession.java:261` `close()`
- `session/defaults/DefaultSqlSession.java:271` `closeCursors()`

`close()` 的顺序是：

1. `executor.close(isCommitOrRollbackRequired(false))`
2. `closeCursors()`
3. `dirty = false`
4. 最后 reset `ErrorContext`

这个顺序很重要。

它说明在 MyBatis 眼里：

- 先把事务/执行器这一层收掉
- 再把挂在会话上的 Cursor 资源逐个关掉
- 最后把当前会话状态清零

这里不是简单的“调用 close 就结束”，而是一个明确的资源收束协议。

## 六、`JdbcTransaction`：为什么它要延迟取连接、只在 `!autoCommit` 时提交、并在 close 前 reset autocommit

`JdbcTransaction` 的关键点在：

- `transaction/jdbc/JdbcTransaction.java:59` `getConnection()`
- `transaction/jdbc/JdbcTransaction.java:67` `commit()`
- `transaction/jdbc/JdbcTransaction.java:76` `rollback()`
- `transaction/jdbc/JdbcTransaction.java:85` `close()`
- `transaction/jdbc/JdbcTransaction.java:111` `openConnection()`

它的协议很清楚：

1. 连接延迟到 `getConnection()` 才真正打开
2. `commit()` / `rollback()` 只在 `connection != null && !connection.getAutoCommit()` 时下沉
3. `close()` 之前先 `resetAutoCommit()`，必要时把 autocommit 设回 `true`

这里最值得停一下的是 `resetAutoCommit()` 的注释语义：

- MyBatis 对“只执行了 select 的会话”未必会显式 commit/rollback
- 但某些数据库在 select 之后依旧要求你先完成一次事务收束再 close
- 于是 MyBatis 选择在 close 前把 autocommit 复位，作为兼容性补救

这说明 `JdbcTransaction` 不只是“JDBC 的薄包装”，而是在帮 `SqlSession` 兜住数据库连接关闭时那些不那么直观的事务边界。

## 七、`ManagedTransaction`：为什么什么都不做反而是正确的

与 `JdbcTransaction` 相对的，是：

- `transaction/managed/ManagedTransaction.java:56` `getConnection()`
- `transaction/managed/ManagedTransaction.java:64` `commit()`
- `transaction/managed/ManagedTransaction.java:69` `rollback()`
- `transaction/managed/ManagedTransaction.java:74` `close()`

它的语义恰恰建立在“不做”：

- `commit()`：Does nothing
- `rollback()`：Does nothing
- `close()`：只有 `closeConnection` 为真时才关闭连接

这不是偷懒，而是在表达一条完全不同的责任边界：

**事务生命周期不再由 MyBatis 自己控制，而由外部容器接管。**

也就是说，`ManagedTransaction` 的存在不是为了“再提供一种事务实现”，而是为了让 MyBatis 能在“我自己管 JDBC”和“容器帮我管”之间明确切换责任世界。

## 到这里，M-3 真正立住的不是几个类，而是“资源责任协议”

如果只看表面，这篇很容易被读成：

- `DefaultSqlSessionFactory` 创建 Session
- `DefaultSqlSession` 调 commit/rollback/close
- `JdbcTransaction` 和 `ManagedTransaction` 两种实现

这还是太平。

更稳的理解方式应该是：

1. `DefaultSqlSessionFactory` 在创建入口把 Session、Transaction、Executor 三者绑到一起
2. `DefaultSqlSession` 用 `autoCommit`、`dirty`、`cursorList` 管住一次会话的资源状态
3. commit/rollback 先由 `SqlSession` 判断是否真正需要下沉
4. close 负责按顺序收掉 executor、cursor 和会话状态
5. `JdbcTransaction` 与 `ManagedTransaction` 不是“两个名字”，而是两种责任边界

所以这篇真正立住的是：

**MyBatis 的 `SqlSession` 是资源所有权与事务收束的第一责任人。**

## 这篇之后，最自然的继续方向

到这里，我们已经知道 mapper 方法怎样进入 `SqlSession`，也知道 `SqlSession` 如何持有事务与资源。

接下来最自然的问题就是：

- 一次真正的执行，是怎样穿过 Executor、StatementHandler、ParameterHandler 和 ResultSetHandler 落到 JDBC 的？

也就是说，下一篇应该进入 `M-4 Executor 执行链与 JDBC 落地`。