# `@Transactional` 到底把哪些操作绑进了“同一个事务”：从 AOP 拦截到 JDBC Connection 的完整链路

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring 事务主线的第一层：`TransactionInterceptor` 如何拦截 `@Transactional` 方法，`TransactionAttributeSource` 如何读取事务配置，`AbstractPlatformTransactionManager.getTransaction(...)` 和 `DataSourceTransactionManager.doBegin(...)` 如何真正开启事务，以及为什么“同一线程内所有数据库操作共享同一连接”是 Spring 事务能成立的根本。失效场景、传播行为、异常翻译会在后续篇章展开。

## 为什么 `@Transactional` 看起来只是一个注解，Spring 却要把一大串 JDBC 操作绑到同一个连接上

前面已经讲了 AOP 责任链、自动代理和 `@AspectJ` 解析。这里把这些串起来，就会遇到 Spring 最著名的注解之一：`@Transactional`。

从使用者的角度，一句 `@Transactional` 看起来只是“让这个方法事务化”。

但从 Spring 源码角度，它需要：

- 通过 AOP 拦截方法
- 读取注解上的事务配置
- 从数据源获取一个 JDBC Connection
- 关闭自动提交
- 执行方法里的所有数据库操作
- 最后统一提交或回滚

第一层问题是：**`@Transactional` 的实质是把多个 JDBC 操作绑定到同一个 Connection，并控制提交时机。**

如果方法里有两个 insert，分别用两个不同的 Connection，那么一个成功、一个失败时，整体就不可能原子回滚。所以 Spring 必须先保证“同一事务内的所有操作走同一个连接”。

这个“同一个连接”是如何保证的？靠核心类是 `TransactionSynchronizationManager`：

- 它用 ThreadLocal 保存当前线程的 `ConnectionHolder`
- 数据源从 `DataSourceUtils.getConnection(...)` 取连接时，先查 ThreadLocal 中是否有当前数据源对应的连接
- 有，就复用；没有，才新建

所以同一线程内，方法调 Repository，Repository 内部再从同一个数据源取连接时，拿到的一定是同一个 Connection。

第二层问题是：**`TransactionAttributeSource` 和 `TransactionManager` 是分离的两条线。**

`TransactionAttributeSource` 负责“读注解”：

- 传播行为
- 隔离级别
- 超时
- 回滚规则

它更像静态配置读取。

`TransactionManager` 负责“执行事务”：

- 获取连接
- 开启、提交、回滚

它更像运行时行为。

分离的好处是：

- 同一个 `TransactionManager` 可以服务不同 `@Transactional` 配置
- 同一个 `@Transactional` 也可以映射到不同的 `TransactionManager`，例如多数据源时

第三层问题是：**对 `DataSourceTransactionManager` 来说，整个事务主线的节点最终都汇到 JDBC Connection 上。**

- 事务开始 → `con.setAutoCommit(false)`
- 提交 → `con.commit()`
- 回滚 → `con.rollback()`
- 释放 → `con.close()`

如果把 Spring 的 `@Transactional` 全部剥掉，剩下的就是这些 JDBC 层面的动作。

但这里必须加一个限定：JDBC 只是 `DataSourceTransactionManager` 这一种实现的落地方式。Spring 事务上层统一依赖的是 `PlatformTransactionManager` 抽象，同样可接入 JTA、JPA 等其它资源管理器。也就是说，“连接共享 + 提交时机控制”是这套抽象的共同本质，而“获取的是 Connection”只是 JDBC 实现的具体表现。

因此，本文真正要回答的问题不是“`@Transactional` 怎么用”，而是：

**Spring 如何用 `TransactionInterceptor` 拦截 `@Transactional` 方法，通过 `TransactionAttributeSource` 读取配置、通过 `TransactionManager` 获取 Connection 并关闭自动提交，再用 `TransactionSynchronizationManager` 的 ThreadLocal 把同一线程内的操作绑到同一个连接上？**

## 先看失败方案：为什么不能每个 Repository 单独开事务、让事务配置写死在代码里、用普通局部变量保存连接

### 失败方案一：每个 Repository 方法自己开一个 Connection 和事务

如果每个 Repository 方法都自己 `getConnection`、自己 `commit`、自己 `close`，那：

- 每个 DB 操作是独立事务，无法整体提交或回滚
- 一个 Service 方法里调多个 Repository 方法，任何一个失败，之前已提交的都无法回滚

这就是为什么必须把多个操作绑定到一个连接，而不是让每个 Repository 各自为政。

### 失败方案二：事务配置写死在代码里

如果在每个方法里硬编码：

```java
connection.setAutoCommit(false);
// 执行 SQL
connection.commit();
connection.setAutoCommit(true);
```

那么事务配置会散落在业务代码各处，无法复用，也无法统一调整。`@Transactional` 这种方式把配置抽取成声明式做法，既避免散落，又让不同 `TransactionManager` 可以复用同一套配置。

