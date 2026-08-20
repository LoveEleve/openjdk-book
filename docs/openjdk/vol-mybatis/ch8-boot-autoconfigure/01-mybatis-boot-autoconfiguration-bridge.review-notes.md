# S-2 MyBatis Boot 自动装配桥 — review notes

## 事实审

- 已核对 `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:83`、`:123`、`:128`、`:136`、`:192`、`:209`、`:217`，自动配置入口、配置文件检查、工厂创建、配置灌入与 `SqlSessionTemplate` 创建主线成立。
- 已核对 `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisAutoConfiguration.java:239` `AutoConfiguredMapperScannerRegistrar.registerBeanDefinitions(...)`，自动 mapper 扫描主线成立。
- 已核对 `mybatis-spring-boot-autoconfigure/src/main/java/org/mybatis/spring/boot/autoconfigure/MybatisProperties.java:48`、`:211`、`:675`，配置收束、mapper location 展开与 CoreConfiguration 回填主线成立。
- 已补测试证据：`MybatisAutoConfigurationTest`、`MybatisPropertiesTest`、语言驱动自动配置测试、mapper scan lazy/default-scope 相关测试。

## 因果审

- Boot 自动装配不是重写 MyBatis/Spring 集成层，而是自动创建 `SqlSessionFactoryBean`、`SqlSessionTemplate` 和 mapper 扫描桥，这个判断成立。
- `MybatisProperties` 把 Boot 配置翻译为 CoreConfiguration 与 factory bean 输入，正文成立。
- `AutoConfiguredMapperScannerRegistrar` 自动注册 `MapperScannerConfigurer`，而不是重写 mapper 注册逻辑，正文成立。
- `sqlSessionTemplate(SqlSessionFactory)` 说明 Boot 最终仍回到 `S-1` 的会话门面，正文成立。

## 结构审

- 从“为什么只加 starter 就能装起来”切入，再落到条件注解、工厂创建、属性回填、模板创建和 mapper scan，主线集中。
- 没有把 starter 使用手册和属性表直接平铺成正文，符合方法论。

## 读者审

- 读完应能回答：为什么没有 `@MapperScan` 时也可能自动扫到 mapper。
- 读完应能回答：为什么 Boot 配置不是直接改 MyBatis 核心源码，而是改工厂和配置输入。
- 读完后能自然进入卷级收尾，而不会误以为还缺核心主线。

## 边界审

- 本篇没有重新展开 `S-1` 的事务桥内部实现。
- MyBatis 核心执行/映射细节只作为背景，不重写，边界成立。

## 依赖审

- 前置依赖：S-1 Spring 会话/事务桥。
- 后续桥接：卷级总审、README、导读、总图索引成立。

## 结论

S-2 已完成单域四件套的事实回填与六层审查，`vol-mybatis` 的主干与集成层已闭合，可进入卷级总审与收尾。