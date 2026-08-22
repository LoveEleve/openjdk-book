# 02. Connection 生命周期与事务控制 — 接口体系、事务边界、异常链

> 基于 JDK 11 `java.sql.Connection`、`Statement`、`PreparedStatement`、`ResultSet` 与 `SQLException` 接口语义。本文讨论的是 JDK 11 JDBC API 当前的事务边界表达、资源关闭契约和异常链结构，不把这里的接口约定、连接池行为或数据库事务实现细节外推成所有驱动、所有数据库或所有框架的统一规范。
> **前置依赖**: [36-jdbc/01 — DriverManager 与驱动加载机制](01-drivermanager-loading.md)(连接怎么拿到)、[06-exceptions/01 — Throwable 结构](../06-exceptions/01-throwable-structure.md)(异常链语义)
> → **后续**:[36-jdbc/03 — XA 与 2PC](03-xa-2pc.md)
> 关联: 域 06 异常(受检异常与链);域 03 对象系统(资源生命周期)

## 拿到连接之后,谁负责什么

第 1 篇讲完了连接怎么拿到。但生产里更大的坑往往不在“连不上”,而在**连上之后谁该替这条连接负责**。

最常见的三种事故几乎每个项目都见过。第一种是事务边界没划对: 转账 SQL 执行了一半抛异常,上一条更新已经写进未提交事务,代码却既没 rollback 也没恢复 autoCommit,最后把下一次借到同一连接的请求一起拖进脏状态。第二种是资源链没收干净: Connection、Statement、ResultSet 里漏关任何一层,连接池 active 数就可能一路爬高,直到新请求拿不到连接。第三种是错误链被日志写法截断: 代码只打 `e.getMessage()`,真正的 SQLState、vendorCode 和 nextException 链全都没了,排查时只能看到一句模糊失败描述。

这些问题背后其实对应三种失败方案。

第一种失败方案，是把 Connection 想成“拿到就能随便执行 SQL 的通道”,而不是会话与事务边界的宿主。这样看时,commit/rollback/autoCommit 都会退化成“顺手调一下”的附属动作。

第二种失败方案，是把关闭职责想成“最后关一下 Connection 就够了”。这样看时,资源三件套的依赖链和连接池复用语义就会被混成一团,出问题时只知道池空了,却说不清到底哪一层漏了。

第三种失败方案，是把 SQLException 当普通文本异常看,只记 message,不看 SQLState、vendorCode 和 nextException。这样一来,JDBC 明明已经把错误分类和驱动补充链留给你了,调用方却亲手把它们抹平。

所以这一篇拆的不是几组接口名,而是三条必须同时讲清的责任线: 接口四件套谁负责哪一段、事务边界由谁显式划定、错误信息又怎样完整穿过调用栈和日志系统。

## 1. "JDBC 的核心接口族" — 四件套

### 1.1 职责分离的调用链

一次查询的完整调用链,四个接口各管一段:

| 接口 | 职责 | 关键方法 |
|------|------|---------|
| `Driver` | 认领 URL + 创建连接(域 36 第 1 篇) | `acceptsURL`/`connect` |
| `Connection` | **物理连接**(事务边界、会话状态) | `createStatement`@105/`prepareStatement`@139 |
| `Statement` | SQL 执行 | `executeQuery`(`Statement.java:69`) |
| `ResultSet` | 结果游标遍历 | `next()` |

```java
// 用法示意(API 形式,非源码片段)
try (Connection conn = ds.getConnection();
     PreparedStatement ps = conn.prepareStatement("SELECT ...");
     ResultSet rs = ps.executeQuery()) {
    while (rs.next()) { /* 遍历行 */ }
}
```

### 1.2 Statement vs PreparedStatement

`PreparedStatement`(`PreparedStatement.java:62`)extends `Statement`——**预编译语句**: SQL 模板先在驱动/数据库侧编译,参数用 `?` 占位(`setInt/setString` 填充)。两个收益:

- **防注入**: 参数走预编译通道,不拼进 SQL 字符串——SQL 注入的第一道防线
- **性能**: 同一模板反复执行时,数据库侧可复用执行计划

关键设计(斜体):*四层职责分离: 建连(Driver/Manager)→ 会话(Connection)→ 执行(Statement)→ 读取(ResultSet);接口化让驱动实现自由(MySQL/Oracle 各自实现同一套接口)。面试画调用链是基础;再问"Statement vs PreparedStatement": 预编译 + 防注入 + 计划复用,三连。*

## 2. "事务边界在哪？" — autoCommit/commit/rollback

### 2.1 默认:每条 SQL 一个事务

