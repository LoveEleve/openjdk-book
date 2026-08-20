# Spring Boot 3 怎么把 Druid 装成默认 DataSource

> 本文基于 Druid 1.2.27 与 Spring Boot 3.5.16 当前源码。本文只讲 Druid 的 Boot Starter 装配桥：`DruidDataSourceAutoConfigure` 如何被激活、`DruidDataSourceWrapper` 如何继承 + `InitializingBean` 接入 `init()`、`StatViewServlet` / `WebStatFilter` 如何自动注册。不重讲 Druid 池本体内部。

## 为什么只加一个依赖就能替换 HikariCP

Spring Boot 3 的默认 DataSource 是 HikariCP。但如果你在 `pom.xml` 里加上 `druid-spring-boot-3-starter`，Druid 就会自动成为默认 DataSource，不需要改任何代码。

这个替换路径不是靠黑魔法，而是靠 Druid 的 Boot Starter 做了一件事：在 Boot 的自动装配体系中，用 `@ConditionalOnClass` 激活 Druid 自己的 `DruidDataSourceAutoConfigure`，然后释放一个 `DruidDataSourceWrapper` bean。

## Boot 装配的最小总图

```text
druid-spring-boot-3-starter
  -> DruidDataSourceAutoConfigure
    -> @ConditionalOnClass 激活
    -> @EnableConfigurationProperties(DruidStatProperties, DataSourceProperties)
    -> @Import({DruidStatViewServletConfiguration, DruidWebStatFilterConfiguration, ...})
    -> @Bean DruidDataSourceWrapper dataSource()
      -> afterPropertiesSet() -> init()
```

## 一、`DruidDataSourceAutoConfigure` 自动装配链

入口是 `DruidDataSourceAutoConfigure`：

- `DruidDataSourceAutoConfigure.java:53` 类声明
- `DruidDataSourceAutoConfigure.java:48` `@EnableConfigurationProperties({DruidStatProperties.class, DataSourceProperties.class})`
- `DruidDataSourceAutoConfigure.java:50` `@Import({DruidStatViewServletConfiguration.class, DruidWebStatFilterConfiguration.class, DruidSpringAopConfiguration.class})`
- `DruidDataSourceAutoConfigure.java:67` `@ConditionalOnMissingBean` 条件下创建 `DruidDataSourceWrapper` 的 `@Bean`

它同时通过 `spring.datasource.type` 条件、`@ConditionalOnClass` 和 `@AutoConfigureBefore(DataSourceAutoConfiguration.class)` 控制激活；默认类型条件指向 Druid，且只有在容器中不存在其他 `DataSource` 时才创建自己的 bean。

## 二、`DruidDataSourceWrapper`：继承 + `InitializingBean`

`DruidDataSourceWrapper` 是 Druid 与 Boot 之间的装配桥：

- `DruidDataSourceWrapper.java:31` `class DruidDataSourceWrapper extends DruidDataSource implements InitializingBean`
- `DruidDataSourceWrapper.java:36` `afterPropertiesSet()`
- `DruidDataSourceWrapper.java:51` `init()`

它不只是一个普通的 `DataSource` 实现。

它继承 `DruidDataSource`，所以池本体所有能力全部继承。
它实现 `InitializingBean`，所以 Spring 在装配完 `@ConfigurationProperties` 绑定的属性后，会自动调用 `afterPropertiesSet()`，然后触发 `init()`。

也就是说：Boot 把配置绑定到 `DruidDataSourceWrapper` → Spring 调 `afterPropertiesSet()` → `init()` 启动池。

这条链不需要用户手写任何 `new DruidDataSource()` 或 `init()` 调用。

## 三、`StatViewServlet` / `WebStatFilter` 自动注册

Boot 装配不只是建一个 DataSource bean，还自动注册两个监控端点：

- `DruidStatViewServletConfiguration.java:34` `statViewServletRegistrationBean`
- `DruidWebStatFilterConfiguration.java:32` `webStatFilterRegistrationBean`

它们分别对应 Druid 控制台页面和 Web 请求统计 filter；两者的配置类都要求 Web 应用环境，并通过 `@ConditionalOnProperty(...enabled=true)` 才会注册。

`DruidStatProperties` 控制它们的开启/关闭路径：

- `DruidStatProperties.java:24` 类声明
- `DruidStatProperties.java:53` `StatViewServlet` 内部类
- `DruidStatProperties.java:122` `WebStatFilter` 内部类

两组属性的 `enabled` 默认值都是 `false`，需要用户显式配置 `spring.datasource.druid.stat-view-servlet.enabled=true` 和 `spring.datasource.druid.web-stat-filter.enabled=true` 才会注册。

## 这一篇真正立住的，不是 Starter 配置，而是“Druid 与 Boot 之间的装配桥”

1. `DruidDataSourceAutoConfigure` 通过 `@ConditionalOnClass` 激活
2. `DruidDataSourceWrapper` 继承 + `InitializingBean` 接入 `init()`
3. `StatViewServlet` / `WebStatFilter` 自动注册（默认关闭）
4. 用户只需要加依赖 + 配置，不需要手写 `new DruidDataSource()`

## 这篇之后，`vol-druid` 就到收口点了

到这里，`vol-druid` 全部 9 篇已经完成，覆盖了：
- D-1 连接池核心
- D-5 连接池维护体系
- D-2 Filter 拦截链
- D-3 StatFilter SQL 监控
- D-6 SQL Parser 体系架构
- D-4 WallFilter SQL 防火墙
- D-7 连接验证与健康检查
- D-8 PreparedStatementPool
- D-9 Spring Boot 3 Starter

下一步应做卷级收尾：README、导读、总图索引，以及一致性复查。