# 卷 Redis · 内存数据库内部实现源码分析

> 本卷基于 Redis 7.4.2 当前源码（C 语言）。目标不是按文件翻译源码，而是把"类型系统 -> 数据结构与编码 -> 事件驱动 -> 命令执行 -> 持久化 -> 复制 -> 高可用 -> 生产排障 -> 高级特性"收束成一卷可连续阅读的源码书。

## 当前卷级状态

- 全部 32 个域（R-1~R-32）正文已完成
- 每篇均含四件套：正文 + rewrite-plan + note + review-notes
- 卷级六层审查已完成，覆盖全量锚点验证与机制描述核对
- 当前属于完整闭合，等同一阶段的源码书成品

## 篇章目录

### A. 数据结构与编码层（7 篇）

- [R-1 redisObject 类型系统](ch1-object-encoding/01-redisobject-type-encoding.md)：type/encoding 分离、INT/EMBSTR/RAW 编码决策、共享对象
- [R-4 SDS 字符串](ch2-sds/01-sds-string-design.md)：5 种 header、二进制安全、预分配策略
- [R-3 Dict 渐进式 rehash](ch3-dict/01-dict-hash-incremental-rehash.md)：双表结构、rehashidx、扩容/缩容两档阈值、SipHash
- [R-5 List / quicklist](ch4-list-quicklist/01-list-quicklist-listpack.md)：listpack 直存 + quicklist 分页、fill/compress、LZF
- [R-6 ZSet](ch5-zset/01-zset-skiplist-dict.md)：skiplist + dict 双结构、span 的 O(logN) 排名
- [R-7 Set / intset](ch6-set-intset/01-set-intset-encoding.md)：intset/listpack/HT 三种编码、单向升级
- [R-10 Stream](ch7-stream-rax/01-stream-rax-consumergroup.md)：rax 基数树 + listpack 批量 + 消费者组 PEL

### B. 事件驱动核心层（1 篇）

- [R-2 事件驱动 + IO 多线程](ch8-event-driver/01-ae-eventloop-io-threads.md)：aeMain 三阶段、beforeSleep、IO 读/写两阶段并行

### C. 命令执行基础设施层（3 篇）

- [R-25 缓冲区体系](ch9-buffer-system/01-buffer-system-client-aof-repl.md)：querybuf / buf+reply / aof_buf / repl_buffer_blocks / repl_backlog
- [R-26 命令执行全流程](ch10-command-flow/01-command-execution-pipeline.md)：readQueryFromClient → processCommand → call → addReply → beforeSleep
- [R-27 Lua 脚本原子性](ch11-lua-script/01-lua-atomicity-eval-script.md)：SCRIPT_WRITE_DIRTY、lua-time-limit、集群 CROSSSLOT、replicate_commands()

### D. 经典混淆补深层（5 篇，面试高频）

- [R-28 内存淘汰策略](ch12-eviction/01-eviction-policy-lru-lfu.md)：8 种策略、近似 LRU 采样池、LFU 对数计数与衰减、过期删除 vs 内存淘汰
- [R-29 键空间与 SCAN](ch13-keyspace-scan/01-keyspace-db-scan.md)：kvstore 键空间、lookupKey 路径、KEYS 阻塞 vs SCAN 游标
- [R-30 阻塞命令](ch14-blocking/01-blocking-brpop-blpop.md)：blockForKeys / signalKeyAsReady / handleClientsBlockedOnKeys
- [R-31 发布订阅](ch15-pubsub/01-pubsub-channel-broadcast.md)：频道组广播、消息丢失、与 Stream/List 对比
- [R-32 ACL 权限控制](ch16-acl/01-acl-user-permission.md)：default 用户、ACL 规则、命令类别位标志

### E. 持久化与复制层（3 篇）

