# 卷 MyBatis · 配置、执行链与 Spring/Boot 集成源码分析

> 本卷基于 MyBatis 3.5.16、`mybatis-spring` 与 `mybatis-spring-boot-starter` 当前源码。目标不是按包翻译仓库，而是把“配置启动 -> 接口调用 -> 会话与事务 -> 执行链 -> 映射装配 -> Spring/Boot 接桥”收束成一卷可连续阅读的源码书。

## 当前卷级状态

- 已完成核心主干层：`M-1 ~ M-5`
- 已完成机制补深层：`M-6 ~ M-9`
- 已完成 Spring 集成层：`S-1`
- 已完成 Boot 装配层：`S-2`
- 已完成卷级六层总审
- 当前属于阶段性收口，不等同于覆盖全部生产排障专题

## 篇章目录

### A. MyBatis 核心主干层

- [M-1 配置启动与元数据构建](ch1-bootstrap/01-configuration-bootstrap.md)
- [M-2 MapperProxy 动态代理与方法分发](ch1-bootstrap/02-mapper-proxy-and-method-dispatch.md)
- [M-3 SqlSession、事务与资源生命周期](ch1-bootstrap/03-sqlsession-transaction-and-resource-lifecycle.md)
- [M-4 Executor 执行链与 JDBC 落地](ch1-bootstrap/04-executor-and-jdbc-execution-chain.md)
- [M-5 缓存与一致性边界](ch2-cache/01-cache-consistency-and-transaction-boundary.md)

### B. MyBatis 机制补深层

- [M-6 动态 SQL、参数绑定与插件拦截](ch3-dynamic-sql/01-dynamic-sql-parameter-binding-and-plugin-chain.md)
- [M-7 类型处理、反射映射与结果装配](ch4-mapping/01-type-reflection-and-result-mapping.md)
- [M-8 Cursor、ResultHandler 与增量结果消费](ch5-cursor/01-cursor-and-streaming-result-consumption.md)
- [M-9 XML 与注解 Mapper 双入口](ch6-dual-entry/01-xml-and-annotation-dual-entry.md)

### C. Spring 集成层

- [S-1 SqlSessionTemplate 与 Spring 事务桥](ch7-spring-integration/01-sqlsession-template-and-spring-transaction-bridge.md)

### D. Boot 装配层

- [S-2 MyBatis 在 Spring Boot 中如何自动装起来](ch8-boot-autoconfigure/01-mybatis-boot-autoconfiguration-bridge.md)

## 推荐阅读顺序

`M-1 -> M-2 -> M-3 -> M-4 -> M-5 -> M-6 -> M-7 -> M-8 -> M-9 -> S-1 -> S-2`

这个顺序先建立 MyBatis 自身协议，再解释它如何进入 Spring，最后解释它如何被 Spring Boot 自动装起来。

## 这卷已经能回答什么

- `mybatis-config.xml` 与 mapper 资源如何收束成 `Configuration`
- mapper 接口为什么没有实现也能执行 SQL
- `SqlSession` 为什么是资源责任中心
- 一次调用如何穿过 Executor、StatementHandler、ParameterHandler 和 ResultSetHandler
- 一级/二级缓存为什么受会话与事务边界约束
- 动态 SQL、参数绑定、插件链如何形成执行期协议
- Java 类型、反射元数据和对象图装配如何协同工作
- Cursor 为什么不是懒 List，而是增量消费协议
- XML 与注解 mapper 为什么不是两套并列系统
- MyBatis 进入 Spring 与 Spring Boot 后，会话和装配责任如何重分配

## 当前仍未覆盖的边界

本卷尚未把生产排障层单独成组。当前已明确的候选包括：

- 大结果集与 `cursor_cache_oom` 边界
- 二级缓存阻塞锁与一致性排障
- `BatchExecutor` 的异常收束与整批回滚边界
- 懒加载线程与生命周期边界

也就是说，本卷主干与集成层已经闭合，但“生产排障层”仍是下一阶段补层。