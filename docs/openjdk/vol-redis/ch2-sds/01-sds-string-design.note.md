# vol-redis R-4 SDS 字符串 — note

## 本篇主张

- SDS 不是"更聪明的 char *"，而是 **"header + buf" 在同一次 malloc 分配的内存块里**。`sds = char *` 指向 `buf[]`，header 紧贴 buf 前面。
- 5 种 header（sdshdr5/8/16/32/64）覆盖不同长度区间，`__packed__` 取消对齐，确保精确的 header 大小。
- `sdshdr5` 不记录空余空间，追加时自动升级到 `sdshdr8`。
- 预分配策略（<1MB 翻倍、≥1MB +1MB）让 N 次追加的均摊复杂度降到 O(1)。

## 本篇边界

- 不展开 SDS 在 EMBSTR 编码中的具体使用（R-1 已覆盖）。
- 不展开 `sdsfree`/`sdscpy` 等辅助函数的细节。

## 下篇桥接

- R-3 Dict 将展开哈希表的渐进式 rehash、SipHash、双表结构和扩容/缩容阈值。
