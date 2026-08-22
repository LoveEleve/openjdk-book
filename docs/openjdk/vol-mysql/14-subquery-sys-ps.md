# 子查询优化、sys Schema 与 Performance Schema：查询优化不是只看 B+Tree 和 EXPLAIN，子查询重写决定语义与可执行计划，sys/Performance Schema 决定你能否在线验证这些计划在运行时的真实成本

> 主题：MySQL｜第 14 篇
> 前置文章：`docs/openjdk/vol-mysql/13-optimizer-explain-slowlog.md`、`docs/openjdk/vol-mysql/06-fulltext-statistics-ddl.md`
> 本篇后续：`15-performance-schema-observability.md`
> 一句话困惑：慢 SQL 不一定只是缺索引，`IN`、相关子查询、派生表、锁等待和元数据争用可能一起把执行计划拖偏；怎样把“SQL 形态”和“运行期证据”接上？
> 一句话顿悟：优化器决定“怎么跑”，sys Schema 和 Performance Schema 决定“跑的时候发生了什么”；没有前者，你不知道为什么选这个计划，没有后者，你不知道这个计划在线上究竟慢在哪。
> 依赖分类：
> - 硬依赖：`13-optimizer-explain-slowlog.md` 已建立优化器、访问方法、EXPLAIN、ANALYZE 和慢日志的主线；本篇在这条主线之上，把子查询重写和运行期证据拼接起来。
> - 软依赖：`06-fulltext-statistics-ddl.md` 关于统计信息与对象定义的认识；`08-deadlock-mdl-optimization.md` 关于锁等待、元数据锁和阻塞链的背景。本文复用这些直觉，但不重复展开底层锁实现。
> - 导航依赖：本篇先建立子查询重写、sys Schema、information_schema 与 Performance Schema 的关系图，为 `15-performance-schema-observability.md` 铺路，后者再进入运行期事件采集、Top SQL、锁等待、文件 I/O 和展示面。
> 版本说明：本文讨论 MySQL 8.x 中常见的子查询重写、半连接、物化、派生表/CTE merge 或 materialize、sys Schema、information_schema、metadata_locks 与 Performance Schema 的稳定心智模型。具体 semijoin 策略、derived merge 开关、sys 视图定义、锁/事务视图位置、instrument 和 consumer 默认值会随 MySQL 版本、配置和负载模型变化。本文不把某一版中的重写规则、sys 视图列集合或 Performance Schema 默认配置写成跨版本契约，而把重点放在“SQL 形态如何被改写成执行计划，以及线上如何用观测视图验证这个计划的真实成本”。

## 现在真正该问的，不再是“这条 SQL 里有没有子查询”，而是“优化器会把它改写成什么，以及线上证据能否证明它真的慢在这里”

上一篇把慢查询诊断的总图搭好了：慢日志给症状，EXPLAIN 给假设，ANALYZE 给事实，系统观测给副作用。现在往前再追半步，你会发现很多 SQL 的问题不只是“有没有索引”，而是**它写成子查询、`IN`、相关子查询、派生表或 CTE 之后，优化器到底会不会重写、重写成什么、有没有物化、会不会把等待和 I/O 成本藏在计划外面**。

这也是很多排障现场真正让人卡住的地方：

“我明明只是写了一个 `WHERE x IN (SELECT ...)`，为什么它有时像 JOIN 一样快，有时却慢得像反复跑内层子查询？”

答案不在 SQL 的字面形态，而在优化器有没有把它改写成更可执行的形态；而第二层答案又在运行时：即便它被改写成看起来合理的计划，线上到底慢在行数估错、锁等待、元数据锁、临时表，还是文件 I/O？换句话说，很多等待和 I/O 代价并不会直接写在计划树的成本字段里，而是作为运行期副作用暴露出来。

先把总图记住：

```text
SQL 文本里有子查询/派生表/CTE
  → 优化器尝试重写
      IN → EXISTS / semijoin
      derived / CTE → merge or materialize
      correlated subquery → 能否去相关 / 变 join
  → 生成最终执行计划
  → EXPLAIN / ANALYZE 看计划与行数
  → sys Schema 看摘要视图
  → information_schema / metadata_locks 看对象与锁
  → Performance Schema 看线程、等待、I/O、阶段事件
```

这篇最该先记住的一句话是：**优化器决定“怎么跑”，sys Schema 和 Performance Schema 决定“跑的时候发生了什么”；没有前者，你不知道为什么选这个计划，没有后者，你不知道这个计划在线上究竟慢在哪。**

