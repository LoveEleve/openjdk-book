# Performance Schema 与锁监控：慢日志只能告诉你哪条 SQL 慢，Performance Schema 才把 SQL、线程、锁、I/O、复制这些运行事件放进同一观测平面

> 主题：MySQL｜第 15 篇
> 前置文章：`docs/openjdk/vol-mysql/14-subquery-sys-ps.md`、`docs/openjdk/vol-mysql/13-optimizer-explain-slowlog.md`
> 本篇后续：`16-connection-pool-proxysql.md`
> 一句话困惑：慢日志告诉你哪条 SQL 慢，但运行时到底慢在锁、I/O、临时表、线程阶段还是复制落后，去哪里看？
> 一句话顿悟：Performance Schema 不是“更多系统表”，而是可配置的事件采集框架；监控也不是把所有 instrument 全开，而是只保留对当前故障和容量最有价值的事件层。
> 依赖分类：
> - 硬依赖：`13-optimizer-explain-slowlog.md` 已建立 EXPLAIN、慢日志、digest 与症状入口；`14-subquery-sys-ps.md` 已建立 sys Schema / Performance Schema 的桥接心智。本文在这条桥上继续向“持续监控”和“锁等待取证”推进。
> - 软依赖：`08-deadlock-mdl-optimization.md` 关于锁等待、死锁与元数据锁的背景；`09-replication-binlog-gtid.md` 关于复制线程和延迟的基本认知。本文会复用这些直觉，但不重复展开所有底层协议。
> - 导航依赖：本篇先把 Performance Schema 的采集模型、digest/threads/复制视图、`data_locks`/`data_lock_waits` 与 Exporter/Prometheus/Grafana 串起来，为 `16-connection-pool-proxysql.md` 铺路，后者再进入连接池、中间件和数据库外部并发整形。
> 版本说明：本文讨论 MySQL 8.x 常见的 Performance Schema、statement digest、threads、复制视图、`data_locks`、`data_lock_waits`、死锁日志、Exporter/Prometheus/Grafana 和监控策略的稳定心智模型。具体 instrument/consumer 默认项、复制视图字段、`data_locks` 可见范围、Exporter collector 选项和 Grafana 看板内容会随 MySQL 版本、实例负载和部署环境变化。本文不把某一版中的全部系统表、默认 consumer 或监控模板写成跨版本契约，而把重点放在“运行时到底慢在什么，以及如何把数据库内部视图变成可持续观测”。

## 现在真正该问的，不再是“哪条 SQL 慢”，而是“它运行时到底慢在什么，以及我怎样持续看见这种变慢”

前两篇已经把问题推进到一个很关键的边界：

- 慢日志告诉你哪条 SQL 慢；
- EXPLAIN/ANALYZE 告诉你优化器打算怎么跑、实际怎么跑；
- sys Schema 帮你把底层摘要翻译成更友好的入口；
- Performance Schema 负责把运行时线程、等待、I/O 和阶段事件变成可采集的观测平面。

但真正线上排障时，读者接下来通常会问另一个更现实的问题：

“我已经知道这条 SQL 慢了，可它到底是慢在锁、I/O、临时表、线程阶段，还是复制线程落后？而且我总不能每次出事都临时手工查几十张系统表吧？”

这就是本篇要处理的主线：**把一次性排障视角，推进成持续可观测视角。**

先把总图记住：

```text
慢日志 / 告警 / 用户抱怨
  → Performance Schema 采集模型
      instrument / consumer / event tables
  → digest / threads / replication 视图
  → data_locks / data_lock_waits / deadlock
  → Exporter 把内部视图导出为 metrics
  → Prometheus 存时序 / 告警
  → Grafana 看趋势 / 对比 / 相关性
```

这篇最该先记住的一句话是：**Performance Schema 的价值不在于“它记录了很多表”，而在于它把 SQL、线程、锁、I/O、复制这些运行事件放进同一观测平面；sys 和监控平台只是这张平面的翻译层。**

## 一、Performance Schema：不是日志，而是可配置事件工厂

### 1. 最朴素的错误世界：开了 Performance Schema，它就会像黑盒录像机一样把一切记下来

这是一个非常自然的误解。很多人听到“Performance Schema”，就把它想成：数据库自带一套观察系统，只要开了就会自动、完整、持续地把所有运行时事件留下来，像飞机黑盒一样随时可回放。

问题是，P_S 根本不是这么设计的。它更像一间可配置的事件工厂：

