# Druid Ch7-01 连接验证与健康检查 — 正文写作规划

## 文章定位
- 写作卷：`vol-druid`
- 章节：Ch7 Validation
- 篇：01 为什么 Druid 有三种验证时机，而不是 HikariCP 那样一种
- 对应主题：`D-7 连接验证与健康检查`
- 文章类型：骨架补深篇

## 前置依赖
- HARD：读者应已读过 D-1，知道池本体的借出路径 `getConnectionInternal()` 和 `recycle()`
- SOFT：D-3 StatFilter 和 D-4 WallFilter 不依赖本篇

## 一句话困惑
为什么 HikariCP 只靠 `aliveBypassWindow` + `isConnectionDead()` 两种判断，而 Druid 要拆出 `testOnBorrow`、`testWhileIdle`、`testOnReturn` 三种时机，每种还对应不同的 `ValidConnectionChecker` 实现？

## 一句话顿悟
Druid 的三种验证时机不是在重复设计，而是分别放在借出前、空闲时、归还后三个不同关口，由 `ValidConnectionChecker` SPI 适配不同数据库——MySQL 用 `/* ping */ SELECT 1`，Oracle 用 `SELECT 'x' FROM DUAL`，PG 用 `SELECT 'x'`。

## 读者理解路径
1. 从“为什么三种时机”切入
2. 最小总图：`testOnBorrow`（借出前）→ `testWhileIdle`（空闲）→ `testOnReturn`（归还后）
3. 解释 `testOnBorrow` 在 `getConnectionInternal()` 中的位置
4. 解释 `testOnReturn` 在 `recycle()` 中的位置
5. 解释 `testWhileIdle` 在 shrink 中的位置
6. 解释 `ValidConnectionChecker` SPI 架构
7. 收束：三种验证时机覆盖了连接生命史的不同阶段

## 文章结构与字数预算
1. 困惑开场（800-1000 字）
2. 最小总图：借出前/空闲/归还后（1200-1500 字）
3. `testOnBorrow` 在 `getConnectionInternal()` 中的位置（1600-2200 字）
4. `testOnReturn` 在 `recycle()` 中的位置（1400-2000 字）
5. `testWhileIdle` 在 shrink 中的位置（1400-2000 字）
6. `ValidConnectionChecker` SPI 架构（1600-2200 字）
7. 收网总结（800-1000 字）

## 证据清单
- `DruidDataSource.java:1081` `validationQueryCheck()`
- `DruidDataSource.java:1384` `if (testOnBorrow)` 在 `getConnectionInternal` 中
- `DruidDataSource.java:1400` `if (testWhileIdle)`
- `DruidDataSource.java:1934` `final boolean testOnReturn = this.testOnReturn;`
- `DruidDataSource.java:1979` `if (testOnReturn)` 在 `recycle()` 中
- `ValidConnectionChecker.java:21` 接口声明
- `JDBC4ValidConnectionChecker.java` 实现
- `pool/vendor/MySqlValidConnectionChecker.java:38` `"/* ping */ SELECT 1"`
- `pool/vendor/OracleValidConnectionChecker.java:31` `"SELECT 'x' FROM DUAL"`
- `pool/vendor/PGValidConnectionChecker.java:28` `"SELECT 'x'"`
- `pool/vendor/MSSQLValidConnectionChecker.java:30` `"SELECT 1"`
- `DruidAbstractDataSource.java` 中 `testOnBorrow` `testWhileIdle` `testOnReturn` 字段声明

## 写作后检查
- [ ] 开篇不是配置项说明，而是“为什么三种验证时机”的困惑
- [ ] 总图明确区分：借出前/空闲/归还后
- [ ] 不把 `testWhileIdle` 写成 `shrink` 的附属，而是独立验证时机
- [ ] 所有 file:line 写作时重新 grep 验证