## 一、子查询优化：语法形态不是执行形态

### 1. 最朴素的错误世界：手工把子查询改成 JOIN，一定更快

“手工改成 JOIN 一定比子查询快”这个说法在经验口口相传里非常常见，因为很多人见过相关子查询反复执行、性能很差的例子。但这个经验最大的问题是：它把**SQL 的字面形态**误当成了**执行形态**。

优化器看到 `IN (SELECT ...)`、`EXISTS (...)`、相关子查询、派生表和 CTE 时，并不一定按你写的字面顺序执行。它可能：

- 把 `IN` 改写成 `EXISTS`；
- 把子查询变成 semijoin；
- 先 materialize 内层结果，再把结果当成一张临时表用；
- 把派生表或 CTE merge 回外层查询；
- 在语义允许时改写成 join、aggregation 或窗口计算的等价形态。

所以“手工改成 JOIN”不是天然更好，因为优化器可能早就替你这么做了；更糟的是，你的手工改写还可能改变重复值、NULL 语义、过滤位置和结果集大小。

### 2. 子查询候选策略：优化器到底在选什么

教学上可以先压成一条最小路线：

```text
子查询候选策略:
  IN           → EXISTS / semijoin 变换
  materialization
               → 先执行内层并缓存结果
  derived/CTE  → merge or materialize
  correlated subquery
               → 能否去相关，或保留原形逐次执行
  rewrite to join/aggregation/window
               → 仅在语义等价时成立

目标:
  减少重复执行
  利用索引和 join 顺序
  控制中间结果大小
```

这条路线最重要的不是记名词，而是记住三个目标：

- **减少重复执行**：别让外层每扫一行都把内层完整重跑；
- **利用索引和 join 顺序**：让原本被嵌在表达式里的关系暴露给优化器；
- **控制中间结果大小**：别为了消灭相关子查询而制造一张更大的临时结果。

所以“子查询优化”不是某一个技巧，而是一组在语义边界内争取更低预计成本的策略组合。源码上，`convert_subquery_to_semijoin()`（`sql/sql_resolver.cc:3003`）、`transform_subquery_to_derived()`（`sql/sql_resolver.cc:7239`）和 `merge_derived()`（`sql/sql_resolver.cc:3467`）把 semijoin、derived transform 和 merge 这些策略落到了真实实现里；它们也提醒你：优化器不是在“背 SQL 语法”，而是在不断试探哪些等价重写成立、哪些不成立。

### 3. 为什么“手工改成 JOIN”不一定更快：语义、重复值和 NULL 会反咬你

这是最容易说错的地方。你把：

```sql
SELECT *
FROM orders o
WHERE o.customer_id IN (
  SELECT c.id FROM customers c WHERE c.vip = 1
)
```

手工改写成：

```sql
SELECT o.*
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.vip = 1
```

很多时候结果看起来一样，但并不意味着所有子查询都能这么改。

- 如果内层会产生重复值，JOIN 可能把外层结果放大；
- 如果涉及 `NOT IN` 与 NULL，语义会很危险；
- 如果过滤位置改变，外层/内层的基数就可能改变；
- 如果原查询依赖去重、聚合或存在性判断，手工 JOIN 可能改变结果集合。

所以真正该问的不是“能不能改成 JOIN”，而是“优化器已经怎么改了，以及我手工改写会不会改变语义”。这里最好直接记一个最小反例：`EXISTS`/`IN` 常常表达的是“是否存在匹配项”，而 `JOIN` 表达的是“把匹配行展开出来”。如果内层 `customers` 表里同一个 `id` 因为联接视角或中间结果出现重复，`JOIN` 会把外层 `orders` 行放大，但 `EXISTS` 只关心“有没有”。再比如 `NOT IN (subquery)` 只要内层结果里混入 `NULL`，整个谓词的语义就会变得非常微妙；很多人把它手工改写成 `LEFT JOIN ... IS NULL` 后，以为自己只是换了写法，实际上已经在三值逻辑上换了题。

### 4. 一个更具体的失败场景：相关子查询没有被去相关，外层每一行都触发内层扫描

假设：

- 外层表 `orders` 有 50 万行；
- SQL 写成：
  `SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.status='OK')`；
