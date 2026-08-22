# 为什么 Redis 单线程还能撑 10 万 QPS

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第八篇，回答 ae 事件循环与 IO 多线程如何让单线程命令执行支撑 10 万级 QPS。

## 为什么"单线程=慢"这个理解会把事件循环读浅

很多人第一次听说 Redis 单线程，觉得它就是一个循环调 epoll_wait，收到请求就处理。

但 Redis 的事件循环不是"一直等事件"，而是 **先读、再执行、再写** 的三阶段循环。6.0 引入的 IO 多线程把"读请求"和"写响应"拆成两阶段交给 IO 线程并行，中间的"命令执行"仍由主线程单线程完成，保证无锁。

## 一、aeEventLoop 结构

关键代码在 `src/ae.h:78`-`:87`：

```c
typedef struct aeEventLoop {
    int maxfd;             /* 当前注册的最大 fd */
    int setsize;           /* 跟踪的最大 fd 数量 */
    long long timeEventNextId;
    aeFileEvent *events;   /* 注册的文件事件 */
    aeFiredEvent *fired;   /* 触发的事件 */
    aeTimeEvent *timeEventHead; /* 定时事件链表 */
    int stop;
    void *apidata;         /* 多路复用 API 数据（epoll/kqueue 等） */
    aeBeforeSleepProc *beforesleep;
    aeBeforeSleepProc *aftersleep;
    int flags;
} aeEventLoop;
```

`events` 数组记录所有注册的文件事件（读/写回调），`fired` 数组记录本次 poll 触发的事件，`timeEventHead` 是定时事件链表（`serverCron` 注册在这里）。`beforesleep` 和 `aftersleep` 是每次 poll 前后调用的钩子函数。

## 二、aeMain 主循环

关键代码在 `src/ae.c:474`-`483`：

```c
void aeMain(aeEventLoop *eventLoop) {
    eventLoop->stop = 0;
    while (!eventLoop->stop) {
        aeProcessEvents(eventLoop, AE_ALL_EVENTS |
                                   AE_CALL_BEFORE_SLEEP |
                                   AE_CALL_AFTER_SLEEP);
    }
}
```

`aeProcessEvents`（`src/ae.c:342`）的执行流程：

1. 如果有定时事件到期，计算最近的到期时间作为 poll 的超时
2. 调用 `beforesleep`（`src/server.c:1637`）
3. 调用 `aeApiPoll`（`src/ae_epoll.c`）等待事件
4. 处理所有 `fired` 事件（读/写回调）
5. 处理到期的定时事件
6. 调用 `aftersleep`（`src/server.c:1808`）

## 三、beforeSleep 的主线任务

`beforeSleep()`（`src/server.c:1637`）在每次 poll 前执行，主要任务：

1. **IO 写线程阶段**：`handleClientsWithPendingWritesUsingThreads()`（`networking.c:4393`）——把客户端输出缓冲区中的数据通过 IO 线程并行写 socket
2. **AOF 落盘**：`flushAppendOnlyFile(0)`（`aof.c`）——把 `aof_buf` 写入磁盘文件
3. **复制传播**：`feedReplicationBacklog()` / 推送给从节点
4. **过期扫描**：`activeExpireCycle()`（`expire.c`）——每次扫描一部分过期 key
5. **内存碎片整理**：`activeDefragCycle()`（`defrag.c`）

## 四、serverCron：100ms 后台任务

`serverCron` 在 `server.c` 中定义，每 100ms（`hz=10`）执行一次，注册为定时事件。主要任务：

- 更新 `server.lruclock`（`server.h` 的 `LRU_CLOCK_RESOLUTION`）
- 调用 `clientsCron`（检查客户端超时和输出缓冲限制）
- 调用 `databasesCron`（过期 key 删除、rehash 推进）
- 检查 `BGSAVE`/`AOF rewrite` 子进程状态
- 更新统计信息（`server.stat_*`）

## 五、IO 多线程：两阶段并行

IO 多线程是 Redis 6.0 引入的优化，核心思想是"主线程负责命令执行，IO 线程并行读写"。`io_threads_op`（`src/networking.c:4231`）标记当前 IO 线程的操作阶段。

### 第一阶段：IO 读（主线程读 + IO 线程并行读）

`readQueryFromClient`（`src/networking.c`）中，客户端把数据读入 `querybuf` 后，不立即解析，而是加入 `pending_read` 列表。`handleClientsWithPendingReadsUsingThreads()`（`src/networking.c:4357`）在 `aeProcessEvents` 中被调用，把 `pending_read` 列表分发给 IO 线程并行解析 RESP 协议，把解析结果写入 `c->argv`/`c->argc`。

### 第二阶段：IO 写（beforeSleep 中 IO 线程并行写）

`beforeSleep` 中调用 `handleClientsWithPendingWritesUsingThreads()`（`src/networking.c:4393`），把待写客户端列表分发给 IO 线程，IO 线程并行调用 `write()` 把 `buf`/`reply` 链表中的数据写入 socket。

### 为什么命令执行不交给 IO 线程

因为命令执行需要访问 Redis 的所有数据结构（dict、skiplist、SDS 等），如果多个线程同时执行命令，就需要加锁，加锁的开销会抵消并行带来的收益。所以 Redis 选择"IO 并行 + 执行串行"的折中方案。

## 六、失败路径

### 1. IO 线程与主线程的边界

`io_threads_op` 在 READ/WRITE/IDLE 三态之间切换。主线程在 IO 线程工作时不能修改客户端状态。`serverAssert(io_threads_op == IO_THREADS_OP_IDLE)` 在多个关键路径上做防御性检查。

### 2. beforeSleep 耗时

`beforeSleep` 中如果 AOF fsync 慢或复制传播量大，会阻塞整个事件循环的 poll 进入。`lua-time-limit` 的超时检测也在这里。

### 3. IO 线程数配置不当

`io-threads` 配置（默认 1，即不启用 IO 多线程）。`io-threads-do-reads` 配置（默认 no，即不启用 IO 读线程）。如果 IO 线程数设置过大，线程切换开销可能超过并行收益。

## 到这里，R-2 真正立住的是"aeMain 三阶段循环 + IO 两阶段并行"

如果只看表面，事件循环被读成"一个 epoll_wait 循环"。

更稳的理解方式应该是：

1. `aeMain` 循环的完整流程：beforeSleep → poll → 处理事件 → afterSleep
2. `beforeSleep` 是 IO 写、AOF 落盘、复制传播、过期扫描的集中执行点
3. `serverCron` 每 100ms 执行后台维护
4. IO 多线程把读写拆成两阶段，交给 IO 线程并行，命令执行仍由主线程单线程
5. `io_threads_op` 三态切换保证主线程与 IO 线程的安全边界

## 下篇桥接

R-25 缓冲区体系将展开 client 输入/输出缓冲、AOF 缓冲、复制缓冲的详细设计。
