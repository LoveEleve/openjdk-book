# vol-redis R-6 ZSet — review notes

## 事实审

- 已核对 `src/server.h:1357`-`:1359`（`zset` 结构体：dict + zsl），正文成立。
- 已核对 `src/server.h:1341`-`:1349`（`zskiplistNode`：ele/score/backward/level[].forward + span），正文成立。
- 已核对 `src/server.h:1351`-`:1355`（`zskiplist`：header/tail/length/level），正文成立。
- 已核对 `src/server.h:514`-`:515`（`ZSKIPLIST_MAXLEVEL 32` / `ZSKIPLIST_P 0.25`），正文成立。
- 已核对 `src/t_zset.c:120`-`:131`（`zslRandomLevel()` P=0.25 概率递增），正文成立。
- 已核对 `src/t_zset.c:137`（`zslInsert()` 插入），正文成立。
- 已核对 `src/t_zset.c:1240`-`:1243`（小 ZSet listpack 创建条件），正文成立。
- 已核对 `src/t_zset.c:1425`（`zsetAdd()` 统一入口），正文成立。
- 已核对 `src/t_zset.c:3905`（`zrankCommand()`），正文成立。
- 已核对 `src/config.c:3219`（`zset-max-listpack-entries` 默认 128）、`:3223`（`zset-max-listpack-value` 默认 64），正文成立。
- 已核对 `src/t_zset.c:69`（`zsetConvertAndExpand()` 编码转换），正文成立。

## 因果审

- `zset.dict` 负责 O(1) member→score 查，`zset.zsl` 负责 O(logN) 排序和范围查询，互补成立。
- `level[].span` 累加实现 O(logN) ZRANK，正文成立。
- `P=0.25` 比 0.5 层数更少、更稀疏，减少内存，正文成立。
- 小 ZSet 用 listpack 编码，超过阈值转 skiplist，正文成立。

## 结构审

- 从"为什么不能一种结构搞定"困惑开场，再落到双结构、skiplist 节点、zslRandomLevel、双编码、ZADD 流程，主线集中。

## 读者审

- 读完应能回答：为什么 skiplist 和 dict 缺一不可。
- 读完应能回答：`span` 字段如何实现 O(logN) 排名。
- 读完应能回答：ZSet 的 listpack 编码阈值。
- 读完后能自然进入 R-7 Set。

## 边界审

- 本篇不展开所有 ZSet 命令的实现。
- R-7 Set/intset 未提前透支，边界成立。

## 依赖审

- 前置依赖：R-1 redisObject（HARD）、R-3 Dict（HARD）。
- 后续桥接：R-7 Set/intset。

## 结论

R-6 已完成四件套的事实回填与六层审查，可进入 R-7 Set/intset。