- 哪些事件值得采，由 instrument 决定；
- 采到的事件留不留、留在哪个桶里，由 consumer 决定；
- 你最终从 current、history、history_long 还是 summary 读取，由事件表层次决定。

所以“开了 P_S 却没数据”并不神秘，“开了太多导致成本上升”也不神秘。这不是黑盒录像机，而是**可配置采集平面**。

### 2. instrument、consumer 与 event tables：三个层次决定“采什么、留多久、怎么看”

教学上可以先压成一张最小图：

```text
instrument:
  具体可观测点
  例如语句、等待、锁、文件、socket、stage、transaction

consumer:
  是否把事件写入 current/history/history_long/summary 等表

event tables:
  current  → 当前事件
  history  → 每线程最近事件
  summary  → 按 digest/thread/object 聚合
```

这三层里，最容易被忽视的是 consumer。很多人只记得 instrument，忘了没有相应 consumer，即使事件被观察到了，也未必会落到你想查的表里。

换句话说：

- instrument 决定“这个世界里有没有摄像头”；
- consumer 决定“摄像头画面是只看直播，还是保存回放”；
- event tables 决定“你现在是在看单个片段，还是看剪好的汇总报表”。

### 3. 为什么 Performance Schema 不是“默认永远正确完整的黑盒录像机”

至少有四个原因：

- 没开的 instrument 不会产生数据；
- 没开的 consumer 会让事件不落地，或只留当前不留历史；
- history/history_long 窗口有限，旧事件会被覆盖；
- summary 会把原始事件聚合，方便读，但会抹平部分上下文。

这就解释了为什么两个实例同样执行了很多 SQL，一个 `events_statements_summary_by_digest` 很丰富，另一个却近乎空白：不是 SQL 不存在，而是采集配置、保留桶和时间窗口不同。

### 4. 一个更具体的失败场景：实例明明很慢，`events_statements_summary_by_digest` 却几乎空白

假设：

- 线上有明显接口超时；
- 你去查 digest 汇总，结果几乎没数据；
- 原因可能不是“数据库没跑这些 SQL”，而是 statement 相关 instrument 没开、与 statement digest 相关的 summary consumer 没开，或者摘要表本身被 reset/清空了；
- history/history_long 窗口太短会影响你回看单条语句现场，但它不是 `events_statements_summary_by_digest` 近乎空白的直接原因。

这时如果你直接下结论“P_S 没价值”，其实误判的是观测配置和摘要口径，而不是数据库行为。

### 5. 为什么“全开最安全”同样是错误思路

另一端也很危险：既然没开就看不到，那是不是全部 instrument、全部 consumer、全部 history/history_long 都开起来最稳？

这仍然是错的，因为：

- 更多 instrument 意味着更多采集点；
- 更多 consumer 意味着更多数据写入、内存占用和聚合路径；
- 对高频 waits、stages、statements 全量留历史，开销和噪音都会上升；
- 你最后可能拥有一堆没人看得过来的表，却仍然没有更快定位故障。

所以 P_S 的目标不是“记录一切”，而是“以可接受成本留下最有价值的事件”。

### 6. 本节最该记住的结论：Performance Schema 不是日志，不是黑盒，而是一个可配置事件工厂；instrument 决定采什么，consumer 决定留多久，event tables 决定你以什么粒度读取这些事件

一句最短人话是：**Performance Schema 像一套可配置摄像头和计数器：摄像头没装就没有画面，装满全楼又会增加存储和管理成本。**

## 二、digest、threads 与复制视图：运行期对象怎样被聚合成可读状态

### 1. 第二个朴素误解：监控应该记录每一条原始 SQL，而不是 digest 模板

这个直觉来自“越原始越真实”的本能：既然排障要精确，为什么不把每条 SQL 原文都记下来？

问题在于，线上高并发实例的原始 SQL 基数太高：

- 同一模板可能每秒执行几千次，只是参数不同；
- 原文逐条保留会迅速膨胀；
- 你真正先想知道的，不是“第 384923 条 SQL 长什么样”，而是“哪一类模板累计最烧时间”。

这就是 digest 的意义：它把高基数原始语句归一化成模板，再做 count、总耗时、扫描行数、临时表、排序等统计。

### 2. digest、threads 与复制表：三个维度分别回答什么问题

