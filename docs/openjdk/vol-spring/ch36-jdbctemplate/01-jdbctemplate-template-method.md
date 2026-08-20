# 为什么一行 `jdbcTemplate.query(...)` 能把 15 行 JDBC 样板缩成一个回调：`JdbcTemplate` 的模板方法主线

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 `JdbcTemplate` 主线的第一层：`execute(StatementCallback, ...)` 这个模板方法如何把“取连接、建 Statement、执行、关闭、释放、异常翻译”这六七个样板步骤固定下来，只把“执行什么 SQL / 怎么处理结果”留给回调；以及 `RowMapper`、`RowCallbackHandler`、`ResultSetExtractor` 三个接口如何在结果处理上提供不同粒度的控制。事务连接复用、连接池与 DataSource 抽象已在前面篇章展开。

## 为什么写 JDBC 的人都很烦，但 `JdbcTemplate` 让这些样板代码几乎消失

如果你手写过原生 JDBC，一定写过这段十几次的样板：

```java
Connection con = null;
Statement stmt = null;
try {
    con = dataSource.getConnection();
    stmt = con.createStatement();
    ResultSet rs = stmt.executeQuery(sql);
    while (rs.next()) {
        // 手动取每一列
    }
} catch (SQLException ex) {
    // 手动处理异常
} finally {
    // 手动关闭 stmt、释放 con
}
```

这段代码的问题不在于难，而在于：

- 每次 SQL 都要重复一遍
- 连接、Statement、ResultSet 的生命周期容易泄漏
- 异常处理、资源释放散落各处

`JdbcTemplate` 把这套样板收回模板方法，只把真正变化的部分交给回调。

第一层问题是：**`execute(StatementCallback, ...)` 是一个模板方法，它把连接和资源管理固定成骨架。**

骨架大致是：

1. `DataSourceUtils.getConnection(...)` 获取连接（事务中先查 ThreadLocal）
2. 创建 Statement
3. 调用回调执行 SQL
4. `finally` 中 `DataSourceUtils.releaseConnection(...)` 释放连接
5. `catch` 中把 `SQLException` 通过异常翻译器翻译成 `DataAccessException`

这个骨架对所有 SQL 完全一样，所以被固定下来；变化的只有“回调里执行什么 SQL”。

第二层问题是：**`DataSourceUtils.getConnection(...)` 先查 ThreadLocal，这正好接上了前面事务篇的连接共享。**

`DataSourceUtils.getConnection(obtainDataSource())` 内部先查 `TransactionSynchronizationManager.getResource(ds)`：

- 如果当前线程有事务连接，直接复用
- 没有才从数据源新建

这也解释了为什么事务内的所有 `JdbcTemplate` 操作会共享同一个 Connection：它们都走同一套 `DataSourceUtils` 取连接逻辑。

第三层问题是：**结果处理不是只有一种方式，而是三个接口按控制粒度递增。**

- `RowMapper` 逐行映射并收集成 List
- `RowCallbackHandler` 逐行处理但不收集
- `ResultSetExtractor` 拿到整个 ResultSet 自行控制

`JdbcTemplate` 的 `query` 方法会把 `RowMapper` 包装成 `RowMapperResultSetExtractor`（一个 `ResultSetExtractor`），再进入 `execute` 模板。这样模板统一，只是回调在结果处理上扮演不同角色。

因此，本文真正要回答的问题不是“`JdbcTemplate` 有什么方法”，而是：

**`JdbcTemplate` 如何用一个统一的 `execute` 模板方法把 JDBC 资源管理和异常翻译固定下来，只把“执行什么 SQL / 怎么处理结果”留给回调，并让 `RowMapper` 系列接口在结果处理上提供不同粒度的控制？**

## 先看失败方案：为什么不能每次手写 JDBC、把结果处理硬编码、让每种查询都重新实现模板

### 失败方案一：每次手写 JDBC 样板

