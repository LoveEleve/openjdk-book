# vol-redisson R-2 RLock 分布式锁 — note

## 本篇主张

- RLock 加锁是 **Lua 脚本原子操作**（`tryLockInnerAsync`，`RedissonLock.java:214`）：`exists==0 || hexists==1` 合并分支 + `HINCRBY` + `PEXPIRE`。
- 可重入用 `HINCRBY threadId` 计数，解锁减到 0 才删 key。
- Watchdog：`scheduleExpirationRenewal`（`RedissonBaseLock.java:72`）每 `lockWatchdogTimeout/3`（默认 10s）续期，TTL 重置为 `lockWatchdogTimeout`（默认 30s）。
- 批量续期：`LockTask`（`LockTask.java:42`）用 `AsyncChunkProcessor.processAll` 按 `lockWatchdogBatchSize`（默认 100）分批。
- 释放：主动 unlock 或持有者崩溃后 Watchdog 停止、30s 自动释放。

## 本篇边界

- 不展开公平锁（FairLock）的排队机制细节。
- RedLock 只概述，不展开多实例调度的完整实现。

## 下篇桥接

- R-3 Codec 序列化体系。
ENDOFFILE