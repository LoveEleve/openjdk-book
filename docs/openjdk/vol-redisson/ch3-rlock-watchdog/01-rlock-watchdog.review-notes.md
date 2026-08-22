# vol-redisson R-2 RLock 分布式锁 — review notes

## 事实审

- `RedissonLock.java:214` tryLockInnerAsync Lua 脚本 ✅（`exists==0 || hexists==1` 合并分支 + `hincrby` + `pexpire`）
- `RedissonBaseLock.java:72` scheduleExpirationRenewal ✅
- `renewal/LockRenewalScheduler.java:56` renewLock ✅
- `renewal/LockTask.java:42` AsyncChunkProcessor.processAll ✅
- 正文初稿的 Lua 脚本使用了经典版（`hset` + 独立 `hincrby`），已修正为实际源码的合并分支版本

## 因果审
- 加锁 Lua 脚本原子操作 ✅
- Watchdog 自动续期 ✅
- 批量续期 AsyncChunkProcessor ✅

## 结构审
- 加锁/可重入/Watchdog/批量/解锁/RedLock，主线集中 ✅

## 读者审
- 读完能回答：RLock 加锁 Lua 脚本的实际逻辑 ✅

## 边界审
- 不展开公平锁细节 ✅

## 依赖审
- 前置 R-4，后续 R-3 ✅

## 结论
R-2 通过六层审查（1 处 Lua 脚本已修正）。
ENDOFFILE