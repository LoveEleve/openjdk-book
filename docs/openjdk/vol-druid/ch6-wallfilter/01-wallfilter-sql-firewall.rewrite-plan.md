# Druid Ch6-01 WallFilter SQL 防火墙 — 正文写作规划

## 文章定位
- 写作卷：`vol-druid`
- 章节：Ch6 WallFilter
- 篇：01 为什么 Druid 能靠 AST 遍历拦截 SQL 注入
- 对应主题：`D-4 WallFilter SQL 防火墙`
- 文章类型：安全实现篇

## 前置依赖
- HARD：读者应已读过 D-2 Filter 链，知道 `nextFilter()` 推进；应已读过 D-6 SQL Parser，知道 AST / Visitor / dialect
- SOFT：StatFilter 和 WallFilter 是解析器两个消费者，本篇不需要重讲解析器内部

## 一句话困惑
为什么 WallFilter 能拦住 `' or '1'='1'` 这类 SQL 注入，而不是靠关键词黑名单硬匹配？

## 一句话顿悟
WallFilter 的防护不是“词表匹配”，而是先由 `WallProvider.check()` 把 SQL 解析成 AST，再用 `WallCheckVisitor` 遍历 AST 的每个节点做规则检查，`WallConfig` 控制哪些表/函数/语句结构允许，违规才登记 `Violation`。

## 读者理解路径
1. 从“为什么黑名单硬匹配不够”切入
2. 最小总图：WallFilter -> WallProvider.check() -> createParser() -> AST -> createWallVisitor() -> violations
3. 解释 `WallFilter` 在 Filter 链中的位置
4. 解析 `WallProvider.check()` 的完整流程
5. 解释 `createWallVisitor()` / `stmt.accept(visitor)` 的遍历方式
6. 解释 `WallConfig` 控制规则
7. 收束：WallFilter 是“AST 遍历 + 规则检查”的安全骨架，不是词表过滤

## 文章结构与字数预算
1. 困惑开场（800-1000 字）
2. 最小总图：WallFilter -> check -> 解析 -> Visitor 遍历（1200-1500 字）
3. `WallFilter` 在 Filter 链中的位置（1400-1800 字）
4. `WallProvider.check()` 完整流程（2200-3000 字）
5. `createWallVisitor()` / `stmt.accept(visitor)` 遍历（1800-2400 字）
6. `WallConfig` 规则控制（1200-1800 字）
7. 收网总结（800-1000 字）

## 证据清单
- `WallFilter.java:44` 类声明
- `WallFilter.java:49` `private WallProvider provider;`
- `WallFilter.java:116` `initWallProvider(...)`
- `WallFilter.java:1563` `checkValid(String sql)`
- `WallProvider.java:43` 抽象类
- `WallProvider.java:441` `check(String sql)`
- `WallProvider.java:446` `checkInternal(sql)`
- `WallProvider.java:454` `checkInternal` 私有方法
- `WallProvider.java:468` `checkWhiteAndBlackList(sql)`
- `WallProvider.java:494` `parser.parseStatementList(statementList)`
- `WallProvider.java:517` multi-statement 检查
- `WallProvider.java:521` `createWallVisitor()`
- `WallProvider.java:533` `stmt.accept(visitor)`
- `WallProvider.java:540` `visitor.getViolations()`
- 方言 Provider：MySqlWallProvider / OracleWallProvider / PGWallProvider / SQLServerWallProvider 等

## 写作后检查
- [ ] 开篇不是黑名单关键词介绍，而是“为什么 AST 遍历更可靠”的困惑
- [ ] 至少 2 个失败方案，且有一个关于“墙就是关键词黑名单”的误解
- [ ] 总图明确区分：Filter 入口 / 解析成 AST / Visitor 遍历 / 规则检查 / Violation
- [ ] 所有 file:line 写作时重新 grep 验证