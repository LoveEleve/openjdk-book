# vol-druid 卷级六层审查笔记

> 审查基线：Druid 1.2.27 当前源码；正文 9 篇；规划文档五层路线图；对照卷 `vol-hikaricp`。

## 结论

卷级审查完成。正文锚点已扫描并复核，发现的问题已修正；物理目录不移动，卷级推荐顺序调整为按规划层级阅读：`D-1 → D-5 → D-7 → D-2 → D-8 → D-3 → D-4 → D-6 → D-9`。

## ① 事实审

- 扫描 9 篇正文，共 100 个 `file:line` 引用。
- 所有引用对应的源码文件存在，行号均在当前文件范围内。
- 未发现跨篇重复锚点；`StatFilter.java:500` 和 `DruidDataSource.java:2887` 的重复均在同一篇正文内部或其对应笔记语境中。
- 源码抽查确认：`DruidDataSource.java:81` 才是类声明，3979 是文件总行数；正文已修正。
- `sql/` 实际有 1238 个 Java 文件，`sql/dialect/` 实际有 29 个方言目录，原正文数字成立。

## ② 因果审

跨篇链路成立，但有两处已修正：

- `D-1 → D-5`：数组与 holder 是 shrink 的扫描对象，`DestroyTask.run()` 在 `DruidDataSource.java:2887` 调用 `shrink(true, keepAlive)`，再按条件调用 `removeAbandoned()`。
- `D-2 → D-3/D-4`：StatFilter 与 WallFilter 都建立在 Filter 链上。
- `D-3/D-4 → D-6`：参数化与 WallProvider 的检查共同依赖 Parser/AST/Visitor。
- `D-1 → D-9`：`DruidDataSourceWrapper.afterPropertiesSet()` 在 `DruidDataSourceWrapper.java:36` 调用 `init()`。
- `D-7` 原文把 `testWhileIdle` 简化成“由 shrink 触发”，实际 `DruidDataSource.java:1400` 位于借出后交付路径，且 shrink 的 keep-alive 分支也有独立验证；正文已改正。
- `validationQueryCheck()` 在 `DruidDataSource.java:1081` 缺少 checker/query 时记录错误日志，不直接抛异常；正文已改正。

## ③ 结构审

规划文档在 `Druid源码学习范围规划.md:203` 定义 A/B/C/D/E 五层。当前物理目录顺序是 `D-1 → D-5 → D-2 → D-3 → D-6 → D-4 → D-7 → D-8 → D-9`，写作产物链接已稳定，不建议为结构审重命名目录。

卷级处理是：

- 物理目录保持不变，避免破坏已有链接。
- 导读和总索引采用规划层级推荐顺序，把 D-7 明确放在骨架层、Filter 层之前。
- D-6 作为 D-3/D-4 的共同地基，推荐位置放在监控/安全之后用于回看抽象，不构成因果回环。

该安排同时保留写作过程和读者学习路径，层序合理。

## ④ 读者审

- D-5 明确依赖 D-1；满足。
- D-2 是 D-3/D-4 的前置；满足。
- D-4 需要 AST/Visitor 概念，正文通过 D-6 桥接；导读已明确建议先读 D-6 的概览再回看 D-4。
- D-7 依赖 D-1 的借出/归还上下文；推荐顺序已前置。
- D-9 依赖 D-1 的 `init()` 语义；满足。
- 未发现“前篇尚未建立却被后篇当作已知”的循环依赖。单篇中对 HikariCP 的对照属于跨卷前置背景，不是 Druid 内部回环。

## ⑤ 边界审

边界总体清晰：

- D-1/D-5 讲池本体与维护，不提前讲 SQL 扩展。
- D-2 讲 Filter 链骨架，不重讲 StatFilter/WallFilter。
- D-3/D-4 讲具体监控与安全，不重复实现 Parser 内部算法。
- D-6 讲共同架构地基，不展开 Lexer/Token/AST 生成细节。
- D-8 讲连接内 PS 复用，不重讲借出链。
- D-9 讲 Boot 装配桥，不重讲池内部实现。

规划中已列出的 9 个域全部有对应篇章。暂缓边界也已明确：更细方言差异、Web 控制台内部页面数据流、生产 SQL 监控实践。

方法论要求的“完整卷”补层方面：当前卷已覆盖主干层与集成层，监控/安全和机制补深层也有代表性内容；规范层、系统化生产排障层、控制台内部数据流仍未形成独立篇章，不能宣称全量完整卷，故 README 标注为阶段性收口。

## ⑥ 依赖审

- 依赖方向为池本体 → 维护/验证 → Filter/PS 扩展 → 监控/安全 → Parser 回看 → Boot 集成，无回环。
- D-6 虽然在推荐阅读中位于 D-3/D-4 之后，但它是概念回看地基，不影响源码调用方向；D-4 的前置说明已在导读中处理。
- 与 `vol-hikaricp` 不矛盾：两卷都把连接池理解为生命周期管理系统，但明确区分 HikariCP 的 `ConcurrentBag`/HouseKeeper 与 Druid 的固定数组、Lock/Condition/DestroyTask 模型。
- 两卷对验证的描述也已区分：HikariCP 以借出前可交付性为主，Druid 展开 `testOnBorrow`、`testWhileIdle`、`testOnReturn` 与 checker/query 配置。

## 修正记录

1. D-1 将错误的“类声明约第 3979 行”改为 `DruidDataSource.java:81`，并保留 3979 作为文件总行数。
2. D-7 修正 `testWhileIdle` 的实际触发位置和影响范围。
3. D-7 修正 `validationQueryCheck()` 的错误处理语义。
4. D-9 补充 `spring.datasource.type`、`@AutoConfigureBefore`、缺失 Bean 和 Web/属性条件，避免把自动装配归因于 `@ConditionalOnClass` 单一条件。
5. 卷级导航补充物理目录与推荐阅读顺序的区别，并将 D-7 放回骨架层阅读路径。

## 验证记录

- 正文锚点脚本检查：100 个引用，坏引用 0 个。
- Druid 源码计数：`sql/` Java 文件 1238 个，`sql/dialect/` 方言目录 29 个。
- 运行时/编译类 lint/typecheck：该文档目录无独立 lint/typecheck 配置；本次以锚点扫描、源码上下文复核和 Markdown 结构检查作为等价校验。