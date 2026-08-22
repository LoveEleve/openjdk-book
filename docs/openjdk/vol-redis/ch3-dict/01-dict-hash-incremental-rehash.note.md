# vol-redis R-3 Dict 渐进式 rehash — note

## 本篇主张

- Dict 用 `ht_table[2]` + `rehashidx` 实现双表结构，把扩容/缩容的 O(n) 开销摊到后续每次操作上。
- 每次操作（增删改查）后调 `dictRehash(d, 1)` 迁移 1 个桶，不阻塞读写。
- 扩容阈值是负载因子 >= 1，缩容阈值是 < 1/32，两者不对称。
- SipHash 替代 MurmurHash 防止 HashDoS 攻击。

## 本篇边界

- 不展开 dict 在 redisDb 键空间中的具体使用（R-29 覆盖）。
- 不展开 dict 与 zset/intset 等具体编码的交互细节。

## 下篇桥接

- R-5 List/quicklist 将展开 List 从 ziplist 到 listpack 的迁移，以及 quicklist 的分页存储设计。
