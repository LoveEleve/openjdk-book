# 域 36: JDBC — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "Class.forName 注册驱动/SPI 三通道" — 01 篇 §2(DriverManager.java:30/95/568-620)
- [x] "getConnection 怎么选驱动" — 01 篇 §3(646-690, isDriverAllowed 669)
- [x] "DataSource vs DriverManager" — 01 篇 §4(javax/sql/DataSource.java:92 getConnection)
- [x] "事务边界(autoCommit/commit/rollback)" — 02 篇 §2(Connection.java:223/250/264)
- [x] "连接泄漏/关闭职责" — 02 篇 §3(280)
- [x] "Statement vs PreparedStatement" — 02 篇 §1(139)
- [x] "SQLException 链" — 02 篇 §4(278)
- [x] "2PC 流程/为什么阻塞/Seata 对比" — 03 篇 §2-4

## 身份 2: 生产工程师
- [x] 驱动找不到排查(SPI/类路径)— 01 篇 §2
- [x] 事务不回滚 bug(异常路径)— 02 篇 §2
- [x] 连接池耗尽排查 — 02 篇 §3
- [x] 分布式事务选型(XA vs Seata)— 03 篇 §4

## 身份 3: 框架工程师
- [x] 连接池原理(DataSource 抽象)— 01 篇 §4
- [x] MyBatis/Spring 的 JDBC 衔接 — 02 篇
- [x] 分布式事务中间件理解 — 03 篇

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 DriverManager.java:86/94/95/247/266/341/378/568-620/646-690, Driver.java:91/106, Connection.java:105/139/223/235/250/264/280, SQLException.java:120/278, javax/sql/DataSource.java, Statement/PreparedStatement/ResultSet 接口族)/关键设计/跨层([关联]为主,JDBC 为纯接口域)/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] XA 模块已删(java.transaction.xa 5 文件),第 3 篇为面试向概念大纲,签名来自 git show 实测(用户指定保留方案)

## 身份 5: 完整性缺口检查
- [x] 加载机制(01)/事务生命周期(02)/XA(03)三篇覆盖域全部面试主战场
- [x] ResultSet/Statement 细节(🟢)并入 02 篇 §1 提及
- [x] 未覆盖确认: DatabaseMetaData/参数元数据(面试低频);驱动实现(MySQL)明确域外
- [x] 二次 review 修正: getConnection 流程锚点精确定位(isDriverAllowed 674、driver.connect 677、ensureDriversInitialized 调用 271/424/438、ServiceLoader.load 597)
- [x] 验证通过: XA 篇接口签名与常量与 git show 实测一致(XAResource 10 方法 + TM* + XA_OK/XA_RDONLY)、module 5 文件
- [ ] 待办: 写作时验证 DriverManager 的 ensureDriversInitialized 精确行号、SQLException SQLState 构造细节
