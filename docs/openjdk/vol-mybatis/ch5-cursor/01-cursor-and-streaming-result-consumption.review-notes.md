# M-8 Cursor、ResultHandler 与增量结果消费 — review notes

## 事实审

- 已核对 `session/defaults/DefaultSqlSession.java:120`、`:271`，Cursor 注册与 Session 关闭级联清理主线成立。
- 已核对 `cursor/Cursor.java:27`、`cursor/defaults/DefaultCursor.java:36`、`:48`、`:94`、`:106`、`:124`、`:132`、`:169`、`:194`、`:202`，Cursor 接口、状态机、单 iterator 约束、逐条推进和内部 ResultHandler 主线成立。
- 已核对 `session/ResultHandler.java:21`、`executor/result/DefaultResultContext.java:29`、`:55`、`executor/resultset/DefaultResultSetHandler.java:330`，ResultHandler 和 stop 机制成立。
- 已补测试证据：`DefaultCursorTest`、`cursor_simple`、`cursor_cache_oom`、`SqlSessionTest.shouldOpenAndClose`。

## 因果审

- `selectCursor()` 不只是执行查询，还把 Cursor 纳入 Session 生命周期管理，正文成立。
- `DefaultCursor` 的状态机与单 iterator 限制直接对应 ResultSet 推进语义，正文成立。
- `ObjectWrapperResultHandler.handleResult()` + `DefaultResultContext.stop()` 让一次只消费一条结果成为可能，正文成立。
- RowBounds、nested result map 与 Cursor 的张力被正文准确限制在“流式消费边界”范围内，正文成立。

## 结构审

- 从“Cursor 不是懒 List”切入，再落到 Session 注册、状态机、逐条推进、ResultHandler、边界与 OOM 证据，主线集中。
- 没有把 Cursor API 用法表和平铺测试清单写成正文，符合方法论。

## 读者审

- 读完应能回答：为什么 Cursor 不能开多个 iterator。
- 读完应能回答：为什么 Session close 必须级联关闭 Cursor。
- 读完后能自然进入 M-9 双入口主题，而不会把 Cursor 和结果装配再混成一层。

## 边界审

- 本篇没有把缓存专题或 Spring 集成提前透支。
- `cursor_cache_oom` 只作为资源边界证据，边界成立。

## 依赖审

- 前置依赖：M-3 生命周期、M-7 结果装配。
- 后续桥接：M-9 XML/注解双入口成立。

## 结论

M-8 已完成单域四件套的事实回填与六层审查，可进入下一补深域。