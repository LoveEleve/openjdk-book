# ES 怎么在 Lucene 之上构建搜索引擎

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第十篇，回答 ES 的 `lucene/` 扩展层。

## 困惑：ES 不是"基于 Lucene"吗，为什么还要自己写查询扩展？

Lucene 提供了 `Query`、`Weight`、`Scorer`、`Similarity` 等抽象类。ES 在这些抽象类之上做了定制扩展，以支持 ES 特有的查询语义（BlendedTermQuery、SearchAfterSortedDocQuery 等）。

## 分层拆解

### 1. lucene/queries/：5 种定制查询

- **`BlendedTermQuery`**：多字段混合查询，把同一个查询词同时在多个字段上打分，合并结果
- **`BinaryDocValuesRangeQuery`**：基于 DocValues 的范围查询，不依赖倒排索引（用于聚合后过滤）
- **`SearchAfterSortedDocQuery`**：支持深度分页的 `search_after` 查询，避免 `from+size` 的深度分页问题
- **`MinDocQuery`**：按最小 doc_id 过滤
- **`SpanMatchNoDocsQuery`**：空匹配查询

### 2. lucene/similarity/：LegacyBM25Similarity

`LegacyBM25Similarity`（95 行）继承 Lucene 的 `Similarity`，是 ES 对 BM25 的定制实现，保持与旧版本的打分兼容。

### 3. lucene/grouping/：分组聚合

分组聚合基于 Lucene 的 Collector 体系，按字段值分组后对每组计算聚合结果。

## 失败路径

- BlendedTermQuery 在多字段上打分权重不均衡 → 需要调整字段 boost
- SearchAfterSortedDocQuery 的 sort 值重复 → 分页结果可能重复或遗漏

## 收网

ES 的 `lucene/` 包（6 子包）是 ES 对 Lucene 的扩展层。`queries/`(5 文件) 定制查询，`similarity/`(1 文件) 定制相似度，`grouping/`(3 文件) 分组聚合。这些扩展通过继承 Lucene 的 `Query/Weight/Scorer/Similarity` 抽象类实现。

## 下篇桥接

E-8 MergePolicy 段合并。
ENDOFFILE