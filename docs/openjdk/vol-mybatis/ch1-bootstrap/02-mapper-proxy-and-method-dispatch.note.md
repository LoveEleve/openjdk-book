# M-2 MapperProxy 动态代理与方法分发 — note

## 本篇主张

- Mapper 运行时不是“生成实现类”，而是“注册 + 代理 + method cache + 签名翻译”的接口调用协议。
- `MapperMethod` 才是真正把 Java 方法语义翻译成 `SqlSession` 调用语义的核心。
- default method、`RowBounds`、`ResultHandler`、`Optional`、`Cursor` 和 primitive/null 都是这层的边界条件。

## 本篇边界

- 不展开 `SqlSession` 生命周期与事务。
- 不展开执行器与结果映射内部细节。
- 不展开 Spring / Boot 集成。

## 下篇桥接

- `M-3` 将回答：一个 `SqlSession` 如何管理 Executor、事务、Cursor 以及 commit/rollback/close 的资源收束。