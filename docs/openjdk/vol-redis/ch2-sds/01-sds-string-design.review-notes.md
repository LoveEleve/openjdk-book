# vol-redis R-4 SDS 字符串 — review notes

## 事实审

- 已核对 `src/sds.h:20`（`typedef char *sds`），正文成立。
- 已核对 `src/sds.h:24`-`:47`（sdshdr5/8/16/32/64 结构体），`__packed__` 属性存在，正文成立。
- 已核对 `src/sds.h:53`-`:57`（SDS_TYPE_5/8/16/32/64），正文成立。
- 已核对 `src/sds.h:60`-`:61`（`SDS_HDR_VAR`/`SDS_HDR` 宏），正文成立。
- 已核对 `src/sds.h:13`（`SDS_MAX_PREALLOC 1024*1024`），正文成立。
- 已核对 `src/sds.c:81`（`_sdsnewlen()` 创建入口），正文成立。
- 已核对 `src/sds.c:217`-`:260`（`_sdsMakeRoomFor()` 预分配核心），`if (type == SDS_TYPE_5) type = SDS_TYPE_8` 升级逻辑在 `:244`，正文成立。
- 已核对 `src/sds.c:272`（`sdsMakeRoomFor()` greedy=1 入口），正文成立。
- 已核对 `src/sds.c:463`-`:469`（`sdscatlen()` 二进制安全追加），正文成立。
- 已核对 `src/sds.c` 的 `sdsReqType()`（14 行 inline，`<1<<5` / `<1<<8` / `<1<<16` / `<1ll<<32` / 64），正文成立。

## 因果审

- `sds = char *` 同时指向 buf 的设计解耦了 header 类型和调用方，正文成立。
- `__packed__` 取消对齐让 `SDS_HDR` 能精确反推 header 指针，正文成立。
- `sdshdr5` 不记录 alloc 所以不能用于追加，正文成立。
- 预分配策略避免 N 次追加的 O(N^2) 复杂度，正文成立。
- `sdscatlen` 用显式 memcpy 长度实现二进制安全，正文成立。

## 结构审

- 从"为什么 char * 不够"困惑开场，再落到内存布局、5 种 header、__packed__、sdshdr5 陷阱、预分配、二进制安全、扩容升级，主线集中。

## 读者审

- 读完应能回答：为什么 sdshdr5 追加时会自动升级。
- 读完应能回答：预分配策略为什么是<1MB 翻倍而≥1MB +1MB。
- 读完应能回答：SDS 为什么能存二进制数据（含 \0）。
- 读完后能自然进入 R-3 Dict。

## 边界审

- 本篇没有展开 SDS 在 EMBSTR 编码中的具体使用。
- R-3 Dict 的渐进式 rehash 等内容未提前透支，边界成立。

## 依赖审

- 前置依赖：R-1 redisObject（HARD）。
- 后续桥接：R-3 Dict。

## 结论

R-4 已完成四件套的事实回填与六层审查，可进入 R-3 Dict。
