# `REQUIRED`、`REQUIRES_NEW`、`NESTED` 到底差在哪：Spring 事务传播行为在 `handleExistingTransaction` 中的 7 条分支

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring 事务传播行为主线：`AbstractPlatformTransactionManager.getTransaction(...)` 在无现有事务和有现有事务时，如何按 7 种传播行为走不同分支，以及 `REQUIRES_NEW` 的“挂起”与 `NESTED` 的“savepoint”在连接和提交时机上的本质差异。

## 为什么 `REQUIRED` 和 `REQUIRES_NEW` 看起来都像“开事务”，但行为完全不同

前面两篇已经把事务主链和失效场景讲清楚了。但还有一个核心问题没有展开：**事务传播行为到底是怎么按不同路径执行的？**

`@Transactional(propagation = REQUIRED)` 和 `@Transactional(propagation = REQUIRES_NEW)` 在无外层事务时行为几乎一样——都会新建一个事务。但一旦有外层事务，两者的差异就非常明显：

- `REQUIRED`：加入现有事务，共用一个连接，一起提交或回滚
- `REQUIRES_NEW`：挂起现有事务，新建一个独立事务（新连接），独立提交或回滚

第一层问题是：**`AbstractPlatformTransactionManager.getTransaction(...)` 是传播行为分流的总入口。**

`getTransaction` 先检查当前线程是否存在现有事务（通过 `TransactionSynchronizationManager.getResource(ds)` 判断），然后分为两个大分支：

- 无现有事务：走 `getTransaction` 主分支，按传播行为决定是否新建事务
- 有现有事务：走 `handleExistingTransaction` 分支，按传播行为决定加入 / 挂起 / savepoint / 报错

第二层问题是：**`REQUIRES_NEW` 的“挂起”和 `NESTED` 的“savepoint”不是同一回事。**

- `REQUIRES_NEW`：挂起外层事务，把当前线程的 Connection 资源解绑，新建一个独立连接，创建另一个物理事务。内层事务的提交 / 回滚完全独立于外层。
- `NESTED`：不新建连接，在同一连接上通过 `savepoint` 实现嵌套。内层回滚到 savepoint，不是完全回滚；外层可以决定整体提交或回滚到 savepoint。

第三层问题是：**`MANDATORY` 和 `NEVER` 是“强制约束”型传播，不是“自行决定”型。**

`MANDATORY` 要求必须有外层事务，否则抛异常。`NEVER` 要求必须没有外层事务，否则抛异常。它们不像 `REQUIRED` / `SUPPORTS` 那样“自适应”，而是对事务状态的硬性约束。

因此，本文真正要回答的问题不是“7 种传播行为分别是什么”，而是：

**`AbstractPlatformTransactionManager` 如何用 `getTransaction` 和 `handleExistingTransaction` 两条分支，把 7 种传播行为分成“无现有事务时的 3 组分支”和“有现有事务时的若干条分支”，并让 `REQUIRES_NEW` 的挂起与 `NESTED` 的 savepoint 形成两种完全不同的物理事务模型？**

## 先看失败方案：为什么不能只保留 `REQUIRED`、用统一传播行为处理所有场景、把挂起当成可选项

### 失败方案一：只保留 `REQUIRED` 就够了

如果所有方法都只要求“必然有事务”，`REQUIRED` 确实能满足大多数场景。但 `REQUIRES_NEW` 可以在外层事务的独立连接中执行内层操作，两者互不干扰；`NESTED` 可以在不新建连接的情况下使用 savepoint 部分回滚；`SUPPORTS` 可以适配“有事务就参与，没有就非事务执行”。

因此，7 种传播行为覆盖了不同的事务边界需求。

### 失败方案二：挂起当前事务是可选优化，不是必须

挂起是 `REQUIRES_NEW` 和 `NOT_SUPPORTED` 的核心语义。不挂起当前事务，就无法在同一个线程内创建新的独立连接。挂起需要把当前 Connection 解绑、保存 `SuspendedResourcesHolder`，内层执行完后恢复。

### 失败方案三：`NESTED` 和 `REQUIRES_NEW` 可以用同一个传播行为实现

`NESTED` 基于 savepoint，不创建新连接，轻量但共享锁。`REQUIRES_NEW` 创建完全独立的物理事务，资源消耗大但完全隔离。两者不能合并，因为它们的提交时机和隔离级别不同。

## 事务传播行为的最小总图

