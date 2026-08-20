# 篇：01 SqlSessionTemplate 与 Spring 事务桥

- 域：`S-1 MyBatis 与 Spring 的会话/事务桥`
- 卷：`vol-mybatis`
- 目标：回答 MyBatis 进入 Spring 后，为什么 `SqlSession` 不再由调用方直接 commit/rollback/close，谁负责把它和当前 Spring 事务绑定，谁把 mapper 接口变成 Spring Bean。

## 前置依赖

- HARD：已读 `M-3`、`M-9`，知道原生 `SqlSession` 生命周期和 mapper 注册主线。

## 读者问题

为什么一旦进入 Spring，MyBatis 的会话责任世界会变成：

1. 业务代码拿到的是 `SqlSessionTemplate`，而不是真实 `DefaultSqlSession`
2. `commit()` / `rollback()` / `close()` 会被直接禁止
3. 当前事务里可以复用同一个 `SqlSession`
4. `SpringManagedTransaction` 有时像 `JdbcTransaction`，有时又完全 no-op
5. mapper 接口能够直接变成 Spring Bean，并按需再注册进 MyBatis `Configuration`

## 主结论

MyBatis 进入 Spring 之后，不是简单“多包一层 Bean”，而是会话责任被重新分配：

`MapperFactoryBean`
  -> `SqlSessionTemplate`
    -> `SqlSessionInterceptor.invoke()`
      -> `SqlSessionUtils.getSqlSession(...)`
        -> `TransactionSynchronizationManager`
          -> 复用或创建当前事务绑定的 `SqlSession`
            -> `SpringManagedTransaction`
              -> 决定 commit/rollback/close 是否真实下沉到 JDBC

也就是说：

- `SqlSessionTemplate` 是 Spring 责任世界里的会话门面
- `SqlSessionUtils` 是线程/事务绑定桥
- `SpringManagedTransaction` 是原生事务边界向 Spring 事务边界的适配器
- `MapperFactoryBean` 是 mapper 接口进入 Spring Bean 世界的桥

## 结构设计

1. 困惑开场：为什么进入 Spring 后，`SqlSession` 反而不让你手工 close/commit
2. 最小总图：`MapperFactoryBean` -> `SqlSessionTemplate` -> `SqlSessionUtils` -> `SpringManagedTransaction`
3. `SqlSessionTemplate`：Spring 管理的会话门面与“禁止手工提交/关闭”
4. `SqlSessionInterceptor.invoke()`：每次方法调用如何取当前事务对应的 Session
5. `SqlSessionUtils.getSqlSession()` / `closeSqlSession()`：线程绑定、引用计数与事务同步
6. `SqlSessionSynchronization.beforeCommit()/afterCompletion()`：谁在事务前后真正收束 Session
7. `SpringManagedTransaction`：何时 no-op，何时像 `JdbcTransaction` 一样真正 commit/rollback
8. `MapperFactoryBean.checkDaoConfig()`：mapper 接口如何作为 Spring Bean 进入容器
9. 失败路径：非 SpringManagedTransactionFactory、ExecutorType 冲突、非事务 Session 关闭与异常翻译
10. 收网：这篇立住的是“会话责任重分配协议”，不是 Spring Bean 配置技巧
11. 下篇桥接：进入 `S-2` Boot 自动装配桥

## 必须回填的源码锚点

- `SqlSessionTemplate.java:75` 类声明
- `SqlSessionTemplate.java:122` 构造函数
- `SqlSessionTemplate.java:272` `commit()`
- `SqlSessionTemplate.java:282` `rollback()`
- `SqlSessionTemplate.java:287` `close()`
- `SqlSessionTemplate.java:343` `SqlSessionInterceptor.invoke()`
- `SqlSessionUtils.java:65` `getSqlSession(SqlSessionFactory, ExecutorType, PersistenceExceptionTranslator)`
- `SqlSessionUtils.java:131` `registerSessionHolder(...)`
- `SqlSessionUtils.java:160` `sessionHolder(...)`
- `SqlSessionUtils.java:186` `closeSqlSession(...)`
- `SqlSessionUtils.java:210` `isSqlSessionTransactional(...)`
- `SqlSessionUtils.java:262` `beforeCommit(boolean readOnly)`
- `SqlSessionUtils.java:286` `beforeCompletion()`
- `SqlSessionUtils.java:300` `afterCompletion(int status)`
- `transaction/SpringManagedTransaction.java:44` 类声明
- `transaction/SpringManagedTransaction.java:82` `openConnection()`
- `transaction/SpringManagedTransaction.java:94` `commit()`
- `transaction/SpringManagedTransaction.java:102` `rollback()`
- `transaction/SpringManagedTransaction.java:110` `close()`
- `mapper/MapperFactoryBean.java:79` `checkDaoConfig()`
- `mapper/MapperFactoryBean.java:98` `getObject()`

## 必须引用的测试/证据

- `SqlSessionTemplateTest`
- `MapperFactoryBeanTest`
- `SqlSessionDaoSupportTest`
- 事务同步与异常翻译相关测试

## note / review 约束

- note 只记主张、边界、下篇桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。