如果每个 DAO 方法都自己写 `getConnection → createStatement → execute → close`，那么连接生命周期的管理会散落在每个方法里，容易泄漏，异常翻译也无法统一。

模板方法的价值在于把这一套固定下来，只留变化点。

### 失败方案二：把行映射逻辑硬编码进 `query` 方法

如果 `query` 只支持一种硬编码的“把结果变成某种对象”方式，就无法同时支持：

- 逐行映射成 List
- 逐行流式处理
- 对整个 ResultSet 做聚合

`RowMapper` / `RowCallbackHandler` / `ResultSetExtractor` 三个接口正是为了按控制粒度拆开这些场景。

### 失败方案三：每个查询方法都重新实现一遍模板骨架

如果每加一种查询就重写连接管理逻辑，模板就失去意义。`JdbcTemplate` 用 `execute` 作为统一的底层模板，`query(sql, RowMapper)`、`query(sql, RowCallbackHandler)`、`update(...)` 等方法都最终委托到这个模板，差异只在回调类型。

## `JdbcTemplate` 主线的简化总图

```text
jdbcTemplate.query(sql, RowMapper)
   -> query 内部包装 rowMapper 为 RowMapperResultSetExtractor
   -> execute(new PreparedStatementCallback { ... })
   -> DataSourceUtils.getConnection(ds)
      -> ThreadLocal 先查当前事务连接
      -> 无则 dataSource.getConnection()
   -> con.createStatement() / prepareStatement
   -> callback.doInStatement / doInPreparedStatement
   -> RowMapperResultSetExtractor.extractData(rs)
   -> finally: DataSourceUtils.releaseConnection(con)
   -> catch: SQLException -> 异常翻译器 -> DataAccessException
```

## 一、`execute(StatementCallback, closeResources)`：模板方法的统一入口

`execute(action, closeResources)` 是 `JdbcTemplate` 所有操作的底层模板。它的骨架是：

1. 获取连接
2. 创建 Statement
3. 应用 Statement 设置（`applyStatementSettings`: 设置 fetchSize、maxRows、queryTimeout 等）
4. 调用回调
5. 如果 `closeResources` 为 true，关闭 Statement 和 ResultSet
6. 释放连接（finally）
7. 异常翻译（catch）

`closeResources` 参数控制是否在 finally 中关闭 Statement 和 ResultSet，默认 true；对于存储过程返回多个结果集等场景，可能需要保留它们不关闭。

这个骨架在不同 SQL 场景下完全相同，所以被收敛成一个方法。`execute(action)` 单参重载只是委托 `execute(action, true)`。

## 二、连接管理：`DataSourceUtils.getConnection(...)` 先查当前事务连接

`getConnection` 是模板里最关键的一段：

```text
DataSourceUtils.getConnection(ds)
   -> TransactionSynchronizationManager.getResource(ds)
      -> 有事务连接: 复用
      -> 无: dataSource.getConnection()
```

这直接接上了前面事务篇的连接共享：事务内所有 `JdbcTemplate` 操作都从 ThreadLocal 取同一连接；非事务时才新建。

对应地，`releaseConnection(con)` 在事务中也不会真正关闭连接，而是保留给 ThreadLocal；非事务才 `con.close()`。

## 三、回调：预留“执行什么 SQL”的变化点

模板把连接管理固定后，把“执行什么 SQL”留给 `StatementCallback.doInStatement(stmt)`。

`query`、`update` 等方法本质上是不同的回调实现：

- `PreparedStatementCallback` 用预处理语句
- `ResultSetExtractor` 处理查询结果
- `BatchPreparedStatementSetter` / `BatchUpdateCallback` 处理批量更新

所有变体共享同一个 `execute` 模板。

## 四、`RowMapper`：把“行 → 对象”的映射逻辑交给你

`RowMapper.mapRow(ResultSet rs, int rowNum)` 是一个单方法接口，负责把**一行**结果映射成一个对象。

