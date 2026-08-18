# 02. Connection 生命周期与事务控制 — 接口体系、事务边界、异常链

> **前置依赖**: [36-jdbc/01 — DriverManager 与驱动加载机制](01-drivermanager-loading.md)(连接怎么拿到)、[06-exceptions/01 — Throwable 结构](../06-exceptions/01-throwable-structure.md)(异常链语义)
> → **后续**:[36-jdbc/03 — XA 与 2PC](03-xa-2pc.md)
> 关联: 域 06 异常(受检异常与链);域 03 对象系统(资源生命周期)

## 拿到连接之后,谁负责什么

第 1 篇讲完了连接怎么拿到。但生产里更大的坑在**拿到之后**: 事务边界没划对导致脏数据、连接忘关导致连接池耗尽、错误只打 message 看不到根因。这一篇拆三件事: 接口四件套的分工、事务边界的显式控制、SQLException 的链式错误。

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

## 核心悬念

单库事务解决了——**跨库事务**呢?两个库要么都提交要么都回滚——这就是分布式事务。`XAResource` 的 prepare/commit 怎么协作?为什么 2PC 有"阻塞"问题?Seata 怎么绕过它?——下一篇: XA 与 2PC(面试向)。

> → [36-jdbc/03 — XA 与 2PC](03-xa-2pc.md)
