# vol-redis R-3 Dict 渐进式 rehash — review notes

## 事实审

- 已核对 `src/dict.h:96`-`:110`（`struct dict`：ht_table[2]/ht_used[2]/rehashidx/ht_size_exp[2]/pauserehash/pauseAutoResize），正文成立。
- 已核对 `src/dict.h:170`（`dictIsRehashing`），正文成立。
- 已核对 `src/dict.c:1492`（`dictExpandIfNeeded()` 扩容判定：ENABLE 负载因子>=1，AVOID 负载因子>=4），正文成立。
- 已核对 `src/dict.c:1592`（`dictFindPositionForInsert` 中调用 `_dictExpandIfNeeded`），正文成立。
- 已核对 `src/dict.c:1529`-`:1547`（`dictShrinkIfNeeded()` 缩容两档：ENABLE 1/8，AVOID 1/32），正文成立。
- 已核对 `src/dict.h:27`（`HASHTABLE_MIN_FILL 8`），正文成立。
- 已核对 `src/dict.c:385`-`:425`（`dictRehash()` 含开头 FORBID/AVOID 检查），正文成立。
- 已核对 `src/dict.c:448`-`:449`（`_dictRehashStep` → `dictRehash(d,1)`），正文成立。
- 已核对 `src/dict.c:521`（`htidx = dictIsRehashing(d) ? 1 : 0` 新增插入 ht[1]），正文成立。
- 已核对 `src/server.c:643`-`:648`（`updateDictResizePolicy()` fork 时 FORBID/AVOID/ENABLE 三态），正文成立。
- 已核对 `src/dict.c:815`（`dictTwoPhaseUnlinkFree` 中 `dictPauseRehashing`，pauserehash 的真实用途），正文成立。
- 已核对 `src/dict.c:92`（`dict_hash_function_seed[16]`）、`:94`（`dictSetHashFunctionSeed`），正文成立。
- 已核对 `src/dict.c:41`-`:42`（`dict_can_resize` / `dict_force_resize_ratio=4`），正文成立。

## 因果审

- 双表 + rehashidx 把 O(n) 扩容拆成逐步迁移，正文成立。
- 扩容/缩容阈值受 `dict_can_resize` 三态控制（ENABLE/AVOID/FORBID），正文成立。
- 每次操作调 `_dictRehashStep` 迁移 1 桶，正文成立。
- rehash 时新增插 ht[1]（`htidx = dictIsRehashing ? 1 : 0`），正文成立。
- fork 用 `updateDictResizePolicy()` 调 `dict_can_resize`，与 `pauserehash`（两阶段删除用）无关，正文已修正。
- AVOID 模式下进行中的 rehash 也会暂停（`dict.c:390`-`398`），正文成立。
- SipHash 替代 MurmurHash 防 HashDoS，正文成立。

## 结构审

- 从"为什么不能停一下"困惑开场，再落到双表、扩容/缩容两档条件、dictRehash、每次一步、fork 关系、SipHash、失败路径，主线集中。
- 深度复审发现并修正 4 处事实错误，结构随之收敛。

## 读者审

- 读完应能回答：为什么双表而不是一次性扩容。
- 读完应能回答：扩容/缩容阈值为什么有 ENABLE/AVOID 两档。
- 读完应能回答：fork 与 rehash 的真正关系（dict_can_resize 而非 pauserehash）。
- 读完应能回答：rehash 期间新增元素插到 ht[1]。
- 读完后能自然进入 R-5 List。

## 边界审

- 本篇没有展开 dict 在 redisDb 键空间中的使用（R-29 覆盖）。
- R-5 List/quicklist 未提前透支，边界成立。

## 依赖审

- 前置依赖：R-1 redisObject（HARD）。
- 后续桥接：R-5 List/quicklist。

## 结论

R-3 已完成深度复审，4 处事实错误全部修正，可进入 R-5 List/quicklist。
