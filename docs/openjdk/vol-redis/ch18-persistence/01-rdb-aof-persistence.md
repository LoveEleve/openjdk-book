# RDB 与 AOF：为什么需要两种持久化

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第十八篇，回答 RDB 与 AOF 各自解决的问题，以及 Multi-part AOF 的实现。

## 为什么"持久化就是存数据"这个理解会把持久化读浅

很多人第一次用 Redis 的持久化，觉得 RDB 就是存快照、AOF 就是记日志。

但 Redis 为什么需要两种？因为它们的**恢复粒度**不同：RDB 是"全量快照"，恢复快但可能丢数据；AOF 是"增量日志"，恢复慢但丢数据少。7.0 的 Multi-part AOF 把两者融合——RDB 格式的 base + AOF 格式的 incremental + manifest 清单。

## 一、RDB：SAVE 阻塞 + BGSAVE fork COW

`rdbSave()`（`src/rdb.c:1593`）是阻塞保存，序列化全部数据并写入文件，期间主线程无法处理任何命令。

`rdbSaveBackground()`（`src/rdb.c:1636`）fork 子进程，子进程调 `rdbSaveRio()`（`src/rdb.c:1452`）序列化数据到临时文件，完成后 `rename` 原子替换原文件。fork 后主进程和子进程共享内存页（COW），子进程序列化期间主进程修改的页被复制，COW 峰值内存放大。

## 二、AOF：flushAppendOnlyFile 与三种策略

`flushAppendOnlyFile()`（`src/aof.c:1045`）在 `beforeSleep` 中调用，把 `aof_buf` 写入文件。

三种 fsync 策略：
- **always**：每条命令后 `fsync`，最安全但最慢
- **everysec**（默认）：`beforeSleep` 中 `fsync`，最多丢 1 秒数据
- **no**：不主动 `fsync`，由操作系统决定，可能丢多秒数据

`feedAppendOnlyFile()`（`src/aof.c:1308`）把写命令的 RESP 表示追加到 `aof_buf`（SDS 字符串，`server.h:1788`）。

## 三、AOF Rewrite：Multi-part AOF 的 base + incremental

Redis 7.0 的 AOF Rewrite 不再用旧版（6.x）的"fork 子进程写全量 + pipe 传增量"模型，而是走 **Multi-part AOF** 的 base + incremental 拆分。

`rewriteAppendOnlyFileBackground()`（`src/aof.c:2437`）fork 子进程做两件事：

1. **子进程**调 `rewriteAppendOnlyFile()`（`src/aof.c:2357`）→ `rewriteAppendOnlyFileRio()`（`:2249`）扫描当前数据，生成 **base.rdb**（RDB 格式，只含最终状态）。
2. **主进程**在 rewrite 前调用 `openNewIncrAofForAppend()`（`src/aof.c:771`）打开一个新的 **incremental.aof** 文件，rewrite 期间的新写命令通过 `feedAppendOnlyFile` 继续追加到这个 incremental 文件，而不是通过 pipe 传给子进程。

rewrite 完成后，`AOF_MANIFEST`（清单文件）更新，指向新的 base.rdb + incremental.aof 组合，旧文件被清理。这就是 Multi-part AOF 用"分段文件 + manifest 清单"替代旧版单一 AOF 文件的核心。

> 注意：网上很多资料讲的"fork + pipe 增量"是 Redis 6.x 的实现，Redis 7.x 已改为 Multi-part AOF 的 incremental 文件。

## 四、Multi-part AOF（7.0+）

Redis 7.0 引入 Multi-part AOF，把 AOF 文件拆成（`src/aof.c:27`-`:54` manifest 注释）：
- **base.rdb**：RDB 格式的快照（AOF rewrite 的产物，用 RDB 格式更紧凑）
- **incremental.aof**：增量的 RESP 日志
- **manifest**：清单文件，记录 base 和 incremental 的关联

`AOF_MANIFEST` 以 `AOF_MANIFEST` 开头标记（`src/aof.c:27`-`:54`），`persistAofManifest()` 在 manifest 变更时写盘。

## 五、失败路径

### 1. fork 阻塞

`BGSAVE` 或 AOF rewrite 的 `fork` 在实例内存大时（如 10GB+）可能阻塞数毫秒甚至更久，期间主线程暂停。

### 2. COW 内存放大

fork 后主进程写操作触发 COW，峰值内存可能达到正常的两倍。`rdbSaveBackground` 中 `sendChildCowInfo` 上报 COW 大小。

### 3. AOF fsync 阻塞

`always` 策略下每次命令后的 `fsync` 在磁盘慢时可能阻塞主线程数十毫秒。

## 到这里，R-8 真正立住的是"RDB 点快照 + AOF 线日志"

如果只看表面，持久化被读成"存数据"。

更稳的理解方式应该是：

1. RDB：`rdbSave` 阻塞 / `rdbSaveBackground` fork COW
2. AOF：`flushAppendOnlyFile` 三种策略，`feedAppendOnlyFile` 追加到 `aof_buf`
3. AOF Rewrite：Multi-part AOF，子进程写 base.rdb，主进程 `openNewIncrAofForAppend` 接 incremental
4. Multi-part AOF：base.rdb + incremental.aof + manifest

## 下篇桥接

R-9 复制将展开 PSYNC 部分同步、repl_backlog 和链式复制。
