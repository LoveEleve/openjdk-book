# 篇：01 MyBatis 在 Spring Boot 中如何自动装起来

- 域：`S-2 MyBatis 在 Spring Boot 中如何自动装起来`
- 卷：`vol-mybatis`
- 目标：回答 `mybatis-spring-boot-starter` 为什么只加依赖就能自动拥有 `SqlSessionFactory`、`SqlSessionTemplate` 与 mapper 扫描；并把 Boot 自动装配层和 `S-1` 的 Spring 事务桥明确分层。

## 前置依赖

- HARD：已读 `S-1`，知道 `SqlSessionTemplate`、`SqlSessionUtils`、`SpringManagedTransaction`、`MapperFactoryBean` 的责任边界。

## 读者问题

为什么在 Spring Boot 下，不手写 `SqlSessionFactoryBean`、`SqlSessionTemplate` 或 `MapperScannerConfigurer`，MyBatis 依然会自己装起来？以及：

1. 哪些条件满足时自动配置才会生效
2. `MybatisProperties` 只是配置载体，还是会真正改写 MyBatis `Configuration`
3. `MapperScannerConfigurer` / `AutoConfiguredMapperScannerRegistrar` 在 Boot 里扮演什么角色
4. 语言驱动、type aliases、type handlers、mapperLocations 为什么都能从属性自动灌进去

## 主结论

Boot 层不是重写 MyBatis 或 Spring 桥，而是在条件满足时自动把 `S-1` 那套责任桥装起来：

`MybatisAutoConfiguration`
  -> `checkConfigFileExists()`
  -> `sqlSessionFactory(DataSource)`
    -> `SqlSessionFactoryBean`
    -> `applyConfiguration()`
    -> `setPlugins/typeAliases/typeHandlers/mapperLocations/...`
  -> `sqlSessionTemplate(SqlSessionFactory)`
    -> `SqlSessionTemplate`
  -> `AutoConfiguredMapperScannerRegistrar.registerBeanDefinitions(...)`
    -> `MapperScannerConfigurer`
      -> 自动扫描 `@Mapper`

同时：

- `MybatisProperties` 负责把 Boot 配置收束成 `SqlSessionFactoryBean` 与 MyBatis Core `Configuration` 的输入
- `MybatisLanguageDriverAutoConfiguration` 等自动配置负责补齐语言驱动等生态装配

## 结构设计

1. 困惑开场：为什么只加 starter 就能自动有 MyBatis 全套 Bean
2. 最小总图：`MybatisAutoConfiguration` -> `SqlSessionFactoryBean` -> `SqlSessionTemplate` -> mapper scan
3. 自动配置生效条件：`@ConditionalOnClass`、单 DataSource、配置属性绑定
4. `sqlSessionFactory(DataSource)`：Boot 如何把 DataSource、plugins、type aliases/handlers、mapper locations 注入进去
5. `MybatisProperties`：配置如何从 `mybatis.*` 收束到 CoreConfiguration / Resource[] / ExecutorType
6. `sqlSessionTemplate(SqlSessionFactory)`：为什么 Boot 最后还是装回 `S-1` 那个会话门面
7. `AutoConfiguredMapperScannerRegistrar`：为什么不写 `@MapperScan` 也可能自动扫到 mapper
8. 失败路径与条件退场：配置文件不存在、无自动配置包、懒加载/默认 scope/语言驱动条件
9. 收网：这篇立住的是“Boot 装配桥”，不是又一套 MyBatis 核心机制
10. 下篇桥接：回到卷级收尾与总审

## 必须回填的源码锚点

- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:83` 类声明与条件注解
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:123` `afterPropertiesSet()`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:128` `checkConfigFileExists()`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:136` `sqlSessionFactory(DataSource)`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:192` `applyConfiguration(...)`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:209` `applySqlSessionFactoryBeanCustomizers(...)`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:217` `sqlSessionTemplate(SqlSessionFactory)`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:239` `AutoConfiguredMapperScannerRegistrar.registerBeanDefinitions(...)`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisProperties.java:48` 类声明
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisProperties.java:211` `resolveMapperLocations()`
- `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisProperties.java:675` `CoreConfiguration.applyTo(...)`

## 必须引用的测试/证据

- `MybatisAutoConfigurationTest`
- `MybatisPropertiesTest`
- 语言驱动自动配置测试
- mapper scan / lazy/default-scope 测试

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。