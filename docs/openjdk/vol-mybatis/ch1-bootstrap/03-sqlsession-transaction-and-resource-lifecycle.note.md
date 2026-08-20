# M-3 SqlSession、事务与资源生命周期 — note

## 本篇主张

- `SqlSession` 不是薄 API，而是资源所有权与事务收束责任中心。
- `autoCommit`、`dirty`、`cursorList` 是理解会话生命周期的三个核心状态。
- `JdbcTransaction` 与 `ManagedTransaction` 表达的是两种责任边界，而不是两个可随便替换的工具类。

## 本篇边界

- 不展开 Executor 内部 query/update/缓存细节。
- 不展开 Spring 接管后的事务同步。
- 只把 Cursor 当作会话资源的一部分，不深入结果映射算法。

## 下篇桥接

- `M-4` 将回答：一次执行如何从 `Executor` 继续下沉到 `StatementHandler`、参数绑定、JDBC 执行和结果处理。