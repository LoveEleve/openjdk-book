# 篇：01 基础数据结构：RBucket / RAtomicLong / RSemaphore

- 域：`R-7 基础数据结构`
- 卷：`vol-redisson`
- 目标：回答 RBucket、RAtomicLong、RSemaphore 各自封装的 Redis 底层命令。

## 前置依赖

- HARD：已读 `R-1 Redisson 主类与连接管理`（知道 CommandAsyncService）。

## 读者问题

1. RBucket 封装了什么 Redis 命令？
2. RAtomicLong 怎么保证 INCR 原子性？
3. RSemaphore 的 acquire/release 怎么实现分布式信号量？

## 主结论

RBucket（567 行）封装 `SET/GET` 键值对，RAtomicLong（325 行）封装 `INCRBY/GET` 原子计数器，RSemaphore（607 行）封装 Lua 脚本实现分布式信号量。

## 必须回填的源码锚点

- `RedissonBucket.java:43` 类声明
- `RedissonAtomicLong.java:43` 类声明
- `RedissonSemaphore.java:46` 类声明

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE