# 为什么只加一个 starter，MyBatis 就能在 Spring Boot 里自己装起来

> 本文基于 `mybatis-spring-boot-starter` 当前源码。本文只讲 Boot 装配桥：`MybatisAutoConfiguration`、`MybatisProperties`、`AutoConfiguredMapperScannerRegistrar` 如何把 `SqlSessionFactoryBean`、`SqlSessionTemplate` 和 mapper 扫描自动接起来。不重讲 MyBatis 核心执行链或 `S-1` 的 Spring 事务桥本身。

## 为什么“Boot 帮你省掉 XML 配置”这个理解太浅了

很多人第一次使用 starter，会觉得发生的事情很简单：

- Spring Boot 帮你省掉了几段配置

这当然不是错，但它还是会把装配桥读得太轻。

因为真正自动被装起来的，不只是几个 Bean，而是：

- `SqlSessionFactoryBean` 需要的数据源、插件、type aliases、type handlers、mapper locations、语言驱动
- `SqlSessionTemplate` 这个 `S-1` 中已经建立好的 Spring 会话门面
- mapper 扫描器与自动扫描包路径之间的桥
- 以及一整套“如果条件不满足就退场”的自动配置约束

也就是说，Boot 层做的不是“替你 new 几个对象”，而是：

**在条件满足时，把前面已经建立好的 Spring 事务桥整套自动装起来。**

## Boot 装配桥的最小总图

```text
MybatisAutoConfiguration
  -> checkConfigFileExists()
  -> sqlSessionFactory(DataSource)
    -> SqlSessionFactoryBean
    -> applyConfiguration()
    -> setPlugins / typeAliases / typeHandlers / mapperLocations ...
  -> sqlSessionTemplate(SqlSessionFactory)
    -> SqlSessionTemplate
  -> AutoConfiguredMapperScannerRegistrar.registerBeanDefinitions(...)
    -> MapperScannerConfigurer
      -> 自动扫描 @Mapper
```

这张图最重要的地方不是“创建了哪些 Bean”，而是：

1. `SqlSessionFactoryBean` 的输入从 `MybatisProperties` 来
2. `SqlSessionTemplate` 仍然是最终会话门面，而不是被 Boot 换掉
3. mapper 扫描并不是神秘黑盒，而是一个被自动注册的 `MapperScannerConfigurer`

## 一、`MybatisAutoConfiguration`：Boot 装配桥真正的总入口

关键类在：

- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:83` 类声明与条件注解
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:123` `afterPropertiesSet()`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:128` `checkConfigFileExists()`

从类声明就能看出它不是无条件加载：

- `@ConditionalOnClass({ SqlSessionFactory.class, SqlSessionFactoryBean.class })`
- `@ConditionalOnSingleCandidate(DataSource.class)`
- `@EnableConfigurationProperties(MybatisProperties.class)`
- `@AutoConfigureAfter({ DataSourceAutoConfiguration.class, MybatisLanguageDriverAutoConfiguration.class })`

这说明 starter 的装配桥不是“类路径上有它就一定创建”，而是至少要求：

- MyBatis Core + mybatis-spring 相关类存在
- 容器里已经有可用的单一候选 `DataSource`
- `mybatis.*` 配置已绑定成 `MybatisProperties`

也就是说，Boot 层的第一步不是“开始装 Bean”，而是先判断环境是否足以支撑这条桥成立。

## 二、`sqlSessionFactory(DataSource)`：自动装配的核心不是创建工厂，而是把所有配置灌对地方

核心方法在：

- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:136` `sqlSessionFactory(DataSource)`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:192` `applyConfiguration(...)`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:209` `applySqlSessionFactoryBeanCustomizers(...)`

这条方法很长，但逻辑很清晰：

1. new `SqlSessionFactoryBean`
2. 注入 `DataSource`
3. 如果没有自定义 VFS，就设成 `SpringBootVFS`
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
7. 最后 `factory.getObject()`

这说明 Boot 层真正关键的不是“创建了一个 `SqlSessionFactoryBean`”，而是：

**它把 MyBatis 需要的那堆分散输入，统一在自动配置层收束并注入到了正确的位置。**

## 三、`MybatisProperties`：它不是配置 DTO，而是 MyBatis CoreConfiguration 的 Boot 侧编排器

关键点在：

- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisProperties.java:48` 类声明
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisProperties.java:211` `resolveMapperLocations()`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisProperties.java:675` `CoreConfiguration.applyTo(...)`

`MybatisProperties` 表面上看像普通配置载体，实际上承担了两层责任：

### 1. 资源路径与外围输入收束

例如：

- `configLocation`
- `mapperLocations`
- `typeAliasesPackage`
- `typeHandlersPackage`
- `executorType`
- `configurationProperties`

其中 `resolveMapperLocations()` 会把配置的 mapper location 模式展开成真正的 `Resource[]`。

### 2. MyBatis CoreConfiguration 属性回填

`CoreConfiguration.applyTo(...)` 会把 Boot 侧配置一项项回写到 MyBatis `Configuration`：

- `mapUnderscoreToCamelCase`
- `cacheEnabled`
- `lazyLoadingEnabled`
- `localCacheScope`
- `defaultExecutorType`
- `defaultSqlProviderType`
- `defaultEnumTypeHandler`
- 等等等等

也就是说，`MybatisProperties` 不是“记住用户配置”这么简单，而是在负责：

**把 Boot 配置语言翻译成 MyBatis CoreConfiguration 能消费的输入。**

## 四、为什么最终还是要回到 `SqlSessionTemplate`

关键方法在：

- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:217` `sqlSessionTemplate(SqlSessionFactory)`

逻辑非常简单：

- 如果配置了 `ExecutorType`，就 `new SqlSessionTemplate(sqlSessionFactory, executorType)`
- 否则 `new SqlSessionTemplate(sqlSessionFactory)`

这一步非常重要，因为它说明：

- Boot 自动装配并没有替换掉 `S-1` 的会话门面
- 它最终仍然要回到 `SqlSessionTemplate`

也就是说，Boot 层不是新的会话模型，而是：

**自动把 `S-1` 那套会话责任桥装起来。**

这也是为什么理解顺序必须是 `S-1 -> S-2`，不能反过来。否则你会把 `SqlSessionTemplate` 误当成 starter 自己的东西。

## 五、`AutoConfiguredMapperScannerRegistrar`：为什么不写 `@MapperScan` 也有机会扫到 mapper

关键点在：

- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:239` `AutoConfiguredMapperScannerRegistrar.registerBeanDefinitions(...)`

它做的事情非常具体：

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

这就说明：

- Boot 不是偷偷改写了 mapper 注册逻辑
- 它只是自动帮你注册了 `MapperScannerConfigurer`
- 默认扫描目标是 `@Mapper`，扫描范围则来自 Boot 的自动配置包

所以“不写 `@MapperScan` 也能扫到 mapper”并不是魔法，而是：

**Boot 自动装配在适当条件下帮你补了一份最小版的 mapper 扫描配置。**

## 六、失败路径：为什么 Boot 装配桥真正重要的是退场条件，而不是“开箱即用”宣传语

### 1. 配置文件不存在

`checkConfigFileExists()` 会在启用检查时直接 fail-fast。

### 2. 没有自动配置包

`AutoConfiguredMapperScannerRegistrar` 直接日志提示后退场，不会硬扫。

### 3. 没有单一候选 DataSource

类级条件根本不会成立，整个自动配置不生效。

### 4. mapper scan 注入目标选择

`sqlSessionTemplateBeanName` 和 `sqlSessionFactoryBeanName` 的选择不是随意的，而是要先看容器里真实有哪些候选 Bean。

### 5. 语言驱动 / lazy / default scope

这些不是核心主线，但测试说明它们都受“属性 + 条件 + 版本能力”共同约束，不是你配了名字就一定生效。

所以 Boot 层真正重要的不是“帮你自动创建”，而是：

**在自动创建之前先确认条件满足；不满足时要么显式失败，要么明确退场。**

## 到这里，S-2 真正立住的不是 starter 便利性，而是“Boot 装配桥”

如果只看表面，这篇很容易被读成：

- `MybatisAutoConfiguration` 会创建一些 Bean
- `MybatisProperties` 会接收配置
- `MapperScannerConfigurer` 会扫描 mapper

这当然都对，但还不够。

更稳的理解方式应该是：

1. `MybatisAutoConfiguration` 先判断环境是否满足桥接条件
2. `MybatisProperties` 把 Boot 配置翻译成 MyBatis core 与 factory bean 的输入
3. `sqlSessionFactory(DataSource)` 负责把这些输入统一灌进 `SqlSessionFactoryBean`
4. `sqlSessionTemplate(SqlSessionFactory)` 说明 Boot 最终还是装回 `S-1` 的会话门面
5. `AutoConfiguredMapperScannerRegistrar` 说明 Boot 只是自动补注册了 Spring 那边的扫描桥，而不是重写 mapper 注册逻辑

所以这篇真正立住的是：

**Spring Boot 没有重写 MyBatis/Spring 集成层，而是在条件满足时自动把那座桥装起来。**

## 到这里，这一卷的主干与集成层已经闭合

到这里，`vol-mybatis` 的主干层、机制补深层、Spring 集成层与 Boot 装配层都已经立住：

- `M-1` 配置启动与元数据构建
- `M-2` Mapper 代理与调用语义
- `M-3` SqlSession、事务与资源生命周期
- `M-4` Executor 执行链与 JDBC 落地
- `M-5` 缓存与一致性边界
- `M-6` 动态 SQL、参数绑定与插件拦截
- `M-7` 类型处理、反射映射与结果装配
- `M-8` Cursor、ResultHandler 与增量结果消费
- `M-9` XML 与注解 Mapper 双入口
- `S-1` MyBatis 与 Spring 的会话/事务桥
- `S-2` MyBatis 在 Spring Boot 中如何自动装起来

下一步不再是继续补核心主线，而是应回到卷级：

- 统一做一轮卷级六层复审
- 再补 README、导读、总图/总索引
- 最后再决定是否追加生产层专题。