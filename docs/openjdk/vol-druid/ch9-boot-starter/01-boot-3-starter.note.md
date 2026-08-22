# Druid D-9 Spring Boot 3 Starter — note

## 本篇主张

- Starter 通过 `spring.datasource.type`、`@ConditionalOnClass`、自动装配顺序和缺失 Bean 条件共同创建默认 DataSource
- `DruidDataSourceWrapper` 继承 + `InitializingBean` 接入 `init()`

## 本篇边界

- 不展开池内部实现
- 不展开 Filter 链

## 下篇桥接

- 本卷 9 个域已全部闭合，进入卷级收尾