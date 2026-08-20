# S-1 SqlSessionTemplate 与 Spring 事务桥 — review notes

## 事实审

- 已核对 `SqlSessionTemplate.java:75`、`:122`、`:272`、`:282`、`:287`、`:343`，Spring 管理会话门面、禁止手工提交/关闭与调用拦截主线成立。
- 已核对 `SqlSessionUtils.java:94`、`:131`、`:160`、`:186`、`:210`、`:262`、`:286`、`:300`，Session 获取、注册、事务同步与关闭主线成立。
- 已核对 `transaction/SpringManagedTransaction.java:44`、`:82`、`:94`、`:102`、`:110`，Spring 托管事务边界成立。
- 已核对 `mapper/MapperFactoryBean.java:79`、`:98`，mapper Bean 如何接入 Spring 与 MyBatis 主线成立。
- 已补测试证据：`SqlSessionTemplateTest`、`MapperFactoryBeanTest`、`SqlSessionDaoSupportTest` 等对事务桥与 mapper Bean 语义形成支撑。

## 因果审

- `SqlSessionTemplate` 禁止手工 commit/rollback/close，是因为这些责任已转交给 Spring 事务同步，正文成立。
- `SqlSessionUtils` 先查 `TransactionSynchronizationManager` 再决定复用或新建 Session，这条桥接逻辑成立。
- `SpringManagedTransaction` 通过“连接是否已被 Spring 管理”判断是否真实下沉到 JDBC，正文成立。
- `MapperFactoryBean` 不是替代 MyBatis 代理，而是把 mapper 接口接进 Spring Bean 生命周期，正文成立。

## 结构审

- 从“为什么进入 Spring 后反而不让你手工 close/commit”切入，再落到门面、线程绑定、事务同步、事务适配与 Bean 化，主线集中。
- 没有把 Spring XML/Bean 配置手册写成正文主线，符合方法论。

## 读者审

- 读完应能回答：为什么同一事务里 MyBatis 能复用同一个 `SqlSession`。
- 读完应能回答：为什么 `SpringManagedTransaction` 有时像 `JdbcTransaction`，有时又完全 no-op。
- 读完后能自然进入 Boot 自动装配，而不会把 Boot starter 误当成核心桥。 

## 边界审

- 本篇没有提前透支 Boot 自动装配层。
- MyBatis 核心执行与映射细节只作为背景，不重写，边界成立。

## 依赖审

- 前置依赖：M-3 原生会话/事务边界、M-9 mapper 注册主线。
- 后续桥接：S-2 Boot 自动装配桥成立。

## 结论

S-1 已完成单域四件套的事实回填与六层审查，可进入 Boot 装配层。