```text
getTransaction(def)
   -> 有现有事务? handleExistingTransaction
   |  -> NEVER: 抛异常
   |  -> NOT_SUPPORTED: 挂起当前 + 非事务执行
   |  -> REQUIRES_NEW: 挂起当前 + 新建独立事务
   |  -> NESTED: savepoint 嵌套
   |  -> REQUIRED/SUPPORTS/MANDATORY: 加入现有事务
   |
   -> 无现有事务?
      -> MANDATORY: 抛异常
      -> REQUIRED/REQUIRES_NEW/NESTED: 新建事务
      -> SUPPORTS/NOT_SUPPORTED/NEVER: 非事务执行
```

## 一、无现有事务时的 3 组分支

当 `getTransaction` 检测到当前线程没有现有事务时，7 种传播行为被分成 3 组：

- **MANDATORY**：抛 `IllegalTransactionStateException`，要求调用方必须已开启事务
- **REQUIRED / REQUIRES_NEW / NESTED**：新建事务（`startTransaction` → `doBegin`）
- **SUPPORTS / NOT_SUPPORTED / NEVER**：非事务执行（`prepareTransactionStatus(null)`）

这里注意到一个细节：`REQUIRED` 和 `REQUIRES_NEW` 在无事务时行为相同——都调用 `suspend(null)` 然后 `startTransaction`。`suspend(null)` 是空操作，因为当前没有事务可以挂起。

## 二、有现有事务时的若干条分支

当 `handleExistingTransaction` 检测到现有事务时，7 种传播行为并不都走独立的代码路径，而是汇成若干条分支：

- `NEVER`：抛 `IllegalTransactionStateException`（“绝不能有事务，但现在有事务”）
- `NOT_SUPPORTED`：挂起当前事务，非事务执行
- `REQUIRES_NEW`：挂起当前事务，新建一个独立事务
- `NESTED`：在同一连接上创建 savepoint 实现嵌套
- `REQUIRED / SUPPORTS / MANDATORY`：汇成同一条“加入现有事务”分支，不新建

所以严格说不是“7 种状态”，而是“5 大类分支覆盖 7 个行为”——其中 REQUIRED、SUPPORTS、MANDATORY 在有事务时合并。

### `REQUIRES_NEW` 的挂起与恢复

`REQUIRES_NEW` 的业务流程：

1. `suspend(existingTransaction)`：把当前线程上的资源绑定与事务状态一起解绑，保存到 `SuspendedResourcesHolder`
2. `startTransaction`：获取新连接，`setAutoCommit(false)`，绑定到 ThreadLocal
3. 内层方法执行
4. 内层提交：`commit()` → `doCommit` → `conn.commit()`（新连接的提交）
5. `cleanupAfterCompletion`：解绑新连接，恢复 `SuspendedResourcesHolder` 中的原事务状态与资源绑定
6. 外层事务继续

挂起还原的不只是“一个连接对象”，而是当前线程上的资源绑定 + 事务状态这一整套上下文。

### `NESTED` 的 savepoint 嵌套

`NESTED` 的业务流程：

1. 不挂起当前事务。不新建连接。
2. 在当前连接上创建 savepoint：`status.createAndHoldSavepoint()`
3. 内层方法执行
4. 内层回滚：回滚到 savepoint，不是完全回滚
5. 内层提交：不提交，由外层统一提交
6. 外层事务继续

`NESTED` 和 `REQUIRES_NEW` 的本质区别：

| | REQUIRES_NEW | NESTED |
|---|---|---|
| 连接 | 新连接 | 同一连接（共享锁） |
| 提交 | 独立提交 | 由外层统一提交 |
| 回滚 | 完全独立回滚 | 回滚到 savepoint |
| 资源消耗 | 高（两个连接） | 轻量 |
| 隔离 | 完全隔离 | 共享锁，可能死锁 |

这里还要补一条失败边界：`NESTED` 的 savepoint 依赖数据库和 JDBC 驱动支持。如果底层不支持 savepoint，`NESTED` 并不是静默降级成“独立提交”，而是取决于平台层对 savepoint 支持能力的判断——它可能退化为参与外层，也可能直接按不支持处理报错，但绝不是悄悄变成 `REQUIRES_NEW`。所以使用 `NESTED` 前应确认目标数据库确实支持 savepoint。

## 三、`REQUIRED` 加入现有事务：为什么不是“不做事”

`REQUIRED` 在有现有事务时，调用 `handleExistingTransaction` 的最后一个分支：加入现有事务。这个分支不做 `doBegin`，也不新建连接，而是直接返回 `TransactionStatus`，让内层方法在现有事务上下文中执行。

