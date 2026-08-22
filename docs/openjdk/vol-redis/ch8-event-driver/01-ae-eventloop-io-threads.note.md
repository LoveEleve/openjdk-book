# vol-redis R-2 事件驱动 + IO 多线程 — note

## 本篇主张

- Redis 事件循环不是"一直等事件"，而是 **beforeSleep → poll → 处理事件 → afterSleep** 的三阶段循环。
- `beforeSleep` 是 IO 写、AOF 落盘、复制传播、过期扫描的集中执行点。
- `serverCron` 每 100ms 执行后台维护（客户端超时、过期删除、rehash 推进、BGSAVE 检查）。
- IO 多线程把"读请求"和"写响应"拆成两阶段交给 IO 线程并行，命令执行仍由主线程单线程完成，保证无锁。
- `io_threads_op` 三态（READ/WRITE/IDLE）切换保证主线程与 IO 线程的安全边界。

## 本篇边界

- 不展开 IO 线程内部的锁/原子操作细节。
- 不展开 client 缓冲区的具体结构（R-25 覆盖）。

## 下篇桥接

- R-25 缓冲区体系将展开 client 输入/输出缓冲、AOF 缓冲、复制缓冲的详细设计。
