# 篇：01 事件驱动 + IO 多线程：aeMain 与两阶段并行

- 域：`R-2 事件驱动 + IO 多线程`
- 卷：`vol-redis`
- 目标：回答 Redis 单线程事件循环为什么能支撑 10 万级 QPS，以及 6.0 IO 多线程如何不破坏无锁主线。

## 前置依赖

- HARD：已读 `R-1 redisObject`，知道 Redis 是单线程执行命令。
- SOFT：了解 epoll/kqueue 多路复用的基本概念。

## 读者问题

1. `aeMain` 循环里发生了什么？`aeProcessEvents` 做了哪几件事？
2. `beforeSleep` 和 `afterSleep` 分别在什么时候调用？各做什么？
3. IO 多线程的 READ 和 WRITE 两阶段是怎么拆分的？
4. 为什么 IO 多线程只负责读写，不参与命令执行？
5. `serverCron` 在什么时候执行？多久一次？

## 主结论

Redis 事件循环不是"一直等事件"，而是 **先读、再执行、再写** 的三阶段循环。6.0 引入的 IO 多线程把"读请求"和"写响应"拆成两阶段交给 IO 线程并行，中间的"命令执行"仍由主线程单线程完成，保证无锁。

`aeMain` → `aeProcessEvents`：先调 `beforeSleep`（IO 写、AOF flush、复制传播、过期/淘汰），然后 poll 事件，处理读事件，最后调 `afterSleep`。

## 结构设计

1. 困惑开场：单线程怎么撑 10 万 QPS
2. aeEventLoop 结构：events/fired/timeEventHead/beforesleep/aftersleep
3. aeMain 主循环 + aeProcessEvents
4. beforeSleep 的主线任务：写客户端、AOF 落盘、复制传播、过期扫描
5. serverCron：100ms 周期的后台任务
6. IO 多线程：READ 阶段（主线程读 → IO 线程并行读）和 WRITE 阶段（beforesleep 中 IO 线程并行写）
7. 为什么命令执行不交给 IO 线程
8. 失败路径
9. 收网与下篇桥接 R-25 缓冲区体系

## 必须回填的源码锚点

- `src/ae.h:78`-`:87` `aeEventLoop` 结构体（maxfd/setsize/events/fired/timeEventHead/beforesleep/aftersleep）
- `src/ae.c:474` `aeMain()`（主循环）
- `src/ae.c:342` `aeProcessEvents()`（事件处理）
- `src/ae.c:46` `aeCreateEventLoop()`（创建事件循环）
- `src/ae.c:487` `aeSetBeforeSleepProc()`（注册 beforeSleep）
- `src/server.c:1637` `beforeSleep()`（AOF flush、复制传播、IO 写线程、过期/淘汰）
- `src/server.c:1808` `afterSleep()`
- `src/server.c:2772`-`2773` beforeSleep/afterSleep 注册
- `src/server.c` `serverCron()`（100ms 后台任务）
- `src/networking.c:4231` `int io_threads_op`（IO 线程操作阶段）
- `src/networking.c:4357` `handleClientsWithPendingReadsUsingThreads()`（IO 读线程）
- `src/networking.c:4393` `handleClientsWithPendingWritesUsingThreads()`（IO 写线程）
- `src/server.c` `IO_THREADS_OP_READ / IO_THREADS_OP_WRITE / IO_THREADS_OP_IDLE`
- `src/ae_epoll.c` `aeApiPoll()`（epoll wait）

## 必须引用的测试/证据

- `tests/unit/` 相关测试

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
