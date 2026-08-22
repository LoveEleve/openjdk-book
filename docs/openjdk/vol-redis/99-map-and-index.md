# vol-redis 总图与索引

## 总图

```text
A. 数据结构编码（7域）
  R-1 redisObject（类型-编码开关）
    → R-4 SDS（5 header + 预分配）
      → R-3 Dict（双表 + 渐进rehash + SipHash）
        → R-5 List（listpack直存 / quicklist分页）
          → R-6 ZSet（skiplist+dict双结构 + span排名）
            → R-7 Set（intset/listpack/HT三种编码）
              → R-10 Stream（rax + listpack + CG·PEL）

B. 事件驱动（1域）
  R-2 aeMain三阶段 + IO多线程两阶段

C. 命令执行基础设施（3域）
  R-25 缓冲区（querybuf / buf+reply / aof_buf / repl_buffer）
    → R-26 命令执行全流程（read→process→call→addReply→beforeSleep）
      → R-27 Lua脚本（SCRIPT_WRITE_DIRTY / CROSSSLOT / replicate_commands）

D. 经典混淆补深（5域）
  R-29 键空间（kvstore / lookupKey / KEYS vs SCAN）
    → R-28 内存淘汰（8种策略 / 近似LRU / LFU对数 / 过期vs淘汰）
      → R-30 阻塞命令（blockForKeys / signalKeyAsReady）
        → R-31 发布订阅（频道广播 / vs Stream / vs List）
          → R-32 ACL（default用户 / acl_categories位标志）

E. 持久化/复制（3域）
  R-11/12/13 Bitmap/HLL/GEO
    → R-8 RDB+AOF（SAVE/BGSAVE / fsync / Multi-part AOF）
      → R-9 复制PSYNC（全量 / backlog / replid链式）

F. 高可用（2域）
  R-14 Sentinel（SDOWN / ODOWN / 故障转移）
    → R-15 Cluster（16384 slot / Gossip / 投票选主）

G. 生产排障（6域）
  R-19 RDB阻塞 → R-20 大key/lazyfree → R-21 backlog溢出 → R-22 AOF fsync
    → R-23 过期删除 → R-24 慢命令+IO边界

H. 高级特性（3域）
  R-16 事务（MULTI/EXEC/WATCH）
    → R-17 tracking（RESP3失效推送）
      → R-18 defrag（activeDefragCycle）
```

## 索引

| 域 | 篇名 | 文件 |
|:--:|------|------|
| R-1 | redisObject 类型系统 | ch1-object-encoding/01-redisobject-type-encoding.md |
| R-2 | 事件驱动 + IO 多线程 | ch8-event-driver/01-ae-eventloop-io-threads.md |
| R-3 | Dict 渐进式 rehash | ch3-dict/01-dict-hash-incremental-rehash.md |
| R-4 | SDS 字符串 | ch2-sds/01-sds-string-design.md |
| R-5 | List / quicklist | ch4-list-quicklist/01-list-quicklist-listpack.md |
| R-6 | ZSet | ch5-zset/01-zset-skiplist-dict.md |
| R-7 | Set / intset | ch6-set-intset/01-set-intset-encoding.md |
| R-8 | 持久化 RDB + AOF | ch18-persistence/01-rdb-aof-persistence.md |
| R-9 | 复制 PSYNC | ch19-replication/01-replication-psync-backlog.md |
| R-10 | Stream / rax | ch7-stream-rax/01-stream-rax-consumergroup.md |
| R-11/12/13 | Bitmap / HLL / GEO | ch17-bitmap-hll-geo/01-bitmap-hll-geo-encoding.md |
| R-14 | Sentinel | ch20-sentinel/01-sentinel-sdown-odown-failover.md |
| R-15 | Cluster | ch21-cluster/01-cluster-slot-gossip-failover.md |
| R-16 | 事务 MULTI/EXEC/WATCH | ch28-transaction/01-transaction-multi-exec-watch.md |
| R-17 | 客户端缓存 tracking | ch29-tracking/01-tracking-client-cache.md |
| R-18 | 内存碎片整理 defrag | ch30-defrag/01-defrag-memory.md |
| R-19 | RDB 阻塞与 fork 陷阱 | ch22-rdb-blocking/01-rdb-fork-blocking.md |
| R-20 | 大 key 删除与 lazyfree | ch23-bigkey-lazyfree/01-bigkey-delete-lazyfree.md |
| R-21 | 复制 backlog 溢出 | ch24-backlog-overflow/01-backlog-overflow-full-resync.md |
| R-22 | AOF fsync 与磁盘抖动 | ch25-aof-fsync/01-aof-fsync-disk-jitter.md |
| R-23 | 过期 key 删除阻塞 | ch26-expire-blocking/01-expire-blocking.md |
| R-24 | 慢命令阻塞与 IO 边界 | ch27-slow-command/01-slow-command-blocking.md |
| R-25 | 缓冲区体系 | ch9-buffer-system/01-buffer-system-client-aof-repl.md |
| R-26 | 命令执行全流程 | ch10-command-flow/01-command-execution-pipeline.md |
| R-27 | Lua 脚本原子性 | ch11-lua-script/01-lua-atomicity-eval-script.md |
| R-28 | 内存淘汰策略 | ch12-eviction/01-eviction-policy-lru-lfu.md |
| R-29 | 键空间与 SCAN | ch13-keyspace-scan/01-keyspace-db-scan.md |
| R-30 | 阻塞命令 | ch14-blocking/01-blocking-brpop-blpop.md |
| R-31 | 发布订阅 | ch15-pubsub/01-pubsub-channel-broadcast.md |
| R-32 | ACL 权限控制 | ch16-acl/01-acl-user-permission.md |