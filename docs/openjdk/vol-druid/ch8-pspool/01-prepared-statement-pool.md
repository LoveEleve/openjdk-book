# 为什么 PreparedStatement 也要 per-connection 池化

> 本文基于 Druid 1.2.27 当前源码。本文只讲 PreparedStatement 复用：为什么缓存必须挂在每条连接上，而不是挂在 DataSource 上；`PreparedStatementPool` 如何用 `LRUCache` 控制上限；`get()`/`put()` 两个入口如何工作。不重讲池本体借出/归还。

## 为什么 PreparedStatement 不能跨连接复用

如果你从“复用能省解析成本”这个角度想，很容易产生一个直觉：直接在 DataSource 级缓存 PreparedStatement 不就行了？

但这是错的。

PreparedStatement 不是独立于 Connection 的对象。它本质上是“Connection 上预先编译好的一段 SQL”。同一个 PreparedStatement 只能作用在它所属的那条 Connection 上。

所以：

- Connection A 上的 PreparedStatement，不能拿去给 Connection B 用
- 跨连接复用会直接违反“一条 prepare 属于一条连接”的语义

这也是为什么 Druid 不能做“DataSource 级 PreparedStatement 池”，而必须在每条连接的持有者 `DruidConnectionHolder` 上各自维护一个 `PreparedStatementPool`。

## per-connection 缓存的最小总图

```text
DruidConnectionHolder
  -> PreparedStatementPool
    -> LRUCache<PreparedStatementKey, PreparedStatementHolder>
```

缓存与连接同生共死，连接归还不销毁时，缓存继续保留。

## 一、为什么必须挂在 `DruidConnectionHolder` 上

在 D-1 我们已经知道，`DruidConnectionHolder` 是单条连接的完整持有者。

所以 PreparedStatement 池也必须挂在它下面。因为：

- PreparedStatement 属于这条连接
- 它的生命周期应该和这条连接对齐
- 连接被重新分配时，它的 PreparedStatement 缓存仍然有效（如果连接没被真正关闭）

这正是“per-connection”和“per-datasource”的本质差别。Druid 用 holder 承载这个关系，而不是用一个全局池。

## 二、`PreparedStatementPool` 的结构

`PreparedStatementPool` 的核心是一个 `LRUCache`：

- `PreparedStatementPool.java:35` 类声明
- `PreparedStatementPool.java:38` `private final LRUCache map;`
- `PreparedStatementPool.java:47` `map = new LRUCache(initCapacity);`
- `PreparedStatementPool.java:185` `public class LRUCache extends LinkedHashMap<...>`

它的容量通过 `maxPoolPreparedStatementPerConnectionSize` 控制，默认值是 10：

- `DruidAbstractDataSource.java:118` `protected volatile int maxPoolPreparedStatementPerConnectionSize = 10;`
- `DruidAbstractDataSource.java:637` `this.poolPreparedStatements = maxPoolPreparedStatementPerConnectionSize > 0;`

也就是说，一条连接默认最多缓存 10 条 PreparedStatement，超出后按 LRU 淘汰。

## 三、`get()` / `put()` 两个入口

`PreparedStatementPool` 对外暴露两个关键入口：

- `PreparedStatementPool.java:54` `get(PreparedStatementKey key)`
- `PreparedStatementPool.java:82` `put(PreparedStatementHolder stmtHolder)`
- `PreparedStatementPool.java:96` `map.put(stmtHolder.key, stmtHolder)`

- `get(key)`：根据 key 从 LRU 中找
- `put(holder)`：把一个 prepared 放回池，走 LRU 淘汰

`PreparedStatementKey` 不是简单字符串，它定义在 `DruidPooledPreparedStatement.java:910`（内部静态类 `PreparedStatementKey`）。

正因为 key 捕捉了“这条 SQL 在什么连接、什么参数场景下 prepared”，所以 keys 能区分不同 same SQL 但不同绑定场景的 prepare。

## 四、`PreparedStatementHolder` 与 `DruidPooledPreparedStatement`

缓存的 value 不是裸 `PreparedStatement`，而是 `PreparedStatementHolder`：

- `PreparedStatementHolder.java:25` 类声明

它持有：

- 这条 PreparedStatement 的 key
- 底层 PreparedStatement
- 相关统计/状态

对外暴露给用户的则通常是 `DruidPooledPreparedStatement`：

- `DruidPooledPreparedStatement.java:34` 类声明
- `DruidPooledPreparedStatement.java:37` `protected final PreparedStatementHolder holder;`

也就是说：

- `PreparedStatementPool` 管缓存
- `PreparedStatementHolder` 管单条缓存的被 holder 对象
- `DruidPooledPreparedStatement` 是用户拿到的代理对象

三者各司其职。

## 这一篇真正立住的，不是“有没存 prepared”，而是“为什么必须 per-connection 存”

很多人第一次看到 Druid 的 PreparedStatementPool，会以为它和连接池一样，是一个“全局复用池”。

但它的本质更细：

1. PreparedStatement 绑定 Connection，所以缓存必须 per-connection
2. `PreparedStatementPool` 挂在 `DruidConnectionHolder` 下
3. 通过 `LRUCache<PreparedStatementKey, PreparedStatementHolder>` 控制上限
4. 默认每连接最多缓存 10 条
5. `get()/put()` 两个入口负责复用与淘汰

所以这篇真正立住的，不是“能缓存 SQL”，而是 **Druid 把 SQL 复用边界精确地放在“单条连接”上**。

## 这篇之后，最自然的继续方向

到这里，`vol-druid` 的骨架层、Filter 层、监控/安全层、解析器地基、验证、PreparedStatementPool 都已立住。最后一步是 D-9 Spring Boot 3 Starter 集成层，把整卷接到真实应用装配上。