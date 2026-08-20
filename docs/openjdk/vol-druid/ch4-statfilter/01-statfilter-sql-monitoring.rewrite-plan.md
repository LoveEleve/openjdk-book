# Druid Ch4-01 StatFilter SQL 监控 — 正文写作规划

## 文章定位
- 写作卷：`vol-druid`
- 章节：Ch4 StatFilter
- 篇：01 为什么 Druid 能在不侵入业务代码的情况下统计每条 SQL
- 对应主题：`D-3 StatFilter SQL 监控`
- 文章类型：监控实现篇

## 前置依赖
- HARD：读者应已读过 D-2 Filter 链，知道 `FilterChainImpl` 递归链模型，知道 `nextFilter()` 如何推进
- SOFT：后续 WallFilter 会用到 SQL 解析器，但本篇不展开解析器细节

## 一句话困惑
为什么业务代码不需要任何埋点，Druid 就能自动统计每条 SQL 的执行次数、耗时、行数，还能把 `WHERE id=123` 合并成 `WHERE id=?`？

## 一句话顿悟
StatFilter 不是“额外加的统计代码”，而是利用 Druid 的 Filter 链骨架，在 `statementExecuteBefore` / `statementExecuteAfter` 两个钩子里做一次时间差和并发计数——SQL 参数化由 `ParameterizedOutputVisitorUtils.parameterize()` 完成，慢 SQL 检测由 `slowSqlMillis` 阈值控制。

## 读者理解路径
1. 从“为什么不需要埋点”切入，回看 D-2 的 Filter 链
2. 最小总图：`statementExecuteBefore -> executeBefore -> 记录耗时 -> statementExecuteAfter -> executeAfter -> 结束`
3. 解释 `statementExecuteBefore`/`After` 钩子
4. 解释 `ParameterizedOutputVisitorUtils.parameterize()` 如何把字面量合并为 `?`
5. 解释 `slowSqlMillis` 慢 SQL 检测
6. 解释 `StatFilterContext` / `JdbcDataSourceStat` / `JdbcSqlStat` 三层统计结构
7. 收束：StatFilter 是 Filter 链骨架上的一个具体实现

## 文章结构与字数预算
1. 困惑开场（800-1000 字）
2. 最小总图：Before/After 钩子（1200-1500 字）
3. `statementExecuteBefore` / `statementExecuteAfter` 钩子（1800-2400 字）
4. SQL 参数化：`ParameterizedOutputVisitorUtils.parameterize()`（1400-2000 字）
5. 慢 SQL 检测：`slowSqlMillis`（1000-1400 字）
6. 三层统计结构：StatFilterContext / JdbcDataSourceStat / JdbcSqlStat（1600-2200 字）
7. 收网总结（800-1000 字）

## 证据清单
- `StatFilter.java:47` 类声明
- `StatFilter.java:71` `slowSqlMillis = 3 * 1000`
- `StatFilter.java:79` `mergeSql`
- `StatFilter.java:143` `mergeSql(String sql)`
- `StatFilter.java:158` `ParameterizedOutputVisitorUtils.parameterize(sql, dbType, …)`
- `StatFilter.java:368` `statementExecuteQueryBefore`
- `StatFilter.java:373` `statementExecuteQueryAfter`
- `StatFilter.java:378` `statementExecuteBefore`
- `StatFilter.java:383` `statementExecuteAfter`
- `StatFilter.java:457` `StatFilterContext.getInstance().executeBefore(sql, inTransaction)`
- `StatFilter.java:500` `if (millis >= slowSqlMillis)`
- `StatFilter.java:527` `StatFilterContext.getInstance().executeAfter(sql, nanos, null)`
- `StatFilter.java:692` `sql = mergeSql(sql, dbType)`
- `JdbcDataSourceStat.java:38` 类声明
- `JdbcSqlStat.java:33` 类声明
- `ParameterizedOutputVisitorUtils.java:54` 类声明
- `ParameterizedOutputVisitorUtils.java:83` `parameterize(String sql, DbType dbType)` 入口
- `ParameterizedOutputVisitorUtils.java:152` 最重载的 `parameterize` 实现

## 写作后检查
- [ ] 开篇不是 API 说明，而是“为什么不需要埋点”的困惑
- [ ] 至少 2 个失败方案
- [ ] 总图明确区分：Before/After 钩子、参数化、慢 SQL、三层统计
- [ ] 所有 file:line 写作时重新 grep 验证