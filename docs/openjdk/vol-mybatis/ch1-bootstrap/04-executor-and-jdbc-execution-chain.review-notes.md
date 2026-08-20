# M-4 Executor 执行链与 JDBC 落地 — review notes

## 事实审

- 已核对 `executor/BaseExecutor.java:54`、`executor/BaseExecutor.java:57`、`executor/BaseExecutor.java:58`、`executor/BaseExecutor.java:62`，事务、deferred load、本地缓存与 `queryStack` 状态成立。
- 已核对 `executor/BaseExecutor.java:111`、`executor/BaseExecutor.java:133`、`executor/BaseExecutor.java:177`、`executor/BaseExecutor.java:184`、`executor/BaseExecutor.java:197`、`executor/BaseExecutor.java:242`、`executor/BaseExecutor.java:252`、`executor/BaseExecutor.java:331`，更新、查询、Cursor、延迟加载、缓存键与提交流程成立。
- 已核对 `executor/CachingExecutor.java:39`、`executor/CachingExecutor.java:49`、`executor/CachingExecutor.java:67`、`executor/CachingExecutor.java:121`，二级缓存装饰语义成立。
- 已核对 `executor/statement/RoutingStatementHandler.java:39`、`executor/statement/RoutingStatementHandler.java:42`，Statement 路由主线成立。
- 已核对 `executor/BatchExecutor.java:54`、`executor/BatchExecutor.java:114`，批处理积攒与 flush 行为成立。
- 已核对 `executor/resultset/DefaultResultSetHandler.java:188`，结果集主处理入口成立；`scripting/defaults/DefaultParameterHandler.java:61` 为参数绑定落地点。

## 因果审

- `BaseExecutor` 先处理一级缓存与 `queryStack`，再决定是否真正打数据库，正文成立。
- `CachingExecutor` 把二级缓存绑定到执行器和事务时机上，正文成立。
- `RoutingStatementHandler` 让执行器不直接关心 JDBC Statement 三种形态，正文成立。
- `DefaultResultSetHandler` 不是简单行映射，而是对象图装配器，正文成立。

## 结构审

- 结构从“为什么执行链不等于 JDBC 调用”切入，再落到执行器状态中心、缓存装饰、Statement 路由、参数绑定、结果装配，主线集中。
- 没有按 executor/statement/resultset 包机械平铺，符合方法论。

## 读者审

- 读完应能回答：为什么相同查询在同一个会话里不一定重复打数据库。
- 读完应能回答：为什么 callable statement 带 OUT 参数不能简单进缓存。
- 读完后能自然进入缓存专题或动态 SQL/插件专题。

## 边界审

- 本篇没有把缓存一致性、动态 SQL、类型系统完整展开，边界控制成立。
- Spring 集成与事务同步未提前透支，边界成立。

## 依赖审

- 前置依赖：M-1 配置中心、M-2 Mapper 入口、M-3 Session/事务生命周期。
- 后续桥接：M-5 缓存边界、M-6 动态 SQL 与插件、M-7 类型系统都成立。

## 结论

M-4 已完成单域四件套的事实回填与六层审查，可进入下一个补深域。