```text
statement digest:
  SQL 归一化
  → DIGEST / DIGEST_TEXT
  → 统计 count、total time、rows、tmp table、sort 等

threads:
  连接线程/后台线程的运行时身份
  → 线程属性、当前事件、等待链路

replication tables:
  连接/applier/worker 维度状态
  → 复制线程、错误、延迟、队列、位点/GTID相关观测
```

这三个维度分别回答三类不同问题：

- digest 回答“哪类 SQL 模板最值得优先看”；
- threads 回答“是谁在执行、是谁在等、当前挂在哪个线程上下文里”；
- 复制相关运行时视图回答“慢是不是和 channel、coordinator、applier worker 或复制落后状态有关”。

源码上，`initialize_performance_schema()`（`storage/perfschema/pfs_server.cc:93`）负责初始化整套 P_S，`insert_events_statements_history()`（`storage/perfschema/pfs_events_statements.cc:191`）和 `insert_events_statements_history_long()`（`storage/perfschema/pfs_events_statements.cc:223`）体现了语句事件进入 history/history_long 的路径；而 `table_events_statements_history.create()`（`storage/perfschema/table_events_statements.cc:815`）和 `table_events_statements_history_long.create()`（`storage/perfschema/table_events_statements.cc:975`）则把这些事件暴露为可查询表。

把这三者连起来，你就能从“一个慢模板”一路追到“是哪类线程、哪类等待、哪类复制状态让它变慢”。

### 3. 为什么 digest 不能替代慢日志原文

digest 擅长发现“高总耗时模板”，但它天然有两个局限：

- 它把参数归一化了，个别极端慢请求的上下文会被抹平；
- 它更适合看总体热点，不擅长保留某一次具体故障的完整 SQL 现场。

所以 digest 和慢日志不是替代关系，而是配合关系：

- digest 告诉你“这一类请求整体有问题”；
- 慢日志或 tracing 告诉你“这一次具体是怎么慢的”。

### 4. 为什么复制视图不能单独证明主从完全一致

复制相关运行时视图很容易被误用。为了帮助理解，你可以先借用传统“接收线程/应用线程”心智，但在 MySQL 8.x 真正落地排障时，更应该看 channel、coordinator、applier worker 这些视图维度，而不是只停在旧式 `I/O thread` / `SQL thread` 口语上。否则很容易把旧术语和新视图混在一起。

但这些复制视图给你的仍然只是**实例观测窗口**：

- 它告诉你 channel、coordinator、worker 是否活着、当前报错、当前位置、延迟和 worker 状态；
- 它不能单独证明业务上没有延迟窗口；
- 更不能单独证明两边数据已经完全一致。

例如 `table_replication_applier_status_by_worker`（`storage/perfschema/table_replication_applier_status_by_worker.cc:219`）这类表，展示的是 worker 维度的复制运行时状态，而不是“业务数据已经一致”的证明书。所以复制视图适合用来回答“复制此刻卡在哪”，不适合被当成“数据永远没问题”的终极证明。

### 5. 一个更具体的失败场景：digest 看起来正常，真正拖慢请求的是后台复制线程争用 I/O

假设：

- digest 显示热点 SQL 模板的平均耗时不高；
- 但业务偶发抖动，P99 拉长；
- 继续看 threads 和复制相关视图，发现某段时间 applier/worker 正在追大量 relay log，I/O 与 Buffer Pool 刷脏压力一起抬升；
- 这时 SQL 模板本身没变，慢的是它所处的运行环境。

如果只盯 digest，总会以为“SQL 自己出问题了”；只有把线程、复制和资源事件并起来看，才知道它是被背景负载拖慢的。

### 6. 本节最该记住的结论：digest 负责把高基数 SQL 压缩成可比较模板，threads 负责把事件挂回执行实体，复制视图负责把后台同步状态暴露出来；三者合在一起，才像一张可用的运行期状态图

一句最短人话是：**digest 像把十万张相似订单归成模板统计总耗时，threads 像查是哪位操作员在处理，复制视图像看运输队是不是堵在路上。**

## 三、锁监控：`data_locks` 与 `data_lock_waits` 把等待图显式化

### 1. 第三个朴素误解：`SHOW PROCESSLIST` 里写着 `Waiting for ...`，就已经足够定位锁问题

这几乎是所有人排锁问题的第一反应：先看 `SHOW PROCESSLIST`，如果状态里写着 `Waiting for ...`，感觉已经知道答案了。

但这类状态字符串只能告诉你“它在等”，却回答不了真正关键的问题：

