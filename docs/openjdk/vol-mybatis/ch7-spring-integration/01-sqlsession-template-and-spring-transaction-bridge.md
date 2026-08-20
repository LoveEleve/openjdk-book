# 为什么进入 Spring 之后，MyBatis 的 `SqlSession` 反而不让你手工 `commit` / `close`

> 本文基于 `mybatis-spring` 当前源码。本文只讲会话与事务桥：`SqlSessionTemplate`、`SqlSessionUtils`、`SpringManagedTransaction`、`MapperFactoryBean` 如何把原生 MyBatis 的会话责任迁移到 Spring 事务与 Bean 生命周期里。不展开 Boot 自动装配。

## 为什么“把 MyBatis 放进 Spring”不是简单多包一层 Bean

很多人第一次接触 `mybatis-spring`，最直观的印象通常是：

- 就是把 `SqlSessionFactory`、mapper 接口放进 Spring 容器

这个印象只说对了最外层的现象，却错过了真正关键的变化。

因为只要你进入 Spring 责任世界，MyBatis 的会话语义马上就变了：

- 你拿到的不是原生 `DefaultSqlSession`
- `commit()` / `rollback()` / `close()` 会直接抛 `UnsupportedOperationException`
- 同一个事务内，多次 mapper 调用会共用同一个 `SqlSession`
- 事务提交时机不再由业务代码显式控制，而是由 Spring 事务同步回调接管
- mapper 接口也不再只是 MyBatis 内部注册对象，而是变成了 Spring Bean

也就是说，进入 Spring 后，改变的不是“创建方式”，而是：

**原来由调用方和 MyBatis 自己承担的会话责任，被重新分配给 Spring 事务与 Bean 生命周期。**

## Spring 桥的最小总图

```text
MapperFactoryBean
  -> SqlSessionTemplate
    -> SqlSessionInterceptor.invoke()
      -> SqlSessionUtils.getSqlSession(...)
        -> TransactionSynchronizationManager
          -> 事务内复用或新建 SqlSession
            -> SpringManagedTransaction
              -> 决定 commit/rollback/close 是否真实下沉到 JDBC
```

这张图里最重要的不是“谁 new 了谁”，而是：

1. 会话门面换成了 `SqlSessionTemplate`
2. 会话获取不再是直接 open，而是先看当前 Spring 事务上下文
3. JDBC 提交责任不再默认属于 MyBatis 本体，而要由 `SpringManagedTransaction` 判断归属

## 一、`SqlSessionTemplate`：为什么 Spring 管理的会话门面必须禁止手工 commit/rollback/close

关键类在：

- `SqlSessionTemplate.java:75` 类声明
- `SqlSessionTemplate.java:122` 构造函数
- `SqlSessionTemplate.java:272` `commit()`
- `SqlSessionTemplate.java:282` `rollback()`
- `SqlSessionTemplate.java:287` `close()`

`SqlSessionTemplate` 本身实现了 `SqlSession`，表面上看很像可以直接替代原生 Session。

但它最重要的地方不是“方法都转发了”，而是三件被明确禁止的事：

- `commit()`
- `rollback()`
- `close()`

全部直接抛：

- `Manual commit is not allowed over a Spring managed SqlSession`
- `Manual rollback is not allowed over a Spring managed SqlSession`
- `Manual close is not allowed over a Spring managed SqlSession`

这说明在 Spring 责任世界里，业务代码已经不再拥有这些关闭权。

为什么必须这么做？因为如果还允许调用方手工提交或关闭，就会破坏：

- 当前事务中的 Session 复用
- Spring 对事务前后顺序的统一控制
- 事务同步回调里对 Session 的收束协议

所以 `SqlSessionTemplate` 并不是“更方便的 Session 包装器”，而是：

**Spring 用来强制重划 `SqlSession` 控制权边界的门面。**

## 二、`SqlSessionInterceptor.invoke()`：每次 mapper 调用之前，都要先问“当前事务里该用哪个 Session”

真正的桥接动作在：

- `SqlSessionTemplate.java:343` `SqlSessionInterceptor.invoke()`

它的流程可以压成：

1. 调 `SqlSessionUtils.getSqlSession(...)`
2. 拿到当前应使用的真实 `SqlSession`
3. 反射调用目标方法
4. 如果这不是事务内 Session，方法返回前强制 `commit(true)`
5. 异常时走 `PersistenceExceptionTranslator`
6. finally 里 `closeSqlSession(...)`

