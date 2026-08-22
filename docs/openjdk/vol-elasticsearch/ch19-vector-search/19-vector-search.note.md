# vol-elasticsearch E-18 向量搜索 — note

## 本篇主张

- `dense_vector` 字段 + `knn` 查询实现向量相似度检索。
- `KnnVectorQueryBuilder.java:51` 构建向量查询，支持 cosine/dot_product/l2。
- kNN 在 DfsPhase 的 `executeKnnVectorQuery`（`DfsPhase.java:175`）执行，用 HNSW 近似最近邻。
- `KnnScoreDocQuery` 持有预计算分数。

## 卷级闭合

- vol-elasticsearch 全部 19 个域完成。
ENDOFFILE