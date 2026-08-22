# vol-redisson R-7 基础数据结构 — note

## 本篇主张

- RBucket（567 行）封装 `SET/GET` 键值对，`RedissonBucket.java:43`。
- RAtomicLong（325 行）封装 `INCRBY/GET` 原子计数器，`RedissonAtomicLong.java:43`。
- RSemaphore（607 行）封装 Lua 脚本实现分布式信号量，`RedissonSemaphore.java:46`。

## 卷级收尾

- vol-redisson 全部 7 个域完成。
ENDOFFILE