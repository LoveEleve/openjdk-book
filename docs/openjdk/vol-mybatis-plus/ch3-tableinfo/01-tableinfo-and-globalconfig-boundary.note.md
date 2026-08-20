# MP-3 表元数据解析与 GlobalConfig 边界 — note

## 本篇主张

- MP 不直接消费注解，而是先把注解和 `GlobalConfig.DbConfig` 收束成 `TableInfo/TableFieldInfo` 运行时语义中心。
- 主键、逻辑删除、版本号、排序、autoResultMap 等关键边界都应在元数据构建期前移暴露。
- `TableInfo` / `TableFieldInfo` 不是注解 DTO，而是后续 SQL 注入、Wrapper、逻辑删除、自动填充共同消费的语义对象。

## 本篇边界

- 不展开 Wrapper / Lambda 解析细节。
- 不展开自动填充和逻辑删除 SQL 改写细节。
- 只在需要时点到 resultMap 和 key generator。

## 下篇桥接

- `MP-4` 将收束 Wrapper / Lambda 条件构造器为什么能避免字段名硬编码并持续生成条件链。