# vol-redis R-7 Set/intset — review notes

## 事实审

- 已核对 `src/intset.h:35`-`:39`（`intset`：encoding/length/contents[]），正文成立。
- 已核对 `src/intset.c:41`-`:43`（`INTSET_ENC_INT16/32/64`），正文成立。
- 已核对 `src/intset.c:206`（`intsetAdd()` 插入 + 升级入口），正文成立。
- 已核对 `src/intset.c:159`（`intsetUpgradeAndAdd()` 升级逻辑），正文成立。
- 已核对 `src/intset.c:46`（`_intsetValueEncoding()` 编码选择），正文成立。
- 已核对 `src/t_set.c:25`-`:33`（`setTypeCreate()` 三种编码创建），正文成立。
- 已核对 `src/t_set.c:57`-`:60`（`maybeConvertIntset()` intset→HT），正文成立。
- 已核对 `src/t_set.c:67`-`:87`（`maybeConvertToIntset()` HT→intset），正文成立。
- 已核对 `src/t_set.c:40`-`:46`（`setTypeMaybeConvert()` listpack→HT），正文成立。
- 已核对 `src/t_set.c:94`（`setTypeAdd()`）、`:99`（`setTypeAddAux()`），正文成立。
- 已核对 `src/t_set.c:583`（`saddCommand()`），正文成立。
- 已核对 `src/config.c:3216`（`set-max-intset-entries` 512）、`:3217`（`set-max-listpack-entries` 128）、`:3218`（`set-max-listpack-value` 64），正文成立。

## 因果审

- intset 有序数组 + 二分查找在 512 元素内比哈希表常数更低，正文成立。
- 编码升级单向（只升不降）因为降级成本高且很少发生，正文成立。
- intset/listpack 超阈值后转 HT，HT 条件满足时转回 intset，正文成立。
- HT 只能转 intset（不能转 listpack）因为 listpack 需要无序编码而 HT 元素无序，正文成立。

## 结构审

- 从"为什么有三种编码"困惑开场，再落到 intset、编码升级、二分查找、listpack 编码、转换逻辑、SADD，主线集中。

## 读者审

- 读完应能回答：Set 三种编码各什么时候用。
- 读完应能回答：intset 为什么只升不降。
- 读完应能回答：HT 什么时候能转回 intset、什么时候不能转回 listpack。
- 读完后能自然进入 R-10 Stream。

## 边界审

- 本篇没有展开全部 Set 命令的实现。
- R-10 Stream/rax 未提前透支，边界成立。

## 依赖审

- 前置依赖：R-1 redisObject（HARD）、R-3 Dict（HARD）。
- 后续桥接：R-10 Stream/rax。

## 结论

R-7 已完成四件套的事实回填与六层审查，可进入 R-10 Stream/rax。
