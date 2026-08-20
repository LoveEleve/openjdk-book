# 为什么 `DuplicateKeyException` 和 `DataIntegrityViolationException` 不是直接从数据库抛出来的：Spring 的 `DataAccessException` 四层回退翻译链

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring 异常翻译主线：`SQLExceptionTranslator` 如何把 JDBC 的 `SQLException`（checked）翻译成 Spring 的 `DataAccessException`（unchecked），`AbstractFallbackSQLExceptionTranslator` 的回退模板如何组织四层翻译器，以及 `sql-error-codes.xml` 如何为不同数据库提供同一语义到同一 Spring 异常的映射。`@Repository` 与 `PersistenceExceptionTranslationPostProcessor` 的集成会在后续篇章展开，这里先提一句：那个集成解决的是 JPA / Hibernate 等非 JDBC 持久化技术的异常翻译，它与本篇的 JDBC `SQLExceptionTranslator` 翻译链是两条不同的入口，但目标一致——把所有持久化异常都收归 `DataAccessException` 体系。

## 为什么 Spring 不让你直接 catch `SQLException`，而是把它翻译成 `DataAccessException`

前面几篇已经讲了事务主链、传播行为和失效场景。但还有一个贯穿始终的谜题：**为什么业务代码里几乎从来不用 catch `SQLException`，而 catch `DataAccessException` 就能处理所有持久化异常？**

因为 Spring 在 JDBC 操作入口处，用一个统一的翻译链把 `SQLException`（checked）翻译成了 `DataAccessException`（unchecked）。这个翻译链的存在，让业务代码不再需要：

- 处理 `SQLException` 的 checked 异常声明
- 理解不同数据库的特有错误码
- 在每次 JDBC 调用处都手工做异常转换

第一层问题是：**翻译链的核心是 `AbstractFallbackSQLExceptionTranslator` 的模板方法：先试 custom，再试 `doTranslate`，最后试 fallback。**

`translate(task, sql, ex)` 按固定顺序走：

1. 先检查是否有自定义 translator，有则调用
2. 再调用 `doTranslate`（子类实现，如 `SQLErrorCodeSQLExceptionTranslator` 用 error code 匹配）
3. 如果前两步都返回 null，则调用 `fallbackTranslator.translate()`（递归执行同一模板）

这样，翻译链是一层包一层的递归模板，不是简单的线性列表。

第二层问题是：**不同数据库的同一语义错误，通过 `sql-error-codes.xml` 映射到同一个 Spring 异常类型。**

例如 MySQL 的 1062 是重复键错误，PostgreSQL 也有自己的重复键错误码；它们通过 `sql-error-codes.xml` 中的 `duplicateKeyCodes` 统一映射到 `DuplicateKeyException`。业务代码只要 catch `DuplicateKeyException`，不管底层是 MySQL 还是 PostgreSQL，都能正确处理。

第三层问题是：**所有通过 `JdbcTemplate` 执行的 SQL 都会自动经过翻译链。直接使用 JDBC Connection 则不会。**

`JdbcTemplate` 的每个执行入口都包着 `catch (SQLException ex) → translateException(...)`。如果业务代码直接使用 JDBC Connection 而不经过 `JdbcTemplate`，`SQLException` 就不会被翻译。这也是 `@Repository` + `JdbcTemplate` 能获得统一异常、而裸 JDBC 不能的原因。

因此，本文真正要回答的问题不是“Spring 有哪些 DataAccessException 子类”，而是：

**Spring 如何用 `AbstractFallbackSQLExceptionTranslator` 的模板方法组织四层翻译链，让不同数据库的特有错误码映射到同一语义的 Spring 异常，并通过 `JdbcTemplate` 的每个 SQL 入口自动触发翻译？**

## 先看失败方案：为什么不能直接抛出 `SQLException`、让每个数据库各自处理异常、用单层 if/else 替代翻译链

### 失败方案一：直接抛出 `SQLException`，业务代码自己 catch

`SQLException` 是 checked 异常，强制调用方在方法签名中声明 `throws SQLException`。如果业务代码每次调用 JDBC 都要处理这个异常，会让事务和服务层代码变得冗长。

`DataAccessException` 是 RuntimeException，不强制声明，符合 Spring 的非强制检查异常哲学。

### 失败方案二：每个数据库各自处理自己的异常，不统一

如果不同数据库使用不同的错误码和异常类型，业务代码就无法用统一的异常处理逻辑来应对不同数据库。

`sql-error-codes.xml` 为每种数据库提供相同的 Spring 异常映射，让业务代码始终 catch 统一的 `DataAccessException` 子类。

