# 篇：10 Lucene 集成层：ES 怎么扩展 Lucene 的查询、相似度与分组

- 域：`E-12 Lucene 集成层`
- 卷：`vol-elasticsearch`
- 目标：回答 ES 怎么在 `lucene/` 包中扩展 Lucene 的查询、相似度和分组能力。

## 前置依赖

- HARD：已读 `E-2b 打分与 Query 重写`（知道 LegacyBM25Similarity 和 BinaryDocValuesRangeQuery）。
- SOFT：了解 Lucene 基本概念（Query、Weight、Scorer、Similarity）。

## 读者问题

1. ES 的 `lucene/` 包包含哪些扩展？
2. `BlendedTermQuery` 解决什么查询问题？
3. `SearchAfterSortedDocQuery` 怎么支持深度分页？
4. `lucene/grouping/` 怎么实现分组聚合？

## 主结论

ES 的 `lucene/` 顶级包（6 子包）是 ES 对 Lucene 的扩展层。`lucene/queries/`(5 文件) 定制查询——`BlendedTermQuery`(多字段混合查询)、`SearchAfterSortedDocQuery`(深度分页)；`lucene/similarity/`(1 文件) `LegacyBM25Similarity`；`lucene/grouping/`(3 文件) 分组聚合。

## 必须回填的源码锚点

- `lucene/similarity/LegacyBM25Similarity.java:35` 类声明
- `lucene/queries/BlendedTermQuery.java` 多字段混合查询
- `lucene/queries/SearchAfterSortedDocQuery.java` 深度分页
- `lucene/queries/BinaryDocValuesRangeQuery.java:30` 范围查询
- `lucene/grouping/` 分组聚合

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE