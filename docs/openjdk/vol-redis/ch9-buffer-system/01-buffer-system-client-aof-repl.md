# 为什么 Redis 需要 5 种缓冲区

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第九篇，回答 Redis 的 5 种缓冲区各自的作用、组织方式和限制。

## 为什么"缓冲区就是输入输出"这个理解会把缓冲体系读浅

很多人第一次看 Redis 的缓冲区，觉得就是一个 input buffer 接收命令 + 一个 output buffer 返回结果。

但 Redis 有 **5 种缓冲区**，不是 2 种：client 输入缓冲（`querybuf`）、client 输出缓冲（`buf` + `reply`）、AOF 缓冲（`aof_buf`）、复制缓冲（`repl_buffer_blocks`）、复制 backlog（`repl_backlog`）。每种服务于不同的数据流，有不同的生命周期和限制策略。

## 一、client 输入缓冲 `querybuf`

关键代码在 `src/server.h:1166` `sds querybuf`，初始化在 `src/networking.c:147` `c->querybuf = sdsempty()`。

`querybuf` 是一个 SDS 字符串，累积客户端发送的原始 RESP 协议数据。`processInputBuffer()`（`src/networking.c:2559`）从 `querybuf` 中解析出完整命令，拆成 `c->argv`/`c->argc`。

`querybuf` 的 `querybuf_peak`（`networking.c:148`）追踪峰值，`PROTO_MAX_BULK_LEN` 限制单条命令大小。`client-query-buffer-limit` 限制客户端输入缓冲的最大值，超过时断开连接。

## 二、client 输出缓冲 `buf` + `reply`

输出缓冲由两个部分组成：

1. **`buf`**（`src/server.h:1147` `int bufpos` + `char buf[PROTO_REPLY_CHUNK_BYTES]`）：静态快速写缓冲区，`addReply*` 系列函数优先写入 `buf`。
2. **`reply`**（`src/server.h:1185` `list *reply`）：当 `buf` 写满时，溢出到 `clientReplyBlock`（`src/server.h:933`-`936`）链表中。

`clientReplyBlock` 是定长缓冲区块（`char buf[]`），通过 `listNode` 链接成 `reply` 链表。`c->sentlen`（`src/server.h:1188`）记录已发送的字节数。

`addReply()` 系列函数（`src/networking.c`）的写入顺序：先写 `buf`，`buf` 满则写 `reply` 链表。

## 三、`client-output-buffer-limit` 客户端输出缓冲限制

`client-output-buffer-limit` 对 **normal / replica / pubsub 三类客户端**分别设 `obuf_hard_limit`（超过立刻断开）和 `obuf_soft_limit`（持续超过 N 秒才断开）。`src/server.h:1195` `obuf_soft_limit_reached_time` 记录软限制开始时间。

`clientsCron` 在 `serverCron` 中周期检查所有客户端的输出缓冲大小，超过限制的断开连接。

## 四、AOF 缓冲 `aof_buf`

关键代码在 `src/server.h:1788` `sds aof_buf`。

命令执行后，`propagate()` 把写命令追加到 `aof_buf` 中。`beforeSleep()` 调用 `flushAppendOnlyFile()`（`src/aof.c:1117` `nwritten = aofWrite(server.aof_fd, server.aof_buf, ...)`）把 `aof_buf` 写入文件。

`aof_buf` 的写入策略由 `appendfsync` 配置控制（always/everysec/no）。`always` 模式下每次命令后都 fsync，`everysec` 模式下 `beforeSleep` 中 fsync。

## 五、复制缓冲 `repl_buffer_blocks`

关键代码在 `src/server.h:1894` `repl_buffer_mem` 和 `:1895` `list *repl_buffer_blocks`。

主节点把写命令同时传播到 `aof_buf` 和所有从节点的 `repl_buffer_blocks`。`repl_buffer_blocks` 是一个链表，每个节点是 `clientReplyBlock`，与 client 输出缓冲结构相同。

如果从节点消费速度慢，`repl_buffer_blocks` 会持续增长，占用主节点内存。`client-output-buffer-limit` 对 replica 类型客户端的限制可以断开慢速从节点。

## 六、复制 backlog `repl_backlog`

`repl_backlog`（`src/server.h:1879`-`1881`）是主节点上的环形缓冲，用于部分同步（PSYNC）。

初始化在 `src/replication.c:104`-`121`：`ref_repl_buf_node` 链表 + `blocks_index`（rax 树索引快速定位 offset）、`histlen`（历史长度）、`offset`（当前偏移量）。`repl-backlog-size` 默认 1MB。

当从节点断线重连时，如果 `repl_backlog` 中还保留着从节点缺失的数据（通过 offset 判断），就只发送增量数据，否则退化为全量重同步。

## 七、内存记账

`client-memory-usage` 和 `maxmemory-clients` 配置控制客户端缓冲的总内存上限。`maxmemory-clients` 默认 0（不限制），开启后当所有客户端缓冲总内存超过限制时，先断开大内存客户端释放内存。

## 八、失败路径

### 1. querybuf 无限增长

如果客户端发送大量半命令（不发送完整 RESP 帧），`querybuf` 持续增长。`client-query-buffer-limit` 断开恶意客户端，`PROTO_MAX_BULK_LEN` 限制单条命令最大值。

### 2. 输出缓冲膨胀

`MONITOR` 命令或 `PSUBSCRIBE` 高频订阅场景下，客户端输出缓冲可能快速膨胀。`client-output-buffer-limit` 对 pubsub 类客户端的限制通常比 normal 更严格。

### 3. 复制缓冲耗尽主节点内存

从节点长时间掉线，`repl_buffer_blocks` 持续增长。`client-output-buffer-limit` 对 replica 的限制断开慢速从节点，但 `repl_backlog` 不受客户端限制控制，由 `repl-backlog-size` 配置限。

## 到这里，R-25 真正立住的是"5 种缓冲区服务不同数据流"

如果只看表面，缓冲区体系被读成"一个输入 + 一个输出"。

更稳的理解方式应该是：

1. `querybuf`：客户端输入，SDS 累积，`processInputBuffer` 解析
2. `buf` + `reply`：客户端输出，静态快速写 + 链式溢出
3. `aof_buf`：AOF 持久化，命令传播后先入缓冲，`beforeSleep` 落盘
4. `repl_buffer_blocks`：复制传播，推送给从节点的写命令缓冲
5. `repl_backlog`：部分同步，环形缓冲，offset 定位

## 下篇桥接

R-26 命令执行全流程将展开从 `readQueryFromClient` 到 `addReply` 的完整执行链。
