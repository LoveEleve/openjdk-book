# 过期 key 删除为什么可能阻塞

> 本文基于 Redis 7.4.2 当前源码。排障层第五篇，回答过期删除的阻塞问题。

## 一、惰性删除 — expireIfNeeded

`expireIfNeeded()`（`expire.c:35`）在 `lookupKeyRead/Write` 时检查 key 是否过期，过期则删除。**不阻塞**（只删除当前 key）。

## 二、定期删除 — activeExpireCycle

`activeExpireCycle()`（`expire.c:187`）在 `serverCron` 中每 100ms 执行，从 `expires` 字典随机采样 key，检查过期，按时间预算控制。**大量 key 同时过期时，一次循环扫不完，需要在后续循环中继续扫**。

## 三、大 key 过期阻塞

大 key（如百万级 List）在 `expireIfNeeded` 中同步删除（`dbSyncDelete`），释放所有元素阻塞主线程。`lazyfree-lazy-expire` 配置可让过期删除走异步路径。

## 四、收网

惰性删除不阻塞，定期删除限定时间预算，大 key 过期时的同步删除是阻塞主线程的主要风险。`lazyfree-lazy-expire` 启用异步释放。

## 下篇桥接

R-24 慢命令阻塞与 IO 多线程边界。
