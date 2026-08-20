# `@Transactional` 为什么有时会失效：8 种失效场景的 4 类根因

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 `@Transactional` 失效场景主线：为什么一个看似正确的事务注解会在运行时不生效，以及它们背后的 4 类根因——代理拦截缺失、异常语义错误、多数据源与传播行为、跨线程与非事务引擎。传播行为专题和异常翻译专题会在后续篇章继续展开。

## 为什么 `@Transactional` 明明写在方法上，事务却有时完全没生效

上一篇已经把事务主链讲清楚了：`TransactionInterceptor` 拦截方法、`DataSourceTransactionManager` 获取连接、`TransactionSynchronizationManager` 用 ThreadLocal 绑定到当前线程，最后统一提交或回滚。

但这条链并不是每次都能跑通。很多开发者会在某个场景下发现：

- 方法里明明写了 `@Transactional`
- 但数据没有按预期被回滚
- 或者事务干脆就没被开启

这些现象通常不是框架 Bug，而是他们对事务主链的某个前提条件没有满足。

第一类问题是：**代理拦截本身就没有发生。**

这是最普遍的一类失效根源。`@Transactional` 是通过 AOP 代理起作用的，因此任何“代理拦截不到”的场景都会导致事务完全不生效：

- 自调用：`this.method()` 不经过代理
- 方法可见性边界：private / final 方法无法被代理覆写；JDK 动态代理只拦截接口里暴露的 public 方法，CGLIB 通过子类覆写 public / protected 方法，但 private 和 final 无法覆写

第二类问题是：**异常语义没有触发回滚。**

`@Transactional` 默认只对 `RuntimeException` 和 `Error` 回滚。如果抛的是 `IOException` 这类 checked 异常，就算事务拦截器确实捕获到了异常，它也不会调用 `rollback()`。

第三类问题是：**多数据源未指定事务管理器，或传播行为本身就不要求事务。**

多数据源时 `@Transactional` 不指定 qualifier，Spring 无法确定用哪个 `TransactionManager`。传播行为如果是 `NEVER`，现有事务存在时反而会报错；`SUPPORTS` 在有事务时参与，没有事务时则非事务执行。

第四类问题是：**事务绑定在 ThreadLocal 上，跨线程时自然就丢了。**

事务的连接和状态存在当前线程的 ThreadLocal 里，`CompletableFuture` 或 `@Async` 的新线程拿不到这个连接，所以 `@Transactional` 不会跨线程传播。

因此，本文真正要回答的问题不是“`@Transactional` 失效了怎么办”，而是：

**Spring 事务主链的 4 类前提条件如果被破坏，`@Transactional` 就会失效；这些失效的根因分别是代理拦截缺失、异常语义错误、多数据源 / 传播行为、跨线程隔离。**

## 先看失败方案：为什么不能“事务就是事务，不管怎么调都该生效”

### 失败方案一：`@Transactional` 写在方法上，不管是不是自调用，事务都该生效

这不是框架层面的问题，而是对 AOP 代理模型的误解。`this.method()` 调用的是原始对象，不走代理拦截器。所以事务必须经过代理才能成立。

### 失败方案二：所有异常都应该导致事务回滚

这个想法很自然，但 Spring 的默认选择是：只有 `RuntimeException` 和 `Error` 默认回滚，checked 异常不回滚。因为 checked 异常通常代表业务预期的情况，不是程序错误。如果 checked 异常也默认回滚，可能会让事务边界变得不可预测。

### 失败方案三：多数据源时，Spring 应该自动选一个

多数据源时，Spring 无法猜测开发者想用哪个数据源，因此必须显式指定。

## 失效场景的最小总图

```text
@Transactional 失效的 4 类根因：

代理拦截缺失
  -> 自调用 (this.method())
  -> 非 public 方法

异常语义错误
  -> checked 异常默认不回滚
  -> rollbackFor / noRollbackFor 配置错误

多数据源 / 传播行为
  -> 未指定 TransactionManager qualifier
  -> NEVER 或 SUPPORTS 语义

跨线程 / 非事务引擎
  -> ThreadLocal 隔离
  -> MyISAM 等不支持事务的引擎
```

## 一、代理拦截缺失：自调用与非 public 方法

### 自调用

`@Transactional` 方法从外部调用时，走的是代理：`controller → serviceProxy.createOrder()` → `TransactionInterceptor.invoke` → 事务开始。

但 `createOrder` 内部执行 `this.saveToDB()` 时，`this` 是原始对象，不是代理。因此 `saveToDB` 上的事务注解不会被拦截，如果 `saveToDB` 也标了 `@Transactional`，它不会生效。

修复方式：

- 把事务方法移到另一个 Service 里，让外部调用触发代理
- 注入自身代理：`@Autowired UserService self`，然后调用 `self.saveToDB()`
- 使用 `AopContext.currentProxy()`，配合 `@EnableAspectJAutoProxy(exposeProxy = true)`

### 非 public / final / private 方法

CGLIB 代理通过生成子类覆写方法实现拦截。但 `private` 方法不能被覆写，`final` 方法不能被覆写。`protected` 方法虽然能被子类覆写，但从 Spring AOP 的可见性边界看，它是否真正走代理还要取决于调用入口；如果只在类内部被调用，就仍会绕过代理。

这里要区分两种代理的可见性规则：

- JDK 动态代理：只能拦截接口里暴露的方法，而接口方法通常是 public，所以非 public 方法在接口代理下天然不会被拦截
- CGLIB 子类代理：通过覆写 public / protected 方法实现，private / final 仍然无法拦截

因此，`@Transactional` 不能写在 `private` 或 `final` 方法上。

## 二、异常语义错误：checked 异常默认不回滚

