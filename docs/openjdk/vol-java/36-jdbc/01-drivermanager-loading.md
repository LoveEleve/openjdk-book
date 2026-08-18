# 01. DriverManager 与驱动加载机制 — 注册三通道、连接路由

> **前置依赖**: [07-classloader/03 — 资源与 SPI](../07-classloader/03-resource-spi.md)(ServiceLoader 与 TCCL)、[07-classloader/01 — 双亲委派模型](../07-classloader/01-delegation-model.md)(类加载链)
> → **后续**:[36-jdbc/02 — Connection 生命周期与事务控制](02-connection-transaction.md)
> 关联: 域 07 类加载(SPI 加载);并发集合的写时复制机制(CopyOnWriteArrayList)

## 一行 getConnection,背后怎么找到驱动

`DriverManager.getConnection("jdbc:mysql://host:3306/db", user, pwd)`——一行代码,DriverManager 怎么知道用 MySQL 驱动而不是 Oracle?老代码还要 `Class.forName("com.mysql.jdbc.Driver")`,JDBC4 之后为什么不用写了?这一篇拆开 DriverManager 的注册表、驱动加载三通道、getConnection 的遍历路由,最后到 DataSource 的抽象演进。

## 1. "DriverManager 是什么？" — 驱动注册表

### 1.1 一个并发安全的列表

`DriverManager`(`DriverManager.java`)的核心是一个静态注册表(`DriverManager.java:86`):

```java
// DriverManager.java:86(截取核心,逐字)
    private final static CopyOnWriteArrayList<DriverInfo> registeredDrivers = new CopyOnWriteArrayList<>();
```

**`CopyOnWriteArrayList<DriverInfo>`**——为什么用它?注册表被两类线程并发访问: 加载期(驱动注册)和运行期(getConnection 遍历)。CopyOnWrite 让**遍历无锁、写时复制**(写操作复制底层数组)——getConnection 遍历注册表时不担心并发修改异常。

### 1.2 registerDriver:去重注册

驱动通过 `registerDriver`(`DriverManager.java:335-341`)注册:

```java
// DriverManager.java:335-341(截取核心,逐字)
    public static void registerDriver(java.sql.Driver driver,
            DriverAction da)
        throws SQLException {

        /* Register the driver if it has not already been added to our list */
        if (driver != null) {
            registeredDrivers.addIfAbsent(new DriverInfo(driver, da));
```

`addIfAbsent`——**驱动重复注册自动去重**(Class.forName 反复执行也只会有一个 DriverInfo)。`deregisterDriver`(`DriverManager.java:378`)反向卸载,支持 `DriverAction` 回调(驱动卸载时通知)。

关键设计(斜体):*DriverManager 是"驱动注册中心"——Driver 对象注册进列表,getConnection 按序询问"你能接这个 URL 吗";CopyOnWriteArrayList 保证注册/遍历并发安全。面试"getConnection 怎么选驱动": 遍历注册表,调 driver.acceptsURL(url) 认领。*

## 2. "驱动怎么被加载？" — 三通道

### 2.1 为什么有 Class.forName 的老写法

JDBC 3 时代,驱动不会自动出现——必须显式加载类:

```java
// 用法示意(API 形式,非源码片段)
Class.forName("com.mysql.jdbc.Driver");   // 老写法: 加载驱动类
```

秘密在**驱动类的静态块**: `com.mysql.jdbc.Driver` 的静态初始化块里调用 `DriverManager.registerDriver(new Driver())`——`Class.forName` 触发类初始化,静态块执行,驱动注册进表。所以 `Class.forName` 的"作用"不是别的,是**借类初始化执行注册**。

### 2.2 三通道:显式 + SPI + 属性

JDBC 4 起,`DriverManager` 在首次使用时自动加载驱动(`ensureDriversInitialized`,`DriverManager.java:570`)。执行顺序(注意与大纲编号不同,按实际源码): **先读 `jdbc.drivers` 属性字符串**(`:583`),再 `ServiceLoader.load` 自动发现(`:597`),最后才逐个 `Class.forName` 加载属性里列出的类(`:631-632`)。

