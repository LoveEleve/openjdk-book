# MP-7 Spring Boot 自动装配桥 — review notes

## 事实审

- 已核对 `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusAutoConfiguration.java:102`（类声明注解起始）、`:107`（类声明行）、`:131`（构造函数）、`:153`（`afterPropertiesSet()`）、`:161`（`checkConfigFileExists()`）、`:169`（`sqlSessionFactory(DataSource)`）、`:253`（`applyConfiguration(...)`）、`:270`（`applySqlSessionFactoryBeanCustomizers(...)`）、`:278`（`sqlSessionTemplate(...)`）、`:300`（`AutoConfiguredMapperScannerRegistrar.registerBeanDefinitions(...)`），装配桥总入口主线成立。
- 已核对 `MybatisPlusProperties.java:55`（类声明）、`:125`（`resolveMapperLocations()`）、`:343`（`CoreConfiguration.applyTo(...)`），配置翻译器主线成立。
- 已核对 `IdentifierGeneratorAutoConfiguration.java:32`（类声明）、`:38`（`identifierGenerator()`），雪花 ID 子装配成立。
- 已核对 `MybatisPlusInnerInterceptorAutoConfiguration.java:31`（类声明）、`:36`（`defaultMybatisPlusInterceptor()`），插件总线子装配成立。
- 已核对 `MybatisPlusLanguageDriverAutoConfiguration.java:49`（类声明）、`:52`（类声明行），语言驱动子装配成立。
- 已核对 `MybatisPlusAutoConfiguration.java:213`-`:220`，`MetaObjectHandler`、`AnnotationHandler`、`PostInitTableInfoHandler`、`IKeyGenerator`、`ISqlInjector`、`IdentifierGenerator` 注入 `GlobalConfig` 成立。
- 已核对 `MybatisPlusAutoConfiguration.java:231`-`235`（`getBeanThen`）、`:244`-`251`（`getBeansThen`），容器 Bean 消费辅助方法成立。

## 因果审

- `MybatisSqlSessionFactoryBean` 替换原生 `SqlSessionFactoryBean` 是 Boot 装配桥的核心动作，正文成立。
- `CoreConfiguration.applyTo(...)` 把 Boot 配置翻译成 `MybatisConfiguration` 输入，正文成立。
- `AutoConfiguredMapperScannerRegistrar` 自动补注册 mapper 扫描，正文成立。
- 条件退场（无 DataSource、无自动配置包、配置文件不存在）与 fail-fast 逻辑，正文成立。

## 结构审

- 从"为什么只加 starter 就能自动拥有增强版 MyBatis"困惑开场，再落到总图、入口、配置翻译器、会话工厂注入、子装配、mapper 扫描桥、失败路径，主线集中。
- 没有把 `MP-1` 到 `MP-6` 的内容重讲一遍，符合方法论。

## 读者审

- 读完应能回答：为什么 `SqlSessionFactoryBean` 被替换成了 `MybatisSqlSessionFactoryBean`。
- 读完应能回答：`MybatisPlusProperties` 如何把 `mybatis-plus.*` 配置翻译成增强版 Configuration 和 GlobalConfig 的输入。
- 读完应能回答：不写 `@MapperScan` 也能扫到 mapper 的原因。
- 读完后能自然进入卷级收尾，而不会把 Boot 装配桥和 MyBatis 核心机制混成一层。

## 边界审

- 本篇没有把每个子自动配置类的完整算法全部展开。
- `MP-8` 应用边界层和卷级收尾都未提前透支，边界成立。

## 依赖审

- 前置依赖：MP-1 到 MP-6 全部（HARD）。
- 后续桥接：MP-8 应用边界层、卷级六层总审、README、导读、总图索引。

## 结论

MP-7 已完成单域四件套的事实回填与六层审查，可进入应用边界层或卷级收尾。
