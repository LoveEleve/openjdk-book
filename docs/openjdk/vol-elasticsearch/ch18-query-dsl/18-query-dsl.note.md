# vol-elasticsearch E-17 Query DSL — note

## 本篇主张

- Query DSL 通过 `QueryBuilder.toQuery()` 编译成 Lucene Query。
- `BoolQueryBuilder.java:40` 组合 MUST/FILTER/SHOULD/MUST_NOT 四种子句。
- `FuzzyQueryBuilder` 按 Levenshtein 编辑距离（最多 2 次）模糊匹配。
- `RescorePhase` 在 Query 后重打分优化排序。

## 下篇桥接

- E-18 向量搜索/kNN。
ENDOFFILE