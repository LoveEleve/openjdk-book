# vol-elasticsearch E-2b 打分与 Query 重写 — note

## 本篇主张

- ES 默认 BM25 相似度，`SimilarityProviders.java:255` `createBM25Similarity()` 创建，`k1=1.2, b=0.75`。
- `LegacyBM25Similarity`（95 行）在 `lucene/similarity/`，是 ES 对 Lucene Similarity 的定制。
- 自定义 Query（`lucene/queries/`）通过重写 `createWeight()` 扩展 Lucene 查询。

## 下篇桥接

- E-12 Lucene 集成层。
ENDOFFILE