这意味着内层方法的数据库操作会复用外层事务的连接，与外层事务一起提交或回滚。如果内层抛异常，外层事务也会被标记为 `rollbackOnly`，即使外层方法本身正常返回，最终也会回滚。

这也正是 `REQUIRES_NEW` 最常见的选型动机：当内层子任务失败不该拖着整个外层一起回滚时，用 `REQUIRED` 会因为 `rollbackOnly` 污染而失败，用 `REQUIRES_NEW` 让内层拥有独立提交/回滚，从根上避开这种污染。

## 四、`MANDATORY` 和 `NEVER`：强制约束型传播

`MANDATORY` 和 `NEVER` 不是“要不要开事务”的问题，而是“事务状态必须满足某个条件”的问题。

- `MANDATORY`：无事务时报错，要求调用方必须已开启事务
- `NEVER`：有事务时报错，要求调用方绝不能有事务

它们在 `getTransaction` 和 `handleExistingTransaction` 中直接抛出 `IllegalTransactionStateException`，而不是尝试创建或调整事务。

## 五、`SUPPORTS` 和 `NOT_SUPPORTED`：自适应型传播

`SUPPORTS` 和 `NOT_SUPPORTED` 的行为由当前线程是否有事务决定：

- `SUPPORTS`：有事务时加入，没有事务时非事务执行
- `NOT_SUPPORTED`：有事务时挂起后非事务执行，没有事务时非事务执行

`NOT_SUPPORTED` 在有事务时需要挂起，和 `REQUIRES_NEW` 的挂起流程相同，区别在于挂起后不创建新事务，而是直接非事务执行。

## 六、几个最容易错的判断

### 1. `REQUIRED` 和 `REQUIRES_NEW` 在无事务时行为不同

不成立。

两者在无事务时都调用 `suspend(null)` + `startTransaction`，行为完全相同。差异只在有事务时出现。

### 2. `NESTED` 和 `REQUIRES_NEW` 本质上是一样的，只是实现方式不同

不成立。

`REQUIRES_NEW` 是独立物理事务，`NESTED` 是基于 savepoint 的嵌套事务，在连接、提交时机和回滚范围上完全不同。

### 3. 挂起事务后，内层事务提交不会影响外层事务

对 `REQUIRES_NEW` 成立，对 `NESTED` 不成立。

`NESTED` 不挂起，内层提交由外层统一控制，内层回滚也只到 savepoint，不是完全回滚。

### 4. `MANDATORY` 和 `NEVER` 在无事务时行为相同

不成立。

`MANDATORY` 无事务时报错，`NEVER` 无事务时正常非事务执行。

### 5. `SUPPORTS` 在有事务时和 `REQUIRED` 行为相同

成立。

两者在有事务时都加入现有事务。差异只在无事务时：`REQUIRED` 新建事务，`SUPPORTS` 非事务执行。

## 收网：Spring 事务传播行为的本质，是 `getTransaction` 和 `handleExistingTransaction` 两条分支把 7 种传播行为分成“无事务时的 3 种状态”和“有事务时的 7 种状态”

现在可以回到开头的问题：为什么 `REQUIRED` 和 `REQUIRES_NEW` 看起来都像“开事务”，但行为完全不同？

因为它们在 `handleExistingTransaction` 中走的是完全不同的分支：

- `REQUIRED`：加入现有事务，不新建连接
- `REQUIRES_NEW`：挂起现有事务，新建独立连接

`REQUIRES_NEW` 的挂起与 `NESTED` 的 savepoint 在连接层次、提交时机和回滚范围上形成了两种完全不同的物理事务模型。

因此，这篇真正该带走的结论是：

**Spring 把事务传播问题从“方法要不要开事务”提升成了“`getTransaction` + `handleExistingTransaction` 两条分支下，7 种传播行为在无事务 / 有事务时分别走不同路径，并形成从新建、加入、挂起、savepoint 到报错的完整事务状态模型”。**

这也留下了下一篇最自然的问题：既然事务传播的 7 条分支已经立住了，那 `SQLException` 到 `DataAccessException` 的翻译体系——`SQLExceptionTranslator`、`SQLErrorCodes`、`SQLExceptionSubclassTranslator`——又是如何把 JDBC 的 checked 异常统一翻译成 Spring 的运行时异常体系的？

下一篇进入 Spring 的 `DataAccessException` 异常翻译主线。