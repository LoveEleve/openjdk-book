# vol-redis R-18 内存碎片整理 — note

## 本篇主张

- `activeDefragCycle`（`defrag.c:1256`）在 `serverCron` 中逐步整理碎片。
- `je_get_defrag_hint`（`defrag.c:32`）判断指针是否可整理。
- `activedefrag yes` 启用，`active-defrag-threshold-lower` 默认 10。

## 下篇桥接

卷级收尾。
