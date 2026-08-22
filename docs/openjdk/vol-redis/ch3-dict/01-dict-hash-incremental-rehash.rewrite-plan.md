# 篇：01 Dict 哈希表：渐进式 rehash 与双表结构

- 域：`R-3 Dict 渐进式 rehash`
- 卷：`vol-redis`
- 目标：回答 Redis 的哈希表如何在扩容时不影响线上服务，以及双表 + 渐进式 rehash 如何保证一致性。

## 前置依赖

- HARD：已读 `R-1 redisObject`，知道 `encoding=HT` 时底层是 dict。
- SOFT：了解哈希表的基本概念（桶、哈希函数、冲突链）。

## 读者问题

1. 为什么 Redis 用双表（`ht[2]`），而不是一次性扩容？
2. 渐进式 rehash 每次迁移多少条数据？谁触发的？
3. 扩容阈值是多少？缩容阈值是多少？为什么缩容阈值这么低（1/32）？
4. rehash 期间的增删改查怎么保证一致性？
5. 为什么从 `MurmurHash` 换成了 `SipHash`？

## 主结论

Dict 不是"rehash 时暂停服务"，而是 **通过双表 + 渐进式迁移，把扩容/缩容的 O(n) 开销摊到后续每次操作上**。

`dict.h:102` `rehashidx` 标记 rehash 进度（-1 表示未在 rehash 中）。`= 0` 时开始迁移，`ht[0]` 的桶逐个迁移到 `ht[1]`，`rehashidx` 递增，直到 `ht[0]` 为空，交换 `ht[0]` 和 `ht[1]`，`rehashidx` 回到 -1。

`dict.c:449`：每次操作（增删改查）后调 `dictRehash(d,1)` 迁移 1 个桶。

## 结构设计

1. 困惑开场：为什么哈希表扩容不能"停一下"？
2. struct dict：ht_table[2]、ht_used[2]、rehashidx、ht_size_exp[2]
3. 扩容触发：`_dictExpandIfNeeded` 的负载因子阈值
4. 缩容边界：`dictShrinkIfNeeded` 的 1/32 比例
5. `dictRehash()`：每次迁移 n 个桶，空桶用 `empty_visits` 跳过
6. 每次操作调一步：`dict.c:449` 的 `dictRehash(d,1)`
7. rehash 期间的增删改查：双表读写 + 新表优先
8. SipHash 替换 MurmurHash 的原因
9. 失败路径：rehash 暂停（pauserehash）、扩容抖动、内存碎片
10. 收网与下篇桥接 R-5 List

## 必须回填的源码锚点

- `src/dict.h:96`-`:110` `struct dict` 定义（ht_table[2]/ht_used[2]/rehashidx/ht_size_exp[2]）
- `src/dict.h:170` `#define dictIsRehashing(d) ((d)->rehashidx != -1)`
- `src/dict.h:32`-`:91` `dictType` 结构（hashFunction/keyCompare）
- `src/dict.c:385`-`:425` `dictRehash()` 增量迁移核心
- `src/dict.c:449` `dictRehash(d,1)` 每次操作一步
- `src/dict.c:41`-`:42` `dict_can_resize` / `dict_force_resize_ratio`
- `src/dict.c:224` `_dictResize()` 缩容扩统一入口
- `src/dict.c:473` `dictAdd()` 增删改查入口
- `src/dict.c:63` `_dictExpandIfNeeded()` 扩容触发
- `src/dict.c` `dict_hash_function_seed[16]` 哈希种子
- `src/dict.c` `dictSetHashFunctionSeed()` SipHash 初始化

## 必须引用的测试/证据

- `tests/unit/dict.tcl`（如果存在）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