- 如果 `payments(order_id, status)` 有合适索引，优化器可能把它变成 semijoin 或高效探测；
- 但如果相关条件复杂、表达式阻止重写，或者统计信息让物化/半连接不划算，优化器可能保留相关子查询形态；
- 结果就是：外层每扫一行，都要重新探测甚至重新扫描内层一部分数据。

这时慢的根因不是“写了 EXISTS”，而是**相关子查询没能被改成更便宜的执行形态**。你要通过 EXPLAIN 和 ANALYZE 看的是：它到底被重写了没有、内层是否反复执行、行数和 loops 有没有爆炸。对读计划的人来说，几个抓手尤其重要：

- 计划里如果还能看到 `dependent subquery`、明显的相关子查询节点，通常说明它没有完全去相关；
- `EXPLAIN ANALYZE` 里内层节点的 `actual loops` 异常大，往往意味着外层每一行都在重新触发内层探测；
- 如果出现 materialize/derived 节点，要继续看它是在帮你减少重复执行，还是制造了一张过大的中间结果；
- 如果内层 probe 次数很高而行数收益很低，通常说明重写失败、驱动方向不佳，或者相关条件没能有效利用索引。

源码上，`convert_subquery_to_semijoin()`（`sql/sql_resolver.cc:3003`）、`subquery_allows_materialization()`（`sql/sql_resolver.cc:989`）和 `finalize_materialization_transform()`（`sql/item_subselect.cc:422`）正是这类重写/物化决策的关键入口。

### 5. materialization 不是坏词：有时它恰恰是在救你

很多人一看到 materialize 就条件反射地觉得“糟了，临时表、变慢了”。但 materialization 的价值正在于：

- 把内层结果先算出来，避免外层每一行都反复执行内层；
- 让一个复杂子查询变成“先产生一个中间结果，再用这个结果继续 join”；
- 在内层结果集不大、可复用时，大幅降低重复成本。

当然它有代价：

- 要占内存或磁盘临时空间；
- 中间结果太大时，物化本身会成为瓶颈；
- 物化后未必还能保留原始索引优势。

所以 materialization 不是“好或坏”，而是“在减少重复执行与增加中间结果成本之间做取舍”。

### 6. 本节最该记住的结论：子查询的语法形态不等于执行形态；真正重要的是它有没有被重写成 semijoin、JOIN、merge 或 materialize，以及这些改写有没有改变语义和中间结果规模

一句最短人话是：**子查询像先问名单再筛人，也可能被改写成边走边比对的联查；表面写法不同，不代表后台一定按字面顺序执行。**

## 二、sys Schema：给 Performance Schema 和信息模式做“翻译”

### 1. 第二个朴素误解：sys Schema 是一套新的监控系统

很多人第一次接触 sys Schema，会以为它像某种“内建监控系统”，直接给你结论：最慢 SQL、最重锁等待、未用索引、热点表。这个直觉一半对，一半错。

对的地方在于：sys 视图确实更适合值班和诊断入口。错的地方在于：**它本质上不是新的采集系统，而是把底层 Performance Schema、information_schema 和系统元数据整理成更友好的诊断视图。**

所以如果底层没有采集、采集窗口太小、summary 表被清空、consumer 没打开，sys 也不会神奇地产生真相。源码层面也能直接看到这一点：`sys.statement_analysis` 这类视图本身就定义在 `scripts/sys_schema/views/p_s/statement_analysis.sql`，`sys.innodb_lock_waits` 则来自 `scripts/sys_schema/views/p_s/innodb_lock_waits.sql`。它们是基于底层表的 SQL 包装，不是新的采集引擎。

### 2. sys 视图到底在帮你做什么

可以先记住几个典型视图：

```text
statement_analysis
  → 归一化 SQL 的执行次数、总耗时、平均耗时、扫描行数等

innodb_lock_waits
  → 等待事务、阻塞事务、锁对象、等待时长

schema_unused_indexes / schema_redundant_indexes
  → 帮助发现未用或重叠索引
```

这些视图的价值不在“它们知道更多”，而在“它们把最常见的诊断任务压缩成了可直接读的入口”。

- 值班要看哪个 SQL 模板最烧时间，不想直接拼 P_S 摘要表；
- 排查锁等待时，想先知道“谁等谁”，而不是先读底层事件定义；
- 清理索引时，想先看未使用和冗余索引的候选，再决定是否下线。

sys 干的是“翻译”和“压缩”，不是“发明新事实”。

### 3. 为什么 sys Schema 不是万能答案

sys 最大的风险恰恰在于它太好用，容易让人忘记它是视图层：

