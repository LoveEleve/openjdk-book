# 为什么 Druid 要自己维护一套 1238 文件的 SQL 解析器

> 本文基于 Druid 1.2.27 当前源码。本文只讲 SQL 解析器的架构概览：Lexer/Parser/AST/Visitor/dialect 的分层、它们如何被 StatFilter 和 WallProvider 复用。不深入 Lexer/Token/AST 生成的具体算法。

## 为什么不用现成的 ANTLR / JSqlParser

如果你第一次接触 Druid，看到一个 1238 文件的 `sql/` 包，最先冒出的问题大概率是：

- 为什么 Druid 不直接用 ANTLR？
- 为什么不用 JSqlParser？
- 为什么非要自己维护一整套 AST？

这个问题的答案，不在于“Druid 不会用现成工具”，而在于 Druid 的解析需求比普通 SQL 转对象要更“重”。

它需要的不是“把 SQL 变成一种能再次输出的模型”，而是：
- 能精确控制输出格式（参数化、方言化）
- 能在 AST 上做安全检测（WallFilter）
- 能跨多种数据库方言保持一致性

现成工具很难同时满足这三个诉求。所以 Druid 选择了自己维护一套 SQL 解析管道。

## SQL Parser 的最小总图

```text
SQL 文本
  -> Lexer（切 Token）
    -> Parser（组装 SQLStatement AST）
      -> AST（SQLStatement / SQLExpr / SQLTableSource ...）
        -> Visitor（遍历 AST：输出/统计/检查）
          -> dialect（按数据库方言差异化）
```

这条管道就是 Druid 独有的“SQL 文本 → 可编程 AST”链路。

## 一、入口与执行器分层：SQLUtils / SQLParser / SQLStatementParser

Druid 的 `sql/` 包不是一个大杂烩，而是入口、基础解析器、语句解析器三层：

- `sql/SQLUtils.java`：对外统一入口。提供 `parseStatements(sql)` / `toSQLString(statement)` 等高层方法，屏蔽内部解析细节
- `sql/parser/SQLParser.java`：基础解析器基类，负责 Token 流与基础表达式解析
- `sql/parser/SQLStatementParser`：语句解析器，把 Token 序列组装成 `SQLStatement` AST 节点

对大多数使用者来说，只需要碰 `SQLUtils`；`SQLParser` / `SQLStatementParser` 是它下面的执行层。

证据：`sql/parser/SQLParser.java:27`

## 二、AST：解析后的可编程模型

当 `SQLParser` 把一个 SQL 文本解析完成后，产出物不是字符串，而是一棵 AST：

- `SQLStatement`：一条完整语句（SELECT / INSERT / UPDATE / DELETE ...）
- `SQLExpr`：表达式（列、常量、函数、运算符 ...）
- `SQLTableSource`：表来源

AST 的存在，让后续处理不用再去碰原始 SQL 字符串，而是直接在结构化节点上工作。

这也是 StatFilter 能“把 `WHERE id=123` 合并成 `WHERE id=?`”的原因：它能遍历 AST，把字面量节点替换成占位符。

## 三、Visitor：消费 AST 的统一入口

AST 建好之后，谁去遍历它？Druid 没有让调用方各自遍历，而是提供统一的 `SQLASTVisitor` 接口：

证据：`sql/visitor/SQLASTVisitor.java:40`

`SQLASTVisitor` 是一套 visitor 约定，Druid 内部对它做了大量实现：

- `OutputVisitor`：把 AST 重新输出成 SQL
- `SchemaStatVisitor`：统计表/列的使用
- `WallCheckVisitor`：供 WallFilter 做安全检查
- `ParameterizedOutputVisitorUtils.parameterize()` 内部也是基于这类 visitor 完成的

所以 `SQLASTVisitor` 不是“一个类”，而是 Druid 消费 AST 的统一入口。它让“遍历 AST”成为 Druid 内部能力地基。

## 四、dialect：为什么还要按数据库方言拆分

AST 是共通的，但不同数据库对同一句 SQL 的写法有差异。Druid 的 `sql/dialect/` 包就是为方言准备的：

- `mysql`
- `oracle`
- `postgresql`
- `db2`
- `sqlserver`
- `hive`
- `clickhouse`
- 以及更多

Druid 用这些方言子包封装各个数据库的语法差异、类型系统差异、允许/禁止的 SQL 规则。

对 WallProvider 来说尤其重要：不同数据库允许的 SQL 子集不同，所以 `WallProvider` 也有方言各自的实现。

## 五、解析器如何被 StatFilter / WallProvider 复用

解析器不是“只给某个模块用”的工具，而是 StatFilter / WallFilter 的共同地基：

- StatFilter：调用 `ParameterizedOutputVisitorUtils.parameterize(sql, dbType, ...)`，把 SQL 参数化，用于 SQL 合并统计
  - `visitor/ParameterizedOutputVisitorUtils.java:54` 类声明
  - `visitor/ParameterizedOutputVisitorUtils.java:83` `parameterize(String sql, DbType dbType)` 入口
- WallProvider：调用解析器把 SQL 转成 AST，再通过 `WallCheckVisitor` 遍历 AST 做安全检查
  - `wall/WallProvider.java:43` 类声明
  - `wall/WallProvider.java:441` `check(String sql)` 入口

也就是说：解析器是这场大戏的“前台”，StatFilter 和 WallFilter 是它的两个主要消费者。

## 本篇真正立住的，不是 Lexer 细节，而是“解析器是 Druid 监控与安全的地基”

一旦理解了这条管道，就能明白为什么 Druid 敢说“不侵入业务代码做 SQL 监控与安全”：

1. 解析器把 SQL 变成 AST
2. `SQLASTVisitor` 让 Druid 能统一遍历 AST
3. StatFilter 和 WallFilter 都踩在这个地基上
4. 具体数据库差异被方言层封装

所以 D-3 StatFilter 和 D-4 WallFilter 共同依赖的，正是这条解析管道。

## 这篇之后，最自然的继续方向

解析器地基立住后，下一步就是 WallFilter——它利用 `WallProvider.check()` 解析 SQL，再用 `WallCheckVisitor` 做安全检测。