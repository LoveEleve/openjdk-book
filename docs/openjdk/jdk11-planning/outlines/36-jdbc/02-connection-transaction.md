# 02. Connection 生命周期与事务控制 — 接口体系、事务边界、异常链

> 🔴 Deep | 域 36 JDBC 第 2 篇 | Layer 3
> 读者处境: 面试"JDBC 事务怎么控制";生产"事务不回滚/连接泄漏"——Connection 的契约与最佳实践。

### 1. "JDBC 的核心接口族" — 四件套

场景: 一次查询的完整调用链——四个接口分别干什么

- `Driver`: 认领 URL + 创建连接(域 36 第 1 篇)
- `Connection`: **物理连接**(事务边界/会话状态)
- `Statement`/`PreparedStatement`: SQL 执行;`ResultSet`: 结果游标
- 调用链: `Connection.createStatement`(105)/`prepareStatement`(139)→ `Statement.executeQuery` → `ResultSet.next()` 遍历
- 关键设计 (斜体): *四层职责分离: 建连(Driver/Manager)→ 会话(Connection)→ 执行(Statement)→ 读取(ResultSet);接口化让驱动实现自由(MySQL/Oracle 各自实现)——面试画调用链是基础*
- 面试: "Statement vs PreparedStatement"——预编译(防注入/性能);接口继承关系(PreparedStatement extends Statement)

### 2. "事务边界在哪？" — autoCommit/commit/rollback

场景: 多条 SQL 要么全成功要么全失败——JDBC 怎么控制?

- `Connection.java:223` `setAutoCommit(false)` — 关闭自动提交(手动事务开始)
- `Connection.java:250` `commit()` / `264` `rollback()` — **事务边界显式化**
- `Connection.java:235` `getAutoCommit()` 查询
- 语义: 同一 Connection 上的 SQL 在"最后一个提交点"到"下次提交"之间是一个事务
- 关键设计 (斜体): *事务的原子性由数据库保证,JDBC 只负责"划边界"(begin=setAutoCommit(false),end=commit/rollback);**典型 bug**: 异常路径不 rollback → 脏数据;正确姿势: try { ... commit } catch { rollback } finally { 关闭 }*
- 面试: "Spring @Transactional 底层"——同一 Connection + 边界管理(域外框架);连接池与事务的绑定关系
- [关联: 域 03/11 资源生命周期;XA 分布式事务见第 3 篇]

### 3. "连接泄漏" — 关闭的职责

场景: 生产"连接池耗尽"——谁负责关连接?

- `Connection.java:280` `close()` — 释放物理连接(池化=归还)
- 资源三件套: Connection/Statement/ResultSet 都要关(ResultSet 随 Statement 关)
- try-with-resources(域 06)自动关闭——JDK7+ 标准写法
- 关键设计 (斜体): *"连接是稀缺资源"——泄漏 = 池耗尽 = 服务不可用;最佳实践: try-with-resources + 池监控;面试"连接泄漏怎么排查"——连接池的 active 数监控/等待超时*
- 生产: 连接池参数(连接超时/空闲回收)是性能与稳定性平衡点

### 4. "SQLException 的链" — 错误定位

场景: 驱动报错——怎么拿到最底层原因?

- `SQLException.java:120` reason 构造 + `SQLState`/错误码
- `SQLException.java:278` `getNextException()` — **异常链**(类似 Throwable cause,域 06)
- 驱动可链多个异常(如批量执行的部分失败)
- 关键设计 (斜体): *SQLException 自带链式(getNextException)——遍历取全;生产日志打印完整链(不是只打 message);面试"SQLException 与 IOException 关系"——都是受检异常(域 06)*
- 生产: 数据库错误码(SQLState)分类处理(重试/告警)

---

### 核心悬念

单库事务解决了——**跨库事务**呢?两个库要么都提交要么都回滚——这就是 2PC。`XAResource` 的 prepare/commit 怎么协作?为什么 2PC 有"阻塞"问题?Seata 怎么绕过它?——下一篇: XA 与 2PC(面试向)。

> → [03-xa-2pc.md](03-xa-2pc.md)