### 失败方案三：用单层 if/else 替代多层回退链

如果只有一层 if/else，就无法同时支持自定义翻译器、error code 映射、JDBC 子类翻译和 SQLState 翻译的多层协同。

`AbstractFallbackSQLExceptionTranslator` 的模板方法让每一层都可以独立扩展，同时保证整个链的完整性。

## 异常翻译的最小总图

翻译链根据默认配置有两种不同结构：

**默认配置（未提供 `sql-error-codes.xml`）：**

```text
JdbcTemplate.execute(sql)
   -> catch SQLException
   -> translator.translate(task, sql, ex)
   -> AbstractFallbackSQLExceptionTranslator.translate
      -> custom translator -> 成功则返回
      -> doTranslate (SQLExceptionSubclassTranslator: 按 JDBC 子类匹配)
      -> fallback: SQLStateSQLExceptionTranslator (SQLState 前缀)
   -> 全部失败: UncategorizedSQLException 兜底
```

**有 `sql-error-codes.xml` 时：**

```text
JdbcTemplate.execute(sql)
   -> catch SQLException
   -> translator.translate(task, sql, ex)
   -> AbstractFallbackSQLExceptionTranslator.translate
      -> custom translator -> 成功则返回
      -> doTranslate (SQLErrorCodeSQLExceptionTranslator: error code 映射)
      -> fallback: SQLExceptionSubclassTranslator (JDBC 4+ 子类)
         -> 再 fallback: SQLStateSQLExceptionTranslator (SQLState 前缀)
   -> 全部失败: UncategorizedSQLException 兜底
```

## 一、`AbstractFallbackSQLExceptionTranslator.translate(...)`：回退模板

`translate(task, sql, ex)` 是整条翻译链的入口。它遵循固定骨架：

1. 检查 `getCustomTranslator()`，如果非 null，调用它
2. 如果 custom 返回 null，调用 `doTranslate(task, sql, ex)`（子类实现）
3. 如果 `doTranslate` 返回 null，调用 `getFallbackTranslator()`
4. 如果 fallback 非 null，递归执行 `fallback.translate(task, sql, ex)`

这个模板的关键在于它是递归的：每个翻译器内部都执行同一个骨架。因此 fallback 翻译器内部又会检查自己的 custom、自己的 `doTranslate`、自己的 fallback，形成一条“链中链”的递归模板。

## 二、`SQLErrorCodeSQLExceptionTranslator.doTranslate(...)`：error code 映射

`SQLErrorCodeSQLExceptionTranslator` 是整条链的主力翻译器。它通过读取 `sql-error-codes.xml` 中的数据库配置，把具体 error code 映射到 `DataAccessException` 的子类。

`sql-error-codes.xml` 为每种数据库定义了 error code 分组：

- `badSqlGrammarCodes` → `BadSqlGrammarException`
- `duplicateKeyCodes` → `DuplicateKeyException`
- `dataIntegrityViolationCodes` → `DataIntegrityViolationException`
- 等等

`doTranslate` 内部：

1. 读取当前数据库的 `sql-error-codes.xml` 配置
2. 检查 `customTranslations` 数组，如果命中，返回自定义异常
3. 检查 `grouped codes`（如 `duplicateKeyCodes` 包含 1062），命中则返回对应异常
4. 全部未命中，返回 null，让 fallback 继续

## 三、`SQLExceptionSubclassTranslator`：JDBC 4+ 子类匹配

`SQLExceptionSubclassTranslator` 的位置取决于翻译链的配置。

当 `SQLErrorCodeSQLExceptionTranslator` 作为主翻译器时，它的 fallback 是 `SQLExceptionSubclassTranslator`。当 `SQLExceptionSubclassTranslator` 本身作为主翻译器时（默认配置），它的 fallback 是 `SQLStateSQLExceptionTranslator`。

它不依赖 error code 配置，而是通过 `instanceof` 判断 `SQLException` 的具体子类：

- `SQLIntegrityConstraintViolationException` → `DataIntegrityViolationException`
- `SQLTransientConnectionException` → `DataAccessResourceFailureException`
- 等等

JDBC 4+ 已经把常见的错误映射为 `SQLException` 的子类，所以子类翻译器在很多场景下不需要 error code 配置就能完成翻译。

## 四、`SQLStateSQLExceptionTranslator`：SQLState 前缀匹配

`SQLStateSQLExceptionTranslator` 是最后一级 fallback。

它通过 `SQLException.getSQLState()` 的前缀进行匹配（`SQLState` 是 SQL 标准定义的状态码），不依赖具体数据库的 error code。

## 五、`UncategorizedSQLException` 兜底

