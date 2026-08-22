# 卷 Redisson · Redis 客户端框架源码分析

> 本卷基于 Redisson main 分支（latest）当前源码（Java）。目标不是按包翻译源码，而是把"连接管理 -> 命令执行 -> 分布式锁 -> 序列化 -> 分布式集合 -> 集成与基础结构"收束成一卷可连续阅读的源码书。

## 当前卷级状态

- 全部 7 个域（R-1~R-7）正文已完成
- 每篇均含四件套：正文 + rewrite-plan + note + review-notes
- 卷级六层审查已完成
- 当前属于完整闭合

## 篇章目录

### A. 核心域（4 篇）

- [R-1 Redisson 主类与连接管理](ch1-connection-init/01-redisson-connection-init.md)：Config 5 种模式、ConnectionManager、ServiceManager 中央工厂、读写分离
- [R-4 命令执行流水线](ch2-command-executor/01-command-async-executor.md)：CommandAsyncService、RFuture 异步模型、Lua 脚本执行、重试机制
- [R-2 RLock 分布式锁 + Watchdog](ch3-rlock-watchdog/01-rlock-watchdog.md)：Lua 原子加锁、可重入、Watchdog 批量续期、RedLock
- [R-3 Codec 序列化体系](ch4-codec/01-codec-encoder-decoder.md)：Encoder/Decoder 接口、5 种内置实现、全局 vs 单结构注册

### B. 扩展域（3 篇）

- [R-5 RMap 分布式映射](ch5-rmap/01-rmap-localcache.md)：LocalCachedMap 近缓存、MapWriter/MapLoader、过期策略
- [R-6 Spring Cache 集成](ch6-spring-cache/01-spring-cache.md)：RedissonSpringCacheManager、RedissonCache、TTL 配置
- [R-7 基础数据结构](ch7-basic-ds/01-basic-ds.md)：RBucket、RAtomicLong、RSemaphore

## 推荐阅读顺序

`R-1 -> R-4 -> R-2 -> R-3 -> R-5 -> R-6 -> R-7`

先建立连接管理与命令执行，再理解分布式锁（最常用功能），然后序列化、分布式集合、集成和基础结构。

## 本卷在体系中的位置

本卷与 `vol-redis` 互补：vol-redis 讲 Redis 服务器内部实现，本卷讲 Java 客户端框架。R-2 RLock 的 Lua 脚本复用 vol-redis R-27 讲过的脚本执行语义。

## 当前仍未覆盖的边界

- `api/` 801 个数据接口（用到时查 API）
- MapReduce、LiveObject、Executor、Remote（低频）
- Reactive / Rx 响应式流（独立话题）
- 各种框架集成（hibernate/mybatis/tomcat/quarkus 等）