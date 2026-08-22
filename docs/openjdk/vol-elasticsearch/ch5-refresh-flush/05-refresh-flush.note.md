# vol-elasticsearch E-1b refresh/flush — note

## 本篇主张

- refresh（`Engine.java:1109`）→ `ReferenceManager.maybeRefresh()` → 打开新 IndexReader，使数据可见。
- flush（`InternalEngine.java:2173`）→ ①refresh ②IndexWriter.commit()(fsync) ③createNewTranslog()。
- NRT 搜索 = refresh 近实时可见性（1s）+ Translog crash-safe 恢复。
- 默认 1s refresh 间隔 / 30min 或 512MB flush 触发。

## 下篇桥接

- E-5 分片生命周期与复制。
ENDOFFILE