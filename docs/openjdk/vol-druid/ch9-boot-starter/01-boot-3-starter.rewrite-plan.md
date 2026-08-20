# Druid Ch9-01 Spring Boot 3 Starter — 正文写作规划

## 文章定位
- 写作卷：`vol-druid`
- 章节：Ch9 Boot Starter
- 篇：01 Spring Boot 3 怎么把 Druid 装成默认 DataSource
- 对应主题：`D-9 Spring Boot 3 Starter`
- 文章类型：集成层篇

## 前置依赖
- HARD：读者应已读过 D-1 池本体，知道 `DruidDataSource` 的 `init()` 是启动转折点
- SOFT：`vol-springboot` 会讲 Boot 通用自动装配机制，本篇只聚焦 Druid 自己的 Starter

## 一句话困惑
为什么 Spring Boot 3 的默认 DataSource 是 HikariCP，但 Druid 只要加一个 `druid-spring-boot-3-starter` 依赖就能自己接上去，不需要改其他代码？

## 一句话顿悟
Druid 的 Starter 替换 Boot 默认 DataSource 的路径是：`DruidDataSourceAutoConfigure` 被 `@ConditionalOnClass` 激活，释放 `DruidDataSourceWrapper`（继承 `DruidDataSource` 并实现 `InitializingBean`），在 `afterPropertiesSet()` 中调用 `init()`，同时自动注册 `StatViewServlet` 和 `WebStatFilter`。

## 读者理解路径
1. 从“Boot 怎么认出 Druid”切入
2. 最小总图：`@ConditionalOnClass` → `DruidDataSourceAutoConfigure` → `DruidDataSourceWrapper` → `afterPropertiesSet()` → `init()`
3. 解释 `DruidDataSourceAutoConfigure` 的自动装配链
4. 解释 `DruidDataSourceWrapper` 为什么继承 + `InitializingBean`
5. 解释 `StatViewServlet` / `WebStatFilter` / `DruidWebStatFilterConfiguration` 自动注册
6. 收束：Starter 是 Druid 与 Boot 的装配桥

## 文章结构与字数预算
1. 困惑开场（800-1000 字）
2. 最小总图：AutoConfigure → init() → Servlet/Filter 注册（1200-1500 字）
3. `DruidDataSourceAutoConfigure` 自动装配链（1600-2200 字）
4. `DruidDataSourceWrapper` 继承 + `InitializingBean`（1600-2200 字）
5. `StatViewServlet` / `WebStatFilter` 注册（1400-2000 字）
6. 收网总结（800-1000 字）

## 证据清单
- `DruidDataSourceAutoConfigure.java:53` 类声明
- `DruidDataSourceAutoConfigure.java:48` `@EnableConfigurationProperties({DruidStatProperties.class, DataSourceProperties.class})`
- `DruidDataSourceAutoConfigure.java:50` `@Import({DruidStatViewServletConfiguration.class, ...})`
- `DruidDataSourceAutoConfigure.java:67` `@Bean DruidDataSourceWrapper dataSource()`
- `DruidDataSourceWrapper.java:31` `class DruidDataSourceWrapper extends DruidDataSource implements InitializingBean`
- `DruidDataSourceWrapper.java:36` `afterPropertiesSet()`
- `DruidDataSourceWrapper.java:51` `init()`
- `DruidStatViewServletConfiguration.java:34` `statViewServletRegistrationBean`
- `DruidWebStatFilterConfiguration.java:32` `webStatFilterRegistrationBean`
- `DruidStatProperties.java:24` 类声明

## 写作后检查
- [ ] 开篇不是配置清单，而是“Boot 怎么认出 Druid”的困惑
- [ ] 总图明确区分：AutoConfigure / Wrapper / init / Servlet/Filter 注册
- [ ] 不把 `DruidDataSourceWrapper` 写成普通 `DataSource` 实现，而是“继承 + `InitializingBean`”的装配桥
- [ ] 所有 file:line 写作时重新 grep 验证