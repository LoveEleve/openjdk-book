# 篇：01 Cursor、ResultHandler 与增量结果消费

- 域：`M-8 Cursor、ResultHandler 与增量结果消费`
- 卷：`vol-mybatis`
- 目标：回答 Cursor 为什么不是一个普通集合返回值，而是一套与 `SqlSession` 生命周期、`ResultHandler`、`RowBounds` 和 ResultSet 关闭协议绑定在一起的增量消费机制。

## 前置依赖

- HARD：已读 `M-3`、`M-4`、`M-7`。

## 读者问题

为什么 MyBatis 既有 `selectList()`，又要专门提供 `selectCursor()` 和 `ResultHandler`？以及：

1. 为什么 Cursor 不能打开多个 iterator
2. 为什么 Session 关闭时必须级联关闭 Cursor
3. 为什么 Cursor 的“已消费完”不等于“用户显式 close 了它”
4. 为什么 nested result map / RowBounds / ResultHandler 会影响 Cursor 行为
5. 为什么 `cursor_cache_oom` 这类测试会把 Cursor 和 Session 缓存边界绑在一起

## 主结论

MyBatis 的 Cursor 不是“懒 List”，而是：

`DefaultSqlSession.selectCursor()`
  -> `executor.queryCursor(...)`
    -> `StatementHandler.queryCursor(...)`
      -> `DefaultCursor`
        -> `DefaultResultSetHandler.handleRowValues(...)`
          -> `ObjectWrapperResultHandler`
            -> 一次只取一条结果

同时：

- `DefaultSqlSession` 负责注册 Cursor，并在 `close()` 时级联关闭
- `DefaultCursor` 自己维护 `CREATED/OPEN/CLOSED/CONSUMED` 状态机
- `ResultHandler` 让结果处理器可以“取一条就停”，从而实现流式消费

## 结构设计

1. 困惑开场：为什么 Cursor 不是“返回 Iterator 的 List”
2. 最小总图：`selectCursor()` -> `queryCursor()` -> `DefaultCursor`
3. `DefaultSqlSession.selectCursor()`：Cursor 为什么要注册到 Session
4. `DefaultCursor`：状态机、单 iterator 约束与 close 语义
5. `fetchNextObjectFromDatabase()`：为什么一次只推进一条
6. `ResultHandler` / `DefaultResultContext.stop()`：流式消费是如何被实现的
7. RowBounds、nested result map 与 Cursor 的边界
8. 失败路径：多 iterator、已关闭后继续读、Session 提前关闭、ResultSet 已关闭
9. `cursor_cache_oom`：为什么 Cursor 必须和 Session/缓存边界一起看
10. 收网：这篇立住的是“增量消费协议”，不是一个返回类型说明
11. 下篇桥接：进入 XML/注解双入口，或回到 Spring 集成层

## 必须回填的源码锚点

- `session/defaults/DefaultSqlSession.java:120` `selectCursor(...)`
- `session/defaults/DefaultSqlSession.java:271` `closeCursors()`
- `cursor/Cursor.java:27` 接口声明
- `cursor/defaults/DefaultCursor.java:36` 类声明
- `cursor/defaults/DefaultCursor.java:48` `CursorStatus`
- `cursor/defaults/DefaultCursor.java:94` `iterator()`
- `cursor/defaults/DefaultCursor.java:106` `close()`
- `cursor/defaults/DefaultCursor.java:124` `fetchNextUsingRowBound()`
- `cursor/defaults/DefaultCursor.java:132` `fetchNextObjectFromDatabase()`
- `cursor/defaults/DefaultCursor.java:169` `ObjectWrapperResultHandler`
- `cursor/defaults/DefaultCursor.java:194` `CursorIterator.hasNext()`
- `cursor/defaults/DefaultCursor.java:202` `CursorIterator.next()`
- `session/ResultHandler.java:21` 接口声明
- `executor/result/DefaultResultContext.java:29` 构造函数
- `executor/result/DefaultResultContext.java:55` `stop()`
- `executor/resultset/DefaultResultSetHandler.java:330` `handleRowValues(...)`

## 必须引用的测试/证据

- `DefaultCursorTest`：ResultSet 已关闭、状态边界
- `cursor_simple`：多 iterator、close 后继续使用、session close 级联关闭
- `cursor_cache_oom`：流式消费与会话缓存边界
- `SqlSessionTest.shouldOpenAndClose`：Session 生命周期侧证据

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。