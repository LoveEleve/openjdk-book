# 篇：01 缓冲区体系：client 输入/输出缓冲、AOF 缓冲、复制缓冲

- 域：`R-25 缓冲区体系`
- 卷：`vol-redis`
- 目标：回答 Redis 的 5 种缓冲区（client input/output/AOF/replication/backlog）各自的作用、组织方式和限制。

## 前置依赖

- HARD：已读 `R-2 事件驱动`，知道 `beforeSleep` 中 IO 写线程和 AOF 落盘。

## 读者问题

1. `querybuf` 跟 `buf` + `reply` 有什么区别？为什么用两个？
2. `client-output-buffer-limit` 对 normal / replica / pubsub 三类客户端分别怎么限制？
3. AOF 的 `aof_buf` 什么时候写？什么时候落盘？
4. `repl_buffer_blocks` 和 `repl_backlog` 有什么区别？都管什么？
5. `client-memory-usage` 和 `maxmemory-clients` 怎么记内存？

## 主结论

Redis 的缓冲区不是"一个接收缓冲区 + 一个发送缓冲区"那么简单，而是 **5 种缓冲区分别服务于不同数据流**：client 输入输出（`querybuf` + `buf`/`reply`）负责客户端读写，`aof_buf` 负责持久化，`repl_buffer_blocks` 负责复制传播，`repl_backlog` 负责部分同步。

## 结构设计

1. 困惑开场：为什么需要这么多缓冲区
2. client 输入缓冲 `querybuf`：SDS 累积 + `processInputBuffer` 解析
3. client 输出缓冲 `buf` + `reply`：静态快速写 + 链式缓冲溢出
4. `client-output-buffer-limit`：normal / replica / pubsub 三类限制
5. AOF 缓冲 `aof_buf`：命令传播后先进缓冲，`beforeSleep` 落盘
6. 复制缓冲 `repl_buffer_blocks`：主节点推送给从节点的写命令缓冲
7. 复制 backlog `repl_backlog`：环形缓冲用于部分同步
8. 内存记账：`client-memory-usage` / `maxmemory-clients`
9. 失败路径
10. 收网与下篇桥接 R-26 命令执行全流程

## 必须回填的源码锚点

- `src/server.h:1166` `sds querybuf`（输入缓冲）
- `src/server.h:1147` `int bufpos`（输出缓冲当前位置）
- `src/server.h:1185` `list *reply`（输出缓冲链表）
- `src/server.h:933`-`936` `clientReplyBlock`（输出缓冲块）
- `src/server.h:1195` `time_t obuf_soft_limit_reached_time`
- `src/server.h:1788` `sds aof_buf`（AOF 缓冲）
- `src/server.h:1894` `size_t repl_buffer_mem`（复制缓冲内存）
- `src/server.h:1895` `list *repl_buffer_blocks`（复制缓冲块）
- `src/server.h:1879`-`1881` `repl_backlog` / `repl_backlog_size` / `repl_backlog_time_limit`
- `src/networking.c:147` `c->querybuf = sdsempty()`
- `src/networking.c:2559` `processInputBuffer()` 解析 querybuf
- `src/networking.c:342` `clientReplyBlock` 相关分配
- `src/aof.c:1117` `aofWrite(server.aof_fd, server.aof_buf, ...)`
- `src/replication.c:104`-`121` `replBacklog` 初始化
- `src/config.c` `client-output-buffer-limit` / `maxmemory-clients` 配置

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