**ServiceLoader 通道(JDBC4+ 主通道)**: `ServiceLoader.load(Driver.class)`(`DriverManager.java:597`)扫描所有驱动 jar 的 `META-INF/services/java.sql.Driver` 文件,自动实例化并注册——这就是"JDBC4 之后不用写 Class.forName"的原因:

```java
// DriverManager.java:594-598(截取核心,逐字)
            AccessController.doPrivileged(new PrivilegedAction<Void>() {
                public Void run() {

                    ServiceLoader<Driver> loadedDrivers = ServiceLoader.load(Driver.class);
                    Iterator<Driver> driversIterator = loadedDrivers.iterator();
```

注意迭代被 `try { while (driversIterator.hasNext()) driversIterator.next(); } catch (Throwable t) {}` 包住(`DriverManager.java:612-618`)——**个别驱动加载失败不影响其他驱动**: 某驱动的 service 声明存在但类缺失(ServiceConfigurationError)时,DriverManager 吞掉异常继续,不阻塞初始化。

**jdbc.drivers 属性通道**: 冒号分隔的驱动类名列表(`DriverManager.java:95` 的 `JDBC_DRIVERS_PROPERTY = "jdbc.drivers"`),逐个 `Class.forName(aDriver, true, ClassLoader.getSystemClassLoader())`(`:631-632`)加载——运维用 `-Djdbc.drivers=...` 注入驱动。

**显式 Class.forName 通道**: 仍兼容,老代码/老驱动保留。

### 2.3 只初始化一次

`driversInitialized` 标志(`DriverManager.java:94`)+ `synchronized (lockForInitDrivers)`(`:575`): **驱动加载只执行一次**,后续 getConnection 直接跳过初始化——三通道在首次使用时合并执行。

关键设计(斜体):*"三通道 + 只初始化一次"是 SPI 的标准工程形态——显式(兼容老代码)、SPI(自动发现)、属性(运维注入)。面试"JDBC4 还要 Class.forName 吗": 不需要——ServiceLoader 自动加载 META-INF/services;但老驱动/老代码保留该写法。SPI 的完整机制(扫描/实例化/失败容忍)在域 07 展开。*

跨层标注: [域 07: 03-resource-spi——ServiceLoader.load 默认用 TCCL 扫描 META-INF/services,DriverManager 的加载正是 SPI 的标准用例]

## 3. "getConnection 的完整流程" — 路由与校验

### 3.1 入口链

`getConnection(String)`(`DriverManager.java:247`)→ 组装 Properties → 私有 `getConnection(url, info, caller)`(`DriverManager.java:646`)。私有方法的关键第一步: **确定调用者类加载器**(`DriverManager.java:654-657`):

```java
// DriverManager.java:654-657(截取核心,逐字)
        ClassLoader callerCL = caller != null ? caller.getClassLoader() : null;
        if (callerCL == null || callerCL == ClassLoader.getPlatformClassLoader()) {
            callerCL = Thread.currentThread().getContextClassLoader();
        }
```

调用者加载器为空(引导类)或平台加载器时,退回 **TCCL(线程上下文类加载器)**——否则 JDBC 驱动(在应用 classpath)根本加载不到(域 07 的 TCCL 语义)。

### 3.2 遍历注册表:谁接受谁用

核心循环(`DriverManager.java:671-693`):

```java
// DriverManager.java:671-693(截取核心,逐字)
        for (DriverInfo aDriver : registeredDrivers) {
            // If the caller does not have permission to load the driver then
            // skip it.
            if (isDriverAllowed(aDriver.driver, callerCL)) {
                try {
                    println("    trying " + aDriver.driver.getClass().getName());
                    Connection con = aDriver.driver.connect(url, info);
                    if (con != null) {
                        // Success!
                        println("getConnection returning " + aDriver.driver.getClass().getName());
                        return (con);
                    }
                } catch (SQLException ex) {
                    if (reason == null) {
                        reason = ex;
                    }
                }

            } else {
                println("    skipping: " + aDriver.getClass().getName());
            }

        }
```