`Connection` 默认 **autoCommit=true**(JDBC 规范约定,驱动实现)——每条 SQL 执行完自动提交,没有显式事务。事务边界在 `setAutoCommit(false)` 之后显式化(`Connection.java:223`):

```java
// Connection.java:223(截取核心,逐字)
    void setAutoCommit(boolean autoCommit) throws SQLException;
```

`getAutoCommit()`(`Connection.java:235`)查询当前模式。

### 2.2 手动事务:边界显式化

```java
// 用法示意(API 形式,非源码片段)
conn.setAutoCommit(false);        // 事务开始: 关闭自动提交
try {
    stmt1.executeUpdate("UPDATE account SET balance=balance-100 WHERE id=1");
    stmt2.executeUpdate("UPDATE account SET balance=balance+100 WHERE id=2");
    conn.commit();                // 事务结束: 显式提交
} catch (SQLException e) {
    conn.rollback();              // 失败回滚
} finally {
    conn.setAutoCommit(true);     // 恢复默认(归还连接前)
}
```

`commit()`(`Connection.java:250`)与 `rollback()`(`Connection.java:264`)把边界显式化。**语义**: 同一 Connection 上,从 setAutoCommit(false)(或上一个提交点)到 commit/rollback 之间的所有 SQL 是一个事务——原子性由数据库保证,JDBC 只负责"划边界"。

### 2.3 典型 bug:异常路径不回滚

最常见的生产事故:

```java
// 反例示意(API 形式,非源码片段)
conn.setAutoCommit(false);
stmt.executeUpdate(sql1);     // 成功
stmt.executeUpdate(sql2);     // 抛异常,但没 rollback!
conn.commit();                // 永不执行——事务悬着
```

SQL2 失败后不 rollback: 事务保持打开,SQL1 的修改留在**未提交状态**——既没提交也没回滚,后续可能被其他代码误提交(或一直占着事务与锁)。**正确姿势**: try { ... commit } catch { rollback } finally { 关闭 }——三句缺一不可。Spring @Transactional 的底层就是同一 Connection 的边界管理(域外框架)。

关键设计(斜体):*事务的原子性由数据库保证,JDBC 只负责"划边界"(begin=setAutoCommit(false),end=commit/rollback)。面试"JDBC 事务怎么控制": 关自动提交 → 执行 → 提交/回滚 → 恢复,四步;典型 bug 是异常路径不 rollback——脏数据/事务悬挂。*

## 3. "连接泄漏" — 关闭的职责

### 3.1 资源三件套:都要关

`Connection.close()`(`Connection.java:280`)释放物理连接(池化场景=归还连接)。**资源三件套**: Connection/Statement/ResultSet 都要关——`Statement`(`Statement.java:47`)与 `ResultSet`(`ResultSet.java:149`)都 extends `AutoCloseable`。关闭规则:

- **ResultSet 随 Statement 关**: 关 Statement 时其打开的 ResultSet 一并关闭(Statement.java:107-109 的 Javadoc 原话: "When a Statement object is closed, its current ResultSet object, if one exists, is also closed")
- **Statement 随 Connection 关**: 关 Connection 时其 Statement 一并关闭
- **但依赖链不等于自动关**: 只关 Connection 是"兜底",规范要求逐层关闭

### 3.2 泄漏的后果与排查

**连接是稀缺资源**——连接池的 maxPoolSize 有限,泄漏一条 = 池里少一条,持续泄漏 = 池耗尽 = 服务不可用。排查:

- 连接池的 **active 数监控**(活跃连接持续不降 = 泄漏)
- 等待获取连接的超时日志(拿不到连接 = 池已空)
- 池参数: 连接获取超时、空闲连接回收(具体参数名随连接池实现,如 HikariCP 的 connectionTimeout/idleTimeout)是性能与稳定性的平衡点

### 3.3 try-with-resources:标准写法

JDK7+ 的标准姿势(`Statement`/`ResultSet` 都是 AutoCloseable,域 06 的资源关闭机制):

```java
// 用法示意(API 形式,非源码片段)
try (Connection conn = ds.getConnection();
     PreparedStatement ps = conn.prepareStatement(sql);
     ResultSet rs = ps.executeQuery()) {
    // 异常或正常退出都自动 close
}
```

关键设计(斜体):*"连接是稀缺资源"——泄漏 = 池耗尽 = 服务不可用。最佳实践: try-with-resources + 池监控;面试"连接泄漏怎么排查": 连接池 active 数监控 + 获取超时日志;能说出"ResultSet 随 Statement 关、Statement 随 Connection 关"的依赖链就是细节分。*

## 4. "SQLException 的链" — 错误定位

### 4.1 三要素:reason + SQLState + vendorCode

`SQLException`(`SQLException.java`)构造时携带三要素(`SQLException.java:120-123` 的 reason 构造):

