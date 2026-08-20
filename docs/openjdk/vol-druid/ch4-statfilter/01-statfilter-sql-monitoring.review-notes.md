# Druid D-3 StatFilter SQL 监控 — review notes

## 一次性深审收口（六类合一）

### 事实审
已核实并回填正文的全部锚点：
- `StatFilter.java:47` 类声明
- `StatFilter.java:71` `slowSqlMillis = 3 * 1000`
- `StatFilter.java:79` `mergeSql`
- `StatFilter.java:143` `mergeSql(String sql)`
- `StatFilter.java:158` `ParameterizedOutputVisitorUtils.parameterize(sql, dbType, ...)`
- `StatFilter.java:368` `statementExecuteQueryBefore`
- `StatFilter.java:373` `statementExecuteQueryAfter`
- `StatFilter.java:378` `statementExecuteBefore`
- `StatFilter.java:383` `statementExecuteAfter`
- `StatFilter.java:457` `StatFilterContext.getInstance().executeBefore(sql, inTransaction)`
- `StatFilter.java:500` `if (millis >= slowSqlMillis)`
- `StatFilter.java:527` `executeAfter(sql, nanos, null)`
- `StatFilter.java:692` `sql = mergeSql(sql, dbType)`
- `JdbcDataSourceStat.java:38` 类声明
- `JdbcSqlStat.java:33` 类声明
- `ParameterizedOutputVisitorUtils.java:54` 类声明
- `ParameterizedOutputVisitorUtils.java:83` `parameterize(String sql, DbType dbType)` 入口
- `ParameterizedOutputVisitorUtils.java:152` 最重载 `parameterize` 实现

所有锚点均在源码实存，正文首稿直接带锚点，无二次补锚。

### 因果审
1. StatFilter 不是“额外加的统计代码”，而是 Filter 链骨架上的 Before/After 钩子 → 成立
2. `statementExecuteBefore`/`After` 记录时间差实现统计 → 成立
3. `ParameterizedOutputVisitorUtils.parameterize()` 合并字面量 → 成立
4. `slowSqlMillis` 控制慢 SQL 日志 → 成立
5. 三层统计结构实现聚合 → 成立

### 结构审
困惑 → 总图 → Before/After 钩子 → 参数化 → 慢 SQL → 三层统计 → 收网 → 下篇桥接。没有按包目录翻译。

### 读者审
读者读完应能：
- 知道为什么不需要业务代码埋点
- 知道 `statementExecuteBefore`/`After` 是钩子
- 知道 `ParameterizedOutputVisitorUtils.parameterize()` 做 SQL 合并
- 知道 `slowSqlMillis` 阈值
- 知道 StatFilterContext / JdbcDataSourceStat / JdbcSqlStat 三层

### 边界审
本篇只讲 StatFilter，没有提前透支 WallFilter 或 SQL 解析器 AST 细节。边界清晰。

### 依赖审
- 前置依赖：D-2 Filter 链骨架
- 后续桥接：WallFilter，合理

### 结论
本篇已通过一次性深审收口，正文首稿直接带锚点，无二次补锚。D-3 可正式收口。

### 下一步
1. 以当前稿为准收口 D-3
2. 进入 D-4 WallFilter SQL 防火墙 的 rewrite-plan