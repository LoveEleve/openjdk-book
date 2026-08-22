# 为什么 MyBatis-Plus 在 Spring Boot 下只加 starter，就能自动拥有增强版 MyBatis

> 本文基于 MyBatis-Plus 3.5.7 当前源码。本文只讲 Boot 自动装配桥：`MybatisPlusAutoConfiguration`、`MybatisPlusProperties`、`IdentifierGeneratorAutoConfiguration`、`MybatisPlusInnerInterceptorAutoConfiguration`、`MybatisPlusLanguageDriverAutoConfiguration` 如何把增强版 `Configuration`、插件家族、ID 生成器、填充器和 mapper 扫描自动接起来。不重讲 MyBatis 核心或 `MP-1` 到 `MP-6` 的内部细节。

## 为什么"MP 就是加了几个 Bean"这个理解会把装配桥读浅

很多人第一次用 MP starter，会觉得发生的事情很简单：

- Spring Boot 帮你省掉了几段配置

这当然不是错，但它会把真正关键的变化读扁。

因为如果你只看"省配置"，就很难解释：

- 为什么 `SqlSessionFactoryBean` 被替换成了 `MybatisSqlSessionFactoryBean`
- 为什么 `GlobalConfig`、`MetaObjectHandler`、`IdentifierGenerator`、`ISqlInjector` 会被自动注入
- 为什么插件总线、语言驱动、mapper 扫描都能从 starter 自动接上
- 为什么 `CoreConfiguration.applyTo(...)` 会把 Boot 配置翻译成增强版 `MybatisConfiguration`

也就是说，MP 的 Boot 装配不是"帮你少写几行 XML"，而是：

**在条件满足时，自动把 `MP-1` 到 `MP-6` 建立的整套增强体系装起来。**

## Boot 装配桥的最小总图

```text
MybatisPlusAutoConfiguration
  -> afterPropertiesSet()
    -> MybatisPlusPropertiesCustomizer
    -> checkConfigFileExists()
  -> sqlSessionFactory(DataSource)
    -> MybatisSqlSessionFactoryBean
    -> applyConfiguration(factory)
    -> CoreConfiguration.applyTo(configuration)
    -> ConfigurationCustomizer
    -> setPlugins/typeAliases/typeHandlers/mapperLocations/...
    -> getBeanThen(MetaObjectHandler/IdentifierGenerator/ISqlInjector/...)
    -> factory.setGlobalConfig(globalConfig)
  -> sqlSessionTemplate(SqlSessionFactory)
  -> AutoConfiguredMapperScannerRegistrar.registerBeanDefinitions(...)
```

这张图最重要的地方不是"创建了哪些 Bean"，而是：

1. `MybatisSqlSessionFactoryBean` 不是原生 `SqlSessionFactoryBean`
2. `MybatisPlusProperties` 不是普通 DTO，而是增强版 Configuration 和 GlobalConfig 的编排器
3. mapper 扫描不是神秘黑盒，而是自动注册的 `MapperScannerConfigurer`

## 一、`MybatisPlusAutoConfiguration`：MP 装配桥的总入口

关键类在：

- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusAutoConfiguration.java:102` 类声明
- `.../MybatisPlusAutoConfiguration.java:131` 构造函数
- `.../MybatisPlusAutoConfiguration.java:153` `afterPropertiesSet()`
- `.../MybatisPlusAutoConfiguration.java:161` `checkConfigFileExists()`

从类声明就能看出它不是无条件加载：

- `@ConditionalOnClass({SqlSessionFactory.class, SqlSessionFactoryBean.class})`
- `@ConditionalOnSingleCandidate(DataSource.class)`
- `@EnableConfigurationProperties(MybatisPlusProperties.class)`
- `@AutoConfigureAfter({DataSourceAutoConfiguration.class, MybatisPlusLanguageDriverAutoConfiguration.class})`

这说明 MP 的装配桥至少要求：

- MyBatis Core + mybatis-spring 相关类存在
- 容器里已经有可用的单一候选 `DataSource`
- `mybatis-plus.*` 配置已绑定成 `MybatisPlusProperties`

## 二、`MybatisPlusProperties`：配置翻译器，不是普通 DTO

关键点在：

- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusProperties.java:55` 类声明
- `.../MybatisPlusProperties.java:125` `resolveMapperLocations()`
- `.../MybatisPlusProperties.java:343` `CoreConfiguration.applyTo(...)`

