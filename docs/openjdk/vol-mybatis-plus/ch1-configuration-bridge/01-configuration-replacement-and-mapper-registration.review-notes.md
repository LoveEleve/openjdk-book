# MP-1 Configuration 替换与 Mapper 注册桥 — review notes

## 事实审

- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisSqlSessionFactoryBuilder.java:80`，全局配置、ID 生成器、`SqlRunnerInjector` 与 `SqlSessionFactory` 回填主线成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisConfiguration.java:90`、`:104`、`:127`、`:149`、`:444`、`:472`，默认语义、优先级与 mapper 缓存责任主线成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperRegistry.java:76`，先 put proxyFactory 再 parse、失败回滚的注册主线成立。
- 已核对 `mybatis-plus-core/src/main/java/com/baomidou/mybatisplus/core/MybatisMapperAnnotationBuilder.java:87`、`:125`、`:135`、`:271`，增强注入入口挂在 mapper 解析期这一主张成立。
- 已补测试证据：`MybatisConfigurationTest`、`MybatisMapperAnnotationBuilderTest`、以及与后续桥接相关的 `MybatisParameterHandlerTest`、`TableInfoHelperTest`。

## 因果审

- MP 先替换工厂构造桥，再替换 `Configuration/MapperRegistry/MapperAnnotationBuilder`，这条因果链成立。
- `parserInjector()` 说明 SQL 自动注入并不是事后扫描，而是挂在 mapper 注册流程上的，正文成立。
- `addMappedStatement()` 的 XML 优先级与原生 MyBatis 的严格冲突策略不同，正文成立。

## 结构审

- 从“MP 不是多几个功能，而是先替换核心桥”切入，再落到工厂构造、Configuration 默认世界、注册桥和注入入口，主线集中。
- 没有把 CRUD 方法、分页插件、Wrapper 等功能提前混入，符合方法论。

## 读者审

- 读完应能回答：为什么 MP 的主入口不是 `BaseMapper`，而是 `MybatisConfiguration` 这一层。
- 读完应能回答：为什么 SQL 注入必须建立在注册桥已经被接管之后。
- 读完后能自然进入 `MP-2`，而不会把“桥替换”和“注入结果”混成一篇。

## 边界审

- 本篇没有提前透支 SQL 注入细节、表元数据和插件家族。
- `GlobalConfig`、ID 生成器、XML 优先级只保留为桥级证据，边界成立。

## 依赖审

- 作为卷入口，无前置依赖。
- 后续桥接：`MP-2` SQL 自动注入、`MP-3` 表元数据解析都成立。

## 结论

MP-1 已完成单域四件套的事实回填与六层审查，可进入下一核心主干域。