- 底层 consumer 没开，sys 没数据；
- 采样窗口太短，sys 只展示“刚好看见的那一段”；
- 工作负载变化快，summary 结果可能把不同阶段混在一起；
- 某些视图按版本变化，列名和来源表不完全一致。

所以 sys 最适合做“从症状切进去”的第一步。你先用它找到可疑 SQL、锁等待或索引问题，再决定是否下钻到 Performance Schema 原表、EXPLAIN 或对象定义。这里还要明确一个观察边界：很多 sys 视图本质上是基于 P_S 摘要表再聚合或包装出来的，窗口被 reset、history 被覆盖、digest 摘要被刷新后，你看到的变化不是 sys 的 bug，而是摘要层本来就只保留那一段观测结果。

### 4. 一个更具体的失败场景：sys 里看不到最慢 SQL，不等于数据库没有慢 SQL

假设：

- 线上明显出现接口超时；
- 你去看 `sys.statement_analysis`，却没看到想象中的那条 SQL；
- 原因可能是 digest 摘要窗口刚被清空、对应 consumer 没启用，或者这条 SQL 在当前模板聚合里被参数差异稀释了。

这时如果你直接下结论“数据库没问题”，就会被 sys 的友好表象骗到。正确姿势是回到慢日志、P_S consumer 和时间窗口，先确认底层采集是否成立。

### 5. 本节最该记住的结论：sys Schema 是值班员面板，不是新的传感器系统；它适合做诊断入口，但不替代你理解底层采集、时间窗口和原始事件表

一句最短人话是：**sys Schema 像给复杂原始仪表盘做了一个值班员面板，把最常用的告警信息先整理出来，但背后仍是同一套传感器。**

## 三、information_schema 与锁/元数据视角：不是所有信息都来自同一层

### 1. 第三个朴素误解：information_schema 就是数据库的“实时状态总线”

这个误解非常常见，因为 information_schema 里什么都有：表、列、索引、约束、字符集，看起来像“数据库内部世界的总目录”。于是很多人自然会延伸出一个错觉：既然目录这么全，实时锁状态、事务状态和元数据阻塞应该也都从这里看。

问题在于：information_schema 的强项是**对象定义和逻辑结构**，不是高频运行期监控。

- `TABLES`、`COLUMNS`、`STATISTICS`、`KEY_COLUMN_USAGE` 这类视图更像对象定义册；
- 元数据锁、事务等待、InnoDB 内部状态在不同版本里可能来自不同层；
- 在 5.6/5.7 到 8.0 的演进里，部分锁/事务观测入口从 information_schema 逐步迁向 performance_schema 和 sys；
- 同一个“锁问题”，你可能需要同时看 metadata、事务、P_S 事件和 sys 视图。

所以不是“哪个系统表更全”，而是“这类问题该去哪一层找证据”。

### 2. 对象定义、锁和事务：三类信息分布在不同入口

先记住一个最小分层图：

```text
information_schema:
  TABLES / COLUMNS / STATISTICS / KEY_COLUMN_USAGE
  → 定义/结构类信息

锁/事务/元数据:
  metadata_locks / innodb_trx / lock waits 等
  → 具体来源和可用性随版本演进

用途:
  先确认对象定义/索引布局
  再定位元数据锁、事务等待和 DDL 阻塞
```

这张图最重要的作用是打断一个常见坏习惯：**别还没分清你在看“蓝图”还是“实时监控”，就开始解释故障。**

### 3. 为什么不能把 information_schema 当成实时状态总线

原因至少有三个：

- 很多视图本质上是逻辑元数据，不是为高频刷新和运行时事件分析设计的；
- 某些锁/事务视图在版本演进中从 information_schema 迁到 performance_schema 或 sys；
- 对象定义告诉你“这张表长什么样”，却不告诉你“此刻谁在等谁”。

所以排查 DDL 卡住、表无法修改、读写突然阻塞时，第一步经常不是再看一次 `SHOW CREATE TABLE`，而是去确认 metadata lock、事务持有者和等待链。换句话说：对象定义告诉你“门长什么样”，但真正要解释“为什么现在过不去”，还得去看谁把门堵住了。

### 4. 一个更具体的失败场景：你盯着索引定义看半天，真正卡住业务的是 metadata lock

假设：