`JdbcTemplate` 的 `query(sql, RowMapper)` 把 `RowMapper` 包装成 `RowMapperResultSetExtractor`：

```java
while (rs.next()) {
    results.add(rowMapper.mapRow(rs, rowNum++));
}
```

即 JdbcTemplate 负责遍历 ResultSet、计数，只把“一行怎么映射”交给开发者。ResultSet 的关闭和异常包装由模板统一处理。

## 五、三个结果处理接口的控制粒度

| 接口 | 行为 | 场景 |
|------|------|------|
| `RowMapper` | 逐行映射并收集成 List | 最常见 |
| `RowCallbackHandler` | 逐行处理但不收集 | 流式处理 / 侧写日志 |
| `ResultSetExtractor` | 拿到整个 ResultSet 自行控制 | 分页 / 统计 / 自定义组织 |

三个接口按“控制粒度递增”设计。90% 的场景 `RowMapper` 足够；需要聚合时用 `ResultSetExtractor`；逐行侧写日志时用 `RowCallbackHandler`。

## 六、为什么 `query(...)` 最终也走 `execute` 模板

`query(sql, RowMapper)` 并不会单独实现一套连接管理逻辑。它把自己包装成 `RowMapperResultSetExtractor`，再放进一个 `PreparedStatementCallback` 作为回调，最后调用 `execute`。

也就是说，无论查询还是更新，最终都汇入同一个 `execute` 模板；差异只在回调类型上。

## 七、几个最容易错的判断

### 1. 每次 `jdbcTemplate.query(...)` 都会获得一个新连接

不成立。

`DataSourceUtils.getConnection` 先查当前事务的 ThreadLocal 连接，事务内所有操作共享同一个连接。

### 2. 事务内操作完成后，连接会被真正关闭

不成立。

事务内 `releaseConnection` 不会真正关闭连接，而是保留给 ThreadLocal；非事务才 close。

### 3. `RowMapper` 负责遍历 ResultSet

不成立。

遍历和计数由 `RowMapperResultSetExtractor` / JdbcTemplate 负责，`RowMapper` 只负责把一行映射成对象。

### 4. `RowCallbackHandler` 和 `RowMapper` 行为相同

不成立。

`RowMapper` 收集结果成 List，`RowCallbackHandler` 逐行处理但不收集。

### 5. 每种查询都实现了自己的连接管理逻辑

不成立。

所有操作最终都汇入同一个 `execute` 模板，差异只在回调类型。

## 收网：`JdbcTemplate` 统一的不是“几行便利方法”，而是“JDBC 资源生命周期 + 异常翻译 + 回调抽象”的模板方法协议

现在可以回到开头的问题：为什么一行 `jdbcTemplate.query(...)` 能取代十几次手写 JDBC？

因为 `JdbcTemplate` 把连接管理、Statement 创建、结果遍历、资源释放、异常翻译这些样板步骤收敛进 `execute` 模板方法，只把“执行什么 SQL / 怎么处理结果”留给回调：

```text
execute 模板
   -> 连接管理（ThreadLocal 复用）
   -> Statement 创建
   -> 回调执行 SQL
   -> RowMapper / ResultSetExtractor 处理结果
   -> 释放连接 + 异常翻译
```

因此，这篇真正该带走的结论是：

**Spring 把 JDBC 操作问题从“每次手写连接和资源管理”提升成了“用 `execute` 模板方法固定 JDBC 生命周期和异常翻译，只把 SQL 执行与结果映射留给回调”的模板方法协议。**

这也留下了下一篇最自然的问题：既然 `JdbcTemplate` 的模板骨架和 `RowMapper` 已经立住了，那更专门的 `ResultSetExtractor`、`NamedParameterJdbcTemplate`、批量操作和 RowMapper 的高级用法，又是如何在同一套模板上继续扩展的？

下一篇进入 spring-jdbc 的高级结果处理与模板扩展主线。