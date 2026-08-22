# 一次 `SET key value` 穿过哪几道门

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第十篇，回答一次命令从网络读到响应返回，中间穿过哪几道门。

## 为什么"收到就执行"这个理解会把命令流水线读浅

很多人第一次看 Redis，觉得命令处理就是"收到请求 → 执行 → 返回结果"三步。

但一次 `SET key value` 从雷达到 Redis 返回 `+OK`，中间要穿过 **六道门**：

```
readQueryFromClient → processInputBuffer → processCommand → call → addReply → beforeSleep
```

这六步每一步都有独立的职责：读入、解析、检查、执行、响应、传播。任何一步出错都会影响整个流水线。

## 一、读阶段：`readQueryFromClient`

`readQueryFromClient()`（`src/networking.c`）把客户端 socket 中的数据读入 `c->querybuf`（SDS 字符串）。

这一步不解析命令，只把原始 RESP 协议字节累积到 `querybuf`。IO 多线程开启时，这一步在 IO 线程并行执行（`io_threads_op == IO_THREADS_OP_READ`）。

## 二、解析阶段：`processInputBuffer`

`processInputBuffer()`（`src/networking.c:2559`）从 `querybuf` 中解析出完整命令。

RESP 协议有两种解析器：
- `processMultibulkBuffer`：解析 `*N\r\n$len\r\n...` 形式的批量请求，填充 `c->argv`/`c->argc`
- `processInlineBuffer`：解析旧版 `SET key value` 形式的纯文本命令

解析出完整命令后，调用 `processCommandAndResetClient()`（`src/networking.c:2501`）。

## 三、检查阶段：`processCommand`

`processCommand()`（`src/server.c:3884`）在执行前做一系列检查：

1. **命令表查询**：`lookupCommand()`（`src/server.c:3200`）从命令表查找 `c->cmd`，命令不存在返回错误
2. **ACL 检查**：`ACLCheckCommandPerm()` 检查用户权限
3. **maxmemory 检查**：`performEvictions()`（`evict.c`）如果内存超限触发淘汰
4. **过期检查**：`lookupKeyRead`（`db.c`）在访问 key 时触发惰性删除
5. **`CLIENT_MULTI` 入队**：如果是 MULTI 事务中的命令，入队不执行
6. **只读从节点检查**：主从模式下从节点禁止写命令
7. **集群检查**：集群模式下检查 slot 归属，`clusterRedirectClient` 处理 MOVED/ASK
8. **WATCH 检查**：如果 key 被 WATCH，且被修改过，返回事务失败

所有检查通过后，才进入执行阶段。

## 四、执行阶段：`call`

`call()`（`src/server.c:3524`）是真正的执行入口：

1. **执行命令**：调用 `c->cmd->proc(c)`，即命令的具体实现（如 `setCommand` → `t_string.c`）
2. **命令耗时统计**：`server.stat_commands` 计数，`server.stat_commands_processed` 累加
3. **慢日志**：`slowlogPushEntryIfNeeded()` 如果命令耗时超过 `slowlog-log-slower-than`，记录慢日志
4. **传播决策**：写命令执行后 `dirty` 计数非 0，调用 `propagate()` 决定是否传播到 AOF 和复制

## 五、响应阶段：`addReply`

命令执行后，`addReply()`（`src/networking.c`）把响应写入客户端输出缓冲：

1. 先写 `c->buf`（静态缓冲，`PROTO_REPLY_CHUNK_BYTES` 大小）
2. `buf` 满后写 `c->reply` 链表（`clientReplyBlock` 块）

写入只在主线程（或 IO 写线程）进行，`io_threads_op == IO_THREADS_OP_IDLE` 时安全写入，否则挂起等待。

## 六、传播阶段：`beforeSleep`

`beforeSleep()`（`src/server.c:1637`）在每次 poll 前执行：

1. **IO 写线程**：`handleClientsWithPendingWritesUsingThreads()`（`networking.c:4393`）把 `buf`/`reply` 中的数据并行写 socket
2. **AOF 落盘**：`flushAppendOnlyFile(0)`（`aof.c:1117` `aofWrite`）把 `aof_buf` 写入文件
3. **复制传播**：写命令的 RESP 表示写入 `repl_buffer_blocks` 推送给从节点

## 七、失败路径

### 1. querybuf 中无完整命令

如果 `querybuf` 中只有半条命令（客户端没发送完整的 RESP 帧），`processInputBuffer` 等待更多数据，不解析。

### 2. processCommand 检查失败

ACL 拒绝、命令不存在、scard 超限（`SET` 在 maxmemory 下拒绝写入）等情况，`processCommand` 返回 C_ERR，不执行命令，直接调用 `addReply` 返回错误。

### 3. call 中执行慢命令

`KEYS` / `SMEMBERS` / `EVAL` 等慢命令在 `call` 中阻塞主线程，期间其他客户端请求排队。这是命令执行阶段的主要阻塞点。

## 到这里，R-26 真正立住的是"六步命令流水线"

如果只看表面，命令处理被读成"收到就执行"。

更稳的理解方式应该是：

1. 读阶段：`readQueryFromClient` 读入 `querybuf`
2. 解析阶段：`processInputBuffer` 拆成 `argv`
3. 检查阶段：`processCommand` 做 ACL/maxmemory/过期/WATCH/集群检查
4. 执行阶段：`call` 执行命令 + 统计 + 慢日志
5. 响应阶段：`addReply` 写入 `buf` / `reply`
6. 传播阶段：`beforeSleep` 落盘 AOF + 推送给从节点 + IO 写

## 下篇桥接

R-27 Lua 脚本原子性将展开 EVAL/EVALSHA 与脚本执行的特殊路径。