- 业务执行一个简单查询，本来应该几十毫秒；
- 你先去看 `STATISTICS`、`KEY_COLUMN_USAGE`，确认索引都在；
- 但接口还是卡住；
- 真正的问题是另一个会话执行了 DDL，拿住了 metadata lock，后续访问都在等它释放。

这时对象定义一点没错，索引也没问题，问题是“对象此刻被谁挡住了”。如果只盯 information_schema 里的定义视图，你永远看不到这层实时阻塞关系。

### 5. 本节最该记住的结论：information_schema 更像建筑蓝图和产权册，适合确认对象定义；元数据锁、事务等待和阻塞链要到 metadata_locks、sys 或 Performance Schema 去看，不能用蓝图替代实时摄像头

一句最短人话是：**information_schema 像建筑蓝图和产权册，Performance Schema 更像实时监控大屏；两者都重要，但不能用蓝图替代摄像头。**

## 四、Performance Schema：运行时观测模型，而不是“又一堆系统表”

### 1. 第四个朴素误解：Performance Schema 就是又一堆难记的系统表

这是很多人第一次接触 P_S 时最真实的感受：表很多，名字长，`events_*`、`summary_*`、`setup_*`、`threads`、`waits`、`stages` 到处都是，看起来像“知道它存在，但不知道它为什么重要”。

真正的理解入口不是记表名，而是先记住它的采集模型：**instrument 决定能观测什么，consumer 决定保留到哪里，event tables 决定你以什么粒度读取这些数据。** 对应到真实入口，大致就是 `setup_instruments` 管“装哪些传感器”，`setup_consumers` 管“把事件送到 current/history/summary 哪些桶里”，`threads` 管“这些事件属于哪个线程/会话”，而 `events_statements_*`、`events_waits_*`、`events_stages_*` 则分别承载语句、等待和阶段事件。

### 2. P_S 的最小心智图：传感器、开关和事件表

```text
instrument:
  定义可观测点(等待、阶段、语句、文件、socket、mutex...)

consumer:
  控制采集到 current / history / summary 等表

event tables:
  current / history / summary by digest / thread / event name ...

threads:
  连接到线程、会话和采集上下文
```

一旦有了这张图，很多现象就不神秘了：

- 看不到数据，先想是不是 instrument 没开；
- 只有当前事件，没有历史，先想是不是相应 consumer 没开；
- digest 有汇总但没有具体线程细节，说明你看到的是 summary 层，不是 current/history 层。

### 3. 为什么开了 Performance Schema 还可能“什么都看不到”

因为“开了 P_S”不等于“你想看的那类事件已经在采”。至少有三个常见坑：

- 对应 instrument 没启用，根本没有原始事件；
- consumer 没启用，只保留当前事件或根本不保留历史；
- 事件发生得太快，current 已经被覆盖，history 窗口又不够长。

所以 P_S 不会自动成为“全知数据库黑盒记录仪”。它是可配置的观测框架，不是无条件全量抓包器。源码上，`initialize_performance_schema()`（`storage/perfschema/pfs_server.cc:93`）负责初始化整套 P_S，`insert_events_statements_history()`（`storage/perfschema/pfs_events_statements.cc:191`）和 `insert_events_statements_history_long()`（`storage/perfschema/pfs_events_statements.cc:223`）则直接体现了 statement 事件是如何进入 history/history_long 这类保留桶的。

### 4. 为什么开太多又会带来成本

另一端的误区是：“既然要排障，那就全开。”

这同样危险，因为：

- 更多 instrument 意味着更多事件采集；
- 更多 consumer 意味着更多内存和写入路径上的额外工作；
- 对高频 waits、stages、statements 全量保留历史，会增加运行时成本和观测噪音。

所以 P_S 的正确姿势不是“永远全开”，而是**带着目标打开**：你是要看 Top SQL、锁等待、文件 I/O，还是线程阶段？不同问题，开启粒度不同。

### 5. 一个更具体的失败场景：你知道 SQL 慢，但不知道慢在锁、I/O 还是线程阶段

假设：

- 慢日志已经告诉你这条 SQL 很慢；
- EXPLAIN 看起来也不离谱；
- 但线上依然偶发秒级抖动；
- 这时真正缺的不是更多 SQL 文本，而是等待与线程事件：它是不是在等锁、等磁盘、等临时文件，还是卡在某个阶段。

这就是为什么最终都绕不开 Performance Schema。它不是告诉你“应该怎么改 SQL”的老师，而是给你运行期事件证据的取证系统。

