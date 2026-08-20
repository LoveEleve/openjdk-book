# Druid D-6 SQL Parser 体系架构 — review notes

## 一次性深审收口（六类合一）

### 事实审
- `sql/parser/SQLParser.java:27` 类声明 ✅
- `sql/visitor/SQLASTVisitor.java:40` 接口声明 ✅
- `visitor/ParameterizedOutputVisitorUtils.java:54` 类声明 ✅
- `visitor/ParameterizedOutputVisitorUtils.java:83` `parameterize(String sql, DbType dbType)` 入口 ✅
- `wall/WallProvider.java:43` 类声明 ✅
- `wall/WallProvider.java:441` `check(String sql)` 入口 ✅
- `sql/dialect/` 下有 29 个方言子包 ✅

本篇不深入 Lexer/Token/AST 生成算法，控制在“概览”范围，与 D-3 和 D-4 的依赖关系清晰。

### 因果审
1. Druid 自建解析器不是“不会用现成工具”，而是需求更重 → 成立
2. 解析管道：Lexer → Parser → AST → Visitor → dialect → 成立
3. `SQLASTVisitor` 是消费 AST 的统一入口 → 成立
4. 解析器是 StatFilter / WallProvider 的共同地基 → 成立

### 结构审
困惑 → 最小总图 → 入口分层 → AST → Visitor → dialect → 被谁复用 → 收网。没有按文件目录平移。

### 读者审
读者读完应能：
- 知道为什么不用 ANTLR / JSqlParser
- 知道 Lexer → Parser → AST → Visitor → dialect 管道
- 知道 `SQLASTVisitor` 的角色
- 知道解析器被 StatFilter 和 WallProvider 复用

### 边界审
本篇不深入 Lexer/Token/AST 生成算法，与 D-3 和 D-4 的边界清晰。D-6 是“地基概览”，不是“解析器深挖”。

### 依赖审
- 前置：D-2 Filter 链、D-3 StatFilter
- 后置：D-4 WallFilter（D-4 依赖 D-6 的概念）

### 结论
本篇已通过一次性深审收口。D-6 可正式收口。

### 下一步
1. 以当前稿为准收口 D-6
2. 进入 D-4 WallFilter SQL 防火墙 的 rewrite-plan