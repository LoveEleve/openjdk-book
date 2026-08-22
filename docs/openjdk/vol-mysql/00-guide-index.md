# vol-mysql 总导读与总索引：如果你不想把 MySQL 学成一堆彼此割裂的知识点，这一页就是整卷的阅读地图、阶段索引和问题入口

> 主题：MySQL｜总导读 / 总索引
> 覆盖范围：`docs/openjdk/vol-mysql/01` ～ `20`
> 适用读者：希望从“会用 MySQL”推进到“能解释架构、性能、恢复、高可用、观测、扩展与选型”的读者
> 使用方式：先看本页确定阅读顺序、问题入口与阶段地图，再按需要顺读或跳读正文
> 一句话总纲：这一卷不是把 MySQL 拆成一堆零散技术点，而是沿着“单机架构 → 日志恢复 → 页与索引 → 事务并发 → 复制高可用 → 优化器与观测 → 库外并发控制 → 扩展存储与数据系统 → 理论与选型”这条主线，把数据库为什么这样设计、成本放在哪里、问题如何演化讲成一个连续世界。

## 一、先看这卷到底在回答什么问题

很多人学 MySQL 时会遇到一个常见困境：

- 语法会写；
- 索引知道一点；
- 慢 SQL 也会看一点；
- 主从、高可用、观测、恢复、连接池、CDC、HTAP、分库分表这些词也都听过。

但一旦问题变复杂，知识就会立刻碎掉：

- 为什么一条 SQL 会牵扯到 Buffer Pool、Redo、Undo、索引页和后台线程？
- 为什么索引“建了”不等于优化器一定会选？
- 为什么复制不是“文件自动同步”，而是五段接力？
- 为什么故障转移后还要补齐事务集合、校验性能和容量？
- 为什么观测不能只看慢日志，还要看 Performance Schema、锁等待和 Exporter？
- 为什么数据库性能问题很多时候并不从 mysqld 内部开始，而是从连接池、代理和路由层开始？
- 为什么再往后走，问题突然变成 LSM、CDC、Shuffle、HTAP、CAP 和选型方法论？

这卷的目标，就是把这些看似分散的问题重新串回同一条主线：**数据库系统到底在替你扛哪些矛盾，而这些矛盾又怎样一层层长出架构、日志、索引、锁、复制、高可用、观测、扩展和选型决策。**

如果把整卷压成一句话，就是：**MySQL 不是一个“执行 SQL 的黑盒”，而是一套不断在写放大、读放大、空间放大、恢复语义、并发正确性、网络边界和组织成本之间重新分配代价的系统。**

## 二、整卷阶段地图

整卷可以分成 7 个阶段来读：

```text
阶段 A：单机总图与持久化主账
  01 架构总图
  02 Redo/WAL/LSN
  03 Group Commit / Undo / Recovery

阶段 B：物理存储与索引系统
  04 B+Tree / 页 / 行格式
  05 索引维护策略
  06 FULLTEXT / 统计 / Online DDL

阶段 C：事务并发与锁
  07 ACID / MVCC / 锁
  08 死锁 / MDL / 并发优化

阶段 D：复制、高可用与集群
  09 复制 / Binlog / GTID
  10 并行复制 / 故障切换
  11 故障转移 / 备份恢复 / 修复
  12 Group Replication / InnoDB Cluster

阶段 E：优化器与观测
  13 优化器 / EXPLAIN / 慢日志
  14 子查询 / sys / Performance Schema 桥接
  15 Performance Schema / 锁监控 / 外部观测

阶段 F：数据库外部控制层与扩展专题
  16 连接池 / ProxySQL
  17 LSM / LevelDB / BoltDB
  18 大数据 SQL / CDC / HTAP

阶段 G：理论与选型方法论
  19 并发控制与恢复理论
  20 CAP / 分库分表 / 数据库选型
```

最推荐的阅读方式，不是按产品功能目录读，而是按这个阶段图读。因为整卷的真正主线不是“功能手册”，而是“问题如何升级”。

## 三、三种阅读路线

### 1. 完整路线：想把整卷彻底读通

按 `01 → 20` 顺序读。

这是最稳的路线，因为：

- 前文会不断给后文建语言；
- 后文的很多“为什么”都建立在前文已经长出的心智上；
- 整卷的桥接是按这条路线设计的。

适合：

- 想把 MySQL 当成一门系统课程读的人；
- 想从工程使用者转成能解释架构和故障的人；
- 想为后面的分布式、选型和架构判断做底座的人。

### 2. 诊断路线：你现在主要想解决性能、故障和观测问题

推荐顺序：

```text
13 → 15 → 09 → 10 → 11 → 16 → 20
```

这条路线先把：

- 优化器与慢日志；
- P_S 和锁监控；
- 复制和高可用；
- 连接池与代理；
- 最终选型与架构判断

串起来，适合在线上问题驱动下跳读。

