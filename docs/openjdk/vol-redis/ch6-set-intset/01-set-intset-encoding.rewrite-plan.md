# 篇：01 Set 数据结构：intset / listpack / HT 三种编码

- 域：`R-7 Set/intset`
- 卷：`vol-redis`
- 目标：回答 Set 为什么有三种编码（intset / listpack / HT），以及 intset 的升级机制。

## 前置依赖

- HARD：已读 `R-1 redisObject`（encoding=INTSET/HT）、`R-3 Dict`（HT 编码）。

## 读者问题

1. Set 有几种编码？各自什么时候用？
2. intset 的编码升级（INT16→INT32→INT64）是怎么触发的？为什么只升不降？
3. intset 为什么用有序数组+二分查找？
4. 什么时候从 intset 转 HT？什么时候从 HT 转回 intset？
5. listpack 编码的 Set 什么时候用？

## 主结论

Set 不是"一个集合"，而是 **intset（整数+有序数组+二分查找） / listpack（非整数+紧凑编码） / HT（dict 哈希表）三种编码的运行时切换**。intset 和 listpack 是小集合的紧凑编码，HT 是大集合的通用编码。

`set-max-intset-entries`（默认 512）控制 intset→HT 的阈值，`set-max-listpack-entries`（默认 128）控制 listpack→HT 的阈值。HT 在所有元素为整数且大小够小时，可转回 intset。

## 结构设计

1. 困惑开场：为什么一个 Set 要用三种编码
2. intset 结构：encoding + length + contents[] 有序数组
3. intset 编码升级：INT16→INT32→INT64 单向升级
4. intset 二分查找与插入
5. listpack 编码的 Set
6. HT 编码的 Set 与 intset/listpack 的转换条件
7. SADD 命令入口
8. 失败路径
9. 收网与下篇桥接 R-10 Stream

## 必须回填的源码锚点

- `src/intset.h:35`-`:39` `intset` 结构体（encoding/length/contents[]）
- `src/intset.c:41`-`:43` `INTSET_ENC_INT16/32/64`
- `src/intset.c:206` `intsetAdd()`（插入与升级入口）
- `src/intset.c:159` `intsetUpgradeAndAdd()`（升级）
- `src/intset.c:46` `_intsetValueEncoding()`（编码选择）
- `src/t_set.c:25`-`:33` `setTypeCreate()`（三种编码创建）
- `src/t_set.c:57`-`:60` `maybeConvertIntset()`（intset→HT）
- `src/t_set.c:67`-`:87` `maybeConvertToIntset()`（HT→intset）
- `src/t_set.c:40`-`:46` `setTypeMaybeConvert()`（listpack→HT）
- `src/t_set.c:94` `setTypeAdd()` 和 `setTypeAddAux()`（添加入口）
- `src/t_set.c:583` `saddCommand()`（SADD 命令）
- `src/config.c:3216` `set-max-intset-entries` 512
- `src/config.c:3217` `set-max-listpack-entries` 128
- `src/config.c:3218` `set-max-listpack-value` 64

## 必须引用的测试/证据

- `tests/unit/type/set.tcl`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
