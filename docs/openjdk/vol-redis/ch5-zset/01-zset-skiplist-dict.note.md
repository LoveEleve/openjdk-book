# vol-redis R-6 ZSet — note

## 本篇主张

- ZSet 不是"一个带排序的 Set"，而是 **skiplist（按 score 排序） + dict（按 member 查 score）的双结构组合**，共享 ele 指针。
- `level[].span` 实现 O(logN) 的 ZRANK，不需要遍历全部节点。
- `ZSKIPLIST_P = 0.25` 比经典 `P=0.5` 更稀疏，减少内存占用。
- 小 ZSet 用 listpack 编码，超过 `zset-max-listpack-entries`（128）或 `zset-max-listpack-value`（64B）后转 skiplist。

## 本篇边界

- 不展开所有 ZSet 命令的完整实现。
- 不展开 ZSet 的 redisDb 键空间操作。

## 下篇桥接

- R-7 Set/intset 将展开 Set 的两种编码。