三步: ① **`isDriverAllowed`**(`DriverManager.java:674`)——校验调用者加载器能否加载该驱动类(`DriverManager.java:550-567`: `Class.forName(driver.getClass().getName(), true, classLoader)`,加载结果与驱动类相同才放行)——**防不可信加载器注入驱动** ② **`driver.connect(url, info)`**(`:677`)——真正尝试连接 ③ 成功(con != null)返回;失败记住首个异常继续下一个。

### 3.3 没人认领:No suitable driver

遍历完都没人接(`DriverManager.java:701-702`):

```java
// DriverManager.java:701-702(截取核心,逐字)
        println("getConnection: no suitable driver found for "+ url);
        throw new SQLException("No suitable driver found for "+ url, "08001");
```

`SQLException("No suitable driver found for ...", "08001")`——**SQLState 08001**(连接失败类)。原因通常是: 注册表空(驱动没加载)/URL 前缀无驱动认领(拼错 jdbc: 子协议)。

### 3.4 驱动契约:acceptsURL 认领

`Driver` 接口(`Driver.java:91-92` 的 `connect`、`:106` 的 `acceptsURL`)是认领与连接的契约:

```java
// Driver.java:91-92 + 106(截取核心,逐字)
    Connection connect(String url, java.util.Properties info)
        throws SQLException;
...
    boolean acceptsURL(String url) throws SQLException;
```

`acceptsURL` 按 URL 前缀判断"这个 URL 归我"(如 `jdbc:mysql://`),`connect` 真正建立连接。getDriver(url)(`DriverManager.java:266`)是单查版: 只找认领者不连接。

关键设计(斜体):*"遍历 + 尝试 + 谁先接受谁用"是插件式路由——URL 前缀由各驱动 acceptsURL 认领;isDriverAllowed 是安全校验(防不可信加载器注入驱动)。面试"getConnection 失败抛什么": SQLException("No suitable driver found", SQLState 08001)——注册表空或无驱动接受 URL。*

## 4. "连接池为什么用 DataSource 不用 DriverManager？" — 抽象演进

### 4.1 DataSource:连接获取的抽象

`javax.sql.DataSource`(`DataSource.java`)是连接获取的接口抽象(`DataSource.java:92` 的 `getConnection()`、`:109` 的带参版)。**生产框架(HikariCP/MyBatis)依赖的是 DataSource 接口,不是 DriverManager**——因为:

- **可池化**: DataSource 实现可以在内部维护连接队列,`getConnection` 从池里拿(连接复用),而不是每次新建物理连接
- **可分布式**: JNDI 时代应用服务器把 DataSource 注册到 JNDI,应用通过名字查找
- **可替换**: 换连接池 = 换 DataSource 实现,业务代码零改动——"面向抽象编程"的标准示范

### 4.2 DriverManager 的局限

`DriverManager.getConnection` 每次调用**新建一条物理连接**(握手、认证、建会话)——无池化。高并发下反复建连是性能灾难。这就是连接池存在的理由: 复用连接、控制并发数、监控泄漏。

关键设计(斜体):*DriverManager = 直连(每次新建物理连接);DataSource = 抽象(可池化/可分布式/可替换)。面试"连接池原理": DataSource 实现里维护连接队列 + 连接复用 + 泄漏回收——池的核心是"复用与上限";框架只依赖 DataSource 接口就是"面向抽象编程"。*

## 核心悬念

连接拿到了——但**事务边界**在哪?`setAutoCommit(false)` 之后 commit/rollback 谁负责?一个事务跨多条 Statement 怎么保证原子?`SQLException` 的链怎么串起多个错误?连接泄漏怎么发生的?——下一篇: Connection 生命周期与事务控制。

> → [36-jdbc/02 — Connection 生命周期与事务控制](02-connection-transaction.md)