`MybatisPlusProperties` 同时承担两层责任：

### 1. 资源路径与外围输入收束

- `configLocation`
- `mapperLocations`（默认 `classpath*:/mapper/**/*.xml`）
- `typeAliasesPackage`
- `typeHandlersPackage`
- `executorType`
- `configurationProperties`

### 2. MyBatis CoreConfiguration 与 GlobalConfig 回填

`CoreConfiguration.applyTo(...)` 会把 Boot 侧配置一项项回写到 `MybatisConfiguration`：

- `mapUnderscoreToCamelCase`
- `cacheEnabled`
- `lazyLoadingEnabled`
- `localCacheScope`
- `defaultExecutorType`
- `defaultSqlProviderType`
- `defaultEnumTypeHandler`
- `useGeneratedShortKey`
- 等等

同时 `globalConfig` 属性会把 `GlobalConfig` 也暴露给 Boot 配置体系。

所以 `MybatisPlusProperties` 不是"记住用户配置"，而是在负责：

**把 Boot 配置语言翻译成 MyBatis CoreConfiguration 和 GlobalConfig 能消费的输入。**

## 三、`sqlSessionFactory(DataSource)`：Boot 如何把增强版 Configuration、插件、ID 生成器、填充器注入进去

关键方法在：

- `.../MybatisPlusAutoConfiguration.java:169` `sqlSessionFactory(DataSource)`
- `.../MybatisPlusAutoConfiguration.java:253` `applyConfiguration(...)`
- `.../MybatisPlusAutoConfiguration.java:270` `applySqlSessionFactoryBeanCustomizers(...)`

这条方法很长，但逻辑很清晰：

1. new `MybatisSqlSessionFactoryBean`
2. 注入 `DataSource`
3. 设 `SpringBootVFS`
4. 如果配置了 `configLocation`，把配置文件 Resource 灌进去
5. 调 `applyConfiguration(factory)`
6. 再依次灌：
   - `configurationProperties`
   - `interceptors`
   - `databaseIdProvider`
   - `typeAliasesPackage` / `typeAliasesSuperType`
   - `typeHandlersPackage` / `typeHandlers`
   - `mapperLocations`
   - `languageDrivers`
   - `defaultScriptingLanguageDriver`
7. `applySqlSessionFactoryBeanCustomizers(factory)`
8. 从容器里取 `MetaObjectHandler`、`AnnotationHandler`、`PostInitTableInfoHandler`、`IKeyGenerator`、`ISqlInjector`、`IdentifierGenerator` 并注入 `GlobalConfig`
9. `factory.setGlobalConfig(globalConfig)`
10. `factory.getObject()`

这说明 MP 的 Boot 装配不是"创建了一个 SqlSessionFactoryBean"，而是：

**它把增强版 Configuration、插件家族、ID 生成器、填充器、mapper locations 统一在自动配置层收束并注入到了正确的位置。**

## 四、`IdentifierGeneratorAutoConfiguration` / `MybatisPlusInnerInterceptorAutoConfiguration` / `MybatisPlusLanguageDriverAutoConfiguration`

这三个自动配置类各自负责一个子装配：

### 1. `IdentifierGeneratorAutoConfiguration`

- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/IdentifierGeneratorAutoConfiguration.java:32` 类声明
- `.../IdentifierGeneratorAutoConfiguration.java:38` `identifierGenerator()`

提供默认雪花 ID 生成器。

### 2. `MybatisPlusInnerInterceptorAutoConfiguration`

- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusInnerInterceptorAutoConfiguration.java:31` 类声明
- `.../MybatisPlusInnerInterceptorAutoConfiguration.java:36` `defaultMybatisPlusInterceptor()`

提供默认插件总线。

### 3. `MybatisPlusLanguageDriverAutoConfiguration`

- `spring-boot-starter/mybatis-plus-spring-boot-autoconfigure/src/main/java/com/baomidou/mybatisplus/autoconfigure/MybatisPlusLanguageDriverAutoConfiguration.java:49` 类声明

提供 FreeMarker / Velocity / Thymeleaf 语言驱动自动装配。