这里最重要的转折是第 4 步和第 6 步。

### 1. 非事务 Session 要强制 `commit(true)`

即便这次调用看上去不 dirty，某些数据库也要求在 close 前有一次明确的 commit/rollback 收束。

### 2. close 不是直接 `sqlSession.close()`

而是交给 `SqlSessionUtils.closeSqlSession(...)` 去判断它到底是不是事务内复用的 Session。

也就是说：

**同样是一次 mapper 调用，Spring 管理的 `SqlSession` 在方法调用前后都要先过一层“当前责任归谁”的判断。**

## 三、`SqlSessionUtils.getSqlSession()`：为什么 MyBatis 进入 Spring 后，会话获取首先变成线程/事务上下文问题

关键入口在：

- `SqlSessionUtils.java:65` `getSqlSession(...)`
- `SqlSessionUtils.java:131` `registerSessionHolder(...)`
- `SqlSessionUtils.java:160` `sessionHolder(...)`
- `SqlSessionUtils.java:186` `closeSqlSession(...)`
- `SqlSessionUtils.java:210` `isSqlSessionTransactional(...)`

`getSqlSession(...)` 的逻辑不是“永远 open 一个新的 Session”，而是：

1. 先从 `TransactionSynchronizationManager.getResource(sessionFactory)` 取 `SqlSessionHolder`
2. 如果 holder 已存在且同步到当前事务，就直接返回里面的 Session
3. 否则才 `sessionFactory.openSession(executorType)`
4. 然后再尝试 `registerSessionHolder(...)`

这说明一旦进入 Spring，`SqlSession` 获取的首要问题就不再是：

- 怎么 new

而是：

- 当前线程/事务上下文里有没有已经可复用的 Session

### `registerSessionHolder(...)`

它进一步定义了一个关键约束：

- 只有在 Spring 事务同步激活，且 `TransactionFactory` 是 `SpringManagedTransactionFactory` 时，才能把 Session 注册进事务同步体系

如果有 Spring 事务，但 `SqlSessionFactory` 还在用非 Spring 的 transaction factory，就直接抛：

- `SqlSessionFactory must be using a SpringManagedTransactionFactory ...`

这说明 MyBatis 进入 Spring 并不是“你放进去就行”，而是：

**它要求底层事务工厂也切换到 Spring 责任模型，否则会话桥根本不成立。**

## 四、`SqlSessionSynchronization`：谁真正决定事务提交前后 Session 何时 flush、何时解绑、何时关闭

关键回调在：

- `SqlSessionUtils.java:262` `beforeCommit(boolean readOnly)`
- `SqlSessionUtils.java:286` `beforeCompletion()`
- `SqlSessionUtils.java:300` `afterCompletion(int status)`

这里可以把 Session 生命周期在 Spring 事务里的节奏看得很清楚：

### 1. `beforeCommit()`

如果当前事务真的活跃，就调用：

- `holder.getSqlSession().commit()`

注意这里并不是业务代码显式 commit，而是事务同步回调在提交前主动 flush Session / Executor。

### 2. `beforeCompletion()`

如果 holder 已经不 open，就：

- 从 `TransactionSynchronizationManager` 解绑
- 关闭 `SqlSession`

这里专门提前做，是因为 `afterCompletion()` 可能会在别的线程里被调用。

### 3. `afterCompletion()`

如果 holder 还 active，就再次安全解绑并关闭 Session，最后 reset holder。

这说明 Spring 事务桥真正厉害的地方不在“能绑定资源”，而在：

**它把 Session 的 flush、解绑、关闭全部插进了事务生命周期的精确时机里。**

所以在 Spring 世界里，会话关闭权已经不在调用方，也不完全在 MyBatis，而是在事务同步回调协议里。

## 五、`SpringManagedTransaction`：为什么它有时像 `JdbcTransaction`，有时却完全 no-op

关键点在：

- `transaction/SpringManagedTransaction.java:44` 类声明
- `transaction/SpringManagedTransaction.java:82` `openConnection()`
- `transaction/SpringManagedTransaction.java:94` `commit()`
- `transaction/SpringManagedTransaction.java:102` `rollback()`
- `transaction/SpringManagedTransaction.java:110` `close()`

`openConnection()` 做了两件特别关键的事：

1. 通过 `DataSourceUtils.getConnection(dataSource)` 从 Spring 取连接
2. 计算当前连接是否已经被 Spring 事务管理

