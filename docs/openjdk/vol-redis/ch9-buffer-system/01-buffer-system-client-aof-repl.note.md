# vol-redis R-25 缓冲区体系 — note

## 本篇主张

- Redis 有 5 种缓冲区，不是 2 种：`querybuf`（输入）、`buf`+`reply`（输出）、`aof_buf`（AOF）、`repl_buffer_blocks`（复制传播）、`repl_backlog`（部分同步）。
- 输出缓冲采用"静态快速写 + 链式溢出"两级设计，`buf` 满后写 `reply` 链表。
- `client-output-buffer-limit` 对 normal / replica / pubsub 三类客户端分别设硬限制和软限制。
- `repl_buffer_blocks` 和 `repl_backlog` 是两个不同的复制缓冲：前者是推送给从节点的写命令，后者是环形缓冲用于部分同步。

## 本篇边界

- 不展开 `processInputBuffer` 的 RESP 解析细节（R-26 覆盖）。
- 不展开 `flushAppendOnlyFile` 的 fsync 策略细节（R-22 覆盖）。

## 下篇桥接

- R-26 命令执行全流程将展开从 `readQueryFromClient` 到 `addReply` 的完整执行链。
