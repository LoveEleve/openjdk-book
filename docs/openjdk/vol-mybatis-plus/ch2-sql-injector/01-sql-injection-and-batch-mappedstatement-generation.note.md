# MP-2 SQL 自动注入与 MappedStatement 批量生成 — note

## 本篇主张

- `BaseMapper` 自带 CRUD 不是接口自带实现，而是 mapper 注册期批量生成 `MappedStatement` 的结果。
- `AbstractSqlInjector.inspectInject()` 负责时机，`DefaultSqlInjector.getMethodList()` 负责方法清单，`AbstractMethod.inject()` 负责真正落 statement。
- `GlobalConfigUtils` 提供注入器与注册缓存的全局状态边界。

## 本篇边界

- 不展开表元数据具体如何生成。
- 不展开分页、逻辑删除、乐观锁等具体增强插件。
- 只在需要时引用 `BaseMapper` 作为能力目录。

## 下篇桥接

- `MP-3` 将收束 `TableInfo`、`TableFieldInfo`、`GlobalConfig.DbConfig` 如何建立并影响注入决策。