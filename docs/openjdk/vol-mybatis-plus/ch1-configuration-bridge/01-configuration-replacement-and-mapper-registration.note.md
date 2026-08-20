# MP-1 Configuration 替换与 Mapper 注册桥 — note

## 本篇主张

- MyBatis-Plus 的第一层增强不在 `BaseMapper` 或分页插件，而在核心桥替换：`SqlSessionFactoryBuilder`、`Configuration`、`MapperRegistry`、`MapperAnnotationBuilder`。
- `parserInjector()` 是后续 SQL 自动注入真正能挂进主线的桥接点。
- MP 改写的是默认运行时语义与注册责任，而不是只换了几个类名。

## 本篇边界

- 不展开 SQL 自动注入具体 method list。
- 不展开表元数据解析、Wrapper、插件家族。
- 只在需要时点到 `GlobalConfig`、ID 生成器和 XML 优先级。

## 下篇桥接

- `MP-2` 将专门回答：为什么 `BaseMapper` 没有 XML 也能直接得到一批 CRUD `MappedStatement`。