### 3. 系统路线：你更关心“数据库为什么长这样”

推荐顺序：

```text
01 → 02 → 03 → 04 → 07 → 09 → 12 → 17 → 19 → 20
```

这条路线重点看：

- 单机架构和持久化主账；
- 物理页世界与事务并发；
- 复制、高可用、替代存储路线；
- 理论与选型。

适合：

- 想把数据库当系统设计材料来学的人；
- 想理解“为什么不是更简单”的人。

## 四、按问题找文章

如果你不是顺读，而是带着具体问题来，可以按这张问题索引走：

### 1. “一条 SQL 到底穿过了什么层？”

- `docs/openjdk/vol-mysql/01-server-innodb-architecture.md`
- `docs/openjdk/vol-mysql/04-btree-page-row-format.md`

### 2. “为什么写操作不能直接改页，为什么先写日志？”

- `docs/openjdk/vol-mysql/02-redo-wal-lsn.md`
- `docs/openjdk/vol-mysql/03-group-commit-undo-recovery.md`

### 3. “索引为什么有时有用，有时没用？”

- `docs/openjdk/vol-mysql/05-index-maintenance-strategy.md`
- `docs/openjdk/vol-mysql/06-fulltext-statistics-ddl.md`
- `docs/openjdk/vol-mysql/13-optimizer-explain-slowlog.md`

### 4. “MVCC、锁、死锁、MDL 到底是什么关系？”

- `docs/openjdk/vol-mysql/07-acid-mvcc-locks.md`
- `docs/openjdk/vol-mysql/08-deadlock-mdl-optimization.md`

### 5. “主从复制、GTID、半同步、并行复制和切换应该怎么连起来看？”

- `docs/openjdk/vol-mysql/09-replication-binlog-gtid.md`
- `docs/openjdk/vol-mysql/10-parallel-replication-failover.md`
- `docs/openjdk/vol-mysql/11-failover-backup-repair.md`
- `docs/openjdk/vol-mysql/12-group-replication-cluster.md`

### 6. “慢 SQL 到底怎么定位，EXPLAIN 和 ANALYZE 差在哪？”

- `docs/openjdk/vol-mysql/13-optimizer-explain-slowlog.md`
- `docs/openjdk/vol-mysql/14-subquery-sys-ps.md`
- `docs/openjdk/vol-mysql/15-performance-schema-observability.md`

### 7. “性能问题很多时候是不是根本不在 mysqld 里？”

- `docs/openjdk/vol-mysql/15-performance-schema-observability.md`
- `docs/openjdk/vol-mysql/16-connection-pool-proxysql.md`

### 8. “InnoDB 之外还有什么存储路线，为什么会有 LSM 和 COW？”

- `docs/openjdk/vol-mysql/17-lsm-leveldb-boltdb.md`

### 9. “为什么一进大数据、CDC、HTAP，问题的语言就全变了？”

- `docs/openjdk/vol-mysql/18-bigdata-cdc-htap.md`

### 10. “理论和选型到底怎样反过来指导架构？”

- `docs/openjdk/vol-mysql/19-concurrency-recovery-theory.md`
- `docs/openjdk/vol-mysql/20-distributed-theory-selection.md`

## 五、每篇一句话索引

### 阶段 A：单机总图与持久化主账

- `docs/openjdk/vol-mysql/01-server-innodb-architecture.md`：MySQL 先用 Server 层/Handler 契约把 SQL 语义和物理存储分开，再由 InnoDB 用 Buffer Pool、日志和后台线程把整条流水线组织起来。
- `docs/openjdk/vol-mysql/02-redo-wal-lsn.md`：WAL 的本质是让数据页晚刷、让提交先返回，而 LSN/Checkpoint 负责把页、日志和恢复边界对齐到同一套坐标系。
- `docs/openjdk/vol-mysql/03-group-commit-undo-recovery.md`：提交、回滚、可见性和清理不是同一件事，Group Commit、Undo、Crash Recovery 和 Purge 只是把这几条时间线咬合起来。

### 阶段 B：物理存储与索引系统

- `docs/openjdk/vol-mysql/04-btree-page-row-format.md`：一行记录真正落地时，要先穿过树、页、行和表空间这四层物理结构。
- `docs/openjdk/vol-mysql/05-index-maintenance-strategy.md`：索引不是“建了就行”，它是一笔要从读写两端一起评估的维护成本账。
- `docs/openjdk/vol-mysql/06-fulltext-statistics-ddl.md`：索引系统同时维护查询结构、统计模型和 DDL 变更工程，三者缺一都会出事故。

### 阶段 C：事务并发与锁

- `docs/openjdk/vol-mysql/07-acid-mvcc-locks.md`：普通读之所以能不等，是因为 MVCC 把可见性从锁里拆了出去；当前读之所以必须等，是因为锁范围仍要沿索引路径建立。
- `docs/openjdk/vol-mysql/08-deadlock-mdl-optimization.md`：锁不只是一种对象，MDL、行锁、内部锁和等待图站在不同层回答不同问题。

