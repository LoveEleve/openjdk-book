# 02. RLock 为什么不能只用 SETNX，而要用 Lua 脚本 + 可重入 + Watchdog

> **前置依赖**: R-1(ServiceManager 注册 LockRenewalScheduler)、R-4(evalWriteSyncedNoRetryAsync 执行 Lua 脚本)
> → **后续**: R-3 Codec(序列化)
> 关联域: R-5 RMap(computeIfAbsentAsync 用 RLock 做并发控制)

## 困惑：SETNX + EXPIRE 不就能实现分布式锁了吗？

最经典的分布式锁方案是 `SETNX key value` + `EXPIRE key seconds`——key 不存在时加锁成功，设超时防止死锁。

但 RLock 的实现里，加锁用的是 `exists / hexists / hincrby / pexpire` 四条命令在一个 Lua 脚本里，key 不是简单的字符串，而是 Hash。如果 SETNX 就够了，为什么还要 Lua 脚本？

## 为什么不行：SETNX + EXPIRE 不是原子的

`SETNX key value` 成功之后、`EXPIRE key seconds` 执行之前，如果持有者崩溃，锁就没有超时保护，变成死锁。

改进方案是 `SET key value NX PX ttl`（Redis 2.6.12+ 的原子 SET 带 NX 和 PX 参数）。但这个方案仍然有 3 个问题：

1. **不可重入**：同一线程重复加锁，`SET NX` 会失败（key 已存在）
2. **无自动续期**：锁的 TTL 是固定的，业务执行超过 TTL 时锁自动释放，另一个线程拿到锁，数据冲突
3. **无等待机制**：锁被持有时，调用方只能 sleep 轮询，浪费 CPU

RLock 要解决的就是这三个问题。

## 总图：RLock 加锁的四步协作

```
tryLockInnerAsync(Lua 脚本)
  → 成功: scheduleExpirationRenewal(Watchdog 启动)
  → 失败: subscribe(等待释放通知)
    → 收到通知: tryAcquireAsync0(再次尝试)
```

## 分层拆解

### 1. 加锁 Lua 脚本：合并分支的 exists==0 || hexists==1

`RedissonLock.java:214`：

```java
<T> RFuture<T> tryLockInnerAsync(...) {
    return evalWriteSyncedNoRetryAsync(getRawName(), LongCodec.INSTANCE, command,
            "if ((redis.call('exists', KEYS[1]) == 0) " +
                        "or (redis.call('hexists', KEYS[1], ARGV[2]) == 1)) then " +
                    "redis.call('hincrby', KEYS[1], ARGV[2], 1); " +
                    "redis.call('pexpire', KEYS[1], ARGV[1]); " +
                    "return nil; " +
                "end; " +
                "return redis.call('pttl', KEYS[1]);",
            Collections.singletonList(getRawName()), unit.toMillis(leaseTime), getLockName(threadId));
}
```

参数：
- `KEYS[1]` = `getRawName()` = 锁名
- `ARGV[1]` = `unit.toMillis(leaseTime)` = 过期毫秒，不设置时取 `internalLockLeaseTime` = `lockWatchdogTimeout`(30s)
- `ARGV[2]` = `getLockName(threadId)` = `UUID:threadId`，持有者标识

逻辑：`exists==0`（锁不存在）**或** `hexists==1`（当前线程已持有，可重入）进同一个分支，`hincrby` 计数 +1 并 `pexpire` 刷新 TTL。都失败（锁被其他线程持有）则返回 `pttl`。

为什么是合并分支？因为 `hincrby` 在 key 不存在时自动初始化为 0 再加 1，所以不需要先 `hset` 再 `hincrby`——一个命令搞定首次加锁和可重入加锁。

### 2. 可重入：HINCRBY 计数

锁的 value 是 Redis Hash，field = `getLockName(threadId)`（`UUID:threadId`），value = HINCRBY 的计数。

同一线程重复加锁 → HINCRBY 计数 +1。解锁时 HINCRBY 计数 -1，减到 0 才删除 key 并 PUBLISH `redisson_lock__channel`。不同线程的 threadId 不同，各自计数互不影响。

### 3. 等待机制：subscribe 释放通知

`RedissonLock.java:374` `lockAsync`：

```java
RFuture<Long> ttlFuture = tryAcquireAsync0(-1, leaseTime, unit, currentThreadId);
ttlFuture.whenComplete((ttl, e) -> {
    if (ttl == null) {
        result.complete(null);  // 加锁成功
        return;
    }
    // 加锁失败，subscribe 等待释放通知
    CompletableFuture<RedissonLockEntry> subscribeFuture = subscribe(threadId);
    subscribeFuture.whenComplete((res, ex) -> {
        lockAsync(leaseTime, unit, res, result, currentThreadId);  // 收到通知再试
    });
});
```

加锁失败后，不 sleep 轮询，而是 subscribe 锁释放 channel（`redisson_lock__channel`），异步等待通知。收到通知后再次 `tryAcquireAsync0`。

### 4. Watchdog 自动续期

加锁成功后，`scheduleExpirationRenewal(threadId)`（`RedissonBaseLock.java:72`）启动：

```java
protected void scheduleExpirationRenewal(long threadId) {
    renewalScheduler.renewLock(getRawName(), threadId, getLockName(threadId));
}
```

`renewal/LockRenewalScheduler.java:56`：

```java
public void renewLock(String name, Long threadId, String lockName) {
    reference.compareAndSet(null, new LockTask(internalLockLeaseTime, executor, batchSize));
    LockTask task = reference.get();
    task.add(name, lockName, threadId);
}
```

`reference` 是 `AtomicReference<LockTask>`，整个进程只有**一个** `LockTask` 实例。`LockTask` 内部维护一个续期集合，`AsyncChunkProcessor.processAll`（`LockTask.java:42`）按 `lockWatchdogBatchSize`（默认 100，`config/Config.java:83`）分批，每批生成一个 Lua 续期脚本批量执行：`HEXISTS` 检查锁是否存在，存在则 `PEXPIRE` 续期，不存在则从集合中移除。

`LockRenewalScheduler` 维护 3 个 `AtomicReference`：`reference`（普通锁 → `LockTask`）、`multilockReference`（红锁 → `FastMultilockTask`）、`readLockReference`（读写锁 → `ReadLockTask`）。

### 5. RedLock

`RedissonFasterMultiLock` 在多个独立 Redis 实例上调用 `tryLockInnerAsync`，超过半数成功则加锁成功。解决单实例故障导致脑裂的问题。

## 失败路径

1. **持有者线程崩溃**：`scheduleExpirationRenewal` 不再被调用 → `LockTask` 中该锁的 `HEXISTS` 返回 0 → 自动移除 → 30s 后锁自动释放
2. **业务执行超过 30s 且 Watchdog 意外停止**：锁被其他线程获取，需配置合适的 `lockWatchdogTimeout`
3. **`lockWatchdogBatchSize` 太小**：续期队列积压，锁可能提前超时
4. **返回 `+OK` 后 `scheduleExpirationRenewal` 前崩溃**：锁无人续期，30s 自动释放（安全）

## 收网

RLock 加锁的四步：Lua 脚本（`tryLockInnerAsync` 合并分支 `exists==0 || hexists==1`）→ `HINCRBY` 可重入计数 → `subscribe` 等待释放通知 → `LockRenewalScheduler` （单例 `LockTask` + `AsyncChunkProcessor` 批量续期）。`scheduleExpirationRenewal` 在加锁成功后启动，`cancelExpirationRenewal` 在解锁后停止。

## 下篇

R-3 Codec 序列化体系。
ENDOFFILE