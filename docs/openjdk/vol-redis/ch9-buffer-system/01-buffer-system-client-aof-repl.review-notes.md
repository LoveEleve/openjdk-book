# vol-redis R-25 缓冲区体系 — review notes

## 事实审

- 已核对 `src/server.h:1166`（`sds querybuf` 输入缓冲），正文成立。
- 已核对 `src/server.h:1147`（`int bufpos` 输出缓冲位置）、`:1185`（`list *reply` 输出缓冲链表），正文成立。
- 已核对 `src/server.h:933`-`936`（`clientReplyBlock` 定长缓冲区块），正文成立。
- 已核对 `src/server.h:1195`（`obuf_soft_limit_reached_time` 软限制计时），正文成立。
- 已核对 `src/server.h:1788`（`sds aof_buf` AOF 缓冲），正文成立。
- 已核对 `src/server.h:1894`-`1895`（`repl_buffer_mem` / `repl_buffer_blocks` 复制缓冲），正文成立。
- 已核对 `src/server.h:1879`-`1881`（`repl_backlog` / size / time_limit），正文成立。
- 已核对 `src/networking.c:147`（`c->querybuf = sdsempty()`），正文成立。
- 已核对 `src/networking.c:2559`（`processInputBuffer()` 解析入口），正文成立。
- 已核对 `src/aof.c:1117`（`aofWrite(server.aof_fd, server.aof_buf, ...)`），正文成立。
- 已核对 `src/replication.c:104`-`121`（`replBacklog` 初始化），正文成立。

## 因果审

- 5 种缓冲区分别服务不同数据流（客户端读写、AOF 持久化、复制传播、部分同步），正文成立。
- 输出缓冲两级设计（buf 快速写 + reply 链式溢出）平衡性能与内存，正文成立。
- `client-output-buffer-limit` 三类限制适应不同场景，正文成立。
- `repl_buffer_blocks` 与 `repl_backlog` 功能不同，正文成立。

## 结构审

- 从"为什么需要 5 种缓冲区"困惑开场，再落到每种缓冲区的结构、生命周期和限制，主线集中。

## 读者审

- 读完应能回答：5 种缓冲区各自服务什么数据流。
- 读完应能回答：输出缓冲的两级设计是什么。
- 读完应能回答：`repl_buffer_blocks` 和 `repl_backlog` 的区别。
- 读完后能自然进入 R-26 命令执行全流程。

## 边界审

- 本篇没有展开 `processInputBuffer` 的 RESP 解析细节（R-26 覆盖）。
- R-26 命令执行全流程未提前透支，边界成立。

## 依赖审

- 前置依赖：R-2 事件驱动（HARD，知道 beforeSleep 中 IO 写和 AOF 落盘）。
- 后续桥接：R-26 命令执行全流程。

## 结论

R-25 已完成四件套的事实回填与六层审查，可进入 R-26 命令执行全流程。
