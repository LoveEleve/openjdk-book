# 为什么 MyBatis 的 Cursor 不是“懒 List”，而是一套增量消费协议

> 本文基于 MyBatis 3.5.16 当前源码。本文只讲 Cursor、ResultHandler 与增量结果消费：`DefaultSqlSession.selectCursor()` 如何注册 Cursor，`DefaultCursor` 如何维护状态机，`DefaultResultSetHandler` 如何一次只推进一条结果，以及为什么这些行为必须和 Session 生命周期绑在一起。不展开 Spring 集成。

## 为什么“Cursor 就是流式 List”这个印象会害你忽略关键边界

很多人第一次看到 MyBatis 的 Cursor，会给它一个很顺手的标签：

- 它就是一个流式 List

这句话比完全错误要好，但还是会把真正的边界读扁。

因为如果它只是“懒一点的 List”，你很难解释下面这些行为：

- 为什么一个 Cursor 不能开两个 iterator
- 为什么 Session 关闭时要主动把 Cursor 一起关掉
- 为什么 Cursor 自己有 `CREATED/OPEN/CLOSED/CONSUMED` 这套状态机
- 为什么结果消费完自动进入 `CONSUMED`，即使你没手动 close
- 为什么 `cursor_cache_oom` 这类测试讨论的不是 Cursor API 用法，而是它与 Session 缓存边界的耦合

更准确的说法应该是：

**MyBatis 的 Cursor 不是一个返回类型优化，而是一套与 ResultSet、Session 生命周期和 ResultHandler 协同工作的增量消费协议。**

## Cursor 消费的最小总图

```text
DefaultSqlSession.selectCursor()
  -> executor.queryCursor(...)
    -> StatementHandler.queryCursor(...)
      -> DefaultCursor
        -> DefaultResultSetHandler.handleRowValues(...)
          -> ObjectWrapperResultHandler.handleResult(...)
            -> context.stop() 一次只取一条
```

这条链里最重要的点有三个：

1. Cursor 不是独立对象，它从属于当前 `SqlSession`
2. Cursor 不是一次性把结果全拿出来，而是一条一条推进 `ResultSet`
3. `ResultHandler` 在这里不是扩展点，而是流式消费能成立的控制开关

## 一、`DefaultSqlSession.selectCursor()`：为什么 Cursor 一定要注册到 Session

入口在：

- `session/defaults/DefaultSqlSession.java:120` `selectCursor(...)`
- `session/defaults/DefaultSqlSession.java:271` `closeCursors()`

`selectCursor(...)` 做的不只是发起查询：

1. 先拿 `MappedStatement`
2. 更新 `dirty` 语义
3. 调 `executor.queryCursor(...)`
4. `registerCursor(cursor)` 把它挂到当前 Session
5. 返回 Cursor

这个注册动作很关键。

它说明 MyBatis 不把 Cursor 当成“调用者拿走后完全自理的对象”，而是把它视为当前会话尚未完全收束的外部资源句柄。

这也解释了为什么 `DefaultSqlSession.close()` 后面一定要 `closeCursors()`：

- 因为只要 Cursor 还挂在 Session 上，这个会话就不能算真正收口。

## 二、`DefaultCursor`：为什么它需要一套明确的状态机

核心类是：

- `cursor/Cursor.java:27` 接口声明
- `cursor/defaults/DefaultCursor.java:36` 类声明
- `cursor/defaults/DefaultCursor.java:48` `CursorStatus`

`DefaultCursor` 的状态机不是装饰，而是在定义资源语义：

- `CREATED`：刚创建，结果还没开始消费
- `OPEN`：正在推进 ResultSet
- `CLOSED`：提前关闭，未必已消费完
- `CONSUMED`：已全部消费完；消费完一定也意味着关闭

这说明 Cursor 不是“有无数据”的对象，而是“当前和底层 ResultSet 的关系处于哪个阶段”的对象。

也就是说，MyBatis 非常明确地区分：

- 还没开始消费
- 正在消费
- 主动中止
- 自然读尽

这四种状态不该混在一起。

## 三、为什么 `iterator()` 只能调一次：因为一个 Cursor 对应的是一条推进中的 ResultSet

- `cursor/defaults/DefaultCursor.java:94` `iterator()`

`iterator()` 一进来就做两件强约束：

1. 如果 `iteratorRetrieved` 已经为真，直接抛 `Cannot open more than one iterator on a Cursor`
2. 如果已经 closed，直接抛 `A Cursor is already closed.`

这背后的语义非常清晰：

- 一个 Cursor 背后不是一个可重复遍历的内存集合
- 它背后是一条正在被推进的 ResultSet 消费通道

如果允许多个 iterator 并发读取，就等于允许多个人同时移动同一个 JDBC 游标位置，语义天然会乱掉。

所以 “单 iterator” 不是 API 设计偏好，而是底层资源模型直接推出来的约束。

`cursor_simple` 相关测试的意义就在这里：它证明多 iterator、close 后继续使用这类行为必须 fail-fast，而不是悄悄出错。

## 四、`fetchNextObjectFromDatabase()`：为什么 Cursor 真正做到的是“一次只拉一条”

- `cursor/defaults/DefaultCursor.java:124` `fetchNextUsingRowBound()`
- `cursor/defaults/DefaultCursor.java:132` `fetchNextObjectFromDatabase()`

真正的流式推进发生在 `fetchNextObjectFromDatabase()`：

1. 如果已关闭，直接返回 null
2. 重置 `objectWrapperResultHandler.fetched = false`
3. 把状态设成 `OPEN`
4. 调 `resultSetHandler.handleRowValues(...)`
5. 如果本次真的抓到一条结果，就递增索引
6. 如果没抓到，或者达到 RowBounds 限制，就 `close()` 并把状态设成 `CONSUMED`

