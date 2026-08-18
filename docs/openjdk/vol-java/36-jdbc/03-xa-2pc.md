# 03. XA 与 2PC — 分布式事务的理论地基(面试向)

> **前置依赖**: [36-jdbc/02 — Connection 生命周期与事务控制](02-connection-transaction.md)(本地事务边界)、[06-exceptions/01 — Throwable 结构](../06-exceptions/01-throwable-structure.md)(受检异常)
> → **后续**: 域 12 锁与同步器(按写作顺序,AQS)
> 关联: 域 36 第 2 篇(本地事务);XA 实现参考数据库驱动(域外)

## 两个库,怎么原子提交

本地事务好办: 一个 Connection,commit/rollback 划边界。但**跨库事务**呢——订单库和库存库,要么都提交要么都回滚?这就是分布式事务。这一篇讲它的理论地基: XAResource 的参与者接口、2PC 的两阶段流程、2PC 的经典问题、以及现代工程化(Seata AT)。

> **源码说明**: `java.transaction.xa` 模块不在本源码树(裁剪),但 `javax.sql.XAConnection`/`XADataSource` 在。XAResource/Xid 的签名经系统 JDK17 的 javap 验证(接口自 JDK1.4 起未变,与 JDK11 一致)。本文接口部分标注验证来源,不写行号锚点。

## 1. "XAResource 是什么？" — 分布式事务的参与者接口

### 1.1 JDK 只出协议,实现归厂商

分布式事务的标准是 **X/Open XA**,Java 侧由 `javax.transaction.xa.XAResource`(`java.transaction.xa` 模块)表达。**关键定位: JDK 只定义接口(签名 + 常量),实现全在别处**——数据库驱动(MysqlXAConnection)实现参与者,事务管理器(Atomikos、Spring JtaTransactionManager)实现协调者。

`javax.sql` 侧的桥是 `XAConnection`(`XAConnection.java:54` 的 `getXAResource()`):

```java
// XAConnection.java:54(截取核心,逐字)
    javax.transaction.xa.XAResource getXAResource() throws SQLException;
```

`XADataSource`(`XADataSource.java:60` 的 `getXAConnection()`、`:81` 的带参版)是 XA 连接的工厂。**应用不直接用这些**——事务管理器(中间件)用(XAConnection 的 Javadoc 原话: "An application programmer does not use this interface directly; rather, it is used by a transaction manager working in the middle tier server",`XAConnection.java:36-37`)。

### 1.2 核心方法与常量

XAResource 接口签名(经系统 JDK17 javap 验证,与 JDK11 一致):

- **`start(Xid, flags)` / `end(Xid, flags)`**: 开启/结束一个**分支事务**(Xid 标识)
- **`prepare(Xid)`**: **投票**——返回 XA_OK(可提交)或抛 XAException(XA_RB* 要回滚)
- **`commit(Xid, onePhase)` / `rollback(Xid)`**: 提交/回滚分支
- **`recover(flag)`**: 恢复不确定的分支(协调者崩溃后重连)

flags 常量: **`TMONEPHASE`**(一阶段优化: 只有一个参与者时跳过 prepare)、`TMJOIN`(加入已有分支)、`TMSUSPEND`/`TMRESUME`(挂起/恢复)。结果常量: `XA_OK`、`XA_RDONLY`(只读分支,无需提交)。

### 1.3 Xid:全局事务标识

`Xid`(javap 验证)三个要素:

- **`getFormatId()`**: 格式标识(标识 Xid 的编码格式)
- **`getGlobalTransactionId()`**: 全局事务 ID(所有分支共享)
- **`getBranchQualifier()`**: 分支限定符(区分同一全局事务里的不同分支)

**同一全局事务的所有分支 Xid 的 globalTransactionId 相同、branchQualifier 不同**——这是"跨库关联"的标识基础。

关键设计(斜体):*XAResource 是"参与者契约"——事务管理器(协调者)通过它对每个分支发指令;JDK 只定义接口(签名+常量),实现全在驱动/中间件。面试讲"JDK 只出协议,实现归厂商"有深度;再答"Xid = 全局 ID + 分支 ID"就完整。*

## 2. "2PC 怎么执行？" — 两阶段提交流程

### 2.1 阶段一:准备(投票)

协调者(事务管理器)向**所有参与者**发 `prepare(Xid)`。每个数据库:

1. 执行自己的 SQL(事务内,未提交)
2. **锁住涉及资源**(行锁/表锁)
3. 回复投票: `XA_OK`(可提交)或 `XA_RB*`(要回滚,如 XA_RBDEADLOCK 死锁、XA_RBINTEGRITY 完整性)

**prepare 的意义**: 让所有参与者提前"承诺"能提交——避免阶段二才发现"最后一个库提交失败"造成部分提交。prepare 是**投票 + 资源锁定**。

### 2.2 阶段二:提交/回滚(统一行动)

- **全部 XA_OK** → 协调者向所有参与者发 `commit(Xid, false)`
- **任一 XA_RB*** 或参与者不可达 → 向所有参与者发 `rollback(Xid)`

时序图:

