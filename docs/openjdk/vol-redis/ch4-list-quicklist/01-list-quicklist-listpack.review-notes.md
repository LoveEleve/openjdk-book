# vol-redis R-5 List/quicklist — review notes

## 事实审

- 已核对 `src/quicklist.h:47`-`:59`（`quicklistNode`：prev/next/entry/sz/count:16/encoding:2/container:2/recompress），正文成立。
- 已核对 `src/quicklist.h:99`-`:108`（`quicklist`：head/tail/count/len/fill/compress），正文成立。
- 已核对 `src/quicklist.h:66`-`:69`（`quicklistLZF`：sz + compressed），正文成立。
- 已核对 `src/quicklist.c:127`（`quicklistCreate()`）、`:557`（`__quicklistCreateNode()`）、`:583`（`quicklistPushHead()`）、`:611`（`quicklistPushTail()`），正文成立。
- 已核对 `src/listpack.c:84`-`89`（header 格式 total_bytes + num_elements）、`:335`（`lpEncodeBacklen`）、`:374`（`lpDecodeBacklen`），正文成立。
- 已核对 `src/ziplist.c:16`（ziplist 布局注释），正文成立。
- 已核对 `src/server.h:893`（`OBJ_ENCODING_LISTPACK 11`）、`src/object.c:221`（`createListListpackObject` listpack 直存）、`src/object.c:214`（`createQuicklistObject`），正文成立。
- 已核对 `src/t_list.c:21`（`listTypeTryConvertListpack` 从 listpack 转 quicklist）、`:65`（`listTypeTryConvertQuicklist` 从 quicklist 转回 listpack）、`:144`（`listTypePush` 按编码分派）、`:464`（`pushGenericCommand`）、`:493`（`lpushCommand`）、`:498`（`rpushCommand`）、`:846`（`lpopCommand`）、`:851`（`rpopCommand`）、`:856`（`lrangeCommand`），正文成立。
- 已核对 `src/config.c:3152`（`list-max-listpack-size` 配置，旧名 `list-max-ziplist-size`），正文成立。
- 已核对 `src/quicklist.c:307`（`__quicklistCompress`，两端节点不压缩、len < 2*compress 不压缩），正文成立。

## 因果审

- ziplist 的连锁更新由 `prevlen` 字段依赖前 entry 长度引起，正文成立。
- listpack 的 `element-backlen` 编码在 entry 末尾，自包含长度，消除连锁更新，正文成立。
- Redis 7.0 小 List 用 listpack 直存、大 List 才转 quicklist，是降低小 List 内存开销的关键变化，正文成立。
- `fill` 控制每节点元素量，`compress` 控制两端免压缩深度，正文成立。

## 结构审

- 从"为什么换四次编码"困惑开场，再落到 ziplist 问题、listpack 方案、List 双编码、quicklist 分页、fill/compress 参数、LZF 压缩，主线集中。
- 深度复审发现"只讲 quicklist 忽略 listpack 直存"的事实缺口并补齐。

## 读者审

- 读完应能回答：为什么 ziplist 有连锁更新而 listpack 没有。
- 读完应能回答：小 List 用什么编码，什么时候转 quicklist。
- 读完应能回答：`fill` 和 `compress` 分别控制什么。
- 读完后能自然进入 R-6 ZSet。

## 边界审

- 本篇没有展开 BLPOP/BRPOP 阻塞命令（R-30 覆盖）。
- R-6 ZSet 未提前透支，边界成立。

## 依赖审

- 前置依赖：R-1 redisObject（HARD）。
- 后续桥接：R-6 ZSet。

## 结论

R-5 已完成深度复审，补齐 List 双编码事实，可进入 R-6 ZSet。
