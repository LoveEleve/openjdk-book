# 为什么业务代码只依赖 `DataSource`，却能在测试、路由池、生产池之间无缝切换：Spring 数据源抽象与池化主线

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 `DataSource` 主线：为什么数据访问层只依赖 `DataSource` 接口就能同时支持非池化、池化、路由三种实现，`AbstractDataSource` / `AbstractDriverBasedDataSource` 如何固定连接获取骨架，`DriverManagerDataSource` 怎么成为“非池化基线”，`HikariDataSource` 又如何通过 `HikariConfig → HikariPool` 实现连接复用。连接池内部的并发细节留给 HikariCP 专用章节。

## 为什么你从来没在业务代码里写 `new HikariDataSource(...)`，却总在用连接池

如果只看最底层的 JDBC，数据库连接是很“成本高”的资源：创建一条真正的 TCP + MySQL 连接是物理链路，和 JVM 内存里 new 一个对象不是一个量级的成本。

但如果从 Spring 业务代码看，你会发现自己几乎从不关心“我拿到的这条 `Connection` 是新建的、复用的，还是路由到某个从库的”。你只需要：

```java
Connection con = dataSource.getConnection();
```

至于背后是：

- 每次 `getConnection` 都真的新建一条（`DriverManagerDataSource`）
- 还是从池里借一条复用（`HikariDataSource`）
- 还是按 key 路由到不同库（`AbstractRoutingDataSource`）

统统与业务代码无关。

这正是 `DataSource` 接口存在的意义。它是 javax.sql 里最朴素也最关键的数据访问入口：对外只暴露 `getConnection()`，至于连接从哪来、怎么管理，都留给实现决定。

第一层问题是：**`DataSource` 接口把“连接怎么来”彻底抽象掉，让数据访问层、事务层、`JdbcTemplate` 都只依赖这一层门面。**

前面 `JdbcTemplate` 篇里，连接获取全是 `DataSourceUtils.getConnection(obtainDataSource())`。`JdbcTemplate` 内部持有的就是 `DataSource`，它根本不关心具体实现是池化还是非池化。所以：

- 测试环境换成 `DriverManagerDataSource`（每次新建，语义简单）
- 生产环境换成 `HikariDataSource`（连接复用）
- 读写分离时换成 `AbstractRoutingDataSource`

业务层和 `JdbcTemplate` 的代码一个字都不用改。这就是“面向接口的数据源门面”。

第二层问题是：**`DataSource` 不只是“一个接口”，它底下有一整套抽象骨架管理连接的获取方式。**

Spring 的 `DataSource` 家族不是一坨平铺的实现，而是分层的：

- `AbstractDataSource`：提供日志、包装等通用逻辑，把 `getConnection()` 留给子类
- `AbstractDriverBasedDataSource`：用模板方法固定“取 URL → 从 Driver / DriverManager 创建连接”的骨架
- `DriverManagerDataSource`：最简单的非池化实现
- `HikariDataSource`：池化实现

这个分层让不同的连接策略都能复用同一套连接获取骨架，差异只在对 URL / 用户名 / 密码的处理上。

第三层问题是：**池化并不是 DataSource 家族里唯一的策略，它只是一个值得单独深挖的实现。**

很多人一提到连接池，就只想到 `HikariDataSource`。但其实 `DataSource` 家族在同一门面上承载了三类完全不同的策略：

- 非池化：每次 `getConnection` 都新建
- 池化：借用与归还
- 路由：按 key 选择目标源

因此，本文真正要回答的问题不是“Hikari 的池怎么工作”，而是：

**`DataSource` 接口如何用“一层门面 + 多层抽象骨架”，让数据访问层、事务层和 JdbcTemplate 都只依赖 `DataSource`，并在非池化、池化、路由三种实现之间自由切换？**

## 先看失败方案：为什么不能每个 DAO 都持有自己的连接、让每个实现都直接暴露细节、把路由写死在业务代码里

### 失败方案一：每个 DAO 都持有自己的 `DataSource` 具体实现

如果每个 DAO 都直接 new `HikariDataSource` 或 `DriverManagerDataSource`，那么：

- 换连接池实现时，所有 DAO 都要改
- DAO 和具体连接策略强耦合
- 测试时无法轻易替换成假数据源

面向 `DataSource` 接口就避免了这个耦合。

### 失败方案二：让每个实现都直接暴露出连接管理细节

如果 `DriverManagerDataSource` 直接对外暴露 URL / 用户名 / 密码字段，`HikariDataSource` 直接暴露池内部结构，那么上层调用方会被具体实现束缚。

Spring 的做法是：`DataSource` 只暴露 `getConnection()`，所有实现都在内部处理细节。

### 失败方案三：把路由逻辑写死在业务代码里

如果多数据源时，业务代码自己判断“这次请求该访问主库还是从库”，那么：

- 路由逻辑散落各处
- 事务边界会与路由边界纠缠
- 难以统一维护

`AbstractRoutingDataSource` 把路由收敛到一个实现里，按 key 选择目标源。

## `DataSource` 主线的最小总图

```text
业务代码 / JdbcTemplate / 事务层
   -> DataSource 接口 (getConnection)
   -> AbstractDataSource (日志/包装通用逻辑)
   -> AbstractDriverBasedDataSource (取 URL -> 从 Driver 创建连接骨架)
      -> DriverManagerDataSource (非池化: 每次新建)
   -> AbstractRoutingDataSource (按 key 选择目标源)
   -> HikariDataSource (池化: HikariConfig -> HikariPool -> 借用)
```

