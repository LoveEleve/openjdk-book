# Druid Ch8-01 PreparedStatementPool — 正文写作规划

## 文章定位
- 写作卷：`vol-druid`
- 章节：Ch8 PreparedStatementPool
- 篇：01 为什么 per-connection 的 PreparedStatement 也要池化
- 对应主题：`D-8 PreparedStatementPool`
- 文章类型：连接内部复用补深篇

## 前置依赖
- HARD：读者应已读过 D-1 连接池核心，知道 `DruidConnectionHolder` 是每条连接的持有者
- SOFT：与 Filter 链关系不大，但要理解“连接与 PreparedStatement 是同一个生命域”

## 一句话困惑
为什么 Druid 不在 DataSource 级缓存 PreparedStatement，而要在每一条连接（`DruidConnectionHolder`）里各维护一个 `PreparedStatementPool`？

## 一句话顿悟
PreparedStatement 是绑定在 Connection 上的，不能跨连接复用，所以缓存必须 per-connection：用它避免相同 SQL 反复解析与重复 prepare，由 `maxPoolPreparedStatementPerConnectionSize`（默认 10）通过 `LRUCache` 控制上限。

## 读者理解路径
1. 从“为什么 PreparedStatement 不能跨连接复用”切入
2. 最小总图：`DruidConnectionHolder -> PreparedStatementPool -> LRUCache<PreparedStatementKey, PreparedStatementHolder>`
3. 解释 `PreparedStatementPool` 结构
4. 解释 `get()` / `put()` 两个入口
5. 解释 `LRUCache` 淘汰机制
6. 解释 `PreparedStatementHolder` 与 `DruidPooledPreparedStatement` 的关系
7. 收束：per-connection 的 SQL 复用池

## 文章结构与字数预算
1. 困惑开场（800-1000 字）
2. 最小总图：Connection -> PreparedStatementPool -> LRU（1200-1500 字）
3. 为什么必须 per-connection（1200-1600 字）
4. `PreparedStatementPool` 结构与 `get()`/`put()`（1800-2400 字）
5. `LRUCache` 淘汰机制（1200-1800 字）
6. `PreparedStatementHolder` 与 `DruidPooledPreparedStatement`（1400-2000 字）
7. 收网总结（800-1000 字）

## 证据清单
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
- 需确认 `PreparedStatementKey` 定义位置

## 写作后检查
- [ ] 开篇不是 API 说明，而是“为什么 per-connection 池化”的困惑
- [ ] 总图明确区分：Connection / Pool / LRU / Key / Holder
- [ ] 不把 PreparedStatementPool 误写成 DataSource 级共享池
- [ ] 所有 file:line 写作时重新 grep 验证