- [R-11/12/13 Bitmap/HLL/GEO 编码专题](ch17-bitmap-hll-geo/01-bitmap-hll-geo-encoding.md)：位操作、寄存器基数估算、geohash
- [R-8 持久化 RDB + AOF](ch18-persistence/01-rdb-aof-persistence.md)：SAVE/BGSAVE、三种 fsync、Multi-part AOF
- [R-9 主从复制 PSYNC](ch19-replication/01-replication-psync-backlog.md)：全量 + 部分同步、repl_backlog、replid/replid2

### F. 高可用层（2 篇）

- [R-14 Sentinel](ch20-sentinel/01-sentinel-sdown-odown-failover.md)：SDOWN/ODOWN、故障转移状态机
- [R-15 Cluster](ch21-cluster/01-cluster-slot-gossip-failover.md)：16384 slot、MOVED/ASK、Gossip、投票选主

### G. 生产排障层（6 篇，面试重难点）

- [R-19 RDB 持久化阻塞与 fork 陷阱](ch22-rdb-blocking/01-rdb-fork-blocking.md)：SAVE 全程阻塞、fork 页表复制、COW 内存放大
- [R-20 大 key 删除与 lazyfree](ch23-bigkey-lazyfree/01-bigkey-delete-lazyfree.md)：DEL 同步 vs UNLINK 异步、dbAsyncDelete、bio 线程
- [R-21 复制 backlog 溢出与全量风暴](ch24-backlog-overflow/01-backlog-overflow-full-resync.md)：backlog 覆盖退化全量、多从节点风暴
- [R-22 AOF fsync 与磁盘抖动](ch25-aof-fsync/01-aof-fsync-disk-jitter.md)：always/everysec/no、fsync 阻塞
- [R-23 过期 key 删除与阻塞](ch26-expire-blocking/01-expire-blocking.md)：惰性 + 定期删除、大 key 过期阻塞
- [R-24 慢命令阻塞与 IO 边界](ch27-slow-command/01-slow-command-blocking.md)：KEYS/EVAL 阻塞、IO 多线程不解决命令执行

### H. 高级特性层（3 篇）

- [R-16 事务 MULTI/EXEC/WATCH](ch28-transaction/01-transaction-multi-exec-watch.md)：入队执行、乐观锁、无回滚
- [R-17 客户端缓存 tracking](ch29-tracking/01-tracking-client-cache.md)：RESP3 失效推送、BCAST
- [R-18 内存碎片整理 defrag](ch30-defrag/01-defrag-memory.md)：activeDefragCycle、je_get_defrag_hint

## 推荐阅读顺序

`R-1 -> R-4 -> R-3 -> R-5 -> R-6 -> R-7 -> R-10 -> R-2 -> R-25 -> R-26 -> R-27 -> R-29 -> R-28 -> R-30 -> R-31 -> R-32 -> R-8 -> R-9 -> R-14 -> R-15 -> R-19~R-24 -> R-16/R-17/R-18`

主干层先建类型系统与数据结构编码，再展开事件驱动主线，紧接**缓冲区体系 + 命令执行全流程**（命令进出的骨架），进入持久化、复制、高可用；排障层放在主干之后、高级特性之前，不打断主干连续阅读。

## 本卷在四卷体系中的位置

本卷是四卷（HikariCP、Druid、MyBatis、MyBatis-Plus）之后的独立新卷（C 语言项目），用 Redis 服务器内部实现补足"数据存储底座"视角：

- 与 `vol-hikaricp` / `vol-druid`：连接池与服务端无直接依赖，正交。
- 与 `vol-mybatis` / `vol-mybatis-plus`：ORM 与 Redis 缓存/分布式结构互补，无交叉引用
- 本卷引入 C 语言分析方法论：锚点格式为 `src/xxx.c:行号`，无 MCP 索引，用 grep + 行号锚点核对

## 当前仍未覆盖的边界

- Module API、Redis CLI 实现、RESP 协议完整编解码为淘汰清单
- 入门集成（spring-boot-starter-data-redis / Lettuce / Jedis）为暂缓候选