```
协调者             库A              库B
  │──prepare──────>│               │
  │<──XA_OK────────│               │
  │──prepare─────────────────────>│
  │<──XA_OK───────────────────────│
  │──commit───────>│               │
  │<──OK───────────│               │
  │──commit──────────────────────>│
  │<──OK──────────────────────────│
```

- **阶段一**(虚线前两轮): 协调者向每个参与者发 `prepare`,参与者投票(→ 返回 XA_OK 或 XA_RB*)
- **阶段二**(后两轮): 全部 XA_OK → 向每个参与者发 `commit`;任一失败 → 全部 `rollback`

### 2.3 一阶段优化:TMONEPHASE

只有一个参与者时,协调者可以直接 `commit(xid, true)`——**onePhase 参数为 true 表示一阶段提交**(`commit(Xid, boolean)`,javap 签名),**跳过 prepare 直接提交**: 单参与者场景下两阶段退化为"提交/回滚"两选一,省一次往返。`TMONEPHASE` 常量(`XAResource.TMONEPHASE = 0x40000000`)是给 `start`/`end` 的 flags 用的对应语义。

关键设计(斜体):*2PC 的"原子性"靠两阶段协议达成: 阶段一"确认都能提交"(投票+锁),阶段二"统一行动"(全提交或全回滚)。面试画时序图(协调者+2 参与者,prepare→commit)是基本功;再问"为什么需要 prepare 阶段": 避免最后一个库提交失败造成部分提交——prepare 是投票锁。*

跨层标注: [域 12 锁与同步器(规划中)——2PC 的资源锁与本地锁的粒度对比: 本地锁秒级,2PC 全局锁跨网络;域 06 异常——XAException 是受检异常(继承 Exception,非 RuntimeException)]

## 3. "2PC 的经典问题" — 阻塞与协调者故障

### 3.1 三大问题

**① 同步阻塞**: prepare 之后,参与者**持有资源锁**直到阶段二——任何一个库慢/挂起,全局事务被拖住,其他事务排队等锁。

**② 协调者单点**: 协调者崩溃且未恢复 → 参与者已经 prepare 了,但不知道是提交还是回滚——**资源锁死**。协调者的恢复要靠事务日志 + recover 重连,但恢复前系统是不可用的。

**③ 脑裂/网络分区**: 阶段二的消息丢失 → 参与者状态不确定(提交了?回滚了?)。2PC 假设网络可靠,网络不可靠时它没有自愈机制。

### 3.2 为什么说"强一致但脆弱"

2PC 保证**原子性**(全提交或全回滚)与**一致性**,但代价是:

- **可用性差**: 协调者故障 = 全局不可用
- **性能差**: 同步阻塞 + 锁持有时间长
- **不具备分区容忍**: 网络分区时无法决策

这就是 CAP 视角: **2PC 是 CP 型协议**——保证一致性与原子性,但在网络分区时无法决策(牺牲可用性);协调者故障时连"分区内可用"也做不到。

关键设计(斜体):*"2PC 是强一致但脆弱"——它保证原子性,代价是阻塞与协调者依赖。面试答"2PC 阻塞 + 单点"就有深度;现代替代: 3PC(引入超时与预提交,减少阻塞窗口,但仍非完全可靠)/TCC(业务补偿)/本地消息表(最终一致)/Seata AT。*

## 4. "与 Seata 的对比" — 生产选型

### 4.1 Seata AT:绕过 XA 的最终一致

**Seata AT 模式**不依赖 XA 接口: 业务 SQL 正常执行,框架自动生成**回滚日志(undo log)**;提交时"分支提交"(释放本地事务),全局提交后异步清理;失败时用 undo log **反向补偿**。

| | XA/2PC | Seata AT | TCC |
|--|--------|----------|-----|
| 一致性 | 强一致(同步) | 最终一致(异步) | 最终一致(业务补偿) |
| 锁 | 全局锁(阻塞) | 无锁窗口(本地锁短) | 业务自控 |
| 吞吐 | 低 | 高 | 中 |
| 实现 | 标准接口 | 框架自动(undo log) | 手动(Try/Confirm/Cancel) |

### 4.2 选型原则

- **强一致场景**(资金对账、扣款)用 XA/Seata-XA——可接受同步代价
- **高并发场景**用 AT/TCC——"一致性强度 vs 吞吐"的经典权衡
- **Seata AT 为什么比 XA 快**: 不用全局锁(无 prepare 阶段的长锁持有)+ 分支异步提交

关键设计(斜体):*选型: 强一致场景(资金)用 XA/Seata-XA;高并发用 AT/TCC——"一致性强度 vs 吞吐"的经典权衡。面试"Seata AT 为什么比 XA 快": 不用全局锁 + 异步分支;能说出"2PC 理论 → XA 标准 → AT/TCC 变体"的演进链就是完整答案。*

## 核心悬念

JDBC 收官——**并发控制**的大魔王来了: AQS。`ReentrantLock` 怎么用 CAS+队列实现?公平/非公平锁差在哪?`synchronized` 和 `Lock` 怎么选?——下一篇(按写作顺序): 域 12 锁与同步器。

> → 域 12 锁与同步器(12-lock-sync 系列)| 关联: 域 13 原子类(前置)、域 14 线程池
