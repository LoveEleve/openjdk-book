# vol-redis R-2 事件驱动 + IO 多线程 — review notes

## 事实审

- 已核对 `src/ae.h:78`-`:87`（`aeEventLoop`：maxfd/setsize/events/fired/timeEventHead/beforesleep/aftersleep），正文成立。
- 已核对 `src/ae.c:474`（`aeMain()` 主循环），正文成立。
- 已核对 `src/ae.c:342`（`aeProcessEvents()` 事件处理），正文成立。
- 已核对 `src/ae.c:46`（`aeCreateEventLoop()`），正文成立。
- 已核对 `src/ae.c:487`（`aeSetBeforeSleepProc()`），正文成立。
- 已核对 `src/server.c:1637`（`beforeSleep()`：AOF flush、复制传播、IO 写线程、过期/淘汰），正文成立。
- 已核对 `src/server.c:1808`（`afterSleep()`），正文成立。
- 已核对 `src/server.c:2772`-`2773`（beforeSleep/afterSleep 注册），正文成立。
- 已核对 `src/networking.c:4231`（`int io_threads_op`），正文成立。
- 已核对 `src/networking.c:4357`（`handleClientsWithPendingReadsUsingThreads()`），正文成立。
- 已核对 `src/networking.c:4393`（`handleClientsWithPendingWritesUsingThreads()`），正文成立。

## 因果审

- `aeMain` 三阶段循环（beforeSleep → poll → afterSleep）是 Redis 事件驱动的主骨架，正文成立。
- `beforeSleep` 集中执行 IO 写、AOF 落盘、复制传播、过期扫描，正文成立。
- IO 多线程把读写交给 IO 线程并行，命令执行仍由主线程单线程，保证无锁，正文成立。
- `io_threads_op` 三态切换保证主线程与 IO 线程的安全边界，正文成立。

## 结构审

- 从"单线程怎么撑 10 万 QPS"困惑开场，再落到 aeEventLoop 结构、aeMain 循环、beforeSleep 任务、serverCron、IO 两阶段，主线集中。

## 读者审

- 读完应能回答：aeMain 循环的完整流程是什么。
- 读完应能回答：beforeSleep 中做了哪些事。
- 读完应能回答：IO 多线程为什么只负责读写，不参与命令执行。
- 读完后能自然进入 R-25 缓冲区体系。

## 边界审

- 本篇没有展开 client 缓冲区的具体结构（R-25 覆盖）。
- R-25 缓冲区体系未提前透支，边界成立。

## 依赖审

- 前置依赖：R-1 redisObject（SOFT）。
- 后续桥接：R-25 缓冲区体系。

## 结论

R-2 已完成四件套的事实回填与六层审查，可进入 R-25 缓冲区体系。
