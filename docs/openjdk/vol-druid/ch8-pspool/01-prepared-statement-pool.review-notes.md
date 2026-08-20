# Druid D-8 PreparedStatementPool — review notes

## 一次性深审收口（六类合一）

### 事实审
已核实并回填正文的全部锚点：
- `DruidAbstractDataSource.java:118` `maxPoolPreparedStatementPerConnectionSize = 10`
- `DruidAbstractDataSource.java:637` `poolPreparedStatements = maxPoolPreparedStatementPerConnectionSize > 0`
- `PreparedStatementPool.java:35` 类声明
- `PreparedStatementPool.java:38` `LRUCache map`
- `PreparedStatementPool.java:47` `map = new LRUCache(initCapacity)`
- `PreparedStatementPool.java:54` `get(PreparedStatementKey key)`
- `PreparedStatementPool.java:82` `put(PreparedStatementHolder stmtHolder)`
- `PreparedStatementPool.java:96` `map.put(stmtHolder.key, stmtHolder)`
- `PreparedStatementPool.java:185` `LRUCache extends LinkedHashMap`
- `PreparedStatementHolder.java:25` 类声明
- `DruidPooledPreparedStatement.java:34` 类声明
- `DruidPooledPreparedStatement.java:37` `holder` 字段
- `DruidPooledPreparedStatement.java:910` `PreparedStatementKey` 内部静态类

所有锚点均在源码实存，正文首稿直接带锚点，无二次补锚。

### 因果审
1. PreparedStatement 绑定 Connection，不能跨连接复用 → 成立
2. 所以缓存必须 per-connection，挂在 `DruidConnectionHolder` 下 → 成立
3. `LRUCache<PreparedStatementKey, PreparedStatementHolder>` 控制复用与淘汰 → 成立
4. 默认每连接缓存 10 条 → 成立
5. `get()/put()` 两个入口负责复用 → 成立

### 结构审
困惑（为什么不能 DataSource 级缓存）→ 总图 → 为什么挂 holder → Pool 结构 → get/put → Holder 与代理对象 → 收网。没有按文件目录翻译。

### 读者审
读者读完应能：
- 知道 PreparedStatement 绑定 Connection 这个约束
- 知道缓存为什么必须 per-connection
- 知道 PreparedStatementPool / PreparedStatementHolder / DruidPooledPreparedStatement 三层
- 知道默认上限是 10 条

### 边界审
本篇只讲 PreparedStatement 复用，没有重讲 SQL 解析或连接池借出。边界清晰。

### 依赖审
- 前置：D-1 连接池核心（Holder 概念）
- 后置：D-9 Spring Boot Starter

### 结论
本篇已通过一次性深审收口，正文首稿直接带锚点，无二次补锚。D-8 可正式收口。

### 下一步
1. 以当前稿为准收口 D-8
2. 进入 D-9 Spring Boot 3 Starter 的 rewrite-plan（vol-druid 最后一篇）