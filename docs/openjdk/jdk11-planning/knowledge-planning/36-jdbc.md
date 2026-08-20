# 域 36: JDBC — 知识规划

> 源码路径: java.sql/share/classes/java/sql/(55 文件:DriverManager/Driver/Connection/Statement/PreparedStatement/ResultSet/SQLException 等) + javax/sql/(DataSource 等)
> 源码量: ~60 文件 / ~12,000 行 | 非巨型域(接口为主,实现全在驱动)
> 写作层: Layer 3(前置: 域 03 对象系统、11 线程;域 07 SPI 衔接)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| DriverManager.java (741) | **驱动注册表**: registeredDrivers CopyOnWriteArrayList(86)、registerDriver/addIfAbsent(341)、deregisterDriver(378)——并发安全列表 | High |
| DriverManager.java | **驱动加载**: 三通道(类注释 52-68: jdbc.drivers 属性 95 + ServiceLoader<Driver> 30 + 显式 Class.forName 注册)、driversInitialized 标志(94) | High |
| DriverManager.java | **连接获取**: getConnection(247→251 三参)→ 遍历 registeredDrivers(646-690: isDriverAllowed(669)校验调用者类加载器 + driver.connect(677)) | High |
| Driver.java (182) | **驱动契约**: connect(91)/acceptsURL(106)——URL 认领与连接创建 | Medium |
| Connection.java (1716) | **连接契约**: createStatement(105)/prepareStatement(139)/setAutoCommit(223)/commit(250)/rollback(264)/close(280)——事务边界 | High |
| Statement/PreparedStatement/ResultSet (1649/1321/4289) | **执行与结果**: executeQuery/ResultSet 游标遍历(接口族) | Medium |
| SQLException.java (377) | **异常链**: reason 构造(120)/getNextException(278,next 链式)、SQLState/错误码 | Medium |
| javax/sql/DataSource.java | **数据源接口**: getConnection——连接池/框架的入口抽象 | Medium |
| XA(域外模块已删,java.transaction.xa) | **XA/2PC(面试向)**: XAResource 接口语义(prepare/commit/rollback)——2PC 理论支撑 | High |

*8 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | DriverManager 注册与加载 | 2 (DriverManager/Driver) | 面试高频(驱动加载机制/SPI);生产(驱动注册失败排查) |
| P1 | 连接生命周期与事务 | 3 (Connection/Statement/ResultSet) | 面试常问(事务边界/连接泄漏) |
| P2 | SQLException 链 | 1 | 面试偶尔;生产(错误链) |
| P2 | XA/2PC 概念 | 1 (面试向) | 面试常问(分布式事务理论) |
| P3 | DataSource 族 | 2 | 使用层 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | 驱动加载与注册机制 | 面试高频(SPI 三通道/Class.forName 静态块);生产(驱动找不到) |
| 🔴 Deep | 连接生命周期与事务控制 | 面试常问(事务边界/连接池关联);生产(泄漏/事务不回滚) |
| 🟡 Working | SQLException 链 | 面试偶尔;生产(错误定位) |
| 🟡 Working | XA/2PC 理论 | 面试常问(2PC 流程/阻塞问题);理论支撑 |
| 🟢 Surface | DataSource/ResultSet 细节 | 使用层 |

## 04 聚类

### 依赖图(域内)
```
DriverManager(注册表) ←── Driver(驱动契约) ←── 驱动实现(域外)
DriverManager(加载) ←── ServiceLoader(域 07 SPI)/jdbc.drivers/Class.forName
Connection(事务边界) ←── Statement ←── ResultSet
DataSource(抽象) ←── 连接池(域外)
XA ←── 2PC 理论(分布式事务)
```

### 教学顺序与文章拆分(3 篇)

1. **DriverManager 与驱动加载机制** — 注册三通道(ServiceLoader/jdbc.drivers/Class.forName)、getConnection 遍历流程、isDriverAllowed、SPI 衔接(域 07)
2. **Connection 生命周期与事务控制** — 接口体系、autoCommit/commit/rollback 边界、连接关闭与泄漏、SQLException 链
3. **XA 与 2PC(面试向)** — XAResource 接口语义、两阶段提交流程、2PC 阻塞问题、与 Seata AT/TCC 对比

> 前置: 域 07(SPI 加载)、03(生命周期)。跨层: 无 native(纯接口);驱动实现是域外(MySQL/Oracle)