## 一、业务层为什么只依赖 `DataSource` 接口

在 Spring 里，`JdbcTemplate`、事务管理器、`DataSourceUtils` 都只持有 `DataSource` 接口引用。它们调用 `getConnection()` 时，根本不关心底层是池化还是非池化。

这就是“面向接口门面”的价值：

- 数据访问层只依赖“能不能拿连接”
- 连接怎么管理是实现的内部细节
- 换一种连接策略无需改上层代码

`DriverManagerDataSource` 提供了“非池化基线”：每次 `getConnection` 都是 `DriverManager.getConnection(url, props)`，语义最简单、最接近原生 JDBC，适合测试和一次性场景。

## 二、`AbstractDataSource` 与 `AbstractDriverBasedDataSource`：连接获取的抽象骨架

`AbstractDataSource` 提供通用逻辑，例如日志、连接包装器，把 `getConnection()` 留给子类。

`AbstractDriverBasedDataSource` 用模板方法固定连接获取骨架：

```text
getConnection()
   -> getConnectionFromDriver(username, password)
   -> 拿 URL
   -> 通过 Driver 或 DriverManager 创建连接
```

两种取连接方式（Driver 与 DriverManager）在子类里区分。

## 三、`AbstractRoutingDataSource`：把“去哪个库”收敛成一个 key 决策

`AbstractRoutingDataSource` 在 `getConnection()` 时：

```text
determineTargetDataSource()
   -> 根据当前 lookup key 选出目标 DataSource
   -> 目标源.getConnection()
```

其中 `determineCurrentLookupKey()` 是一个**抽象钩子**，由子类实现来提供每次请求的 key（例如从线程上下文取当前租户 ID、或判断主/从）。没有这个钩子，路由就无法接入业务层。

它把多数据源的选择逻辑收进一个实现，业务代码依旧只依赖 `DataSource` 接口。读写分离、多租户选库，都通过这种“按 key 路由”的方式实现。

## 四、`HikariDataSource` 池化：连接复用与借用

`HikariDataSource` 是生产环境的默认池化实现（Spring Boot 3 默认）。它有两种初始化路径：

1. 使用 `new HikariDataSource(HikariConfig)`：池会在构造器里直接建好
2. 使用无参构造、之后通过 setter 设置属性：池会延迟到首次 `getConnection()` 时才建

`HikariConfig` 提供 builder 风格配置（`setMaximumPoolSize`、`setMinimumIdle`、`setJdbcUrl` 等）。之后 `getConnection()` 都从池里“借用”一条连接。

池化把“新建物理连接”的成本降到最低，把高频的 `getConnection / close` 变成借还操作。Spring 官方也明确建议生产环境使用连接池而非裸 `DriverManagerDataSource`。

## 五、非池化、池化、路由三种策略如何并存

| 实现 | 策略 | 适用 |
|------|------|------|
| `DriverManagerDataSource` | 每次新建连接 | 测试 / 简单场景 |
| `HikariDataSource` | 池化复用 | 生产默认 |
| `AbstractRoutingDataSource` | 按 key 路由到目标源 | 读写分离 / 多数据源 |

三者都实现 `DataSource`，所以上层代码可以无感切换。

## 六、几个最容易错的判断

### 1. 每次 `dataSource.getConnection()` 都一定是新建连接

不成立。

池化实现中是借用，只有非池化实现才每次新建。

### 2. `HikariDataSource` 是 `DataSource` 的唯一生产实现

不成立。

它是默认池化实现，但 `DataSource` 族里还有非池化和路由等其他实现。

### 3. 多数据源时，业务代码要自己判断访问哪个库

不成立。

`AbstractRoutingDataSource` 会按 key 收敛路由，业务代码仍只依赖 `DataSource`。

### 4. `DataSource` 接口只是 JDBC 的一个轻量门面

不完整。

它同时也是整个连接管理层和事务层共同依赖的核心抽象。

### 5. 连接池的池化细节是业务代码需要关心的

不成立。

池化是 `DataSource` 实现的内部细节，业务代码面向接口即可。

## 收网：`DataSource` 门面统一的不是“某一种连接实现”，而是“数据访问层/事务层/模板层共同依赖的连接门面与多策略切换”

现在可以回到开头的问题：为什么业务代码只依赖 `DataSource`，却能在测试、路由池、生产池之间无缝切换？

因为 Spring 用“一层门面 + 多层抽象骨架”让所有数据访问入口都只面对 `DataSource`：

```text
业务代码 / JdbcTemplate / 事务层
   -> DataSource.getConnection()
   -> AbstractDataSource + AbstractDriverBasedDataSource（骨架）
   -> DriverManagerDataSource（非池化）
   -> AbstractRoutingDataSource（路由）
   -> HikariDataSource（池化）
```

因此，这篇真正该带走的结论是：

**Spring 把数据源问题从“每次 getConnection 怎么拿连接”提升成了“用 DataSource 门面统一连接获取入口，并在非池化、池化、路由三种策略之间按需切换”的 JDBC 连接抽象协议。**

这也留下了下一篇最自然的问题：既然 `DataSource` 已经把数据访问层和连接策略统一了，那回到 Web 层，后面的 `HandlerInterceptor` 又是如何通过 preHandle / postHandle / afterCompletion 三个回调沿请求执行链切进去的？

下一篇进入 Web MVC 的拦截器主线。