于是后面 `commit()` / `rollback()` 的语义就变成：

- 如果连接已被 Spring 事务接管，且非 autoCommit，就 no-op
- 否则就像 `JdbcTransaction` 一样真正下沉到 JDBC

所以 `SpringManagedTransaction` 不是简单替换了 `JdbcTransaction`，而是在做一件更微妙的事：

**它把“这次提交责任到底属于 MyBatis 还是属于 Spring”这个判断编码进了事务对象本身。**

而 `close()` 走的是：

- `DataSourceUtils.releaseConnection(...)`

这说明关闭责任也不再是“直接关 JDBC Connection”，而是“把连接还回 Spring 的资源管理体系”。

## 六、`MapperFactoryBean`：mapper 接口什么时候从 MyBatis 内部对象变成 Spring Bean

关键点在：

- `mapper/MapperFactoryBean.java:79` `checkDaoConfig()`
- `mapper/MapperFactoryBean.java:98` `getObject()`

`MapperFactoryBean` 干的事情很克制，但特别关键：

1. 确保 `mapperInterface` 已配置
2. 拿到当前 `SqlSession` 的 `Configuration`
3. 如果 `addToConfig=true` 且 MyBatis 里还没有这个 mapper，就 `configuration.addMapper(mapperInterface)`
4. 真正 `getObject()` 时，返回的是 `getSqlSession().getMapper(mapperInterface)`

这说明 Spring 容器里的 mapper Bean 并不是另外一套代理系统，而是：

- 先在需要时把 mapper 纳入 MyBatis 的注册体系
- 再从 Spring 管理的 `SqlSessionTemplate` 里取回原本那条 `MapperProxy` 主线

也就是说，`MapperFactoryBean` 的作用不是“替代 MyBatis 代理”，而是：

**把 MyBatis 已有的 mapper 代理协议接进 Spring Bean 生命周期。**

## 七、失败路径：为什么 `mybatis-spring` 真正值钱的是责任边界，而不是集成便利性

### 1. 手工 commit/rollback/close

`SqlSessionTemplate` 直接禁止。

### 2. 事务内切换 `ExecutorType`

`SqlSessionUtils.sessionHolder(...)` 会直接拒绝在已有事务中切换 `ExecutorType`。

### 3. 非 `SpringManagedTransactionFactory` 但又尝试事务同步

`registerSessionHolder(...)` 直接抛异常。

### 4. 非事务 Session 的关闭语义

`SqlSessionInterceptor.invoke()` 会在非事务场景下强制 `commit(true)` 再走关闭流程。

### 5. mapper Bean 注册和 MyBatis 配置不同步

`MapperFactoryBean.checkDaoConfig()` 会在初始化期主动校验并补注册，而不是等运行时才炸。

所以这层最重要的不是“Spring 集成起来很方便”，而是：

**它把原生 MyBatis 中调用方持有的会话责任，重新精确地交给了 Spring 的事务与 Bean 生命周期。**

## 到这里，S-1 真正立住的不是几个适配类，而是“会话责任重分配协议”

如果只看类名，这篇很容易被读成：

- `SqlSessionTemplate` 是模板类
- `SqlSessionUtils` 是工具类
- `SpringManagedTransaction` 是事务适配类
- `MapperFactoryBean` 是工厂 Bean

这当然都对，但完全不够。

更稳的理解方式应该是：

1. `SqlSessionTemplate` 收走了业务代码的手工会话关闭权
2. `SqlSessionUtils` 把 Session 绑定进 Spring 事务同步体系
3. `SpringManagedTransaction` 决定 JDBC 提交责任归谁
4. `MapperFactoryBean` 把 mapper 接口接进 Spring Bean 生命周期，同时仍回到 MyBatis 原生代理主线

所以这篇真正立住的是：

**进入 Spring 之后，MyBatis 的 `SqlSession` 不再由调用方直接控制，而是被重分配到 Spring 的事务与 Bean 责任世界。**

## 这篇之后，最自然的继续方向

到这里，Spring 集成层的责任桥已经立住。下一步最自然的继续方向就是：

- 在 Spring Boot 下，这套桥为什么只加 starter 就能自动生效
- `MybatisAutoConfiguration`、`MybatisProperties`、`MapperScannerConfigurer` / `AutoConfiguredMapperScannerRegistrar` 怎样把它装起来

也就是说，下一篇应该进入 `S-2 MyBatis 在 Spring Boot 中如何自动装起来`。