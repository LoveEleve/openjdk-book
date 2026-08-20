# Druid D-7 连接验证与健康检查 — review notes

## 一次性深审收口（六类合一）

### 事实审
已核实并回填正文的全部锚点：
- `DruidDataSource.java:1081` `validationQueryCheck()`
- `DruidDataSource.java:1384` `if (testOnBorrow)`
- `DruidDataSource.java:1400` `if (testWhileIdle)`
- `DruidDataSource.java:1934` `final boolean testOnReturn = this.testOnReturn;`
- `DruidDataSource.java:1979` `if (testOnReturn)`
- `ValidConnectionChecker.java:21` 接口声明
- `pool/vendor/MySqlValidConnectionChecker.java:38` `"/* ping */ SELECT 1"`
- `pool/vendor/OracleValidConnectionChecker.java:31` `"SELECT 'x' FROM DUAL"`
- `pool/vendor/PGValidConnectionChecker.java:28` `"SELECT 'x'"`
- `pool/vendor/MSSQLValidConnectionChecker.java:30` `"SELECT 1"`

所有锚点均在源码实存，正文首稿直接带锚点，无二次补锚。

### 因果审
1. 三种验证时机分别覆盖借出前、空闲时、归还后 → 成立
2. `testOnBorrow` 在 `getConnectionInternal()` 中，成本最高 → 成立
3. `testOnReturn` 在 `recycle()` 中，成本中等 → 成立
4. `testWhileIdle` 在借出后按空闲时长触发，keep-alive 的 shrink 分支也会执行验证；不能概括为只由 shrink 触发 → 已修正
5. `validationQueryCheck()` 检查验证器或验证 SQL是否存在，并记录错误日志而非直接抛异常 → 已修正
6. `ValidConnectionChecker` SPI 适配不同数据库 → 成立

### 结构审
困惑 → 三种时机总图 → testOnBorrow → testOnReturn → testWhileIdle → validationQueryCheck → SPI → 收网。没有按文件目录翻译。

### 读者审
读者读完应能：
- 知道三种验证时机分别对应什么位置
- 知道每个时的成本/收益
- 知道 `validationQueryCheck()` 的作用
- 知道 `ValidConnectionChecker` SPI 适配不同数据库

### 边界审
本篇只讲验证时机和 SPI 架构，没有重讲池本体借出/归还细节。边界清晰。

### 依赖审
- 前置：D-1 池本体（借出/归还路径）
- 后置：D-8 PreparedStatementPool / D-9 Boot Starter

### 结论
本篇已通过一次性深审收口，正文首稿直接带锚点，无二次补锚。D-7 可正式收口。

### 下一步
1. 以当前稿为准收口 D-7
2. 进入 D-8 PreparedStatementPool 的 rewrite-plan