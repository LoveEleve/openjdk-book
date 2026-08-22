# vol-redis R-5 List/quicklist — note

## 本篇主张

- Redis List 经历了四次编码演进：ziplist（连锁更新问题）→ quicklist+ziplist（缓解）→ listpack 直存（小 List）+ quicklist+listpack（大 List）。
- Redis 7.0 的关键变化不只是"quicklist 节点从 ziplist 换 listpack"，而是**小 List 直接用 listpack 编码，不需要 quicklist 包装**。
- listpack 的每 entry 自包含长度（`element-backlen` 编码在 entry 末尾），彻底消除连锁更新。
- 超过 `list-max-listpack-size` 时 List 从 listpack 转 quicklist，缩小后也可转回。
- quicklist 双向链表 + 分页容器，`fill` 控制每节点元素量，`compress` 控制两端免压缩深度，LZF 压缩中间节点。

## 本篇边界

- 不展开 t_list.c 中所有 List 命令的完整实现。
- 不展开 BLPOP/BRPOP 阻塞命令（R-30 覆盖）。

## 下篇桥接

- R-6 ZSet 将展开 skiplist + dict 双结构组合，以及 ZRANK 的 O(logN) span 机制。
