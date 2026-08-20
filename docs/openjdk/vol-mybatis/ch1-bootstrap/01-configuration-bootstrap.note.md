# M-1 配置启动与元数据构建 — note

## 本篇主张

- MyBatis 启动不是“读 XML 生成对象”，而是建立运行时元数据中心。
- `Configuration` 是状态核心，不是普通配置 DTO。
- `parsePending*()` 与 `StrictMap` 共同构成“延迟收束 + fail-fast”协议。

## 本篇边界

- 不展开 `MapperProxy` 与方法调用分发。
- 不展开执行器、参数绑定、结果映射与 Spring 集成。
- 注解入口只点到 pending method 与共享 `MappedStatement` 收束，不在本篇深入。

## 下篇桥接

- `M-2` 将回答：接口方法如何借 `MapperRegistry`、`MapperProxy`、`MapperMethod` 进入 `Configuration` 中已建好的元数据。