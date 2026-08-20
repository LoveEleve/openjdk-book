# Druid Ch5-01 SQL Parser 体系架构 — 正文写作规划

## 文章定位
- 写作卷：`vol-druid`
- 章节：Ch5 SQL Parser
- 篇：01 为什么 Druid 需要一个独立于 JDBC 的 SQL 解析器体系
- 对应主题：`D-6 SQL Parser 体系架构概览`
- 文章类型：地基层概览篇（不深入 Lexer/AST 生成算法）

## 前置依赖
- HARD：读者应已读过 D-2 Filter 链，知道 `StatFilter` 靠 `ParameterizedOutputVisitorUtils.parameterize()` 做 SQL 参数化
- SOFT：后续 WallFilter 会依赖 AST 遍历，本篇先给解析器定位

## 一句话困惑
为什么 Druid 要自己维护一套 1238 文件的 SQL 解析器，而不是用现成的 ANTLR / JSqlParser？

## 一句话顿悟
Druid 的 SQL 解析器是一条“SQL 文本 → AST → Visitor 遍历 → 方言适配”的管道：`Lexer` 把文本切成 Token，`Parser` 把 Token 组建成 `SQLStatement` AST，`Visitor` 遍历 AST 做输出/统计/检查，`dialect` 包为每种数据库做方言差异化。

## 读者理解路径
1. 从“为什么不用现成解析器”切入
2. 最小总图：SQL 文本 -> Lexer -> Parser -> AST -> Visitor
3. 解释 `SQLUtils` / `SQLParser` / `SQLStatementParser` 分层
4. 解释 `SQLASTVisitor` 为什么是消费 AST 的统一入口
5. 解释 dialect 包（29 种方言）的定位
6. 解释解析器如何被 `StatFilter` / `WallProvider` 复用
7. 收束：解析器是 StatFilter/WallFilter 共同地基

## 文章结构与字数预算
1. 困惑开场（800-1000 字）
2. 最小总图：文本 -> Lexer -> Parser -> AST -> Visitor（1200-1500 字）
3. SQLUtils / SQLParser / SQLStatementParser 分层（1800-2400 字）
4. `SQLASTVisitor`：消费 AST 的统一入口（1600-2200 字）
5. dialect 包：29 种方言定位（1200-1800 字）
6. 解析器如何被 StatFilter / WallProvider 复用（1400-2000 字）
7. 收网总结（800-1000 字）

## 证据清单
- `sql/parser/SQLParser.java:27`
- `sql/visitor/SQLASTVisitor.java:40`
- `sql/SQLUtils.java`
- `sql/SQLUtils.java` 中 `toSQLString` / `parseStatements` 入口
- `sql/dialect/` 下 mysql / oracle / postgresql 等子包
- `visitor.ParameterizedOutputVisitorUtils.java:54/83`
- `wall/WallProvider.java:43/441`
- `wall/WallFilter.java`

## 写作后检查
- [ ] 开篇不是 API 说明，而是“为什么不用现成解析器”的困惑
- [ ] 总图明确区分：Lexer/Parser/AST/Visitor/dialect
- [ ] 不深入 Lexer/Token/AST 生成算法（这是概览篇）
- [ ] 所有 file:line 写作时重新 grep 验证