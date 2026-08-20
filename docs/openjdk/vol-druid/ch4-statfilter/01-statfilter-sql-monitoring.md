# 为什么 Druid 能在不侵入业务代码的情况下统计每条 SQL

> 本文基于 Druid 1.2.27 当前源码。本文只讲 StatFilter 的 SQL 监控实现：`statementExecuteBefore`/`After` 钩子、SQL 参数化、慢 SQL 检测、三层统计结构。不展开 WallFilter 或 SQL 解析器的 AST 细节。

## 为什么不需要业务代码埋点

如果你用过 HikariCP，你就会知道它没有内置 SQL 监控。想监控 SQL，必须靠外部 Micrometer 或手动埋点。

但 Druid 不一样。Druid 在 Filter 链骨架（D-2 已讲）上插了一个 `StatFilter`，它就能自动统计：

- 每条 SQL 的执行次数
- 总耗时、最大耗时
- 读取行数、更新行数
- 并发数
- 慢 SQL 日志
- 还能把 `WHERE id=123` 合并成 `WHERE id=?`

这一切不需要业务代码做任何改动。

## StatFilter 的最小总图

```text
FilterChainImpl 推进
  -> statFilter.statementExecuteBefore(statement, sql)
    -> 记录开始时间、计数
  -> 实际 JDBC 执行
  -> statFilter.statementExecuteAfter(statement, sql, result)
    -> 计算耗时、更新统计、慢 SQL 检测
```

## 一、`statementExecuteBefore` / `statementExecuteAfter` 钩子

StatFilter 不是一个独立的“统计线程”，它是 `FilterEventAdapter` 的子类，在 `FilterChainImpl` 推进时被调用：

- `StatFilter.java:47` 类声明
- `StatFilter.java:368` `statementExecuteQueryBefore(StatementProxy, String sql)`
- `StatFilter.java:373` `statementExecuteQueryAfter(StatementProxy, String sql, ResultSetProxy)`
- `StatFilter.java:378` `statementExecuteBefore(StatementProxy, String sql)`
- `StatFilter.java:383` `statementExecuteAfter(StatementProxy, String sql, boolean firstResult)`

在 `executeBefore` 方法中，StatFilter 会调用：

- `StatFilter.java:457` `StatFilterContext.getInstance().executeBefore(sql, inTransaction)`

在 `executeAfter` 方法中，它计算耗时并更新统计：

- `StatFilter.java:500` `if (millis >= slowSqlMillis)`——慢 SQL 检测
- `StatFilter.java:527` `StatFilterContext.getInstance().executeAfter(sql, nanos, null)`——成功路径
- `StatFilter.java:558` `StatFilterContext.getInstance().executeAfter(sql, nanos, error)`——异常路径

所以 StatFilter 的统计逻辑不是“定时采样”，而是植入了每个 JDBC 操作的前后。

## 二、SQL 参数化：`ParameterizedOutputVisitorUtils.parameterize()`

StatFilter 的 `mergeSql` 功能可以把具体 SQL 合并成参数化形式：

- `StatFilter.java:79` `private boolean mergeSql;`
- `StatFilter.java:143` `mergeSql(String sql)` 方法
- `StatFilter.java:158` 内部调用 `ParameterizedOutputVisitorUtils.parameterize(sql, dbType, ...)`
- `StatFilter.java:692` 在统计前执行 `sql = mergeSql(sql, dbType)` 替换原始 SQL

`ParameterizedOutputVisitorUtils` 本身是 Druid SQL 解析器的一部分：

- `ParameterizedOutputVisitorUtils.java:54` 类声明
- `ParameterizedOutputVisitorUtils.java:83` `parameterize(String sql, DbType dbType)` 入口
- `ParameterizedOutputVisitorUtils.java:152` 最重载的实现

它使用 SQL 解析器的 AST 遍历能力，把字面量合并为 `?`，把 `WHERE id=123` 变成 `WHERE id=?`。

## 三、慢 SQL 检测：`slowSqlMillis`

StatFilter 的慢 SQL 检测由 `slowSqlMillis` 控制：

- `StatFilter.java:51` `SYS_PROP_SLOW_SQL_MILLIS = "druid.stat.slowSqlMillis"`
- `StatFilter.java:71` `protected long slowSqlMillis = 3 * 1000`
- `StatFilter.java:500` `if (millis >= slowSqlMillis)`

默认 3 秒，可以通过系统属性 `druid.stat.slowSqlMillis` 或 `setSlowSqlMillis()` 修改。

当 `millis >= slowSqlMillis` 时，StatFilter 会输出慢 SQL 日志。这个判断放在 `executeAfter` 路径中，所以慢 SQL 不需要专门的监控线程。

## 四、三层统计结构

StatFilter 的统计结果不是直接存在 `StatFilter` 实例里的，而是委托给一套三层结构：

1. `StatFilterContext`：单例，提供 `executeBefore` / `executeAfter` 入口
2. `JdbcDataSourceStat`：数据源级统计，聚合所有 SQL 的统计结果
   - `JdbcDataSourceStat.java:38` 类声明
3. `JdbcSqlStat`：单条 SQL 的统计，包含执行次数、总耗时、最大耗时、并发数、直方图
   - `JdbcSqlStat.java:33` 类声明

这个分层结构让 Druid 可以按 DataSource → SQL 维度聚合展示。

## 本篇真正立住的，不是 StatFilter 的配置，而是“植入钩子 + 参数化 + 分层统计”这条链

1. `statementExecuteBefore`/`After` 钩子实现了“不侵入业务代码的统计”
2. `ParameterizedOutputVisitorUtils.parameterize()` 实现了 SQL 参数化
3. `slowSqlMillis` 实现了慢 SQL 检测
4. `StatFilterContext` / `JdbcDataSourceStat` / `JdbcSqlStat` 实现了三层统计

## 这篇之后，最自然的继续方向

StatFilter 立住后，下一步是 WallFilter——它利用同样的 Filter 链骨架做 SQL 注入防护。