- 它到底在等什么对象；
- 谁持有了那个对象；
- 这是行锁、间隙锁、next-key lock 还是别的锁；
- 是谁阻塞了谁，阻塞链有多长；
- 当前只是长等待，还是已经形成死锁环。

所以 `SHOW PROCESSLIST` 更像“排队大厅公告屏”，而不是锁取证工具。

### 2. `data_locks` 与 `data_lock_waits`：两张表分别承担什么角色

```text
data_locks:
  当前持有/申请中的锁对象
  → engine / object / lock_type / lock_mode / lock_data 等

data_lock_waits:
  请求者锁ID ↔ 阻塞者锁ID 关系
  → 可拼成等待链/阻塞图

SHOW ENGINE INNODB STATUS:
  补充 deadlock、semaphores、事务上下文
```

这里要先钉死一个边界：`data_locks` 和 `data_lock_waits` 给你的首先是**当前快照**，不是天然带时间轴的历史录像。你适合用它们回答“现在谁堵了谁”，不适合单靠它们回答“过去半小时锁热点怎么演化”。如果要看趋势，还得借助持续采样、摘要聚合或外部监控时间序列。

这三者的关系可以这样理解：

- `data_locks` 告诉你“停车场里当前有哪些车位被占着”；
- `data_lock_waits` 告诉你“哪辆车在等哪辆车挪”；
- `SHOW ENGINE INNODB STATUS` 告诉你“最近那次互相堵死的事故报告长什么样”。

所以锁诊断最怕的不是表不够多，而是把三者看成了同一种信息。源码上，`initialize_performance_schema()`（`storage/perfschema/pfs_server.cc:93`）初始化时就包含了 data lock bootstrap，而 `performance_schema.data_locks` / `performance_schema.data_lock_waits` 这组视图的意义，正是把“锁对象”和“等待关系”拆成两层，不再只靠状态字符串猜。

### 3. 为什么只看 `LATEST DETECTED DEADLOCK` 不够

很多人喜欢直接盯 `SHOW ENGINE INNODB STATUS` 里的 `LATEST DETECTED DEADLOCK`，因为这里最戏剧化：你能看到事务 A 等事务 B，B 又等 A，数据库回滚了谁。

但它至少有三个边界：

- 它只记录最近一次被检测出的死锁，不记录所有普通长等待；
- 它不能覆盖所有 metadata lock、内部锁热点或历史趋势；
- 它是事故报告，不是持续时间序列。

所以“没有 deadlock 日志”绝不等于“没有锁问题”；大量慢请求可能只是长等待，不一定形成环。

### 4. 一个更具体的失败场景：没有死锁，业务照样被锁等待拖到秒级

假设：

- 一个长事务持有某行记录锁很久；
- 后续一串更新都在等这把锁；
- 等待链很长，但因为没有形成环，所以根本不会触发死锁检测和回滚；
- `SHOW ENGINE INNODB STATUS` 没有“精彩事故”，业务却已经出现秒级抖动。

这时真正有价值的不是再刷一次 deadlock 段落，而是把 `data_locks`、`data_lock_waits`、threads 和当前 SQL 一起拼出阻塞图。

### 5. 本节最该记住的结论：锁问题不是“有没有死锁”这么简单；`data_locks` 负责暴露锁对象，`data_lock_waits` 负责暴露等待关系，死锁日志只补充最近一次事故上下文

一句最短人话是：**`data_locks` 像停车场车位表，`data_lock_waits` 像挪车等待关系，死锁日志只是最近一次两车互堵的事故报告。**

## 四、Exporter、Prometheus 与 Grafana：把数据库内部视图变成外部时间序列

### 1. 第四个朴素误解：既然 P_S 里什么都有，直接手工查就够了，不需要外部监控

这个想法在“排一次障”时很容易出现：既然已经能从 P_S、sys、`SHOW ENGINE INNODB STATUS` 里查出东西，那是不是只要出事时手工查一下就够了？

问题在于，线上问题往往不是静止的：

- 峰值只出现几十秒；
- 某些等待在你连上库之前已经消失；
- 你要看的不是某一瞬间，而是过去 1 小时、1 天、1 周的趋势和相关性。

所以数据库内部视图必须进一步变成外部时间序列，才能承担“持续观测”和“回看趋势”的职责。

### 2. Exporter → Prometheus → Grafana：三层各自做什么

