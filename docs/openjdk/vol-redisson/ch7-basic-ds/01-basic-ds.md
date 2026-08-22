# RBucket / RAtomicLong / RSemaphore：为什么不是"一行代码封装"

> 本文基于 Redisson main 分支（latest）当前源码。本文只讲 `RedissonBucket`、`RedissonAtomicLong`、`RedissonSemaphore` 三个基础数据结构的封装。不展开连接管理（R-1）和命令执行（R-4）。

## 为什么"基础结构就是一行代码封装"这个理解，会把实现读浅

第一次用 `RBucket` / `RAtomicLong` / `RSemaphore` 时，很容易觉得它们就是"SET/GET、INCRBY、信号量 Lua 脚本的一行封装"。

但它们不止"封装"——每种结构都管理自己的异步状态：`RBucket` 有 `getAndSetAsync` / `getAndExpireAsync` 等变体，`RAtomicLong` 有 `addAndGetAsync` / `incrementAndGetAsync`，`RSemaphore` 有 `acquireAsync` / `releaseAsync`。这些变体背后是 `CommandAsyncService` 的读写分离和重试机制。

## 一、RBucket：SET/GET 键值对

`RedissonBucket<V>`（567 行，`RedissonBucket.java:43`）封装 `SET` / `GET` 命令。`getAsync` 发 `GET key`，`setAsync` 发 `SET key value`。

变体方法：

- `getAndSetAsync(newValue)`（`:98`）：原子 `GETSET key newValue`（返回旧值，设新值）
- `getAndExpireAsync(Instant/Duration)`（`:116` / `:126`）：读值的同时设过期
- `getAndClearExpireAsync()`（`:136`）：读值的同时清除过期

## 二、RAtomicLong：原子计数器

`RedissonAtomicLong`（325 行，`RedissonAtomicLong.java:43`）封装 `INCRBY` / `GET` / `SET` 命令。

- `incrementAndGetAsync()`（`:174`）：`INCR key`，原子 +1
- `addAndGetAsync(delta)`（`:90`）：`INCRBY key delta`，原子 +delta
- `getAndSetAsync(newValue)`：`SET key newValue` + 返回旧值

所有操作在 Redis 服务端原子执行，不需要客户端加锁。

## 三、RSemaphore：分布式信号量

`RedissonSemaphore`（607 行，`RedissonSemaphore.java:46`）用 Lua 脚本实现信号量：

- `acquireAsync(permits)`（`:94`）：检查可用许可数，够则减，不够则阻塞
- `releaseAsync(permits)`（`:445`）：释放许可，增加可用数

信号量的许可数存储在 Redis 的 `RSemaphore` key 中，跨节点共享。

## 四、收网

`RBucket` 封装 SET/GET 键值对，`RAtomicLong` 封装 INCRBY 原子计数器，`RSemaphore` 封装 Lua 脚本实现分布式信号量。`vol-redisson` 全部 7 个域完成。

## 卷级闭合

- R-1 Redisson 主类与连接管理
- R-4 命令执行流水线
- R-2 RLock 分布式锁 + Watchdog
- R-3 Codec 序列化体系
- R-5 RMap 分布式映射
- R-6 Spring Cache 集成
- R-7 基础数据结构
ENDOFFILE