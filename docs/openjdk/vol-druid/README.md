# 卷 Druid · 连接池与 JDBC 扩展源码分析

> 本卷基于 Druid 1.2.27，目标不是按包翻译源码，而是建立一条从连接池本体、后台维护、Filter 扩展、SQL 解析，到 Spring Boot 装配的机制主线。

## 当前卷级状态

- 9 个机制域正文已完成
- 卷级六层审查已完成，并修正正文中的源码事实表述
- 已完成卷级入口、导读、总图与审查笔记
- 当前属于阶段性收口，不等同于覆盖 Druid 全部生产专题

## 篇章目录

### A. 连接池骨架层

- [D-1 连接池核心](ch1-datasource/01-druid-datasource-core.md)：固定数组、Lock + Condition、初始化与借出协议
- [D-5 维护体系](ch2-maintenance/01-shrink-maintenance-system.md)：`shrink()`、DestroyTask、CreateConnectionTask、removeAbandoned
- [D-7 连接验证](ch7-validation/01-connection-validation.md)：借出、空闲、归还阶段的验证策略与厂商 SPI

### B. Filter / 扩展层

- [D-2 Filter 链](ch3-filter/01-filter-chain.md)：递归链、链对象复用与连接关闭路径
- [D-8 PreparedStatementPool](ch8-pspool/01-prepared-statement-pool.md)：per-connection 的 LRU PreparedStatement 缓存

### C. 监控与安全层

- [D-3 StatFilter](ch4-statfilter/01-statfilter-sql-monitoring.md)：执行钩子、参数化、慢 SQL 与分层统计
- [D-4 WallFilter](ch6-wallfilter/01-wallfilter-sql-firewall.md)：AST 解析、Visitor 遍历与方言安全规则

### D. 解析器地基层

- [D-6 SQL Parser](ch5-sql-parser/01-sql-parser-architecture.md)：Lexer、Parser、AST、Visitor 与 dialect 的共同地基

### E. 集成层

- [D-9 Spring Boot 3 Starter](ch9-boot-starter/01-boot-3-starter.md)：自动装配、属性绑定、池初始化与 Web 统计注册

## 推荐阅读顺序

按规划层级阅读：`D-1 → D-5 → D-7 → D-2 → D-8 → D-3 → D-4 → D-6 → D-9`。

物理目录保持原有写作顺序，便于稳定链接；推荐顺序将 D-7 前置到 Filter 之前，因为它属于连接池骨架，而不是监控/安全层。详见 [卷前导读](00-guide-how-to-read-this-volume.md)。

## 与 HikariCP 的关系

`vol-hikaricp` 建立连接生命史、借还和后台维护的参照系；本卷不复用其实现结论，而是重点解释 Druid 的固定数组、Lock + Condition、Filter 链、SQL 解析器与 Boot 装配桥。

## 尚未覆盖的边界

更细的方言解析器差异、Web 控制台内部页面数据流，以及生产环境 SQL 监控实践暂不纳入本阶段主线。