```text
mysqld exporter / agent
  → 周期性查询 status / P_S / replication / InnoDB 视图
  → 输出 metrics endpoint

Prometheus
  → scrape
  → 存储时序/规则/告警

Grafana
  → 仪表板
  → QPS/TPS/延迟/锁等待/Buffer Pool/Redo/复制延迟/连接数
```

这三层最容易被混淆：

- Exporter 负责“把库里的状态翻译成指标”；
- Prometheus 负责“定时采、保存、算规则和触发告警”；
- Grafana 负责“把时序画成能看懂的大屏”。

它们不是同一个东西的三个名字，而是一条持续观测流水线。

### 3. 为什么 Exporter 指标不能等同于 SQL 诊断真相

监控平台上的图很好看，但它们也有边界：

- 采样周期会错过瞬时尖峰；
- 聚合会抹平个别极端慢事务；
- collector 可能因权限、查询成本或配置不完整而漏数；
- 高基数标签如果设计不好，反而会拖垮监控系统。

所以 Grafana 适合看趋势、相关性和告警，不适合替代 EXPLAIN、慢日志和现场取证。

### 4. 一个更具体的失败场景：Grafana 上一切都很平，用户却说刚才接口卡了 20 秒

假设：

- Prometheus 每 15 秒抓一次；
- 某次锁等待尖峰只持续 5 秒；
- Grafana 图上均值几乎看不出来；
- 但那 5 秒足够把一批请求拖到超时。

这时如果你只看图，会以为“监控没问题，业务夸张了”。真实情况是：采样周期和聚合方式把尖峰抹平了；即便把 scrape interval 再缩短，也仍会受 exporter 查询成本、collector 粒度和指标聚合方式影响。监控图告诉你趋势，不能代替更细粒度的运行期证据。

### 5. 本节最该记住的结论：Exporter/Prometheus/Grafana 把数据库内部状态变成可持续回看的时间序列，但它们更适合趋势和相关性，不替代 SQL 计划、慢日志和锁取证

一句最短人话是：**Exporter 像把数据库里的多个仪表读数抄到监控平台，Grafana 是总控室大屏；大屏适合看趋势，不适合替代现场取证。**

## 五、监控策略：不是“全开”，而是围绕故障模型选九类指标

### 1. 第五个朴素误解：监控系统当然是越全越安全

“全量采集最安全”听起来几乎无可反驳：数据越全，出了事越容易回放。可惜监控本身也是有成本的，尤其数据库监控更是如此。

- 观测会消耗 CPU、内存和表空间；
- 高基数字段会拖垮监控系统；
- 太多 collector 和太细粒度 history 会制造海量噪音；
- 真出故障时，你反而淹没在一堆没法快速判断的图表里。

所以好的监控设计不是“最全”，而是“最能缩短定位时间”。

### 2. 长期保留什么，按需打开什么

```text
长期保留(低成本/高价值):
  QPS/TPS/错误率/P95-P99
  连接数/活跃线程
  Buffer Pool 命中/脏页/Redo 速率
  复制健康/延迟
  锁等待聚合/死锁计数

按需打开(高成本/细粒度):
  wait/stage/file/socket 细表
  大量 history/history_long
  更高频或更高基数的 statement 明细观测

原则:
  为故障模型服务
  为容量规划服务
  为回归验证服务
```

这里最关键的不是记住列表，而是理解“长期保留”和“按需打开”背后的逻辑：

- 长期保留的是低成本、高价值、和容量/健康强相关的指标；digest 摘要在很多生产环境里恰恰属于这一类长期保留入口；
- 按需打开的是更细粒度、高成本、只在取证时才需要的事件层。

### 3. 为什么监控设计必须围绕故障模型，而不是围绕工具菜单

一个实例真正会坏什么，决定你应该长期看什么：

- 如果你最常见的问题是慢查询尖峰，就重点保留延迟分位、digest 汇总和锁等待聚合；
- 如果你最常见的问题是复制落后，就重点保留 worker/applier/relay 相关状态；
- 如果你最常见的问题是 I/O 抖动，就重点保留 Buffer Pool、redo、刷脏、文件 I/O 相关指标。

所以监控指标不是“工具菜单里能勾什么就都勾上”，而是围绕故障模型反推。

### 4. 一个更具体的失败场景：全开 collector，真正出事时反而没人知道先看哪张图

假设：

- 团队几乎把 exporter 能采的都采了；
- Grafana 有几十个 dashboard，上百个 panel；
- 真出故障时，大家每人盯一张图，却没人能先回答“这更像锁、I/O、复制还是连接问题”。

