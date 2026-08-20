# M-9 XML 与注解 Mapper 双入口 — note

## 本篇主张

- XML mapper、注解 mapper、provider mapper 不是三套并列系统，而是三种输入最终并回同一条 `MappedStatement/Configuration` 主线。
- `MapperRegistry.addMapper()` 是统一注册入口，`MapperAnnotationBuilder.parse()` 是并流编排器。
- provider 只是注解入口里的 SQL 生成分支，不是独立体系。

## 本篇边界

- 不展开 Spring 对 mapper 扫描和注册的接管。
- 不重讲 `MapperProxy` 运行时分发，只聚焦注册与元数据编排。
- 只在需要时引用 XMLBuilder/Provider/MethodSignature 的既有背景。

## 下篇桥接

- `S-1` 将收束 MyBatis 进入 Spring 后，谁负责 Session、事务与 Mapper Bean 的生命周期。