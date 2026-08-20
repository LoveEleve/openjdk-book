# M-4 Executor 执行链与 JDBC 落地 — note

## 本篇主张

- MyBatis 执行链不是“Executor 直接打 JDBC”，而是缓存、路由、参数绑定、结果装配共同构成的执行协议。
- `BaseExecutor` 是一级缓存、`queryStack` 与 deferred load 的状态中心。
- `CachingExecutor` 是二级缓存的执行器装饰器，而不是独立缓存组件。

## 本篇边界

- 不把缓存一致性、动态 SQL、类型系统完全展开为独立专题。
- 只在执行链需要的位置点到 `DefaultParameterHandler` 和 `DefaultResultSetHandler`。
- 不展开 Spring 事务桥。

## 下篇桥接

- `M-5` 将专门收束一级/二级缓存、一致性边界与阻塞缓存语义。