### 阶段 D：复制、高可用与集群

- `docs/openjdk/vol-mysql/09-replication-binlog-gtid.md`：复制不是“文件自动同步”，而是事件生产、传输、落盘、回放和确认的五段接力。
- `docs/openjdk/vol-mysql/10-parallel-replication-failover.md`：并行复制的前提不是多开线程，而是证明事务不冲突；故障切换的前提不是切得快，而是事务集合判断正确。
- `docs/openjdk/vol-mysql/11-failover-backup-repair.md`：故障处理不是把服务拉起来就结束，而是先确认事务集合，再选恢复路径，最后验证性能和容量。
- `docs/openjdk/vol-mysql/12-group-replication-cluster.md`：组复制不是半同步增强版，而是把成员资格、事务认证和选主推进到了协议层。

### 阶段 E：优化器与观测

- `docs/openjdk/vol-mysql/13-optimizer-explain-slowlog.md`：优化器不是神谕，而是统计和成本模型驱动的预测器；慢日志给症状，EXPLAIN 给假设，ANALYZE 给事实。
- `docs/openjdk/vol-mysql/14-subquery-sys-ps.md`：SQL 的语法形态不等于执行形态，真正要紧的是重写成什么，以及线上证据能否证明它慢在这里。
- `docs/openjdk/vol-mysql/15-performance-schema-observability.md`：Performance Schema 的价值不在于“表很多”，而在于把 SQL、线程、锁、I/O 和复制放进了同一观测平面。

### 阶段 F：数据库外部控制层与扩展专题

- `docs/openjdk/vol-mysql/16-connection-pool-proxysql.md`：连接池决定请求如何进入数据库，ProxySQL 决定请求去哪里，MySQL 才负责真正执行。
- `docs/openjdk/vol-mysql/17-lsm-leveldb-boltdb.md`：存储引擎设计的核心不是数据结构名，而是你愿意把成本放在哪个阶段支付。
- `docs/openjdk/vol-mysql/18-bigdata-cdc-htap.md`：单机 SQL 的每一步，在分布式分析、异构同步和 HTAP 场景里都会长出新的网络和一致性成本。

### 阶段 G：理论与选型方法论

- `docs/openjdk/vol-mysql/19-concurrency-recovery-theory.md`：数据库理论始终在回答两件事：崩溃后怎样恢复一个可解释状态，并发事务怎样避免不可串行化。
- `docs/openjdk/vol-mysql/20-distributed-theory-selection.md`：数据库选型不是产品打榜，而是把一致性、数据模型、团队与运维成本放进同一套可验证决策框架。

## 六、如果你只想记住这卷的七条主线

1. MySQL 不是单个黑盒，而是一条由 Server 层、Handler、Buffer Pool、日志和后台线程组织起来的流水线。  
2. 持久化不是“改页就算完”，而是 WAL、Redo、Undo、Checkpoint 和恢复边界共同结账。  
3. 索引不是一棵树，而是一整套读写代价、统计模型和结构演进工程。  
4. 并发控制真正难的不是“同时执行”，而是“同时执行后还能解释为什么结果是对的”。  
5. 复制和高可用真正难的不是“多几台机器”，而是“事务集合、角色语义和故障边界怎么收敛”。  
6. 性能问题很多时候不从 mysqld 内部开始，而是从连接池、代理、路由、观测和外部同步链路开始。  
7. 选数据库不是问“谁最快”，而是问“在你的业务、故障、数据和组织边界下，哪种代价最值得长期承担”。

## 七、这卷现在可以怎么用

### 1. 当课程读

按 `01 → 20` 顺序读，整卷会像一门连续的数据库系统课。

### 2. 当排障地图读

遇到慢 SQL、复制延迟、死锁、备份恢复、连接池超时、跨系统同步等问题时，按问题索引跳读对应篇章。

### 3. 当架构决策工具读

如果你已经不是在问“功能怎么用”，而是在问：

- 该不该上组复制；
- 该不该拆分；
- 该不该引入 HTAP；
- 该不该做 CDC；
- 该怎么选数据库；

那就优先读 `12`、`15`、`16`、`18`、`19`、`20`。

## 八、卷后建议

如果要继续推进，下一步最自然的主线是分布式：

- 先读分布式规划总纲；
- 再按同样方法论，从“问题引入 → 失败直觉 → 机制拆解 → 收束桥接”的节奏开写；
- 继续保持“先建立语言，再建立判断框架”的顺序，而不是直接扑进某一个具体产品。

如果你未来回头重读这卷，只需要记住一件事：**这不是一套 MySQL 知识卡片，而是一条从单机数据库一直通向数据系统与架构判断的连续主线。**