这说明 MP 的 Boot 装配不是只装一个 `SqlSessionFactory`，而是：

**把增强体系的多个子装配点也一并接上。**

## 五、`AutoConfiguredMapperScannerRegistrar`：mapper 扫描桥

关键点在：

- `.../MybatisPlusAutoConfiguration.java:300` `AutoConfiguredMapperScannerRegistrar.registerBeanDefinitions(...)`

它做的事情很具体：

1. 先检查 `AutoConfigurationPackages.has(beanFactory)`
2. 如果没有自动配置包，直接退场
3. 拿到 Boot 自动配置包列表
4. 构造一个 `MapperScannerConfigurer` BeanDefinition
5. 设置：
   - `processPropertyPlaceHolders=true`
   - `annotationClass=Mapper.class`
   - `basePackage=自动配置包`
6. 如果支持 `lazyInitialization` / `defaultScope`，再按属性补进去
7. 根据是否注入 `SqlSessionTemplate` 或 `SqlSessionFactory` 选择对应 bean name
8. 最后把这个 `MapperScannerConfigurer` 作为基础设施 Bean 注册进容器

这说明"不写 `@MapperScan` 也能扫到 mapper"不是魔法，而是：

**Boot 自动装配在适当条件下帮你补了一份最小版的 mapper 扫描配置。**

## 六、失败路径与条件退场

### 1. 配置文件不存在

`checkConfigFileExists()` 会在启用检查时直接 fail-fast。

### 2. 没有自动配置包

`AutoConfiguredMapperScannerRegistrar` 直接日志提示后退场，不会硬扫。

### 3. 没有单一候选 DataSource

类级条件根本不会成立，整个自动配置不生效。

### 4. `defaultScriptingLanguageDriver` 设置不当

`MybatisPlusProperties` 注释里已经明确警告：如果设置了这个，你可能会失去几乎所有 MP 提供的功能。

所以 MP 的 Boot 装配真正重要的不是"帮你自动创建"，而是：

**在自动创建之前先确认条件满足；不满足时要么显式失败，要么明确退场。**

## 到这里，MP-7 真正立住的不是 starter 便利性，而是"MP Boot 装配桥"

如果只看表面，这篇很容易被读成：

- `MybatisPlusAutoConfiguration` 会创建一些 Bean
- `MybatisPlusProperties` 会接收配置
- `MapperScannerConfigurer` 会扫描 mapper

这些都对，但还不够。

更稳的理解方式应该是：

1. `MybatisPlusAutoConfiguration` 先判断环境是否满足桥接条件
2. `MybatisPlusProperties` 把 Boot 配置翻译成增强版 Configuration 和 GlobalConfig 的输入
3. `sqlSessionFactory(DataSource)` 负责把这些输入统一灌进 `MybatisSqlSessionFactoryBean`
4. `sqlSessionTemplate(SqlSessionFactory)` 说明 Boot 最终还是装回 `S-1` 的会话门面
5. `AutoConfiguredMapperScannerRegistrar` 说明 Boot 只是自动补注册了 Spring 那边的扫描桥
6. `IdentifierGeneratorAutoConfiguration`、`MybatisPlusInnerInterceptorAutoConfiguration`、`MybatisPlusLanguageDriverAutoConfiguration` 说明增强体系的子装配点也被一并接上

所以这篇真正立住的是：

**Spring Boot 没有重写 MyBatis-Plus 增强体系，而是在条件满足时自动把那套体系装起来。**

## 到这里，`vol-mybatis-plus` 的主干与集成层已经闭合

到这里，`vol-mybatis-plus` 的核心主干层、机制补深层、Boot 装配层都已经立住：

- `MP-1` Configuration 替换与 Mapper 注册桥
- `MP-2` SQL 自动注入与 MappedStatement 批量生成
- `MP-3` 表元数据解析与 GlobalConfig 边界
- `MP-4` Wrapper / Lambda 条件构造器
- `MP-5` 插件总线与 SQL 改写入口
- `MP-6` 内置运行时增强专题组
- `MP-7` Spring Boot 自动装配桥

下一步不再是继续补核心主线，而是应回到卷级：

- 统一做一轮卷级六层复审
- 再补 README、导读、总图索引
- 最后再决定是否追加 `MP-8` 应用边界层