```java
// SQLException.java:120-123(截取核心,逐字)
    public SQLException(String reason) {
        super(reason);
        this.SQLState = null;
        this.vendorCode = 0;
```

- **reason**: 人类可读的错误描述
- **SQLState**: 标准错误码(`getSQLState()`,`SQLException.java:256`)——**跨数据库统一分类**(SQL 标准: 08001 连接失败、23000 约束违反;08001 可见第 1 篇 DriverManager 的源码用法)
- **vendorCode**: 驱动私有错误码(`getErrorCode()`,`SQLException.java:266`)——数据库特有

### 4.2 getNextException:驱动级异常链

`getNextException()`(`SQLException.java:278-280`)返回链中的下一个异常:

```java
// SQLException.java:278-280(截取核心,逐字)
    public SQLException getNextException() {
        return (next);
    }
```

`next` 字段(`SQLException.java:371`)由 `setNextException` 维护(`SQLException.java:289-301`)——注意它的追加是**并发安全的**: 用 `AtomicReferenceFieldUpdater` 的 CAS 把新异常链到链尾(`SQLException.java:299` 的 `nextUpdater.compareAndSet(current, null, ex)`,失败则重试)。**与 Throwable.cause 不同**,这是 JDBC 特有的链: 驱动可以把**多个相关错误**串起来(如批量执行的部分失败——每个 batch 条目的失败各成一个节点),getCause 与 next 是两条独立链。

### 4.3 遍历完整链

生产日志必须遍历整条链,不是只打 message:

```java
// 用法示意(API 形式,非源码片段)
for (SQLException e = ex; e != null; e = e.getNextException()) {
    log.error("SQLState={}, code={}, msg={}", e.getSQLState(), e.getErrorCode(), e.getMessage());
}
```

面试关联: SQLException 与 IOException 都是**受检异常**(域 06)——编译期强制处理;错误定位按 SQLState 分类(重试/告警),vendorCode 查数据库手册。

关键设计(斜体):*SQLException 自带链式(getNextException)——遍历取全,生产日志打印完整链(不是只打 message)。面试"SQLException 与 IOException 关系": 都是受检异常(域 06);"错误怎么分类处理": SQLState 标准码(连接失败重试、约束违反告警)。*

跨层标注: [域 06: 01-throwable——SQLException 是受检异常(编译期强制处理),其 next 链与 Throwable.cause 是两种链;域 03 对象系统——Connection/Statement/ResultSet 的资源生命周期与 finalize/Cleaner 的对象清理语义对照]

## 五个最容易混掉的边界：拿到 Connection 不是开始事务，commit 不是 JDBC 自己保证原子，close 不是只关物理连接，cause 不是 nextException，恢复 autoCommit 也不是可选清理

第一，拿到 `Connection` 不是开始事务。默认 `autoCommit=true` 时，每条 SQL 的边界由驱动和数据库按自动提交处理；只有显式关闭自动提交，调用方才开始自己管理一组 SQL 的提交与回滚边界。

第二，`commit()` 不是 JDBC 自己保证原子。JDBC 负责把事务边界指给驱动，具体原子性、隔离和持久化能力仍由数据库与驱动共同实现；接口方法不会替你弥补数据库层的事务语义差异。

第三，`close()` 不是只关物理连接。直连场景它释放连接资源，连接池场景通常意味着把连接归还池中；同时 Statement、ResultSet 也有自己的资源生命周期，不能把依赖链的兜底关闭误当成调用方可以随意漏关。

第四，`cause` 不是 `nextException`。Throwable cause 表达异常因果关系，SQLException 的 next 链表达驱动追加的多个相关 SQL 错误；生产诊断需要分别检查两条链，不能只沿其中一条走。

第五，恢复 `autoCommit` 也不是可选清理。连接池复用的是 Connection 对象及其会话状态，事务完成后若不明确提交或回滚、恢复自动提交并关闭资源，下一个借到同一连接的请求可能继承旧状态或未完成事务。

把这五条边界记稳，JDBC 连接与事务就不会再被简化成“拿连接、执行 SQL、最后 close”三步模板。它真正想讲的是：接口层分别管理会话、事务、资源和错误信息，而调用方必须在成功路径和异常路径上都把这些状态明确收回。

## 核心悬念

单库事务解决了——**跨库事务**呢?两个库要么都提交要么都回滚——这就是分布式事务。`XAResource` 的 prepare/commit 怎么协作?为什么 2PC 有"阻塞"问题?Seata 怎么绕过它?——下一篇: XA 与 2PC(面试向)。

> → [36-jdbc/03 — XA 与 2PC](03-xa-2pc.md)