这时问题不是“监控不够”，而是“监控没有围绕故障模型组织”。数据很多，不等于定位更快。

### 5. 本节最该记住的结论：监控设计不是把所有 instrument 和 collector 全开，而是用可接受成本长期保留最关键的健康指标，并在需要时临时打开更细粒度的事件层做取证

一句最短人话是：**好的监控不是把整座楼装满摄像头，而是先知道最容易失火的是哪几层，再决定哪里长期布控、哪里按需加密。**

## 六、把本篇收成一张图：从一次性排障到持续可观测

现在可以把整篇彻底收回来。

一开始我们要解决的问题是：慢日志只能告诉你哪条 SQL 慢，但运行时到底慢在锁、I/O、临时表、线程阶段还是复制落后，而且怎样把这些信息持续看见。答案已经闭环了。

Performance Schema 不是黑盒录像机，而是可配置事件工厂。instrument、consumer 和 event tables 共同决定“采什么、留多久、怎么看”。digest 把高基数 SQL 压成模板，threads 把事件挂回执行实体，复制视图把后台同步状态露出来。`data_locks` 和 `data_lock_waits` 把锁对象与等待关系显式化，死锁日志只补最近一次事故上下文。Exporter、Prometheus 和 Grafana 再把这些数据库内部视图变成可持续回看的时间序列。最后，真正好的监控设计不是“全开”，而是围绕故障模型长期保留低成本高价值指标，并在需要时打开更细粒度事件层。

把这一切压成最短总图，就是：

```text
慢日志/告警
  → Performance Schema digest / threads / replication
  → data_locks / data_lock_waits / deadlock
  → Exporter / Prometheus / Grafana 看趋势与告警
  → 必要时回到 EXPLAIN / trace / system metrics
```

所以本篇最该记住的一句话是：**Performance Schema 的价值不在于“它记录了很多表”，而在于它把 SQL、线程、锁、I/O、复制这些运行事件放进同一观测平面；sys 和监控平台只是这张平面的翻译层。**

## 七、几个最容易说错的地方

### 开了 Performance Schema，就一定什么都看得到？

不是。没开的 instrument/consumer 不会产出数据，history 窗口太短也会让你错过现场。

### digest 能替代慢日志原文？

不是。digest 擅长发现高总耗时模板，但会抹平参数差异和个别极端慢请求的上下文。

### 没看到 deadlock，就说明没有锁问题？

不是。很多问题只是长等待，并没有形成环；死锁日志只记录最近一次被检测出的死锁事故。

### Grafana 图上很平，就说明刚才没有抖动？

不是。采样周期和聚合方式会抹平瞬时尖峰，趋势图不能代替细粒度现场取证。

### 监控当然是越全越安全？

不是。观测本身也有成本；好的监控设计追求的是更快定位，而不是更多图表。

## 收束：可观测性不是“多看几张图”，而是把 SQL、线程、锁、I/O 和复制状态放进同一观测平面

回到开头那个问题：运行时到底慢在什么，以及我怎样持续看见这种变慢。答案已经闭环了：先用 P_S 把事件采进来，再用 digest、threads、复制视图和 `data_locks`/`data_lock_waits` 把事件压成可读状态，最后用 Exporter/Prometheus/Grafana 把这些状态变成长期可回看的时间序列。只有这样，你才能同时回答“这条 SQL 为什么慢”和“它在线上到底慢在执行链的哪一层”。

这就是为什么说：**Performance Schema 的价值不在于“它记录了很多表”，而在于它把 SQL、线程、锁、I/O、复制这些运行事件放进同一观测平面；sys 和监控平台只是这张平面的翻译层。** 只要这条主线站稳，后面进入连接池与中间件时，你就不会再把数据库内部事件和外部并发行为割裂开，而会自然去问：连接池、中间件和读写分离到底怎样改变这张观测平面上的负载形状与故障模式。

## 下一篇桥接

现在最自然的问题已经从“数据库内部怎么观测”推进到了“数据库外部怎么塑形”：**数据库内部的监控和复制都讲清了；连接池和中间件如何在数据库外部塑造并发、故障切换和读写分离？为什么同一套 SQL，在直连、连接池和 ProxySQL 后面会表现出完全不同的峰值与失败模式？**

下一篇 `16-connection-pool-proxysql.md` 会把视角推进到 HikariCP、连接池与 ProxySQL：连接复用、限流、排队、读写分离、故障切换和中间件指标怎样一起改变数据库前的并发形状。