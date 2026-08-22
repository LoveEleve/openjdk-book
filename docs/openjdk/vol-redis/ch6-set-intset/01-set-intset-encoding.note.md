# vol-redis R-7 Set/intset — note

## 本篇主张

- Redis 7.4 的 Set 有三种编码：intset（整数有序数组+二分查找）/ listpack（非整数紧凑编码）/ HT（dict 哈希表）。
- intset 编码升级（INT16→INT32→INT64）是单向的，只升不降。
- `set-max-intset-entries`（512）控制 intset→HT 阈值，`set-max-listpack-entries`（128）控制 listpack→HT 阈值。
- HT 条件满足时可转回 intset（所有元素为整数且大小 <= 512），但不能转回 listpack。

## 本篇边界

- 不展开 t_set.c 中所有 Set 命令的完整实现。
- 不展开 dict 在 HT 编码中的详细 rehash 机制（R-3 已覆盖）。

## 下篇桥接

- R-10 Stream/rax 将展开 Stream 的基数树（rax）实现和消费者组机制。
