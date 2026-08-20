# Druid D-4 WallFilter SQL 防火墙 — review notes

## 一次性深审收口（六类合一）

### 事实审
已核实并回填正文的全部锚点：
- `WallFilter.java:44` 类声明
- `WallFilter.java:49` `private WallProvider provider`
- `WallFilter.java:116` `initWallProvider(...)`
- `WallFilter.java:1563` `checkValid(String sql)`
- `WallProvider.java:43` 抽象类
- `WallProvider.java:441` `public WallCheckResult check(String sql)`
- `WallProvider.java:446` `return checkInternal(sql)`
- `WallProvider.java:454` `private WallCheckResult checkInternal(String sql)`
- `WallProvider.java:468` `checkWhiteAndBlackList(sql)`
- `WallProvider.java:475` `hardCheckCount.incrementAndGet()`
- `WallProvider.java:481` `createParser(sql)`
- `WallProvider.java:494` `parser.parseStatementList(statementList)`
- `WallProvider.java:497`/`503`/`517` 语法/注释/multi-statement 违规
- `WallProvider.java:521` `createWallVisitor()`
- `WallProvider.java:533` `stmt.accept(visitor)`
- `WallProvider.java:540` `visitor.getViolations()`
- 方言 Provider：`MySqlWallProvider` / `OracleWallProvider` / `PGWallProvider` / `SQLServerWallProvider` / `SQLiteWallProvider` / `DB2WallProvider`

所有锚点均在源码实存，正文首稿直接带锚点，无二次补锚。

### 因果审
1. WallFilter 不是词表过滤，而是 Filter 链上的安全 Filter → 成立
2. `WallProvider.check()` 先快速通道（白名单/黑名单），再硬检查 AST → 成立
3. `createParser()` 把 SQL 解析成 AST → 成立
4. `stmt.accept(visitor)` 让每个节点进入检查 → 成立
5. 方言 Provider 让不同库用不同规则 → 成立

### 结构审
困惑（为什么黑名单不够）→ 最小总图 → WallFilter 位置 → WallProvider.check() 流程 → Visitor 遍历 → WallConfig → 方言 Provider → 收网。没有按文件目录翻译。

### 读者审
读者读完应能：
- 知道为什么关键词黑名单不够
- 知道 WallProvider.check() 的快速通道 vs 硬检查
- 知道 stmt.accept(visitor) 让 AST 节点进入检查
- 知道不同方言 Provider 用不同规则

### 边界审
本篇只讲 WallFilter 安全骨架，没有重讲 SQL 解析器内部算法。边界清晰。

### 依赖审
- 前置：D-2 Filter 链、D-6 SQL Parser（AST/Visitor 地基）
- 后置：连接验证（D-7）/ PreparedStatementPool（D-8）/ Boot 集成（D-9）

### 结论
本篇已通过一次性深审收口，正文首稿直接带锚点，无二次补锚。D-4 可正式收口。

### 下一步
1. 以当前稿为准收口 D-4
2. 进入 D-7 连接验证与健康检查 的 rewrite-plan