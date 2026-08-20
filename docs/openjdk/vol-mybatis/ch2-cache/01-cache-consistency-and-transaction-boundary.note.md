# M-5 缓存与一致性边界 — note

## 本篇主张

- MyBatis 缓存不是一个组件，而是会话内缓存与事务后共享缓存两条责任线。
- `TransactionalCache` 的意义不是再包一层 Map，而是延迟发布共享结果直到 commit。
- `BlockingCache` 关注的是未命中并发一致性，不是普通性能优化。

## 本篇边界

- 不展开动态 SQL、类型系统和 Spring 缓存集成。
- 不把大结果集 / Cursor 问题直接混成缓存优化问题。
- 只在执行链需要的位置点到 `CacheKey` 与 cache decorator。

## 下篇桥接

- `M-6` 将回答：动态 SQL、参数绑定和插件是怎样切进执行链的。