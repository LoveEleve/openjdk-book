# 篇：01 MyBatis-Plus 在 Spring Boot 中如何自动装起来

- 域：`MP-7 Spring Boot 自动装配桥`
- 卷：`vol-mybatis-plus`
- 目标：回答 `MybatisPlusAutoConfiguration`、`MybatisPlusProperties`、`IdentifierGeneratorAutoConfiguration`、`MybatisPlusInnerInterceptorAutoConfiguration`、`MybatisPlusLanguageDriverAutoConfiguration` 如何把增强版 `Configuration`、插件家族、ID 生成器、填充器和 mapper 扫描自动接起来。

## 前置依赖

- HARD：已读 `MP-1` 到 `MP-6`，知道核心桥替换、SQL 注入、表元数据、Wrapper、插件总线和增强家族。

## 读者问题

为什么 MyBatis-Plus 在 Spring Boot 下只加 starter 就能自动拥有增强版 `SqlSessionFactory`、插件家族、ID 生成器、填充器和 mapper 扫描？以及：

1. `MybatisPlusProperties` 如何把 `mybatis-plus.*` 配置翻译成 `MybatisConfiguration` 和 `GlobalConfig` 的输入
2. `MybatisSqlSessionFactoryBean` 为什么不是原生 `SqlSessionFactoryBean`
3. `IdentifierGeneratorAutoConfiguration`、`MybatisPlusInnerInterceptorAutoConfiguration`、`MybatisPlusLanguageDriverAutoConfiguration` 各自负责什么
4. `AutoConfiguredMapperScannerRegistrar` 如何在没有 `@MapperScan` 时自动扫描 `@Mapper`

## 主结论

MP 的 Boot 装配不是重写 MyBatis/Spring 集成层，而是在条件满足时自动把 `MP-1` 到 `MP-6` 建立的整套增强体系装起来：

`MybatisPlusAutoConfiguration`
  -> `afterPropertiesSet()`：`MybatisPlusPropertiesCustomizer` + `checkConfigFileExists()`
  -> `sqlSessionFactory(DataSource)`
    -> `MybatisSqlSessionFactoryBean`
    -> `applyConfiguration(factory)`
    -> `CoreConfiguration.applyTo(configuration)`
    -> `ConfigurationCustomizer`
    -> `setPlugins/typeAliases/typeHandlers/mapperLocations/...`
    -> `getBeanThen(MetaObjectHandler/IdentifierGenerator/ISqlInjector/...)`
    -> `factory.setGlobalConfig(globalConfig)`
  -> `sqlSessionTemplate(SqlSessionFactory)`
  -> `AutoConfiguredMapperScannerRegistrar.registerBeanDefinitions(...)`

同时：

- `IdentifierGeneratorAutoConfiguration` 提供默认雪花 ID 生成器
- `MybatisPlusInnerInterceptorAutoConfiguration` 提供默认插件总线
- `MybatisPlusLanguageDriverAutoConfiguration` 提供语言驱动自动装配

## 结构设计

1. 困惑开场：为什么只加 starter 就能自动拥有增强版 MyBatis
2. 最小总图：`MybatisPlusAutoConfiguration` -> `MybatisSqlSessionFactoryBean` -> `SqlSessionTemplate` -> mapper scan
3. 自动装配生效条件
4. `MybatisPlusProperties`：配置如何从 `mybatis-plus.*` 收束到 `CoreConfiguration` / `GlobalConfig` / `Resource[]`
5. `sqlSessionFactory(DataSource)`：Boot 如何把增强版 Configuration、插件、ID 生成器、填充器注入进去
6. `IdentifierGeneratorAutoConfiguration` / `MybatisPlusInnerInterceptorAutoConfiguration` / `MybatisPlusLanguageDriverAutoConfiguration`
7. `AutoConfiguredMapperScannerRegistrar`：mapper 扫描桥
8. 失败路径与条件退场
9. 收网：这篇立住的是"MP Boot 装配桥"，不是又一套 MyBatis 核心机制
10. 下篇桥接：回到卷级收尾

## 必须回填的源码锚点

- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusAutoConfiguration.java:102` 类声明
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusAutoConfiguration.java:131` 构造函数
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusAutoConfiguration.java:153` `afterPropertiesSet()`
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusAutoConfiguration.java:161` `checkConfigFileExists()`
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusAutoConfiguration.java:169` `sqlSessionFactory(DataSource)`
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusAutoConfiguration.java:253` `applyConfiguration(...)`
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusAutoConfiguration.java:270` `applySqlSessionFactoryBeanCustomizers(...)`
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusAutoConfiguration.java:278` `sqlSessionTemplate(...)`
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusAutoConfiguration.java:300` `AutoConfiguredMapperScannerRegistrar.registerBeanDefinitions(...)`
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusProperties.java:55` 类声明
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusProperties.java:125` `resolveMapperLocations()`
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusProperties.java:343` `CoreConfiguration.applyTo(...)`
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/IdentifierGeneratorAutoConfiguration.java:32` 类声明
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/IdentifierGeneratorAutoConfiguration.java:38` `identifierGenerator()`
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusInnerInterceptorAutoConfiguration.java:31` 类声明
- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusInnerInterceptorAutoConfiguration.java:36` `defaultMybatisPlusInterceptor()`

## 必须引用的测试/证据

- `MetadataTest`
- `MybatisPlusPropertiesTest`
- `MybatisPlusLanguageDriverAutoConfigurationTest`
- `MybatisAutoConfigurationTest`（Boot 2）
- `MybatisPlusSampleTest`（Boot 3）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。