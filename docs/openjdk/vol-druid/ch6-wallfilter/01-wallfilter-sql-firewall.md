# 为什么 Druid 能靠 AST 遍历拦截 SQL 注入

> 本文基于 Druid 1.2.27 当前源码。本文只讲 WallFilter 的安全实现：`WallFilter` 在 Filter 链中的位置、`WallProvider.check()` 把 SQL 解析成 AST、`WallCheckVisitor` 遍历 AST 检查规则、`WallConfig` 控制允许范围。不展开 SQL 解析器内部算法。

## 为什么关键词黑名单不够

如果你只做 SQL 注入防护，最容易想到的方式是“关键词黑名单”：

- 检测到 `or`
- 检测到 `'`
- 检测到 `union` / `select` / `insert`

但这套方案在真实环境里非常脆弱：

- 大小写绕过：`Or` / `OR` / `oR`
- 注释绕过：`or/*x*/1=1`
- 编码绕过：`%27`、Unicode
- 正常业务也会用到很多敏感词，误杀严重

Druid 没走这条路。它选择先解析 SQL，再在结构化 AST 上做检查。这就是 WallFilter 和普通防火墙的本质区别。

## WallFilter 的最小总图

```text
Druid 连接池
  -> WallFilter（Filter 链上）
    -> WallProvider.check(sql)
      -> 白名单/黑名单（快速通道）
      -> createParser(sql) -> parseStatementList -> SQLStatement AST
      -> createWallVisitor() -> stmt.accept(visitor) 遍历 AST
      -> visitor.getViolations() 收集违规
    -> WallConfig 控制允许范围
```

它不是一个黑名单检测器，而是一条“解析成 AST → 遍历 → 检查 → 收集违规”的管道。

## 一、`WallFilter` 在 Filter 链中的位置

`WallFilter` 是 Druid Filter 链上的一个 Filter。

- `WallFilter.java:44` 类声明
- `WallFilter.java:49` `private WallProvider provider;`
- `WallFilter.java:116` `initWallProvider(...)`，根据 dbType 创建对应方言 Provider
- `WallFilter.java:1563` `checkValid(String sql)`

和 `StatFilter` 一样，它并不自己动手解析 SQL，而是把工作委托给 `WallProvider`。

关键的地方在于：因为它在 Filter 链上，所以每个 JDBC 执行都会经过它；因为它内部有方言 Provider，所以不同数据库执行不同规则。

## 二、`WallProvider.check()` 完整流程

`WallFilter` 最终调用 `WallProvider.check(sql)`：

- `WallProvider.java:441` `public WallCheckResult check(String sql)`
- `WallProvider.java:446` `return checkInternal(sql)`
- `WallProvider.java:454` `private WallCheckResult checkInternal(String sql)`

`check()` 的流程是：

1. **快速通道**：如果配置了白名单/黑名单，先检查是否命中
   - `WallProvider.java:468` `checkWhiteAndBlackList(sql)`
   - 如果命中，直接返回结果，不再做硬检查
2. **硬检查**：否则进入真正的 AST 检查
   - `WallProvider.java:475` `hardCheckCount.incrementAndGet()`
3. **解析成 AST**
   - `WallProvider.java:481` `createParser(sql)`
   - `WallProvider.java:494` `parser.parseStatementList(statementList)` 得到 `List<SQLStatement>`
4. **语法/结构检测**
   - `WallProvider.java:517` 如果 `statementList.size() > 1` 且不允许 multi-statement，记违规
   - `WallProvider.java:497` 注释处理、`WallProvider.java:503` 禁止注释等

所以 `check()` 并不是一进来就扫描关键词，而是先“尽量快速通道”，再“完整解析 AST”。

这样做既保证性能（白名单/黑名单很快），也保证可靠性（真正安全判断基于 AST）。

## 三、`createWallVisitor()` / `stmt.accept(visitor)` 遍历

AST 建好之后，真正做规则检查的是 visitor 遍历：

- `WallProvider.java:521` `WallVisitor visitor = createWallVisitor();`
- `WallProvider.java:533` `stmt.accept(visitor);`
- `WallProvider.java:540` `if (visitor.getViolations().size() > 0) violations.addAll(visitor.getViolations());`

这里的核心是 `stmt.accept(visitor)`：每个 AST 节点在 `accept` 时把自己的类型分派给 `visitor` 对应的 `visit(...)` 方法。

例如：
- `visit(SQLExprTableSource x)` 检查表来源是否在白名单
- `visit(SQLMethodInvokeExpr x)` 检查函数调用
- 各种表达式节点能判断是否出现危险的恒真条件（如 `1=1`、`'1'='1'`）

正是因为有 `SQLASTVisitor` 这个统一抽象，WallFilter 才能做“AST 级规则检查”，而不是碰原始字符串。

## 四、`WallConfig` 控制允许范围

规则要不要生效、允许哪些表函数、允许哪些语句类型，都由 `WallConfig` 控制：

- 表白名单：哪些表允许访问
- 函数调用限制：哪些函数不合法
- 语句类型限制：哪些语句类型允许
- 对 `1=1` 这类恒真条件做出拦截

`WallFilter` 的 `config` 来自 init 时创建的方言 Provider，所以不同数据库可加载不同默认规则。

## 五、方言 Provider：为什么不同库规则不同

Druid 在 `initWallProviderInternal()` 里根据 `dbType` 创建对应 Provider：

- `MySqlWallProvider`
- `OracleWallProvider`
- `PGWallProvider`
- `SQLServerWallProvider`
- `SQLiteWallProvider`
- `DB2WallProvider`

每个碎片 Provider 继承 `WallProvider`，并用对应方言的默认 `WallConfig` 和 `WallCheckVisitor`。

这样 Druid 能在不同数据库上使用“语言密切相关”的安全规则，而不是一套 SQL 规则打天下。

## 这篇真正立住的，不是 WallFilter 配置，而是“AST 遍历 + 规则检查”的安全骨架

回到开头，为什么关键词黑名单不够？因为它是字符串级的，看不到结构。

WallFilter 换了一条更可靠的路：

1. `WallFilter` 在 Filter 链上拦截每次 JDBC 执行
2. `WallProvider.check()` 尝试快速通道（白名单/黑名单）
3. 硬检查时把 SQL 解析成 AST
4. `stmt.accept(visitor)` 让每个节点进入检查
5. 违规被收集进 `Violation` 列表

所以 WallFilter 本质上不是“词表过滤”，而是“结构解析 + 规则遍历”的安全实现。

## 这篇之后，最自然的继续方向

到目前，`vol-druid` 已经覆盖：池本体、维护体系、Filter 链、StatFilter、SQL 解析器、WallFilter。接下来可以进入连接验证（D-7）或 PreparedStatementPool（D-8），再落到 Spring Boot 集成（D-9）。