最关键的是第 4 步配合 `ObjectWrapperResultHandler`：

- `DefaultResultSetHandler` 会尝试处理行
- 但 `ObjectWrapperResultHandler.handleResult(...)` 一拿到一条对象就 `context.stop()`

这意味着 Cursor 模式下，结果处理器不是要“把这个 ResultSet 全部装完”，而是：

**每推进一次，只允许装出一条对象，然后立刻停住。**

这就是它和 `selectList()` 的根本差异。

## 五、`ResultHandler` / `DefaultResultContext.stop()`：流式消费真正成立的开关在这里

关键点在：

- `session/ResultHandler.java:21` 接口声明
- `executor/result/DefaultResultContext.java:29` 构造函数
- `executor/result/DefaultResultContext.java:55` `stop()`
- `executor/resultset/DefaultResultSetHandler.java:330` `handleRowValues(...)`
- `cursor/defaults/DefaultCursor.java:169` `ObjectWrapperResultHandler`

`ResultHandler` 本身看起来很轻，只暴露了一个：

- `handleResult(ResultContext<? extends T> resultContext)`

但在 Cursor 路径里，它承担的是“什么时候停”的控制权。

`ObjectWrapperResultHandler.handleResult(...)` 的语义非常直接：

1. 取出当前结果对象
2. `context.stop()`
3. 标记本次确实 fetched 到一条

所以 Cursor 能够做到“一次只消费一条”，不是因为 JDBC 驱动 magically 只给它一条，而是因为：

**结果处理协议被改写成‘装一条就停，再由外层决定要不要继续推进’。**

## 六、RowBounds、nested result map 与 Cursor：为什么这些边界会让流式消费变复杂

`DefaultCursor.fetchNextUsingRowBound()` 说明了 RowBounds 的处理并不是 JDBC 层跳过，而是 Cursor 自己推进到 offset 之后才开始对外暴露结果。

这意味着：

- RowBounds 在 Cursor 模式下不是零成本过滤
- 它依然要消费前面的行，只是不返回给调用方

再看：

- `executor/resultset/DefaultResultSetHandler.java:330` `handleRowValues(...)`

它会先判断：

- `resultMap.hasNestedResultMaps()`

如果是 nested result map，还会额外检查 rowBounds / resultHandler 的限制。

这说明 Cursor 并不是对所有结果映射形态都天然轻巧；一旦结果装配需要跨多行拼对象图，流式消费和对象图装配之间就会出现张力。

这也正是 `cursor_cache_oom` 这类测试存在的意义：

- 它不是在演示 Cursor API，而是在暴露“流式消费 + nested result map + Session 状态”交织时的真实边界。

## 七、失败路径：为什么 Cursor 专题的价值主要在资源边界，而不是遍历语法

### 1. 多 iterator

`iterator()` 直接 fail-fast。

### 2. 已关闭后继续读

`isClosed()` 检查会阻止继续推进。

### 3. ResultSet 已经关闭

`DefaultCursorTest.shouldCloseImmediatelyIfResultSetIsClosed` 说明 Cursor 会在底层 ResultSet 已关闭时尽快转入关闭状态，而不是继续冒险推进。

### 4. Session 提前关闭

只要 `DefaultSqlSession.close()` 走到 `closeCursors()`，挂在 Session 上的 Cursor 都会被级联关闭。

### 5. 结果消费完毕

即使调用方没显式 close，只要读到尽头也会自动进 `CONSUMED`。

所以 Cursor 的主题不是“怎么遍历”，而是：

**底层 ResultSet、Session 生命周期和调用方消费节奏之间，谁在什么时刻拥有关闭权。**

## 八、`cursor_cache_oom`：为什么 Cursor 必须和 Session/缓存边界一起看

`cursor_cache_oom` 的价值不在于“有个 OOM 用例”，而在于它提醒我们：

- Cursor 的目标是避免把整个结果集一次性物化进内存
- 但只要结果处理或 Session 缓存策略仍在积累对象图，问题并不会自动消失

所以 Cursor 不是“打开它就自动高性能”的开关，而是：

- 一种增量消费协议
- 仍然需要和 ResultMap 形态、Session 生命周期、缓存边界一起理解

这也正是为什么本篇应该放在结果装配之后，而不是更前面：

- 先知道对象图是怎么被拼的
- 再知道“只拼一条、逐步往前推”意味着什么

## 到这里，M-8 真正立住的不是一个返回类型，而是“增量消费协议”

如果只看类名，这篇很容易被读成：

- `Cursor` 是接口
- `DefaultCursor` 是实现
- `ResultHandler` 是回调

这当然都对，但还不够。

更稳的理解方式应该是：

1. `DefaultSqlSession` 负责把 Cursor 纳入会话生命周期
2. `DefaultCursor` 负责维护 ResultSet 推进状态机和单 iterator 约束
3. `ResultHandler` / `DefaultResultContext.stop()` 负责把“整批处理”改写成“一次一条”
4. RowBounds、nested result map、Session 关闭都会改变这套增量消费协议的实际行为

所以这篇真正立住的是：

**MyBatis 的 Cursor 不是懒 List，而是一套受 Session 生命周期约束的增量结果消费协议。**

## 这篇之后，最自然的继续方向

到这里，MyBatis 核心与机制补深层还剩最后一个重要入口问题：

- XML mapper 与注解 mapper 是怎样双入口并回同一套 `MappedStatement` 主线的？

也就是说，下一篇应该进入 `M-9 XML 与注解 Mapper 双入口`。