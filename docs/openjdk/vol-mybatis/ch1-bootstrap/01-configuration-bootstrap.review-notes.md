# M-1 配置启动与元数据构建 — review notes

## 事实审

- 已核对 `session/SqlSessionFactoryBuilder.java:47` 与 `session/SqlSessionFactoryBuilder.java:95`，入口与工厂创建位置成立。
- 已核对 `builder/xml/XMLConfigBuilder.java:105`、`builder/xml/XMLConfigBuilder.java:114`，`parse()` 与 `parseConfiguration()` 位置成立。
- 已核对 `builder/xml/XMLMapperBuilder.java:96`、`builder/xml/XMLMapperBuilder.java:111`、`builder/xml/XMLMapperBuilder.java:123`，Mapper XML 装配主线成立。
- 已核对 `session/Configuration.java:153`、`session/Configuration.java:159`、`session/Configuration.java:168`、`session/Configuration.java:170`、`session/Configuration.java:173`，状态中心与 pending 队列位置成立。
- 已核对 `session/Configuration.java:973`、`session/Configuration.java:992`、`session/Configuration.java:1011`、`session/Configuration.java:1029`、`session/Configuration.java:1111`、`session/Configuration.java:1138`，二次收束与 `StrictMap` fail-fast 位置成立。
- 已补测试证据：`XmlConfigBuilderTest.shouldSuccessfullyLoadXMLConfigFile`、`unknownSettings`、`parseIsTwice` 能支撑配置顺序、未知 setting fail-fast 与 builder 单次解析限制；`DuplicateStatementsTest.shouldFailForDuplicateMethod` 支撑重复 statement fail-fast。
## 因果审

- `properties -> settings -> env -> databaseId -> typeHandlers -> mappers` 的顺序不是描述偏好，而是启动协议，正文成立。
- `XMLMapperBuilder.parse()` 不是单文件闭环，而是“先写入，再 parsePending*() 回收 unresolved”，正文成立。
- `Configuration` 同时持有已完成元数据与 unresolved 队列，支撑“延迟收束 + fail-fast”主结论，正文成立。

## 结构审

- 结构从“为什么启动不只是读 XML”切入，再落到入口、顺序、mapper 装配、状态中心、pending 队列、StrictMap，主线集中。
- 没有按 builder 包目录平铺，符合方法论。

## 读者审

- 读完应能回答：为什么启动阶段会有 `incomplete*` 队列，为什么重复 statement 要在启动期炸掉。
- 读完后能自然接到 `MapperProxy`，不会把 `Configuration` 误读成静态配置对象。

## 边界审

- 本篇没有提前透支 `MapperProxy`、执行器、Spring 集成。
- 注解 mapper 只作为 pending method 的外部来源轻触，详细逻辑留给 M-9。

## 依赖审

- 作为卷入口，无前置依赖。
- 直接下一跳桥接到 M-2 成立：`MapperRegistry` / `MappedStatement` 都以 `Configuration` 为入口。
- 更后续的 M-4、M-5、M-9 也会复用这套元数据中心，但不必在本篇桥接里提前展开。

## 结论

M-1 已完成单域四件套的事实回填与六层审查，可进入下一域。