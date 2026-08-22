# 卷 MyBatis-Plus · 增强机制与 Spring Boot 集成源码分析

> 本卷基于 MyBatis-Plus 3.5.7 当前源码。目标不是按包翻译仓库，而是把"Configuration 替换 -> SQL 注入 -> 表元数据 -> Wrapper -> 插件总线 -> 增强家族 -> Boot 装配 -> 应用边界"收束成一卷可连续阅读的源码书。

## 当前卷级状态

- 已完成核心主干层：`MP-1 ~ MP-4`
- 已完成机制补深层：`MP-5 ~ MP-6`
- 已完成 Boot 装配层：`MP-7`
- 已完成应用边界层：`MP-8`
- 已完成卷级六层总审
- 当前属于阶段性收口，不等同于覆盖 MP 全部生产排障专题

## 篇章目录

### A. MyBatis-Plus 核心主干层

- [MP-1 Configuration 替换与 Mapper 注册桥](ch1-configuration-bridge/01-configuration-replacement-and-mapper-registration.md)：`MybatisConfiguration` 替换原生 `Configuration`，`SqlSessionFactoryBean` 替换，`AutoMapperScanner`
- [MP-2 SQL 自动注入与 MappedStatement 批量生成](ch2-sql-injector/01-sql-injection-and-batch-mappedstatement-generation.md)：`DefaultSqlInjector`、`AbstractMethod`、`insertOneSql`、`SqlMethod` 枚举
- [MP-3 表元数据解析与 GlobalConfig 边界](ch3-tableinfo/01-tableinfo-and-globalconfig-boundary.md)：`TableInfoHelper`、`TableInfo`、`GlobalConfig`、`DbConfig`
- [MP-4 Wrapper / Lambda 条件构造器](ch4-wrapper/01-wrapper-and-lambda-condition-builder.md)：`AbstractWrapper`、`QueryWrapper`、`UpdateWrapper`、`LambdaQueryWrapper`

### B. MyBatis-Plus 机制补深层

- [MP-5 插件总线与 SQL 改写入口](ch5-interceptor/01-interceptor-bus-and-sql-rewrite-entry.md)：`MybatisPlusInterceptor`、`InnerInterceptor`、`@InterceptIgnore`
- [MP-6 内置运行时增强专题组](ch6-runtime-enhancements/01-runtime-enhancement-family-map.md)：自动填充、逻辑删除、乐观锁、租户、分页、权限、安全

### C. Boot 装配层

- [MP-7 Spring Boot 自动装配桥](ch7-boot-autoconfigure/01-mybatis-plus-boot-autoconfiguration-bridge.md)：`MybatisPlusAutoConfiguration`、`MybatisPlusProperties`、`IdentifierGeneratorAutoConfiguration`、`MybatisPlusInnerInterceptorAutoConfiguration`、`MybatisPlusLanguageDriverAutoConfiguration`

### D. 应用边界层

- [MP-8 BaseMapper / IService 应用边界层](ch8-mapper-service/01-base-mapper-service-boundary.md)：`BaseMapper`、`IService`、`ServiceImpl`，3.5.7 批量方法与逻辑删除填充适配

## 推荐阅读顺序

`MP-1 -> MP-2 -> MP-3 -> MP-4 -> MP-5 -> MP-6 -> MP-7 -> MP-8`

这个顺序先建立 MP 自身的增强版协议，再解释插件与增强家族，最后解释它如何被 Spring Boot 自动装起来，以及用户代码如何与增强体系对接。

## 这卷已经能回答什么

- `MybatisConfiguration` 为什么能替换原生 `Configuration` 而不破坏 MyBatis 协议
- `DefaultSqlInjector` 如何在启动时批量注入增强版 MappedStatement
- `TableInfo` / `GlobalConfig` 如何管理表元数据与全局配置
- `Wrapper` / `LambdaQueryWrapper` 如何把条件构造器从字符串拼接升级为类型安全 API
- `MybatisPlusInterceptor` / `InnerInterceptor` 如何建立插件总线与 SQL 改写入口
- 自动填充、逻辑删除、乐观锁、租户、分页、权限、安全如何挂进插件总线
- `MybatisPlusAutoConfiguration` 如何在 Spring Boot 下自动装配增强版 SqlSessionFactory
- `BaseMapper` / `IService` / `ServiceImpl` 如何把所有增强机制收束到用户代码可直接调用的 CRUD 边界

## 当前仍未覆盖的边界

本卷尚未把生产排障层单独成组。当前已明确的候选包括：

- 大批量操作下的内存与事务边界
- 分页插件在复杂 SQL 下的边界
- 租户插件与子查询的边界
- 逻辑删除与索引的边界

也就是说，本卷主干与集成层已经闭合，但"生产排障层"仍是下一阶段补层。