`TransactionInterceptor` 捕获异常后，调用 `rollbackOn(ex)` 判断是否该回滚。

`RuleBasedTransactionAttribute.rollbackOn(Throwable)` 的默认行为是：

- 遍历 `rollbackRules` 列表
- 如果没有任何规则命中，退回父类判断：`super.rollbackOn(ex)` 只对 `RuntimeException` 和 `Error` 返回 true

因此，`importData()` 抛出 `IOException` 时，`rollbackOn` 返回 false，事务不会回滚，而是按正常路径提交。

修复方式：

- `@Transactional(rollbackFor = Exception.class)` 或 `@Transactional(rollbackFor = IOException.class)`

## 三、多数据源与传播行为

### 多数据源未指定 TransactionManager

当容器中存在多个 `PlatformTransactionManager` Bean 时，`@Transactional` 不指定 qualifier，`determineTransactionManager` 会按类型查找：

```java
beanFactory.getBean(TransactionManager.class)
```

这里有一个版本边界：Spring 6.0 引入了 `TransactionManager` 作为公共标记接口，`PlatformTransactionManager` 继承它，所以 6.x 里按 `TransactionManager.class` 查找；如果对照 Spring 5.x 源码，这里查的通常是 `PlatformTransactionManager.class`。

遇到多个候选时抛出 `NoUniqueBeanDefinitionException`。

修复方式：`@Transactional("orderTm")` 显式指定 qualifier。

### NEVER 与 SUPPORTS 语义

`NEVER` 声明“当前方法绝不能运行在事务中”。如果调用时已有事务，`handleExistingTransaction` 会抛出 `IllegalTransactionStateException`，而不是静默降级。

`SUPPORTS` 是最宽松的传播：有事务时参与，没有事务时非事务执行。

这两种传播行为不是 Bug，而是事务边界语义的正确表达。

## 四、跨线程与非事务引擎

### 跨线程

事务连接绑定在发起线程的 ThreadLocal 中。`CompletableFuture.runAsync` 或 `@Async` 启动的新线程有自己独立的 ThreadLocal，拿不到当前事务的连接。

因此新线程中的数据库操作是在独立连接中执行的，不受主线程事务控制。

修复方式：

- 手动将事务传播到新线程（需要显式传 Connection 或使用 Spring 的 `TransactionAware` 线程池）
- 在同一个线程内完成所有事务操作

### MyISAM 等非事务引擎

MyISAM 引擎不支持事务。`commit` 和 `rollback` 在 MyISAM 上无效。这不是 Spring 的问题，而是数据库引擎本身的差异：例如 MySQL 的 InnoDB 支持事务，而 MyISAM 不支持。这属于数据库层面不可控的范围，Spring 的事务抽象无法改变它。

## 五、失效排查的三问：遇到事务不生效时，先按最小路径逐条排除

四类根因分清楚了，但一个读者真正遇到事务失效时，最需要的是一条最小成本的判断路径。可以用三个问题依次排查：

### 一问：方法有没有进代理？

先在事务方法里打点，或看日志里是否出现事务日志。如果调用根本没经过代理（典型是同类内部 `this.method()` 或非 public 方法），后面所有分析都不用继续，先把调用入口修对。

### 二问：抛出的异常类型是什么？

如果确认已经进了代理，但还是没回滚，那就看异常类型：是 `RuntimeException` / `Error`，还是 checked 异常？前者默认回滚，后者默认不回滚。这一步直接对应本节第一条路径：是否需要补 `rollbackFor`。

### 三问：数据源 / 线程边界是否被破坏？

如果上述两点都对，再查两件事：

- 是否多数据源但 `@Transactional` 没指定 qualifier
- 事务内的数据库操作是否被切到了新线程

这两者往往不是“逻辑写错”，而是资源归属或线程归属问题。

## 六、几个最容易错的判断

### 1. `@Transactional` 不管是否自调用，事务都会生效

不成立。

自调用不走代理，事务拦截器不会触发。

### 2. 所有异常都会导致事务回滚

不成立。

默认只有 `RuntimeException` 和 `Error` 回滚，checked 异常不回滚。

### 3. 多数据源时，Spring 会自动选择正确的 TransactionManager

不成立。

多数据源时 `@Transactional` 必须显式指定 qualifier。

### 4. `@Async` 方法内的事务操作可以参与外部事务

不成立。

新线程有自己的 ThreadLocal，拿不到外部事务的连接。

### 5. `NEVER` 传播语义是“没有事务时正常执行，有事务时静默跳过”

不成立。

`NEVER` 是“有事务就报错”，不是静默降级。

## 收网：`@Transactional` 失效的根因，不是框架 Bug，而是“代理拦截、异常语义、多数据源、跨线程”这 4 类前提条件被破坏

现在可以回到开头的问题：为什么 `@Transactional` 明明写在方法上，事务却有时没生效？

因为 Spring 事务主链的正常运行，依赖 4 个前提条件同时成立：

1. 方法调用必须经过代理
2. 异常类型必须匹配回滚规则
3. 多数据源时必须指定正确的事务管理器
4. 事务操作必须在同一线程内完成

如果其中任何一个被破坏，`@Transactional` 就会失效。因此，排查事务失效时，应该按这 4 类根因逐条检查。

这也留下了下一篇最自然的问题：既然事务主链和失效场景都已经讲清楚了，那 `REQUIRED`、`REQUIRES_NEW`、`NESTED`、`SUPPORTS`、`NOT_SUPPORTED`、`MANDATORY`、`NEVER` 这 7 种传播行为，在 `AbstractPlatformTransactionManager.handleExistingTransaction(...)` 中到底是怎么按不同分支执行的？

下一篇进入 Spring 的 7 种事务传播行为主线。