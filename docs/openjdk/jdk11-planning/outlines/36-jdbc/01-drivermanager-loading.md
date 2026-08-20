# 01. DriverManager 与驱动加载机制 — 注册三通道、连接路由

> 🔴 Deep | 域 36 JDBC 第 1 篇 | Layer 3
> 读者处境: 面试"Class.forName 注册驱动是怎么回事""SPI 自动加载"——DriverManager 的注册表与三通道加载。

### 1. "DriverManager 是什么？" — 驱动注册表

场景: `DriverManager.getConnection(url)` — 它怎么知道用哪个驱动?

- `DriverManager.java:86` — `registeredDrivers = new CopyOnWriteArrayList<>()` — **驱动注册表**(并发安全)
- `DriverManager.java:341` — `registerDriver` 的 `addIfAbsent`(驱动可重复注册去重)
- `DriverManager.java:378` — `deregisterDriver`(卸载驱动,DriverAction 回调)
- 关键设计 (斜体): *DriverManager 是"驱动注册中心"——Driver 对象注册进列表,getConnection 按序询问"你能接这个 URL 吗";CopyOnWriteArrayList 保证注册/遍历并发安全(域 10)*
- 面试: "getConnection 怎么选驱动?"——遍历注册表,调 driver.acceptsURL(url)

### 2. "驱动怎么被加载？" — 三通道

场景: 老代码 `Class.forName("com.mysql.jdbc.Driver")` 为什么能注册?JDBC4 之后为什么不用写了?

- 通道①: 显式 `Class.forName` — 驱动静态块调 `DriverManager.registerDriver`(经典写法)
- 通道②: **ServiceLoader<Driver>**(`DriverManager.java:597` `ServiceLoader.load(Driver.class)`,loadInitialDrivers 内)— JDBC4+ 自动加载驱动 jar 的 `META-INF/services/java.sql.Driver`(域 07 SPI)
- 通道③: `jdbc.drivers` 系统属性(`DriverManager.java:95`,冒号分隔类名列表)
- `DriverManager.java:94` — `driversInitialized` 标志(ensureDriversInitialized 保证只初始化一次)
- 关键设计 (斜体): *"三通道 + 只初始化一次"是 SPI 的标准工程形态——显式(兼容)、SPI(自动)、属性(运维);面试"JDBC4 还要 Class.forName 吗"——不需要(SPI 自动),但老驱动/老代码保留*
- [关联: 域 07 类加载(ServiceLoader 与线程上下文加载器);面试"SPI 怎么加载"——域 07 展开]

### 3. "getConnection 的完整流程" — 路由与校验

场景: `getConnection("jdbc:mysql://host:3306/db", user, pwd)` — 内部发生了什么?

- `DriverManager.java:247` `getConnection(String)` → 251 三参版 → 646 私有 `getConnection`
- 流程(646-690): ① 确保驱动已初始化(ensureDriversInitialized)② 遍历 `registeredDrivers` ③ `isDriverAllowed(aDriver.driver, callerCL)`(674,校验调用者类加载器能否加载驱动类)④ `driver.connect(url, info)`(677)⑤ 成功返回,失败继续下一个
- `DriverManager.java:266` `getDriver(url)`(单查)
- 关键设计 (斜体): *"遍历 + 尝试 + 谁先接受谁用"是插件式路由——URL 前缀(jdbc:mysql://)由各驱动 acceptsURL 认领;isDriverAllowed 是安全校验(防止不可信加载器注入驱动)*
- 面试: "getConnection 失败抛什么?"——SQLException("No suitable driver"——注册表空/无驱动接受 URL)

### 4. "连接池为什么用 DataSource 不用 DriverManager？" — 抽象演进

场景: 生产连接池(HikariCP/MyBatis)的入口——为什么是 DataSource

- `javax/sql/DataSource.java` — `getConnection()` 接口——**连接获取的抽象**(实现=连接池/DriverManager 适配)
- JNDI 时代: 应用服务器注册 DataSource(域 07 JNDI 关联)
- DriverManager 局限: 每次 getConnection 新建物理连接(无池化)
- 关键设计 (斜体): *DriverManager = 直连;DataSource = 抽象(可池化/可分布式);框架只依赖 DataSource 接口——"面向抽象编程"的标准示范;面试"连接池原理"——DataSource 实现里维护连接队列(域 10 队列思想)*
- 生产: 连接池配置(initialSize/maxPoolSize)与泄漏监控

---

### 核心悬念

连接拿到了——但**事务边界**在哪?`setAutoCommit(false)` 后 commit/rollback 谁负责?SQLException 的链怎么串?——下一篇: Connection 生命周期与事务控制。

> → [02-connection-transaction.md](02-connection-transaction.md)
