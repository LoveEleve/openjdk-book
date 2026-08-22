# vol-elasticsearch E-12 Lucene 集成层 — note

## 本篇主张

- ES 的 `lucene/` 顶级包（6 子包）是 ES 对 Lucene 的扩展层。
- `lucene/queries/`(5 文件) 定制查询：BlendedTermQuery(多字段混合)、SearchAfterSortedDocQuery(深度分页)、BinaryDocValuesRangeQuery(范围) 等。
- `lucene/similarity/`(1 文件) LegacyBM25Similarity 定制相似度。
- `lucene/grouping/`(3 文件) 分组聚合。

## 下篇桥接

- E-8 MergePolicy 段合并。
ENDOFFILE