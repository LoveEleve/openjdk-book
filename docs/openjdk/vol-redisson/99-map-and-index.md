# vol-redisson 总图与索引

## 总图

```text
R-1 Redisson.create(config)
  Config（5 种服务器模式）
    → ConnectionManager（5 种实现）
      → ServiceManager（中央工厂）
        → CommandAsyncExecutor
          → R-4 CommandAsyncService
            readAsync → slave / writeAsync → master
            RFuture 异步结果
              → R-2 RLock（tryLockInnerAsync Lua 加锁 → Watchdog 批量续期）
                → R-3 Codec（Encoder/Decoder → 5 种实现）
                  → R-5 RMap（LocalCachedMap 近缓存 → MapWriter/MapLoader）
                    → R-6 Spring Cache（RedissonSpringCacheManager → RedissonCache）
                      → R-7 基础结构（RBucket / RAtomicLong / RSemaphore）
```

## 索引

| 域 | 篇名 | 文件 |
|:--:|------|------|
| R-1 | Redisson 主类与连接管理 | ch1-connection-init/01-redisson-connection-init.md |
| R-2 | RLock 分布式锁 + Watchdog | ch3-rlock-watchdog/01-rlock-watchdog.md |
| R-3 | Codec 序列化体系 | ch4-codec/01-codec-encoder-decoder.md |
| R-4 | 命令执行流水线 | ch2-command-executor/01-command-async-executor.md |
| R-5 | RMap 分布式映射 | ch5-rmap/01-rmap-localcache.md |
| R-6 | Spring Cache 集成 | ch6-spring-cache/01-spring-cache.md |
| R-7 | 基础数据结构 | ch7-basic-ds/01-basic-ds.md |