### 失败方案三：用普通局部变量传递连接

如果 Service 方法里把连接作为局部变量，手工传给每个 Repository，那么：

- 代码里到处传递 Connection
- Repository 接口被迫暴露 JDBC 细节
- 事务边界一旦改变就要改很多调用处

Spring 用 ThreadLocal 的方式，让 Repository 内部通过 `DataSourceUtils.getConnection(...)` 自动从当前线程拿到同一个连接，技术上不需要在方法签名里传 Connection。这样避免把 JDBC 细节泄漏到业务层。

## Spring 事务主线的最小总图

```text
@Transactional method
   -> AOP proxy
   -> TransactionInterceptor.invoke
   -> invokeWithinTransaction
   -> TransactionAttributeSource.getTransactionAttribute
   -> TransactionManager.getTransaction(def)
   -> DataSourceTransactionManager.doBegin
   -> ds.getConnection()
   -> conn.setAutoCommit(false)
   -> TransactionSynchronizationManager.bindResource(ThreadLocal)
   -> invocation.proceed()  // 业务方法
   -> 成功: commit -> conn.commit()
   -> 异常: rollback -> conn.rollback()
   -> unbindResource + close
```

## 一、`TransactionInterceptor.invoke(...)`：AOP 拦截到事务管理的入口

`TransactionInterceptor` 实现 `MethodInterceptor`，进入事务主线的第一步是：

```java
invokeWithinTransaction(invocation.getMethod(), targetClass, invocation::proceed)
```

它会把方法执行委托给父类 `TransactionAspectSupport`。真正的模板逻辑在 `invokeWithinTransaction` 里：

1. 获取 `TransactionAttributeSource`
2. 读取当前方法上的 `@Transactional` 配置
3. 确定 `TransactionManager`
4. 创建事务（必要时）
5. 执行目标方法
6. 成功则提交，异常则回滚

这个模板把“读配置”、“开事务”、“执行业务”、“提交/回滚”四个阶段固定下来，而具体的连接获取、提交、回滚留给 `TransactionManager` 实现。

这里还暗含一套 `do*` 模板方法：`AbstractPlatformTransactionManager` 固定整体骨架，而 `doGetTransaction`、`doBegin`、`doCommit`、`doRollback`、`doSetRollbackOnly` 这些 `doXxx` 钩子由子类实现。`DataSourceTransactionManager` 只要覆写这几个钩子，就能接入整个事务骨架，而不需要重写 `getTransaction` / `commit` / `rollback` 的公共流程。这也是后面 `DataSourceTransactionManager` 只写 doBegin / doCommit / doRollback，就能完成 JDBC 落地的原因。

## 二、`TransactionAttributeSource`：负责读注解里的配置

`TransactionAttributeSource` 是一个只读接口，返回事务属性：

- 传播行为（REQUIRED、REQUIRES_NEW、NESTED 等）
- 隔离级别（DEFAULT、READ_COMMITTED 等）
- 超时
- readOnly
- 回滚规则

它只负责“配置是什么”，不负责“怎么执行”。所以它天然可以和具体 `TransactionManager` 分离。

## 三、`determineTransactionManager`：按 `@Transactional("orderTm")` 或默认选择事务管理器

`invokeWithinTransaction` 中，Spring 会先 `determineTransactionManager(...)`：

- 如果 `@Transactional` 指定了 `value` 或 `transactionManager`，则按 qualifier 找 Bean
- 否则查找默认的 `PlatformTransactionManager` Bean

多数据源场景下，不同的 `@Transactional` 可以指定不同的事务管理器，从而让不同数据源使用不同的事务。

## 四、`AbstractPlatformTransactionManager.getTransaction(...)`：判断是新建、复用还是挂起

`getTransaction(def)` 是事务真正开始的第一步。它先通过 `doGetTransaction` 检查当前线程是否已存在事务，而这个检查本身也是从 `TransactionSynchronizationManager.getResource(ds)` 的 ThreadLocal 取值来判断的。也就是说，事务是否存在、同一连接是否复用、传播行为是否走“复用”分支，所有这些都建立在同一个 ThreadLocal 绑定机制上。`getTransaction` 和 ThreadLocal 不是两件独立的事，而是同一套动态绑定机制的两个面。

`getTransaction` 分为两个分支：

### 存在现有事务

调用 `handleExistingTransaction(def, transaction, debugEnabled)`：

- 按传播行为决定是复用、挂起还是建 savepoint

### 不存在现有事务

判断传播行为：

- REQUIRED / REQUIRES_NEW / NESTED 才真正 `startTransaction(...)`
- SUPPORTS 等传播此时不开启本地事务

对 `REQUIRED`，`startTransaction` 最终会调用 `doBegin(...)`，这是子类实现的地方。

## 五、`DataSourceTransactionManager.doBegin(...)`：真正打开事务的地方

`doBegin` 是事务真正“打开”的动作，对 `DataSourceTransactionManager` 来说：

1. 从数据源获取一个 JDBC Connection
2. 如果当前连接自动提交为 true，则 `con.setAutoCommit(false)`
3. 把 `ConnectionHolder` 绑到 ThreadLocal

这一步等价于 JDBC 里的 `BEGIN` 或 `SET autocommit=0`。但连接的生命周期由 Spring 统一管理。

这里的 `setAutoCommit(false)` 是事务成功的核心——它让后续所有操作都在同一事务中，只有最后的 `commit()` 才真正提交。

## 六、`TransactionSynchronizationManager.bindResource(...)`：用 ThreadLocal 绑定当前线程的连接

`bindResource` 把 `(DataSource, ConnectionHolder)` 存到 ThreadLocal。

这样做的意义是：

- 后续业务方法内的 Repository 通过 `DataSourceUtils.getConnection(dataSource)` 取连接
- `getConnection` 先查 ThreadLocal：当前线程是否已有该数据源的 ConnectionHolder
- 有，就复用；没有，才新建

因此，同一线程内同一个数据源的所有操作，都会复用同一个 Connection，从而落在同一个事务内。

这也解释了为什么 `@Transactional` 只对“同一线程内”有效：一旦跨线程，另一个线程的 ThreadLocal 是空的，拿不到当前事务的连接。

## 七、`invocation.proceedWithInvocation()`：执行真正的业务方法

事务配置和连接都准备好后，Spring 才真正调用目标业务方法：

- 方法内部的 Repository 操作通过 `DataSourceUtils.getConnection(...)` 从 ThreadLocal 拿到同一个连接
- 所有 JDBC 写入都在同一事务内累积

方法正常返回后，进入提交分支；方法抛异常后，进入回滚分支。

## 八、commit 与 rollback 两条出口

### 正常返回：`commitTransactionAfterReturning(...)`

- `tm.commit(txInfo.getTransactionStatus())`
- `doCommit`：`conn.commit()`
- 清理 ThreadLocal（`unbindResource`），关闭连接

### 异常抛出：`completeTransactionAfterThrowing(...)`

- 判断是否应回滚（由 `RollbackRuleAttribute` 匹配异常类型：`RuntimeException` / `Error` 默认匹配回滚，checked 异常默认不匹配）
- 需要回滚：`tm.rollback` → `doRollback` → `conn.rollback()`
- 同样清理 ThreadLocal、关闭连接

commit 和 rollback 路径共享同样的连接清理逻辑。

## 九、几个最容易错的判断

### 1. `@Transactional` 会自动让每个 SQL 独立提交

不成立。

它恰恰会关闭自动提交，让所有操作在同一个事务中，直到统一 commit 才真正生效。

### 2. `TransactionAttributeSource` 和 `TransactionManager` 是同一个东西

不成立。

前者负责读配置，后者负责执行事务，两者分离才支持多数据源和配置复用。

### 3. 每个 Repository 方法都有自己的独立事务连接

不成立。

同一线程内同一数据源会复用同一个 Connection。

### 4. 跨线程调用 `@Transactional` 方法时，事务依然成立

不成立。

事务绑定在当前线程的 ThreadLocal 里，新线程拿不到当前事务连接。

### 5. checked 异常默认一定会导致回滚

不成立。

默认回滚规则是 RuntimeException / Error 回滚，checked 异常默认不回滚；需要显式配置 rollbackFor 才能改变。

## 收网：`@Transactional` 统一的不是“一个注解让方法能写数据库”，而是“把同一线程内多个 JDBC 操作绑到同一个连接并控制提交时机”

现在可以回到开头的问题：为什么 `@Transactional` 能让一大串 JDBC 操作看起来像一个整体？

因为 Spring 用一个完整的链路把它组织起来了：

```text
TransactionInterceptor
   -> TransactionAttributeSource 读配置
   -> TransactionManager.getTransaction
   -> DataSourceTransactionManager.doBegin
   -> conn.setAutoCommit(false)
   -> TransactionSynchronizationManager 绑定 ThreadLocal
   -> 业务方法内复用同一个连接
   -> commit / rollback
```

因此，这篇真正该带走的结论不是“Spring 支持事务注解”，而是：

**Spring 把事务问题从“怎么在方法里开事务”提升成了“用 AOP + ThreadLocal 把同一线程内的多个 JDBC 操作绑定到同一连接，并统一控制提交与回滚时机”的声明式事务协议。**

这也就解释了为什么 Spring 事务的关键，不是“`@Transactional` 注解本身”，而是它背后的连接共享策略和提交时机控制。

这也留下了下一篇最自然的问题：既然事务主链已经立住了，那为什么 `@Transactional` 有时会失效——自调用、非 public、异常类型不匹配、多数据源，这些场景又是如何绕过这条主链的？

下一篇进入 Spring 的 `@Transactional` 失效场景矩阵。