### 6. 本节最该记住的结论：Performance Schema 不是一堆系统表，而是一套运行期传感器框架；`setup_instruments` 决定采什么，`setup_consumers` 决定留多久，event tables 决定你以什么粒度读取真相

一句最短人话是：**Performance Schema 像一套可配置传感器系统：传感器没装就没有数据，装满全楼又会增加管理成本；应先决定想看哪类故障。**

## 五、把本篇收成一张图：从 SQL 结构到运行期证据链

现在可以把整篇彻底收回来。

一开始我们要解决的问题是：慢 SQL 不一定只是缺索引，子查询、锁等待和元数据争用可能一起把执行计划拖偏，怎样把“SQL 形态”和“运行期证据”接上。答案已经闭环了。

子查询的语法形态不等于执行形态。优化器可能把 `IN`、`EXISTS`、相关子查询、派生表和 CTE 重写成 semijoin、JOIN、merge 或 materialize。EXPLAIN 和 ANALYZE 告诉你它被改写成了什么。sys Schema 把底层摘要翻译成值班员面板。information_schema 负责对象定义，metadata_locks、sys 和 Performance Schema 才负责实时等待与阻塞证据。Performance Schema 则把线程、等待、I/O 和阶段事件统一纳入可配置采集框架。

把这一切压成最短总图，就是：

```text
慢 SQL/异常模板
  → 看子查询/CTE/派生表是否被重写或物化
  → EXPLAIN/ANALYZE 验证计划与行数
  → sys Schema 找高耗时/高锁等待模板
  → information_schema / metadata_locks 看对象与锁
  → Performance Schema 下钻线程、等待、I/O、阶段
```

所以本篇最该记住的一句话是：**优化器决定“怎么跑”，sys Schema 和 Performance Schema 决定“跑的时候发生了什么”；没有前者，你不知道为什么选这个计划，没有后者，你不知道这个计划在线上究竟慢在哪。**

## 六、几个最容易说错的地方

### 手工把子查询改成 JOIN，一定更快？

不是。优化器可能已经做了等价重写；你的手工改写还可能改变重复值、NULL 语义、过滤位置和结果规模。

### materialization 一出现就说明计划变差？

不是。物化有时正是为了避免相关子查询被反复执行。它的代价在中间结果大小和临时空间，不在“这个词本身不好”。

### sys Schema 是新的监控系统？

不是。它是底层 P_S、information_schema 和系统元数据的友好视图层，采集没开或窗口不对，它也不会自动变真。

### information_schema 能看所有实时状态？

不是。它更适合对象定义和逻辑结构。元数据锁、事务等待和阻塞链要到 metadata_locks、sys 或 P_S 去看。

### 开了 Performance Schema 就一定什么都能看到？

不是。instrument、consumer、history 窗口和汇总粒度都决定你能看到什么；开太多还会增加成本。

## 收束：查询优化不是只看“SQL 怎么写”，还要看“它在线上被改写成什么、慢在执行链的哪一层”

回到开头那个问题：怎样把“SQL 形态”和“运行期证据”接上。答案已经闭环了：先承认子查询的语法形态不等于执行形态，再用 EXPLAIN/ANALYZE 看优化器把它改写成了什么；然后用 sys Schema、information_schema、metadata_locks 和 Performance Schema 把对象定义、阻塞关系、线程等待和 I/O 事件拼进同一条证据链。

这就是为什么说：**优化器决定“怎么跑”，sys Schema 和 Performance Schema 决定“跑的时候发生了什么”；没有前者，你不知道为什么选这个计划，没有后者，你不知道这个计划在线上究竟慢在哪。** 只要这条主线站稳，后面进入 Performance Schema 的观测深化时，你就不会再把“计划慢”和“运行时慢”混成一个黑盒，而会始终把“重写结果、等待事件、时间窗口和采集粒度”四条线一起看。

## 下一篇桥接

现在最自然的问题已经从“怎么把 SQL 结构和运行期证据接上”推进到了“怎么把这些运行期证据系统化地采、留、看、报”：**真正线上最常用的 Top SQL、锁等待、文件 I/O、Digest 汇总要怎么系统化采集与展示，哪些 consumer 要开，哪些 summary 值得长期保留？**

下一篇 `15-performance-schema-observability.md` 会把视角推进到 Performance Schema、慢日志与监控可观测性深化：语句摘要、锁等待、文件 I/O、线程事件、采集粒度、保留窗口，以及这些观测数据如何进入稳定的诊断面板。