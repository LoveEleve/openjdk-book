# 篇：01 ZSet：为什么同时用 skiplist 和 dict

- 域：`R-6 ZSet`
- 卷：`vol-redis`
- 目标：回答 ZSet 为什么同时用 skiplist 和 dict 两种结构，以及 ZRANK 如何 O(logN) 排名。

## 前置依赖

- HARD：已读 `R-1 redisObject`（encoding=SKIPLIST 时底层是 zset）、`R-3 Dict`（dict 是 ZSet 的一半）。
- SOFT：了解 skiplist 的基本概念。

## 读者问题

1. ZSet 为什么同时用 skiplist 和 dict？各自解决什么问题？
2. 为什么用 skiplist 不用红黑树/B+树？
3. `ZSKIPLIST_P = 0.25` 和 `ZSKIPLIST_MAXLEVEL = 32` 是怎么来的？
4. ZRANK 为什么是 O(logN)？span 字段怎么用？
5. ZSet 也有 listpack 编码吗？什么时候转 skiplist？

## 主结论

ZSet 不是"一个带排序的 Set"，而是 **skiplist（按 score 排序） + dict（按 member 查 score）的双结构组合**。两个结构共享同一个 `ele` 指针，没有重复存储。

`zset.dict` 负责 O(1) 的 member 查 score，`zset.zsl` 负责 O(logN) 的按 score 范围查询和排名。两个结构互补，缺一不可。

## 结构设计

1. 困惑开场：为什么不能用一种结构搞定
2. zset 结构：dict + zskiplist 双结构，共享 ele
3. skiplist 节点：level[] 数组 + forward + span，span 实现 ZRANK
4. zslRandomLevel：P=0.25，最大 32 层
5. 双编码：小 ZSet 用 listpack，大 ZSet 转 skiplist
6. ZADD 流程：双结构同步操作
7. 失败路径
8. 收网与下篇桥接 R-7 Set

## 必须回填的源码锚点

- `src/server.h:514`-`:515` `ZSKIPLIST_MAXLEVEL 32` / `ZSKIPLIST_P 0.25`
- `src/server.h:1341`-`:1349` `zskiplistNode` 结构体（ele/score/backward/level[].forward + span）
- `src/server.h:1351`-`:1355` `zskiplist` 结构体（header/tail/length/level）
- `src/server.h:1357`-`:1359` `zset` 结构体（dict + zsl）
- `src/t_zset.c:120`-`:131` `zslRandomLevel()`（P=0.25 概率递增）
- `src/t_zset.c:137` `zslInsert()`（skiplist 插入）
- `src/t_zset.c:1240`-`:1243` 小 ZSet 创建 listpack 编码
- `src/t_zset.c:69` `zsetConvertAndExpand()`（listpack↔skiplist 转换）
- `src/t_zset.c:3905` `zrankCommand()`（ZRANK 命令）
- `src/t_zset.c:1425` `zsetAdd()`（ZADD 统一入口）
- `src/config.c:3219` `zset-max-listpack-entries`（默认 128）
- `src/config.c:3223` `zset-max-listpack-value`（默认 64）

## 必须引用的测试/证据

- `tests/unit/type/zset.tcl`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