如果整条翻译链都返回 null，`JdbcTemplate.translateException(...)` 会用 `UncategorizedSQLException` 兜底，确保 `SQLException` 永远不会以原始形态被抛到业务层。

这里还有一个关键点：`DataAccessException` 本身是抽象类。翻译链最终抛出的永远是它的具体子类，如 `DuplicateKeyException`、`DataIntegrityViolationException`、`BadSqlGrammarException` 等。也就是说，`catch (DataAccessException e)` 捕获的是这些具体子类的实例，而不是抽象基类本身。

## 六、默认翻译器的选择：`SQLErrorCode` 版 vs `SQLExceptionSubclass` 版

在 `JdbcAccessor` 中，默认翻译器的选择逻辑是：

- 如果用户显式提供了 `sql-error-codes.xml`，使用 `SQLErrorCodeSQLExceptionTranslator`（error code 映射）
- 否则默认使用 `SQLExceptionSubclassTranslator`（JDBC 4+ 子类匹配）

`SQLExceptionSubclassTranslator` 的 fallback 是 `SQLStateSQLExceptionTranslator`。所以对大多数现代 JDBC 驱动来说，子类匹配已经足够，不需要 error code 配置文件。

## 七、为什么翻译链是“四层”而不是“三层”

严格来说，翻译链的层次是：

1. custom translator（用户自定义）
2. `doTranslate`（error code 映射）
3. fallback 链（`SQLExceptionSubclassTranslator` → `SQLStateSQLExceptionTranslator`）
4. 调用方 `JdbcTemplate.translateException` 的 `UncategorizedSQLException` 兜底

每一层都可能捕获并翻译异常，层层递进，保证“永不放弃翻译”的兜底承诺。

## 八、几个最容易错的判断

### 1. 所有 `SQLException` 都会被自动翻译成 `DataAccessException`

不成立。

只有通过 `JdbcTemplate` 执行 SQL 时才会自动翻译；直接使用 JDBC Connection 不会触发翻译。

### 2. 翻译链是一层简单的线性 if/else

不成立。

它是基于 `AbstractFallbackSQLExceptionTranslator` 的递归模板，每层内部又按 custom → doTranslate → fallback 执行，形成“链中链”。

### 3. 不同数据库的同一语义错误必须来自同一个 error code

不成立。

`sql-error-codes.xml` 为每种数据库单独配置 error code 映射，不同数据库的同一语义错误映射到同一个 Spring 异常类型。

### 4. 翻译成 `DataAccessException` 只是为了少写几行 `throws`

不成立。

它同时解决了跨数据库异常统一、checked 转 unchecked 和自定义翻译器三层问题。

### 5. `SQLErrorCodeSQLExceptionTranslator` 是默认翻译器

不成立。

默认是 `SQLExceptionSubclassTranslator`（JDBC 4+ 子类匹配），`SQLErrorCode` 版只有在用户显式提供 `sql-error-codes.xml` 时才启用。

## 收网：`DataAccessException` 翻译链统一的不是“异常名”，而是“不同数据库的持久化异常统一到 Spring 的运行时异常体系”

现在可以回到开头的问题：为什么业务代码不用 catch `SQLException`，而 catch `DataAccessException` 就能处理所有持久化异常？

因为 Spring 通过 `AbstractFallbackSQLExceptionTranslator` 的模板方法，组织了翻译链。最终翻译结果是一个 `DataAccessException` 的具体子类（`DataAccessException` 本身是抽象类）：

```text
JdbcTemplate 自动捕获 SQLException
   -> 自定义 translator
   -> 主翻译器: 默认是 SQLExceptionSubclass 版（JDBC 4+ 子类），
                有 sql-error-codes.xml 时是 SQLErrorCode 版（error code 映射）
   -> 二级 fallback: SQLState 版（SQLState 前缀）
   -> UncategorizedSQLException 兜底
```

因此，这篇真正该带走的结论是：

**Spring 把异常翻译问题从“如何 catch SQLException”提升成了“用递归模板组织四层翻译链，让不同数据库的同一语义错误码映射到同一 Spring 异常，并确保所有通过 JdbcTemplate 执行的 SQL 都自动经过翻译”的持久化异常协议。**

这也留下了下一篇最自然的问题：既然事务主链、传播行为、异常翻译都已经立住了，那事务同步机制——`TransactionSynchronizationManager` 的 `afterCommit`、`afterCompletion` 回调，以及 `TransactionSynchronization` 接口——又是如何在事务提交后、回滚后分别通知注册的同步器的？

下一篇进入 Spring 的 `TransactionSynchronization` 事务同步主线。