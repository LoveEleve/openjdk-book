# 为什么 Druid 有三种验证时机，而不是 HikariCP 那样一种

> 本文基于 Druid 1.2.27 当前源码。本文只讲连接验证：`testOnBorrow`、`testWhileIdle`、`testOnReturn` 三种验证时机，以及 `ValidConnectionChecker` SPI 如何适配不同数据库。不重讲池本体的借出/归还细节。

## 为什么一条连接要用三种时机验证

在 HikariCP 里，连接验证基本集中在借出前（`aliveBypassWindow` + `isConnectionDead()`）。它的策略很单一：能跳过就不验证，不能跳过就只验证一次。

Druid 没有走这条“尽量少验证”的路，而是把验证分散到了连接生命史的三个不同关口：

- 借出前：`testOnBorrow`
- 空闲时：`testWhileIdle`
- 归还后：`testOnReturn`

为什么会这样？因为 Druid 认为这三种这里的“连接状态风险”不一样：

- 借出前：这条连接会被交给新调用方，必须保证可用
- 归还后：这条连接要回池，应该确认它没有在本次使用时坏掉
- 空闲时：连接在池里放了很久，可能在外部已悄悄失效

每一个关口验证的成本不同、收益不同，所以 Druid 分开配置。

## 三种验证时机的最小总图

```text
借出前  testOnBorrow  -> 在 getConnectionInternal() 中
空闲时  testWhileIdle -> 在 shrink() 中
归还后  testOnReturn  -> 在 recycle() 中
```

## 一、`testOnBorrow`：借出前验证

`testOnBorrow` 是成本最高、也最直接的验证：每次借出前都验证这条连接是否可用。

它在 `getConnectionInternal()` 中的位置是：

- `DruidDataSource.java:1384` `if (testOnBorrow)`

它的作用是：保证交给调用方的连接一定是可用的，代价是每次借出都多一次验证开销。

所以 Druid 默认 `testOnBorrow=false`，是为了在高频借出下避免拖慢性能。需要严格保证每次连接都可用时才开启。

## 二、`testOnReturn`：归还后验证

`testOnReturn` 在 `recycle()` 中触发，用于确认连接在本次使用时没有坏掉：

- `DruidDataSource.java:1934` `final boolean testOnReturn = this.testOnReturn;`
- `DruidDataSource.java:1979` `if (testOnReturn)`

它比 `testOnBorrow` 成本略低，因为它只验证“用完后回池”的连接状态。

默认也通常是 `false`。开启后可以在连接回池前发现问题连接，避免它再被借出去。

## 三、`testWhileIdle`：空闲时验证

`testWhileIdle` 是在连接空闲时（shrink 维护）做的验证，它不拦截借出路径，也不拦截归还路径，而是由后台维护周期触发：

- `DruidDataSource.java:1400` `if (testWhileIdle)`（在 shrink 相关路径中）

它适合那些“池里有连接，但已经空闲很久，可能外部悄悄失效”的场景。Druid 的实际路径是在借出后、交付前按空闲时长决定是否验证；另外，`shrink()` 的 keep-alive 分支也会对收集到的连接执行验证。

它通过空闲时长控制验证频率，避免每次借出都执行验证；但实际验证仍发生在借出路径或 keep-alive 维护分支中，因此不能简单说成完全不影响借出主路径。

## 四、`validationQueryCheck()`：验证配置的一致性

Druid 在启动时会做一次配置一致性检查：`validationQueryCheck()`

- `DruidDataSource.java:1081` `private void validationQueryCheck()`
- `DruidDataSource.java:1082` 如果三个 `testXxx` 都是 `false`，跳过
- `DruidDataSource.java:1090` 如果有 `validationQuery` 就用它
- `DruidDataSource.java:1108` 否则报错：“testWhileIdle is true ... validationQuery not set”

也就是说：如果你开启验证而又没有 `ValidConnectionChecker` 或 `validationQuery`，启动阶段会记录 `validationQuery not set` 错误日志；该检查本身不会直接抛出异常。

这体现了 Druid 的“配置一致性先行”设计：验证策略和验证 SQL 必须同时成立。

## 五、`ValidConnectionChecker` SPI：为什么不同库验证方式不同

验证 `validationQuery` 能不能执行，需要针对不同数据库做不同适配。这就是 `ValidConnectionChecker` SPI 存在的意义：

- `ValidConnectionChecker.java:21` 接口声明
- `JDBC4ValidConnectionChecker` 实现：利用 JDBC4 `Connection.isValid(seconds)`
- 厂商实现（在 `pool/vendor/` 下）：
  - `MySqlValidConnectionChecker.java:38` `DEFAULT_VALIDATION_QUERY = "/* ping */ SELECT 1"`
  - `OracleValidConnectionChecker.java:31` `defaultValidateQuery = "SELECT 'x' FROM DUAL"`
  - `PGValidConnectionChecker.java:28` `defaultValidateQuery = "SELECT 'x'"`
  - `MSSQLValidConnectionChecker.java:30` `DEFAULT_VALIDATION_QUERY = "SELECT 1"`

也就是说，Druid 不要求用户写一个通用的 `validationQuery`，而是按 `dbType` 自动选用适合数据库的默认验证查询。

这样每种数据库都能做“低成本且语义正确”的连接验证：
- MySQL 用 ping 查询
- Oracle 用 DUAL
- PG/SQL Server 用各自最小的验证语句

## 这一篇真正立住的，不是三个配置项，而是“验证时机覆盖连接生命史不同阶段”这个骨架

1. 借出前用 `testOnBorrow`：交付前必验
2. 归还后用 `testOnReturn`：用后回池前验一遍
3. 空闲后用 `testWhileIdle`：后台维护时防悄悄失效
4. `validationQueryCheck()` 保证配置一致
5. `ValidConnectionChecker` SPI 保证不同库用不同的验证方式

所以 Druid 不是盲目做三种验证，而是让验证时机覆盖连接生命史的不同风险阶段。

## 这篇之后，最自然的继续方向

到这里，连接验证已补完。下一步应进入 `D-8 PreparedStatementPool`（连接内部复用优化），再落到 `D-9 Spring Boot Starter`。