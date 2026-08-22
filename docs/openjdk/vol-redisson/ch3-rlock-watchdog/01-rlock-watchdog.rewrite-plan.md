# 篇：01 RLock 分布式锁与批量 Watchdog 续期

- 域：`R-2 RLock 分布式锁 + 批量 Watchdog`
- 卷：`vol-redisson`
- 目标：回答 RLock 加锁/释放锁的完整流程，以及 Watchdog 怎么批量续期。

## 前置依赖

- HARD：已读 `R-4 命令执行流水线`（知道 eval 脚本执行）。
- SOFT：熟悉 Lua 脚本和 `SET NX PX` 的基本锁语义。

## 读者问题

1. RLock 怎么用 Lua 脚本原子加锁？
2. lockWatchdogTimeout（30s）自动续期怎么工作？
3. `LockRenewalScheduler` + `AsyncChunkProcessor` 怎么批量续期多把锁？
4. RedLock（红锁）怎么处理脑裂？
5. 可重入锁怎么计数？

## 主结论

RLock 的加锁是 **Lua 脚本原子操作**（`SET key NX PX ttl` / `HINCRBY` 可重入计数 + `PEXPIRE`）+ **看门狗自动续期**（`scheduleExpirationRenewal` → `LockRenewalScheduler.renewLock` → `LockTask` 批量续期）。

## 结构设计

1. 困惑开场：分布式锁为什么不能只用 SETNX
2. 加锁：tryLockInnerAsync Lua 脚本
3. 可重入：HINCRBY 计数
4. Watchdog：scheduleExpirationRenewal + LockRenewalScheduler
5. 批量续期：AsyncChunkProcessor
6. 解锁：Lua 脚本删 key
7. RedLock 红锁
8. 失败路径
9. 收网与下篇桥接 R-3 Codec

## 必须回填的源码锚点

- `org.redisson/RedissonLock.java:39` 类声明（可重入、非公平注释）
- `org.redisson/RedissonLock.java:214` `tryLockInnerAsync`
- `org.redisson/RedissonBaseLock.java:72` `scheduleExpirationRenewal`
- `org.redisson/renewal/LockRenewalScheduler.java:56` `renewLock`
- `org.redisson/renewal/LockTask.java:42` `AsyncChunkProcessor.processAll`（批量续期）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE